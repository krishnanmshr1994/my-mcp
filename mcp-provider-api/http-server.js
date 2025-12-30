import express from 'express';
import cors from 'cors';
import jsforce from 'jsforce';

const app = express();
const PORT = process.env.PORT || 8080;

// Configuration
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1';

const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
const SF_USERNAME = process.env.SALESFORCE_USERNAME;
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SALESFORCE_SECURITY_TOKEN || '';
const SF_ACCESS_TOKEN = process.env.SALESFORCE_ACCESS_TOKEN;
const SF_INSTANCE_URL = process.env.SALESFORCE_INSTANCE_URL;

// Cache
let schemaCache = null;
let schemaCacheTime = null;
const SCHEMA_CACHE_TTL = 3600000;
const objectFieldsCache = new Map();
let currentUserId = null;

// Salesforce connection
let sfConnection = null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// SALESFORCE CONNECTION
// ============================================

async function getConnection() {
  console.log('🔍 Getting Salesforce connection...');
  
  if (sfConnection && sfConnection.accessToken) {
    try {
      await sfConnection.query('SELECT Id FROM User LIMIT 1');
      console.log('✅ Using existing connection');
      return sfConnection;
    } catch (err) {
      console.log('⚠️  Connection expired, reconnecting...');
      sfConnection = null;
      currentUserId = null;
    }
  }

  if (SF_ACCESS_TOKEN && SF_INSTANCE_URL) {
    console.log('🔐 Authenticating with access token...');
    
    sfConnection = new jsforce.Connection({
      instanceUrl: SF_INSTANCE_URL.replace(/\/$/, ''),
      accessToken: SF_ACCESS_TOKEN
    });

    try {
      await sfConnection.query('SELECT Id FROM User LIMIT 1');
      const identity = await sfConnection.identity();
      currentUserId = identity.user_id;
      console.log('✅ Token authentication successful');
      console.log(`   User ID: ${currentUserId}`);
      return sfConnection;
    } catch (error) {
      console.error('❌ Token authentication failed:', error.message);
      sfConnection = null;
      throw new Error(`Token auth failed: ${error.message}`);
    }
  }

  if (!SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Salesforce credentials not configured');
  }

  console.log('🔐 Authenticating with username/password...');
  sfConnection = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });

  try {
    const password = SF_PASSWORD + SF_SECURITY_TOKEN;
    const userInfo = await sfConnection.login(SF_USERNAME, password);
    currentUserId = userInfo.id;
    console.log('✅ Username/password authentication successful');
    console.log(`   User ID: ${currentUserId}`);
    return sfConnection;
  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
    sfConnection = null;
    throw new Error(`Login failed: ${error.message}`);
  }
}

// ============================================
// SALESFORCE OPERATIONS
// ============================================

async function query(soql) {
  console.log(`📊 Executing query: ${soql.substring(0, 100)}...`);
  const conn = await getConnection();
  
  try {
    const result = await conn.query(soql);
    console.log(`✅ Query returned ${result.totalSize} records`);
    return result;
  } catch (error) {
    console.error(`❌ Query failed: ${error.message}`);
    throw error;
  }
}

async function createRecord(objectType, data) {
  const conn = await getConnection();
  const result = await conn.sobject(objectType).create(data);
  return result;
}

async function updateRecord(objectType, id, data) {
  const conn = await getConnection();
  const result = await conn.sobject(objectType).update({ Id: id, ...data });
  return result;
}

async function deleteRecord(objectType, id) {
  const conn = await getConnection();
  const result = await conn.sobject(objectType).destroy(id);
  return result;
}

// ============================================
// SCHEMA FUNCTIONS
// ============================================

async function getOrgSchema() {
  if (schemaCache && schemaCacheTime && (Date.now() - schemaCacheTime < SCHEMA_CACHE_TTL)) {
    return schemaCache;
  }

  const soql = 'SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomizable = true ORDER BY QualifiedApiName LIMIT 50000';
  const result = await query(soql);
  
  const objects = { standard: [], custom: [] };
  
  if (result && result.records) {
    result.records.forEach(obj => {
      const isCustom = obj.QualifiedApiName.endsWith('__c');
      const info = {
        apiName: obj.QualifiedApiName,
        label: obj.Label,
        isCustom: isCustom
      };
      if (isCustom) objects.custom.push(info);
      else objects.standard.push(info);
    });
  }

  schemaCache = objects;
  schemaCacheTime = Date.now();
  return objects;
}

async function getObjectSchema(objectName) {
  const cached = objectFieldsCache.get(objectName);
  if (cached && (Date.now() - cached.timestamp < SCHEMA_CACHE_TTL)) {
    return cached.data;
  }

  const soql = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectName}' ORDER BY QualifiedApiName LIMIT 200`;
  const result = await query(soql);
  
  const schema = {
    objectName,
    fields: result.records || []
  };
  
  objectFieldsCache.set(objectName, {
    data: schema,
    timestamp: Date.now()
  });
  
  return schema;
}

function formatSchema(schema) {
  let text = 'STANDARD OBJECTS:\n';
  schema.standard?.forEach(o => text += `- ${o.apiName} (${o.label})\n`);
  
  if (schema.custom?.length) {
    text += '\nCUSTOM OBJECTS:\n';
    schema.custom.forEach(o => text += `- ${o.apiName} (${o.label})\n`);
  }
  
  return text;
}

// ============================================
// IMPROVED SOQL GENERATION
// ============================================

function buildSOQLPrompt(question, schemaText, objectFieldsList, conversationContext, detectedObject, isFieldsQuery) {
  const userId = currentUserId || 'UNKNOWN_USER';
  const today = new Date().toISOString().split('T')[0];

  return `You are a Salesforce SOQL expert. Generate VALID, EXECUTABLE SOQL queries.

=== CRITICAL RULES ===

1. FIELD SELECTION:
   ❌ NEVER: SELECT *
   ✅ ALWAYS: SELECT Id, Name, Field1__c FROM Object

2. ADDRESS FIELDS (CRITICAL):
   ❌ NEVER query "Address" directly
   ✅ Use components: BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry
   ✅ Or: ShippingStreet, ShippingCity, MailingStreet, MailingCity, etc.

3. POLYMORPHIC FIELDS (Task, Event):
   - WhoId = Lead or Contact (people)
   - WhatId = Account, Opportunity, Case (things)
   - To traverse: SELECT WhoId, Who.Name, WhatId, What.Name FROM Task
   - To filter: WHERE WhoId IN (SELECT Id FROM Contact WHERE...)

4. USER CONTEXT:
   - Current User: '${userId}'
   - Today: ${today}
   - For "my tasks": WHERE OwnerId = '${userId}'
   - ❌ NO bind variables (:userId)

5. TOP N QUERIES:
   WHERE Amount > 0 ORDER BY Amount DESC LIMIT 5

6. DATES:
   Use: TODAY, YESTERDAY, THIS_WEEK, LAST_N_DAYS:30

7. RELATIONSHIPS:
   - Parent-to-child: (SELECT Id FROM Contacts)
   - Child-to-parent: Account.Name
   - Lookup: Custom__r.Name

=== EXAMPLES ===

"my open tasks"
→ SELECT Id, Subject, Status, ActivityDate, WhoId, Who.Name, WhatId, What.Name FROM Task WHERE OwnerId = '${userId}' AND IsClosed = false

"top 5 opportunities"
→ SELECT Id, Name, Amount, StageName FROM Opportunity WHERE Amount > 0 ORDER BY Amount DESC LIMIT 5

"contacts in California"
→ SELECT Id, Name, Email, MailingCity, MailingState FROM Contact WHERE MailingState = 'CA'

"accounts with billing in NY"
→ SELECT Id, Name, BillingStreet, BillingCity, BillingState FROM Account WHERE BillingState = 'NY'

=== SCHEMA ===
${schemaText}
${objectFieldsList}
${conversationContext}

=== QUESTION ===
${question}

${isFieldsQuery ? `LIST ALL FIELDS from ${detectedObject}` : ''}

Respond with ONLY the SOQL query. No markdown, no explanation.
If unclear, respond: CLARIFICATION_NEEDED: [question]`;
}

async function generateSOQLWithContext(question, objectHint, conversationHistory) {
  await getConnection();

  const fieldQueryMatch = question.toLowerCase().match(/fields?.*(?:of|for|in)\s+(\w+)/);
  let detectedObject = objectHint;
  
  if (fieldQueryMatch) {
    detectedObject = fieldQueryMatch[1];
  }

  const customObjMatch = question.match(/(\w+__c)/i);
  if (customObjMatch) {
    detectedObject = customObjMatch[1];
  }

  const schema = await getOrgSchema();
  const schemaText = formatSchema(schema);

  let objectFieldsList = '';
  let isFieldsQuery = false;
  
  if (detectedObject || fieldQueryMatch) {
    try {
      const targetObject = detectedObject || fieldQueryMatch[1];
      const allObjects = [...schema.standard, ...schema.custom];
      const matchedObject = allObjects.find(obj => 
        obj.apiName.toLowerCase().includes(targetObject.toLowerCase()) ||
        obj.label.toLowerCase().includes(targetObject.toLowerCase())
      );

      if (matchedObject) {
        const objSchema = await getObjectSchema(matchedObject.apiName);
        objectFieldsList = `\n\nFIELDS for ${matchedObject.apiName}:\n${objSchema.fields.map(f => `- ${f.QualifiedApiName} (${f.DataType})`).join('\n')}`;
        isFieldsQuery = true;
        detectedObject = matchedObject.apiName;
      }
    } catch (err) {
      console.error('Failed to get object fields:', err);
    }
  }

  const isReferencingPrevious = /\b(above|those|these|previous|that|them)\b/i.test(question);
  
  let conversationContext = '';
  if (conversationHistory.length > 0 && isReferencingPrevious) {
    conversationContext = '\n\nPREVIOUS CONTEXT:\n';
    conversationHistory.slice(-2).forEach((msg, idx) => {
      conversationContext += `${idx + 1}. Q: ${msg.question}\n   SOQL: ${msg.soql}\n`;
    });
    conversationContext += 'User is referencing the above. Reuse conditions or use subqueries.\n';
  }

  const prompt = buildSOQLPrompt(question, schemaText, objectFieldsList, conversationContext, detectedObject, isFieldsQuery);

  const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    throw new Error(`NVIDIA API error: ${response.status}`);
  }

  const data = await response.json();
  let result = data.choices[0].message.content.trim();
  
  if (result.startsWith('CLARIFICATION_NEEDED:')) {
    return {
      needsClarification: true,
      question: result.replace('CLARIFICATION_NEEDED:', '').trim(),
      originalQuestion: question
    };
  }

  result = result.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
  
  if (result.includes('SELECT *')) {
    result = result.replace(/SELECT \*/gi, 'SELECT Id, Name');
  }

  return {
    soql: result,
    originalQuestion: question,
    needsClarification: false,
    detectedObject
  };
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/health', async (req, res) => {
  let sfStatus = 'not connected';
  try {
    if (sfConnection) {
      await sfConnection.identity();
      sfStatus = 'connected';
    }
  } catch (err) {
    sfStatus = 'error';
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    salesforce: {
      status: sfStatus,
      currentUserId: currentUserId || 'Not loaded'
    },
    llm: {
      configured: !!NVIDIA_API_KEY,
      model: NVIDIA_MODEL
    }
  });
});

app.get('/schema', async (req, res) => {
  try {
    const schema = await getOrgSchema();
    res.json(schema);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/schema/:objectName', async (req, res) => {
  try {
    const schema = await getObjectSchema(req.params.objectName);
    res.json(schema);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/query', async (req, res) => {
  try {
    const { soql } = req.body;
    if (!soql) return res.status(400).json({ error: 'soql required' });
    const result = await query(soql);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/create', async (req, res) => {
  try {
    const { objectType, data } = req.body;
    if (!objectType || !data) return res.status(400).json({ error: 'objectType and data required' });
    const result = await createRecord(objectType, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/update', async (req, res) => {
  try {
    const { objectType, id, data } = req.body;
    if (!objectType || !id || !data) return res.status(400).json({ error: 'objectType, id, data required' });
    const result = await updateRecord(objectType, id, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/delete', async (req, res) => {
  try {
    const { objectType, id } = req.body;
    if (!objectType || !id) return res.status(400).json({ error: 'objectType and id required' });
    const result = await deleteRecord(objectType, id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/describe-object', async (req, res) => {
  try {
    const { objectName } = req.body;
    if (!objectName) return res.status(400).json({ error: 'objectName required' });

    const objSchema = await getObjectSchema(objectName);
    const fieldNames = objSchema.fields.map(f => f.QualifiedApiName);
    const soql = `SELECT ${fieldNames.join(', ')} FROM ${objectName} LIMIT 10`;
    
    let sampleData = null;
    try {
      sampleData = await query(soql);
    } catch (err) {
      console.log('Could not fetch sample data');
    }
    
    res.json({
      objectName,
      fieldCount: objSchema.fields.length,
      fields: objSchema.fields,
      generatedSOQL: soql,
      sampleData
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-soql', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) return res.status(503).json({ error: 'LLM not configured' });

    await getConnection();
    const { question, objectHint } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    const result = await generateSOQLWithContext(question, objectHint, []);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/summarize', async (req, res) => {
    try {
        if (!NVIDIA_API_KEY) return res.status(503).json({ error: 'LLM not configured' });

        const { textData, isChunk, isFinal, chunkNumber, totalChunks } = req.body;

        // 1. Define the exact Schema we want (NVIDIA NIM Structured Output)
        const jsonSchema = {
            type: "object",
            properties: {
                summary: { type: "string" },
                sentiment: { type: "string", enum: ["Positive", "Neutral", "Negative"] }
            },
            required: ["summary", "sentiment"]
        };

        let systemPrompt;
        if (isChunk) {
            systemPrompt = `Summarize news chunk ${chunkNumber}/${totalChunks}. Provide key points only.`;
        } else if (isFinal) {
            systemPrompt = `Create a final executive summary using <ul><li> tags from these partial summaries.`;
        } else {
            systemPrompt = `Summarize this news article concisely.`;
        }

        const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${NVIDIA_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: NVIDIA_MODEL,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: textData }
                ],
                // THE SECRET SAUCE: Tell NVIDIA exactly what JSON structure to follow
                response_format: { 
                    type: "json_object",
                    schema: jsonSchema 
                },
                temperature: 0.1
            })
        });

        if (!response.ok) throw new Error(`NVIDIA Error: ${response.status}`);

        const result = await response.json();
        let content = result.choices[0].message.content.trim();

        // Safety: Sometimes NIM still wraps in markdown blocks despite the schema
        content = content.replace(/```json|```/g, "").trim();

        // Final Parse
        const finalJson = JSON.parse(content);
        console.log(`✅ ${isFinal ? 'Final' : 'Chunk'} summary generated.`);
        res.json(finalJson);

    } catch (error) {
        console.error('❌ Server Error:', error.message);
        res.status(500).json({ summary: "Error processing text", sentiment: "Neutral" });
    }
});

app.post('/smart-query', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) return res.status(503).json({ error: 'LLM not configured' });

    await getConnection();
    const { question, objectHint, conversationHistory = [] } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    const isAggregationOnPrevious = /\b(average|avg|sum|total|count)\b/i.test(question) &&
                                     /\b(above|those|these)\b/i.test(question) &&
                                     conversationHistory.length > 0;

    if (isAggregationOnPrevious) {
      const lastConv = conversationHistory[conversationHistory.length - 1];
      
      if (!lastConv.results || lastConv.results.length === 0) {
        return res.json({
          question,
          soql: null,
          data: { records: [], totalSize: 0 },
          explanation: 'Previous query had no results',
          response: 'No data to calculate',
          calculatedByLLM: true
        });
      }

      const calcPrompt = `Previous query: "${lastConv.question}"
Returned: ${lastConv.recordCount} records

Sample data:
${JSON.stringify(lastConv.results.slice(0, 5), null, 2)}

Current question: "${question}"

Identify numeric field, perform calculation, format result.
OUTPUT FORMAT:
RESULT: [answer]
EXPLANATION: [reasoning]`;

      const llmRes = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: NVIDIA_MODEL,
          messages: [{ role: 'user', content: calcPrompt }],
          temperature: 0.2
        })
      });

      const llmData = await llmRes.json();
      const llmResponse = llmData.choices[0].message.content;
      const resultMatch = llmResponse.match(/RESULT:\s*([^\n]+)/i);
      const result = resultMatch ? resultMatch[1].trim() : llmResponse;

      return res.json({
        question,
        soql: null,
        data: { records: [], totalSize: 0 },
        explanation: llmResponse,
        response: result,
        calculatedByLLM: true
      });
    }

    const soqlResult = await generateSOQLWithContext(question, objectHint, conversationHistory);
    
    if (soqlResult.needsClarification) {
      return res.json(soqlResult);
    }

    const queryResult = await query(soqlResult.soql);

    const explainPrompt = `Question: "${question}"
SOQL: ${soqlResult.soql}
Results: ${JSON.stringify(queryResult.records.slice(0, 3))}

Explain clearly what this shows. Format numbers/dates properly.`;

    const llmRes = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: 'user', content: explainPrompt }],
        temperature: 0.7,
        max_tokens: 512
      })
    });

    const llmData = await llmRes.json();

    res.json({
      question,
      soql: soqlResult.soql,
      data: queryResult,
      explanation: llmData.choices[0].message.content,
      recordCount: queryResult.totalSize,
      response: `Found ${queryResult.totalSize} records`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    if (!NVIDIA_API_KEY) return res.status(503).json({ error: 'LLM not configured' });

    const { message, conversationHistory = [], includeSchema = false } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    let systemPrompt = `You are a helpful Salesforce assistant. You can:
- Answer questions about Salesforce
- Help with SOQL queries (suggest using /smart-query for data questions)
- Explain Salesforce concepts
- Provide best practices

Be concise and helpful.`;

    if (includeSchema) {
      const schema = await getOrgSchema();
      systemPrompt += `\n\nAvailable objects:\n${formatSchema(schema)}`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: message }
    ];

    const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 1024
      })
    });

    const data = await response.json();
    res.json({
      response: data.choices[0].message.content,
      model: NVIDIA_MODEL
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STARTUP
// ============================================

console.log('🚀 Starting Salesforce MCP Provider...');
console.log(`SF Auth: ${SF_ACCESS_TOKEN ? 'Token' : 'Username/Password'}`);
console.log(`LLM: ${NVIDIA_API_KEY ? 'Configured' : 'Not configured'}`);

try {
  await getConnection();
  console.log('✅ Salesforce connected');
  await getOrgSchema();
  console.log('✅ Schema loaded');
} catch (error) {
  console.error('❌ Startup failed:', error.message);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log('   Endpoints: /health, /schema, /query, /smart-query, /chat');
});
import express from 'express';
import cors from 'cors';
import jsforce from 'jsforce';
import { buildSOQLPrompt, getSummarizeSystemPrompt, getCalculationPrompt, getExplanationPrompt, getChatSystemPrompt } from './prompts.js';

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

async function getEnrichedSchema(objectsToEnrich = null) {
  const schema = await getOrgSchema();
  const enrichedSchema = { ...schema, relationships: {} };
  
  // If specific objects provided, enrich those. Otherwise enrich all standard objects.
  const objectsToProcess = objectsToEnrich && objectsToEnrich.length > 0 
    ? objectsToEnrich 
    : schema.standard.map(o => o.apiName).concat(schema.custom.map(o => o.apiName));
  
  // Limit to avoid excessive API calls if enriching all objects
  const maxObjectsToEnrich = objectsToEnrich ? 50 : 20;
  const objectsToFetch = objectsToProcess.slice(0, maxObjectsToEnrich);
  
  for (const objName of objectsToFetch) {
    try {
      const objSchema = await getObjectSchema(objName);
      enrichedSchema.relationships[objName] = {
        fields: objSchema.fields,
        lookupFields: objSchema.fields.filter(f => 
          f.DataType === 'Reference' || 
          f.QualifiedApiName.endsWith('Id')
        )
      };
    } catch (err) {
      // Silently skip if object doesn't exist in org
    }
  }
  
  return enrichedSchema;
}

// ============================================
// IMPROVED SOQL GENERATION
// ============================================

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
  
  const isReferencingPrevious = /\b(above|those|these|previous|that|them)\b/i.test(question);
  const isAddingFields = /\b(related|also|as well|include|show|add|too)\b/i.test(question) && isReferencingPrevious;
  
  const allObjects = [...schema.standard, ...schema.custom];
  const questionLower = question.toLowerCase();
  const mentionedObjects = allObjects.filter(obj => 
    questionLower.includes(obj.apiName.toLowerCase()) ||
    questionLower.includes(obj.label.toLowerCase())
  );
  
  // Collect all objects that might need relationship info
  const objectsForEnrichment = new Set();
  
  // Add detected object
  if (detectedObject) objectsForEnrichment.add(detectedObject);
  
  // Add mentioned objects from question
  mentionedObjects.forEach(obj => objectsForEnrichment.add(obj.apiName));
  
  // Add previous object from conversation
  let previousObject = null;
  let previousLimit = null;
  let previousWhereClause = null;
  let previousRecordIds = [];
  
  if (conversationHistory.length > 0) {
    const lastQuery = conversationHistory[conversationHistory.length - 1];
    const fromMatch = lastQuery.soql.match(/FROM\s+(\w+)/i);
    if (fromMatch) {
      previousObject = fromMatch[1];
      objectsForEnrichment.add(previousObject);
    }
    
    const limitMatch = lastQuery.soql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      previousLimit = limitMatch[1];
    }
    
    const whereMatch = lastQuery.soql.match(/WHERE\s+(.+?)(?:ORDER BY|LIMIT|$)/i);
    if (whereMatch) {
      previousWhereClause = whereMatch[1].trim();
    }
    
    // Extract actual record IDs from previous results
    if (lastQuery.results && Array.isArray(lastQuery.results) && lastQuery.results.length > 0) {
      previousRecordIds = lastQuery.results
        .filter(r => r && r.Id)
        .map(r => r.Id)
        .slice(0, 200); // Limit to 200 IDs to avoid query length issues
    }
  }
  
  // Now enrich schema for all detected objects (always enrich at least previous/current)
  let objectsToEnrichList = Array.from(objectsForEnrichment);
  if (objectsToEnrichList.length === 0) {
    if (previousObject) objectsToEnrichList.push(previousObject);
    if (detectedObject) objectsToEnrichList.push(detectedObject);
  }
  const enrichedSchema = objectsToEnrichList.length > 0 
    ? await getEnrichedSchema(objectsToEnrichList) 
    : { standard: schema.standard, custom: schema.custom, relationships: {} };
  const schemaText = formatSchema(schema);

  let objectFieldsList = '';
  let isFieldsQuery = false;
  
  if (detectedObject || fieldQueryMatch) {
    try {
      const targetObject = detectedObject || fieldQueryMatch[1];
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

  const isDifferentObject = previousObject && detectedObject && 
                            detectedObject.toLowerCase() !== previousObject.toLowerCase();
  const hasRelatedKeywords = /\b(related|from|of|for)\b/i.test(question);
  const isNewQuery = isDifferentObject && !hasRelatedKeywords && !isAddingFields;
  
  let conversationContext = '';
  if (conversationHistory.length > 0 && isReferencingPrevious && !isNewQuery) {
    conversationContext = '\n\n=== PREVIOUS CONVERSATION CONTEXT ===\n';
    conversationHistory.slice(-2).forEach((msg, idx) => {
      conversationContext += `\n${idx + 1}. User asked: "${msg.question}"\n`;
      conversationContext += `   SOQL: ${msg.soql}\n`;
      if (msg.recordCount) {
        conversationContext += `   Records found: ${msg.recordCount}\n`;
      }
      
      const idMatch = msg.soql.match(/WHERE\s+Id\s*=\s*'([^']+)'/i);
      if (idMatch) {
        conversationContext += `   ⚠️ IMPORTANT ID: ${idMatch[1]}\n`;
      }
      conversationContext += '\n';
    });
    
    conversationContext += `\n🎯 CONTEXT: User is referring to the LAST query (Object: ${previousObject}).\n\n`;
    
    if (isAddingFields) {
      conversationContext += '⚠️ USER WANTS TO ADD/SHOW MORE FIELDS from SAME records:\n';
      conversationContext += `- Keep SAME object: ${previousObject}\n`;
      if (previousLimit) {
        conversationContext += `- Keep SAME LIMIT: ${previousLimit}\n`;
      }
      if (previousWhereClause) {
        conversationContext += `- Keep SAME WHERE clause: ${previousWhereClause}\n`;
        
        const idInWhere = previousWhereClause.match(/Id\s*=\s*'([^']+)'/i);
        if (idInWhere) {
          conversationContext += `- ⚠️ USE THIS EXACT ID: ${idInWhere[1]}\n`;
        }
      }
      
      // If asking for related data from different object
      if (isDifferentObject && previousRecordIds.length > 0) {
        conversationContext += `\n⚠️ USER ASKING FOR RELATED DATA FROM DIFFERENT OBJECT:\n`;
        conversationContext += `- Previous object: ${previousObject}\n`;
        conversationContext += `- User is asking for data about DIFFERENT object type\n`;
        conversationContext += `- Previous returned ${previousRecordIds.length} record IDs\n`;
        conversationContext += `- ❌ WRONG: SELECT from previous object with new WHERE - returns SAME object type\n`;
        conversationContext += `- ❌ WRONG: Invalid subqueries or non-existent relationships\n`;
        conversationContext += `- ✅ CORRECT: Use lookup fields from the RELATIONSHIP REFERENCE below\n`;
        conversationContext += `- Then SELECT from the TARGET object\n`;
        conversationContext += `- Example pattern:\n`;
        
        // Use ACTUAL record IDs from previous query (first 2-3)
        const exampleIds = previousRecordIds.slice(0, 2);
        const exampleIdString = exampleIds.map(id => `'${id}'`).join(', ');
        
        // Find example lookup fields from previous object
        const prevObjLookups = (enrichedSchema && enrichedSchema.relationships && enrichedSchema.relationships[previousObject]) 
          ? enrichedSchema.relationships[previousObject].lookupFields 
          : [];
        const exampleLookupField = (prevObjLookups && prevObjLookups.length > 0 && prevObjLookups[0] && prevObjLookups[0].QualifiedApiName) 
          ? prevObjLookups[0].QualifiedApiName 
          : 'AccountId';
        
        conversationContext += `  SELECT Id, Name FROM [TargetObject] WHERE Id IN (SELECT ${exampleLookupField} FROM ${previousObject} WHERE Id IN (${exampleIdString}))\n`;
        conversationContext += `  Replace [TargetObject] with the object name the user is asking for\n`;
        conversationContext += `  Use lookup fields from OBJECT RELATIONSHIPS section to identify correct field\n\n`;
        
        conversationContext += `  ⚠️ EXAMPLES based on common relationships:\n`;
        // Generate examples based on what we know about the previous object
        if (previousObject === 'Contact') {
          conversationContext += `  - Contact → Account: SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Id IN (${exampleIdString}))\n`;
        } else if (previousObject === 'Opportunity') {
          conversationContext += `  - Opportunity → Account: SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity WHERE Id IN (${exampleIdString}))\n`;
        } else if (previousObject === 'Case') {
          conversationContext += `  - Case → Account: SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Case WHERE Id IN (${exampleIdString}))\n`;
        } else if (previousObject === 'Task' || previousObject === 'Event') {
          conversationContext += `  - ${previousObject} → Account: SELECT Id, Name FROM Account WHERE Id IN (SELECT WhatId FROM ${previousObject} WHERE WhatId != null AND WhatId LIKE '001%' AND Id IN (${exampleIdString}))\n`;
        }
        
        conversationContext += `  Use OBJECT RELATIONSHIPS & LOOKUP FIELDS section to find correct field and target\n\n`;
      } else {
        conversationContext += `- ADD the requested fields (Account.Name, Who.Name, What.Name, etc.)\n`;
      }
      
      conversationContext += `\nExample:\n`;
      conversationContext += `  Previous: SELECT Id, Subject FROM Task WHERE Id = '00TGA00003fTAL32AO'\n`;
      conversationContext += `  User: "show client name too"\n`;
      conversationContext += `  Generate: SELECT Id, Subject, WhoId, Who.Name, WhatId, What.Name FROM Task WHERE Id = '00TGA00003fTAL32AO'\n\n`;
    } else {
      conversationContext += '- Reuse WHERE conditions, LIMIT, ORDER BY when appropriate\n';
      conversationContext += '- For related objects, use subqueries or relationship fields\n';
      conversationContext += '- ALWAYS use exact IDs from previous queries\n\n';
    }
  } else if (conversationHistory.length > 0 && isNewQuery) {
    conversationContext = '\n\n=== NEW QUERY ===\nThis is a different topic. Generate a fresh SOQL query.\n\n';
  }

  const prompt = buildSOQLPrompt(question, schemaText, objectFieldsList, conversationContext, detectedObject, isFieldsQuery, enrichedSchema, currentUserId);

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
  
  // Validation: Check for common errors
  if (result.includes('SELECT *')) {
    console.warn('⚠️ Found SELECT * - replacing with Id, Name');
    result = result.replace(/SELECT \*/gi, 'SELECT Id, Name');
  }
  
  // Validation: Check for placeholder IDs
  const placeholderPatterns = [
    /your_\w+_id/i,
    /replace_with/i,
    /\[id\]/i,
    /'id'/i,
    /'xxx'/i,
    /'003xxx'/i,
    /'003yyy'/i
  ];
  
  const hasPlaceholder = placeholderPatterns.some(pattern => pattern.test(result));
  if (hasPlaceholder) {
    console.error('❌ LLM generated placeholder ID');
    console.error('   Generated query:', result);
    
    // Try to fix using IDs from previous query results
    if (previousRecordIds.length > 0) {
      console.log(`✅ Replacing placeholders with ${previousRecordIds.length} IDs from previous results`);
      
      // Replace IN clause with actual IDs
      const inClauseMatch = result.match(/WHERE\s+Id\s+IN\s*\([^)]+\)/i);
      if (inClauseMatch) {
        const idsString = previousRecordIds.map(id => `'${id}'`).join(', ');
        result = result.replace(/WHERE\s+Id\s+IN\s*\([^)]+\)/i, `WHERE Id IN (${idsString})`);
      }
      
      // Replace single placeholder IDs
      result = result.replace(/('your_\w+_id'|'replace_with[^']*'|'\[id\]'|'id'|'xxx'|'003xxx'|'003yyy')/gi, `'${previousRecordIds[0]}'`);
    } else if (conversationHistory.length > 0) {
      // Fallback: try to get ID from previous SOQL
      const lastQuery = conversationHistory[conversationHistory.length - 1].soql;
      const idFromPrevious = lastQuery.match(/WHERE\s+Id\s*=\s*'([^']+)'/i);
      
      if (idFromPrevious) {
        console.log('✅ Fixing with ID from previous SOQL:', idFromPrevious[1]);
        result = result.replace(/('your_\w+_id'|'replace_with[^']*'|'\[id\]'|'id'|'xxx'|'003xxx'|'003yyy')/gi, `'${idFromPrevious[1]}'`);
      }
    }
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

// generate SOQL with context endpoint
app.post('/generate-soql', async (req, res) => {
  try {
    const { question, objectHint, conversationHistory = [] } = req.body;
    
    // Pass history here. Your internal logic (isNewQuery) 
    // will determine if it actually gets used in the prompt.
    const result = await generateSOQLWithContext(question, objectHint, conversationHistory);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/summarize', async (req, res) => {
    try {
        if (!NVIDIA_API_KEY) return res.status(503).json({ error: 'LLM not configured' });
        const { textData, isChunk, isFinal } = req.body;

        const systemPrompt = getSummarizeSystemPrompt();

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
                temperature: 0.1,
                // Remove response_format: {type: 'json_object'} if it keeps failing, 
                // as some NVIDIA endpoints handle it poorly.
            })
        });

        const data = await response.json();
        let content = data.choices[0].message.content.trim();
        console.log(`Raw summary response: ${content}`);

        // --- THE "BULLETPROOF" CLEANER ---
        // 1. Remove markdown blocks
        content = content.replace(/```json|```/g, "").trim();
        console.log(`Remove markdown blocks summary response: ${content}`);
        // 2. Find the FIRST '{' and the LAST '}'
        const firstBracket = content.indexOf('{');
        const lastBracket = content.lastIndexOf('}');
        
        if (firstBracket === -1 || lastBracket === -1) {
            throw new Error("No JSON object found in LLM response");
        }
        
        // 3. Slice the string to get ONLY the JSON block
        content = content.substring(firstBracket, lastBracket + 1);
        console.log(`Removed bracket summary response: ${content}`);
        // 4. Sanitize internal newlines that break JSON parsing
        content = content.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
        console.log(`Removed regex summary response: ${content}`);
        // 5. Attempt Parse
        const finalJson = JSON.parse(content);
        console.log(`final summary response: ${content}`);
        res.json(finalJson);

    } catch (error) {
        console.error('❌ Final Failure:', error.message);
        // Fallback so the LWC doesn't break
        res.status(200).json({ 
            summary: "Error parsing result. Check server logs.", 
            sentiment: "Neutral" 
        });
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

      const calcPrompt = getCalculationPrompt(lastConv.question, lastConv.recordCount, lastConv.results, question);

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

    const explainPrompt = getExplanationPrompt(question, soqlResult.soql, queryResult.records);

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

    let systemPrompt = getChatSystemPrompt(includeSchema ? formatSchema(await getOrgSchema()) : null);

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
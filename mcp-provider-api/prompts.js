/**
 * Centralized prompts for LLM interactions
 * Used by http-server.js to provide context-aware prompts
 */

/**
 * Builds the SOQL generation prompt with schema and conversation context
 * @param {string} question - User's question
 * @param {string} schemaText - Formatted schema information
 * @param {string} objectFieldsList - Fields for detected object
 * @param {string} conversationContext - Previous conversation history
 * @param {string} detectedObject - Object name detected from question
 * @param {boolean} isFieldsQuery - Whether user is asking for field list
 * @param {object} enrichedSchema - Schema with relationships
 * @param {string} userId - Current user ID
 * @returns {string} Complete prompt for SOQL generation
 */
export function buildSOQLPrompt(question, schemaText, objectFieldsList, conversationContext, detectedObject, isFieldsQuery, enrichedSchema, userId = 'UNKNOWN_USER') {
  const today = new Date().toISOString().split('T')[0];

  // Extract Salesforce IDs from question
  const idPattern = /\b([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})\b/g;
  const extractedIds = question.match(idPattern) || [];
  
  let idContext = '';
  if (extractedIds.length > 0) {
    idContext = `\n=== SALESFORCE IDs DETECTED ===\n`;
    extractedIds.forEach(id => idContext += `- ${id}\n`);
    idContext += `⚠️ Use these EXACT IDs. NO placeholders like 'your_id' or 'your_task_id'.\n\n`;
  }

  // Build relationship reference for key objects
  let relationshipRefrence = '';
  if (enrichedSchema && enrichedSchema.relationships && Object.keys(enrichedSchema.relationships).length > 0) {
    relationshipRefrence = '\n=== OBJECT RELATIONSHIPS & LOOKUP FIELDS ===\n';
    Object.entries(enrichedSchema.relationships).forEach(([objName, data]) => {
      const lookupFields = data && data.lookupFields ? data.lookupFields : [];
      if (lookupFields.length > 0) {
        relationshipRefrence += `\n${objName}:\n`;
        lookupFields.forEach(field => {
          if (field && field.QualifiedApiName && field.DataType) {
            relationshipRefrence += `  - ${field.QualifiedApiName} (${field.DataType})\n`;
          }
        });
      }
    });
  }

  return `You are a Salesforce SOQL expert. Generate VALID, EXECUTABLE SOQL queries.

=== CRITICAL RULES ===

1. FIELD SELECTION:
   ❌ NEVER: SELECT *
   ✅ ALWAYS: SELECT Id, Name, Field1__c FROM Object

2. SALESFORCE IDs:
   ✅ Use EXACT 15/18 character IDs: WHERE Id = '00TGA00003fTAL32AO'
   ❌ NO placeholders: 'your_id', 'your_task_id', 'replace_with_id', 'xxx'

3. ADDRESS FIELDS:
   ❌ NEVER: SELECT Address FROM Account
   ✅ ALWAYS use components:
      - Billing: BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry
      - Shipping: ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode, ShippingCountry
      - Mailing: MailingStreet, MailingCity, MailingState, MailingPostalCode, MailingCountry
      - Other: OtherStreet, OtherCity, OtherState, OtherPostalCode, OtherCountry

4. POLYMORPHIC FIELDS (Task/Event):
   - WhoId → Contact or Lead (people)
   - WhatId → Account, Opportunity, Case (things)
   - ✅ Query both: SELECT WhoId, Who.Name, WhatId, What.Name FROM Task
   - ✅ Use Who.Type and What.Type to identify object type
   - For "client" questions: include BOTH Who and What (client could be either)
   
   Polymorphic Examples:
   - "task for account": SELECT Id, Subject, WhatId, What.Name FROM Task WHERE WhatId != null AND WhatId LIKE '001%' LIMIT 5
   - "task for contact": SELECT Id, Subject, WhoId, Who.Name FROM Task WHERE WhoId != null AND WhoId LIKE '003%' LIMIT 5
   - "client for task [ID]": SELECT Id, WhoId, Who.Name, Who.Type, WhatId, What.Name, What.Type FROM Task WHERE Id = '[specific task ID]'

5. USER CONTEXT:
   - Current User ID: '${userId}'
   - Today: ${today}
   - "My tasks": WHERE OwnerId = '${userId}'
   - "My opportunities": WHERE OwnerId = '${userId}'
   - ❌ NO bind variables (:userId)

6. TOP N / SORTING:
   - "Top 5": WHERE Amount > 0 ORDER BY Amount DESC LIMIT 5
   - "Random 5": ORDER BY RANDOM() LIMIT 5 (NOT SUPPORTED - use just LIMIT 5)
   - "Latest 10": ORDER BY CreatedDate DESC LIMIT 10

7. DATE LITERALS:
   Day-based: TODAY, YESTERDAY, TOMORROW
   Week-based: THIS_WEEK, LAST_WEEK, NEXT_WEEK
   Month-based: THIS_MONTH, LAST_MONTH, NEXT_MONTH
   Quarter-based: THIS_QUARTER, LAST_QUARTER, NEXT_QUARTER
   Year-based: THIS_YEAR, LAST_YEAR, NEXT_YEAR
   
   Range literals:
   - LAST_N_DAYS:n (e.g., LAST_N_DAYS:30)
   - NEXT_N_DAYS:n (e.g., NEXT_N_DAYS:7)
   - LAST_N_WEEKS:n, NEXT_N_WEEKS:n
   - LAST_N_MONTHS:n, NEXT_N_MONTHS:n
   - LAST_N_QUARTERS:n, NEXT_N_QUARTERS:n
   - LAST_N_YEARS:n, NEXT_N_YEARS:n
   
   Date formats:
   - Date: YYYY-MM-DD (e.g., 2024-12-30)
   - DateTime: YYYY-MM-DDTHH:MM:SSZ (e.g., 2024-12-30T15:30:00Z)
   
   Examples:
   - WHERE CreatedDate = TODAY
   - WHERE CreatedDate > LAST_N_DAYS:30
   - WHERE CloseDate >= THIS_MONTH
   - WHERE LastModifiedDate = YESTERDAY

8. RELATIONSHIPS:
   - Child-to-Parent: Account.Name, Contact.Account.Name, Opportunity.Account.Owner.Name
   - Parent-to-Child: (SELECT Id, Name FROM Contacts), (SELECT Id, Name FROM Opportunities)
   - Custom: Custom__r.Name, Custom__r.Field__c

9. SWITCHING BETWEEN OBJECTS:
   ❌ NEVER create invalid subqueries: SELECT ... FROM Account WHERE Id IN (SELECT ... FROM Accounts)
   ✅ To get related records from a different object:
      1. Identify the lookup field (e.g., AccountId on Contact points to Account)
      2. SELECT from the TARGET object using IN with a subquery on the SOURCE object
      3. Example: "Give me account details for these contacts"
         - Target object: Account
         - Source object: Contact (previous results)
         - Lookup field: Contact.AccountId
         - CORRECT: SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Id IN (SELECT Id FROM Contact LIMIT 2))
         - WRONG: SELECT Id, Name FROM Contact WHERE Id IN (SELECT Id FROM Contact LIMIT 2) [returns contacts, not accounts]
         - WRONG: SELECT * FROM Account WHERE Id IN (SELECT * FROM Contact WHERE AccountId != null) [invalid nesting]

${idContext}

=== EXAMPLES ===

"task 00TGA00003fTAL32AO"
→ SELECT Id, Subject, Status, WhoId, Who.Name, WhatId, What.Name FROM Task WHERE Id = '00TGA00003fTAL32AO'

"client for task 00TGA00003fTAL32AO"
→ SELECT Id, WhoId, Who.Name, Who.Type, WhatId, What.Name, What.Type FROM Task WHERE Id = '00TGA00003fTAL32AO'

"my open tasks"
→ SELECT Id, Subject, Status, ActivityDate, WhoId, Who.Name, WhatId, What.Name FROM Task WHERE OwnerId = '${userId}' AND IsClosed = false

"top 5 opportunities"
→ SELECT Id, Name, Amount, StageName FROM Opportunity WHERE Amount > 0 ORDER BY Amount DESC LIMIT 5

"contacts in California"
→ SELECT Id, Name, Email, MailingCity, MailingState FROM Contact WHERE MailingState = 'CA'

"accounts with billing address in NY"
→ SELECT Id, Name, BillingStreet, BillingCity, BillingState FROM Account WHERE BillingState = 'NY'

"opportunities closed this month"
→ SELECT Id, Name, Amount, CloseDate FROM Opportunity WHERE CloseDate = THIS_MONTH

"tasks created in last 7 days"
→ SELECT Id, Subject, CreatedDate FROM Task WHERE CreatedDate > LAST_N_DAYS:7

"leads updated yesterday"
→ SELECT Id, Name, Email, LastModifiedDate FROM Lead WHERE LastModifiedDate = YESTERDAY

"give me 5 contacts"
→ SELECT Id, Name, Email, Phone FROM Contact LIMIT 5

"account details of contacts"
→ SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact)

"accounts for these contacts"
→ SELECT Id, Name, BillingCity, BillingState FROM Account WHERE Id IN (SELECT AccountId FROM Contact LIMIT 5)

"accounts with opportunities"
→ SELECT Id, Name, (SELECT Id, Name, Amount FROM Opportunities) FROM Account

=== SCHEMA ===
${schemaText}
${objectFieldsList}
${relationshipRefrence}
${conversationContext}

=== QUESTION ===
${question}

${isFieldsQuery ? `LIST ALL FIELDS from ${detectedObject}` : ''}

Respond with ONLY the SOQL query. No markdown, no explanation.
If unclear: CLARIFICATION_NEEDED: [question]`;
}

/**
 * Summarize text prompt - used for summarizing content
 * @returns {string} System prompt for summarization
 */
export function getSummarizeSystemPrompt() {
  return `You are a JSON-only response bot. 
        Return ONLY valid JSON. No preamble. No markdown. No explanations.
        Required Format: {"summary": "your text here", "sentiment": "Neutral"}`;
}

/**
 * Calculation prompt - used for aggregations on previous query results
 * @param {string} lastQuestion - Previous user question
 * @param {number} recordCount - Number of records from previous query
 * @param {array} sampleData - Sample records from previous query
 * @param {string} currentQuestion - Current user question
 * @returns {string} Prompt for calculating on previous data
 */
export function getCalculationPrompt(lastQuestion, recordCount, sampleData, currentQuestion) {
  return `Previous query: "${lastQuestion}"
Returned: ${recordCount} records

Sample data:
${JSON.stringify(sampleData.slice(0, 5), null, 2)}

Current question: "${currentQuestion}"

Identify numeric field, perform calculation, format result.
OUTPUT FORMAT:
RESULT: [answer]
EXPLANATION: [reasoning]`;
}

/**
 * Explanation prompt - used for explaining query results
 * @param {string} question - Original user question
 * @param {string} soql - Generated SOQL query
 * @param {array} results - Sample results from query
 * @returns {string} Prompt for explaining results
 */
export function getExplanationPrompt(question, soql, results) {
  return `Question: "${question}"
    SOQL: ${soql}
    Results: ${JSON.stringify(results.slice(0, 3))}

    Explain clearly what this shows. Format numbers/dates properly.`;
}

/**
 * Chat system prompt - used for general Salesforce assistant conversations
 * @param {string} schemaText - Optional formatted schema information
 * @returns {string} System prompt for chat
 */
export function getChatSystemPrompt(schemaText) {
  return `You are a helpful Salesforce assistant. You can:
                      - Answer questions about Salesforce
                      - Help with SOQL queries (suggest using /smart-query for data questions)
                      - Explain Salesforce concepts
                      - Provide best practices

                      Be concise and helpful.${schemaText ? `\n\nAvailable objects:\n${schemaText}` : ''}`;
}

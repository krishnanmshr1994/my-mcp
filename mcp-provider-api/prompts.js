/**
 * Centralized prompts for LLM interactions
 * Used by http-server.js to provide context-aware prompts
 * Enhanced version with comprehensive SOQL generation rules
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
  let relationshipReference = '';
  if (enrichedSchema && enrichedSchema.relationships && Object.keys(enrichedSchema.relationships).length > 0) {
    relationshipReference = '\n=== OBJECT RELATIONSHIPS & LOOKUP FIELDS ===\n';
    Object.entries(enrichedSchema.relationships).forEach(([objName, data]) => {
      const lookupFields = data && data.lookupFields ? data.lookupFields : [];
      if (lookupFields.length > 0) {
        relationshipReference += `\n${objName}:\n`;
        lookupFields.forEach(field => {
          if (field && field.QualifiedApiName && field.DataType) {
            relationshipReference += `  - ${field.QualifiedApiName} (${field.DataType})\n`;
          }
        });
      }
    });
  }

  return `You are a Salesforce SOQL expert. Generate VALID, EXECUTABLE SOQL queries.

=== DYNAMIC REASONING FRAMEWORK ===

**You must analyze the schema and context before generating queries. DO NOT use hardcoded assumptions.**

1. **FIELD SELECTION - Context-Aware:**
   When user says "show me contacts" or "get accounts":
   - Analyze the object schema
   - Always include: Id, Name (or equivalent identifier)
   - Add contextual fields based on object type:
     * People objects (Contact, Lead) → Add Email, Phone
     * Account objects → Add Industry, BillingCity, BillingState
     * Opportunity → Add Amount, StageName, CloseDate
     * Case → Add Status, Priority, Subject
     * Task/Event → Add Subject, ActivityDate, Status
     * Custom objects → Examine schema for key fields (look for Email, Status, Date, Amount patterns)

2. **"TOP N" REASONING - Analyze Schema:**
   When user asks "top 5 [objects]" or "best [objects]":
   
   Step 1: Identify the object type
   Step 2: Examine available fields for ranking candidates:
      - Currency fields: Amount, Price, Revenue, Value, Total
      - Numeric fields: Score, Rating, Marks, GPA, Count, Quantity
      - Date fields: CreatedDate (for "latest"), CloseDate (for "soonest")
   Step 3: Choose the most logical field:
      - Opportunity/Quote/Order → Amount field
      - Student/Employee → Score/Rating/Performance field
      - Product → Sales/Units/Revenue field
      - Support objects → Priority or CreatedDate
      - Custom objects → Search for *Amount*, *Score*, *Value*, *Total* pattern fields
   Step 4: If ambiguous or no clear field → CLARIFICATION_NEEDED: "Top 5 by which field?"
   
   Examples:
   - "top 5 opportunities" → Check schema → Amount found → ORDER BY Amount DESC LIMIT 5
   - "top students" → Check schema → GPA__c found → ORDER BY GPA__c DESC LIMIT 10
   - "best products" → Check schema → Revenue__c or Units_Sold__c → ORDER BY [chosen field] DESC

3. **FILTER REASONING - Understand Intent:**
   When user asks about status or state:
   - "open" → Typically IsClosed = false OR Status != 'Closed'
   - "active" → Typically IsActive = true OR Status = 'Active'
   - "my" → OwnerId = '${userId}'
   - "today/this week/this month" → Use date literals on appropriate date field
   
   Dynamic Status Detection:
   - Check if object has IsClosed field → use that
   - Check if object has Status field → examine picklist values
   - Check if object has IsActive field → use that
   - For custom objects → look for *Status*, *Active*, *Closed* pattern fields

4. **RELATIONSHIP REASONING - Infer Connections:**
   When user mentions related objects:
   - "opportunities with accounts" → Opportunity has AccountId → SELECT Account.Name
   - "contacts for this account" → Contact has AccountId → use parent-to-child subquery
   - "tasks for contacts" → Task.WhoId → polymorphic relationship
   
   Dynamic Relationship Detection:
   - Parse schema for lookup fields (*Id, *__c fields with reference type)
   - Identify parent-child relationships from schema metadata
   - Suggest relationship fields when user asks for "related" or "with"

5. **AGGREGATION REASONING - Contextual Grouping:**
   When user asks "count by" or "total by":
   - Identify the grouping field (typically picklist or lookup)
   - Identify the aggregation field (typically numeric/currency)
   - Common patterns:
     * "by stage" → GROUP BY StageName
     * "by owner" → GROUP BY OwnerId
     * "by account" → GROUP BY AccountId
     * "by region/state" → GROUP BY State or Region__c
     * For custom objects → look for picklist and reference fields

6. **DATE FIELD REASONING:**
   When user mentions time:
   - "created" → Use CreatedDate
   - "updated/modified" → Use LastModifiedDate
   - "closed" → Use CloseDate (if exists)
   - "due" → Use ActivityDate or DueDate
   - For custom objects → look for fields with Date/DateTime type

7. **ADDRESS HANDLING:**
   Dynamically determine address type:
   - Account → Prefer Billing, fallback to Shipping
   - Contact/Lead → Prefer Mailing, fallback to Other
   - Custom objects → Check schema for *Street, *City, *State patterns

1. FIELD SELECTION:
   ❌ NEVER: SELECT *
   ✅ ALWAYS: SELECT Id, Name, Field1__c FROM Object
   ✅ Be specific about which fields to retrieve

2. SALESFORCE IDs:
   ✅ Use EXACT 15/18 character IDs: WHERE Id = '00TGA00003fTAL32AO'
   ❌ NO placeholders: 'your_id', 'your_task_id', 'replace_with_id', 'xxx'
   
   Common Object ID Prefixes (for LIKE filters):
   - 001: Account
   - 003: Contact
   - 00Q: Lead
   - 006: Opportunity
   - 500: Case
   - 00T: Task
   - 00U: Event
   - 005: User

3. ADDRESS FIELDS - CONTEXTUAL DEFAULTS:
   ❌ NEVER: SELECT Address FROM Account (compound fields don't exist)
   ❌ NEVER: SELECT MailingAddress FROM Contact
   ✅ ALWAYS use individual components:
      - Billing: BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry
      - Shipping: ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode, ShippingCountry
      - Mailing: MailingStreet, MailingCity, MailingState, MailingPostalCode, MailingCountry
      - Other: OtherStreet, OtherCity, OtherState, OtherPostalCode, OtherCountry
   
   **DYNAMIC ADDRESS TYPE SELECTION:**
   When user asks for "address" without specifics, intelligently choose based on object:
   - Account → Default to Billing (primary business address)
   - Contact/Lead → Default to Mailing (personal correspondence address)
   - Custom objects → Check schema for available address fields, use most common pattern
   
   If user asks "show address" or "get location":
   1. Check which address types exist on the object
   2. Select the most appropriate type (Billing > Mailing > Shipping > Other)
   3. Include Street, City, State, PostalCode at minimum

4. POLYMORPHIC FIELDS (Task/Event) & CONVERSATION CONTEXT:
   - WhoId → Contact or Lead (people) - prefix 003 or 00Q
   - WhatId → Account, Opportunity, Case (things) - prefix 001, 006, or 500
   - ✅ Query both: SELECT WhoId, Who.Name, WhatId, What.Name FROM Task
   - ✅ Use Who.Type and What.Type to identify object type
   - For "client" questions: include BOTH Who and What (client could be either)
   
   **CRITICAL: Task/Event CANNOT be used in WHERE IN subqueries**
   
   Polymorphic Query Examples:
   - "task for account": SELECT Id, Subject, WhatId, What.Name FROM Task WHERE WhatId != null AND WhatId LIKE '001%' LIMIT 5
   - "task for contact": SELECT Id, Subject, WhoId, Who.Name FROM Task WHERE WhoId != null AND WhoId LIKE '003%' LIMIT 5
   - "client for task [ID]": SELECT Id, WhoId, Who.Name, Who.Type, WhatId, What.Name, What.Type FROM Task WHERE Id = '[specific task ID]'
   
   **CONVERSATION CONTEXT - Follow-up Questions:**
   
   When user asks follow-up questions about previous Task/Event results:
   
   Scenario: User first asks "my tasks" then "show me the account for the first task"
   
   ❌ WRONG: SELECT Id, Name FROM Account WHERE Id IN (SELECT WhatId FROM Task WHERE ...)
   ❌ ERROR: "Entity 'Task' is not supported for semi join inner selects"
   
   ✅ CORRECT Approaches:
   
   Option 1: Use relationship traversal directly
   SELECT Id, Subject, What.Id, What.Name, What.Type, What.Industry FROM Task WHERE Id = '[task_id]'
   (This gives you account details in one query via What.* fields)
   
   Option 2: Two-step explanation
   Respond: "From the previous task, the WhatId is [ID] linking to [Account Name]. To get full account details:"
   Then: SELECT Id, Name, Industry, BillingCity, BillingState FROM Account WHERE Id = '[extracted_what_id]'
   
   Option 3: If you have the task ID from context
   First query: SELECT WhatId FROM Task WHERE Id = '[task_id]'
   Then use the result: SELECT Id, Name, Industry FROM Account WHERE Id = '[result_what_id]'
   
   **Key Point:** Never try to use Task/Event as the inner SELECT in a WHERE IN clause

5. USER CONTEXT:
   - Current User ID: '${userId}'
   - Today: ${today}
   - "My tasks": WHERE OwnerId = '${userId}'
   - "My opportunities": WHERE OwnerId = '${userId}'
   - "My records": WHERE OwnerId = '${userId}'
   - ❌ NO bind variables (:userId) - always use the actual ID

6. TOP N / SORTING / LIMITS - CONTEXTUAL REASONING:
   
   **CRITICAL: "Top N" requires contextual analysis of the object and available fields**
   
   When user asks for "top 5" or "best" or "highest":
   1. **Analyze the object type** to infer what "top" means
   2. **Examine available numeric/currency fields** in the schema
   3. **Choose the most logical field** for ranking
   
   Reasoning Examples:
   - Opportunity → "top 5" likely means highest Amount (currency field)
   - Case → "top priority" likely means Priority field or oldest CreatedDate
   - Student__c → "top 5" likely means highest Marks__c or GPA__c
   - Product__c → "top selling" likely means Units_Sold__c or Revenue__c
   - Invoice__c → "top 5" likely means highest Total_Amount__c
   - Employee__c → "top performers" likely means highest Performance_Score__c or Sales__c
   
   **Decision Tree for "Top N":**
   
   IF object has Amount/Value/Price/Revenue field → ORDER BY that field DESC
   ELSE IF object has Score/Rating/Marks/Grade field → ORDER BY that field DESC
   ELSE IF object has Count/Quantity/Units field → ORDER BY that field DESC
   ELSE IF user says "latest/recent/newest" → ORDER BY CreatedDate DESC
   ELSE IF user says "oldest" → ORDER BY CreatedDate ASC
   ELSE → Ask for clarification: "Top 5 by which field? Amount, Date, or something else?"
   
   Examples of Dynamic Reasoning:
   - "top 5 opportunities" → Analyze schema → Found Amount field → ORDER BY Amount DESC LIMIT 5
   - "top 10 students" → Analyze schema → Found GPA__c field → ORDER BY GPA__c DESC LIMIT 10
   - "best performing products" → Analyze schema → Found Sales_Count__c → ORDER BY Sales_Count__c DESC
   - "highest priority cases" → Analyze Priority field → ORDER BY Priority DESC (if High=3, Medium=2, Low=1)
   
   **Generic Patterns:**
   - "Latest/Recent/Newest N": ORDER BY CreatedDate DESC LIMIT N
   - "Oldest N": ORDER BY CreatedDate ASC LIMIT N
   - "First N": Just LIMIT N (insertion order)
   - ❌ NO RANDOM() - Salesforce doesn't support random ordering
   - Pagination: LIMIT 10 OFFSET 20
   - Multiple sorts: ORDER BY [Primary Field] DESC, [Secondary Field] ASC

7. DATE LITERALS:
   Day-based: TODAY, YESTERDAY, TOMORROW
   Week-based: THIS_WEEK, LAST_WEEK, NEXT_WEEK
   Month-based: THIS_MONTH, LAST_MONTH, NEXT_MONTH
   Quarter-based: THIS_QUARTER, LAST_QUARTER, NEXT_QUARTER
   Year-based: THIS_YEAR, LAST_YEAR, NEXT_YEAR
   Fiscal: THIS_FISCAL_YEAR, LAST_FISCAL_QUARTER, NEXT_FISCAL_QUARTER
   
   Range literals:
   - LAST_N_DAYS:n (e.g., LAST_N_DAYS:30)
   - NEXT_N_DAYS:n (e.g., NEXT_N_DAYS:7)
   - LAST_N_WEEKS:n, NEXT_N_WEEKS:n
   - LAST_N_MONTHS:n, NEXT_N_MONTHS:n
   - LAST_N_QUARTERS:n, NEXT_N_QUARTERS:n
   - LAST_N_YEARS:n, NEXT_N_YEARS:n
   
   Date formats:
   - Date: YYYY-MM-DD (e.g., WHERE BirthDate = 2024-12-30)
   - DateTime: YYYY-MM-DDTHH:MM:SSZ (e.g., WHERE CreatedDate > 2024-12-30T15:30:00Z)
   - ❌ NO quotes around dates: WHERE CreatedDate = 2024-01-15 (not '2024-01-15')
   
   Examples:
   - WHERE CreatedDate = TODAY
   - WHERE CreatedDate > LAST_N_DAYS:30
   - WHERE CloseDate >= THIS_MONTH
   - WHERE LastModifiedDate = YESTERDAY
   - WHERE CloseDate = THIS_FISCAL_YEAR

8. RELATIONSHIPS:
   - Child-to-Parent (Dot notation): Account.Name, Contact.Account.Name, Opportunity.Account.Owner.Name
   - Parent-to-Child (Subquery): (SELECT Id, Name FROM Contacts), (SELECT Id, Name FROM Opportunities)
   - Custom objects: Custom__r.Name, Custom__r.Field__c
   - RecordType: SELECT Id, Name, RecordType.Name FROM Account WHERE RecordType.Name = 'Partner'
   - Owner info: SELECT Id, Name, Owner.Name, Owner.Email FROM Opportunity

9. SWITCHING BETWEEN OBJECTS & SEMI-JOIN LIMITATIONS:
   
   **CRITICAL: Some objects cannot be used in WHERE IN subqueries (semi-joins)**
   
   **Objects that CANNOT be used in semi-joins:**
   - Task (use direct query instead)
   - Event (use direct query instead)
   - ActivityHistory
   - OpenActivity
   - Other objects with polymorphic relationships
   
   **WRONG APPROACH - Semi-join with Task:**
   ❌ SELECT Id, Name FROM Account WHERE Id IN (SELECT WhatId FROM Task WHERE Id = 'xxx')
   ❌ SELECT Id, Name FROM Contact WHERE Id IN (SELECT WhoId FROM Task WHERE Status = 'Open')
   
   **CORRECT APPROACH - Query Task directly and extract IDs:**
   
   For follow-up questions about previous Task/Event results:
   
   Pattern 1: When user asks about "account for this task":
   Step 1: Query the Task to get WhatId
   ✅ SELECT Id, Subject, WhatId, What.Name, What.Type FROM Task WHERE Id = 'xxx'
   Step 2: Extract WhatId from result, then query Account if needed
   ✅ SELECT Id, Name, Industry, BillingCity FROM Account WHERE Id = '[extracted WhatId]'
   
   Pattern 2: When user asks about "contact for this task":
   ✅ SELECT Id, Subject, WhoId, Who.Name, Who.Type FROM Task WHERE Id = 'xxx'
   Then if needed: SELECT Id, Name, Email, Phone FROM Contact WHERE Id = '[extracted WhoId]'
   
   Pattern 3: When asked "account associated with above task" in conversation:
   **DO NOT use semi-join**
   Instead respond with:
   "Based on the previous task results, I can see the WhatId is [ID] which links to [Account Name]. Would you like more details about this account?"
   
   OR generate two-step approach:
   "To get the account details, I need to:
   1. First get the WhatId from the task: SELECT WhatId, What.Name FROM Task WHERE Id = 'xxx'
   2. Then query the account: SELECT Id, Name, Industry FROM Account WHERE Id = '[WhatId from step 1]'"
   
   **ALTERNATIVE: Use direct relationship queries instead of semi-joins:**
   
   Instead of semi-join:
   ❌ SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity WHERE Amount > 10000)
   
   Better approaches:
   ✅ SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity WHERE Amount > 10000)
   (This works because Opportunity CAN be used in semi-joins)
   
   ✅ For objects that support semi-joins:
      SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)
      SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity)
      SELECT Id FROM Contact WHERE Id IN (SELECT ContactId FROM Case)
   
   **General Rule:**
   - Standard objects like Account, Contact, Opportunity, Case, Lead → CAN use in semi-joins
   - Task, Event, and polymorphic objects → CANNOT use in semi-joins
   - When in doubt, use direct relationship queries: SELECT Account.Name FROM Task WHERE Id = 'xxx'

10. AGGREGATE QUERIES (GROUP BY):
    - COUNT: SELECT COUNT(Id) FROM Opportunity
    - COUNT with field: SELECT COUNT(Id), StageName FROM Opportunity GROUP BY StageName
    - SUM: SELECT AccountId, SUM(Amount) FROM Opportunity GROUP BY AccountId
    - AVG: SELECT StageName, AVG(Amount) FROM Opportunity GROUP BY StageName
    - MIN/MAX: SELECT MIN(Amount), MAX(Amount) FROM Opportunity
    - HAVING: SELECT AccountId, SUM(Amount) total FROM Opportunity GROUP BY AccountId HAVING SUM(Amount) > 100000
    - Multiple aggregates: SELECT StageName, COUNT(Id), SUM(Amount), AVG(Amount) FROM Opportunity GROUP BY StageName
    - ⚠️ All non-aggregate fields must be in GROUP BY

11. NULL HANDLING:
    - Check for values: WHERE Phone != null
    - Check for empty: WHERE AccountId = null
    - "contacts with phone": WHERE Phone != null
    - "contacts without account": WHERE AccountId = null
    - "opportunities without amount": WHERE Amount = null
    - NULL in conditions: WHERE (Email != null OR Phone != null)

12. LIKE PATTERNS & WILDCARDS:
    - Starts with: WHERE Name LIKE 'Acme%'
    - Ends with: WHERE Email LIKE '%@gmail.com'
    - Contains: WHERE Subject LIKE '%urgent%'
    - Single char: WHERE Name LIKE 'A_me' (underscore = single char)
    - Case-insensitive by default
    - Examples:
      * "companies starting with A": WHERE Name LIKE 'A%'
      * "emails from Gmail": WHERE Email LIKE '%@gmail.com'
      * "tasks about urgent": WHERE Subject LIKE '%urgent%'

13. IN CLAUSE WITH LISTS:
    - Text values: WHERE StageName IN ('Closed Won', 'Closed Lost', 'Negotiation')
    - States: WHERE State IN ('CA', 'NY', 'TX')
    - IDs: WHERE Id IN ('001...', '001...', '001...')
    - Subquery: WHERE AccountId IN (SELECT Id FROM Account WHERE Industry = 'Technology')
    - NOT IN: WHERE StageName NOT IN ('Closed Won', 'Closed Lost')

14. BOOLEAN FIELD HANDLING:
    - True: WHERE IsActive = true
    - False: WHERE IsClosed = false
    - "active accounts": WHERE IsActive = true
    - "open tasks": WHERE IsClosed = false
    - "deleted records": WHERE IsDeleted = true
    - ❌ NO quotes: WHERE IsActive = 'true' is WRONG

15. PICKLIST VALUES:
    - Exact match required (case-sensitive in queries)
    - Use quotes: WHERE Status = 'New'
    - Multiple values: WHERE Status IN ('New', 'In Progress', 'Escalated')
    - NOT: WHERE Status != 'Closed'
    - Common picklists:
      * Lead Status: 'New', 'Working', 'Qualified', 'Unqualified'
      * Opportunity Stage: 'Prospecting', 'Qualification', 'Closed Won', 'Closed Lost'
      * Case Status: 'New', 'Working', 'Escalated', 'Closed'
      * Task Status: 'Not Started', 'In Progress', 'Completed'

16. MULTIPLE CONDITIONS (AND/OR):
    - AND: WHERE Status = 'Open' AND Priority = 'High'
    - OR: WHERE Status = 'Open' OR Status = 'In Progress'
    - Combined: WHERE (Status = 'Open' OR Status = 'In Progress') AND Priority = 'High'
    - NOT: WHERE NOT (Status = 'Closed' AND Priority = 'Low')
    - Complex: WHERE Amount > 50000 AND (StageName = 'Negotiation' OR StageName = 'Proposal')

17. FIELD TYPE HANDLING:
    TEXT fields: Use quotes → WHERE Name = 'Acme'
    NUMBER fields: No quotes → WHERE Amount > 50000
    CURRENCY fields: No quotes → WHERE AnnualRevenue >= 1000000
    PERCENT fields: No quotes → WHERE Probability = 75
    DATE fields: YYYY-MM-DD → WHERE BirthDate = 1990-05-15
    DATETIME fields: ISO format → WHERE CreatedDate > 2024-01-01T00:00:00Z
    BOOLEAN fields: true/false → WHERE IsActive = true
    PICKLIST fields: Exact match → WHERE Status = 'New'
    REFERENCE fields: Use ID → WHERE OwnerId = '005...'
    EMAIL fields: Use quotes → WHERE Email = 'test@example.com'
    PHONE fields: Use quotes → WHERE Phone = '555-1234'

${idContext}

=== COMMON ERRORS TO AVOID ===

❌ SELECT * FROM Account
✅ SELECT Id, Name FROM Account

❌ WHERE Amount = '50000' (string for number)
✅ WHERE Amount = 50000

❌ WHERE Name = Bob (missing quotes)
✅ WHERE Name = 'Bob'

❌ WHERE CreatedDate = '2024-01-15' (Date as string with quotes)
✅ WHERE CreatedDate = 2024-01-15

❌ SELECT Id FROM Account WHERE Id IN (SELECT Id FROM Accounts) (wrong object name)
✅ SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)

❌ SELECT Id, Name FROM Account WHERE Id IN (SELECT WhatId FROM Task WHERE Status = 'Open') (Task cannot be in semi-join)
✅ SELECT Id, Subject, What.Id, What.Name FROM Task WHERE Status = 'Open' (use relationship traversal instead)

❌ SELECT * FROM Account WHERE Id IN (SELECT * FROM Contact WHERE AccountId != null) (can't SELECT * in subquery)
✅ SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE AccountId != null)

❌ WHERE IsActive = 'true' (boolean as string)
✅ WHERE IsActive = true

❌ SELECT COUNT(*) FROM Account
✅ SELECT COUNT(Id) FROM Account

❌ WHERE Amount > null (invalid comparison)
✅ WHERE Amount != null

❌ SELECT Name, COUNT(Id) FROM Account (missing GROUP BY)
✅ SELECT Name, COUNT(Id) FROM Account GROUP BY Name

=== COMPREHENSIVE EXAMPLES ===

Basic Queries (Context-Aware):
"give me 5 contacts"
→ Analyze Contact object → SELECT Id, Name, Email, Phone FROM Contact LIMIT 5

"show me accounts"
→ Analyze Account object → SELECT Id, Name, Industry, BillingCity, BillingState FROM Account LIMIT 10

"list opportunities"
→ Analyze Opportunity object → SELECT Id, Name, Amount, StageName, CloseDate FROM Opportunity LIMIT 10

"get all students"
→ Analyze Student__c object schema → SELECT Id, Name, Grade__c, GPA__c FROM Student__c LIMIT 100

"show me products"
→ Analyze Product__c schema → SELECT Id, Name, Price__c, Stock__c FROM Product__c LIMIT 10

Tasks and Polymorphic (with Conversation Context):
"task 00TGA00003fTAL32AO"
→ SELECT Id, Subject, Status, WhoId, Who.Name, WhatId, What.Name FROM Task WHERE Id = '00TGA00003fTAL32AO'

"client for task 00TGA00003fTAL32AO"
→ SELECT Id, WhoId, Who.Name, Who.Type, WhatId, What.Name, What.Type FROM Task WHERE Id = '00TGA00003fTAL32AO'

"account for task 00TGA00003fTAL32AO"
→ SELECT Id, Subject, WhatId, What.Name, What.Type, What.Industry, What.BillingCity FROM Task WHERE Id = '00TGA00003fTAL32AO'
   (Use What.* to get account details directly - don't use semi-join)

"my open tasks"
→ SELECT Id, Subject, Status, ActivityDate, WhoId, Who.Name, WhatId, What.Name FROM Task WHERE OwnerId = '${userId}' AND IsClosed = false

"tasks for accounts"
→ SELECT Id, Subject, WhatId, What.Name FROM Task WHERE WhatId != null AND WhatId LIKE '001%' LIMIT 10

Follow-up after "give me my tasks":
User: "show me the account for the first task"
→ If task ID is known: SELECT Id, Subject, WhatId, What.Id, What.Name, What.Industry FROM Task WHERE Id = '[first_task_id]'
→ OR explain: "The task is related to account '[Account Name]' (ID: [WhatId]). Would you like more account details?"
→ Then if needed: SELECT Id, Name, Industry, BillingCity FROM Account WHERE Id = '[extracted_what_id]'

User Context:
"my opportunities"
→ SELECT Id, Name, Amount, StageName, CloseDate FROM Opportunity WHERE OwnerId = '${userId}'

"my closed won deals"
→ SELECT Id, Name, Amount, CloseDate FROM Opportunity WHERE OwnerId = '${userId}' AND StageName = 'Closed Won'

Sorting and Limits (Dynamic):
"top 5 opportunities"
→ Analyze schema → Amount field exists → SELECT Id, Name, Amount, StageName FROM Opportunity WHERE Amount != null ORDER BY Amount DESC LIMIT 5

"top 10 students"
→ Analyze schema → GPA__c field exists → SELECT Id, Name, GPA__c FROM Student__c ORDER BY GPA__c DESC LIMIT 10

"best performing employees"
→ Analyze schema → Performance_Rating__c exists → SELECT Id, Name, Performance_Rating__c FROM Employee__c ORDER BY Performance_Rating__c DESC LIMIT 10

"highest priority cases"
→ Analyze Priority field (picklist) → SELECT Id, CaseNumber, Priority FROM Case WHERE Priority = 'High' ORDER BY CreatedDate DESC

"latest 10 leads"
→ User said "latest" → SELECT Id, Name, Email, CreatedDate FROM Lead ORDER BY CreatedDate DESC LIMIT 10

"oldest open tasks"
→ User said "oldest" + "open" → SELECT Id, Subject, CreatedDate FROM Task WHERE IsClosed = false ORDER BY CreatedDate ASC LIMIT 10

Date Queries:
"opportunities closed this month"
→ SELECT Id, Name, Amount, CloseDate FROM Opportunity WHERE CloseDate = THIS_MONTH

"tasks created in last 7 days"
→ SELECT Id, Subject, CreatedDate FROM Task WHERE CreatedDate > LAST_N_DAYS:7

"leads updated yesterday"
→ SELECT Id, Name, Email, LastModifiedDate FROM Lead WHERE LastModifiedDate = YESTERDAY

"accounts created this year"
→ SELECT Id, Name, CreatedDate FROM Account WHERE CreatedDate = THIS_YEAR

"opportunities closing next quarter"
→ SELECT Id, Name, Amount, CloseDate FROM Opportunity WHERE CloseDate = NEXT_QUARTER

Relationships:
"accounts with their owner names"
→ SELECT Id, Name, Owner.Name, Owner.Email FROM Account LIMIT 10

"opportunities with account details"
→ SELECT Id, Name, Amount, Account.Name, Account.Industry FROM Opportunity LIMIT 10

"accounts with contacts"
→ SELECT Id, Name, (SELECT Id, Name, Email FROM Contacts) FROM Account LIMIT 5

"contacts and their account info"
→ SELECT Id, Name, Email, Account.Name, Account.BillingCity FROM Contact WHERE AccountId != null LIMIT 10

Object Switching (Respecting Semi-Join Limitations):
"account details for these contacts"
→ SELECT Id, Name, BillingCity, BillingState FROM Account WHERE Id IN (SELECT AccountId FROM Contact LIMIT 5)
   (Contact CAN be used in semi-join)

"accounts with opportunities"
→ SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity)
   (Opportunity CAN be used in semi-join)

"contacts with open cases"
→ SELECT Id, Name, Email FROM Contact WHERE Id IN (SELECT ContactId FROM Case WHERE IsClosed = false)
   (Case CAN be used in semi-join)

"accounts related to my tasks" 
→ ❌ CANNOT USE: SELECT Id, Name FROM Account WHERE Id IN (SELECT WhatId FROM Task WHERE OwnerId = 'xxx')
→ ✅ INSTEAD USE: SELECT Id, Subject, WhatId, What.Name, What.Industry FROM Task WHERE OwnerId = 'xxx' AND WhatId LIKE '001%'
   (Query Task directly with relationship fields)

"show account for task [ID]"
→ SELECT Id, Subject, What.Id, What.Name, What.Industry, What.BillingCity FROM Task WHERE Id = '[task_id]'
   (Get account details via What.* relationship, not semi-join)

Aggregations (Dynamic Grouping):
"count opportunities by stage"
→ Analyze: StageName is picklist → SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName

"total amount by account"
→ Analyze: AccountId is lookup, Amount is currency → SELECT AccountId, Account.Name, SUM(Amount) FROM Opportunity GROUP BY AccountId, Account.Name

"average student performance by grade"
→ Analyze schema: Grade__c is picklist, Score__c is number → SELECT Grade__c, AVG(Score__c) FROM Student__c GROUP BY Grade__c

"count products by category"
→ Analyze schema: Category__c exists → SELECT Category__c, COUNT(Id) FROM Product__c GROUP BY Category__c

"sum revenue by region"
→ Analyze schema: Region__c and Revenue__c exist → SELECT Region__c, SUM(Revenue__c) FROM Sales__c GROUP BY Region__c

Complex Queries:
"high value open opportunities"
→ SELECT Id, Name, Amount, StageName FROM Opportunity WHERE Amount > 100000 AND StageName NOT IN ('Closed Won', 'Closed Lost') ORDER BY Amount DESC

"contacts in California or New York with phone numbers"
→ SELECT Id, Name, Email, Phone, MailingState FROM Contact WHERE (MailingState = 'CA' OR MailingState = 'NY') AND Phone != null

"urgent open cases"
→ SELECT Id, CaseNumber, Subject, Priority, Status FROM Case WHERE Priority = 'High' AND IsClosed = false ORDER BY CreatedDate DESC

"technology accounts with revenue over 1M"
→ SELECT Id, Name, Industry, AnnualRevenue FROM Account WHERE Industry = 'Technology' AND AnnualRevenue > 1000000

NULL Handling:
"contacts with phone numbers"
→ SELECT Id, Name, Phone FROM Contact WHERE Phone != null

"opportunities without amount"
→ SELECT Id, Name, StageName FROM Opportunity WHERE Amount = null

"contacts without accounts"
→ SELECT Id, Name, Email FROM Contact WHERE AccountId = null

Address Queries (Dynamic Type Selection):
"accounts with addresses in NY"
→ Analyze Account → Has Billing → SELECT Id, Name, BillingStreet, BillingCity, BillingState, BillingPostalCode FROM Account WHERE BillingState = 'NY'

"contacts in San Francisco"
→ Analyze Contact → Has Mailing → SELECT Id, Name, MailingStreet, MailingCity, MailingState FROM Contact WHERE MailingCity = 'San Francisco'

"show me customer addresses"
→ Analyze Customer__c schema → Check for available address fields → Use most appropriate type

"get location of stores"
→ Analyze Store__c schema → May have custom Location__c or standard address fields → SELECT Id, Name, [appropriate address fields] FROM Store__c

Boolean Queries:
"active accounts"
→ SELECT Id, Name, IsActive FROM Account WHERE IsActive = true

"deleted leads"
→ SELECT Id, Name, IsDeleted FROM Lead WHERE IsDeleted = true

"completed tasks"
→ SELECT Id, Subject, Status FROM Task WHERE IsClosed = true

=== SCHEMA ANALYSIS INSTRUCTIONS ===

**Before generating any SOQL query, you MUST:**

1. **Read the provided schema carefully** - it contains:
   - Object names
   - Field names and types (Text, Number, Currency, Date, Picklist, Lookup, etc.)
   - Relationship information
   - Custom field patterns

2. **Identify the target object** from the user's question:
   - Direct mention: "show me contacts" → Contact object
   - Implied: "my tasks" → Task object
   - Custom objects: "students", "products" → Student__c, Product__c

3. **Analyze available fields on that object:**
   - What identifier field exists? (Name, CaseNumber, Subject)
   - What date fields exist? (CreatedDate, CloseDate, DueDate__c)
   - What numeric/currency fields exist? (Amount, Score__c, Quantity__c)
   - What status/state fields exist? (Status, StageName, IsActive)
   - What relationship fields exist? (AccountId, OwnerId, Parent__c)

4. **Infer user intent based on keywords:**
   - "top/best/highest" → Find numeric field to sort DESC
   - "latest/recent/newest" → Sort by CreatedDate DESC
   - "oldest" → Sort by CreatedDate ASC
   - "open/active" → Check for IsClosed=false or Status field
   - "my" → Use OwnerId = current user
   - "with/related to" → Include relationship fields

5. **Make intelligent defaults when information is partial:**
   - If user says "show contacts" → Include Id, Name, Email, Phone (common useful fields)
   - If user says "top 5 X" and multiple numeric fields exist → Choose most relevant (Amount over Id)
   - If user says "address" → Choose appropriate address type for that object

6. **Ask for clarification only when truly ambiguous:**
   - Multiple equally valid numeric fields for "top N"
   - Object cannot be determined from question
   - Required information completely missing

=== SCHEMA ===
${schemaText}
${objectFieldsList}
${relationshipReference}
${conversationContext}

=== QUESTION ===
${question}

${isFieldsQuery ? `LIST ALL FIELDS from ${detectedObject}` : ''}

=== RESPONSE FORMAT ===
Analyze the question and respond in ONE of these formats:

1. If the query is clear and valid:
   Return ONLY the SOQL query. No markdown. No explanation. No code blocks.

2. If critical information is missing:
   CLARIFICATION_NEEDED: [Ask a specific question about what's missing]
   Examples:
   - CLARIFICATION_NEEDED: Which object do you want to query? Accounts, Contacts, or Opportunities?
   - CLARIFICATION_NEEDED: Do you want open tasks or all tasks?
   - CLARIFICATION_NEEDED: Which date field should I filter on - CreatedDate or CloseDate?

3. If the request is impossible in SOQL:
   NOT_POSSIBLE: [Brief explanation]
   Examples:
   - NOT_POSSIBLE: SOQL doesn't support SELECT * - please specify which fields you need
   - NOT_POSSIBLE: Cannot query deleted records without using ALL ROWS in the query
   - NOT_POSSIBLE: RANDOM() ordering is not supported in Salesforce SOQL

Generate the most accurate, efficient, and executable SOQL query based on the question.`;
}

/**
 * Summarize text prompt - used for summarizing content
 * @returns {string} System prompt for summarization
 */
export function getSummarizeSystemPrompt() {
  return `You are a JSON-only response bot. 
Return ONLY valid JSON. No preamble. No markdown. No explanations.

Analyze the provided text and extract:
1. A concise summary (2-3 sentences)
2. Overall sentiment (Positive, Negative, Neutral, or Mixed)
3. Key topics or themes (if applicable)

Required Format: 
{
  "summary": "your concise summary here", 
  "sentiment": "Neutral",
  "topics": ["topic1", "topic2"]
}

Rules:
- Keep summary under 200 characters if possible
- Sentiment must be one of: Positive, Negative, Neutral, Mixed
- Topics are optional but helpful for context`;
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
  return `You are performing a calculation on previously retrieved Salesforce data.

=== PREVIOUS CONTEXT ===
Previous query: "${lastQuestion}"
Total records returned: ${recordCount}

=== SAMPLE DATA (first 5 records) ===
${JSON.stringify(sampleData.slice(0, 5), null, 2)}

=== CURRENT QUESTION ===
"${currentQuestion}"

=== YOUR TASK ===
1. Identify which numeric field to calculate on
2. Perform the requested calculation (sum, average, count, min, max, etc.)
3. Consider all ${recordCount} records, not just the sample
4. Format the result appropriately (currency, percentage, count, etc.)

=== CALCULATION TYPES ===
- Sum: "total", "sum of", "add up"
- Average: "average", "mean", "avg"
- Count: "how many", "count", "number of"
- Min/Max: "highest", "lowest", "minimum", "maximum"
- Percentage: "what percent", "percentage"
- Comparison: "more than", "less than", "between"

=== OUTPUT FORMAT ===
RESULT: [calculated answer with appropriate formatting]
EXPLANATION: [brief 1-2 sentence explanation of what was calculated]
FIELD_USED: [name of the field used in calculation]

Examples:
RESULT: $2,450,000
EXPLANATION: The total amount across all 15 opportunities is $2.45M
FIELD_USED: Amount

RESULT: 42
EXPLANATION: There are 42 records with a status of "Open"
FIELD_USED: Status

RESULT: $163,333.33
EXPLANATION: The average opportunity amount is $163,333.33 based on 15 records
FIELD_USED: Amount

Be precise and concise. Format currency with $ and commas. Format percentages with %.`;
}

/**
 * Explanation prompt - used for explaining query results
 * @param {string} question - Original user question
 * @param {string} soql - Generated SOQL query
 * @param {array} results - Sample results from query
 * @returns {string} Prompt for explaining results
 */
export function getExplanationPrompt(question, soql, results) {
  const resultCount = results.length;
  
  return `You are explaining Salesforce query results to a user.

=== USER QUESTION ===
"${question}"

=== SOQL QUERY EXECUTED ===
${soql}

=== RESULTS (${resultCount} records returned) ===
${JSON.stringify(results.slice(0, 3), null, 2)}
${resultCount > 3 ? `\n... and ${resultCount - 3} more records` : ''}

=== YOUR TASK ===
Provide a clear, concise explanation of what these results show. 

Guidelines:
1. Start with a direct answer to the user's question
2. Mention key insights from the data
3. Format numbers properly:
   - Currency: $1,234.56
   - Dates: January 15, 2024 (human-readable)
   - Large numbers: 1,234 or 1.2M
4. Keep it conversational and helpful
5. If results are empty, explain why and suggest alternatives
6. Don't repeat the entire query unless asked

Length: 2-4 sentences maximum

Example outputs:
- "I found 5 contacts in California. They include John Smith from San Francisco and Jane Doe from Los Angeles."
- "Your top opportunity is 'Acme Corp Deal' worth $250,000, currently in the Negotiation stage."
- "No tasks found for today. You might want to check upcoming tasks or create new ones."
- "There are 12 open cases, with 5 marked as high priority. The oldest case was created 3 days ago."`;
}

/**
 * Chat system prompt - used for general Salesforce assistant conversations
 * @param {string} schemaText - Optional formatted schema information
 * @returns {string} System prompt for chat
 */
export function getChatSystemPrompt(schemaText) {
  return `You are a helpful Salesforce assistant with deep knowledge of the Salesforce platform.

=== YOUR CAPABILITIES ===
1. Answer questions about Salesforce concepts, features, and best practices
2. Help users understand SOQL queries and data modeling
3. Provide guidance on Salesforce administration and configuration
4. Explain Salesforce terminology and functionality
5. Suggest using /smart-query for data retrieval questions

=== COMMUNICATION STYLE ===
- Be concise and helpful
- Use clear, simple language
- Provide examples when helpful
- Break down complex topics into digestible parts
- Be proactive in suggesting better approaches

=== WHEN TO SUGGEST /smart-query ===
If the user asks questions like:
- "Show me my opportunities"
- "How many contacts do I have?"
- "What are my open tasks?"
- "Find accounts in California"
→ Respond: "I can help with that! Use /smart-query followed by your question to retrieve data. For example: '/smart-query show me my opportunities'"

=== TOPICS YOU CAN HELP WITH ===
- SOQL syntax and best practices
- Salesforce objects and relationships
- Standard and custom fields
- Workflow rules, Process Builder, Flows
- Apex basics and triggers
- Lightning components
- Reports and dashboards
- User management and security
- Data import/export
- Integration concepts

=== AVAILABLE SCHEMA ===
${schemaText ? `You have access to the following Salesforce objects:\n${schemaText}\n\nUse this context to provide more specific and relevant answers.` : 'No schema information currently loaded. You can still help with general Salesforce questions.'}

Remember: Be helpful, accurate, and concise. Guide users to the right tools and approaches for their needs.`;
}

/**
 * Error analysis prompt - used for analyzing failed SOQL queries
 * @param {string} query - The SOQL query that failed
 * @param {string} error - The error message received
 * @param {string} question - Original user question
 * @returns {string} Prompt for analyzing and fixing query errors
 */
export function getErrorAnalysisPrompt(query, error, question) {
  return `A SOQL query has failed. Analyze the error and suggest a fix.

=== ORIGINAL QUESTION ===
"${question}"

=== FAILED QUERY ===
${query}

=== ERROR MESSAGE ===
${error}

=== YOUR TASK ===
1. Identify the root cause of the error
2. Provide a corrected SOQL query
3. Explain what was wrong and how you fixed it

=== COMMON ERROR PATTERNS ===
- "No such column" → Field doesn't exist or is misspelled
- "unexpected token" → Syntax error in query
- "MALFORMED_QUERY" → Invalid SOQL syntax
- "Invalid field" → Field not available on this object
- "Aggregate functions not allowed" → Missing GROUP BY clause
- "Field must be grouped or aggregated" → Non-aggregated field in aggregate query

=== OUTPUT FORMAT ===
CORRECTED_QUERY: [fixed SOQL query]
EXPLANATION: [what was wrong and how it was fixed]
ROOT_CAUSE: [underlying issue]

Be specific and actionable in your response.`;
}

/**
 * Query optimization prompt - used for suggesting query improvements
 * @param {string} query - The SOQL query to optimize
 * @param {number} executionTime - Query execution time in ms
 * @param {number} resultCount - Number of records returned
 * @returns {string} Prompt for query optimization suggestions
 */
export function getQueryOptimizationPrompt(query, executionTime, resultCount) {
  return `Analyze this SOQL query for potential optimizations.

=== QUERY ===
${query}

=== PERFORMANCE METRICS ===
Execution Time: ${executionTime}ms
Records Returned: ${resultCount}

=== OPTIMIZATION CHECKLIST ===

1. **Selective Filters**
   - Are WHERE clauses using indexed fields? (Id, Name, OwnerId, RecordTypeId, CreatedDate, SystemModstamp)
   - Can filters be more restrictive to reduce result set?
   - Are date filters using efficient ranges?

2. **Field Selection**
   - Are only necessary fields being selected?
   - Can formula fields or roll-up summaries be removed?
   - Are there unnecessary relationship traversals?

3. **Query Structure**
   - Is LIMIT appropriate for the use case?
   - Can parent-to-child subqueries be avoided?
   - Are there unnecessary JOINs via relationship fields?

4. **Indexing Considerations**
   - Standard indexed fields: Id, Name, OwnerId, CreatedDate, SystemModstamp, RecordTypeId, MasterRecordId
   - Custom fields can be indexed if they're marked as External ID or Unique
   - Lookup and Master-Detail fields are automatically indexed

5. **Common Issues**
   - NOT operators (WHERE Field != value) prevent index use
   - LIKE with leading wildcard (LIKE '%text') prevents index use
   - OR conditions across multiple fields prevent index use
   - Functions like TOLOWER() prevent index use

=== OUTPUT FORMAT ===
OPTIMIZATION_SCORE: [1-10, where 10 is perfectly optimized]
SUGGESTIONS: [bulleted list of specific improvements]
OPTIMIZED_QUERY: [rewritten query if improvements are possible, otherwise "No changes needed"]
EXPECTED_IMPROVEMENT: [estimated performance gain: None, Minor, Moderate, Significant]

Examples:

OPTIMIZATION_SCORE: 6
SUGGESTIONS:
- Add a more selective filter on OwnerId or CreatedDate to reduce result set
- Remove non-essential formula fields from SELECT clause
- Consider adding LIMIT if not all records are needed
OPTIMIZED_QUERY: SELECT Id, Name, Amount WHERE CreatedDate = THIS_YEAR AND OwnerId = '005xxx' LIMIT 100
EXPECTED_IMPROVEMENT: Moderate

OPTIMIZATION_SCORE: 9
SUGGESTIONS:
- Query is well-optimized, uses indexed fields, has appropriate LIMIT
OPTIMIZED_QUERY: No changes needed
EXPECTED_IMPROVEMENT: None`;
}

/**
 * Field suggestion prompt - used when user asks about available fields
 * @param {string} objectName - Salesforce object name
 * @param {array} fields - Array of field metadata
 * @param {string} userIntent - What the user is trying to do
 * @returns {string} Prompt for suggesting relevant fields
 */
export function getFieldSuggestionPrompt(objectName, fields, userIntent) {
  return `Suggest the most relevant fields for the user's intent.

=== OBJECT ===
${objectName}

=== USER INTENT ===
"${userIntent}"

=== AVAILABLE FIELDS ===
${JSON.stringify(fields, null, 2)}

=== YOUR TASK ===
1. Identify fields that are most relevant to the user's intent
2. Categorize them as Essential, Useful, or Optional
3. Explain why each field is relevant
4. Suggest a sample SOQL query using these fields

=== FIELD CATEGORIES ===
- **Essential**: Must include for the query to be meaningful
- **Useful**: Commonly needed contextual information
- **Optional**: Nice to have but not critical

=== OUTPUT FORMAT ===
ESSENTIAL_FIELDS: [field1, field2, field3]
USEFUL_FIELDS: [field4, field5]
OPTIONAL_FIELDS: [field6, field7]

EXPLANATION:
- field1: [why it's essential]
- field2: [why it's essential]
...

SAMPLE_QUERY: [complete SOQL query using suggested fields]

Example:
ESSENTIAL_FIELDS: Id, Name, Email
USEFUL_FIELDS: Phone, AccountId, Account.Name
OPTIONAL_FIELDS: Title, Department, MailingCity

EXPLANATION:
- Id: Unique identifier for the contact
- Name: Primary way to identify the contact
- Email: Core communication method
- Phone: Secondary contact method
- Account.Name: Shows which company the contact belongs to

SAMPLE_QUERY: SELECT Id, Name, Email, Phone, Account.Name FROM Contact WHERE Email != null LIMIT 10`;
}

/**
 * Multi-step query prompt - used for complex requests requiring multiple queries
 * @param {string} question - User's complex question
 * @param {string} schemaText - Available schema
 * @param {array} previousResults - Results from previous steps if any
 * @returns {string} Prompt for breaking down complex requests
 */
export function getMultiStepQueryPrompt(question, schemaText, previousResults = []) {
  return `Break down this complex request into multiple SOQL queries.

=== USER REQUEST ===
"${question}"

=== AVAILABLE SCHEMA ===
${schemaText}

${previousResults.length > 0 ? `=== PREVIOUS STEP RESULTS ===
${JSON.stringify(previousResults, null, 2)}
` : ''}

=== YOUR TASK ===
Analyze if this request requires multiple queries and plan the execution steps.

=== MULTI-QUERY INDICATORS ===
- "and then" phrases
- Multiple object references
- Calculations on query results
- Filtering based on aggregated data
- Cross-object comparisons

=== OUTPUT FORMAT ===
REQUIRES_MULTI_STEP: [YES or NO]

If YES:
STEP_COUNT: [number]
EXECUTION_PLAN:
Step 1: [description]
Query: [SOQL]
Purpose: [why this step is needed]

Step 2: [description]
Query: [SOQL using results from Step 1]
Purpose: [why this step is needed]

...

FINAL_OUTPUT: [description of what the final result will look like]

If NO:
SINGLE_QUERY: [SOQL query]
EXPLANATION: [why a single query is sufficient]

Examples:

Request: "Show me accounts in California and then their related opportunities"
REQUIRES_MULTI_STEP: NO
SINGLE_QUERY: SELECT Id, Name, BillingState, (SELECT Id, Name, Amount FROM Opportunities) FROM Account WHERE BillingState = 'CA'
EXPLANATION: Can be done with a single parent-to-child subquery

Request: "Find my top 5 opportunities and calculate their average amount"
REQUIRES_MULTI_STEP: YES
STEP_COUNT: 2
EXECUTION_PLAN:
Step 1: Retrieve top 5 opportunities
Query: SELECT Id, Name, Amount FROM Opportunity WHERE OwnerId = 'xxx' ORDER BY Amount DESC LIMIT 5
Purpose: Get the dataset for calculation

Step 2: Calculate average
Query: Not a SOQL query - perform calculation on results from Step 1
Purpose: Compute average of the Amount field

FINAL_OUTPUT: Average amount of top 5 opportunities with the list of opportunities`;
}

/**
 * Validation prompt - validates generated SOQL before execution
 * @param {string} query - SOQL query to validate
 * @param {string} schemaText - Available schema
 * @returns {string} Prompt for query validation
 */
export function getValidationPrompt(query, schemaText) {
  return `Validate this SOQL query for common errors before execution.

=== QUERY TO VALIDATE ===
${query}

=== AVAILABLE SCHEMA ===
${schemaText}

=== VALIDATION CHECKLIST ===

1. **Syntax Validation**
   ✓ No SELECT *
   ✓ Proper FROM clause
   ✓ Valid WHERE conditions
   ✓ Correct field names
   ✓ Proper quote usage
   ✓ Valid operators

2. **Field Validation**
   ✓ All fields exist on the object
   ✓ Relationship fields use correct notation (Account.Name not Account__r.Name for standard)
   ✓ No compound fields (Address, Location)
   ✓ Correct field types in comparisons

3. **Logic Validation**
   ✓ Date formats are correct
   ✓ Numbers don't have quotes
   ✓ Booleans use true/false not 'true'/'false'
   ✓ Aggregate queries have proper GROUP BY
   ✓ HAVING clause only with aggregates

4. **Performance Validation**
   ✓ Has reasonable LIMIT
   ✓ Uses indexed fields in WHERE when possible
   ✓ Efficient relationship traversals

=== OUTPUT FORMAT ===
IS_VALID: [YES or NO]

If NO:
ERRORS:
- [Error 1 description]
- [Error 2 description]
CORRECTED_QUERY: [fixed query]

If YES:
VALIDATION_NOTES:
- [Any warnings or suggestions]
READY_TO_EXECUTE: true

Example:

IS_VALID: NO
ERRORS:
- Field "Address" doesn't exist - should use BillingStreet, BillingCity, etc.
- Amount comparison using string '50000' should be number 50000
- Missing LIMIT clause for potentially large result set
CORRECTED_QUERY: SELECT Id, Name, BillingStreet, BillingCity FROM Account WHERE Amount > 50000 LIMIT 100`;
}

/**
 * Natural language to SOQL examples prompt - provides context for learning
 * @returns {string} Comprehensive examples for training/reference
 */
export function getSOQLExamplesPrompt() {
  return `=== COMPREHENSIVE SOQL PATTERN REFERENCE ===

This reference shows common natural language patterns and their SOQL equivalents.

1. BASIC RETRIEVAL
"get contacts" → SELECT Id, Name, Email FROM Contact LIMIT 10
"show me accounts" → SELECT Id, Name FROM Account LIMIT 10
"list opportunities" → SELECT Id, Name, Amount FROM Opportunity LIMIT 10

2. FILTERING BY FIELD
"contacts in California" → SELECT Id, Name FROM Contact WHERE MailingState = 'CA'
"accounts with revenue over 1M" → SELECT Id, Name, AnnualRevenue FROM Account WHERE AnnualRevenue > 1000000
"open opportunities" → SELECT Id, Name FROM Opportunity WHERE IsClosed = false

3. CURRENT USER
"my tasks" → SELECT Id, Subject FROM Task WHERE OwnerId = '${current_user_id}'
"my accounts" → SELECT Id, Name FROM Account WHERE OwnerId = '${current_user_id}'
"opportunities I own" → SELECT Id, Name FROM Opportunity WHERE OwnerId = '${current_user_id}'

4. DATE FILTERS
"tasks due today" → SELECT Id, Subject FROM Task WHERE ActivityDate = TODAY
"opportunities closing this month" → SELECT Id, Name FROM Opportunity WHERE CloseDate = THIS_MONTH
"cases created in last 7 days" → SELECT Id, CaseNumber FROM Case WHERE CreatedDate > LAST_N_DAYS:7
"accounts created this year" → SELECT Id, Name FROM Account WHERE CreatedDate = THIS_YEAR

5. SORTING AND LIMITING
"top 5 opportunities" → SELECT Id, Name, Amount FROM Opportunity ORDER BY Amount DESC LIMIT 5
"latest 10 leads" → SELECT Id, Name FROM Lead ORDER BY CreatedDate DESC LIMIT 10
"oldest open cases" → SELECT Id, CaseNumber FROM Case WHERE IsClosed = false ORDER BY CreatedDate ASC

6. NULL CHECKS
"contacts with phone numbers" → SELECT Id, Name, Phone FROM Contact WHERE Phone != null
"opportunities without amounts" → SELECT Id, Name FROM Opportunity WHERE Amount = null
"contacts without accounts" → SELECT Id, Name FROM Contact WHERE AccountId = null

7. TEXT SEARCH
"accounts starting with Acme" → SELECT Id, Name FROM Account WHERE Name LIKE 'Acme%'
"emails from Gmail" → SELECT Id, Email FROM Contact WHERE Email LIKE '%@gmail.com'
"cases about refund" → SELECT Id, Subject FROM Case WHERE Subject LIKE '%refund%'

8. MULTIPLE CONDITIONS
"high priority open cases" → SELECT Id, Subject FROM Case WHERE Priority = 'High' AND IsClosed = false
"contacts in CA or NY" → SELECT Id, Name FROM Contact WHERE MailingState IN ('CA', 'NY')
"large opportunities not closed" → SELECT Id, Name, Amount FROM Opportunity WHERE Amount > 100000 AND IsClosed = false

9. RELATIONSHIPS (CHILD TO PARENT)
"opportunities with account names" → SELECT Id, Name, Account.Name FROM Opportunity
"contacts with account info" → SELECT Id, Name, Account.Name, Account.Industry FROM Contact
"tasks with owner details" → SELECT Id, Subject, Owner.Name, Owner.Email FROM Task

10. RELATIONSHIPS (PARENT TO CHILD)
"accounts with their contacts" → SELECT Id, Name, (SELECT Id, Name FROM Contacts) FROM Account
"accounts with opportunities" → SELECT Id, Name, (SELECT Id, Name, Amount FROM Opportunities) FROM Account

11. AGGREGATIONS
"count opportunities by stage" → SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName
"total amount by account" → SELECT AccountId, SUM(Amount) FROM Opportunity GROUP BY AccountId
"average opportunity amount" → SELECT AVG(Amount) FROM Opportunity
"highest opportunity" → SELECT MAX(Amount) FROM Opportunity

12. IN CLAUSE WITH SUBQUERY
"accounts with opportunities" → SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity)
"contacts with open tasks" → SELECT Id, Name FROM Contact WHERE Id IN (SELECT WhoId FROM Task WHERE IsClosed = false)

13. COMPLEX FILTERS
"tech companies in California with revenue over 5M" → 
SELECT Id, Name FROM Account WHERE Industry = 'Technology' AND BillingState = 'CA' AND AnnualRevenue > 5000000

"high value deals closing soon" →
SELECT Id, Name, Amount, CloseDate FROM Opportunity WHERE Amount > 100000 AND CloseDate = NEXT_N_DAYS:30 AND IsClosed = false

14. POLYMORPHIC (TASK/EVENT)
"tasks related to accounts" → SELECT Id, Subject, WhatId, What.Name FROM Task WHERE WhatId LIKE '001%'
"tasks related to contacts" → SELECT Id, Subject, WhoId, Who.Name FROM Task WHERE WhoId LIKE '003%'
"client for this task" → SELECT Id, WhoId, Who.Name, WhatId, What.Name FROM Task WHERE Id = 'xxx'

15. RECORD TYPES
"partner accounts" → SELECT Id, Name, RecordType.Name FROM Account WHERE RecordType.Name = 'Partner'
"enterprise opportunities" → SELECT Id, Name FROM Opportunity WHERE RecordType.DeveloperName = 'Enterprise'

These patterns cover 95% of common SOQL use cases.`;
}

/**
 * Context-aware prompt builder - combines multiple contexts for better results
 * @param {object} options - Configuration object
 * @returns {string} Combined context-aware prompt
 */
export function buildContextAwarePrompt(options) {
  const {
    question,
    schema,
    conversationHistory = [],
    userPreferences = {},
    recentQueries = [],
    errorHistory = []
  } = options;

  let contextPrompt = `You are generating a SOQL query with full context awareness.

=== CURRENT QUESTION ===
"${question}"

`;

  // Add conversation history if available
  if (conversationHistory.length > 0) {
    contextPrompt += `=== CONVERSATION HISTORY ===
Recent exchanges:
${conversationHistory.slice(-5).map((item, i) => 
  `${i + 1}. User: "${item.question}"\n   Response: ${item.response.substring(0, 100)}...`
).join('\n')}

`;
  }

  // Add recent successful queries
  if (recentQueries.length > 0) {
    contextPrompt += `=== RECENT SUCCESSFUL QUERIES ===
${recentQueries.slice(-3).map((q, i) => 
  `${i + 1}. "${q.question}" → ${q.soql}`
).join('\n')}

`;
  }

  // Add error patterns to avoid
  if (errorHistory.length > 0) {
    contextPrompt += `=== ERRORS TO AVOID ===
Recent errors encountered:
${errorHistory.slice(-3).map((e, i) => 
  `${i + 1}. Query: ${e.query}\n   Error: ${e.error}\n   Fix: ${e.resolution}`
).join('\n\n')}

`;
  }

  // Add user preferences
  if (Object.keys(userPreferences).length > 0) {
    contextPrompt += `=== USER PREFERENCES ===
${JSON.stringify(userPreferences, null, 2)}

`;
  }

  contextPrompt += `Generate the most accurate SOQL query considering all context above.`;

  return contextPrompt;
}
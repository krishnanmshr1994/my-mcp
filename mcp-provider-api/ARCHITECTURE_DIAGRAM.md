# Self-Healing SOQL System - Architecture Diagram

## System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER REQUEST                                     │
│                   POST /smart-query                                      │
│            { question, objectHint, conversationHistory }                 │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  Check if      │
                    │ aggregation on │
                    │   previous?    │
                    └────────┬───────┘
                             │
                  ┌──────────┴──────────┐
                  │                     │
                  ▼ YES                 ▼ NO
         ┌──────────────────┐   ┌─────────────────────────────┐
         │  Calculate       │   │ generateAndExecuteSOQL      │
         │  aggregation     │   │ WithHealing()               │
         │  using LLM       │   └──────────┬──────────────────┘
         └────────┬─────────┘              │
                  │                        ▼
                  │            ┌────────────────────┐
                  │            │  ATTEMPT 1:        │
                  │            │  Fresh Generation  │
                  │            └────────┬───────────┘
                  │                     │
                  │           ┌─────────┴──────────┐
                  │           │                    │
                  │           ▼ SUCCESS            ▼ ERROR
                  │      ┌──────────┐        ┌──────────────┐
                  │      │  Return  │        │ Capture      │
                  │      │  results │        │ Error        │
                  │      └──────────┘        └────┬─────────┘
                  │                               │
                  │                    ┌──────────▼───────────┐
                  │                    │  Check if FATAL      │
                  │                    │  (auth, session)?    │
                  │                    └────────┬─────────────┘
                  │                             │
                  │                    ┌────────┴─────────┐
                  │                    │                  │
                  │                    ▼ YES              ▼ NO
                  │            ┌──────────────┐  ┌──────────────────┐
                  │            │ Return Fatal │  │  ATTEMPT 2/3:    │
                  │            │ Error (HTTP  │  │  Error Analysis  │
                  │            │ 500)         │  │  & Correction    │
                  │            └──────────────┘  └────────┬─────────┘
                  │                                       │
                  │                           ┌───────────┴───────────┐
                  │                           │                       │
                  │                           ▼ SUCCESS               ▼ ERROR
                  │                      ┌──────────┐           ┌───────────┐
                  │                      │ Return   │           │ Check max │
                  │                      │ healed   │           │ retries?  │
                  │                      │ results  │           └─────┬─────┘
                  │                      └──────────┘                 │
                  │                                          ┌────────┴────────┐
                  │                                          │                 │
                  │                                   YES ◄──┘                 ▼ NO
                  │                                   (3+)           ┌──────────────┐
                  │                                   │              │ Retry again  │
                  │                                   │              │ (loop back)  │
                  │                   ┌───────────────┴──┐           └──────────────┘
                  │                   ▼                  │
                  │        ┌────────────────────┐        │
                  │        │ Return maxRetries  │        │
                  │        │ Reached + all      │        │
                  │        │ errors             │        │
                  │        └────────────────────┘        │
                  │                                       │
                  └───────────────────┬───────────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────┐
                        │  Generate Explanation   │
                        │  using LLM              │
                        └────────────┬────────────┘
                                     │
                                     ▼
                    ┌────────────────────────────┐
                    │  Return Final Response      │
                    │  with all metadata         │
                    └────────────────────────────┘
```

## Detailed Flow: First Attempt

```
ATTEMPT 1: generateSOQLWithContext()
│
├─ Parse question for object type
├─ Build enriched schema with relationships
├─ Analyze conversation context (if available)
├─ Build comprehensive SOQL prompt
├─ Call NVIDIA LLM with prompt
├─ Generate SOQL query
│
├─ Execute SOQL query
│
├─ Success? ─────────────────┐
│  │                          │
│  └─ Return results         │
│                             │
└─ Error? ───────────────────┘
    │
    └─ Capture error details
       (error message, error code)
       
       Proceed to ATTEMPT 2
```

## Detailed Flow: Retry Attempts (2-3)

```
ATTEMPT 2/3: Error Analysis & Correction
│
├─ Get error analysis prompt from prompts.js:
│  ├─ Failed SOQL query
│  ├─ Error message
│  ├─ Original user question
│  ├─ Available schema
│  └─ Attempt number
│
├─ Call NVIDIA LLM with lower temperature (0.1)
│  (More precise, less creative)
│
├─ LLM analyzes error:
│  ├─ Pattern matching (6 error types)
│  ├─ Schema validation
│  ├─ Relationship checking
│  └─ Generate correction
│
├─ Check if correction is possible:
│  ├─ If "NOT_POSSIBLE" ──┐
│  │                       └─ Return not possible
│  │
│  └─ If corrected query ─┐
│                         ├─ Clean syntax (remove markdown)
│                         ├─ Execute corrected query
│                         │
│                         ├─ Success? ──┐
│                         │  │           │
│                         │  └─ Return  │
│                         │   healed    │
│                         │   results   │
│                         │             │
│                         └─ Error? ────┘
│                             │
│                             └─ Check if maxRetries reached
│                                ├─ YES: Return error + history
│                                └─ NO: Loop to ATTEMPT 2 or 3
```

## Error Type Handling Matrix

```
┌────────────────────────────┬─────────────────────────┬────────────────────┐
│ Error Type                 │ Detection Pattern       │ Correction Action  │
├────────────────────────────┼─────────────────────────┼────────────────────┤
│ Polymorphic Field          │ "Invalid field X on     │ Replace with       │
│ (Task.What.Industry)       │  type Y"                │ What.Name, What.Type
│                            │                         │                    │
│ Semi-Join Error            │ "not supported for      │ Rewrite as direct  │
│ (Task relationships)       │  semi join"             │ query               │
│                            │                         │                    │
│ Compound Field             │ "Address is not valid"  │ Expand to Street,  │
│ (Address)                  │                         │ City, State, etc.   │
│                            │                         │                    │
│ Invalid Field              │ "Unknown field X"       │ Suggest valid       │
│                            │ "No such column"        │ alternatives        │
│                            │                         │                    │
│ Missing GROUP BY           │ "GROUP BY clause        │ Add GROUP BY        │
│                            │  required"              │                    │
│                            │                         │                    │
│ Syntax Error               │ "Malformed query" OR    │ Fix syntax issues   │
│                            │ "Parse error"           │ (quotes, etc.)      │
└────────────────────────────┴─────────────────────────┴────────────────────┘
```

## Response Path Decision Tree

```
                      Query Execution Result
                              │
                ┌─────────────┬┴─────────────┬──────────────┐
                │             │              │              │
                ▼             ▼              ▼              ▼
           SUCCESS       CLARIFICATION   NOT_POSSIBLE    FATAL ERROR
            (200)         NEEDED (200)      (200)          (500)
                              │              │              │
                              ▼              ▼              ▼
                    needsClarification   notPossible      fatal: true
                         = true             = true        HTTP 500
                              │              │              │
                    Show schema            Return          Reconnect
                    Ask user               error msg       Salesforce
                              │              │              │
                              └──────┬───────┴──────────────┘
                                     │
                         ┌───────────▼──────────────┐
                         │   MAX RETRIES CHECK      │
                         └───────────┬──────────────┘
                                     │
                        ┌────────────┴────────────┐
                        │                         │
                        ▼ 3+ Attempts            ▼ < 3 Attempts
                   Return Error            Continue Healing
                   + Full History              OR Success
```

## Data Structure: Healing Result

```javascript
{
  // Always present
  success: boolean,
  question: string,
  attempts: number,
  errorHistory: [
    {
      attempt: number,
      query: string,
      error: string
    }
  ],
  
  // For successful queries
  soql?: string,
  data?: { records: [], totalSize: number },
  healed?: boolean,        // true if attempts > 1
  
  // For error scenarios
  error?: string,
  needsClarification?: boolean,
  notPossible?: boolean,
  fatal?: boolean,
  maxRetriesReached?: boolean
}
```

## Performance Profile

```
Time (seconds)
│
6 ├─────────────────┐
  │                 │ Worst case: 3 retries with LLM
  │                 │ (complex error + slow API)
5 ├                 │
  │                 │
4 ├         ┌───────┘
  │         │ Typical: 1 correction attempt
3 ├─────────┘
  │         ┌─────────────┐
2 ├─────────┤             │ Best case: Fresh query success
  │ │       │             │ (good generation, fast execution)
1 ├─┘       │             │
  │         │             │
0 └─────────┴─────────────┘
  Attempt1  Attempt2      Total
```

## Concurrency & State Management

```
┌─────────────────────────────────────────────────────────┐
│                 generateAndExecuteSOQLWithHealing        │
│                                                          │
│  Local Variables (per request):                         │
│  ├─ attemptNumber: number (1-3)                        │
│  ├─ lastError: string                                  │
│  ├─ lastQuery: string                                  │
│  ├─ errorHistory: array                                │
│  └─ currentUserId: from outer scope (read-only)        │
│                                                          │
│  No shared state - fully async safe!                   │
│  Each request gets its own variables                   │
└─────────────────────────────────────────────────────────┘
```

## Configuration Points

```
┌──────────────────────────────────────┐
│  Tuning Parameters                   │
├──────────────────────────────────────┤
│ maxRetries: 3 (adjustable)           │
│ LLM Temperature: 0.1 (precise)       │
│ Fatal Errors: Hardcoded list         │
│ Max Tokens: 1024 (adjustable)        │
│ Schema Context: Full (adjustable)    │
│ Timeout: None (uses fetch timeout)   │
└──────────────────────────────────────┘
```

## Example: Complete Request/Response Cycle

```
USER REQUEST:
POST /smart-query
{
  "question": "show me account for task 00TGA00003fTAL32AO",
  "conversationHistory": []
}

SYSTEM PROCESSING:
┌─ Attempt 1 (0.5s)
│  Generated SOQL: SELECT What.Industry FROM Task WHERE Id = '00TGA...'
│  Error: Invalid field 'Industry' on type 'What'
│  
├─ Attempt 2 (2.5s)
│  Analyzed Error: Polymorphic field access issue
│  Corrected SOQL: SELECT WhatId, What.Name, What.Type FROM Task WHERE Id = '00TGA...'
│  Success! ✅ 1 record returned
│
└─ Generate Explanation (3.2s)
   "This shows 1 task with its related account information"

RESPONSE (3.5s total):
{
  "question": "show me account for task 00TGA00003fTAL32AO",
  "soql": "SELECT WhatId, What.Name, What.Type FROM Task WHERE Id = '00TGA...'",
  "data": {
    "records": [
      { "Id": "00T...", "WhatId": "001...", "What": { "Name": "Acme Corp", "Type": "Account" } }
    ],
    "totalSize": 1
  },
  "explanation": "This shows 1 task with its related account...",
  "recordCount": 1,
  "response": "Found 1 records",
  "healed": true,        ◄── NEW: Auto-corrected!
  "attempts": 2,         ◄── NEW: Required 2 attempts
  "errorHistory": [      ◄── NEW: Error trail
    {
      "attempt": 1,
      "query": "SELECT What.Industry FROM Task WHERE...",
      "error": "Invalid field 'Industry' on type 'What'"
    }
  ]
}
```

---

This architecture provides robust error handling with transparent healing metadata for debugging and monitoring!

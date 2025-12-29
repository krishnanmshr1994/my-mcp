# Salesforce AI Agent (MCP + NVIDIA LLM)

A powerful Salesforce middleware that uses **NVIDIA Llama-3** to intelligently query and manage Salesforce data via the **Model Context Protocol (MCP)**.

## 🚀 Features
- **Smart Querying**: Natural language to SOQL conversion.
- **MCP Native**: Compatible with Claude Desktop, Cursor, and other MCP clients.
- **Autonomous Agent**: Includes a "Brain" loop that can perform multi-step Salesforce tasks.

## 🛠️ Setup

### Prerequisites
- Node.js v18+
- Salesforce Developer Org
- NVIDIA API Key (from NVIDIA API Catalog)

 ### Root Directory
 - mcp-provider-api

### Environment Variables
Create a `.env` file or set these in Render:
- `SALESFORCE_USERNAME`
- `SALESFORCE_PASSWORD`
- `SALESFORCE_SECURITY_TOKEN`
- `NVIDIA_API_KEY`
- `SALESFORCE_LOGIN_URL`
- `SALESFORCE_ACCESS_TOKEN`: If face accessing SF org
- `SALESFORCE_INSTANCE_URL`
- `SCHEMA_CACHE_TTL`
- `ENABLE_PERSISTENT_CACHE`

## 📦 Installation
```bash
npm install
npm start
```
### Start Command
```bash
node http-server.js
```
### Build Comand
```bash
npm install
```
---
### 🔌Endpoints
- GET  /health
- GET  /schema
- GET  /schema/:objectName
- POST /query
- POST /create
- POST /update
- POST /delete
- POST /generate-soql
- POST /smart-query
- POST /chat


### 2. `.gitignore`
Crucial to prevent your private keys from being uploaded to GitHub.

# Dependencies
node_modules/
.npm

# Credentials
.env
*.pem

# System
.DS_Store
dist/
3. render.yaml (Optional but highly recommended)
This allows you to deploy to Render with a single click using "Blueprints."

YAML

services:
  - type: web
    name: salesforce-ai-agent
    env: node
    plan: free
    buildCommand: npm install
    startCommand: node http-server.js
    envVars:
      - key: NODE_VERSION
        value: 18.16.0
      - key: SALESFORCE_LOGIN_URL
        sync: false
      - key: NVIDIA_API_KEY
        sync: false
4. package.json
(As provided previously, ensure type: "module" is included to support your import statements.)

5. http-server.js
(Your main application logic provided in the previous turn.)

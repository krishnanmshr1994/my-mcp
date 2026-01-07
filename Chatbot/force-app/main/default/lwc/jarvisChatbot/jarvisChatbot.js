import { LightningElement, track } from 'lwc';

export default class JarvisChatbot extends LightningElement {
    @track viewMode = ''; 
    @track selectedFeatureLabel = '';
    @track messages = [];
    @track isLoading = false;
    @track isMobile = false;
    @track conversationHistory = [];
    @track newsAccountName = '';
    @track newsConfirmed = false;
    
    userInput = '';
    BASE_URL = 'https://my-mcp-6ihw.onrender.com';

    connectedCallback() {
        this.isMobile = window.innerWidth <= 768 || /SalesforceMobileSDK|Salesforce1/i.test(navigator.userAgent);
    }

    get isChatActive() { return this.viewMode === 'chat'; }
    get isNewsActive() { return this.viewMode === 'news'; }
    get isNewsDisabled() { return !this.newsAccountName.trim(); }

    // Navigation
    handleSelectQuery() { this.activateChat('Smart Query', 'Ask me about Salesforce data.'); }
    handleSelectChat() { this.activateChat('General Chat', 'How can I help you?'); }
    handleSelectNews() { this.viewMode = 'news'; this.newsConfirmed = false; this.newsAccountName = ''; }

    activateChat(label, welcomeMsg) {
        this.viewMode = 'chat';
        this.selectedFeatureLabel = label;
        this.messages = [{ id: 'welcome', text: welcomeMsg, containerClass: 'bot-container', bubbleClass: 'bot-bubble' }];
    }

    handleBack() {
        this.viewMode = '';
        this.newsConfirmed = false;
        this.messages = [];
        this.userInput = '';
    }

    // News Actions
    handleNewsNameChange(event) { this.newsAccountName = event.target.value; }
    handleConfirmNews() { if(this.newsAccountName.trim()) this.newsConfirmed = true; }
    handleNewSearch() { this.newsConfirmed = false; this.newsAccountName = ''; }

    // Chat Actions
    handleInputChange(event) { this.userInput = event.target.value; }
    handleEnter(event) { if (event.keyCode === 13) this.handleSendMessage(); }

    async handleSendMessage() {
        if (!this.userInput.trim()) return;
        const txt = this.userInput;
        this.userInput = '';
        this.messages = [...this.messages, { id: Date.now(), text: txt, containerClass: 'user-container', bubbleClass: 'user-bubble' }];
        this.isLoading = true;
        const isSmartQuery = this.selectedFeatureLabel === 'Smart Query';
        const endpoint = isSmartQuery ? '/smart-query' : '/chat';
        // FIX: Format history correctly for the specific endpoint
        let historyPayload = isSmartQuery ? 
        this.conversationHistory : 
        this.messages.filter(m => m.id !== 'welcome').map(m => ({
            role: m.containerClass === 'user-container' ? 'user' : 'assistant',
            content: m.text
        }));
        try {
            const res = await fetch(`${this.BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: txt, message: txt, conversationHistory: historyPayload })
            });
            const data = await res.json();
            this.processBotResponse(data, txt);
        } catch (e) { console.error(e); } 
        finally { this.isLoading = false; this.scrollToBottom(); }
    }

    processBotResponse(data, originalQuestion) {
        const hasRecs = !!(data.data?.records?.length > 0);
        
        const msg = {
            id: `bot-${Date.now()}`,
            text: data.response || (hasRecs ? "Results:" : "Response:"),
            containerClass: 'bot-container', 
            bubbleClass: 'bot-bubble',
            hasExplanation: !!data.explanation, 
            explanation: data.explanation,
            showExplanation: false, 
            toggleLabel: 'Why use this?',
            hasRecords: hasRecs,
            rawRecords: hasRecs ? data.data.records : [], // Required for HTML table
            objectQueried: data.objectQueried,// Track object for conversation history
            soql: data.soql,// Track SOQL for reference
            recordCount: data.recordCount,  // Track count
            childRecordTables: [] 
        };

        // Safety check: Only process columns/records if they exist
        if (hasRecs) {
            const firstRecord = data.data.records[0]; 
            const columnInfo = this.extractColumnsWithChildren(firstRecord);
            msg.columns = columnInfo.parentColumns;
            msg.childRecordTables = columnInfo.childTables;
            
            msg.records = data.data.records.map((r, i) => ({
                Id: r.Id || i,
                fields: msg.columns.map(c => ({ 
                    label: c.label, 
                    value: this.getNestedFieldValue(r, c.fieldName),
                    fieldName: c.fieldName
                })),
                childRecords: this.extractChildRecords(r, columnInfo.childTables)
            }));
        }
        // Only update technical history for Smart Query
        if (this.selectedFeatureLabel === 'Smart Query') {
            this.conversationHistory = [...this.conversationHistory, {
                question: originalQuestion,
                soql: data.soql,
                objectQueried: data.objectQueried,
                recordCount: data.recordCount,
                results: data.data?.records || []
            }];
        }
        this.messages = [...this.messages, msg];
    }

    // Helper: Extract columns AND identify child record collections
    extractColumnsWithChildren(record) {
        const parentColumns = [];
        const childTables = [];
        
        if (!record) return { parentColumns, childTables };

        const processField = (key) => {
            if (key === 'attributes') return;
            
            const value = record[key];
            
            // 1. Handle Child Records (Arrays like Contacts, Opportunities)
            // Check for records property because Salesforce subqueries return { totalSize, done, records: [] }
            const childData = (value && typeof value === 'object' && value.records) ? value.records : (Array.isArray(value) ? value : null);

            if (Array.isArray(childData) && childData.length > 0) {
                const childColumns = [];
                const firstChildRecord = childData[0];
                
                Object.keys(firstChildRecord).forEach(childKey => {
                    if (childKey !== 'attributes' && typeof firstChildRecord[childKey] !== 'object') {
                        childColumns.push({
                            label: childKey.charAt(0).toUpperCase() + childKey.slice(1),
                            fieldName: childKey
                        });
                    }
                });
                
                if (childColumns.length > 0) {
                    childTables.push({
                        relationshipName: key,
                        label: `${key} (${childData.length})`,
                        columns: childColumns,
                        records: childData
                    });
                }
                return;
            }
            
            // 2. Handle Nested Parent Objects (e.g., Account, Who, What)
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                // This is a related object (Parent), extract its fields (Name, Phone, etc.)
                Object.keys(value).forEach(nestedKey => {
                    if (nestedKey !== 'attributes') {
                        // This creates 'Account.Name' which getNestedFieldValue can resolve
                        const fieldName = `${key}.${nestedKey}`;
                        const label = `${key} ${nestedKey}`;
                        parentColumns.push({ label, fieldName });
                    }
                });
            } 
            // 3. Handle Simple Fields (e.g., Id, Name, Status)
            else if (typeof value !== 'object') {
                parentColumns.push({ label: key, fieldName: key });
            }
        };
        
        Object.keys(record).forEach(key => processField(key));
        return { parentColumns, childTables };
    }

    // Helper: Extract child records for a parent record
    extractChildRecords(record, childTables) {
        const childRecords = {};
        
        childTables.forEach(childTable => {
            const relationshipData = record[childTable.relationshipName];
            if (Array.isArray(relationshipData)) {
                childRecords[childTable.relationshipName] = {
                    label: childTable.label,
                    columns: childTable.columns,
                    records: relationshipData.map((childRec, idx) => ({
                        Id: childRec.Id || idx,
                        fields: childTable.columns.map(col => ({
                            label: col.label,
                            value: this.getNestedFieldValue(childRec, col.fieldName),
                            fieldName: col.fieldName
                        }))
                    }))
                };
            }
        });
        
        return childRecords;
    }

    // Helper: Extract columns from record, handling nested fields
    extractColumns(record) {
        const columns = [];
        
        const processField = (key, prefix = '') => {
            if (key === 'attributes') return;
            
            const value = record[key];
            
            // Handle nested objects (e.g., Account, Who, What)
            if (value && typeof value === 'object' && !Array.isArray(value) && value.attributes) {
                // This is a related object, extract its fields
                Object.keys(value).forEach(nestedKey => {
                    if (nestedKey !== 'attributes') {
                        const fieldName = `${key}.${nestedKey}`;
                        const label = `${key} ${nestedKey}`;
                        columns.push({ label, fieldName });
                    }
                });
            } else if (typeof value !== 'object' || Array.isArray(value)) {
                // Simple field
                columns.push({ label: key, fieldName: key });
            }
        };
        
        Object.keys(record).forEach(key => processField(key));
        return columns;
    }

    // Helper: Get value from nested field path (e.g., "Account.Name" or "Who.Name")
    getNestedFieldValue(record, fieldPath) {
        if (!fieldPath) return '';
        
        // Handle nested fields like "Account.Name", "Who.Name", "What.Name"
        if (fieldPath.includes('.')) {
            const parts = fieldPath.split('.');
            let value = record;
            
            for (const part of parts) {
                if (value && typeof value === 'object') {
                    value = value[part];
                } else {
                    return ''; // Path doesn't exist
                }
            }
            
            return value ? String(value) : '';
        }
        
        // Simple field
        const value = record[fieldPath];
        return value ? String(value) : '';
    }

    handleToggleExplanation(event) {
        const id = event.target.dataset.id;
        this.messages = this.messages.map(m => m.id == id ? { ...m, showExplanation: !m.showExplanation, toggleLabel: m.showExplanation ? 'Why use this?' : 'Hide' } : m);
    }

    scrollToBottom() {
        setTimeout(() => {
            const el = this.template.querySelector('.message-area');
            if (el) el.scrollTop = el.scrollHeight;
        }, 100);
    }
}
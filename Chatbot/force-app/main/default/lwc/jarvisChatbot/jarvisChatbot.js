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

    // GETTERS
    get isChatActive() { 
        return this.viewMode === 'chat'; 
    }
    get isNewsActive() { 
        return this.viewMode === 'news'; 
    }
    get isEmailMode() { 
        return this.selectedFeatureLabel === 'Email Assistant'; 
    }
    get isNewsDisabled() { 
        return !this.newsAccountName.trim(); 
    }

    // NAVIGATION HANDLERS
    handleSelectQuery() { 
        this.activateChat('Smart Query', 'Ask me about Salesforce data (e.g., "Show me top accounts").'); 
    }
    handleSelectChat() { 
        this.activateChat('General Chat', 'How can I help you today?'); 
    }
    handleSelectNews() { 
        this.viewMode = 'news'; 
        this.newsConfirmed = false; 
        this.newsAccountName = ''; 
    }
    handleSelectEmail() { 
        this.activateChat('Email Assistant', 'Tell me who you are emailing and the goal (e.g., "Draft a follow-up email to a lead about a demo").'); 
    }

    activateChat(label, welcomeMsg) {
        this.viewMode = 'chat';
        this.selectedFeatureLabel = label;
        this.messages = [{ 
            id: 'welcome', 
            text: welcomeMsg, 
            containerClass: 'bot-container', 
            bubbleClass: 'bot-bubble',
            isBot: true // Flag for EmailAssistant component
        }];
    }

    handleBack() {
        this.viewMode = '';
        this.newsConfirmed = false;
        this.messages = [];
        this.userInput = '';
        this.conversationHistory = [];
    }

    // NEWS LOGIC
    handleNewsNameChange(event) { this.newsAccountName = event.target.value; }
    handleConfirmNews() { if(this.newsAccountName.trim()) this.newsConfirmed = true; }
    handleNewSearch() { this.newsConfirmed = false; this.newsAccountName = ''; }

    // CHAT LOGIC
    handleInputChange(event) { this.userInput = event.target.value; }
    handleEnter(event) { if (event.keyCode === 13) this.handleSendMessage(); }

    async handleSendMessage() {
        if (!this.userInput.trim()) return;
        
        const txt = this.userInput;
        this.userInput = '';
        
        // Add User Message to UI
        this.messages = [...this.messages, { 
            id: Date.now(), 
            text: txt, 
            containerClass: 'user-container', 
            bubbleClass: 'user-bubble',
            isBot: false
        }];
        
        this.isLoading = true;

        // Determine Endpoint
        let endpoint = '/chat';
        if (this.selectedFeatureLabel === 'Smart Query') endpoint = '/smart-query';
        if (this.selectedFeatureLabel === 'Email Assistant') endpoint = '/email-assist';

        // Format History
        let historyPayload = this.selectedFeatureLabel === 'Smart Query' ? 
            this.conversationHistory : 
            this.messages.filter(m => m.id !== 'welcome').map(m => ({
                role: m.containerClass === 'user-container' ? 'user' : 'assistant',
                content: m.text
            }));

        try {
            const res = await fetch(`${this.BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    question: txt, 
                    message: txt, 
                    conversationHistory: historyPayload 
                })
            });
            const data = await res.json();
            this.processBotResponse(data, txt);
        } catch (e) { 
            console.error(e); 
            this.messages = [...this.messages, { 
                id: 'err', 
                text: 'Connection error.', 
                containerClass: 'bot-container', 
                bubbleClass: 'bot-bubble',
                isBot: true 
            }];
        } finally { 
            this.isLoading = false; 
            this.scrollToBottom(); 
        }
    }

    processBotResponse(data, originalQuestion) {
        const hasRecs = !!(data.data?.records?.length > 0);
        
        const msg = {
            id: `bot-${Date.now()}`,
            text: data.response || (hasRecs ? "Results found:" : "Processed."),
            containerClass: 'bot-container', 
            bubbleClass: 'bot-bubble',
            isBot: true,
            hasExplanation: !!data.explanation, 
            explanation: data.explanation,
            showExplanation: false, 
            toggleLabel: 'Why use this?',
            hasRecords: hasRecs,
            rawRecords: hasRecs ? data.data.records : [],
            objectQueried: data.objectQueried,
            soql: data.soql,
            recordCount: data.recordCount
        };

        if (hasRecs) {
            const firstRecord = data.data.records[0]; 
            const columnInfo = this.extractColumnsWithChildren(firstRecord);
            msg.columns = columnInfo.parentColumns;
            
            msg.records = data.data.records.map((r, i) => ({
                Id: r.Id || i,
                fields: msg.columns.map(c => ({ 
                    label: c.label, 
                    value: this.getNestedFieldValue(r, c.fieldName)
                }))
            }));
        }

        if (this.selectedFeatureLabel === 'Smart Query') {
            this.conversationHistory = [...this.conversationHistory, {
                question: originalQuestion,
                soql: data.soql,
                objectQueried: data.objectQueried,
                results: data.data?.records || []
            }];
        }
        
        this.messages = [...this.messages, msg];
    }

    // HELPERS (FULL ORIGINAL PARSING LOGIC)
    extractColumnsWithChildren(record) {
        const parentColumns = [];
        const childTables = [];
        if (!record) return { parentColumns, childTables };

        Object.keys(record).forEach(key => {
            if (key === 'attributes') return;
            const value = record[key];

            if (value && typeof value === 'object' && !Array.isArray(value)) {
                // Handle Lookups/Relationships
                Object.keys(value).forEach(nestedKey => {
                    if (nestedKey !== 'attributes') {
                        parentColumns.push({ label: `${key} ${nestedKey}`, fieldName: `${key}.${nestedKey}` });
                    }
                });
            } else if (typeof value !== 'object') {
                // Handle Standard Fields
                parentColumns.push({ label: key, fieldName: key });
            }
        });
        return { parentColumns, childTables };
    }

    getNestedFieldValue(record, fieldPath) {
        if (!fieldPath) return '';
        if (fieldPath.includes('.')) {
            const parts = fieldPath.split('.');
            let value = record;
            for (const part of parts) {
                value = value ? value[part] : '';
            }
            return value ? String(value) : '';
        }
        return record[fieldPath] ? String(record[fieldPath]) : '';
    }

    handleToggleExplanation(event) {
        const id = event.target.dataset.id;
        this.messages = this.messages.map(m => m.id == id ? 
            { ...m, showExplanation: !m.showExplanation, toggleLabel: m.showExplanation ? 'Why use this?' : 'Hide' } : m);
    }

    scrollToBottom() {
        setTimeout(() => {
            const el = this.template.querySelector('.message-area');
            if (el) el.scrollTop = el.scrollHeight;
        }, 100);
    }
}
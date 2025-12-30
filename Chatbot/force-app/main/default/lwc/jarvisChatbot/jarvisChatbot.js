import { LightningElement, track } from 'lwc';

export default class JarvisChatbot extends LightningElement {
    @track isChatActive = false;
    @track selectedFeatureLabel = '';
    @track messages = [];
    @track isLoading = false;
    @track isMobile = false;
    @track conversationHistory = []; // Track conversation for context
    userInput = '';
    BASE_URL = 'https://my-mcp-6ihw.onrender.com';

    connectedCallback() {
        // Detect if running in Salesforce mobile app
        this.isMobile = this.detectMobile();
        console.log('Is Mobile:', this.isMobile);
    }

    detectMobile() {
        // Check for Salesforce mobile app
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        const isSFMobile = /SalesforceMobileSDK|Salesforce1/i.test(userAgent);
        const isSmallScreen = window.innerWidth <= 768;
        return isSFMobile || isSmallScreen;
    }

    handleSelectQuery() { 
        this.activateChat('Smart Query', 'Find records.'); 
    }
    
    handleSelectChat() { 
        this.activateChat('General Chat', 'Ask me anything.'); 
    }

    activateChat(label, welcomeMsg) {
        this.selectedFeatureLabel = label;
        this.isChatActive = true;
        this.messages = [{ 
            id: 'welcome', 
            text: welcomeMsg, 
            containerClass: 'bot-container', 
            bubbleClass: 'bot-bubble',
            hasExplanation: false,
            hasRecords: false,
            showExplanation: false,
            isMobile: this.isMobile
        }];
    }

    handleBack() { 
        this.isChatActive = false; 
        this.messages = [];
        this.conversationHistory = []; // Clear history when going back
        this.userInput = '';
    }
    
    handleInputChange(event) { 
        this.userInput = event.target.value; 
    }
    
    handleEnter(event) { 
        if (event.keyCode === 13 && !event.shiftKey) {
            event.preventDefault();
            this.handleSendMessage(); 
        }
    }

    handleToggleExplanation(event) {
        event.preventDefault();
        event.stopPropagation();
        const msgId = event.currentTarget.dataset.id;
        
        // Force a complete re-render by creating entirely new array
        const updatedMessages = [];
        for (let msg of this.messages) {
            if (msg.id.toString() === msgId.toString()) {
                const newShowState = !msg.showExplanation;
                updatedMessages.push({
                    ...msg,
                    showExplanation: newShowState,
                    toggleLabel: newShowState ? 'Hide explanation' : 'Why use this?'
                });
            } else {
                updatedMessages.push({...msg});
            }
        }
        this.messages = updatedMessages;
    }

    async handleSendMessage() {
        if (!this.userInput.trim()) return;
        
        const userText = this.userInput;
        this.userInput = '';
        
        // Add user message
        const userMessage = { 
            id: `user-${Date.now()}`, 
            text: userText, 
            containerClass: 'user-container', 
            bubbleClass: 'user-bubble',
            hasExplanation: false,
            hasRecords: false,
            showExplanation: false,
            isMobile: this.isMobile
        };
        
        this.messages = [...this.messages, userMessage];
        this.isLoading = true;
        this.scrollToBottom();

        try {
            const endpoint = this.selectedFeatureLabel === 'Smart Query' ? '/smart-query' : '/chat';
            
            // Prepare request body with conversation history for Smart Query
            const requestBody = {
                question: userText,
                message: userText
            };
            
            // Add conversation history for Smart Query to maintain context
            if (endpoint === '/smart-query') {
                requestBody.conversationHistory = this.conversationHistory;
            }
            
            const response = await fetch(`${this.BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Process records
            let rawRecords = data.data?.records || null;
            let processedRecords = [];
            let columns = [];

            const hasRecords = rawRecords && Array.isArray(rawRecords) && rawRecords.length > 0;
            
            if (hasRecords) {
                const columnKeys = Object.keys(rawRecords[0]).filter(k => k !== 'attributes');
                columns = columnKeys.map(k => ({ label: k, fieldName: k, type: 'text' }));
                processedRecords = rawRecords.map((r, idx) => {
                    const record = {
                        Id: r.Id || `rec-${idx}`
                    };
                    const fields = [];
                    columnKeys.forEach(key => {
                        fields.push({
                            name: key,
                            label: key,
                            value: r[key] != null ? String(r[key]) : ''
                        });
                    });
                    record.fields = fields;
                    return record;
                });
            }

            // Check if explanation exists and is not empty
            const explanationText = data.explanation ? String(data.explanation).trim() : '';
            const hasExplanation = explanationText.length > 0;

            // Create bot message with all properties
            const botMessage = {
                id: `bot-${Date.now()}`,
                text: data.response || "Results:",
                containerClass: 'bot-container',
                bubbleClass: 'bot-bubble',
                hasExplanation: hasExplanation,
                hasRecords: hasRecords,
                showExplanation: false, // ALWAYS start false
                toggleLabel: 'Why use this?',
                isMobile: this.isMobile
            };

            if (hasExplanation) {
                botMessage.explanation = explanationText;
            }

            if (hasRecords) {
                botMessage.rawRecords = rawRecords;
                botMessage.records = processedRecords;
                botMessage.columns = columns;
            }
            
            this.messages = [...this.messages, botMessage];
            
            // Add to conversation history for Smart Query context
            if (endpoint === '/smart-query' && data.soql) {
                this.conversationHistory = [...this.conversationHistory, {
                    question: userText,
                    soql: data.soql,
                    recordCount: data.recordCount || 0
                }];
                
                // Keep only last 5 conversations to avoid token limits
                if (this.conversationHistory.length > 5) {
                    this.conversationHistory = this.conversationHistory.slice(-5);
                }
            }
            
        } catch (e) { 
            console.error('Error fetching data:', e);
            this.messages = [...this.messages, {
                id: `error-${Date.now()}`,
                text: `Sorry, there was an error: ${e.message}`,
                containerClass: 'bot-container',
                bubbleClass: 'bot-bubble',
                hasExplanation: false,
                hasRecords: false,
                showExplanation: false,
                isMobile: this.isMobile
            }];
        } finally { 
            this.isLoading = false; 
            this.scrollToBottom(); 
        }
    }

    scrollToBottom() {
        setTimeout(() => { 
            const container = this.template.querySelector('.message-area');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 200);
    }
}
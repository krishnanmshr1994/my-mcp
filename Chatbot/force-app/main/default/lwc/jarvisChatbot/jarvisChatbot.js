import { LightningElement, track } from 'lwc';

export default class JarvisChatbot extends LightningElement {
    @track isChatActive = false;
    @track selectedFeatureLabel = '';
    @track messages = [];
    @track isLoading = false;
    userInput = '';
    BASE_URL = 'https://my-mcp-6ihw.onrender.com';

    handleSelectQuery() { 
        this.activateChat('Smart Query', '"Show top 5 Accounts"'); 
    }
    
    handleSelectChat() { 
        this.activateChat('General Chat', 'How can I assist you today?'); 
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
            showExplanation: false
        }];
    }

    handleBack() { 
        this.isChatActive = false; 
        this.messages = []; 
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
        
        console.log('Toggle clicked for message:', msgId);
        
        this.messages = this.messages.map(msg => {
            if (msg.id.toString() === msgId.toString()) {
                const newShowState = !msg.showExplanation;
                console.log('Toggling explanation:', msg.showExplanation, '->', newShowState);
                return { 
                    ...msg, 
                    showExplanation: newShowState, 
                    toggleLabel: newShowState ? 'Hide explanation' : 'Why use this?' 
                };
            }
            return msg;
        });
    }

    async handleSendMessage() {
        if (!this.userInput.trim()) return;
        
        const userText = this.userInput;
        this.userInput = '';
        
        // Add user message
        this.messages = [...this.messages, { 
            id: `user-${Date.now()}`, 
            text: userText, 
            containerClass: 'user-container', 
            bubbleClass: 'user-bubble',
            hasExplanation: false,
            hasRecords: false,
            showExplanation: false
        }];
        
        this.isLoading = true;
        this.scrollToBottom();

        try {
            const endpoint = this.selectedFeatureLabel === 'Smart Query' ? '/smart-query' : '/chat';
            const response = await fetch(`${this.BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: userText, message: userText })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            console.log('API Response:', data);
            
            // Process records
            let rawRecords = data.data?.records || null;
            let processedRecords = [];
            let columns = [];

            const hasRecords = rawRecords && Array.isArray(rawRecords) && rawRecords.length > 0;
            
            if (hasRecords) {
                const columnKeys = Object.keys(rawRecords[0]).filter(k => k !== 'attributes');
                columns = columnKeys.map(k => ({ label: k, fieldName: k }));
                processedRecords = rawRecords.map((r, idx) => ({
                    Id: r.Id || `rec-${idx}`,
                    fields: columnKeys.map(key => ({ 
                        name: key, 
                        label: key, 
                        value: r[key] != null ? String(r[key]) : '' 
                    }))
                }));
            }

            // Check if explanation exists and is not empty
            const hasExplanation = Boolean(data.explanation && data.explanation.trim().length > 0);
            
            console.log('Has explanation:', hasExplanation);
            console.log('Has records:', hasRecords);

            // Create bot message
            const botMessage = {
                id: `bot-${Date.now()}`,
                text: data.response || "Results:",
                containerClass: 'bot-container',
                bubbleClass: 'bot-bubble',
                hasExplanation: hasExplanation,
                hasRecords: hasRecords,
                showExplanation: false, // CRITICAL: Always start hidden
                toggleLabel: 'Why use this?'
            };

            // Only add explanation property if it exists
            if (hasExplanation) {
                botMessage.explanation = data.explanation;
            }

            // Only add records if they exist
            if (hasRecords) {
                botMessage.rawRecords = rawRecords;
                botMessage.records = processedRecords;
                botMessage.columns = columns;
            }

            console.log('Bot message object:', botMessage);
            
            this.messages = [...this.messages, botMessage];
            
        } catch (e) { 
            console.error('Error fetching data:', e);
            this.messages = [...this.messages, {
                id: `error-${Date.now()}`,
                text: `Sorry, there was an error: ${e.message}`,
                containerClass: 'bot-container',
                bubbleClass: 'bot-bubble',
                hasExplanation: false,
                hasRecords: false,
                showExplanation: false
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
        }, 150);
    }
}
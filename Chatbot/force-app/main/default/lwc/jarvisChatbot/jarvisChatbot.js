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

        try {
            const endpoint = this.selectedFeatureLabel === 'Smart Query' ? '/smart-query' : '/chat';
            const res = await fetch(`${this.BASE_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: txt, message: txt, conversationHistory: this.conversationHistory })
            });
            const data = await res.json();
            this.processBotResponse(data);
        } catch (e) { console.error(e); } 
        finally { this.isLoading = false; this.scrollToBottom(); }
    }

    processBotResponse(data) {
        const hasRecs = data.data?.records?.length > 0;
        const msg = {
            id: `bot-${Date.now()}`,
            text: data.response || "Results:",
            containerClass: 'bot-container', bubbleClass: 'bot-bubble',
            hasExplanation: !!data.explanation, explanation: data.explanation,
            showExplanation: false, toggleLabel: 'Why use this?',
            hasRecords: hasRecs
        };

        if (hasRecs) {
            msg.rawRecords = data.data.records;
            msg.columns = Object.keys(data.data.records[0]).filter(k => k !== 'attributes').map(k => ({ label: k, fieldName: k }));
            msg.records = data.data.records.map((r, i) => ({
                Id: r.Id || i,
                fields: msg.columns.map(c => ({ label: c.label, value: String(r[c.fieldName]) }))
            }));
        }
        this.messages = [...this.messages, msg];
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
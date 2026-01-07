import { LightningElement, api, track } from 'lwc';
import getNewsSummary from '@salesforce/apex/NewsController.getNewsSummary';

export default class ClientNews extends LightningElement {
    @api recordId;
    @api clientName;
    @track newsItems = [];
    @track sentiment = '';
    @track loading = false;
    @track error;

    connectedCallback() {
        if (this.clientName) this.fetchNews(this.clientName);
    }

    fetchNews(query) {
        this.loading = true;
        getNewsSummary({ query })
            .then(result => {
                const data = JSON.parse(result);
                this.newsItems = typeof data.summary === 'string' ? JSON.parse(data.summary) : data.summary;
                this.sentiment = data.sentiment || 'Neutral';
                this.loading = false;
            })
            .catch(err => {
                this.error = 'Failed to load intelligence.';
                this.loading = false;
            });
    }

    get headerClass() {
        let base = 'slds-card__header slds-grid custom-header ';
        if (this.sentiment === 'Positive') return base + 'header-positive';
        if (this.sentiment === 'Negative') return base + 'header-negative';
        return base + 'header-neutral';
    }

    get sentimentIcon() {
        if (this.sentiment === 'Positive') return 'utility:trending_up';
        if (this.sentiment === 'Negative') return 'utility:trending_down';
        return 'utility:dash';
    }
}
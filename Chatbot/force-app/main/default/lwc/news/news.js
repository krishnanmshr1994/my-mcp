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
                // The summary key contains stringified JSON array
                this.newsItems = typeof data.summary === 'string' ? JSON.parse(data.summary) : data.summary;
                this.sentiment = data.sentiment;
                this.loading = false;
            })
            .catch(err => {
                this.error = err.body?.message || 'Error fetching news';
                this.loading = false;
            });
    }

    get sentimentBadgeClass() {
        const base = 'slds-badge ';
        if (this.sentiment === 'Positive') return base + 'sentiment-positive';
        if (this.sentiment === 'Negative') return base + 'sentiment-negative';
        return base + 'sentiment-neutral';
    }
}
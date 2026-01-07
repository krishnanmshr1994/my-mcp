import { LightningElement, api, wire, track } from 'lwc';
import { getRecord } from 'lightning/uiRecordApi';
import getNewsSummary from '@salesforce/apex/NewsController.getNewsSummary';
const FIELDS = ['Account.Name'];

export default class News extends LightningElement {
    @api recordId;
    @track newsItems = [];
    @track loading = false;
    @track error;
    
    _clientName = ''; // Private variable to store the name

    @api 
    get clientName() {
        return this._clientName;
    }
    set clientName(value) {
        if (value) {
            this._clientName = value;
            setTimeout(() => {
                this.fetchNews(this._clientName);
            }, 30);
        }
    }

    // Use a computed property for the wire parameter
    // If we already have a clientName, we pass 'undefined' to the wire to disable it
    get wireRecordId() {
        return this._clientName ? undefined : this.recordId;
    }

    @wire(getRecord, { recordId: '$wireRecordId', fields: FIELDS })
    wiredAccount({ error, data }) {
        if (data) {
            this._clientName = data.fields.Name.value;
            if (this._clientName) {
                this.fetchNews(this._clientName);
            }
        } else if (error) {
            this.error = 'Error loading Account: ' + JSON.stringify(error);
        }
    }

    fetchNews(query) {
        if (!query) return;
        this.loading = true;
        this.newsItems = [];
        this.error = undefined;
        
        getNewsSummary({ query })
            .then(result => {
                let parsed;
                try {
                    parsed = JSON.parse(result);
                } catch(e) {
                    this.error = result || 'No news found.';
                    this.loading = false;
                    return;
                }
                if (Array.isArray(parsed)) {
                    this.newsItems = parsed;
                } else {
                    this.error = 'No news found.';
                }
                this.loading = false;
            })
            .catch(err => {
                this.error = 'Error: ' + (err.body?.message || JSON.stringify(err));
                this.loading = false;
            });
    }

    get showHint() {
        return !this.loading && !this.newsItems.length && !this.error;
    }
}
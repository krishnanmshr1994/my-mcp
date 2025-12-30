import { LightningElement, track, api } from 'lwc';
import getMostValuableAccount from '@salesforce/apex/NewsController.getMostValueableAccount';

export default class News extends LightningElement {
    @api accountName;
    @track newsArticles = {};
    @track isFlipped = false;
    renderNews = false;

    // Point this to your Render/Node.js server URL
    PROXY_URL = 'https://my-mcp-6ihw.onrender.com/summarize';

    connectedCallback() {
        if (this.accountName) {
            this.getNews(this.accountName);
        } else {
            this.getAccount();
        }
    }

    getAccount() {
        getMostValuableAccount()
            .then(result => {
                if (result && result.length > 0) {
                    this.getNews(result[0].Name);
                }
            })
            .catch(error => {
                console.error('Apex Error:', error.message);
            });
    }

    getNews(accName) {
        // Fetch news from WorldNewsAPI
        fetch(`https://api.worldnewsapi.com/search-news?text=${accName}&language=en`, { 
            method: "GET",
            headers: {
                "x-api-key": "c06c1f7c280d4d3388bbeaa40a90ba15"
            }
        })
        .then(response => response.json())
        .then(jsonResponse => {
            let content = '';
            let sources = [];
            
            if (jsonResponse.news && jsonResponse.news.length > 0) {
                jsonResponse.news.forEach(news => {
                    content += (news.text || '') + ' ';
                    if (news.author && !sources.includes(news.author)) {
                        sources.push(news.author);
                    }
                });
                
                this.newsArticles.source = sources;
                this.newsArticles.header = `News for ${accName}`;
                // Send combined text to your Node server for NVIDIA summarization
                this.getSummarizedNews(content);
            } else {
                this.newsArticles.content = "No recent news found for this account.";
                this.renderNews = true;
            }
        })
        .catch(error => {
            console.error('News API Error:', error);
            this.newsArticles.content = "Failed to fetch news articles.";
            this.renderNews = true;
        });
    }

    async getSummarizedNews(textData) {
        try {
            // Call your backend proxy to use NVIDIA and avoid CORS
            const response = await fetch(this.PROXY_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ textData: textData })
            });

            const result = await response.json();
            
            // Handle NVIDIA response structure via your proxy
            if (result.choices && result.choices.length > 0) {
                this.newsArticles.content = result.choices[0].message.content;
            } else if (result.error) {
                console.error('NVIDIA Error:', result.error);
                this.newsArticles.content = "The summarization service is currently unavailable.";
            }
        } catch (error) {
            console.error('Proxy Call Error:', error);
            this.newsArticles.content = "Could not summarize news. Please try again later.";
        } finally {
            this.renderNews = true;
        }
    }

    handleFlip() {
        this.isFlipped = !this.isFlipped;
    }

    get cardClass() {
        return this.isFlipped ? 'flip-card-inner flipped' : 'flip-card-inner';
    }
}
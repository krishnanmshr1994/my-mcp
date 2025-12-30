import { LightningElement, track, api } from 'lwc';
import getMostValuableAccount from '@salesforce/apex/NewsController.getMostValueableAccount';

export default class News extends LightningElement {
    @api accountName;
    @track isFlipped = false;
    @track renderNews = false;
    @track sentiment = 'Neutral';
    @track newsArticles = { header: 'News', content: '', source: [] };

    WORLD_NEWS_API_KEY = 'c06c1f7c280d4d3388bbeaa40a90ba15';
    PROXY_URL = 'https://my-mcp-6ihw.onrender.com/summarize';

    connectedCallback() {
        this.initNews();
    }

    async initNews() {
        try {
            if (this.accountName) {
                this.getNews(this.accountName);
            } else {
                const result = await getMostValuableAccount();
                if (result && result.length > 0) {
                    this.getNews(result[0].Name);
                } else {
                    this.newsArticles.content = 'No account context found.';
                    this.renderNews = true;
                }
            }
        } catch (err) {
            console.error('Init Error:', err);
            this.renderNews = true;
        }
    }

    getNews(accName) {
        this.newsArticles.header = `News for ${accName}`;
        
        fetch(`https://api.worldnewsapi.com/search-news?text=${accName}&language=en`, { 
            method: "GET",
            headers: { "x-api-key": this.WORLD_NEWS_API_KEY }
        })
        .then(res => res.json())
        .then(json => {
            if (json.news && json.news.length > 0) {
                let fullText = '';
                let sources = [];
                json.news.forEach(n => {
                    fullText += (n.text || '') + ' ';
                    if (n.author && !sources.includes(n.author)) sources.push(n.author);
                });
                this.newsArticles.source = sources;
                this.getSummarizedNews(fullText);
            } else {
                this.newsArticles.content = "No recent news found.";
                this.renderNews = true;
            }
        })
        .catch(err => {
            console.error('Fetch Error:', err);
            this.renderNews = true;
        });
    }

    async getSummarizedNews(textData) {
        console.log('📤 Starting chunked summarization');
        console.log('📝 Total text length:', textData.length);
        
        try {
            // Split into chunks of 5000 chars
            const chunkSize = 5000;
            const chunks = [];
            for (let i = 0; i < textData.length; i += chunkSize) {
                chunks.push(textData.substring(i, i + chunkSize));
            }
            
            console.log('📦 Created', chunks.length, 'chunks');
            
            // Summarize each chunk
            const chunkSummaries = [];
            for (let i = 0; i < chunks.length; i++) {
                console.log(`📤 Summarizing chunk ${i + 1}/${chunks.length}`);
                
                const res = await fetch(this.PROXY_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                        textData: chunks[i],
                        isChunk: true,
                        chunkNumber: i + 1,
                        totalChunks: chunks.length
                    })
                });
                
                if (!res.ok) throw new Error(`Chunk ${i + 1} failed: ${res.status}`);
                
                const result = await res.json();
                const data = typeof result === 'string' ? JSON.parse(result) : result;
                
                chunkSummaries.push(data.summary);
                console.log(`✅ Chunk ${i + 1} done`);
            }
            
            // Now create final summary from all chunk summaries
            console.log('📤 Creating final summary from', chunkSummaries.length, 'summaries');
            
        const finalRes = await fetch(this.PROXY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                textData: chunkSummaries.join('\n\n'),
                isFinal: true
            })
        });
        
            if (!finalRes.ok) throw new Error(`Final summary failed: ${finalRes.status}`);
            
            const finalResult = await finalRes.json();
            const finalData = typeof finalResult === 'string' ? JSON.parse(finalResult) : finalResult;

            this.sentiment = finalData.sentiment || 'Neutral';
            this.newsArticles = {
                ...this.newsArticles,
                content: finalData.summary || 'Summary unavailable.'
            };
            
            console.log('✅ Final summary complete');
            
        } catch (err) {
            console.error('❌ Summarization error:', err);
            this.newsArticles.content = "Summary error: " + err.message;
        } finally {
            this.renderNews = true;
        }
    }

    get sentimentIcon() {
        if (this.sentiment === 'Positive') return 'utility:arrowup';
        if (this.sentiment === 'Negative') return 'utility:arrowdown';
        return 'utility:right';
    }

    get sentimentClass() {
        let base = 'slds-p-around_xx-small slds-text-title_bold ';
        if (this.sentiment === 'Positive') return base + 'slds-text-color_success';
        if (this.sentiment === 'Negative') return base + 'slds-text-color_error';
        return base + 'slds-text-color_weak';
    }

    handleFlip() { this.isFlipped = !this.isFlipped; }
    get cardClass() { return this.isFlipped ? 'flip-card-inner flipped' : 'flip-card-inner'; }
}
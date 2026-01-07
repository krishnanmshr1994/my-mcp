public with sharing class NewsController {
    static final String GNEWS_API_KEY = 'd5a4174b721e691bbed2bf4759b89f77';
    static final String PROXY_URL = 'https://my-mcp-6ihw.onrender.com/summarize';
    static final Integer CHUNK_SIZE = 5000; 

    @AuraEnabled(cacheable=false)
    public static String getNewsSummary(String query) {
        Http http = new Http();
        HttpRequest req = new HttpRequest();
        req.setEndpoint('https://gnews.io/api/v4/search?q='+EncodingUtil.urlEncode(query, 'UTF-8')+'&lang=en&max=20&apikey='+GNEWS_API_KEY);
        req.setMethod('GET');
        
        HttpResponse res = http.send(req);
        if (res.getStatusCode() != 200) throw new AuraHandledException('GNews Failed');

        Map<String,Object> newsData = (Map<String,Object>)JSON.deserializeUntyped(res.getBody());
        List<Object> articles = (List<Object>)newsData.get('articles');
        
        String fullText = '';
        for (Object obj : articles) {
            Map<String,Object> art = (Map<String,Object>)obj;
            fullText += 'TITLE: ' + art.get('title') + '\nDESC: ' + art.get('description') + '\nSOURCE: ' + art.get('url') + '\n\n';
        }

        List<String> chunks = new List<String>();
        for (Integer i = 0; i < fullText.length(); i += CHUNK_SIZE) {
            Integer endIndex = Math.min(i + CHUNK_SIZE, fullText.length());
            chunks.add(fullText.substring(i, endIndex));
        }

        List<String> chunkSummaries = new List<String>();
        for (Integer i = 0; i < chunks.size(); i++) {
            Map<String, Object> payload = new Map<String, Object>{
                'textData' => chunks[i],
                'isChunk' => true,
                'chunkNumber' => i + 1,
                'totalChunks' => chunks.size()
            };
            // MAP PHASE: Extract facts
            chunkSummaries.add(callProxy(payload, false));
        }

        Map<String, Object> finalPayload = new Map<String, Object>{
            'textData' => String.join(chunkSummaries, '\n\n'),
            'isFinal' => true
        };

        // REDUCE PHASE: Format as JSON
        return callProxy(finalPayload, true);
    }

    private static String callProxy(Map<String, Object> payload, Boolean isFinal) {
        String originalText = (String)payload.get('textData');
        
        // Inject DeepSeek-style instructions to force relevance and numbers
        String instruction = isFinal 
            ? 'You are a news expert.Combine these summaries. Keep all numbers/prices.Ensure to keep all the critical news. Return ONLY JSON array: [{"news":"", "news source":""}]'
            : 'Extract specific facts, company names, and data points as concise bullet points.';

        payload.put('textData', instruction + '\n\nTEXT:\n' + originalText);

        Http http = new Http();
        HttpRequest req = new HttpRequest();
        req.setEndpoint(PROXY_URL);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setBody(JSON.serialize(payload));
        req.setTimeout(120000);

        HttpResponse res = http.send(req);
        if (res.getStatusCode() != 200) throw new AuraHandledException('Proxy Error');

        // FIX FOR THE CASTING ERROR:
        Object deserialized = JSON.deserializeUntyped(res.getBody());
        if (deserialized instanceof Map<String, Object>) {
            Map<String, Object > resultMap = (Map<String, Object>)deserialized;
            return resultMap.containsKey('summary') ? (String)resultMap.get('summary') : res.getBody();
        } 
        
        // If the LLM returned a raw list or string, return as is
        return res.getBody();
    }
}
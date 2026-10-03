// Pinned, local gpt-tokenizer 4.0.0. No user data leaves this worker.
let loadedEncoding = '';
self.onmessage = event => {
    const { id,encoding,docs } = event.data;
    try {
        if (!['o200k_base','cl100k_base'].includes(encoding)) throw new Error('未知分词器');
        if (loadedEncoding !== encoding) { importScripts(`../../vendor/tokenizer/${encoding}.js`); loadedEncoding = encoding; }
        const api = self.OVOTokenizer.default,encoder = new TextEncoder();
        const counts = docs.map(doc => {
            const tokens = api.encode(doc.text,{ disallowedSpecial:new Set() }),values = doc.spans.map(() => 0),boundaries = doc.spans.map(s => encoder.encode(doc.text.slice(0,s.end)).length);
            let byte = 0,span = 0;
            for (const token of tokens) {
                while (span < boundaries.length - 1 && byte >= boundaries[span]) span++;
                if (values.length) values[span]++;
                const bytes = api.bytePairEncodingCoreProcessor.tryDecodeToken(token); byte += typeof bytes === 'string' ? encoder.encode(bytes).length : bytes.length;
            } return values;
        }); self.postMessage({ id,counts });
    } catch (error) { self.postMessage({ id,error:error.message }); }
};

(function (root) {
    'use strict';

    function normalizeBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    function buildVectorEndpoint(config, kind) {
        const provider = config?.provider || 'newapi';
        const base = normalizeBaseUrl(config?.url);
        const model = String(config?.model || '').trim();
        if (!base) return '';
        if (kind === 'models') {
            if (provider === 'gemini') return `${base.replace(/\/v1beta$/i, '')}/v1beta/models`;
            if (provider === 'ollama') return `${base.replace(/\/api$/i, '')}/api/tags`;
            if (/\/embeddings$/i.test(base)) return base.replace(/\/embeddings$/i, '/models');
            return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
        }
        if (provider === 'gemini') {
            const cleanModel = model.replace(/^models\//i, '');
            return `${base.replace(/\/v1beta$/i, '')}/v1beta/models/${encodeURIComponent(cleanModel)}:embedContent`;
        }
        if (provider === 'ollama') {
            return /\/api\/embed$/i.test(base) ? base : `${base.replace(/\/api$/i, '')}/api/embed`;
        }
        if (/\/embeddings(?:\?|$)/i.test(base)) return base;
        return /\/v1$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
    }

    function isFiniteVector(value) {
        return Array.isArray(value)
            && value.length > 0
            && value.every(item => Number.isFinite(Number(item)));
    }

    function parseEmbeddingResponse(provider, data, expectedCount) {
        let vectors = [];
        if (provider === 'gemini') {
            const single = data?.embedding?.values;
            const multiple = data?.embeddings;
            if (isFiniteVector(single)) vectors = [single.map(Number)];
            else if (Array.isArray(multiple)) {
                vectors = multiple.map(item => item?.values || item?.embedding?.values || []).map(item => item.map(Number));
            }
        } else if (provider === 'ollama') {
            if (Array.isArray(data?.embeddings)) vectors = data.embeddings.map(item => item.map(Number));
            else if (isFiniteVector(data?.embedding)) vectors = [data.embedding.map(Number)];
        } else if (Array.isArray(data?.data)) {
            vectors = [...data.data]
                .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
                .map(item => Array.isArray(item?.embedding) ? item.embedding.map(Number) : []);
        }
        if (!vectors.length || vectors.some(item => !isFiniteVector(item))) {
            throw new Error('Embedding 响应中没有有效的数值向量');
        }
        if (expectedCount && vectors.length !== expectedCount) {
            throw new Error(`Embedding 返回数量不匹配：期望 ${expectedCount}，实际 ${vectors.length}`);
        }
        const dimensions = vectors[0].length;
        if (vectors.some(item => item.length !== dimensions)) {
            throw new Error('Embedding 响应中的向量维度不一致');
        }
        return vectors;
    }

    function stableHash(value) {
        const input = String(value || '');
        let hash = 2166136261;
        for (let index = 0; index < input.length; index++) {
            hash ^= input.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function createProfileKey(config, dimensions) {
        return stableHash([
            config?.provider || 'newapi',
            normalizeBaseUrl(config?.url).toLowerCase(),
            String(config?.model || '').trim(),
            Number(dimensions || config?.dimensions || 0),
        ].join('|'));
    }

    function tokenize(text) {
        const normalized = String(text || '').toLowerCase().normalize('NFKC');
        const tokens = new Set();
        const words = normalized.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
        words.forEach(word => {
            if (/^[\p{Script=Han}]+$/u.test(word)) {
                if (word.length <= 3) tokens.add(word);
                for (let size = 2; size <= 3; size++) {
                    for (let index = 0; index <= word.length - size; index++) {
                        tokens.add(word.slice(index, index + size));
                    }
                }
            } else if (word.length >= 2) {
                tokens.add(word);
            }
        });
        return [...tokens];
    }

    function lexicalSimilarity(haystack, query) {
        const queryTokens = tokenize(query);
        if (!queryTokens.length) return 0;
        const targetTokens = new Set(tokenize(haystack));
        let matchedWeight = 0;
        let totalWeight = 0;
        queryTokens.forEach(token => {
            const weight = Math.min(3, Math.max(1, token.length - 1));
            totalWeight += weight;
            if (targetTokens.has(token) || String(haystack || '').toLowerCase().includes(token)) matchedWeight += weight;
        });
        return totalWeight ? matchedWeight / totalWeight : 0;
    }

    root.VectorMemoryCore = Object.freeze({
        normalizeBaseUrl,
        buildVectorEndpoint,
        isFiniteVector,
        parseEmbeddingResponse,
        stableHash,
        createProfileKey,
        tokenize,
        lexicalSimilarity,
    });
})(typeof window !== 'undefined' ? window : globalThis);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
await import(pathToFileURL(path.join(root, 'js/modules/vector-memory-core.js')).href);
const core = globalThis.VectorMemoryCore;

assert.ok(core, 'VectorMemoryCore should be exported');

assert.equal(
    core.buildVectorEndpoint({ provider: 'newapi', url: 'https://example.com/v1/' }, 'embeddings'),
    'https://example.com/v1/embeddings',
    'existing /v1 must not be duplicated',
);
assert.equal(
    core.buildVectorEndpoint({ provider: 'newapi', url: 'https://example.com/v1/embeddings' }, 'embeddings'),
    'https://example.com/v1/embeddings',
    'a complete embeddings endpoint must be preserved',
);
assert.equal(
    core.buildVectorEndpoint({ provider: 'newapi', url: 'https://example.com/v1/embeddings' }, 'models'),
    'https://example.com/v1/models',
);
assert.equal(
    core.buildVectorEndpoint({ provider: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta', model: 'models/gemini-embedding-001' }, 'embeddings'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
);
assert.equal(
    core.buildVectorEndpoint({ provider: 'ollama', url: 'http://localhost:11434/' }, 'embeddings'),
    'http://localhost:11434/api/embed',
);

assert.deepEqual(
    core.parseEmbeddingResponse('newapi', {
        data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
        ],
    }, 2),
    [[1, 2], [3, 4]],
    'OpenAI-compatible batch results must follow response indexes',
);
assert.deepEqual(
    core.parseEmbeddingResponse('gemini', { embedding: { values: [0.1, 0.2] } }, 1),
    [[0.1, 0.2]],
);
assert.deepEqual(
    core.parseEmbeddingResponse('ollama', { embeddings: [[0.1, 0.2], [0.3, 0.4]] }, 2),
    [[0.1, 0.2], [0.3, 0.4]],
);
assert.throws(
    () => core.parseEmbeddingResponse('newapi', { data: [{ embedding: [1, Number.NaN] }] }, 1),
    /有效的数值向量/,
);
assert.throws(
    () => core.parseEmbeddingResponse('newapi', { data: [{ embedding: [1, 2] }] }, 2),
    /数量不匹配/,
);

assert.ok(core.tokenize('我喜欢草莓蛋糕').includes('草莓'));
assert.ok(core.lexicalSimilarity('用户喜欢草莓蛋糕', '还记得我爱吃草莓吗') > 0);
assert.notEqual(
    core.createProfileKey({ provider: 'newapi', url: 'https://a.example/v1', model: 'embed-a' }, 1536),
    core.createProfileKey({ provider: 'newapi', url: 'https://a.example/v1', model: 'embed-b' }, 1536),
    'model changes must invalidate the embedding profile',
);

const presetsSource = fs.readFileSync(path.join(root, 'js/settings/api-presets.js'), 'utf8');
assert.match(presetsSource, /saveApiPresetSettings\(\[dbKey, presetsKey\]\)/, 'sub API settings and presets must be persisted');
const savedKeyCalls = [];
const presetSandbox = {
    saveGlobalSettings: async keys => { savedKeyCalls.push(keys); return true; },
    window: {},
    document: {},
    console,
};
vm.createContext(presetSandbox);
vm.runInContext(`${presetsSource}\nglobalThis.__saveApiPresetSettings = saveApiPresetSettings;`, presetSandbox);
assert.equal(await presetSandbox.__saveApiPresetSettings(['vectorApiSettings', 'vectorApiPresets']), true);
assert.deepEqual(
    Array.from(savedKeyCalls[0]),
    ['apiPresets', 'vectorApiSettings', 'vectorApiPresets'],
    'vector API configuration and presets must be committed together',
);
const vectorSource = fs.readFileSync(path.join(root, 'js/modules/vector_memory.js'), 'utf8');
const vectorConfigSource = vectorSource.slice(
    vectorSource.indexOf('function getVectorApiConfig'),
    vectorSource.indexOf('async function requestVectorSummary'),
);
assert.doesNotMatch(vectorConfigSource, /summaryApiSettings|db\.apiSettings/, 'embedding config must not fall back to chat APIs');
assert.match(vectorSource, /embeddingProfileKey/, 'entries must carry embedding profile identity');
assert.match(vectorSource, /embeddingStatus = 'pending'/, 'failed embedding must retain pending memory text');

const requestedEndpoints = [];
const sandbox = {
    window: { VectorMemoryCore: core },
    db: { vectorApiSettings: {} },
    fetch: async (endpoint) => {
        requestedEndpoints.push(endpoint);
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.2, 0.4, 0.6] }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    },
    Response,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    getRandomValue: value => value,
    saveGlobalSettings: async () => {},
    console,
};
vm.createContext(sandbox);
vm.runInContext(vectorSource, sandbox, { filename: 'js/modules/vector_memory.js' });
const liveTest = await sandbox.window.testVectorApiConfiguration({
    provider: 'newapi',
    url: 'https://example.com/v1',
    key: 'secret',
    model: 'embed-model',
});
assert.equal(liveTest.dimensions, 3);
assert.equal(requestedEndpoints[0], 'https://example.com/v1/embeddings');

console.log('Vector memory tests passed.');

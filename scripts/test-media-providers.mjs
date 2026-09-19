import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');

class TestFileReader {
    readAsDataURL(blob) {
        blob.arrayBuffer().then(buffer => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onloadend?.();
        }).catch(error => this.onerror?.(error));
    }
}

function imageContext() {
    const context = {
        window: {}, db: {}, console, Blob, FormData, Response, TextDecoder, DataView, Uint8Array,
        FileReader: TestFileReader, atob: value => Buffer.from(value, 'base64').toString('binary'),
        btoa: value => Buffer.from(value, 'binary').toString('base64'), setTimeout, clearTimeout,
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
        showErrorModal: () => {}, getRandomValue: value => value, pad: value => value,
        formatTimeGap: () => '', getLocalTimeInTimezone: () => '', filterHistoryForAI: value => value,
        showToast: () => {}, showAppConfirmDialog: async () => true,
        writeOvoPngMetadata: value => value, readOvoPngMetadata: () => null
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/core/api-and-image-utils.js'), 'utf8'), context);
    return context;
}

{
    const context = imageContext();
    context.db.imageAtmosphereGroups = [{ id: 'rain', name: '雨夜', prompt: 'cinematic rainy night', negativePrompt: 'sunny', providerPrompts: { google: 'blue neon' } }];
    context.db.activeImageAtmosphereId = 'rain';
    let request;
    context.fetch = async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await context.window.generateGoogleImage('a cat', { key: 'secret' });
    assert.equal(result.provider, 'google');
    assert.match(result.imageUrl, /^data:image\/png;base64,/);
    assert.match(request.body.contents[0].parts[0].text, /cinematic rainy night/);
    assert.match(request.body.contents[0].parts[0].text, /blue neon/);
    assert.ok(request.options.headers['x-goog-api-key']);
}

{
    const context = imageContext();
    let form;
    context.fetch = async (_url, options) => {
        form = options.body;
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const result = await context.window.generateStabilityImage('a cat', { key: 'secret', aspectRatio: '16:9' });
    assert.equal(result.provider, 'stability');
    assert.equal(form.get('prompt'), 'a cat');
    assert.equal(form.get('aspect_ratio'), '16:9');
    assert.match(result.imageUrl, /^data:image\/png;base64,/);
}

{
    const context = imageContext();
    let endpoint;
    context.fetch = async (url) => {
        endpoint = url;
        return new Response(JSON.stringify({ images: [{ base64: 'iVBORw0KGgo=' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await context.window.generateGptImage('a cat', { url: 'https://example.test/v1', key: 'secret' });
    assert.equal(endpoint, 'https://example.test/v1/images/generations');
    assert.equal(result.provider, 'gpt');
}

{
    const context = imageContext();
    context.fetch = async () => new Response(JSON.stringify({ images: [{ base64: 'iVBORw0KGgo=' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const result = await context.window.generateNovelAiImage('1girl', {
        token: '', authMode: 'none', customUrlEnabled: true, customUrl: 'https://example.test/custom', endpointMode: 'full'
    });
    assert.equal(result.provider, 'novelai');
    assert.match(result.imageUrl, /^data:image\/png;base64,/);
}

{
    const storage = new Map();
    const context = {
        window: {}, console, Blob, Uint8Array, ArrayBuffer, DataView,
        document: { readyState: 'loading', addEventListener: () => {}, dispatchEvent: () => {} },
        CustomEvent: class {}, Audio: class {},
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
        URL: { createObjectURL: blob => blob, revokeObjectURL: () => {} },
        crypto: { randomUUID: () => 'request-id' },
        atob: value => Buffer.from(value, 'base64').toString('binary'), setTimeout, clearTimeout,
        VoiceSelector: { voices: [{ id: 'female-shaonv' }] }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/modules/tts_service.js'), 'utf8'), context);
    const service = context.window.MinimaxTTSService;
    service.config = {
        ...service.config, enabled: true, provider: 'volcengine', volcAppId: 'app', volcAccessToken: 'token',
        volcResourceId: 'seed-tts-2.0', volcVoiceType: 'voice', volcUrl: 'https://example.test/tts', volcFormat: 'mp3'
    };
    let request;
    context.fetch = async (_url, options) => {
        request = options;
        const one = Buffer.from([1, 2]).toString('base64');
        const two = Buffer.from([3, 4]).toString('base64');
        return new Response(`${JSON.stringify({ code: 0, data: one })}\n${JSON.stringify({ code: 0, data: two })}\n`, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    context.Response = Response;
    const blob = await service.synthesize('你好', 'female-shaonv', 'zh');
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4]);
    const body = JSON.parse(request.body);
    assert.equal(body.req_params.speaker, 'voice');
    assert.equal(request.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
}

console.log('Media provider adapter tests passed.');

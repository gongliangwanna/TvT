import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8S8AAAAASUVORK5CYII=';
class FileReader {
    readAsDataURL(blob) { blob.arrayBuffer().then(data => { this.result = `data:${blob.type};base64,${Buffer.from(data).toString('base64')}`; this.onloadend?.(); }).catch(error => this.onerror?.(error)); }
}
const context = {
    window: {}, db: { novelAiSettings: {} }, crypto: webcrypto, URL, Blob, Response, ReadableStream,
    TextEncoder, TextDecoder, DataView, Uint8Array, DecompressionStream, FileReader, atob, btoa, DOMException,
    console: { log() {}, warn() {}, error() {} }, showAppConfirmDialog() {}, setTimeout, clearTimeout,
    showErrorModal() {}, getRandomValue: value => value, pad: value => value,
    formatTimeGap() {}, getLocalTimeInTimezone() {}, filterHistoryForAI: value => value,
    showToast() {}, writeOvoPngMetadata: value => value, readOvoPngMetadata() {}
};
vm.createContext(context);
vm.runInContext(read('js/core/novelai-compat.js'), context);
vm.runInContext(read('js/core/api-and-image-utils.js'), context);
const compat = context.window.NovelAiCompat;
let request;
context.fetch = async (url, init) => { request = { url, headers: init.headers, body: JSON.parse(init.body) }; return Response.json({ images: [{ image: png, seed: 17 }, { image: png, seed: 18 }] }); };
const generate = settings => context.generateNovelAiImage('cat Text: Hello', { authMode: 'none', model: 'nai-diffusion-5-full', generationMode: 'normal', ...settings });

for (let i = 0; i < 50; i++) assert.match(compat.headers({}, 'application/json')['x-correlation-id'], /^[A-Za-z0-9]{6}$/);
assert.equal(compat.headers({ extraHeaders: { 'X-Correlation-ID': 'Abc123', accept: 'application/json' } }, 'text/event-stream')['x-correlation-id'], 'Abc123');
assert.throws(() => compat.headers({ extraHeaders: { 'X-Correlation-ID': 'uuid-too-long' } }, ''), /6 位/);
assert.equal(compat.endpoint({ customUrlEnabled: true, customUrl: 'https://proxy.test/base?route=a', authMode: 'query', token: 'test', authQueryName: 'key' }, 'encode'), 'https://proxy.test/base/ai/encode-vibe?route=a&key=test');
assert.equal(compat.endpoint({ customUrlEnabled: true, customUrl: 'https://proxy.test/custom', endpointMode: 'full' }, 'stream'), 'https://proxy.test/custom');
assert.equal(compat.endpoint({ customUrlEnabled: true, customUrl: 'https://proxy.test/ai/generate-image?x=y' }, 'upscale'), 'https://proxy.test/ai/upscale?x=y');

let result = await generate({ qualityPresetId: 'light', ucPresetId: 'humanFocus', transparentBackground: true, smea: true, scale: 10, seed: 0, nSamples: 2 });
assert.equal(result.images.length, 2); assert.equal(result.seed, 17);
assert.equal(request.body.parameters.tag_hint_qt, 3); assert.equal(request.body.parameters.tag_hint_uc_preset, 4);
assert.match(request.body.parameters.negative_prompt, /mismatched pupils/);
assert.match(request.body.input, /amazing quality.*transparent background Text: Hello$/);
assert.equal(request.body.parameters.noise_schedule, 'karras'); assert.equal(request.body.parameters.seed, 0);
for (const key of ['ucPreset', 'qualityToggle', 'sm', 'sm_dyn', 'autoSmea']) assert.ok(!(key in request.body.parameters), key);
assert.match(result.correlationId, /^[A-Za-z0-9]{6}$/);
await generate({ qualityToggle: false, ucPreset: 3, negativePrompt: 'custom negative', transparentBackground: false });
assert.equal(request.body.input, 'cat Text: Hello'); assert.equal(request.body.parameters.negative_prompt, 'custom negative');
assert.equal(request.body.parameters.tag_hint_qt, 0); assert.equal(request.body.parameters.tag_hint_uc_preset, 0);
await assert.rejects(generate({ seed: -1 }), /Seed/);
await assert.rejects(generate({ seed: 4294967296 }), /Seed/);
await assert.rejects(generate({ scale: 11 }), /Guidance/);
await assert.rejects(generate({ model: 'nai-diffusion-4-5-full', qualityPresetId: 'light' }), /质量预设/);
await assert.rejects(generate({ model: 'nai-diffusion-3', ucPreset: 4 }), /V3/);
await generate({ model: 'nai-diffusion-3', ucPreset: 2, smea: true, noiseSchedule: 'native', qualityToggle: false });
assert.equal(request.body.parameters.ucPreset, 2); assert.equal(request.body.parameters.sm, true);
assert.equal(request.body.parameters.noise_schedule, 'native'); assert.ok(!('v4_prompt' in request.body.parameters));

const characters = [{ prompt: 'one', center: { x: 0.22, y: 0.84 } }, { prompt: 'disabled', enabled: false }];
await generate({ model: 'nai-diffusion-4-5-full', characterPrompts: characters, characterUseCoords: true });
assert.equal(request.body.parameters.characterPrompts.length, 1);
assert.equal(request.body.parameters.characterPrompts[0].center.x, 0.3);
assert.equal(request.body.parameters.characterPrompts[0].center.y, 0.9);
assert.equal(characters[0].center.x, 0.22);
await generate({ characterPrompts: characters }); assert.equal(request.body.parameters.characterPrompts[0].center.x, 0.22);
await assert.rejects(generate({ model: 'nai-diffusion-4-5-full', characterPrompts: Array.from({ length: 7 }, () => ({ prompt: 'role' })) }), /已有 7/);
await assert.rejects(generate({ characterPrompts: Array.from({ length: 23 }, () => ({ prompt: 'role' })) }), /已有 23/);

context.window.NovelAiVibe = {
    resolveForGeneration: async () => ({ images: [], strengths: [], information: [] }),
    resolvePreciseReferences: async () => ({ images: ['reference'], strengths: [0.8], fidelity: [0.75], descriptions: ['character'] })
};
await generate({ model: 'nai-diffusion-4-5-full' });
assert.equal(request.body.parameters.director_reference_secondary_strength_values[0], 0.25);
assert.ok(!('director_reference_images' in result.requestSnapshot.parameters));
delete context.window.NovelAiVibe;
const fitted = [];
compat.fitImage = async (...args) => { fitted.push(args); return 'fitted'; };
result = await generate({ model: 'nai-diffusion-4-5-full', action: 'infill', initImage: 'source', mask: 'mask', strength: 0.4, noise: 0.1 });
assert.equal(request.body.model, 'nai-diffusion-4-5-full-inpainting'); assert.equal(request.body.action, 'infill');
assert.equal(request.body.parameters.mask, 'fitted'); assert.equal(request.body.parameters.img2img.strength, 0.4);
assert.equal(fitted.at(-1)[3], 'black'); assert.ok(!('mask' in result.requestSnapshot.parameters)); assert.ok(!('image' in result.requestSnapshot.parameters));
await assert.rejects(generate({ model: 'nai-diffusion-5-curated', action: 'infill', initImage: 'source', mask: 'mask' }), /明确选择/);
await assert.rejects(generate({ action: 'img2img' }), /原图/);
await generate({ action: 'img2img', initImage: 'source', enhanceMax: true });
assert.equal(request.body.parameters.upscaled_enhance, true); assert.ok(!('sm' in request.body.parameters));
await assert.rejects(generate({ model: 'nai-diffusion-4-5-full', action: 'img2img', initImage: 'source', enhanceMax: true }), /Max Enhance/);

const sse = frames => new Response(new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(frames); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const frame = obj => `data: ${JSON.stringify(obj)}\r\n\r\n`;
let progress = 0;
result = await compat.readSSE(sse(frame({ event_type: 'intermediate', image: png, samp_ix: 0, step_ix: 2 }) + frame({ event_type: 'final', image: png, samp_ix: 1, seed: 22 }) + frame({ event_type: 'final', image: png, samp_ix: 0, seed: 21 })), () => progress++);
assert.equal(progress, 1); assert.equal(result.length, 2); assert.equal(result[0].seed, 21);
await assert.rejects(compat.readSSE(sse(frame({ event_type: 'intermediate', image: png }))), /未收到最终/);
await assert.rejects(compat.readSSE(sse(frame({ event_type: 'final', image: png }) + frame({ event_type: 'error', message: 'invalid' }))), /invalid/);
const abort = new AbortController(); const pending = compat.readSSE(new Response(new ReadableStream({ start() {} })), null, abort.signal); abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
const ndjson = new Response(JSON.stringify({ event_type: 'final', image: png }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
assert.equal((await compat.readSSE(ndjson)).length, 1);
context.fetch = async () => sse(frame({ event_type: 'final', image: png, seed: 32 }));
assert.equal((await generate({ generationMode: 'stream' })).seed, 32);

// Standard central-directory ZIP with compressed entries, preserving every sample.
const locals = [], central = []; let offset = 0;
for (const name of ['image_0.png', 'image_1.png']) {
    const body = deflateRawSync(Buffer.from(png, 'base64')), filename = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(body.length, 18); local.writeUInt16LE(filename.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(body.length, 20); cd.writeUInt16LE(filename.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(local, filename, body); central.push(cd, filename); offset += local.length + filename.length + body.length;
}
const zip = new Blob([...locals, ...central]);
assert.equal((await context._nai_extractPngFromZipBlob(zip, true)).length, 2);
assert.match(await context._nai_extractPngFromZipBlob(zip), /^data:image\/png;/);
context.fetch = async (url, init) => { request = { url, body: JSON.parse(init.body), headers: init.headers }; return Response.json({ images: [png] }); };
assert.equal((await compat.upscale(`data:image/png;base64,${png}`, { authMode: 'none' })).images.length, 1);
assert.equal(request.body.model, 'nai-diffusion-5-curated'); assert.equal(request.body.declared_blur_sigma, 0); assert.match(request.url, /\/ai\/upscale$/);
context.fetch = async () => new Response('invalid request', { status: 400 });
await assert.rejects(generate({}), /请求 ID：[A-Za-z0-9]{6}/);

// Protect unrelated providers and their settings/preset code from accidental edits.
assert.ok(read('js/data/defaults-and-state.js').includes("'novelAiStudioWorks'"));
const baselinePath = process.env.NAI_BEFORE;
if (baselinePath) {
    const oldSettings = fs.readFileSync(`${baselinePath}/js/settings/image-api-settings.js`, 'utf8');
    const settings = read('js/settings/image-api-settings.js');
    assert.equal(settings.slice(0, settings.indexOf('function setupNovelAiSettings()')), oldSettings.slice(0, oldSettings.indexOf('function setupNovelAiSettings()')));
    assert.equal(settings.slice(settings.indexOf('function setupAdditionalImageProviders()')), oldSettings.slice(oldSettings.indexOf('function setupAdditionalImageProviders()')));
    const oldApi = fs.readFileSync(`${baselinePath}/js/core/api-and-image-utils.js`, 'utf8');
    const api = read('js/core/api-and-image-utils.js');
    assert.equal(api.slice(api.indexOf('/** 使用 Google Gemini')), oldApi.slice(oldApi.indexOf('/** 使用 Google Gemini')));
}
console.log('NovelAI compatibility tests passed: headers, auth, presets, models, characters, references, image actions, SSE, ZIP, upscale and provider isolation.');

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/modules/novelai-vibe.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'js/core/api-and-image-utils.js'), 'utf8');
const databaseSource = fs.readFileSync(path.join(root, 'js/data/indexed-db.js'), 'utf8');
const backupSource = fs.readFileSync(path.join(root, 'js/modules/tutorial/backup-and-restore.js'), 'utf8');
const sandbox = { window: {}, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, DataView, Blob, Response, DecompressionStream, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'novelai-vibe.js' });

const vibe = sandbox.window.NovelAiVibe;
if (!vibe) throw new Error('NovelAiVibe global was not registered');
if (vibe.modelFamily('nai-diffusion-5-full') !== 'v5') throw new Error('V5 capability detection failed');
if (vibe.modelFamily('nai-diffusion-4-5-full') !== 'v4') throw new Error('V4.5 capability detection failed');
if (vibe.modelFamily('nai-diffusion-furry-3') !== 'v3') throw new Error('V3 capability detection failed');
if (vibe.supportsVibe('nai-diffusion-5-curated')) throw new Error('V5 must not advertise VIBE support');
if (!vibe.supportsVibe('nai-diffusion-4-full') || !vibe.supportsVibe('nai-diffusion-3')) throw new Error('Supported VIBE model detection failed');
if (vibe.SINGLE_IDENTIFIER !== 'novelai-vibe-transfer' || vibe.BUNDLE_IDENTIFIER !== 'novelai-vibe-transfer-bundle') {
    throw new Error('Native NovelAI VIBE identifiers are incorrect');
}
const pngChunk = (type, body) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    return Buffer.concat([length, typeBytes, body, Buffer.alloc(4)]);
};
const fakePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('tEXt', Buffer.concat([Buffer.from('NovelAI_Vibe_Encoding_Base64'), Buffer.from([0]), Buffer.from('ZW5jb2RlZA==')])),
    pngChunk('IEND', Buffer.alloc(0)),
]);
const parsedChunks = await vibe._test.pngTextChunks(fakePng.buffer.slice(fakePng.byteOffset, fakePng.byteOffset + fakePng.byteLength));
if (vibe._test.chunkValues(parsedChunks, 'NovelAI_Vibe_Encoding_Base64')[0] !== 'ZW5jb2RlZA==') {
    throw new Error('Official raw PNG VIBE encoding chunk was not recovered');
}
if (!apiSource.includes('reference_image_multiple') || !apiSource.includes('reference_information_extracted_multiple') || !apiSource.includes('reference_strength_multiple')) {
    throw new Error('NovelAI request builder is missing official VIBE arrays');
}
const mergeBody = apiSource.match(/function _imageMergePrompt[\s\S]*?\n}/)?.[0] || '';
if (mergeBody.includes('_imageGetAtmosphere(')) throw new Error('Legacy text atmosphere still modifies provider prompts');
if (!apiSource.includes('requestSnapshot') || !apiSource.includes('x-correlation-id')) throw new Error('Request diagnostics are incomplete');
if (!apiSource.includes('director_reference_images') || !apiSource.includes('director_reference_secondary_strength_values')) {
    throw new Error('V4.5 Precise Reference fields are incomplete');
}
for (const table of ['naiVibeAssets', 'naiVibeEncodings', 'naiVibeGroups']) {
    if (!databaseSource.includes(table) || !backupSource.includes(table)) throw new Error(`${table} is not covered by persistence and backup`);
}

console.log('NovelAI VIBE capability, native format, request fields, and legacy isolation tests passed.');

const requestBuilderSource = apiSource.slice(
    apiSource.indexOf('function _image_base64Kind'),
    apiSource.indexOf('/** 使用 Google Gemini'),
);
const sentBodies = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8S8AAAAASUVORK5CYII=';
const requestSandbox = {
    window: {
        NovelAiVibe: {
            modelFamily: vibe.modelFamily,
            resolveForGeneration: async model => model.includes('4')
                ? { images: ['ZW5jb2RlZA=='], information: [0.8], strengths: [0.6], groupName: 'test-vibe' }
                : { images: [], information: [], strengths: [], groupName: '' },
            resolvePreciseReferences: async () => ({ images: [], strengths: [], fidelity: [], descriptions: [] }),
        },
    },
    db: { novelAiSettings: {} },
    fetch: async (_url, init) => {
        sentBodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ image: png }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    crypto: webcrypto, console, Blob, Response, TextDecoder, Uint8Array, DataView, atob, btoa,
};
vm.createContext(requestSandbox);
vm.runInContext(requestBuilderSource, requestSandbox, { filename: 'novelai-request-builder.js' });
await requestSandbox.generateNovelAiImage('1girl', {
    authMode: 'none', model: 'nai-diffusion-4-5-full', resolution: '832x1216', sampler: 'k_dpmpp_2m',
    characterPrompts: [{ prompt: 'blue hair', uc: 'red hair', center: { x: 0.2, y: 0.4 } }], characterUseCoords: true,
});
const v4Body = sentBodies.at(-1);
if (v4Body.parameters.reference_image_multiple?.[0] !== 'ZW5jb2RlZA==' || v4Body.parameters.reference_strength_multiple?.[0] !== 0.6) {
    throw new Error('V4 encoded VIBE was not placed into the official arrays');
}
if (v4Body.parameters.reference_information_extracted_multiple) throw new Error('V4 encoded VIBE must not send V3 information extraction array');
if (v4Body.parameters.characterPrompts?.[0]?.prompt !== 'blue hair' || v4Body.parameters.v4_prompt?.caption?.char_captions?.length !== 1) {
    throw new Error('V4 multi-character prompt wire format is incomplete');
}
await requestSandbox.generateNovelAiImage('cat', { authMode: 'none', model: 'nai-diffusion-5-full', resolution: '1024x1024', imageFormat: 'webp' });
const v5Body = sentBodies.at(-1);
if (v5Body.parameters.params_version !== 4 || v5Body.parameters.image_format !== 'webp' || 'qualityToggle' in v5Body.parameters) {
    throw new Error('V5 parameter branching is incorrect');
}

console.log('NovelAI V3/V4/V5 request-shape tests passed.');

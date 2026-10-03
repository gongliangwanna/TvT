import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const context = {
    window: {}, db: {}, URL, crypto: webcrypto, Uint8Array, DataView, TextDecoder, Response, Blob, atob, btoa,
    showErrorModal() {}, getRandomValue() {}, pad() {}, formatTimeGap() {}, getLocalTimeInTimezone() {},
    filterHistoryForAI() {}, showToast() {}, showAppConfirmDialog() {}, writeOvoPngMetadata() {}, readOvoPngMetadata() {},
    console: { warn() {} },
    FileReader: class { readAsDataURL(blob) { blob.arrayBuffer().then(data => { this.result = `data:${blob.type};base64,${Buffer.from(data).toString('base64')}`; this.onloadend?.(); }); } }
};
vm.createContext(context);
vm.runInContext(read('js/core/novelai-compat.js'), context);
vm.runInContext(read('js/core/api-and-image-utils.js'), context);
const upscale = signal => context.window.NovelAiCompat.upscale('data:image/png;base64,iVBORw0KGgo=', { authMode: 'none' }, signal);
for (const data of [{ image: 'iVBORw0KGgo=' }, { data: [{ b64_json: 'iVBORw0KGgo=' }] }, { images: [{ base64: 'iVBORw0KGgo=' }, { image: 'iVBORw0KGgo=' }] }]) {
    context.fetch = async () => Response.json(data);
    assert.match((await upscale()).imageUrl, /^data:image\/png;base64,/);
}
let downloadCount = 0;
context.fetch = async url => {
    if (url.endsWith('/ai/upscale')) return Response.json({ images: ['https://images.test/original.png'] });
    downloadCount++;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });
};
assert.match((await upscale()).imageUrl, /^data:image\/png;base64,/);
assert.equal(downloadCount, 1);
context.fetch = async url => url.endsWith('/ai/upscale') ? Response.json({ image: 'https://images.test/original.png' }) : new Response('', { status: 403 });
assert.equal((await upscale()).imageUrl, 'https://images.test/original.png');
context.fetch = async url => { if (url.endsWith('/ai/upscale')) return Response.json({ image: 'https://images.test/original.png' }); throw new DOMException('cancelled', 'AbortError'); };
await assert.rejects(upscale(), { name: 'AbortError' });
console.log('NovelAI upscale proxy tests passed: JSON envelopes, multiple images, original persistence, download failure and cancellation.');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const normalize = body => body.toString().replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const sha = body => createHash('sha256').update(normalize(body)).digest('hex');
const generated = { self: {} };
vm.runInNewContext(read('sw-assets.js'), generated);
const generatedManifest = generated.self.__OVO_SW_MANIFEST;
for (const asset of generatedManifest.assets) {
    assert.equal(generatedManifest.integrity[asset], sha(fs.readFileSync(path.join(root, asset))), `outdated manifest: ${asset}`);
}
assert.equal(generatedManifest.version, createHash('sha256')
    .update(generatedManifest.assets.map(asset => `${asset}\0${normalize(read(asset))}`).join('\0'))
    .update(normalize(read('sw.js'))).digest('hex').slice(0, 16));

function release(version) {
    const files = { 'index.html': `<html>${version}</html>`, 'js/app.js': `app-${version}`,
        'css/app.css': `style-${version}\n`, 'js/vendor/tokenizer/dictionary.js': `dictionary-${version}` };
    return { files, manifest: { version: version.repeat(16), assets: Object.keys(files),
        integrity: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, sha(body)])) } };
}

function workerHarness(repo, { stores = new Map(), builtin = release('1') } = {}) {
    const scope = `https://example.test/${repo ? repo + '/' : ''}`;
    const handlers = new Map();
    let server = builtin;
    let broken = null;
    let stale = null;
    let paused = null;
    let calls = [];
    let notifications = 0;
    const cacheApi = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name);
            return {
                async match(key) { return store.get(typeof key === 'string' ? key : key.url)?.clone(); },
                async put(key, response) { store.set(typeof key === 'string' ? key : key.url, response.clone()); },
                async delete(key) { return store.delete(key); }
            };
        },
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); }
    };
    const sandbox = {
        URL, Request, Response, AbortController, Uint8Array, TextEncoder, setTimeout, clearTimeout,
        crypto: webcrypto, caches: cacheApi, console: { log() {}, warn() {} },
        clients: { async claim() {}, async matchAll() { return []; } },
        importScripts() { sandbox.self.__OVO_SW_MANIFEST = builtin.manifest; },
        self: { registration: { scope, async showNotification() { notifications++; } },
            location: new URL(scope), async skipWaiting() {},
            addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); } },
        async fetch(input, options = {}) {
            const url = new URL(typeof input === 'string' ? input : input.url);
            assert.equal(url.origin, 'https://example.test');
            assert.ok(url.pathname.startsWith(new URL(scope).pathname), 'must use current repository deployment path');
            const asset = url.pathname.slice(scope.length - url.origin.length);
            calls.push({ asset, cache: options.cache, url: url.href });
            if (asset === paused) await new Promise((resolve, reject) => {
                if (options.signal?.aborted) reject(new Error('aborted'));
                options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
            if (asset === broken) return new Response('unavailable', { status: 503 });
            if (asset === 'sw-assets.js') return new Response(`self.__OVO_SW_MANIFEST=${JSON.stringify(server.manifest)};`);
            const body = asset === stale ? '<html>redirect fallback</html>' : server.files[asset];
            return new Response(body || 'missing', { status: body ? 200 : 404 });
        }
    };
    vm.runInNewContext(read('sw.js'), sandbox, { filename: 'sw.js' });
    async function dispatch(type, extra = {}) {
        const pending = [];
        let response;
        const event = { waitUntil(promise) { pending.push(promise); }, respondWith(promise) { response = promise; }, ...extra };
        for (const fn of handlers.get(type) || []) fn(event);
        await Promise.all(pending);
        return response ? await response : undefined;
    }
    async function message(type, token = 'test', client = 'client-1') {
        const output = [];
        await dispatch('message', { data: { type, token }, source: { id: client, url: scope },
            ports: [{ postMessage(value) { output.push(value); } }] });
        return output;
    }
    const stateName = `ovo-app-state-${encodeURIComponent(scope)}`;
    const activeKey = new URL('__ovo_active_shell__', scope).href;
    return { scope, stores, calls, dispatch, message,
        set server(value) { server = value; }, set broken(value) { broken = value; },
        set stale(value) { stale = value; }, set paused(value) { paused = value; },
        async active() { return (await (await cacheApi.open(stateName)).match(activeKey)).json(); },
        async asset(name) { return dispatch('fetch', { request: { method: 'GET', url: new URL(name, scope).href, mode: 'cors' } }); },
        get notifications() { return notifications; }
    };
}

for (const repo of ['OVO', 'xinOVO', 'TUT', '']) {
    const h = workerHarness(repo);
    h.stores.set(`ovo-app-shell-${encodeURIComponent('https://example.test/Other/')}-existing`, new Map());
    await h.dispatch('install');
    await h.dispatch('activate');
    assert.ok([...h.stores.keys()].some(name => name.includes('Other')), 'other site cache must survive');
    assert.equal(h.calls.some(call => call.asset.includes('tokenizer')), false, 'dictionary stays lazy');
    assert.ok(h.calls.every(call => call.cache === 'no-store' && call.url.includes('ovo-update=')));
    const before = await h.active();
    h.server = release('2');
    const staged = await h.message('OVO_UPDATE_PREPARE', 'new-release');
    assert.equal(staged.at(-1).type, 'done');
    assert.equal(staged.filter(msg => msg.type === 'progress').at(-1).completed, 3);
    assert.equal((await h.active()).name, before.name, 'download alone must not change active cache');
    assert.equal(await (await h.asset('js/app.js')).text(), 'app-1');
    const nav = await h.dispatch('fetch', { request: { method: 'GET', url: h.scope, mode: 'navigate' } });
    assert.equal(await nav.text(), '<html>1</html>', 'new navigation must not mix with old scripts');
    assert.equal((await h.message('OVO_UPDATE_APPLY', 'new-release')).at(-1).type, 'done');
    assert.equal(await (await h.asset('js/app.js')).text(), 'app-2');
    assert.equal(h.stores.has(before.name), false, 'old own cache is removed after success');
    const dictionary = await h.asset('js/vendor/tokenizer/dictionary.js');
    assert.equal(await dictionary.text(), 'dictionary-2');
    assert.ok([...h.stores.keys()].some(name => name.includes('Other')));
}

const h = workerHarness('xinOVO');
await h.dispatch('install');
await h.dispatch('activate');
const original = await h.active();
h.broken = 'css/app.css';
assert.equal((await h.message('OVO_UPDATE_PREPARE', 'failed')).at(-1).type, 'error');
assert.equal((await h.active()).name, original.name);
assert.equal([...h.stores.keys()].some(name => name.endsWith('pull-failed')), false);
h.broken = null;
h.stale = 'js/app.js';
assert.match((await h.message('OVO_UPDATE_PREPARE', 'stale')).at(-1).message, /尚未同步/);
assert.equal((await h.active()).name, original.name);
h.stale = null;
const windowsRelease = release('1');
windowsRelease.files['css/app.css'] = 'style-1\r\n';
h.server = windowsRelease;
await h.message('OVO_UPDATE_PREPARE', 'same-version');
await h.message('OVO_UPDATE_APPLY', 'same-version');
assert.notEqual((await h.active()).name, original.name, 'same version must be re-downloadable');
await h.message('OVO_UPDATE_PREPARE', 'tab-a');
await h.message('OVO_UPDATE_PREPARE', 'tab-b');
assert.equal((await h.message('OVO_UPDATE_APPLY', 'tab-a')).at(-1).type, 'done');
assert.match((await h.message('OVO_UPDATE_APPLY', 'tab-b')).at(-1).message, /其他页面/);
await h.message('OVO_UPDATE_DISCARD', 'tab-b');
const valid = await h.active();
const installer = workerHarness('xinOVO', { stores: h.stores, builtin: release('3') });
installer.broken = 'css/app.css';
await assert.rejects(installer.dispatch('install'), /下载失败/);
assert.equal((await h.active()).name, valid.name, 'failed auto install must preserve current cache');
h.paused = 'js/app.js';
const cancelling = h.message('OVO_UPDATE_PREPARE', 'cancelled');
while (!h.calls.some(call => call.asset === 'js/app.js' && call.url.includes('cancelled'))) {
    await new Promise(resolve => setTimeout(resolve, 0));
}
assert.equal((await h.message('OVO_UPDATE_PREPARE', 'double-click')).at(-1).type, 'error');
await h.message('OVO_UPDATE_DISCARD', 'cancelled');
assert.equal((await cancelling).at(-1).type, 'error');
assert.equal((await h.active()).name, valid.name);
assert.equal([...h.stores.keys()].some(name => name.endsWith('pull-cancelled')), false);
await h.dispatch('message', { data: { type: 'SHOW_NOTIFICATION', payload: { title: 'existing notification' } } });
await h.dispatch('push', { data: { json() { return { title: 'existing push' }; } } });
assert.equal(h.notifications, 2, 'existing notification and push behavior must remain');

function pageHarness({ confirmed = true, generating = false, saved = true, failDownload = false, pauseDownload = false } = {}) {
    let reloads = 0;
    let saves = 0;
    const messages = [];
    const labels = { textContent: '拉取最新文件' };
    const elements = {
        'ovo-file-update-btn': { textContent: '', disabled: false, querySelector() { return labels; }, setAttribute() {} },
        'ovo-file-update-status': { textContent: '' },
        'custom-confirm-ok-btn': { textContent: '确定' }
    };
    class Channel {
        constructor() {
            this.port1 = { close() {} };
            this.port2 = { postMessage: data => queueMicrotask(() => this.port1.onmessage?.({ data })) };
        }
    }
    const worker = { postMessage(data, ports) {
        messages.push(data.type);
        if (data.type === 'OVO_UPDATE_PREPARE') {
            ports[0].postMessage({ type: 'progress', completed: 1, total: 2 });
            if (pauseDownload) return;
            ports[0].postMessage(failDownload ? { type: 'error', message: '下载失败' } : { type: 'done' });
        } else ports[0].postMessage({ type: 'done', protocol: 1 });
    } };
    const data = { characters: [{ id: 'c', history: ['user data'] }], groups: [], apiSettings: { secret: 'existing' } };
    const initial = structuredClone(data);
    const sandbox = {
        URL, AbortController, crypto: webcrypto, MessageChannel: Channel, setTimeout, clearTimeout,
        navigator: { serviceWorker: { async register(url, options) {
            assert.equal(url, 'https://example.test/TUT/sw.js');
            assert.equal(options.scope, 'https://example.test/TUT/');
            assert.equal(options.updateViaCache, 'none');
            return { active: worker, installing: null };
        } } },
        window: { isSecureContext: true }, location: { protocol: 'https:', reload() { reloads++; } },
        document: { currentScript: { src: 'https://example.test/TUT/js/modules/tutorial/file-update.js' },
            getElementById(id) { return elements[id] || null; } },
        db: data, isGenerating: generating, loadingBtn: false,
        async customConfirm(message) { assert.match(message, /备份/); return confirmed; },
        async saveData() { saves++; return saved; },
        characterSaveQueues: new Map(), groupSaveQueues: new Map()
    };
    vm.runInNewContext(read('js/modules/tutorial/file-update.js'), sandbox);
    return { api: sandbox.window.OVOFileUpdate, messages, elements, labels,
        get reloads() { return reloads; }, get saves() { return saves; },
        preserved() { assert.deepEqual(data, initial); } };
}

const success = pageHarness();
await success.api.run();
assert.equal(success.reloads, 1);
assert.equal(success.saves, 1);
assert.ok(success.messages.indexOf('OVO_UPDATE_PREPARE') < success.messages.indexOf('OVO_UPDATE_APPLY'));
assert.match(success.elements['ovo-file-update-status'].textContent, /拉取完成/);
assert.equal(success.labels.textContent, '拉取最新文件', 'modern label is restored without deleting its arrow');
success.preserved();
for (const options of [{ confirmed: false }, { generating: true }, { saved: false }, { failDownload: true }]) {
    const page = pageHarness(options);
    await page.api.run();
    assert.equal(page.reloads, 0);
    assert.equal(page.messages.includes('OVO_UPDATE_APPLY'), false);
    assert.equal(page.elements['ovo-file-update-btn'].disabled, false, 'retry stays available');
    page.preserved();
}
const cancel = pageHarness({ pauseDownload: true });
const pending = cancel.api.run();
while (!cancel.messages.includes('OVO_UPDATE_PREPARE')) await new Promise(resolve => setTimeout(resolve, 0));
await cancel.api.run();
await pending;
assert.equal(cancel.reloads, 0);
assert.ok(cancel.messages.includes('OVO_UPDATE_DISCARD'));
assert.match(cancel.elements['ovo-file-update-status'].textContent, /已取消/);
cancel.preserved();

// Exercise the real existing save queue: the new result must report failure without
// changing its coalescing behavior or introducing a database migration.
const dataSource = read('js/data/indexed-db.js');
const saveStart = dataSource.indexOf('let saveDataPromise = null;');
const saveEnd = dataSource.indexOf('/**', saveStart);
let writes = 0;
let shouldFail = false;
let releaseWrite;
const gate = new Promise(resolve => { releaseWrite = resolve; });
const table = { async bulkPut() { writes++; await gate; if (shouldFail) throw new Error('disk full'); } };
const saveSandbox = { navigator: {}, db: { characters: [], groups: [], worldBooks: [], myStickers: [] },
    dexieDB: { characters: table, groups: table, worldBooks: table, myStickers: table,
        globalSettings: { async put() {} } },
    globalSettingKeys: [], window: {}, console: { error() {} }, showToast() {} };
vm.createContext(saveSandbox);
vm.runInContext(dataSource.slice(saveStart, saveEnd) + '\nglobalThis.runSave = saveData;', saveSandbox);
const firstSave = saveSandbox.runSave();
const secondSave = saveSandbox.runSave();
releaseWrite();
assert.equal(await firstSave, true);
assert.equal(await secondSave, true);
assert.equal(writes, 8, 'two concurrent callers retain two ordered full-save passes');
shouldFail = true;
assert.equal(await saveSandbox.runSave(), false, 'disk failure stops the update');
shouldFail = false;
assert.equal(await saveSandbox.runSave(), true, 'save queue recovers after a failure');

const ui = normalize(read('js/modules/tutorial/content-and-data-tools.js'));
assert.ok(ui.includes("fileUpdateButton.addEventListener('click', () => window.OVOFileUpdate.run())"));
for (const parent of ['modernGroups.github', 'tutorialContentArea']) {
    assert.ok(ui.includes(`${parent}.appendChild(githubSection);\n        ${parent}.appendChild(fileUpdateSection);`), 'update must be directly under repository backup');
}
assert.ok(read('src/html/scripts.html').includes('js/modules/tutorial/file-update.js'));
assert.ok(read('css/modules/tutorial.css').includes('overflow-wrap: anywhere'));
console.log('File update tests passed: three deployment paths, atomic cache switching, integrity, weak network, cancellation, concurrency, save failure, backup reminder and existing notifications.');

/* Browser embeddings for already-pushed phone text, owned by the Tavern extension. */
export const PHONE_VECTOR_REASONS = Object.freeze({
    DISABLED: '未启用向量检索', NO_SOURCE: '没有可索引的手机来源', INVALID_CONFIG: '向量连接配置不完整或无效',
    KEY_REQUIRED: '尚未保存向量服务密钥', KEY_ENDPOINT_MISMATCH: '此接口未保存匹配的独立密钥',
    STATUS_ERROR: '无法核对向量服务和账号', NOT_READY: '向量索引尚未就绪，使用关键词',
    PARTIAL: '部分来源尚未完成向量索引', OK: '向量检索完成', TIMEOUT: '向量请求超时，使用关键词',
    CANCELLED: '向量请求已取消', STALE: '来源或生成已改变，丢弃向量结果', INVALID_RESPONSE: '向量响应无效，使用关键词',
    DIMENSION_MISMATCH: '向量维度改变，索引需要重建', NETWORK_ERROR: '向量服务请求失败，使用关键词',
    CACHE_MEMORY: '持久缓存不可用，本页暂用内存缓存', INDEXING: '正在增量建立向量索引',
    CONNECTION_OK: '向量连接测试成功', NO_CAPACITY: '向量请求仍在结束，使用关键词', SOURCE_TOO_LARGE: '部分手机原文过长，保留关键词检索',
    CAPACITY_LIMIT: '已索引容量内的最近手机原文，较早原文使用关键词检索',
    ACCOUNT_UNKNOWN: '无法确认当前酒馆账号，暂停向量请求', KEY_STORAGE_ERROR: '无法读取或保存当前账号的向量密钥',
    BROWSER_NETWORK_ERROR: '浏览器无法访问向量接口，请检查地址、网络和接口跨域设置',
    BROWSER_UPSTREAM_ERROR: '向量接口返回错误，请检查接口配置和服务状态',
    MODELS_OK: '已拉取可用的嵌入模型', MODELS_EMPTY: '接口未返回可识别的嵌入模型，可手动输入模型名称',
});

const MAX_ENTRIES = 512, MAX_BYTES = 16 * 1024 * 1024, MAX_TEXT = 16000, MAX_DIMENSIONS = 16384;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_LIST = 4096, MAX_MODEL_PAGES = 16;
const SPLIT_VERSION = 'phone-units-v1';
const fault = reason => Object.assign(new Error(reason), { reason });
const validBrowserKey = value => typeof value === 'string' && value.length <= 4096
    && !/[\u0000-\u001f\u007f-\u009f\u0100-\uffff]/.test(value);

function profileFrom(settings, allowDisabled = false) {
    if (!allowDisabled && !settings?.enabled) throw fault('DISABLED');
    const provider = settings.provider || 'openai';
    const model = typeof settings.model === 'string' ? settings.model.trim() : '';
    let url;
    try { url = new URL(String(settings.url || '').trim()); } catch { throw fault('INVALID_CONFIG'); }
    if (!['openai', 'ollama', 'gemini'].includes(provider) || !model || model.length > 256 || /[\r\n\0]/.test(model)
        || url.href.length > 2048
        || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fault('INVALID_CONFIG');
    const dimensions = settings.dimensions === '' || settings.dimensions == null ? 0 : settings.dimensions;
    if (!Number.isInteger(dimensions) || dimensions < 0 || dimensions > MAX_DIMENSIONS) throw fault('INVALID_CONFIG');
    const splitVersion = String(settings.splitVersion || SPLIT_VERSION);
    return { transport: 'browser', provider, url: browserEndpoint(provider, url.href, model), model, dimensions, splitVersion };
}

function browserEndpoint(provider, value, model = 'uwu-placeholder') {
    let endpoint;
    try { endpoint = new URL(String(value || '').trim()); } catch { throw fault('INVALID_CONFIG'); }
    if (!['openai', 'ollama', 'gemini'].includes(provider) || endpoint.href.length > 2048
        || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw fault('INVALID_CONFIG');
    let pathname = endpoint.pathname.replace(/\/+$/, '');
    if (provider === 'openai' && !/\/embeddings$/.test(pathname)) pathname += /\/v\d+$/.test(pathname) ? '/embeddings' : '/v1/embeddings';
    if (provider === 'ollama' && !/\/api\/embed$/.test(pathname)) pathname += /\/api$/.test(pathname) ? '/embed' : '/api/embed';
    if (provider === 'gemini') {
        const modelId = String(model).replace(/^models\//, '');
        if (!/^[A-Za-z0-9._-]+$/.test(modelId)) throw fault('INVALID_CONFIG');
        if (/\/models\/[^/]+:embedContent$/.test(pathname)) pathname = pathname.replace(/\/models\/[^/]+:embedContent$/, '');
        if (!/\/v\d+(?:beta\d*)?$/.test(pathname)) pathname += '/v1beta';
        pathname += '/models/' + encodeURIComponent(modelId) + ':embedContent';
    }
    endpoint.pathname = pathname;
    if (endpoint.href.length > 2048) throw fault('INVALID_CONFIG');
    return endpoint.href;
}

/** Credentials are tied to the provider and endpoint; changing only a Gemini model is safe. */
export function phoneBrowserCredentialProfile({ provider = 'openai', url } = {}) {
    const endpoint = new URL(browserEndpoint(provider, url));
    if (provider === 'gemini') endpoint.pathname = endpoint.pathname.replace(/\/models\/[^/]+:embedContent$/, '/models/:embedContent');
    return provider + ':' + endpoint.href;
}

// Discovery accepts a base URL, an embedding endpoint, or its model-list endpoint.
// Its credential identity remains that of the corresponding embedding endpoint.
function modelDiscoveryProfile(settings) {
    const provider = settings?.provider || 'openai';
    let address;
    try { address = new URL(String(settings?.url || '').trim()); } catch { throw fault('INVALID_CONFIG'); }
    if (!['openai', 'ollama', 'gemini'].includes(provider) || address.href.length > 2048
        || !['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw fault('INVALID_CONFIG');
    let path = address.pathname.replace(/\/+$/, '');
    if (provider === 'openai') path = path.replace(/\/models$/, '/embeddings');
    if (provider === 'ollama') path = path.replace(/\/api\/(?:tags|show)$/, '/api/embed');
    if (provider === 'gemini') path = path.replace(/\/models$/, '');
    address.pathname = path;
    const url = browserEndpoint(provider, address.href);
    if (url.length > 2048) throw fault('INVALID_CONFIG');
    const list = new URL(url);
    if (provider === 'openai') list.pathname = list.pathname.replace(/\/embeddings$/, '/models');
    if (provider === 'ollama') list.pathname = list.pathname.replace(/\/api\/embed$/, '/api/tags');
    if (provider === 'gemini') list.pathname = list.pathname.replace(/\/models\/[^/]+:embedContent$/, '/models');
    return { provider, url, listUrl: list.href };
}

function modelName(value, provider) {
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return '';
    const name = value.trim();
    if (provider === 'gemini' && !/^(?:models\/)?[A-Za-z0-9._-]+$/.test(name)) return '';
    return provider === 'gemini' ? name.replace(/^models\//, '') : name;
}

function embeddingName(name) {
    const id = name.toLowerCase();
    // Rerankers and image/audio/generation models also appear in compatible lists.
    if (/(?:rerank|cross[-_]?encoder|(?:^|[/_.:-])(?:chat|gpt|llama|whisper|tts|clip|siglip|image|audio|speech|video|vision|diffusion|completion|moderation)(?:$|[/_.:-]))/.test(id)) return false;
    return /(?:^|[/_.:-])(?:embed|embeddings?)(?:$|[/_.:-])/.test(id)
        || /(?:^|\/)(?:embeddinggemma|bge-(?:m3|(?:small|base|large)-(?:en|zh)(?:-v\d+(?:\.\d+)*|(?:$|[:._-]))|multilingual-gemma2)|all-minilm(?:-l\d+-v\d+)?|multilingual-e5-(?:small|base|large)|e5-(?:small|base|large)(?:-v\d+)?)(?:$|[:._-])/.test(id);
}

function compatibleEmbeddingModel(item, name) {
    if (!item || typeof item !== 'object' || /rerank|cross[-_]?encoder/i.test(name)) return false;
    const marker = value => typeof value === 'string'
        && /^(?:embeddings?|embed|embedContent|text-embedding|feature-extraction|(?:\/v\d+)?\/embeddings)$/i.test(value);
    const signals = ['capabilities', 'supportedGenerationMethods', 'supported_endpoints', 'endpoints']
        .filter(field => Object.hasOwn(item, field)).map(field => item[field]);
    const kinds = ['type', 'mode', 'task'].map(field => item[field]).filter(value => typeof value === 'string');
    if (kinds.some(value => /rerank|cross[-_]?encoder|image|audio|speech|vision|video|diffusion/i.test(value))) return false;
    const input = item.input_modalities || item.architecture?.input_modalities;
    if (Array.isArray(input) && input.length && !input.includes('text')) return false;
    if (signals.some(value => Array.isArray(value) && value.some(marker)) || kinds.some(marker)
        || item.capabilities?.embedding === true || item.capabilities?.embeddings === true) return true;
    // Explicit capability metadata is authoritative; names only fill missing metadata.
    if (signals.length || kinds.length) return false;
    return embeddingName(name);
}

async function browserJson(response, signal) {
    if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel?.().catch(() => {});
        throw fault('INVALID_RESPONSE');
    }
    const reader = response.body?.getReader?.();
    if (reader) {
        let bytes = 0;
        const chunks = [];
        try {
            while (true) {
                if (signal.aborted) throw fault('CANCELLED');
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > MAX_RESPONSE_BYTES) throw fault('INVALID_RESPONSE');
                chunks.push(part.value);
            }
            const contents = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { contents.set(chunk, offset); offset += chunk.byteLength; }
            try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)); } catch { throw fault('INVALID_RESPONSE'); }
        } finally { await reader.cancel().catch(() => {}); }
    }
    // Real fetch responses support streams; this path also supports injected transports.
    let contents;
    try { contents = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json()); }
    catch { throw fault('INVALID_RESPONSE'); }
    if (typeof contents !== 'string' || new TextEncoder().encode(contents).byteLength > MAX_RESPONSE_BYTES) throw fault('INVALID_RESPONSE');
    try { return JSON.parse(contents); } catch { throw fault('INVALID_RESPONSE'); }
}

/** No coercion: strings, NaN, Infinity, zero vectors and mixed dimensions are invalid. */
function vectorScale(vector) {
    if (!Array.isArray(vector) || !vector.length || vector.length > MAX_DIMENSIONS) throw fault('INVALID_RESPONSE');
    let scale = 0;
    // Iteration visits array holes too; .some/.map silently skip them.
    for (const value of vector) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw fault('INVALID_RESPONSE');
        scale = Math.max(scale, Math.abs(value));
    }
    if (!scale) throw fault('INVALID_RESPONSE');
    return scale;
}

export function validatePhoneVectors(vectors, count, dimensions = 0) {
    if (!Array.isArray(vectors) || vectors.length !== count || !Number.isInteger(count) || count <= 0
        || !Number.isInteger(dimensions) || dimensions < 0 || dimensions > MAX_DIMENSIONS) throw fault('INVALID_RESPONSE');
    let size = dimensions;
    const result = Array.from(vectors, vector => {
        vectorScale(vector);
        if (!size) size = vector.length;
        if (vector.length !== size) throw fault('DIMENSION_MISMATCH');
        return [...vector];
    });
    return result;
}

export function cosinePhoneVectors(left, right) {
    const leftScale = vectorScale(left), rightScale = vectorScale(right);
    if (left.length !== right.length) throw fault('DIMENSION_MISMATCH');
    // Scale before calculating the norm, so finite coordinates cannot overflow
    // it or lose their relative magnitudes through subnormal rounding.
    const a = Math.hypot(...left.map(value => value / leftScale)), b = Math.hypot(...right.map(value => value / rightScale));
    let score = 0;
    for (let i = 0; i < left.length; i++) score += (left[i] / leftScale / a) * (right[i] / rightScale / b);
    if (!Number.isFinite(score)) throw fault('INVALID_RESPONSE');
    return Math.max(-1, Math.min(1, score));
}

function hash(value) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < value.length; i++) { const n = value.charCodeAt(i); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return `${value.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

function cacheDeadline(operation) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(fault('CACHE_MEMORY')), 1500);
        Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}

/** Injectable cache contract: loadAll(), put(record), delete(key); all may return promises. */
export function createPhoneVectorMemoryCache() {
    const records = new Map();
    return { mode: 'memory', loadAll: async () => structuredClone([...records.values()]), put: async record => { records.set(record.key, structuredClone(record)); },
        delete: async key => { records.delete(key); } };
}

function indexedCache(indexedDB) {
    let opening;
    function open() {
        if (!opening) opening = new Promise((resolve, reject) => {
            if (!indexedDB?.open) { reject(fault('CACHE_MEMORY')); return; }
            const request = indexedDB.open('UWUPhoneVectorV1', 1);
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('vectors')) request.result.createObjectStore('vectors', { keyPath: 'key' }); };
            request.onsuccess = () => {
                const db = request.result, connection = opening;
                db.onversionchange = () => { db.close(); if (opening === connection) opening = null; };
                resolve(db);
            };
            request.onerror = () => reject(request.error || fault('CACHE_MEMORY'));
            request.onblocked = () => reject(fault('CACHE_MEMORY'));
        });
        return opening;
    }
    async function transact(mode, perform) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('vectors', mode), request = perform(tx.objectStore('vectors'));
            let value;
            request.onsuccess = () => { value = request.result; };
            tx.oncomplete = () => resolve(value);
            tx.onabort = tx.onerror = () => reject(tx.error || request.error || fault('CACHE_MEMORY'));
        });
    }
    return { mode: 'indexeddb', loadAll: () => transact('readonly', store => store.getAll()),
        put: record => transact('readwrite', store => store.put(record)), delete: key => transact('readwrite', store => store.delete(key)) };
}

function snapshotScan(scan) {
    if (!scan || typeof scan.chatId !== 'string' || !scan.chatId || !Array.isArray(scan.sources) || !Array.isArray(scan.units)) throw fault('NO_SOURCE');
    const sources = new Map(scan.sources.filter(source => source && typeof source.key === 'string' && source.key)
        .map(source => [source.key, source]));
    const units = [], idCounts = new Map(), sourceVersions = new Map(), sourceMessageIds = new Map(); let oversized = 0;
    for (const unit of scan.units) {
        if (!unit || typeof unit !== 'object') continue;
        const source = sources.get(unit.sourceKey);
        if (!source || typeof source.body !== 'string' || typeof unit.text !== 'string' || !unit.text.trim()
            || typeof unit.id !== 'string' || !unit.id || !Number.isInteger(unit.start) || !Number.isInteger(unit.end)
            || unit.start < 0 || unit.end > source.body.length || unit.end <= unit.start || source.body.slice(unit.start, unit.end) !== unit.text
            || unit.ref?.chatId !== scan.chatId || unit.ref.sourceKey !== source.key
            || unit.ref.blockFingerprint !== source.blockFingerprint
            || (unit.ref.start !== undefined && unit.ref.start !== unit.start)
            || (unit.ref.end !== undefined && unit.ref.end !== unit.end)
            || (unit.ref.floor !== undefined && unit.ref.floor !== source.floor)
            || (unit.ref.textFingerprint !== undefined && unit.ref.textFingerprint !== hash(unit.text))) continue;
        if (!sourceMessageIds.has(source)) sourceMessageIds.set(source, Array.isArray(source.msgIds) ? new Set(source.msgIds) : null);
        const messageIds = sourceMessageIds.get(source);
        if (unit.ref.msgIds !== undefined && (!Array.isArray(unit.ref.msgIds)
            || Array.from(unit.ref.msgIds).some(id => id == null || !messageIds?.has(id)
                || (Array.isArray(unit.msgIds) && !unit.msgIds.includes(id))))) continue;
        idCounts.set(unit.id, (idCounts.get(unit.id) || 0) + 1);
        if (unit.text.length > MAX_TEXT) { oversized++; continue; }
        if (!sourceVersions.has(source)) {
            const sourceText = typeof source.block?.text === 'string' ? source.block.text : source.body;
            const version = JSON.stringify({ text: sourceText, body: source.body, floor: source.floor,
                summary: !!source.summary, msgIds: source.msgIds || [] });
            sourceVersions.set(source, { version, fingerprint: hash(version) });
        }
        // Every segment in a pushed floor has the same exact source version.
        // Retain one shared string instead of serializing the whole floor for each segment.
        const sourceVersion = sourceVersions.get(source);
        units.push({ id: unit.id, text: unit.text, sourceVersion: sourceVersion.version,
            sourceFingerprint: sourceVersion.fingerprint, start: unit.start, end: unit.end });
    }
    const uniqueUnits = units.filter(unit => idCounts.get(unit.id) === 1);
    return { chatId: scan.chatId, units: uniqueUnits, oversized };
}

/**
 * The scheduler retains a slot until the actual fetch settles, even if timeout/abort
 * already returned to the caller. A server that ignores abort cannot flood requests.
 */
export function createPhoneVectorService({ getSettings = () => ({}), fetch = globalThis.fetch?.bind(globalThis),
    indexedDB = globalThis.indexedDB, cache, onStatus = () => {},
    getScope = () => '', getBrowserCredential = () => ({ key: '', credentialProfile: '' }), saveBrowserCredential } = {}) {
    let epoch = 0, statusVersion = 0, statusRequest = 0, lastStatusApplied = 0, scope = '', available = false, hasKey = false, browserKeyProfile = '';
    let cacheMode = cache?.mode || 'indexeddb', cacheWarning = '', loaded, syncing = null, pendingSync = null, active = 0, indexActive = false, reason = 'DISABLED';
    let currentProfile = '', currentChat = '', currentTotal = 0, currentContext, currentSnapshot, previewOrder = 0;
    let recordsRevision = 0, removalRevision = 0, cachedCount = null;
    let persistenceTail = Promise.resolve();
    const records = new Map(), recordsByUnit = new Map(), discardedRecords = new Map(), controllers = new Set(), operationControllers = new Set(), queue = [];
    const persistence = cache || indexedCache(indexedDB);

    const recordUnitKey = record => JSON.stringify([record.scope, record.profile, record.chatId, record.id]);
    function forgetRecord(key) {
        const record = records.get(key);
        if (!record) return;
        records.delete(key);
        recordsRevision++; removalRevision++;
        const unitKey = recordUnitKey(record), bucket = recordsByUnit.get(unitKey);
        bucket?.delete(record);
        if (!bucket?.size) recordsByUnit.delete(unitKey);
    }
    function rememberRecord(record) {
        forgetRecord(record.key);
        records.set(record.key, record);
        recordsRevision++;
        const unitKey = recordUnitKey(record);
        if (!recordsByUnit.has(unitKey)) recordsByUnit.set(unitKey, new Set());
        recordsByUnit.get(unitKey).add(record);
    }

    function browserScope() {
        let value;
        try { value = getScope(); } catch { throw fault('ACCOUNT_UNKNOWN'); }
        if (typeof value !== 'string' || !value.trim() || value.length > 512) throw fault('ACCOUNT_UNKNOWN');
        return value;
    }
    async function browserCredential(ctx, signal = ctx.signal) {
        if (signal?.aborted) throw fault('CANCELLED');
        assertCurrent(ctx, false);
        let value;
        // Pass the scheduler's actual signal, including its local timeout, so an
        // abort-aware storage adapter can finish and release the occupied slot.
        try { value = await getBrowserCredential({ scope: ctx.account, signal }); }
        catch { throw fault(signal?.aborted ? 'CANCELLED' : 'KEY_STORAGE_ERROR'); }
        if (signal?.aborted) throw fault('CANCELLED');
        assertCurrent(ctx, false);
        if (value == null) return { key: '', credentialProfile: '' };
        if (!validBrowserKey(value.key) || typeof value.credentialProfile !== 'string'
            || value.credentialProfile.length > 2304) throw fault('KEY_STORAGE_ERROR');
        return { key: value.key.trim(), credentialProfile: value.credentialProfile };
    }
    function liveBrowserAccount(ctx) {
        if (!ctx) return false;
        try { return ctx.account === browserScope(); } catch { return false; }
    }
    function browserRevisionCurrent(ctx) {
        // A newly captured account can adopt its first discovery. An earlier known
        // account cannot resume after A -> B -> A, even when the name matches again.
        return ctx.mode === 'status' || ctx.statusVersion === statusVersion
            || (ctx.statusVersion + 1 === statusVersion && ctx.initialScope !== ctx.account && scope === ctx.account);
    }
    function state() {
        let cached = 0;
        // Account checks remain live even when the exact snapshot's count is reusable.
        if (currentContext?.scope === scope && currentSnapshot && liveBrowserAccount(currentContext)) {
            if (!cachedCount || cachedCount.context !== currentContext || cachedCount.snapshot !== currentSnapshot
                || cachedCount.revision !== recordsRevision) {
                let count = 0;
                for (const unit of currentSnapshot.units) if (cachedRecord(currentContext, currentSnapshot, unit)) count++;
                cachedCount = { context: currentContext, snapshot: currentSnapshot, revision: recordsRevision, count };
            }
            cached = cachedCount.count;
        }
        return { available, scope, hasKey, status: reason, reason, cached, total: currentTotal, active, cacheMode, cacheWarning, profile: currentProfile };
    }
    function ownsPreview(ctx) {
        return ctx?.previewOrder == null || ctx.previewOrder === previewOrder;
    }
    function report(next, ctx) {
        // The latest submitted request owns failures before it has prepared a
        // snapshot as well. A late worker cannot take back that newer preview.
        if (!ownsPreview(ctx)) return;
        reason = next; try { onStatus(state()); } catch { /* UI cannot break retrieval. */ }
    }
    function context({ isCurrent = () => true, signal } = {}, mode = '') {
        // Maintenance must work while disabled or incompletely configured, but it
        // still belongs to the captured account revision. Only a status read may
        // follow a later discovery without reviving a destructive old operation.
        const raw = getSettings(), p = mode === 'status' || mode === 'maintenance' ? null : profileFrom(raw, mode === 'test');
        const account = browserScope();
        return { epoch, mode, profile: p ? JSON.stringify(p) : JSON.stringify(raw), config: p,
            account, allowAnonymous: raw?.allowAnonymous === true, isCurrent, signal,
            scope: account, initialScope: scope, statusVersion, descriptors: new WeakMap(),
            previewOrder: mode === '' ? ++previewOrder : null };
    }
    function modelsContext(options) {
        const raw = getSettings(), draft = { ...raw, ...options }, account = browserScope();
        return { epoch, mode: 'models', config: modelDiscoveryProfile(draft),
            profile: JSON.stringify(raw), account, scope: account, initialScope: scope, statusVersion,
            allowAnonymous: draft.allowAnonymous === true, signal: options.signal,
            isCurrent: typeof options.isCurrent === 'function' ? options.isCurrent : () => true };
    }
    function valid(ctx, requireScope = true) {
        if (ctx.epoch !== epoch || ctx.signal?.aborted) return false;
        try {
            if (ctx.mode === 'models') return JSON.stringify(getSettings()) === ctx.profile
                && liveBrowserAccount(ctx) && browserRevisionCurrent(ctx) && ctx.isCurrent() !== false;
            const actual = ctx.mode === 'status' || ctx.mode === 'maintenance' ? JSON.stringify(getSettings()) : JSON.stringify(profileFrom(getSettings(), ctx.mode === 'test'));
            return actual === ctx.profile && (getSettings()?.allowAnonymous === true) === ctx.allowAnonymous
                && liveBrowserAccount(ctx)
                && browserRevisionCurrent(ctx)
                && (!requireScope || (ctx.scope === scope && ctx.statusVersion === statusVersion)) && ctx.isCurrent() !== false;
        }
        catch { return false; }
    }
    function assertCurrent(ctx, requireScope = true) {
        if (valid(ctx, requireScope)) return;
        if (ctx.signal?.aborted) throw fault('CANCELLED');
        browserScope();
        throw fault('STALE');
    }
    function pump() {
        queue.sort((a, b) => b.priority - a.priority);
        while (active < 2 && queue.length) {
            const position = queue.findIndex(task => !task.finished && (!task.indexing || !indexActive));
            if (position < 0) break;
            const task = queue.splice(position, 1)[0];
            task.started = true;
            active++;
            if (task.indexing) indexActive = true;
            task.run().finally(() => { active--; if (task.indexing) indexActive = false; pump(); });
        }
    }
    function schedule(perform, { timeoutMs = 3000, signal, priority = 10, fallback = 'NETWORK_ERROR' } = {}) {
        return new Promise((resolve, reject) => {
            const controller = new AbortController(); controllers.add(controller);
            const task = { priority, indexing: priority === 0, finished: false };
            let timer;
            const finish = (error, value) => {
                if (task.finished) return;
                task.finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
                if (!task.started) {
                    const position = queue.indexOf(task);
                    if (position >= 0) queue.splice(position, 1);
                    controllers.delete(controller);
                }
                if (error) reject(error); else resolve(value);
            };
            const abort = () => { finish(fault('CANCELLED')); controller.abort(); };
            controller.signal.addEventListener('abort', () => finish(fault('CANCELLED')), { once: true });
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => { finish(fault('TIMEOUT')); controller.abort(); }, Math.max(1, timeoutMs));
            task.run = async () => {
                try {
                    if (controller.signal.aborted) throw fault('CANCELLED');
                    finish(null, await perform(controller.signal));
                } catch (error) { finish(Object.hasOwn(PHONE_VECTOR_REASONS, error?.reason) ? fault(error.reason)
                    : fault(controller.signal.aborted ? 'CANCELLED' : fallback)); }
                finally { controllers.delete(controller); }
            };
            if (signal?.aborted) { abort(); controllers.delete(controller); return; }
            queue.push(task); pump();
        });
    }
    function cancel() {
        epoch++;
        if (pendingSync) { pendingSync.resolve({ ok: false, ...state(), reason: 'CANCELLED' }); pendingSync = null; }
        for (const controller of operationControllers) controller.abort();
        for (const controller of controllers) controller.abort();
        // Aborting fetch is distinct from resolving its caller: active slots remain occupied.
        for (const task of queue.splice(0)) { task.run(); }
    }
    async function persistent(method, value) {
        if (cacheWarning && method !== 'delete') return;
        // Cache adapters may retain or mutate the value handed to them. The
        // verified page index must never share that outgoing record or vector.
        const payload = method === 'put' ? structuredClone(value) : value;
        // A timed-out write may still commit. Keep later removals ordered behind
        // it, including after the page has fallen back to its memory cache.
        const operation = persistenceTail.then(() => persistence[method](payload));
        persistenceTail = operation.catch(() => {});
        if (cacheWarning) return;
        try { await cacheDeadline(() => operation); }
        catch { cacheMode = 'memory'; cacheWarning = 'CACHE_MEMORY'; report(reason); }
    }
    async function ensureLoaded() {
        if (!loaded) loaded = (async () => {
            try {
                const list = await cacheDeadline(() => persistence.loadAll());
                const observedDimensions = new Map();
                for (const record of Array.isArray(list) ? list : []) {
                    // Invalid vectors still occupy the durable cache. Remember only
                    // their ownership so an explicit scoped clear can remove them.
                    if (record && typeof record.key === 'string' && typeof record.scope === 'string' && typeof record.chatId === 'string') {
                        discardedRecords.set(record.key, { key: record.key, scope: record.scope, chatId: record.chatId });
                    }
                    if (!record || typeof record.key !== 'string' || typeof record.scope !== 'string' || typeof record.profile !== 'string'
                        || typeof record.chatId !== 'string' || typeof record.id !== 'string' || typeof record.text !== 'string'
                        || typeof record.sourceVersion !== 'string' || record.text.length > MAX_TEXT) continue;
                    try {
                        const dimensions = JSON.parse(record.profile)?.dimensions;
                        if (!Number.isInteger(dimensions) || dimensions < 0 || dimensions > MAX_DIMENSIONS) continue;
                        const [vector] = validatePhoneVectors([record.vector], 1, dimensions);
                        const cohort = JSON.stringify([record.scope, record.profile]);
                        if (observedDimensions.has(cohort) && observedDimensions.get(cohort) !== vector.length) continue;
                        observedDimensions.set(cohort, vector.length);
                        // The cache adapter may return live record objects. Keep
                        // the validated index independent of later cache edits.
                        const used = typeof record.used === 'number' && Number.isFinite(record.used) && record.used >= 0 ? record.used : 0;
                        rememberRecord({ ...record, vector, used });
                        discardedRecords.delete(record.key);
                    } catch { /* corrupt index is rebuildable */ }
                }
            } catch { cacheMode = 'memory'; cacheWarning = 'CACHE_MEMORY'; report(reason); }
            await prune();
        })();
        return loaded;
    }
    function bytes(record) { return 2 * (record.key.length + record.profile.length + record.text.length + record.sourceVersion.length) + record.vector.length * 8 + 256; }
    async function remove(predicate, ctx) {
        if (ctx) assertCurrent(ctx);
        const selected = [...records].filter(([, record]) => predicate(record));
        for (const [key, record] of selected) {
            // A transaction already in flight may finish after cancellation, but
            // the abandoned worker must not start another cache deletion.
            if (ctx) assertCurrent(ctx);
            if (records.get(key) !== record) continue;
            forgetRecord(key); await persistent('delete', key);
            if (ctx) assertCurrent(ctx);
        }
    }
    async function prune(protectedKeys = new Set(), ctx) {
        if (ctx) assertCurrent(ctx);
        let size = [...records.values()].reduce((n, record) => n + bytes(record), 0);
        const ordered = [...records.values()].sort((a, b) => Number(protectedKeys.has(a.key)) - Number(protectedKeys.has(b.key)) || (a.used || 0) - (b.used || 0));
        for (const record of ordered) {
            if (ctx) assertCurrent(ctx);
            if (records.size <= MAX_ENTRIES && size <= MAX_BYTES) break;
            forgetRecord(record.key); size -= bytes(record); await persistent('delete', record.key);
            if (ctx) assertCurrent(ctx);
        }
    }
    function identity(ctx, snapshot, unit) {
        if (ctx.descriptors.has(unit)) return ctx.descriptors.get(unit);
        const descriptor = { scope: ctx.scope, profile: ctx.profile, chatId: snapshot.chatId, id: unit.id, text: unit.text, sourceVersion: unit.sourceVersion };
        // Hash the shared source once in snapshotScan. The complete version remains
        // on the record and is compared below, so a hash collision cannot reuse text.
        const key = 'v2:' + hash(JSON.stringify([ctx.scope, ctx.profile, snapshot.chatId, unit.id, unit.text, unit.sourceFingerprint]));
        const result = { ...descriptor, key };
        ctx.descriptors.set(unit, result); return result;
    }
    function cachedRecord(ctx, snapshot, unit) {
        const wanted = identity(ctx, snapshot, unit), record = records.get(wanted.key);
        const matches = candidate => candidate && candidate.scope === wanted.scope && candidate.profile === wanted.profile
            && candidate.chatId === wanted.chatId && candidate.id === wanted.id && candidate.text === wanted.text
            && candidate.sourceVersion === wanted.sourceVersion;
        if (matches(record)) return record;
        // Old cache keys hashed the full source for every segment. Reuse their
        // exact records through a bounded identity lookup instead of re-embedding.
        for (const candidate of recordsByUnit.get(recordUnitKey(wanted)) || []) if (matches(candidate)) return candidate;
        return null;
    }
    async function refresh(ctx, timeoutMs = 3000) {
        assertCurrent(ctx, false);
        const accountChangedSinceCapture = () => ctx.mode !== 'status' && ctx.statusVersion !== statusVersion
            && !(ctx.statusVersion + 1 === statusVersion && ctx.initialScope !== ctx.account && scope === ctx.account);
        if (accountChangedSinceCapture()) throw fault('STALE');
        const sequence = ++statusRequest;
        const saved = await schedule(signal => browserCredential(ctx, signal), { timeoutMs, signal: ctx.signal, priority: 20, fallback: 'KEY_STORAGE_ERROR' });
        assertCurrent(ctx, false);
        if (accountChangedSinceCapture()) throw fault('STALE');
        if (sequence < lastStatusApplied && scope !== ctx.account) throw fault('STALE');
        if (sequence >= lastStatusApplied) {
            lastStatusApplied = sequence;
            if (scope !== ctx.account) { statusVersion++; scope = ctx.account; }
            available = true; hasKey = Boolean(saved.key); browserKeyProfile = saved.credentialProfile;
        }
        ctx.scope = ctx.account; ctx.statusVersion = statusVersion;
        return { available: true, scope, hasKey, credentialProfile: browserKeyProfile };
    }
    async function prepare(scan, options, timeoutMs = 3000, suppliedContext, suppliedSnapshot) {
        const ctx = suppliedContext || context(options), snapshot = suppliedSnapshot || snapshotScan(scan);
        if (!snapshot.units.length) throw fault(snapshot.oversized ? 'SOURCE_TOO_LARGE' : 'NO_SOURCE');
        await refresh(ctx, timeoutMs);
        if (!hasKey && (!ctx.allowAnonymous || ctx.config.provider === 'gemini')) throw fault('KEY_REQUIRED');
        await ensureLoaded(); assertCurrent(ctx);
        if (ownsPreview(ctx)) {
            currentProfile = ctx.profile; currentChat = snapshot.chatId; currentTotal = snapshot.units.length + snapshot.oversized;
            currentContext = ctx; currentSnapshot = snapshot;
        }
        return { ctx, snapshot };
    }
    async function embed(ctx, texts, timeoutMs, priority = 10) {
        assertCurrent(ctx);
        return schedule(async signal => {
            assertCurrent(ctx);
            if (!Array.isArray(texts) || !texts.length || texts.length > 16
                || texts.some(text => typeof text !== 'string' || !text.trim())
                || texts.reduce((total, text) => total + text.length, 0) > 32000) throw fault('INVALID_CONFIG');
            const saved = await browserCredential(ctx, signal);
            assertCurrent(ctx);
            const profileMatches = saved.credentialProfile === phoneBrowserCredentialProfile(ctx.config);
            const key = profileMatches ? saved.key : '';
            if (saved.key && !profileMatches && (!ctx.allowAnonymous || ctx.config.provider === 'gemini')) throw fault('KEY_ENDPOINT_MISMATCH');
            if (!key && (!ctx.allowAnonymous || ctx.config.provider === 'gemini')) throw fault('KEY_REQUIRED');
            const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
            if (key) headers[ctx.config.provider === 'gemini' ? 'x-goog-api-key' : 'Authorization'] = ctx.config.provider === 'gemini' ? key : 'Bearer ' + key;
            async function call(payload) {
                assertCurrent(ctx);
                if (signal.aborted) throw fault('CANCELLED');
                let response;
                try {
                    response = await fetch(ctx.config.url, { method: 'POST', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
                        headers, body: JSON.stringify(payload), signal, redirect: 'error' });
                } catch { throw fault(signal.aborted ? 'CANCELLED' : 'BROWSER_NETWORK_ERROR'); }
                assertCurrent(ctx);
                if (!response?.ok) {
                    // Provider error bodies may contain credentials, URLs or echoed inputs.
                    await response?.body?.cancel?.().catch(() => {});
                    throw fault(response?.status === 401 || response?.status === 403 ? 'KEY_REQUIRED' : 'BROWSER_UPSTREAM_ERROR');
                }
                const data = await browserJson(response, signal);
                assertCurrent(ctx);
                if (signal.aborted) throw fault('CANCELLED');
                return data;
            }
            if (ctx.config.provider === 'openai') {
                const payload = { model: ctx.config.model, input: texts, encoding_format: 'float',
                    ...(ctx.config.dimensions ? { dimensions: ctx.config.dimensions } : {}) };
                const data = await call(payload);
                if (!Array.isArray(data?.data) || data.data.length !== texts.length) throw fault('INVALID_RESPONSE');
                const vectors = new Array(texts.length), seen = new Set();
                for (const item of data.data) {
                    if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= texts.length || seen.has(item.index)) throw fault('INVALID_RESPONSE');
                    seen.add(item.index); vectors[item.index] = item.embedding;
                }
                return validatePhoneVectors(vectors, texts.length, ctx.config.dimensions);
            }
            if (ctx.config.provider === 'ollama') {
                const data = await call({ model: ctx.config.model, input: texts, truncate: false });
                return validatePhoneVectors(data?.embeddings, texts.length, ctx.config.dimensions);
            }
            const vectors = [];
            for (const text of texts) {
                const data = await call({ model: ctx.config.model.startsWith('models/') ? ctx.config.model : 'models/' + ctx.config.model,
                    content: { parts: [{ text }] }, ...(ctx.config.dimensions ? { outputDimensionality: ctx.config.dimensions } : {}) });
                vectors.push(data?.embedding?.values);
            }
            return validatePhoneVectors(vectors, texts.length, ctx.config.dimensions);
        }, { timeoutMs, signal: ctx.signal, priority, fallback: 'BROWSER_NETWORK_ERROR' });
    }
    function handle(error, ctx) {
        const next = Object.hasOwn(PHONE_VECTOR_REASONS, error?.reason) ? error.reason : 'NETWORK_ERROR';
        if (!ctx || valid(ctx, false)) {
            if (next === 'STATUS_ERROR' || next === 'ACCOUNT_UNKNOWN') available = false;
            if (next === 'ACCOUNT_UNKNOWN') { hasKey = false; if (scope) { statusVersion++; scope = ''; } }
            report(next, ctx);
        }
        return { candidates: [], reason: next };
    }
    async function refreshStatus() {
        let ctx;
        try {
            ctx = context({}, 'status'); const status = await refresh(ctx);
            let mismatch = false;
            const settings = getSettings(), needsKey = !ctx.allowAnonymous || settings?.provider === 'gemini';
            if (hasKey && typeof settings?.url === 'string' && settings.url.trim()) {
                // Status remains readable before an address is configured. Reading it
                // never clears an existing credential or sends it to a changed endpoint.
                try { mismatch = status.credentialProfile !== phoneBrowserCredentialProfile(settings); } catch { /* connection test validates the address */ }
            }
            report(mismatch && needsKey ? 'KEY_ENDPOINT_MISMATCH' : hasKey || !needsKey ? 'NOT_READY' : 'KEY_REQUIRED');
        }
        catch (error) { handle(error, ctx); }
        return state();
    }
    async function saveKey(key, { clear = false } = {}) {
        cancel();
        let ctx;
        try {
            ctx = context({}, 'maintenance'); await refresh(ctx);
            if (!clear && (!validBrowserKey(key) || !key.trim())) throw fault('INVALID_CONFIG');
            const credentialProfile = clear ? '' : phoneBrowserCredentialProfile(getSettings());
            await schedule(async signal => {
                assertCurrent(ctx);
                if (typeof saveBrowserCredential !== 'function') throw fault('KEY_STORAGE_ERROR');
                try { await saveBrowserCredential({ scope: ctx.account, key: clear ? '' : key.trim(), credentialProfile, clear, signal }); }
                catch { throw fault('KEY_STORAGE_ERROR'); }
                assertCurrent(ctx);
            }, { timeoutMs: 5000, signal: ctx.signal, priority: 20, fallback: 'KEY_STORAGE_ERROR' });
            assertCurrent(ctx);
            await refresh(ctx); report(hasKey || (ctx.allowAnonymous && getSettings()?.provider !== 'gemini') ? 'NOT_READY' : 'KEY_REQUIRED');
            return { ok: true, ...state() };
        } catch (error) { const failure = handle(error, ctx); return { ok: false, ...state(), reason: failure.reason }; }
    }
    async function testConnection() {
        let ctx;
        try {
            ctx = context({}, 'test'); await refresh(ctx);
            if (!hasKey && (!ctx.allowAnonymous || ctx.config.provider === 'gemini')) throw fault('KEY_REQUIRED');
            const vectors = await embed(ctx, ['手机剧情记忆连接测试'], 10000, 20);
            assertCurrent(ctx); report('CONNECTION_OK'); return { ok: true, dimensions: vectors[0].length, ...state() };
        } catch (error) { const failure = handle(error, ctx); return { ok: false, ...state(), reason: failure.reason }; }
    }
    /** Read-only discovery: accepts unsaved UI values and never writes a key or index. */
    async function fetchModels(options = {}) {
        try {
            const ctx = modelsContext(options);
            if (options.key != null && !validBrowserKey(options.key)) throw fault('INVALID_CONFIG');
            const draftKey = typeof options.key === 'string' ? options.key.trim() : '';
            const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(20000, options.timeoutMs)) : 15000;
            const models = await schedule(async signal => {
                const check = () => { assertCurrent(ctx, false); if (signal.aborted) throw fault('CANCELLED'); };
                check();
                let key = draftKey;
                if (!key) {
                    const saved = await browserCredential(ctx, signal);
                    check();
                    const matches = saved.credentialProfile === phoneBrowserCredentialProfile(ctx.config);
                    key = matches ? saved.key : '';
                    if (saved.key && !matches && (!ctx.allowAnonymous || ctx.config.provider === 'gemini')) throw fault('KEY_ENDPOINT_MISMATCH');
                }
                if (!key && (!ctx.allowAnonymous || ctx.config.provider === 'gemini')) throw fault('KEY_REQUIRED');
                const headers = { Accept: 'application/json' };
                if (key) headers[ctx.config.provider === 'gemini' ? 'x-goog-api-key' : 'Authorization'] = ctx.config.provider === 'gemini' ? key : 'Bearer ' + key;
                async function call(url, body) {
                    check();
                    let response;
                    try {
                        response = await fetch(url, { method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit',
                            referrerPolicy: 'no-referrer', headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
                            ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error' });
                    } catch { throw fault(signal.aborted ? 'CANCELLED' : 'BROWSER_NETWORK_ERROR'); }
                    check();
                    if (!response?.ok) {
                        // Do not read provider errors: they can echo keys or request URLs.
                        await response?.body?.cancel?.().catch(() => {});
                        throw fault(response?.status === 401 || response?.status === 403 ? 'KEY_REQUIRED' : 'BROWSER_UPSTREAM_ERROR');
                    }
                    const data = await browserJson(response, signal);
                    check();
                    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fault('INVALID_RESPONSE');
                    return data;
                }
                const found = new Set();
                if (ctx.config.provider === 'openai') {
                    const data = await call(ctx.config.listUrl);
                    if (!Array.isArray(data.data) || data.data.length > MAX_MODEL_LIST) throw fault('INVALID_RESPONSE');
                    for (const item of data.data) {
                        const name = modelName(item?.id, 'openai');
                        if (name && compatibleEmbeddingModel(item, name)) found.add(name);
                    }
                } else if (ctx.config.provider === 'gemini') {
                    const seen = new Set(); let token = '', total = 0;
                    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
                        const address = new URL(ctx.config.listUrl); address.searchParams.set('pageSize', '1000');
                        if (token) address.searchParams.set('pageToken', token);
                        const data = await call(address.href);
                        if (!Array.isArray(data.models) || (total += data.models.length) > MAX_MODEL_LIST) throw fault('INVALID_RESPONSE');
                        for (const item of data.models) {
                            const name = modelName(item?.name, 'gemini');
                            if (name && Array.isArray(item?.supportedGenerationMethods) && item.supportedGenerationMethods.includes('embedContent')) found.add(name);
                        }
                        if (data.nextPageToken == null || data.nextPageToken === '') break;
                        if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 2048
                            || /[\u0000-\u001f\u007f]/.test(data.nextPageToken) || seen.has(data.nextPageToken) || page + 1 === MAX_MODEL_PAGES) throw fault('INVALID_RESPONSE');
                        token = data.nextPageToken; seen.add(token);
                    }
                } else {
                    const data = await call(ctx.config.listUrl);
                    if (!Array.isArray(data.models) || data.models.length > MAX_MODEL_LIST) throw fault('INVALID_RESPONSE');
                    const names = new Set(data.models.map(item => modelName(item?.name || item?.model, 'ollama')).filter(Boolean));
                    const showUrl = ctx.config.listUrl.replace(/\/tags$/, '/show');
                    for (const name of names) {
                        if (/rerank|cross[-_]?encoder/i.test(name)) continue;
                        let detail;
                        try { detail = await call(showUrl, { model: name, verbose: false }); }
                        catch (error) {
                            // A removed or corrupt local model must not hide models whose
                            // capabilities were confirmed. Failed show calls never use a
                            // name fallback, and shared auth/network failures still abort.
                            if (error?.reason === 'BROWSER_UPSTREAM_ERROR' || error?.reason === 'INVALID_RESPONSE') continue;
                            throw error;
                        }
                        if (Array.isArray(detail.capabilities) ? detail.capabilities.includes('embedding')
                            : detail.capabilities == null && embeddingName(name)) found.add(name);
                    }
                }
                check();
                return [...found].sort((a, b) => a.localeCompare(b));
            }, { timeoutMs, signal: ctx.signal, priority: 20, fallback: 'BROWSER_NETWORK_ERROR' });
            assertCurrent(ctx, false);
            return { ok: true, reason: models.length ? 'MODELS_OK' : 'MODELS_EMPTY', models };
        } catch (error) {
            return { ok: false, reason: Object.hasOwn(PHONE_VECTOR_REASONS, error?.reason) ? error.reason : 'BROWSER_NETWORK_ERROR', models: [] };
        }
    }
    function sync(scan, options = {}) {
        let ctx, snapshot;
        try { ctx = context(options); snapshot = snapshotScan(scan); }
        catch (error) { const failure = handle(error); return Promise.resolve({ ok: false, ...state(), reason: failure.reason }); }
        return syncWithContext(scan, options, ctx, snapshot);
    }
    function syncWithContext(scan, options, capturedContext, capturedSnapshot) {
        // One latest pending snapshot survives a refresh while the old loop finishes.
        // Bind queued work when submitted: a later account or profile must not adopt
        // a scan captured by an earlier operation, including A -> B -> A switches.
        if (syncing) return new Promise(resolve => {
            if (pendingSync) pendingSync.resolve({ ok: false, ...state(), reason: 'STALE' });
            pendingSync = { scan, options, resolve, ctx: capturedContext, snapshot: capturedSnapshot };
        });
        syncing = (async () => {
            let ctx;
            try {
                ctx = capturedContext; const prepared = await prepare(scan, options, 3000, ctx, capturedSnapshot);
                const snapshot = prepared.snapshot;
                const allowed = new Map(snapshot.units.map(unit => [unit.id, unit]));
                // A scan can have a generation cutoff: only purge stale versions of present
                // units, never later sources merely absent from this particular request.
                await remove(record => record.scope === ctx.scope && record.profile === ctx.profile && record.chatId === snapshot.chatId
                    && allowed.has(record.id) && !cachedRecord(ctx, snapshot, allowed.get(record.id)), ctx);
                assertCurrent(ctx); report('INDEXING', ctx);
                let skippedLarge = snapshot.oversized > 0, capacityLimited = false;
                let responseDimensions = ctx.config.dimensions || [...records.values()].find(record => record.scope === ctx.scope && record.profile === ctx.profile)?.vector.length || 0;
                let knownDimensions = responseDimensions || MAX_DIMENSIONS, rebuiltDimensions = false;
                let selectedWorkingSet = null, selectedDimensions = null;
                let lastYield = Date.now(), lastProgress = Date.now();
                function workingSet() {
                    if (selectedWorkingSet && selectedDimensions === knownDimensions) return selectedWorkingSet;
                    let remaining = MAX_BYTES;
                    const units = [], keys = new Set();
                    skippedLarge = snapshot.oversized > 0; capacityLimited = false;
                    for (const unit of [...snapshot.units].reverse()) {
                        if (units.length >= MAX_ENTRIES) { capacityLimited = true; continue; }
                        // The two-hash key is shorter than 40 characters. Estimate first
                        // so excluded long sources do not incur repeated hashing work.
                        const required = 2 * (40 + ctx.profile.length + unit.text.length + unit.sourceVersion.length) + knownDimensions * 8 + 256;
                        if (required > MAX_BYTES) { skippedLarge = true; continue; }
                        if (required > remaining) { capacityLimited = true; continue; }
                        const descriptor = identity(ctx, snapshot, unit);
                        units.push(unit); keys.add(cachedRecord(ctx, snapshot, unit)?.key || descriptor.key); remaining -= required;
                    }
                    selectedDimensions = knownDimensions;
                    selectedWorkingSet = { units, keys, cursor: 0, removalRevision };
                    return selectedWorkingSet;
                }
                // Choose a bounded working set before issuing requests, then protect it
                // when older profiles/chats are evicted. Repeated sync is incremental.
                while (true) {
                    assertCurrent(ctx);
                    // Cached/mocked providers can resolve through microtasks only.
                    // Give input, keyboard resizing and painting a turn during indexing.
                    if (Date.now() - lastYield >= 8) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                        assertCurrent(ctx); lastYield = Date.now();
                    }
                    const selected = workingSet();
                    // Completed prefixes stay cached while records are only added. A
                    // concurrent dimension reset, eviction or rollback must recheck them.
                    if (selected.removalRevision !== removalRevision) {
                        selected.cursor = 0; selected.removalRevision = removalRevision;
                    }
                    while (selected.cursor < selected.units.length && cachedRecord(ctx, snapshot, selected.units[selected.cursor])) selected.cursor++;
                    const unit = selected.units[selected.cursor];
                    if (!unit) break;
                    const descriptor = identity(ctx, snapshot, unit);
                    const vectors = await embed(ctx, [unit.text], 15000, 0);
                    assertCurrent(ctx);
                    if (responseDimensions && responseDimensions !== vectors[0].length) {
                        await remove(record => record.scope === ctx.scope && record.profile === ctx.profile, ctx);
                        assertCurrent(ctx);
                        // Allow one upgrade of a cached index, but a drifting endpoint
                        // must not repeatedly erase and re-embed the same paid sources.
                        if (rebuiltDimensions) throw fault('DIMENSION_MISMATCH');
                        rebuiltDimensions = true; report('DIMENSION_MISMATCH', ctx);
                    }
                    responseDimensions = knownDimensions = vectors[0].length;
                    const afterResponse = workingSet();
                    if (!afterResponse.keys.has(descriptor.key)) {
                        if (!afterResponse.units.includes(unit)) continue;
                        // A concurrently removed legacy record can be rebuilt under its
                        // current key while the unit still belongs to this bounded set.
                        afterResponse.keys.add(descriptor.key);
                    }
                    const record = { ...descriptor, vector: vectors[0], used: Date.now() };
                    if (bytes(record) > MAX_BYTES) { skippedLarge = true; continue; }
                    rememberRecord(record);
                    discardedRecords.delete(record.key);
                    try {
                        await persistent('put', record); assertCurrent(ctx);
                        await prune(afterResponse.keys, ctx); assertCurrent(ctx);
                    } catch (error) {
                        // Only revoke this worker's publication; a newer operation
                        // may already own the same content key or have cleared it.
                        if (records.get(record.key) === record) {
                            forgetRecord(record.key); await persistent('delete', record.key);
                        }
                        throw error;
                    }
                    if (Date.now() - lastProgress >= 100) {
                        report('INDEXING', ctx); lastProgress = Date.now();
                    }
                }
                const cached = snapshot.units.filter(unit => cachedRecord(ctx, snapshot, unit)).length;
                const total = snapshot.units.length + snapshot.oversized;
                const next = skippedLarge ? 'SOURCE_TOO_LARGE' : capacityLimited ? 'CAPACITY_LIMIT' : cached < total ? 'PARTIAL' : 'OK';
                report(next, ctx);
                return { ok: true, ...state(), cached, total, profile: ctx.profile, reason: next, status: next };
            } catch (error) { const failure = handle(error, ctx); return { ok: false, ...state(), reason: failure.reason }; }
        })().finally(() => {
            syncing = null;
            const next = pendingSync; pendingSync = null;
            if (next) syncWithContext(next.scan, next.options, next.ctx, next.snapshot).then(next.resolve);
        });
        return syncing;
    }
    async function searchWork(scan, query, options = {}, suppliedContext) {
        let ctx;
        const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(15000, options.timeoutMs)) : 3000;
        const deadline = Date.now() + timeoutMs;
        try {
            ctx = suppliedContext || context(options); const prepared = await prepare(scan, options, timeoutMs, ctx);
            const snapshot = prepared.snapshot;
            if (typeof query !== 'string' || !query.trim() || query.length > MAX_TEXT) throw fault('INVALID_CONFIG');
            const present = snapshot.units.map(unit => cachedRecord(ctx, snapshot, unit)).filter(Boolean);
            if (!present.length) { report('NOT_READY', ctx); return { candidates: [], reason: 'NOT_READY' }; }
            if (deadline <= Date.now()) throw fault('TIMEOUT');
            const [vector] = await embed(ctx, [query], deadline - Date.now(), 10);
            if (present.some(record => record.vector.length !== vector.length)) {
                await remove(record => record.scope === ctx.scope && record.profile === ctx.profile, ctx);
                throw fault('DIMENSION_MISMATCH');
            }
            assertCurrent(ctx);
            const candidates = present.map(record => ({ id: record.id, score: cosinePhoneVectors(vector, record.vector) }))
                .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 16);
            // The returned IDs always come from this exact allowed scan, never from an
            // unrestricted cache search. Caller must revalidate sources before sending.
            assertCurrent(ctx);
            for (const record of present) record.used = Date.now();
            const next = present.length === snapshot.units.length && !snapshot.oversized ? 'OK' : 'PARTIAL'; report(next, ctx);
            return { candidates, reason: next };
        } catch (error) { return handle(error, ctx); }
    }
    function search(scan, query, options = {}) {
        // The whole recall has a deadline, including a blocked IndexedDB operation.
        // The abandoned worker retains guards and cannot publish a late result.
        const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(15000, options.timeoutMs)) : 3000;
        const controller = new AbortController(); operationControllers.add(controller);
        return new Promise(resolve => {
            let settled = false, timer, workerContext;
            const finish = result => {
                if (settled) return;
                settled = true; clearTimeout(timer); operationControllers.delete(controller);
                options.signal?.removeEventListener('abort', externalAbort); resolve(result);
            };
            const externalAbort = () => { controller.abort(); };
            controller.signal.addEventListener('abort', () => finish({ candidates: [], reason: 'CANCELLED' }), { once: true });
            options.signal?.addEventListener('abort', externalAbort, { once: true });
            timer = setTimeout(() => {
                // Report before abort invalidates the worker, and only if its generation
                // still owns this operation. No stale timeout overwrites a new preview.
                let stillCurrent = false;
                try { stillCurrent = startedEpoch === epoch && startedSettings === JSON.stringify(getSettings())
                    && (!startedScope || startedScope === scope)
                    && workerContext && valid(workerContext, false)
                    && ownsPreview(workerContext)
                    && !options.signal?.aborted && (options.isCurrent?.() ?? true); } catch { /* old caller */ }
                if (stillCurrent) report('TIMEOUT');
                finish({ candidates: [], reason: 'TIMEOUT' }); controller.abort();
            }, timeoutMs);
            const startedEpoch = epoch;
            let startedSettings;
            const startedScope = scope;
            if (options.signal?.aborted) { externalAbort(); return; }
            const workerOptions = { ...options, signal: controller.signal, timeoutMs };
            try { startedSettings = JSON.stringify(getSettings()); workerContext = context(workerOptions); }
            catch (error) { finish(handle(error)); return; }
            searchWork(scan, query, workerOptions, workerContext).then(finish, () => finish({ candidates: [], reason: 'NETWORK_ERROR' }));
        });
    }
    async function clearCache(chatId) {
        cancel(); let ctx;
        try {
            ctx = context({}, 'maintenance'); await refresh(ctx); await ensureLoaded(); assertCurrent(ctx);
            await remove(record => record.scope === ctx.scope && (chatId == null || record.chatId === chatId), ctx);
            for (const [key, record] of [...discardedRecords]) {
                assertCurrent(ctx);
                if (record.scope !== ctx.scope || (chatId != null && record.chatId !== chatId)
                    || discardedRecords.get(key) !== record) continue;
                discardedRecords.delete(key); await persistent('delete', key);
                assertCurrent(ctx);
            }
            assertCurrent(ctx); report('NOT_READY');
        } catch (error) { handle(error, ctx); }
        return state();
    }
    return Object.freeze({ refreshStatus, saveKey, testConnection, fetchModels, sync, search, cancel, clearCache, getState: state });
}

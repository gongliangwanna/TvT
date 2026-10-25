// 酒馆主页面适配。原文只来自当前酒馆聊天；向量默认由浏览器直连独立 API。
import * as core from './st-phone-memory-core.js';
import { createPhoneVectorService, phoneBrowserCredentialProfile } from './st-phone-vector.js';

export const MEMORY_SLOT = 'uwu_phone_memory';
const NORMAL_TYPES = new Set(['', 'normal', 'regenerate', 'swipe', 'continue']);
const TEXT_CONTENT_TYPES = new Set(['text', 'input_text', 'output_text']);
const REASONS = {
    ...core.REASON_TEXT,
    NO_NEED: '当前没有涉及手机剧情', NONE: '当前没有涉及手机剧情',
    JOIN: '接上刚刚推送的手机剧情', DIRECT: '当前正在询问相关手机剧情',
    FOLLOW: '接上刚刚谈到的手机话题', MANUAL: '按你选择的来源补充这一次',
    COVERED: '这段已经在本次对话里', COOLDOWN: '刚刚已经补充过',
    AMBIGUOUS: '不确定你指的是哪件事', BUDGET: '完整内容放不进本次长度上限',
    SOURCE_CHANGED: '来源或当前聊天已改变，本次补充已移除',
    TARGET_UNKNOWN: '无法确定这次回复的范围', INTERNAL: '这次是内部生成或预览',
    DISABLED: '按需补充已关闭', GROUP: '群聊不补充手机剧情',
    UNSUPPORTED: '当前酒馆缺少所需生成接口', TOKENIZER_ERROR: '本次无法确认实际 token 数',
    CANCELLED: '生成已取消，没有记录采用', NOT_RETAINED: '组装数据没有保留本次补充',
    CONCURRENT_INTERNAL: '后台生成与本次组装重叠，无法确认归属，已省略本次补充',
    SAVE_FAILED: '采用标记未确认保存，刷新后可能无法沿用这次重复抑制',
    ERROR: '本次补充遇到问题，正常聊天继续',
};

function ordinaryText(message) {
    return core.ordinaryText(message);
}
const isGroupChat = ctx => ctx?.groupId === 0 || !!ctx?.groupId;
function chatIdentity(ctx) {
    if (!ctx || isGroupChat(ctx) || !Array.isArray(ctx.chat)) return null;
    const ch = ctx.characters?.[ctx.characterId];
    const id = ctx.getCurrentChatId?.() ?? ch?.chat;
    if (id === null || id === undefined || id === '') return null;
    return JSON.stringify([ch?.avatar ?? ctx.characterId ?? null, String(id)]);
}
function prefixSnapshot(chat, cutoff, allowGreetingMacros = false) {
    // 原文和版本直接比对，不依赖短哈希判断请求归属。
    // 自动隐藏只是提示可见性变化；不把同一原文的隐藏标记当成来源删除。
    return chat.slice(0, cutoff).map((message, floor) => ({
        text: allowGreetingMacros && floor === 0 && !message?.is_user && !message?.extra?.from_uwu ? null : messageText(message),
        metadata: prefixMetadata(message),
    }));
}
function prefixMetadata(m) {
    return JSON.stringify([m?.is_user, m?.swipe_id ?? 0, m?.extra?.from_uwu, m?.extra?.bbs_omit,
        m?.extra?.uwu_msg_ids, m?.extra?.uwu_line_lens, m?.extra?.uwu_summary,
        m?.extra?.uwu_created, m?.extra?.uwu_internal, m?.extra?.isSmallSys, m?.name,
        core.isTypedSystemMessage(m)]);
}
function prefixMatches(snapshot, chat, cutoff, allowGreetingMacros = false) {
    if (!Array.isArray(snapshot) || !Array.isArray(chat) || snapshot.length !== cutoff || chat.length < cutoff) return false;
    for (let floor = 0; floor < cutoff; floor++) {
        const message = chat[floor];
        const text = allowGreetingMacros && floor === 0 && !message?.is_user && !message?.extra?.from_uwu ? null : messageText(message);
        if (snapshot[floor].text !== text || snapshot[floor].metadata !== prefixMetadata(message)) return false;
    }
    return true;
}
function replyStartSnapshot(message, floor) {
    // 宿主会展开首楼招呼宏；目标时间字段也会在正常 Continue 中更新。
    return JSON.stringify([floor === 0 && !message?.extra?.from_uwu ? null : messageText(message), message?.swipe_id ?? 0]);
}
function messageText(message) { return contentTexts(message?.mes ?? message?.content).join(''); }
function messageVersion(message) { return JSON.stringify([messageText(message), message?.swipe_id ?? 0]); }
function phoneSourceMetadata(extra) {
    return JSON.stringify([!!extra.uwu_summary, Array.isArray(extra.uwu_msg_ids) ? extra.uwu_msg_ids : [],
        Array.isArray(extra.uwu_line_lens) ? extra.uwu_line_lens : null, extra.uwu_push_time || 0]);
}
function capturePhoneSources(chat, cutoff) {
    const sources = [];
    for (let floor = 0; floor < cutoff; floor++) {
        const message = chat[floor], extra = message?.extra;
        if (extra?.from_uwu && !extra.bbs_omit) sources.push({ floor, text: message.mes, metadata: phoneSourceMetadata(extra) });
    }
    return sources;
}
function phoneSourcesMatch(sources, chat, cutoff) {
    if (!Array.isArray(chat) || cutoff > chat.length) return false;
    let index = 0;
    for (let floor = 0; floor < cutoff; floor++) {
        const message = chat[floor], extra = message?.extra;
        if (!extra?.from_uwu || extra.bbs_omit) continue;
        const source = sources[index++];
        // Exact source text comparisons avoid re-parsing and segmenting the
        // whole history on every asynchronous index validity check.
        if (!source || source.floor !== floor || source.text !== message.mes || source.metadata !== phoneSourceMetadata(extra)) return false;
    }
    return index === sources.length;
}
function contentTexts(content) {
    if (typeof content === 'string') return [content];
    if (Array.isArray(content)) return content.flatMap(part => typeof part === 'string'
        ? [part] : TEXT_CONTENT_TYPES.has(part?.type) && typeof part.text === 'string' ? [part.text] : []);
    return [];
}
function mapContent(content, fn, ownedRanges = []) {
    if (typeof content === 'string') return fn(content);
    if (Array.isArray(content)) {
        const joined = contentTexts(content).join('');
        const edits = ownedRanges.map(range => ({ ...range, text: fn(joined.slice(range.start, range.end)) }))
            .filter(edit => edit.text !== joined.slice(edit.start, edit.end));
        let offset = 0;
        const transform = text => {
            const start = offset, end = start + text.length; offset = end;
            let cursor = start, result = '';
            for (const edit of edits) {
                if (edit.end <= start || edit.start >= end) continue;
                result += joined.slice(cursor, Math.max(cursor, Math.min(end, edit.start)));
                // 新的短块仅放在原块起点；其余部分只删除相交文字，不挪动图片/工具信息。
                if (edit.start >= start) result += edit.text;
                cursor = Math.min(end, edit.end);
            }
            return result + joined.slice(cursor, end);
        };
        return content.map(part => typeof part === 'string' ? transform(part)
            : TEXT_CONTENT_TYPES.has(part?.type) && typeof part.text === 'string' ? { ...part, text: transform(part.text) } : part);
    }
    return content;
}
const clone = value => JSON.parse(JSON.stringify(value));
const VECTOR_DEFAULTS = Object.freeze({ enabled: false, transport: 'browser', provider: 'openai', url: '', model: '',
    dimensions: 0, threshold: 0.72, margin: 0.06, allowAnonymous: false, splitVersion: 'phone-units-v1' });
// Only this Toastr icon is removed; theme images and gradients remain intact.
const NATIVE_SUCCESS_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADsSURBVEhLY2AYBfQMgf///3P8+/evAIgvA/FsIF+BavYDDWMBGroaSMMBiE8VC7AZDrIFaMFnii3AZTjUgsUUWUDA8OdAH6iQbQEhw4HyGsPEcKBXBIC4ARhex4G4BsjmweU1soIFaGg/WtoFZRIZdEvIMhxkCCjXIVsATV6gFGACs4Rsw0EGgIIH3QJYJgHSARQZDrWAB+jawzgs+Q2UO49D7jnRSRGoEFRILcdmEMWGI0cm0JJ2QpYA1RDvcmzJEWhABhD/pqrL0S0CWuABKgnRki9lLseS7g2AlqwHWQSKH4oKLrILpRGhEQCw2LiRUIa4lwAAAABJRU5ErkJggg==';
const VECTOR_REASONS = {
    DISABLED: '向量检索未启用，使用关键词', NO_SOURCE: '当前没有已推送的手机来源',
    INVALID_CONFIG: '请填写有效的接口地址和嵌入模型',
    KEY_REQUIRED: '请保存独立 API Key，或明确选择无需鉴权', STATUS_ERROR: '无法确认向量连接，使用关键词',
    KEY_ENDPOINT_MISMATCH: '此接口未保存匹配的独立 Key，旧接口的 Key 不会发给它',
    NOT_READY: '向量索引尚未就绪，使用关键词', PARTIAL: '部分来源向量已就绪，其余仍可关键词检索',
    OK: '向量检索已就绪', TIMEOUT: '本次向量查询超时，使用关键词', CANCELLED: '向量操作已取消',
    STALE: '来源、账号或配置已改变，旧向量结果已忽略', INVALID_RESPONSE: '向量响应格式无效，使用关键词',
    DIMENSION_MISMATCH: '向量维度不一致，旧索引已停用', NETWORK_ERROR: '向量请求失败，使用关键词',
    CACHE_MEMORY: '持久缓存不可用，暂用页内缓存', INDEXING: '正在增量准备已推送来源的向量',
    CONNECTION_OK: '连接测试通过', NO_CAPACITY: '向量连接仍有未结束的请求，本次使用关键词',
    SOURCE_TOO_LARGE: '部分原文过长，仍可关键词检索', CAPACITY_LIMIT: '向量缓存容量已满，较早来源仍可关键词检索',
    ACCOUNT_UNKNOWN: '尚未确认当前酒馆账号，请刷新酒馆后重试',
    KEY_STORAGE_ERROR: '无法读取或保存当前酒馆账号的向量 Key，请重试',
    BROWSER_NETWORK_ERROR: '无法连接，请检查地址、网络，或接口是否允许浏览器跨域；HTTPS 酒馆不能连接 HTTP 接口',
    BROWSER_UPSTREAM_ERROR: '向量接口返回错误，请检查 API Key、模型和接口地址',
};
const MODEL_FETCH_REASONS = {
    INVALID_CONFIG: '请先填写有效的接口地址。',
    KEY_REQUIRED: '请先输入 API Key，或选择此接口无需 API Key。',
    MODELS_EMPTY: '未找到可识别的嵌入模型，可以手动输入模型名称。',
    UNSUPPORTED: '当前接口不支持拉取模型，可以手动输入模型名称。',
    TIMEOUT: '拉取模型超时，请重试。',
    CANCELLED: '模型拉取已取消。',
    STALE: '账号或接口已改变，请重新拉取模型。',
    INVALID_RESPONSE: '接口返回的模型列表无效。',
    BROWSER_UPSTREAM_ERROR: '拉取模型失败，请检查接口地址、API Key 和模型列表权限。',
    NO_CAPACITY: '接口仍有请求未结束，请稍后再拉取。',
};

// 酒馆公开的账号模块提供实时账号信息；未知账号不共用凭据或缓存。
let accountModule = null;
let adapterSerial = 0;

/** 使用同一创建入口运行真实宿主和测试宿主，测试不绕过生成生命周期。 */
export function createPhoneMemoryAdapter(host = {}) {
    const getContext = host.getContext || (() => globalThis.SillyTavern?.getContext?.());
    const getDocument = () => host.document === undefined ? globalThis.document : host.document;
    let active = null, sequence = 0, topicRefs = [], topicChat = null, topicScope = null, manual = null, assemblyOwner = null;
    let initialized = false, disposed = false, preview = { stage: 'idle', reason: 'NO_NEED', selected: [], chars: 0, tokens: 0 };
    let trialJob = null;
    let sourceScanCache = null;
    let vectorIndexSnapshot = null;
    const trialEvidence = new WeakMap();
    let boundEvents = null, boundTypes = null;
    let previewOwner = null;
    // 独有前缀与递增编号可识别任意久以前的自有块，不必无限保存整段原文。
    const operationOwner = `m${Date.now().toString(36)}_${++adapterSerial}_${Math.random().toString(36).slice(2, 10)}_`;
    let operationSequence = 0;
    const publishedOperations = new Set();
    const bindings = [], warnings = new Set(), knownBlocks = new Map();
    const fallbackSettings = { enabled: true };
    const tokenizerTimeoutMs = Number.isFinite(host.tokenizerTimeoutMs)
        ? Math.max(1, Math.min(15000, host.tokenizerTimeoutMs)) : 3000;
    let indexTimer = null, vectorControls = null, vectorUiBusy = false, saveSuccessToast = null;
    const contextCall = (name, ...args) => {
        const ctx = getContext();
        const fn = host[name] || ctx?.[name];
        return typeof fn === 'function' ? fn.apply(ctx, args) : undefined;
    };
    function settings() {
        const ctx = getContext();
        const container = host.extensionSettings || ctx?.extensionSettings;
        if (!container || typeof container !== 'object' || Array.isArray(container)) return fallbackSettings;
        const stored = container[MEMORY_SLOT];
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) container[MEMORY_SLOT] = { enabled: true };
        // 旧配置可只有向量设置；缺失开关时与界面使用同一个默认值。
        if (typeof container[MEMORY_SLOT].enabled !== 'boolean') container[MEMORY_SLOT].enabled = true;
        return container[MEMORY_SLOT];
    }
    function vectorSettings() {
        const stored = settings();
        stored.vector ||= { ...VECTOR_DEFAULTS };
        // 旧连接配置也使用浏览器直连；服务端凭据不会迁入扩展设置。
        const normalized = { ...VECTOR_DEFAULTS, ...stored.vector, transport: 'browser' };
        delete normalized.key; delete normalized.apiKey; delete normalized.secret;
        const entry = recallProfile(normalized);
        if (entry) { normalized.threshold = entry.threshold; normalized.margin = entry.margin; }
        return normalized;
    }
    function recallProfileKey(config) {
        try {
            if (!String(config.model || '').trim()) return null;
            return JSON.stringify([userScope(), phoneBrowserCredentialProfile(config),
                String(config.model).trim().replace(config.provider === 'gemini' ? /^models\// : /^$/, ''), Number(config.dimensions) || 0]);
        } catch { return null; }
    }
    function recallProfile(config, create = true) {
        const key = recallProfileKey(config);
        if (!key) return null;
        const stored = settings();
        const migrating = !stored.recallProfiles || stored.recallProfiles.version !== 1
            || !stored.recallProfiles.profiles || typeof stored.recallProfiles.profiles !== 'object'
            || Array.isArray(stored.recallProfiles.profiles);
        if (migrating && create) stored.recallProfiles = { version: 1, profiles: {} };
        const profiles = stored.recallProfiles?.profiles;
        if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return null;
        if ((!Object.hasOwn(profiles, key) || !profiles[key] || typeof profiles[key] !== 'object'
            || Array.isArray(profiles[key])) && create) {
            const value = (name, fallback) => migrating && config[name] !== null && config[name] !== ''
                && ['number', 'string'].includes(typeof config[name]) && Number.isFinite(Number(config[name]))
                ? Math.min(1, Math.max(0, Number(config[name]))) : fallback;
            profiles[key] = { threshold: value('threshold', .72), margin: value('margin', .06), evaluations: [],
                origin: migrating ? 'migrated' : 'default' };
        }
        const entry = Object.hasOwn(profiles, key) ? profiles[key] : null;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        for (const [name, fallback] of [['threshold', .72], ['margin', .06]]) {
            if (typeof entry[name] !== 'number' || !Number.isFinite(entry[name])) entry[name] = fallback;
            else entry[name] = Math.min(1, Math.max(0, entry[name]));
        }
        if (!Array.isArray(entry.evaluations)) entry.evaluations = [];
        return entry;
    }
    function privateSafeText(value) {
        let text = String(value ?? '');
        const key = settings().browserCredential?.key;
        if (typeof key === 'string' && key) text = text.replaceAll(key, '[已隐藏]');
        return text;
    }
    function reasonCode(value) {
        const code = privateSafeText(value);
        return /^[A-Z_]{1,64}$/.test(code) ? code : 'UNKNOWN';
    }
    function getRecallEvaluation() {
        const config = vectorSettings(), entry = recallProfile(config);
        return clone({ threshold: config.threshold, margin: config.margin, evaluations: entry?.evaluations || [] });
    }
    function recordTrialEvaluation(result, { expected = 'recall', correctSource = false } = {}) {
        const evidence = trialEvidence.get(result), config = vectorSettings();
        if (disposed || !evidence || evidence.profile !== recallProfileKey(config)
            || evidence.chatId !== chatIdentity(getContext()) || evidence.snapshot !== JSON.stringify(getContext()?.chat)
            || evidence.threshold !== config.threshold || evidence.margin !== config.margin
            || !['recall', 'omit'].includes(expected)) return false;
        const entry = recallProfile(config);
        if (!entry) return false;
        const actual = result.selected.length ? 'recall' : 'omit';
        const record = { at: new Date().toISOString(), expected, actual,
            correct: expected === actual && (expected === 'omit' || correctSource === true),
            reason: reasonCode(result.reason), vectorReason: reasonCode(result.vector?.reason || 'NO_NEED'),
            threshold: evidence.threshold, margin: evidence.margin, elapsedMs: evidence.elapsedMs,
            vectorQueried: evidence.vectorQueried };
        entry.evaluations = [...(entry.evaluations || []), record].slice(-40);
        trialEvidence.delete(result);
        contextCall('saveSettingsDebounced'); return true;
    }
    function getDiagnosticSummary() {
        const config = vectorSettings(), state = vectors.getState(), current = getPreview();
        return JSON.stringify({ format: 'uwu-recall-diagnostic-v1', at: new Date().toISOString(),
            stage: /^[a-z]{1,32}$/.test(privateSafeText(current.stage)) ? privateSafeText(current.stage) : 'unknown',
            reason: reasonCode(current.reason), vectorReason: reasonCode(state.reason),
            index: { cached: Number(state.cached) || 0, total: Number(state.total) || 0 },
            provider: ['openai', 'ollama', 'gemini'].includes(config.provider) ? config.provider : 'unknown',
            model: privateSafeText(config.model).replace(/https?:\/\/\S+|(?:sk-|key[=:])\S+/gi, '[已隐藏]').split(/[?#]/)[0].slice(0, 256),
            dimensions: config.dimensions, threshold: config.threshold, margin: config.margin,
            chars: Number(current.chars) || 0, tokens: Number.isFinite(current.tokens) ? current.tokens : null,
            evaluationCount: getRecallEvaluation().evaluations.length }, null, 2);
    }
    function userScope() {
        if (host.getUserScope) return host.getUserScope();
        if (!accountModule) return '';
        return accountModule.accountsEnabled ? accountModule.currentUser?.handle || '' : 'default-user';
    }
    function vectorProfileSnapshot() { return JSON.stringify(vectorSettings()); }
    function scanSourcesCached(chat, { chatId, cutoff = chat?.length || 0 } = {}) {
        const list = Array.isArray(chat) ? chat : [];
        const boundary = Math.max(0, Math.min(list.length, Number.isInteger(cutoff) ? cutoff : 0));
        const scope = userScope();
        if (!sourceScanCache || sourceScanCache.chatId !== chatId || sourceScanCache.scope !== scope
            || !phoneSourcesMatch(sourceScanCache.sources, list, boundary)) {
            sourceScanCache = { chatId, scope, sources: capturePhoneSources(list, boundary),
                scan: core.scanSources(list, { chatId, cutoff: boundary }) };
        }
        return sourceScanCache.scan.cutoff === boundary ? sourceScanCache.scan : { ...sourceScanCache.scan, cutoff: boundary };
    }
    const vectors = host.vectorService || createPhoneVectorService({
        getSettings: vectorSettings, fetch: host.fetch || globalThis.fetch,
        indexedDB: host.indexedDB === undefined ? globalThis.indexedDB : host.indexedDB,
        cache: host.vectorCache,
        getScope: userScope,
        getBrowserCredential: ({ scope }) => {
            const credential = settings().browserCredential;
            return credential?.scope === scope ? { ...credential } : { key: '', credentialProfile: '' };
        },
        saveBrowserCredential: ({ scope, key, credentialProfile, clear }) => {
            if (!scope || userScope() !== scope) throw Object.assign(new Error('STALE'), { reason: 'STALE' });
            if (clear) delete settings().browserCredential;
            else settings().browserCredential = { scope, key, credentialProfile };
            contextCall('saveSettingsDebounced');
        },
        onStatus: state => renderVectorStatus(state),
    });
    function renderVectorKeyStatus() {
        const key = vectorControls?.credential;
        if (!key || disposed) return;
        const saved = settings().browserCredential;
        let matches = false;
        if (saved?.scope === userScope() && saved.key) {
            try {
                matches = saved.credentialProfile === phoneBrowserCredentialProfile({
                    provider: vectorControls.provider.value, url: vectorControls.url.value,
                });
            } catch { /* An incomplete address has no matching saved credential. */ }
        }
        const placeholder = matches ? '密钥已保存' : '输入 API Key';
        if (key.placeholder !== placeholder) key.placeholder = placeholder;
    }
    function renderVectorStatus(state) {
        if (disposed) return;
        // Background indexing must not keep mutating a closed dialog. Host DOM
        // observers can otherwise do work for every invisible progress update.
        if (!getDocument()?.getElementById?.('uwu-phone-vector-dialog')?.open) return;
        state ??= vectors.getState();
        renderVectorKeyStatus();
        const status = getDocument()?.getElementById?.('uwu-phone-vector-status');
        if (!status) return;
        const text = `${VECTOR_REASONS[state.reason] || state.reason || '向量尚未准备'}。${Number(state.cached) || 0}/${Number(state.total) || 0} 段已缓存。`
            + (state.available ? (state.hasKey
                ? ' 当前账号已保存 Key；更改地址后需重新保存。' : ' 当前账号尚未保存 Key。') : '')
            + (state.cacheWarning ? ` ${VECTOR_REASONS[state.cacheWarning] || state.cacheWarning}` : '');
        if (status.textContent !== text) status.textContent = text;
    }
    function scheduleVectorIndex() {
        if (indexTimer !== null) clearTimeout(indexTimer);
        indexTimer = null;
        if (disposed || !initialized || !settings().enabled || !vectorSettings().enabled) return;
        const ctx = getContext(), chatId = chatIdentity(ctx);
        if (vectorIndexSnapshot && vectorIndexSnapshot.chatId === chatId
            && vectorIndexSnapshot.scope === userScope() && vectorIndexSnapshot.profile === vectorProfileSnapshot()
            && phoneSourcesMatch(vectorIndexSnapshot.sources, ctx?.chat, ctx?.chat?.length || 0)
            && (vectorIndexSnapshot.pending || vectorIndexSnapshot.ready || Date.now() < vectorIndexSnapshot.retryAfter)) return;
        indexTimer = setTimeout(() => {
            indexTimer = null;
            prepareVectorIndex().catch(() => renderVectorStatus());
        }, 100);
    }
    async function prepareVectorIndex() {
        if (disposed || !settings().enabled || !vectorSettings().enabled) return vectors.getState();
        const ctx = getContext(), chatId = chatIdentity(ctx);
        if (!chatId) return vectors.getState();
        const sourceScope = userScope();
        const profile = vectorProfileSnapshot();
        const scan = scanSourcesCached(ctx.chat, { chatId });
        // 非手机普通对话增减不使内容索引失效；每个来源的原文版本必须保持一致。
        const sources = sourceScanCache.sources;
        const indexing = { chatId, scope: sourceScope, profile, sources, pending: true, ready: false, retryAfter: 0 };
        vectorIndexSnapshot = indexing;
        const isCurrent = () => !disposed && settings().enabled && vectorSettings().enabled
            && userScope() === sourceScope && chatIdentity(getContext()) === chatId && vectorProfileSnapshot() === profile
            && phoneSourcesMatch(sources, getContext().chat, getContext().chat?.length || 0);
        try {
            const result = await vectors.sync(scan, { isCurrent });
            indexing.ready = result?.ok === true;
            renderVectorStatus(); return vectors.getState();
        } finally {
            indexing.pending = false;
            if (!indexing.ready) indexing.retryAfter = Date.now() + 5000;
        }
    }
    function setVectorSettings(changes) {
        if (disposed) throw Object.assign(new Error('CANCELLED'), { reason: 'CANCELLED' });
        const next = { ...vectorSettings(), ...changes };
        const supplied = String(next.url || '').trim();
        if (supplied) {
            let endpoint;
            try { endpoint = new URL(supplied); } catch { throw new Error('INVALID_CONFIG'); }
            if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
                || endpoint.search || endpoint.hash) throw new Error('INVALID_CONFIG');
        }
        next.url = supplied;
        next.model = String(next.model || '').trim();
        next.provider = ['openai', 'ollama', 'gemini'].includes(next.provider) ? next.provider : 'openai';
        next.transport = 'browser';
        next.enabled = !!next.enabled; next.allowAnonymous = !!next.allowAnonymous;
        const dimensions = Number(next.dimensions);
        if (!Number.isInteger(dimensions) || dimensions < 0 || dimensions > 16384) throw new Error('INVALID_CONFIG');
        next.dimensions = dimensions;
        next.threshold = Number.isFinite(Number(next.threshold)) ? Math.min(1, Math.max(0, Number(next.threshold))) : 0.72;
        next.margin = Number.isFinite(Number(next.margin)) ? Math.min(1, Math.max(0, Number(next.margin))) : 0.06;
        const entry = recallProfile(next);
        if (entry) {
            if (!Object.hasOwn(changes, 'threshold')) next.threshold = entry.threshold;
            if (!Object.hasOwn(changes, 'margin')) next.margin = entry.margin;
            entry.threshold = next.threshold; entry.margin = next.margin;
        }
        // Key 单独绑定账号及端点，不混入普通连接配置或补充预览。
        delete next.key; delete next.apiKey; delete next.secret;
        settings().vector = next;
        invalidate('VECTOR_CONFIG');
        contextCall('saveSettingsDebounced');
        scheduleVectorIndex(); renderVectorStatus();
        return clone(next);
    }
    async function saveVectorKey(key, { clear = false } = {}) {
        if (disposed) return { ok: false, reason: 'CANCELLED' };
        invalidate('VECTOR_CONFIG');
        const result = await vectors.saveKey(String(key || ''), { clear });
        scheduleVectorIndex(); renderVectorStatus(); return result;
    }
    async function testVectorConnection() {
        if (disposed) return { ok: false, reason: 'CANCELLED' };
        const result = await vectors.testConnection();
        renderVectorStatus(); return result;
    }
    async function fetchVectorModels(changes = {}) {
        if (disposed) return { ok: false, reason: 'CANCELLED', models: [] };
        if (typeof vectors.fetchModels !== 'function') return { ok: false, reason: 'UNSUPPORTED', models: [] };
        try { return await vectors.fetchModels({ ...vectorSettings(), ...changes }); }
        catch (error) { return { ok: false, reason: error?.reason || 'BROWSER_NETWORK_ERROR', models: [] }; }
    }
    async function clearVectorCache() {
        if (disposed) return { ok: false, reason: 'CANCELLED' };
        const chatId = chatIdentity(getContext());
        if (!chatId) {
            const status = getDocument()?.getElementById?.('uwu-phone-vector-status');
            if (status) status.textContent = '请先打开需要清理的单角色聊天；其他聊天的缓存会保留。';
            return { ok: false, reason: 'NO_SOURCE' };
        }
        invalidate('VECTOR_CONFIG', { reindex: false });
        await vectors.clearCache(chatId);
        renderVectorStatus();
    }
    function warn(reason, detail) {
        if (disposed) return;
        const key = `${reason}:${detail || ''}`;
        if (warnings.has(key)) return;
        warnings.add(key);
        console.warn('[小手机记忆]', REASONS[reason] || reason, detail || '');
        (host.notify || globalThis.toastr?.warning)?.(REASONS[reason] || reason, '小手机剧情补充');
    }
    function clearSlot() {
        if (disposed) return;
        contextCall('setExtensionPrompt', MEMORY_SLOT, '', 1, 1, false, 0, () => false);
    }
    function updatePreview(changes) {
        if (disposed) return;
        preview = { ...preview, ...changes };
        const status = getDocument()?.getElementById?.('uwu-phone-memory-status');
        if (status) status.textContent = REASONS[preview.reason] || preview.reason;
        host.onPreview?.(getPreview());
    }
    function getPreview() {
        // 已完成操作也保留预览；读取时仍须隔离无 CHAT_CHANGED 事件的账号/聊天切换。
        if (previewOwner && (previewOwner.scope !== userScope() || previewOwner.chatId !== chatIdentity(getContext())))
            invalidate();
        return clone({ ...preview, explanation: REASONS[preview.reason] || preview.reason });
    }
    function invalidate(reason = 'SOURCE_CHANGED', { reindex = true } = {}) {
        if (disposed) return;
        cancelTrial();
        sequence++;
        vectors.cancel();
        if (active) { active.invalid = true; active.vectorAbort?.abort(); active.abortCleanup?.(); }
        active = null; assemblyOwner = null;
        sourceScanCache = null;
        vectorIndexSnapshot = null;
        topicRefs = []; topicChat = null; topicScope = null; manual = null;
        previewOwner = { scope: userScope(), chatId: chatIdentity(getContext()) };
        clearSlot();
        updatePreview({ stage: 'idle', reason: reason === 'DISABLED' ? reason : 'SOURCE_CHANGED',
            selected: [], chars: 0, tokens: 0, persistence: null, vector: null, retrieval: null,
            query: '', kind: null, operationId: null, saveError: null });
        if (reindex) scheduleVectorIndex();
        else {
            if (indexTimer !== null) clearTimeout(indexTimer);
            indexTimer = null;
        }
    }
    function setEnabled(enabled) {
        if (disposed) return;
        const wasEnabled = settings().enabled !== false;
        settings().enabled = !!enabled;
        if (!enabled) invalidate('DISABLED');
        else if (!wasEnabled) updatePreview({ stage: 'idle', reason: 'NO_NEED' });
        const toggle = getDocument()?.getElementById?.('uwu-phone-memory-enabled');
        if (toggle) toggle.checked = !!enabled;
        contextCall('saveSettingsDebounced');
        scheduleVectorIndex();
    }
    function compatible(ctx) {
        const types = ctx?.eventTypes || ctx?.event_types || host.eventTypes || {};
        const required = ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
            'CHARACTER_MESSAGE_RENDERED', 'CHAT_CHANGED'];
        const apiEvents = ctx?.mainApi === 'openai'
            ? ['CHAT_COMPLETION_PROMPT_READY', 'CHAT_COMPLETION_SETTINGS_READY'] : ['GENERATE_AFTER_DATA'];
        return required.concat(apiEvents).every(name => !!types[name])
            && typeof (host.setExtensionPrompt || ctx?.setExtensionPrompt) === 'function'
            && typeof (host.getTokenCountAsync || ctx?.getTokenCountAsync) === 'function';
    }
    function start(type, options = {}, dryRun = false) {
        if (disposed) return;
        // 正式生成优先。只取消试查自己的请求，不取消共享向量服务或改变真实采用状态。
        cancelTrial();
        getPreview();
        clearSlot();
        const ctx = getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const scope = userScope();
        const mode = String(type || '').toLowerCase();
        const lastFloor = chat.length - 1;
        const last = chat[lastFloor];
        const eligible = !dryRun && NORMAL_TYPES.has(mode) && !options?.quiet_prompt
            && !options?.quietToLoud && !options?.quietImage && !options?.depth && !options?.internal;
        if (!eligible && active?.eligible && !active.invalid && active.scope === scope) {
            // 酒馆允许 quiet 与主回复并行。后台开始只清临时槽，不能抹去主请求的采用证据。
            active.concurrentInternal = true; assemblyOwner = null;
            // TC 最终数据没有生成 type；未发送时不能可靠区分并行组装，省略这一轮补充。
            if (ctx?.mainApi !== 'openai' && !active.sent) active.supplementSuppressed = true;
            return;
        }
        if (active) { active.invalid = true; active.vectorAbort?.abort(); active.abortCleanup?.(); }
        const initialTarget = ['regenerate', 'swipe', 'continue'].includes(mode) && core.isCompletedReply(last)
            ? lastFloor : null;
        const startLength = chat.length, startCutoff = initialTarget ?? startLength;
        sequence++;
        active = { id: `${operationOwner}${++operationSequence}`,
            operationNumber: operationSequence,
            serial: sequence, chatId: chatIdentity(ctx), scope, mode, options, eligible,
            // 自动隐藏的角色楼仍是目标；真正的系统/内部楼和手机推送不能成为主回复目标。
            initialTarget, startLength, startCutoff,
            startPrefix: prefixSnapshot(chat, startCutoff, true),
            startTargetVersion: initialTarget === null ? null : replyStartSnapshot(last, initialTarget),
            selected: [], sent: false, replySeen: false, invalid: false, vectorAbort: new AbortController(),
            vectorProfile: vectorProfileSnapshot() };
        previewOwner = { scope, chatId: active.chatId };
        assemblyOwner = eligible ? active.id : null;
        updatePreview({ stage: 'started', reason: eligible ? 'NO_NEED' : 'INTERNAL',
            selected: [], chars: 0, tokens: 0, persistence: null, vector: null, retrieval: null,
            query: '', kind: null, saveError: null, operationId: active.id });
        const startedOp = active;
        const signal = options?.signal;
        const onAbort = () => { if (active === startedOp) stop(); };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        startedOp.abortCleanup = () => signal?.removeEventListener?.('abort', onAbort);
        if (signal?.aborted) stop();
    }
    function targetFor(op, ctx) {
        const chat = ctx.chat;
        let cutoff = chat.length, replyFloor = chat.length;
        if (['regenerate', 'swipe', 'continue'].includes(op.mode)) {
            if (!Number.isInteger(op.initialTarget)) return null;
            replyFloor = op.initialTarget;
            if (op.mode === 'regenerate') {
                // 已删除目标，或宿主保留目标直到组装；不能接受目标后还有未来楼。
                if (chat.length !== replyFloor && chat.length !== replyFloor + 1) return null;
            } else if (chat.length !== replyFloor + 1 || chat[replyFloor]?.is_user) return null;
            // START 到 interceptor 之间目标也可能被其他扩展改为辅助楼。
            // 重生已删除目标时沿用用户输入；仍存在的目标必须是当前有效角色回复。
            if (chat[replyFloor] && !core.isCompletedReply(chat[replyFloor])) return null;
            cutoff = replyFloor;
        }
        const tail = chat[cutoff - 1];
        const replacingReply = ['regenerate', 'swipe', 'continue'].includes(op.mode);
        // 重做/续写取原目标的用户输入；自动隐藏不能把它替换为更早的话题。
        const inputText = message => ordinaryText(replacingReply && message?.is_user
            ? { ...message, is_system: false } : message);
        let userFloor = replacingReply ? -1 : cutoff - 1, query = '';
        let pendingPhoneTail = tail?.extra?.from_uwu && !inputText(tail);
        for (let i = cutoff - 1; i >= 0; i--) {
            const message = chat[i];
            // 普通生成可以跳过辅助楼，但角色已回复后不能再次把历史提问当作新输入。
            // 隐藏的角色楼仍是已回复；重做/续写则沿用原目标之前的用户问题。
            if (!replacingReply && core.isCompletedReply(message)) break;
            const text = inputText(message);
            if (message?.extra?.from_uwu && !text) {
                pendingPhoneTail = true; userFloor = i; break;
            }
            if (!message?.is_user) continue;
            if (text) { userFloor = i; query = text; break; }
        }
        // 手机纯块是待回应末尾时，旧的普通用户楼不是新查询。
        // 保留循环找到的实际手机楼，不能把后面的辅助楼记为采用依据。
        if (pendingPhoneTail) query = '';
        return { cutoff, replyFloor, userFloor, query,
            joinAllowed: !replacingReply && !query && !pendingPhoneTail ? false : undefined,
            continuationText: op.mode === 'continue' ? ordinaryText(chat[replyFloor]) : '' };
    }
    function currentValid(op, allowReply = false) {
        const ctx = getContext();
        if (disposed || !op || active !== op || op.invalid || !settings().enabled || chatIdentity(ctx) !== op.chatId
            || userScope() !== op.scope) return false;
        if (op.vectorProfile !== vectorProfileSnapshot()) return false;
        if (!prefixMatches(op.prefix, ctx.chat, op.cutoff)) return false;
        if (!allowReply) {
            const expected = ['swipe', 'continue'].includes(op.mode) ? op.cutoff + 1 : op.baseLength;
            if (ctx.chat.length !== expected) return false;
            if (Number.isInteger(op.initialTarget) && ctx.chat[op.replyFloor]
                && !core.isCompletedReply(ctx.chat[op.replyFloor])) return false;
            if (op.targetVersion !== null && messageVersion(ctx.chat[op.replyFloor]) !== op.targetVersion) return false;
        }
        return true;
    }
    function countOperationTokens(op, text) {
        // 宿主 tokenizer 可能一直不返回。超时或取消后让主生成继续，迟到结果只属于旧调用。
        return new Promise((resolve, reject) => {
            const signal = op.vectorAbort.signal;
            let settled = false, timer;
            const finish = (error, value) => {
                if (settled) return;
                settled = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort);
                if (error) reject(error); else resolve(value);
            };
            const onAbort = () => finish(Object.assign(new Error('CANCELLED'), { reason: 'CANCELLED' }));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) { onAbort(); return; }
            timer = setTimeout(() => finish(new Error('TOKENIZER_TIMEOUT')), tokenizerTimeoutMs);
            Promise.resolve().then(() => { if (!settled) return contextCall('getTokenCountAsync', text); })
                .then(value => finish(null, value), error => finish(error));
        });
    }
    async function decideWithVectors(decisionInput, { isCurrent, signal }) {
        let decision = core.decideMemory(decisionInput);
        const config = vectorSettings(), classification = decision.classification;
        const maySearch = config.enabled && decisionInput.scan.units.length && !decisionInput.manualRefs?.length
            && !['JOIN', 'FOLLOW', 'MANUAL'].includes(decision.kind)
            && classification?.need && !classification.genericFollow
            && core.semanticQueryHasContent(classification,
                [...decisionInput.roleNames, ...decisionInput.scan.units.map(unit => unit.speaker).filter(Boolean)]);
        if (!maySearch) return { decision, vector: { reason: config.enabled ? 'NO_NEED' : 'DISABLED',
            explanation: config.enabled ? '当前承接或输入无需向量查询' : VECTOR_REASONS.DISABLED } };
        let result;
        try { result = await vectors.search(decisionInput.scan, classification.demandText, { isCurrent, signal, timeoutMs: 3000 }); }
        catch { result = { candidates: [], reason: 'NETWORK_ERROR' }; }
        if (!isCurrent()) return null;
        if (result.candidates?.length) decision = core.decideMemory({ ...decisionInput,
            semanticCandidates: result.candidates, semanticThreshold: config.threshold, semanticMargin: config.margin });
        return { decision, vector: { reason: result.reason, explanation: VECTOR_REASONS[result.reason] || result.reason,
            candidateCount: result.candidates?.length || 0, queried: true } };
    }
    async function interceptor(_coreChat, contextSize, _abort, type) {
        if (disposed) return;
        clearSlot();
        const op = active, ctx = getContext();
        if (!op || !op.eligible || op.mode !== String(type || '').toLowerCase()) {
            assemblyOwner = null;
            if (op?.eligible && op.concurrentInternal) return;
            updatePreview({ stage: 'empty', reason: 'INTERNAL' }); return;
        }
        assemblyOwner = op.id;
        if (!settings().enabled) { updatePreview({ stage: 'empty', reason: 'DISABLED' }); return; }
        if (isGroupChat(ctx)) { updatePreview({ stage: 'empty', reason: 'GROUP' }); return; }
        if (!op.chatId || op.chatId !== chatIdentity(ctx)) {
            updatePreview({ stage: 'empty', reason: 'TARGET_UNKNOWN' }); return;
        }
        if (!compatible(ctx)) {
            updatePreview({ stage: 'empty', reason: 'UNSUPPORTED' }); warn('UNSUPPORTED'); return;
        }
        // START 到 interceptor 期间允许宿主追加本轮用户输入、删除重生目标和展开招呼宏。
        // 其余既有输入/来源或目标正文、swipe 改变后，旧开始事件不能接管新版本。
        const appendedUser = ['', 'normal'].includes(op.mode) && ctx.chat.length === op.startLength + 1
            && ctx.chat[op.startLength]?.is_user && !ctx.chat[op.startLength]?.extra?.from_uwu
            && !!ordinaryText(ctx.chat[op.startLength]);
        const removedTarget = op.mode === 'regenerate' && Number.isInteger(op.initialTarget)
            && ctx.chat.length === op.startLength - 1;
        if ((ctx.chat.length !== op.startLength && !appendedUser && !removedTarget)
            || !prefixMatches(op.startPrefix, ctx.chat, op.startCutoff, true)
            || (op.startTargetVersion !== null && ctx.chat[op.initialTarget]
                && replyStartSnapshot(ctx.chat[op.initialTarget], op.initialTarget) !== op.startTargetVersion)) {
            invalidate(); return;
        }
        const target = targetFor(op, ctx);
        if (!target) { updatePreview({ stage: 'empty', reason: 'TARGET_UNKNOWN' }); return; }
        Object.assign(op, target, { baseLength: ctx.chat.length, prefix: prefixSnapshot(ctx.chat, target.cutoff),
            targetVersion: ['swipe', 'continue'].includes(op.mode)
                ? messageVersion(ctx.chat[target.replyFloor]) : null });
        try {
            const scan = scanSourcesCached(ctx.chat, { chatId: op.chatId, cutoff: op.cutoff });
            if (scan.issues?.length) warn('ERROR', '有损坏的手机来源已跳过');
            let refs = topicChat === op.chatId && topicScope === op.scope && !['regenerate', 'swipe'].includes(op.mode)
                ? topicRefs : core.restoreTopicRefs(ctx.chat, scan, { cutoff: op.cutoff });
            const receipts = core.collectValidReceipts(ctx.chat, scan, {
                cutoff: op.mode === 'continue' ? op.cutoff + 1 : op.cutoff });
            // Continue 延续已有回复的采用来源；更新该标记的正文版本，不新增一个回合。
            if (op.mode === 'continue') op.priorReceipt = receipts.find(r => r.replyFloor === op.replyFloor);
            const manualRefs = manual?.chatId === op.chatId && manual.scope === op.scope ? manual.refs : [];
            manual = null;
            const decisionInput = { scan, chat: ctx.chat, query: op.query,
                userFloor: op.userFloor, mode: op.mode || 'normal', joinAllowed: op.joinAllowed,
                topicRefs: refs, receipts, manualRefs,
                roleNames: [ctx.name1, ctx.name2, ctx.characters?.[ctx.characterId]?.name].filter(Boolean) };
            const found = await decideWithVectors(decisionInput, {
                isCurrent: () => currentValid(op), signal: op.vectorAbort.signal });
            if (!found) return;
            const { decision, vector } = found;
            op.vectorReason = vector.reason;
            updatePreview({ vector, retrieval: decision.retrieval || { mode: 'keyword' } });
            if (!currentValid(op)) return;
            op.decision = decision;
            topicRefs = decision.topicRefs || []; topicChat = op.chatId; topicScope = op.scope;
            if (!decision.selected?.length) {
                updatePreview({ stage: 'empty', reason: decision.reason || 'NO_NEED', kind: decision.kind,
                    selected: [], query: op.query, chars: 0, tokens: 0 }); return;
            }
            const budget = await core.fitBudget(decision.selected, {
                countTokens: text => countOperationTokens(op, text),
                maxTokens: Math.min(1200, Number.isFinite(contextSize) ? Math.max(0, contextSize) : 1200),
                operationId: op.id, query: op.query });
            if (!currentValid(op)) return;
            if (!budget.selected?.length) {
                const reason = budget.reason || 'BUDGET';
                updatePreview({ stage: 'empty', reason, selected: [], chars: 0, tokens: 0 });
                if (/TOKEN|ERROR/.test(reason)) warn('TOKENIZER_ERROR');
                return;
            }
            if (op.supplementSuppressed || assemblyOwner !== op.id) {
                op.selected = []; op.omittedForConcurrency = true;
                updatePreview({ stage: 'empty', reason: 'CONCURRENT_INTERNAL', selected: [], chars: 0, tokens: 0 });
                return;
            }
            op.selected = budget.selected; op.block = budget.text; op.tokens = budget.tokens;
            // 只记实际生成过补充块的编号；内部任务编号不授权删除任何正文。
            publishedOperations.add(op.operationNumber);
            knownBlocks.set(op.id, op.block);
            // 防止无限积累；旧块仅用于从其他回调数据里清掉本扩展的残留。
            if (knownBlocks.size > 8) knownBlocks.delete(knownBlocks.keys().next().value);
            contextCall('setExtensionPrompt', MEMORY_SLOT, op.block, 1,
                op.mode === 'continue' ? 2 : 1, false, 0,
                () => currentValid(op) && op.eligible && assemblyOwner === op.id);
            updatePreview({ stage: 'selected', kind: decision.kind, reason: decision.kind,
                selected: op.selected.map(s => ({ ref: s.ref, text: s.text })),
                chars: op.block.length, tokens: op.tokens, query: op.query });
        } catch (error) {
            if (active !== op) return;
            op.selected = []; clearSlot();
            updatePreview({ stage: 'empty', reason: 'ERROR', selected: [], chars: 0, tokens: 0 });
            warn('ERROR', error.message);
        }
    }
    function knownRanges(text) {
        // 槽内容经过宿主宏展开后可能与预选字符串不同；仍能按本次独有边界移除。
        // 历史里的同形标记已由核心转义，永远不按泛化标签删除其他资料。
        const ranges = [];
        for (const match of text.matchAll(/\[\[UWU_PHONE_MEMORY:([a-zA-Z0-9_-]+):BEGIN\]\]/g)) {
            const id = match[1];
            if (!id.startsWith(operationOwner)) continue;
            const serial = id.slice(operationOwner.length), number = Number(serial);
            if (!/^[1-9]\d*$/.test(serial) || !Number.isSafeInteger(number) || !publishedOperations.has(number)) continue;
            const begin = `[[UWU_PHONE_MEMORY:${id}:BEGIN]]`, end = `[[UWU_PHONE_MEMORY:${id}:END]]`;
            const to = text.indexOf(end, match.index + begin.length);
            if (to !== -1) ranges.push({ start: match.index, end: to + end.length });
        }
        for (const block of knownBlocks.values()) {
            if (!block) continue;
            for (let from = text.indexOf(block); from !== -1; from = text.indexOf(block, from + block.length))
                ranges.push({ start: from, end: from + block.length });
        }
        const merged = [];
        for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
            const last = merged.at(-1);
            if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
            else merged.push({ ...range });
        }
        return merged;
    }
    function withoutKnown(text) {
        for (const range of knownRanges(text).reverse()) text = text.slice(0, range.start) + text.slice(range.end);
        return text;
    }
    async function prune(actual, shape, dryRun = false, sending = false, requestType, hasRequestType = false, getActual = () => actual) {
        const op = active;
        const assembledBlock = op?.block;
        const sentAtEntry = op?.sent;
        const initialActual = actual;
        let texts, replace, readTexts;
        if (shape === 'messages') {
            if (!Array.isArray(actual)) return;
            // 同一消息的多个文本部分共同构成原文；图片和工具信息保持原样。
            readTexts = () => Array.isArray(actual) ? actual.map(m => contentTexts(m?.content).join('')) : null;
            texts = readTexts();
            replace = fn => {
                actual = getActual();
                if (!Array.isArray(actual)) return;
                for (let i = actual.length - 1; i >= 0; i--) {
                    const m = actual[i];
                    if (!m || typeof m !== 'object' || !('content' in m)) continue;
                    const previous = contentTexts(m.content).join('');
                    m.content = mapContent(m.content, fn, knownRanges(previous));
                    // 只有本扩展移除后变空的纯消息才删除；别的空消息不归本扩展处理。
                    const hasMedia = Array.isArray(m.content) && m.content.some(part => typeof part === 'object' && !TEXT_CONTENT_TYPES.has(part?.type));
                    if (previous && !contentTexts(m.content).join('').trim()
                        && previous !== contentTexts(m.content).join('') && !hasMedia && !m.tool_calls) actual.splice(i, 1);
                }
            };
        } else {
            const field = shape === 'input' ? 'input' : 'prompt';
            if (typeof actual?.[field] !== 'string') return;
            readTexts = () => typeof actual?.[field] === 'string' ? [actual[field]] : null;
            texts = readTexts(); replace = fn => { if (typeof actual?.[field] === 'string') actual[field] = fn(actual[field]); };
        }
        const requestSnapshot = JSON.stringify(texts);
        const normalizeMode = mode => !mode || mode === 'normal' ? 'normal' : String(mode).toLowerCase();
        const foreignRequest = hasRequestType && normalizeMode(requestType) !== normalizeMode(op?.mode);
        const occurrences = op?.block ? texts.reduce((n, t) => n + t.split(op.block).length - 1, 0) : 0;
        // generateRaw 的后台 CC 不发 START，却也会发无 type 的组装事件。
        // 已发送的主请求不再接受组装回调改写采用证据。
        if (op?.eligible && op.sent && (!sending || dryRun || foreignRequest || occurrences !== 1
            || (shape === 'messages' && !hasRequestType))) { replace(withoutKnown); return; }
        if (op?.eligible && (foreignRequest || (op.concurrentInternal && dryRun)
            || (op.concurrentInternal && sending && !hasRequestType))) {
            replace(withoutKnown);
            // 只有有归属的最终后台数据到达，主预算稍后完成时才可以恢复主组装。
            if (sending || dryRun) assemblyOwner = op.id;
            return;
        }
        // CC 的组装事件没有 type；并行时由有 type 的最终 SETTINGS 事件完成复核。
        if (op?.eligible && op.concurrentInternal && shape === 'messages' && !sending && !dryRun) return;
        if (op?.eligible && op.supplementSuppressed) {
            replace(withoutKnown); op.selected = []; clearSlot();
            updatePreview({ stage: 'empty', reason: 'CONCURRENT_INTERNAL', selected: [], chars: 0, tokens: 0 });
            return;
        }
        if (dryRun || !op?.eligible || !currentValid(op) || occurrences !== 1) {
            replace(withoutKnown);
            if (op?.selected?.length) {
                // 连同块版本一起作废，等待 token 的旧回调不能复活已省略的选择。
                op.selected = []; op.sent = false; op.block = ''; op.tokens = 0; clearSlot();
                updatePreview({ stage: 'removed', reason: dryRun ? 'INTERNAL'
                    : occurrences !== 1 ? (op.omittedForConcurrency ? 'CONCURRENT_INTERNAL' : 'NOT_RETAINED') : 'SOURCE_CHANGED', selected: [], chars: 0, tokens: 0 });
            }
            return;
        }
        // 在实际组装和发送数据上重复检查；只能删本扩展内容。
        const scan = scanSourcesCached(getContext().chat, { chatId: op.chatId, cutoff: op.cutoff });
        const valid = core.validateSelection(op.selected, scan);
        const covered = core.filterCovered(valid, texts.map(withoutKnown));
        const kept = covered.selected;
        let next = kept.length ? core.buildMemoryBlock(kept, { operationId: op.id }) : '';
        let tokens = 0, removalReason = valid.length ? 'COVERED' : 'SOURCE_CHANGED';
        try {
            if (next) tokens = await countOperationTokens(op, next);
            if (next && (!Number.isFinite(tokens) || tokens < 0)) throw new Error('invalid token count');
        } catch (error) {
            next = ''; removalReason = 'TOKENIZER_ERROR';
            if (currentValid(op)) warn('TOKENIZER_ERROR');
        }
        if (!currentValid(op) || active !== op) { replace(withoutKnown); return; }
        // 另一份最终数据可能在 token 等待期间已确认主请求发送。
        // 迟到组装只清理自己的副本，不能把 sent 或实际采用来源退回未发送状态。
        if (op.sent && !sentAtEntry) { replace(withoutKnown); return; }
        // tokenizer 会让出执行权；其他扩展可原地编辑或替换同一份实际数据。
        // 旧计数不能确认修改后的请求仍只含一份补充或未覆盖原文。
        actual = getActual();
        if (actual !== initialActual || JSON.stringify(readTexts()) !== requestSnapshot) {
            replace(withoutKnown);
            op.selected = []; op.sent = false; op.block = ''; op.tokens = 0; clearSlot();
            updatePreview({ stage: 'removed', reason: 'NOT_RETAINED', selected: [], chars: 0, tokens: 0 });
            return;
        }
        // token 复核会让出执行权。期间后台开始或另一份组装可能已清空/裁短本轮块，
        // 迟到的结果不能恢复旧选择，更不能把 TC 的无归属后台材料当作主请求。
        if (op.supplementSuppressed || op.block !== assembledBlock) {
            replace(withoutKnown);
            if (op.supplementSuppressed) {
                op.selected = []; clearSlot();
                updatePreview({ stage: 'empty', reason: 'CONCURRENT_INTERNAL', selected: [], chars: 0, tokens: 0 });
            }
            return;
        }
        // 组装后不增字符或token，严格不重新选段。
        if (next.length > op.block.length || tokens > op.tokens || next.length > 1800 || tokens > 1200) {
            next = ''; removalReason = 'BUDGET';
        }
        const previous = op.block;
        replace(text => text.split(previous).join(next));
        op.block = next; op.selected = next ? kept : []; op.tokens = next ? tokens : 0;
        if (next) knownBlocks.set(op.id, next);
        // 仍留旧block以便不同shape的回调拿到较早的组装副本时清理。
        if (previous !== next) knownBlocks.set(`${op.id}_previous`, previous);
        op.sent = sending && !!next;
        if (!next) clearSlot();
        updatePreview({ stage: next ? (sending ? 'retained' : 'assembled') : 'removed',
            reason: next ? op.decision.kind : removalReason,
            selected: op.selected.map(s => ({ ref: s.ref, text: s.text })),
            chars: next.length, tokens: op.tokens });
    }
    function replyRendered(floor, type) {
        const op = active;
        if (!op || (!op.sent && !op.priorReceipt) || !Number.isInteger(Number(floor)) || Number(floor) !== op.replyFloor) return;
        if (type && ![op.mode, 'normal', 'append', 'appendFinal', 'continue', 'swipe'].includes(type)) return;
        const reply = getContext()?.chat?.[op.replyFloor];
        if (!core.isCompletedReply(reply)) return;
        op.replySeen = true;
        op.replyVersion = messageVersion(reply);
        // 流式完成或并行后台请求可能先发 ENDED；仍以主回复落地为成功证据。
        if (op.ended && (op.streamSucceeded || op.waitingMainRender)) {
            return Promise.resolve().then(() => finish(op));
        }
    }
    function stop() {
        if (active) { active.invalid = true; active.selected = []; active.vectorAbort?.abort(); active.abortCleanup?.(); }
        active = null; assemblyOwner = null; sequence++; clearSlot();
        updatePreview({ stage: 'cancelled', reason: 'CANCELLED', selected: [], chars: 0, tokens: 0 });
    }
    async function ended() {
        const op = active;
        clearSlot();
        if (!op) return;
        op.ended = true;
        const stream = getContext()?.streamingProcessor;
        if (stream) {
            op.streamSucceeded = stream.isFinished === true && !stream.isStopped && !stream.abortController?.signal?.aborted;
            if (!op.streamSucceeded) { op.abortCleanup?.(); active = null; return; }
            if (!op.replySeen) return;
        }
        // 非流式 quiet 完成也会隐藏停止按钮，可能抢先发出唯一的 ENDED。
        // 此时不能把尚未落地的主回复算成功，也不能丢弃它的发送证据。
        if (!stream && op.concurrentInternal && !op.replySeen) {
            op.waitingMainRender = true; return;
        }
        // stopGeneration 会先不等待地发 ENDED，再发 STOPPED；让同次取消先撤销操作。
        await Promise.resolve();
        return finish(op);
    }
    async function finish(op) {
        if (active !== op || op.saving) return;
        op.saving = true;
        let savedReply = null, savedReplyVersion = null;
        const savedReplyStillCurrent = () => !savedReply || (getContext()?.chat?.[op.replyFloor] === savedReply
            && messageVersion(savedReply) === savedReplyVersion);
        try {
            const ctx = getContext(), message = ctx?.chat?.[op.replyFloor];
            if ((!op.sent && !op.priorReceipt) || !op.replySeen || (!op.selected.length && !op.priorReceipt) || !currentValid(op, true)
                || !core.isCompletedReply(message)
                || messageVersion(message) !== op.replyVersion
                || ctx.chat.length !== op.replyFloor + 1) return;
            const scan = scanSourcesCached(ctx.chat, { chatId: op.chatId, cutoff: op.cutoff });
            const previous = (op.priorReceipt?.sources || []).map(ref => {
                const source = scan.sources.find(s => s.key === ref.sourceKey);
                return { ref, floor: ref.floor, text: source?.body.slice(ref.start, ref.end) || '' };
            });
            const selected = core.validateSelection([...previous, ...op.selected], scan)
                .filter((s, index, all) => all.findIndex(x => JSON.stringify(x.ref) === JSON.stringify(s.ref)) === index);
            if (!selected.length) return;
            const receipt = core.createReceipt({ chatId: op.chatId, userFloor: op.userFloor,
                replyFloor: op.replyFloor, swipeId: message.swipe_id ?? 0, replyText: messageText(message), selected,
                userText: op.query,
                ...(op.priorReceipt?.userFingerprint ? { userFingerprint: op.priorReceipt.userFingerprint } : {}) });
            message.extra ||= {};
            message.extra[MEMORY_SLOT] = receipt;
            // extra会随酒馆的swipe切换；每个版本各自保存采用标记。
            if (Array.isArray(message.swipe_info)) {
                const info = message.swipe_info[message.swipe_id ?? 0];
                if (info) { info.extra ||= {}; info.extra[MEMORY_SLOT] = clone(receipt); }
            }
            const save = host.saveChat || ctx.saveChat;
            if (typeof save !== 'function') throw new Error('酒馆未提供保存聊天方法');
            savedReply = message; savedReplyVersion = op.replyVersion;
            updatePreview({ stage: 'completed', persistence: 'saving' });
            const result = await save.call(ctx);
            // 保存可能跨越切账号、换聊、来源更新或下一次生成；结果只属于原操作。
            if (!currentValid(op, true) || !savedReplyStillCurrent()) {
                if (active === op) invalidate();
                return;
            }
            if (result === false || result?.ok === false) throw new Error('酒馆报告保存失败');
            if (active === op && chatIdentity(getContext()) === op.chatId) {
                // 有些酒馆版本saveChat会吞掉错误，void不能冒充已确认持久保存。
                updatePreview({ persistence: result === true || result?.ok === true ? 'saved' : 'requested' });
            }
        } catch (error) {
            if (!currentValid(op, true) || !savedReplyStillCurrent()) {
                if (active === op) invalidate();
                return;
            }
            if (active === op) updatePreview({ persistence: 'failed', saveError: error.message });
            warn('SAVE_FAILED', error.message);
        } finally {
            op.abortCleanup?.();
            if (active === op) active = null;
        }
    }
    function availableSources({ query = '', recentFirst = false } = {}) {
        const ctx = getContext(), chatId = chatIdentity(ctx);
        if (!chatId) return [];
        const words = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const units = scanSourcesCached(ctx.chat, { chatId }).units.filter(source =>
            words.every(word => source.text.toLocaleLowerCase().includes(word)));
        if (recentFirst) units.sort((a, b) => b.floor - a.floor || b.start - a.start);
        return units.map(source => ({ ref: source.ref, text: source.text }));
    }
    function cancelTrial() {
        trialJob?.vectorAbort.abort();
        trialJob = null;
    }
    async function trialRecall(query, { contextSize = 1200 } = {}) {
        cancelTrial();
        const startedAt = Date.now();
        const empty = reason => ({ stage: 'trial', adopted: false, reason,
            explanation: REASONS[reason] || ({ EMPTY_QUERY: '请先输入一句要试查的话', BUSY: '角色正在生成，请等本次回复结束后试查' }[reason]) || reason,
            selected: [], chars: 0, tokens: 0 });
        if (disposed) return empty('CANCELLED');
        query = String(query || '').trim();
        if (!query) return empty('EMPTY_QUERY');
        if (!settings().enabled) return empty('DISABLED');
        const ctx = getContext(), chatId = chatIdentity(ctx), scope = userScope();
        const trialConfig = vectorSettings();
        if (isGroupChat(ctx)) return empty('GROUP');
        if (!chatId) return empty('TARGET_UNKNOWN');
        if (active?.eligible && !active.invalid) return empty('BUSY');
        const job = { vectorAbort: new AbortController(), profile: vectorProfileSnapshot(), chatId, scope,
            snapshot: JSON.stringify(ctx.chat) };
        trialJob = job;
        const isCurrent = () => !disposed && trialJob === job && !job.vectorAbort.signal.aborted
            && settings().enabled && chatIdentity(getContext()) === chatId && userScope() === scope
            && vectorProfileSnapshot() === job.profile && JSON.stringify(getContext()?.chat) === job.snapshot;
        const finish = result => {
            trialEvidence.set(result, { profile: recallProfileKey(trialConfig), chatId, snapshot: job.snapshot,
                threshold: trialConfig.threshold, margin: trialConfig.margin,
                elapsedMs: Math.max(0, Date.now() - startedAt), vectorQueried: result.vector?.queried === true });
            return result;
        };
        try {
            // 只给副本追加试查输入。手选、主题和采用记录均只读，不消费下一次正式补充。
            const chat = clone(ctx.chat);
            chat.push({ name: ctx.name1 || '我', is_user: true, mes: query, extra: {} });
            const scan = scanSourcesCached(chat, { chatId });
            const decisionInput = { scan, chat, query, userFloor: chat.length - 1, mode: 'normal',
                topicRefs: clone(topicChat === chatId && topicScope === scope ? topicRefs : core.restoreTopicRefs(chat, scan)),
                receipts: core.collectValidReceipts(chat, scan), manualRefs: [],
                roleNames: [ctx.name1, ctx.name2, ctx.characters?.[ctx.characterId]?.name].filter(Boolean) };
            const found = await decideWithVectors(decisionInput, { isCurrent, signal: job.vectorAbort.signal });
            if (!found || !isCurrent()) return empty('SOURCE_CHANGED');
            const { decision, vector } = found;
            const result = { ...empty(decision.reason || 'NO_NEED'), query, kind: decision.kind,
                vector, retrieval: decision.retrieval || { mode: 'keyword' },
                candidateCount: decision.candidates?.length || 0 };
            if (!decision.selected?.length) return finish(result);
            const budget = await core.fitBudget(decision.selected, {
                countTokens: text => isCurrent() ? countOperationTokens(job, text) : Promise.reject(new Error('CANCELLED')),
                maxTokens: Math.min(1200, Number.isFinite(contextSize) ? Math.max(0, contextSize) : 1200),
                operationId: 'trial', query });
            if (!isCurrent()) return empty('SOURCE_CHANGED');
            return finish({ ...result, reason: budget.selected?.length ? decision.kind : budget.reason || 'BUDGET',
                explanation: REASONS[budget.selected?.length ? decision.kind : budget.reason || 'BUDGET'] || budget.reason,
                selected: (budget.selected || []).map(source => ({ ref: clone(source.ref), text: source.text })),
                chars: budget.chars || 0, tokens: budget.tokens });
        } catch { return empty(isCurrent() ? 'ERROR' : 'SOURCE_CHANGED'); }
        finally { if (trialJob === job) trialJob = null; }
    }
    function selectManual(refs) {
        if (disposed) return false;
        getPreview();
        const ctx = getContext(), chatId = chatIdentity(ctx);
        if (!chatId || !settings().enabled || !Array.isArray(refs)) return false;
        manual = { chatId, scope: userScope(), refs: clone(refs) };
        previewOwner = { scope: manual.scope, chatId };
        updatePreview({ stage: 'manual', reason: 'MANUAL' }); return true;
    }
    const MEMORY_ICON_SVG = `<svg class="uwu-memory-svg-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="2.5" width="12.5" height="19" rx="2.8"/><path d="M9.2 18.2h3.1"/><path d="M8 7.2h5.5"/><path d="M8 10.6h3.5"/><circle cx="17.2" cy="14.2" r="3.3" fill="var(--SmartThemeBlurTintColor,#222)"/><path d="M19.6 16.6L21.5 18.5"/></svg>`;
    function createMemoryIcon(doc) {
        const wrap = doc.createElement('div');
        wrap.className = 'fa-fw fa-solid extensionsMenuExtensionButton uwu-memory-icon-wrap';
        wrap.setAttribute?.('aria-hidden', 'true');
        wrap.innerHTML = MEMORY_ICON_SVG;
        return wrap;
    }
    function showPreview() {
        const doc = getDocument();
        if (!doc?.body || disposed) return;
        const existing = doc.getElementById('uwu-phone-memory-preview-dialog');
        if (existing?.open) return;
        // 原生 close 事件在下一帧才派发；不要重开即将被旧 close 回调移除的节点。
        existing?.remove();
        mountMemoryStyles(doc);
        getPreview();
        const dialog = doc.createElement('dialog');
        dialog.id = 'uwu-phone-memory-preview-dialog';
        dialog.className = 'uwu-memory-dialog uwu-preview-dialog';
        dialog.setAttribute?.('aria-labelledby', 'uwu-phone-memory-preview-title');
        const header = doc.createElement('div'); header.className = 'uwu-memory-header';
        const headingBox = doc.createElement('div'); headingBox.className = 'uwu-memory-heading';
        const title = doc.createElement('h3'); title.id = 'uwu-phone-memory-preview-title'; title.textContent = '本次手机剧情补充';
        headingBox.append(title);
        const closeTop = doc.createElement('button'); closeTop.className = 'menu_button uwu-dialog-close'; closeTop.textContent = '关闭';
        closeTop.addEventListener('click', () => dialog.close());
        header.append(headingBox, closeTop); dialog.append(header);

        const panel = doc.createElement('div'); panel.className = 'uwu-memory-panel'; dialog.append(panel);
        const summaryCard = doc.createElement('section'); summaryCard.className = 'uwu-memory-card';
        const description = doc.createElement('p'); description.className = 'uwu-memory-status-banner';
        const stageNames = { manual: '已指定下一次补充来源', cancelled: '本次生成已取消', selected: '已预选，等待组装', assembled: '组装中保留，等待发送检查',
            retained: '发送数据中保留', completed: '本次回复已完成', empty: '本次没有补充', removed: '本次补充已移除' };
        description.textContent = `${stageNames[preview.stage] || '本次没有发送补充'} · ${REASONS[preview.reason] || preview.reason}（${preview.chars} 字符 / ${preview.tokens} tokens）`;
        summaryCard.append(description);
        if (preview.vector) {
            const p = doc.createElement('p'); p.className = 'uwu-memory-help';
            p.textContent = preview.vector.explanation || VECTOR_REASONS[preview.vector.reason] || preview.vector.reason;
            summaryCard.append(p);
        }
        if (preview.persistence) {
            const p = doc.createElement('p'); p.className = 'uwu-memory-help';
            p.textContent = { saving: '正在保存采用标记', saved: '采用标记已保存',
                requested: '已请求酒馆保存采用标记；宿主未返回持久保存确认', failed: '采用标记保存失败，刷新后可能无法沿用这次重复抑制' }[preview.persistence];
            summaryCard.append(p);
        }
        for (const source of preview.selected || []) {
            const p = doc.createElement('pre'); p.className = 'uwu-memory-snippet';
            p.textContent = `来源：聊天第 ${source.ref?.floor + 1} 楼\n${source.text}`; summaryCard.append(p);
        }
        const details = doc.createElement('details'), summary = doc.createElement('summary'), data = doc.createElement('pre');
        details.className = 'uwu-memory-advanced';
        summary.textContent = '技术明细'; data.className = 'uwu-memory-snippet';
        data.textContent = JSON.stringify(getPreview(), null, 2);
        details.append(summary, data); summaryCard.append(details);
        const diagnosticButton = doc.createElement('button'); diagnosticButton.type = 'button';
        diagnosticButton.id = 'uwu-phone-memory-copy-diagnostic'; diagnosticButton.className = 'menu_button';
        diagnosticButton.textContent = '复制召回诊断摘要';
        const diagnosticStatus = doc.createElement('p'); diagnosticStatus.className = 'uwu-memory-help';
        diagnosticStatus.setAttribute?.('role', 'status');
        diagnosticButton.addEventListener('click', async () => {
            const summaryText = getDiagnosticSummary();
            try {
                const clipboard = host.clipboard === undefined ? globalThis.navigator?.clipboard : host.clipboard;
                if (typeof clipboard?.writeText !== 'function') throw new Error('NO_CLIPBOARD');
                await clipboard.writeText(summaryText);
                diagnosticStatus.textContent = '已复制，不含 Key、接口地址、查询或聊天原文。';
            } catch {
                let fallback = doc.getElementById('uwu-phone-memory-diagnostic-text');
                if (!fallback) {
                    fallback = doc.createElement('textarea'); fallback.id = 'uwu-phone-memory-diagnostic-text';
                    fallback.className = 'text_pole uwu-memory-search'; fallback.readOnly = true;
                    fallback.setAttribute?.('aria-label', '可手动复制的脱敏诊断摘要'); summaryCard.append(fallback);
                }
                fallback.value = summaryText; fallback.focus?.(); fallback.select?.();
                diagnosticStatus.textContent = '浏览器未允许自动复制，请长按下方摘要全选并复制。摘要不含聊天原文或 Key。';
            }
        });
        summaryCard.append(diagnosticButton, diagnosticStatus);
        panel.append(summaryCard);

        const trialCard = doc.createElement('section'); trialCard.className = 'uwu-memory-card';
        const trialTitle = doc.createElement('h4'); trialTitle.textContent = '试查一句话';
        const trialHelp = doc.createElement('p'); trialHelp.className = 'uwu-memory-help';
        trialHelp.textContent = '按下一次普通提问试查，不生成角色回复，不记为实际采用，也不改变已手选的来源。使用已保存的设置；启用向量时，查询文字会发送到向量 API，可能产生费用。正式发送时仍会重新检查已有原文和剩余长度。';
        const trialInput = doc.createElement('input'); trialInput.type = 'text'; trialInput.className = 'text_pole uwu-memory-search';
        trialInput.id = 'uwu-phone-memory-trial-query'; trialInput.placeholder = '例如：之前约好的桂花咖啡店几点见';
        trialInput.setAttribute?.('aria-label', '要试查的一句话');
        const trialButton = doc.createElement('button'); trialButton.type = 'button'; trialButton.className = 'menu_button';
        trialButton.id = 'uwu-phone-memory-trial-run'; trialButton.textContent = '试查'; trialButton.disabled = !settings().enabled;
        const trialResult = doc.createElement('div'); trialResult.id = 'uwu-phone-memory-trial-result';
        trialResult.className = 'uwu-memory-source-list'; trialResult.setAttribute?.('role', 'status');
        const trialActions = doc.createElement('div'); trialActions.className = 'uwu-memory-actions'; trialActions.append(trialButton);
        const expected = doc.createElement('select'); expected.id = 'uwu-phone-memory-trial-expected'; expected.className = 'text_pole';
        expected.setAttribute?.('aria-label', '这条样例预期是否补充');
        for (const [value, caption] of [['recall', '预期：应找到旧事'], ['omit', '预期：不应补充']]) {
            const option = doc.createElement('option'); option.value = value; option.textContent = caption; expected.append(option);
        }
        expected.value = 'recall';
        const correctLabel = doc.createElement('label'); correctLabel.className = 'uwu-memory-field';
        const correct = doc.createElement('select'); correct.className = 'text_pole'; correct.id = 'uwu-phone-memory-trial-correct';
        const correctText = doc.createElement('span'); correctText.className = 'uwu-memory-field-title'; correctText.textContent = '人工核对来源';
        for (const [value, caption] of [['unchecked', '尚未核对 / 找错旧事'], ['correct', '已核对，是正确旧事']]) {
            const option = doc.createElement('option'); option.value = value; option.textContent = caption; correct.append(option);
        }
        correct.value = 'unchecked'; correctLabel.append(correctText, correct);
        const record = doc.createElement('button'); record.type = 'button'; record.className = 'menu_button';
        record.id = 'uwu-phone-memory-trial-record'; record.textContent = '记录本次对照'; record.disabled = true;
        const evaluationStatus = doc.createElement('p'); evaluationStatus.className = 'uwu-memory-help';
        evaluationStatus.setAttribute?.('role', 'status');
        const showEvaluation = () => {
            const records = getRecallEvaluation().evaluations;
            evaluationStatus.textContent = `当前模型记录 ${records.length} 次对照，${records.filter(item => item.correct).length} 次符合预期。只记录编号、预期、结果和参数，不保存查询或原文；这是人工对照记录，不是已完成真实验收。`;
        };
        showEvaluation();
        const evaluationHelp = doc.createElement('p'); evaluationHelp.className = 'uwu-memory-help';
        evaluationHelp.textContent = '校准：先选预期，再分别试查相关改写和无关问题；核对来源后记录。误补时提高门槛，漏补时先检查索引再小幅调整，保存后重试。仅点“试查”才查询，不自动批量运行。';
        let latestTrial = null;
        record.addEventListener('click', () => {
            if (recordTrialEvaluation(latestTrial, { expected: expected.value, correctSource: correct.value === 'correct' })) {
                record.disabled = true; showEvaluation();
            } else { record.disabled = true; evaluationStatus.textContent = '设置、聊天或样例已改变，请重新试查后记录。'; }
        });
        let trialUiEpoch = 0, dialogTrialJob = null;
        const cancelDialogTrial = () => {
            if (dialogTrialJob && trialJob === dialogTrialJob) cancelTrial();
            dialogTrialJob = null;
        };
        trialInput.addEventListener('input', () => {
            trialUiEpoch++; cancelDialogTrial(); trialResult.textContent = ''; trialButton.disabled = !settings().enabled;
            latestTrial = null; record.disabled = true; correct.value = 'unchecked';
        });
        trialButton.addEventListener('click', async () => {
            const epoch = ++trialUiEpoch;
            latestTrial = null; record.disabled = true; correct.value = 'unchecked';
            trialButton.disabled = true; trialResult.textContent = '正在试查，尚未采用…';
            const pending = trialRecall(trialInput.value); dialogTrialJob = trialJob;
            const result = await pending;
            if (disposed || !dialog.open || trialUiEpoch !== epoch) return;
            latestTrial = result; record.disabled = !trialEvidence.has(result);
            trialResult.textContent = '';
            const status = doc.createElement('p'); status.className = 'uwu-memory-help';
            status.textContent = `试查结果，未发送、未采用：${result.explanation}。${result.chars} 字符 / ${result.tokens ?? '未确认'} tokens。`;
            trialResult.append(status);
            if (result.vector) {
                const vectorHint = doc.createElement('p'); vectorHint.className = 'uwu-memory-help';
                vectorHint.textContent = result.vector.explanation; trialResult.append(vectorHint);
            }
            for (const source of result.selected) {
                const text = doc.createElement('pre'); text.className = 'uwu-memory-snippet';
                text.textContent = `来源：聊天第 ${source.ref.floor + 1} 楼\n${source.text}`; trialResult.append(text);
            }
            trialButton.disabled = !settings().enabled;
        });
        trialCard.append(trialTitle, trialHelp, evaluationHelp, expected, trialInput, trialActions, trialResult,
            correctLabel, record, evaluationStatus); panel.append(trialCard);

        const manualCard = doc.createElement('section'); manualCard.className = 'uwu-memory-card';
        const manualTitle = doc.createElement('h4'); manualTitle.textContent = '手动指定下一次补充来源';
        const help = doc.createElement('p'); help.className = 'uwu-memory-help';
        help.textContent = '自动定位失败时，展开来源列表，搜索并勾选所需片段，再点「下次补充所选来源」。手动选择不限段数，只用于下一次主回复。补充总长仍不超过 1800 字符、1200 tokens，超出时可能省略部分所选内容；仍会检查来源和已有内容。';
        if (!settings().enabled) help.textContent = '剧情补充已关闭，开启「按需补充手机剧情」后可手动指定来源。';
        manualCard.append(manualTitle, help);
        const selectedSources = new Map();
        const sources = availableSources({ recentFirst: true });
        if (sources.length) {
            const browser = doc.createElement('details'); browser.id = 'uwu-phone-memory-source-browser';
            browser.className = 'uwu-memory-source-browser';
            const browserTitle = doc.createElement('summary');
            browserTitle.textContent = `展开来源列表（共 ${sources.length} 段）`;
            const browserBody = doc.createElement('div'); browserBody.className = 'uwu-memory-source-browser-body';
            const search = doc.createElement('input'); search.type = 'search'; search.className = 'text_pole uwu-memory-search';
            search.id = 'uwu-phone-memory-source-search'; search.placeholder = '输入关键词找来源，多个词用空格分开';
            search.setAttribute?.('aria-label', '搜索已推送手机来源');
            const sourceCount = doc.createElement('p'); sourceCount.className = 'uwu-memory-help'; sourceCount.setAttribute?.('role', 'status');
            sourceCount.id = 'uwu-phone-memory-source-count';
            const list = doc.createElement('div'); list.className = 'uwu-memory-source-list';
            list.id = 'uwu-phone-memory-source-list';
            const pagination = doc.createElement('div'); pagination.className = 'uwu-memory-source-pagination';
            const previous = doc.createElement('button'); previous.type = 'button'; previous.className = 'menu_button';
            previous.id = 'uwu-phone-memory-source-prev'; previous.textContent = '上一页';
            const pageStatus = doc.createElement('span'); pageStatus.id = 'uwu-phone-memory-source-page';
            pageStatus.setAttribute?.('role', 'status');
            const next = doc.createElement('button'); next.type = 'button'; next.className = 'menu_button';
            next.id = 'uwu-phone-memory-source-next'; next.textContent = '下一页';
            pagination.append(previous, pageStatus, next);
            const selection = doc.createElement('p'); selection.className = 'uwu-memory-help';
            selection.id = 'uwu-phone-memory-source-selection'; selection.setAttribute?.('role', 'status');
            selection.textContent = '已选 0 段。翻页、搜索或收起列表都会保留选择。';
            const selectedList = doc.createElement('div'); selectedList.className = 'uwu-memory-selected-sources';
            const entries = sources.map((source, index) => ({ source, index, text: source.text.toLocaleLowerCase() }));
            const pageSize = 20, visibleChecks = new Map();
            let matches = entries, page = 0, rendered = false;
            const updateSelection = () => {
                const count = selectedSources.size;
                selection.textContent = `已选 ${count} 段。翻页、搜索或收起列表都会保留选择。`;
                use.disabled = !settings().enabled || !count;
                selectedList.textContent = '';
                for (const [index, source] of selectedSources) {
                    const item = doc.createElement('div'); item.className = 'uwu-memory-selected-source';
                    const text = doc.createElement('span');
                    text.textContent = `第 ${source.ref?.floor + 1} 楼：${source.text.slice(0, 60)}${source.text.length > 60 ? '…' : ''}`;
                    const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'menu_button';
                    remove.textContent = '移除'; remove.setAttribute?.('aria-label', `移除第 ${source.ref?.floor + 1} 楼的所选来源`);
                    remove.addEventListener('click', () => { selectedSources.delete(index); updateSelection(); });
                    item.append(text, remove); selectedList.append(item);
                }
                for (const [index, input] of visibleChecks) input.checked = selectedSources.has(index);
            };
            const renderSources = () => {
                rendered = true;
                const pageCount = Math.ceil(matches.length / pageSize);
                page = Math.max(0, Math.min(page, pageCount - 1));
                const start = page * pageSize, end = Math.min(start + pageSize, matches.length);
                sourceCount.textContent = `${search.value.trim() ? `找到 ${matches.length} 段（共 ${sources.length} 段）` : `共 ${sources.length} 段`}，最近的排在前面，每页 ${pageSize} 段。`;
                pageStatus.textContent = pageCount ? `第 ${page + 1} / ${pageCount} 页 · ${start + 1}-${end} 段` : '没有匹配结果';
                previous.disabled = page === 0; next.disabled = !pageCount || page >= pageCount - 1;
                list.textContent = ''; visibleChecks.clear();
                if (!matches.length) {
                    const empty = doc.createElement('p'); empty.className = 'uwu-memory-help';
                    empty.textContent = '没有匹配来源，换个关键词试试。已勾选的来源仍会保留。'; list.append(empty);
                }
                for (const { source, index } of matches.slice(start, end)) {
                    const row = doc.createElement('div'); row.className = 'uwu-memory-source-row';
                    const label = doc.createElement('label'), input = doc.createElement('input'), textSpan = doc.createElement('span');
                    label.className = 'uwu-memory-check'; input.type = 'checkbox';
                    input.checked = selectedSources.has(index); input.disabled = !settings().enabled;
                    input.addEventListener('change', () => {
                        if (input.checked) selectedSources.set(index, source);
                        else if (!input.checked) selectedSources.delete(index);
                        updateSelection();
                    });
                    visibleChecks.set(index, input);
                    const shortened = source.text.length > 180;
                    textSpan.className = 'uwu-memory-check-text';
                    textSpan.textContent = `第 ${source.ref?.floor + 1} 楼：${source.text.slice(0, 180)}${shortened ? '…' : ''}`;
                    label.append(input, textSpan); row.append(label);
                    if (shortened) {
                        const full = doc.createElement('details'); full.className = 'uwu-memory-advanced';
                        const caption = doc.createElement('summary'); caption.textContent = `展开全文（共 ${source.text.length} 字符）`;
                        const body = doc.createElement('pre'); body.className = 'uwu-memory-snippet'; body.textContent = source.text;
                        full.append(caption, body); row.append(full);
                    }
                    list.append(row);
                }
            };
            browser.addEventListener('toggle', () => {
                browserTitle.textContent = `${browser.open ? '收起' : '展开'}来源列表（共 ${sources.length} 段）`;
                if (browser.open && !rendered) renderSources();
            });
            search.addEventListener('input', () => {
                const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
                matches = entries.filter(({ text }) => words.every(word => text.includes(word)));
                page = 0; renderSources();
            });
            previous.addEventListener('click', () => {
                if (page > 0) { page--; renderSources(); list.scrollIntoView?.({ block: 'start' }); }
            });
            next.addEventListener('click', () => {
                if ((page + 1) * pageSize < matches.length) { page++; renderSources(); list.scrollIntoView?.({ block: 'start' }); }
            });
            browserBody.append(search, sourceCount, list, pagination); browser.append(browserTitle, browserBody);
            manualCard.append(browser, selection, selectedList);
        } else {
            const emptyHint = doc.createElement('p'); emptyHint.className = 'uwu-memory-help';
            emptyHint.textContent = '当前聊天暂无可选的已推送手机记录。';
            manualCard.append(emptyHint);
        }
        panel.append(manualCard);

        const footer = doc.createElement('div'); footer.className = 'uwu-memory-footer';
        const footerBtns = doc.createElement('div'); footerBtns.className = 'uwu-memory-actions';
        const use = doc.createElement('button'); use.className = 'menu_button uwu-memory-primary'; use.textContent = '下次补充所选来源';
        use.id = 'uwu-phone-memory-use-sources'; use.disabled = true;
        use.addEventListener('click', () => {
            if (selectManual([...selectedSources.values()].map(source => source.ref))) dialog.close();
        });
        const close = doc.createElement('button'); close.className = 'menu_button uwu-dialog-close'; close.textContent = '关闭';
        close.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', () => {
            trialUiEpoch++; cancelDialogTrial(); dialog.remove();
        });
        footerBtns.append(use, close); footer.append(footerBtns); dialog.append(footer);
        doc.body.append(dialog); dialog.showModal();
    }
    function mountMemoryStyles(doc) {
        if (doc.getElementById('uwu-phone-memory-ui-style')) return;
        const style = doc.createElement('style'); style.id = 'uwu-phone-memory-ui-style';
        // Scope layout rules to our controls so host themes cannot stretch buttons or checkboxes.
        style.textContent = `
            #uwu-phone-vector-dialog, .uwu-memory-dialog {
                --uwu-memory-accent:var(--SmartThemeQuoteColor,#8ab4f8);
                --uwu-memory-panel-gap:12px;
                --uwu-memory-item-gap:8px;
                --uwu-memory-sub-gap:6px;
                --uwu-memory-label-gap:4px;
                box-sizing:border-box;width:580px;max-width:calc(100vw - 24px);
                max-height:88vh;max-height:88dvh;overflow:auto;padding:0;
                border:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 75%,transparent);border-radius:16px;
                background:var(--SmartThemeBlurTintColor,#222);color:var(--SmartThemeBodyColor,#eee);
                box-shadow:0 20px 60px rgba(0,0,0,.48);font:inherit;line-height:1.5;text-align:left;
            }
            #uwu-phone-vector-dialog::backdrop, .uwu-memory-dialog::backdrop { background:rgba(0,0,0,.55);backdrop-filter:blur(4px); }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) * { box-sizing:border-box; }
            #uwu-phone-vector-menu { align-items:center !important;flex-wrap:nowrap; }
            #uwu-phone-vector-menu .uwu-memory-icon-wrap {
                display:inline-flex;align-items:center;justify-content:center;
                color:inherit;flex:0 0 auto;align-self:center;
            }
            #uwu-phone-vector-menu .uwu-memory-svg-icon { width:18px;height:18px;flex:0 0 18px;display:block; }
            #uwu-phone-vector-menu .uwu-memory-menu-label { display:block;align-self:center; }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-header {
                position:sticky;top:0;z-index:2;display:flex;align-items:center !important;
                justify-content:space-between;gap:16px;padding:14px 18px;
                background:color-mix(in srgb,var(--SmartThemeBlurTintColor,#222) 94%,var(--SmartThemeBodyColor,#eee) 6%);
                border-bottom:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 60%,transparent);
                backdrop-filter:blur(10px);
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-heading { display:flex;flex-direction:column;gap:2px;min-width:0;margin:0;padding:0; }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) h3 { margin:0 !important;padding:0;font-size:16px;font-weight:600;line-height:1.35; }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-subtitle { margin:0 !important;padding:0;font-size:12px;opacity:.68; }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-panel {
                display:flex;flex-direction:column;gap:var(--uwu-memory-panel-gap);padding:14px 18px;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-card {
                display:flex;flex-direction:column;gap:var(--uwu-memory-item-gap);
                min-width:0;padding:14px 16px;border:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 55%,transparent);border-radius:12px;
                background:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 3.5%,transparent);
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) h4 {
                margin:0 !important;padding:0;font-size:13px;font-weight:600;letter-spacing:.02em;line-height:1.35;opacity:.9;
            }
            #uwu-phone-vector-dialog .uwu-memory-model-group {
                display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--uwu-memory-item-gap);align-items:stretch;
            }
            #uwu-phone-vector-dialog .uwu-memory-model-group > :is(.text_pole,.menu_button) { height:36px;min-height:36px; }
            #uwu-phone-vector-dialog .uwu-memory-model-status { margin:0 !important;font-size:12px;line-height:1.5;overflow-wrap:anywhere; }
            #uwu-phone-vector-dialog :is(.uwu-memory-model-options,.uwu-memory-model-status)[hidden] { display:none !important; }
            #uwu-phone-vector-dialog .uwu-memory-field {
                display:flex;flex-direction:column;gap:var(--uwu-memory-label-gap);min-width:0;margin:0 !important;padding:0;
            }
            #uwu-phone-vector-dialog .uwu-memory-field-title {
                margin:0 !important;padding:0;font-size:12px;font-weight:500;line-height:1.35;opacity:.88;
            }
            #uwu-phone-vector-dialog .uwu-memory-field .text_pole {
                display:block;width:100%;min-width:0;height:36px;min-height:36px;margin:0 !important;padding:6px 10px;
                border:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 75%,transparent);border-radius:8px;
                background:color-mix(in srgb,var(--SmartThemeBlurTintColor,#222) 94%,var(--SmartThemeBodyColor,#eee));
                color:inherit;font:inherit;font-size:13px;line-height:1.4;transition:border-color .15s,box-shadow .15s;
            }
            #uwu-phone-vector-dialog .uwu-memory-field .text_pole:focus {
                border-color:var(--uwu-memory-accent,var(--SmartThemeQuoteColor,#8ab4f8));outline:none;
            }
            #uwu-phone-vector-credential::placeholder { color:#999;opacity:1; }
            #uwu-phone-vector-dialog .uwu-memory-key-group {
                display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:var(--uwu-memory-item-gap);align-items:center;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .uwu-memory-check {
                display:flex !important;flex-direction:row !important;align-items:center;gap:8px;
                width:100%;min-width:0;min-height:34px;margin:0 !important;padding:5px 10px;
                border-radius:8px;background:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 3%,transparent);
                border:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 35%,transparent);
                cursor:pointer;text-align:left;transition:background .15s,border-color .15s;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .uwu-memory-check:hover {
                background:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 6%,transparent);
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .uwu-memory-check input[type="checkbox"] {
                appearance:auto;display:inline-block !important;flex:0 0 16px !important;
                width:16px !important;min-width:16px !important;max-width:16px !important;
                height:16px !important;min-height:16px;margin:0 !important;padding:0;transform:none;
                accent-color:var(--uwu-memory-accent,var(--SmartThemeQuoteColor,#8ab4f8));
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .uwu-memory-check-text {
                display:block;flex:1;min-width:0;font-size:13px;line-height:1.4;overflow-wrap:anywhere;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .uwu-memory-actions {
                display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--uwu-memory-item-gap);min-width:0;margin:0 !important;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .menu_button {
                display:inline-flex !important;flex-direction:row !important;align-items:center;justify-content:center;
                width:auto !important;min-width:0 !important;max-width:100%;min-height:36px;margin:0 !important;
                padding:6px 12px;border:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 75%,transparent);border-radius:8px;
                background:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 5.5%,transparent);
                color:inherit;font:inherit;font-size:12.5px;font-weight:500;line-height:1.35;white-space:normal;word-break:normal;
                text-align:center;cursor:pointer;transition:background .15s,border-color .15s,transform .08s;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .menu_button:hover:not(:disabled) {
                background:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 11%,transparent);
                border-color:var(--uwu-memory-accent,var(--SmartThemeQuoteColor,#8ab4f8));
            }
            #uwu-phone-vector-dialog .uwu-memory-key-actions .menu_button {
                font-family:inherit !important;font-size:12.5px !important;font-weight:500 !important;
                font-style:normal !important;line-height:1.35 !important;letter-spacing:normal !important;text-transform:none !important;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .menu_button:disabled { opacity:.5;cursor:wait; }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) :is(button,input,select,summary):focus-visible {
                outline:2px solid var(--uwu-memory-accent,var(--SmartThemeQuoteColor,#8ab4f8));outline-offset:2px;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-primary {
                border-color:color-mix(in srgb,var(--uwu-memory-accent) 70%,transparent);
                background:color-mix(in srgb,var(--uwu-memory-accent) 20%,transparent);font-weight:600;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-danger {
                color:color-mix(in srgb,var(--SmartThemeWarningColor,#df5b69) 80%,var(--SmartThemeBodyColor,#eee));
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .menu_button.uwu-dialog-close {
                flex:0 0 50px;align-self:center;justify-self:end;
                width:50px !important;min-width:50px !important;max-width:50px;
                height:32px;min-height:32px;padding:5px 12px;font-size:12px;white-space:nowrap;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-help {
                margin:0 !important;padding:0;font-size:12px;line-height:1.5;opacity:.72;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) :is(.uwu-memory-check,.uwu-memory-parameters,h4) + .uwu-memory-help {
                margin-top:calc(var(--uwu-memory-sub-gap) - var(--uwu-memory-item-gap)) !important;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-advanced {
                margin:0 !important;padding:0;border:0;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-advanced summary {
                margin:0 !important;padding:2px 0;cursor:pointer;font-size:12.5px;font-weight:500;line-height:1.35;opacity:.88;user-select:none;
            }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-advanced[open] > :not(summary) {
                margin-top:var(--uwu-memory-sub-gap) !important;
            }
            #uwu-phone-vector-dialog .uwu-memory-parameters {
                display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--uwu-memory-item-gap);margin:0 !important;align-items:start;
            }
            #uwu-phone-vector-dialog #uwu-phone-vector-status,
            #uwu-phone-vector-dialog #uwu-phone-memory-status,
            .uwu-memory-dialog .uwu-memory-status-banner,
            #uwu-phone-memory-settings #uwu-phone-memory-status {
                margin:0 !important;padding:8px 12px;border-radius:8px;font-size:12.5px;line-height:1.5;overflow-wrap:anywhere;
                background:color-mix(in srgb,var(--SmartThemeBodyColor,#eee) 4.5%,transparent);
                border-left:3px solid var(--uwu-memory-accent,var(--SmartThemeQuoteColor,#8ab4f8));
            }
            #uwu-phone-memory-settings #uwu-phone-memory-status { margin:8px 0 0 !important; }
            .uwu-memory-dialog .uwu-memory-snippet {
                margin:0 !important;padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.5;
                white-space:pre-wrap;overflow-wrap:anywhere;
                background:color-mix(in srgb,var(--SmartThemeBlurTintColor,#222) 92%,var(--SmartThemeBodyColor,#eee));
                border:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 55%,transparent);
            }
            .uwu-memory-dialog .uwu-memory-source-list { display:flex;flex-direction:column;gap:6px;margin:0 !important; }
            .uwu-memory-dialog .uwu-memory-source-row { display:flex;flex-direction:column;gap:6px;min-width:0; }
            .uwu-memory-dialog .uwu-memory-source-list [hidden] { display:none !important; }
            .uwu-memory-dialog .uwu-memory-search { width:100%;min-width:0;box-sizing:border-box; }
            .uwu-memory-dialog .uwu-memory-source-list .uwu-memory-check { align-items:flex-start; }
            .uwu-memory-dialog .uwu-memory-source-list input[type="checkbox"] { margin-top:2px !important; }
            .uwu-memory-dialog .uwu-memory-source-browser { min-width:0; }
            .uwu-memory-dialog .uwu-memory-source-browser > summary {
                padding:8px 0;font-size:13px;font-weight:600;cursor:pointer;overflow-wrap:anywhere;
            }
            .uwu-memory-dialog .uwu-memory-source-browser-body { display:flex;flex-direction:column;gap:8px;padding-top:6px; }
            .uwu-memory-dialog .uwu-memory-source-browser .uwu-memory-source-list { scroll-margin-top:72px; }
            .uwu-memory-dialog .uwu-memory-source-pagination {
                display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;
            }
            .uwu-memory-dialog .uwu-memory-source-pagination > span { min-width:0;text-align:center;font-size:12px;overflow-wrap:anywhere; }
            .uwu-memory-dialog .uwu-memory-source-pagination .menu_button:disabled { cursor:default; }
            .uwu-memory-dialog .uwu-memory-selected-sources { display:flex;flex-direction:column;gap:6px; }
            .uwu-memory-dialog .uwu-memory-selected-source { display:flex;align-items:center;gap:8px;min-width:0; }
            .uwu-memory-dialog .uwu-memory-selected-source > span { flex:1;min-width:0;font-size:12px;overflow-wrap:anywhere; }
            .uwu-memory-dialog .uwu-memory-selected-source > button { flex-shrink:0; }
            #uwu-phone-vector-dialog .uwu-memory-story-actions { margin:0 !important; }
            :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-footer {
                position:sticky;bottom:0;z-index:2;padding:12px 18px;
                border-top:1px solid color-mix(in srgb,var(--SmartThemeBorderColor,#555) 60%,transparent);
                background:color-mix(in srgb,var(--SmartThemeBlurTintColor,#222) 94%,var(--SmartThemeBodyColor,#eee) 6%);
                backdrop-filter:blur(10px);
            }
            #uwu-phone-vector-dialog .uwu-memory-save-actions { display:flex !important;justify-content:center; }
            #uwu-phone-vector-dialog .uwu-memory-save-actions .menu_button { width:160px !important; }
            #uwu-phone-memory-settings { padding:14px 16px; }
            #uwu-phone-memory-settings .uwu-memory-actions { margin:8px 0 !important; }
            #uwu-phone-memory-settings p { margin:8px 0 0;font-size:12px;line-height:1.5;opacity:.75; }
            @media(max-width:520px) {
                #uwu-phone-vector-dialog, .uwu-memory-dialog {
                    --uwu-memory-panel-gap:10px;
                    max-width:calc(100vw - 16px);max-height:92vh;max-height:92dvh;border-radius:14px;
                }
                :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-header { padding:12px 14px;gap:10px; }
                :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-panel { padding:12px 14px; }
                :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-card { padding:12px 14px; }
                :is(#uwu-phone-vector-dialog,.uwu-memory-dialog) .uwu-memory-footer { padding:10px 14px; }
                #uwu-phone-vector-dialog .uwu-memory-parameters { grid-template-columns:1fr; }
                #uwu-phone-vector-dialog .uwu-memory-key-group { grid-template-columns:1fr 1fr; }
                #uwu-phone-vector-dialog .uwu-memory-key-group .text_pole { grid-column:1 / -1; }
                :is(#uwu-phone-vector-dialog,.uwu-memory-dialog,#uwu-phone-memory-settings) .menu_button { padding:6px 8px;font-size:12px; }
                #uwu-phone-vector-dialog .uwu-memory-key-actions .menu_button { font-size:12px !important; }
            }
        `;
        (doc.head || doc.body).append(style);
    }
    function mountSettings() {
        const doc = getDocument();
        if (!doc?.body || disposed) return;
        mountVectorDialog();
        const menu = doc.getElementById('extensionsMenu');
        if (menu && !doc.getElementById('uwu-phone-vector-menu')) {
            const container = doc.createElement('div'); container.id = 'uwu-phone-vector-menu-container';
            container.className = 'extension_container interactable';
            const entry = doc.createElement('div'); entry.id = 'uwu-phone-vector-menu';
            entry.className = 'list-group-item flex-container flexGap5 interactable'; entry.tabIndex = 0;
            const icon = createMemoryIcon(doc);
            const label = doc.createElement('span'); label.className = 'uwu-memory-menu-label'; label.textContent = '小手机剧情召回';
            entry.append(icon, label); entry.title = '设置手机剧情的查找与召回'; entry.setAttribute?.('role', 'button');
            entry.addEventListener('click', showVectorSettings);
            entry.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showVectorSettings(); }
            });
            container.append(entry); menu.append(container);
        }
    }
    function mountVectorDialog() {
        const doc = getDocument();
        if (!doc?.body || disposed || doc.getElementById('uwu-phone-vector-dialog')) return;
        mountMemoryStyles(doc);
        const dialog = doc.createElement('dialog'); dialog.id = 'uwu-phone-vector-dialog';
        dialog.setAttribute?.('aria-labelledby', 'uwu-phone-memory-title');
        const header = doc.createElement('div'); header.className = 'uwu-memory-header';
        const headingBox = doc.createElement('div'); headingBox.className = 'uwu-memory-heading';
        const heading = doc.createElement('h3'); heading.id = 'uwu-phone-memory-title'; heading.textContent = '小手机剧情召回';
        const subtitle = doc.createElement('p'); subtitle.className = 'uwu-memory-subtitle'; subtitle.textContent = '让酒馆聊天接上小手机里的剧情';
        headingBox.append(heading, subtitle);
        const close = doc.createElement('button'); close.className = 'menu_button uwu-dialog-close'; close.id = 'uwu-phone-vector-close'; close.textContent = '关闭';
        close.addEventListener('click', () => dialog.close()); header.append(headingBox, close); dialog.append(header);
        const panel = doc.createElement('div'); panel.className = 'uwu-memory-panel'; dialog.append(panel);
        const config = vectorSettings(), controls = {};
        vectorControls = controls;
        const card = title => {
            const section = doc.createElement('section'); section.className = 'uwu-memory-card';
            const caption = doc.createElement('h4'); caption.textContent = title;
            section.append(caption); panel.append(section); return section;
        };
        const story = card('剧情补充');
        const storyLabel = doc.createElement('label'), storyToggle = doc.createElement('input'), storyText = doc.createElement('span');
        storyLabel.className = 'uwu-memory-check'; storyToggle.id = 'uwu-phone-memory-enabled';
        storyToggle.type = 'checkbox'; storyToggle.checked = settings().enabled !== false;
        storyToggle.addEventListener('change', () => setEnabled(storyToggle.checked));
        storyText.className = 'uwu-memory-check-text'; storyText.textContent = '按需补充手机剧情';
        storyLabel.append(storyToggle, storyText); story.append(storyLabel);
        const storyHelp = doc.createElement('p'); storyHelp.className = 'uwu-memory-help';
        storyHelp.textContent = '只查找已推送到当前酒馆聊天的记录。隐藏手机楼仍可被召回；编辑或删除手机块可撤销来源。开关修改后自动保存。';
        const storyStatus = doc.createElement('p'); storyStatus.id = 'uwu-phone-memory-status';
        storyStatus.className = 'uwu-memory-status-banner'; storyStatus.setAttribute?.('role', 'status');
        storyStatus.textContent = REASONS[preview.reason] || preview.reason;
        const storyActions = doc.createElement('div'); storyActions.className = 'uwu-memory-story-actions';
        const inspect = doc.createElement('button'); inspect.id = 'uwu-phone-memory-preview';
        inspect.className = 'menu_button'; inspect.textContent = '查看本次补充'; inspect.addEventListener('click', showPreview);
        storyActions.append(inspect); story.append(storyHelp, storyStatus, storyActions);
        const connection = card('向量接口');
        const addSelect = (name, title, options, parent = connection) => {
            const row = doc.createElement('label'), select = doc.createElement('select');
            row.className = 'uwu-memory-field'; select.id = `uwu-phone-vector-${name}`;
            select.className = 'text_pole';
            select.title = title; select.setAttribute?.('aria-label', title);
            for (const [value, text] of options) { const option = doc.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
            const caption = doc.createElement('span'); caption.className = 'uwu-memory-field-title'; caption.textContent = title;
            select.value = config[name]; controls[name] = select; row.append(caption, select); parent.append(row); return select;
        };
        const addField = (name, title, type = 'text', value = config[name], parent = connection) => {
            const row = doc.createElement('label'), input = doc.createElement('input');
            row.className = type === 'checkbox' ? 'uwu-memory-check' : 'uwu-memory-field';
            input.id = `uwu-phone-vector-${name}`; input.type = type;
            if (type === 'checkbox') input.checked = !!value;
            else { input.value = String(value ?? ''); input.className = 'text_pole'; }
            const caption = doc.createElement('span'); caption.textContent = title;
            caption.className = type === 'checkbox' ? 'uwu-memory-check-text' : 'uwu-memory-field-title';
            if (type === 'checkbox') row.append(input, caption);
            else row.append(caption, input);
            parent.append(row); controls[name] = input;
            return input;
        };
        const provider = addSelect('provider', '接口类型', [['openai', 'OpenAI 兼容'], ['ollama', 'Ollama'], ['gemini', 'Gemini']]);
        const url = addField('url', '接口地址'); url.autocomplete = 'off';
        const key = addField('credential', 'API Key', 'password', ''); key.autocomplete = 'new-password';
        for (const event of ['input', 'change']) url.addEventListener(event, renderVectorKeyStatus);
        provider.addEventListener('change', renderVectorKeyStatus);
        const allowAnonymous = addField('allowAnonymous', '此接口无需 API Key（仅用于开放服务）', 'checkbox');
        const modelField = doc.createElement('div'); modelField.className = 'uwu-memory-field'; connection.append(modelField);
        const modelCaption = doc.createElement('label'); modelCaption.className = 'uwu-memory-field-title';
        modelCaption.htmlFor = 'uwu-phone-vector-model'; modelCaption.textContent = '嵌入模型';
        const modelGroup = doc.createElement('div'); modelGroup.className = 'uwu-memory-model-group';
        const model = doc.createElement('input'); model.id = 'uwu-phone-vector-model'; model.type = 'text';
        model.className = 'text_pole'; model.value = config.model; model.autocomplete = 'off';
        model.setAttribute?.('aria-label', '嵌入模型'); controls.model = model; modelGroup.append(model);
        const modelOptions = doc.createElement('select'); modelOptions.id = 'uwu-phone-vector-model-options';
        modelOptions.className = 'text_pole uwu-memory-model-options'; modelOptions.hidden = true;
        modelOptions.title = '选择嵌入模型'; modelOptions.setAttribute?.('aria-label', '选择嵌入模型');
        controls.modelOptions = modelOptions;
        const modelStatus = doc.createElement('p'); modelStatus.id = 'uwu-phone-vector-model-status';
        modelStatus.className = 'uwu-memory-model-status'; modelStatus.hidden = true; modelStatus.setAttribute?.('role', 'status');
        modelField.append(modelCaption, modelGroup, modelOptions, modelStatus);
        const keyButtons = doc.createElement('div'); keyButtons.className = 'uwu-memory-actions uwu-memory-key-actions'; connection.append(keyButtons);
        const reveal = doc.createElement('button'); reveal.type = 'button'; reveal.id = 'uwu-phone-vector-reveal-key'; reveal.className = 'menu_button'; reveal.textContent = '显示输入的 Key';
        reveal.addEventListener('click', () => { key.type = key.type === 'password' ? 'text' : 'password'; reveal.textContent = key.type === 'password' ? '显示输入的 Key' : '隐藏输入的 Key'; });
        keyButtons.append(reveal);
        let modelListEpoch = 0, modelListAbort = null, modelListOwner = null;
        const modelContext = () => JSON.stringify([userScope(), provider.value, url.value.trim(), allowAnonymous.checked, key.value.trim()]);
        const clearModelOptions = () => {
            modelListEpoch++; modelListAbort?.abort(); modelListAbort = null; modelListOwner = null;
            modelOptions.textContent = ''; modelOptions.hidden = true;
            modelStatus.textContent = ''; modelStatus.hidden = true;
        };
        controls.clearModelOptions = clearModelOptions;
        for (const control of [url, key]) control.addEventListener('input', clearModelOptions);
        for (const control of [provider, url, key, allowAnonymous]) control.addEventListener('change', clearModelOptions);
        dialog.addEventListener('close', () => {
            if (!dialog.open) { clearModelOptions(); clearVectorSaveSuccess(); }
        });
        modelOptions.addEventListener('change', () => {
            if (modelListOwner !== modelContext()) { clearModelOptions(); return; }
            if (modelOptions.value) { model.value = modelOptions.value; loadDraftProfile(); model.focus?.(); }
        });
        const retrieval = card('召回设置');
        const enabled = addField('enabled', '启用向量辅助查找', 'checkbox'); retrieval.append(enabled.parentNode);
        const consent = doc.createElement('p'); consent.className = 'uwu-memory-help';
        consent.textContent = '启用后，已推送到当前酒馆聊天的手机片段会发送到向量 API 建立索引，查找剧情时会发送查询文字。关闭小手机后仍可用；向量关闭或连接失败时，继续使用关键词查找。'; retrieval.append(consent);
        const advanced = doc.createElement('details'), advancedTitle = doc.createElement('summary');
        advanced.className = 'uwu-memory-advanced';
        advancedTitle.textContent = '检索参数'; advanced.append(advancedTitle);
        const parameters = doc.createElement('div'); parameters.className = 'uwu-memory-parameters'; advanced.append(parameters);
        for (const [name, title, step, max] of [['dimensions', '输出维度（0 为模型默认）', '1', '16384'],
            ['threshold', '语义相似度门槛', '0.01', '1'], ['margin', '不同事件的最小分差', '0.01', '1']]) {
            const input = addField(name, title, 'number'); input.min = '0'; input.max = max; input.step = step;
            parameters.append(input.parentNode);
        }
        const calibration = doc.createElement('p'); calibration.className = 'uwu-memory-help';
        calibration.id = 'uwu-phone-vector-calibration-status';
        let draftProfileKey = recallProfileKey(config);
        function loadDraftProfile() {
            const draft = { provider: provider.value, url: url.value, model: model.value, dimensions: controls.dimensions.value };
            const identity = recallProfileKey(draft), entry = recallProfile(draft, false);
            if (identity !== draftProfileKey) {
                controls.threshold.value = String(entry?.threshold ?? .72);
                controls.margin.value = String(entry?.margin ?? .06);
                draftProfileKey = identity;
            }
            calibration.textContent = `${entry ? '使用本接口、本模型和维度保存的门槛。' : '新模型使用默认门槛。'}${entry?.evaluations?.length ? '已有本地人工对照记录，仍需真实聊天验证。' : '尚待相关和无关样例验证。'}请在“查看本次补充”里试查后记录；连接测试不能证明召回效果。`;
        }
        for (const control of [provider, url, model, controls.dimensions]) {
            for (const event of ['input', 'change']) control.addEventListener(event, loadDraftProfile);
        }
        controls.loadDraftProfile = loadDraftProfile; loadDraftProfile();
        advanced.append(calibration); retrieval.append(advanced);
        const maintenance = card('索引状态');
        const vectorStatus = doc.createElement('p'); vectorStatus.id = 'uwu-phone-vector-status'; vectorStatus.setAttribute?.('role', 'status');
        maintenance.append(vectorStatus);
        const buttons = doc.createElement('div'); buttons.className = 'uwu-memory-actions'; maintenance.append(buttons);
        const footer = doc.createElement('div'); footer.className = 'uwu-memory-footer';
        const primaryButtons = doc.createElement('div'); primaryButtons.className = 'uwu-memory-actions uwu-memory-save-actions'; footer.append(primaryButtons); dialog.append(footer);
        const readForm = () => ({ enabled: controls.enabled.checked, provider: provider.value,
            url: controls.url.value, model: controls.model.value, allowAnonymous: controls.allowAnonymous.checked,
            dimensions: controls.dimensions.value, threshold: controls.threshold.value, margin: controls.margin.value });
        const saveForm = async () => {
            setVectorSettings(readForm());
            loadDraftProfile();
            if (key.value.trim()) {
                const result = await saveVectorKey(key.value);
                if (!result.ok) return false;
                key.value = ''; key.type = 'password'; reveal.textContent = '显示输入的 Key';
            }
            return true;
        };
        const actionButtons = [];
        const action = (title, id, callback, target = buttons, extraClass = '') => {
            const btn = doc.createElement('button'); btn.type = 'button'; btn.className = `menu_button ${extraClass}`.trim(); btn.id = id; btn.textContent = title;
            btn.addEventListener('click', async () => {
                if (vectorUiBusy) return;
                vectorUiBusy = true; for (const button of actionButtons) button.disabled = true;
                const fields = Object.values(controls).filter(control => control && typeof control === 'object');
                for (const control of fields) control.disabled = true;
                reveal.disabled = true;
                try { await callback(); }
                catch { vectorStatus.textContent = '操作未完成，请检查接口地址、模型、Key 和网络；关键词查找仍可使用。'; }
                finally {
                    vectorUiBusy = false; for (const button of actionButtons) button.disabled = false;
                    for (const control of fields) control.disabled = false;
                    reveal.disabled = false;
                }
            });
            actionButtons.push(btn); target.append(btn); return btn;
        };
        const fetchModels = action('拉取', 'uwu-phone-vector-fetch-models', async () => {
            clearModelOptions();
            const epoch = modelListEpoch, owner = modelContext(), controller = new AbortController();
            modelListAbort = controller;
            const isCurrent = () => !disposed && dialog.open && modelListEpoch === epoch && modelContext() === owner;
            modelStatus.textContent = '正在拉取嵌入模型…'; modelStatus.hidden = false; fetchModels.textContent = '拉取中';
            try {
                const result = await fetchVectorModels({ provider: provider.value, url: url.value,
                    allowAnonymous: allowAnonymous.checked, key: key.value.trim(), signal: controller.signal, isCurrent });
                if (!isCurrent()) { if (modelListEpoch === epoch) clearModelOptions(); return; }
                if (!result.ok || !result.models?.length) {
                    modelStatus.textContent = MODEL_FETCH_REASONS[result.reason] || VECTOR_REASONS[result.reason]
                        || '拉取失败，请检查接口地址、Key 和网络。';
                    return;
                }
                const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择嵌入模型';
                modelOptions.append(placeholder);
                for (const name of result.models) {
                    const option = doc.createElement('option'); option.value = name; option.textContent = name; modelOptions.append(option);
                }
                modelListOwner = owner; modelOptions.value = ''; modelOptions.hidden = false;
                modelStatus.textContent = `已拉取 ${result.models.length} 个嵌入模型。`;
            } finally {
                if (modelListAbort === controller) modelListAbort = null;
                fetchModels.textContent = '拉取';
            }
        }, modelGroup);
        action('保存设置', 'uwu-phone-vector-save', async () => {
            if (await saveForm()) {
                showVectorSaveSuccess();
                await vectors.refreshStatus(); renderVectorStatus();
            }
        }, primaryButtons, 'uwu-memory-primary');
        action('测试连接', 'uwu-phone-vector-test', async () => {
            if (await saveForm()) {
                const result = await testVectorConnection();
                if (result.ok && result.dimensions) vectorStatus.textContent += ` 返回 ${result.dimensions} 维向量。`;
            }
        }, keyButtons);
        const keyMaintenance = doc.createElement('div'); keyMaintenance.className = 'uwu-memory-actions'; connection.append(keyMaintenance);
        action('删除已保存 Key', 'uwu-phone-vector-clear-key', async () => {
            const result = await saveVectorKey('', { clear: true });
            if (result.ok) {
                key.value = ''; key.type = 'password'; reveal.textContent = '显示输入的 Key'; clearModelOptions();
                vectorStatus.textContent = '已删除当前酒馆账号保存的向量 Key。需要鉴权的接口请重新填写并保存。';
            } else vectorStatus.textContent = VECTOR_REASONS[result.reason] || '删除未完成，请重试。';
        }, keyMaintenance, 'uwu-memory-danger');
        const keyHelp = doc.createElement('p'); keyHelp.className = 'uwu-memory-help';
        keyHelp.textContent = '删除按钮只清除当前酒馆账号保存的向量 Key，不修改主聊天 API 的 Key。'; connection.append(keyHelp);
        action('准备本聊天索引', 'uwu-phone-vector-index', async () => {
            if (await saveForm()) await prepareVectorIndex();
        });
        action('清除本聊天向量缓存', 'uwu-phone-vector-clear-cache', clearVectorCache, buttons, 'uwu-memory-danger');
        doc.body.append(dialog); renderVectorStatus();
    }
    function clearVectorSaveSuccess() {
        if (saveSuccessToast) (host.toastr || globalThis.toastr)?.clear?.(saveSuccessToast, { force: true });
        saveSuccessToast = null;
        const doc = getDocument(), container = doc?.getElementById('toast-container');
        // The shared native container must survive closing or disposing our dialog.
        if (container && container.parentNode === doc.getElementById('uwu-phone-vector-dialog')) {
            const layer = Array.from(doc.querySelectorAll?.('dialog[open]:not([closing])') || [])
                .filter(dialog => dialog.id !== 'uwu-phone-vector-dialog').pop() || doc.body;
            layer.append(container);
        }
    }
    function showVectorSaveSuccess() {
        const doc = getDocument();
        const dialog = doc?.getElementById('uwu-phone-vector-dialog');
        if (disposed || !dialog?.open) return;
        const toastr = host.toastr || globalThis.toastr;
        if (typeof toastr?.success !== 'function') return;
        clearVectorSaveSuccess();
        saveSuccessToast = toastr.success('保存成功', '', {
            timeOut: 2000, extendedTimeOut: 0, closeOnHover: false, closeButton: false,
            progressBar: false, preventDuplicates: false, target: dialog,
        });
        saveSuccessToast?.addClass?.('uwu-memory-save-success');
        // Existing containers ignore toastr's target; keep native notices above the modal.
        const container = doc.getElementById('toast-container');
        if (container && container.parentNode !== dialog) dialog.append(container);
        const toast = saveSuccessToast?.[0];
        const background = toast && doc.defaultView?.getComputedStyle(toast).backgroundImage;
        const iconLayer = `url("${NATIVE_SUCCESS_ICON}")`;
        if (background?.includes(iconLayer)) {
            // Keep the layer's position so theme background-size/position lists still align.
            toast.style.setProperty('background-image', background.replaceAll(iconLayer, 'none'), 'important');
        }
    }
    function showVectorSettings() {
        if (disposed) return;
        mountVectorDialog();
        const dialog = getDocument()?.getElementById('uwu-phone-vector-dialog');
        if (!dialog || !vectorControls) return;
        getPreview();
        const toggle = getDocument().getElementById('uwu-phone-memory-enabled');
        if (toggle) toggle.checked = settings().enabled !== false;
        if (!dialog.open) vectorControls.clearModelOptions();
        if (!dialog.open && !vectorUiBusy) {
            const config = vectorSettings();
            for (const [name, value] of Object.entries(config)) {
                const control = vectorControls[name]; if (!control) continue;
                if (control.type === 'checkbox') control.checked = !!value;
                else control.value = String(value ?? '');
            }
            vectorControls.credential.value = ''; vectorControls.credential.type = 'password';
            getDocument().getElementById('uwu-phone-vector-reveal-key').textContent = '显示输入的 Key';
            vectorControls.loadDraftProfile?.();
        }
        if (!dialog.open) dialog.showModal();
        return vectors.refreshStatus().then(() => renderVectorStatus()).catch(() => renderVectorStatus());
    }
    function releaseBindings() {
        for (const [events, type, fn] of bindings) (events.removeListener || events.off)?.call(events, type, fn);
        bindings.length = 0;
        initialized = false; boundEvents = null; boundTypes = null;
    }
    function initialize() {
        if (disposed) return;
        const ctx = getContext();
        const events = host.eventSource || ctx?.eventSource;
        const types = host.eventTypes || ctx?.eventTypes || ctx?.event_types;
        if (!events?.on || !types) {
            if (initialized) { releaseBindings(); invalidate(); }
            throw new Error('酒馆生成事件接口未就绪');
        }
        if (initialized && boundEvents === events && Object.keys(boundTypes).length === Object.keys(types).length
            && Object.entries(boundTypes).every(([name, value]) => types[name] === value)) return;
        if (initialized) { releaseBindings(); invalidate(); }
        const on = (name, fn) => {
            if (!types[name]) return;
            // 有些宿主注册后才抛错；先记账才能完整撤回并允许下一次重试。
            bindings.push([events, types[name], fn]); events.on(types[name], fn);
        };
        try {
            if (!host.generationStartManaged) on('GENERATION_STARTED', start);
            on('CHAT_COMPLETION_PROMPT_READY', data => prune(data?.chat, 'messages', data?.dryRun, false, undefined, false, () => data?.chat));
            on('CHAT_COMPLETION_SETTINGS_READY', data => prune(data?.messages, 'messages', false, true,
                data?.type, !!data && Object.hasOwn(data, 'type'), () => data?.messages));
            on('GENERATE_AFTER_DATA', (data, dryRun) => {
                // CC还会发一份中间GENERATE_AFTER_DATA，最后发送检查在settings事件。
                if (getContext()?.mainApi === 'openai') return;
                // NovelAI 的最终请求正文是 input，其余 TC 宿主通常使用 prompt。
                const shape = getContext()?.mainApi === 'novel' ? 'input' : 'prompt';
                return prune(data, shape, dryRun, true);
            });
            on('CHARACTER_MESSAGE_RENDERED', replyRendered);
            on('GENERATION_STOPPED', stop);
            on('GENERATION_ENDED', ended);
            for (const name of ['CHAT_CHANGED', 'CHARACTER_DELETED', 'PERSONA_CHANGED', 'MAIN_API_CHANGED', 'CONNECTION_PROFILE_LOADED'])
                on(name, () => invalidate());
            for (const name of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
                on(name, () => {
                    topicRefs = []; topicChat = null; topicScope = null;
                    // 重生的宿主删除发生在interceptor之前，不阻断它；选段后的变更取消本块。
                    if (active?.prefix && !active.replySeen && !currentValid(active, true)) invalidate();
                    scheduleVectorIndex();
                });
            }
            on('APP_READY', mountSettings);
            initialized = true; boundEvents = events; boundTypes = { ...types }; clearSlot(); mountSettings();
            scheduleVectorIndex();
            if (!compatible(ctx)) { updatePreview({ reason: 'UNSUPPORTED' }); warn('UNSUPPORTED'); }
        } catch (error) {
            releaseBindings(); clearSlot();
            throw error;
        }
    }
    function dispose() {
        if (disposed) return;
        vectorControls?.clearModelOptions?.();
        invalidate(); disposed = true;
        clearVectorSaveSuccess();
        if (indexTimer !== null) { clearTimeout(indexTimer); indexTimer = null; }
        releaseBindings();
        for (const id of ['uwu-phone-memory-preview-dialog', 'uwu-phone-memory-settings', 'uwu-phone-vector-dialog', 'uwu-phone-vector-menu-container', 'uwu-phone-vector-menu', 'uwu-phone-memory-ui-style']) getDocument()?.getElementById?.(id)?.remove();
    }
    return { initialize, startGeneration: start, interceptor, invalidate, setEnabled, getPreview, selectManual, availableSources, trialRecall, dispose,
        getRecallEvaluation, recordTrialEvaluation, getDiagnosticSummary,
        getVectorSettings: () => clone(vectorSettings()), setVectorSettings,
        getVectorState: () => clone(vectors.getState()),
        refreshVectorStatus: () => disposed ? Promise.resolve({ reason: 'CANCELLED' }) : vectors.refreshStatus(),
        saveVectorKey, testVectorConnection, fetchVectorModels, prepareVectorIndex, clearVectorCache, showVectorSettings };
}

let defaultAdapter = null;
export async function initializePhoneMemory({ generationStartManaged = false } = {}) {
    try { accountModule ||= await import('/scripts/user.js'); } catch { /* Unknown accounts cannot share vector credentials/cache; keywords still work. */ }
    defaultAdapter ||= createPhoneMemoryAdapter({ generationStartManaged });
    defaultAdapter.initialize();
    if (!generationStartManaged) globalThis.uwuPhoneMemoryInterceptor = (...args) => defaultAdapter.interceptor(...args);
    return defaultAdapter;
}
export function invalidatePhoneMemory(reason) { defaultAdapter?.invalidate(reason); }

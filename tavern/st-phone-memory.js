// 酒馆主页面适配。原文只来自当前酒馆聊天；向量默认由浏览器直连独立 API。
import * as core from './st-phone-memory-core.js';
import { createPhoneVectorService } from './st-phone-vector.js';

export const MEMORY_SLOT = 'uwu_phone_memory';
const NORMAL_TYPES = new Set(['', 'normal', 'regenerate', 'swipe', 'continue']);
const REASONS = {
    ...core.REASON_TEXT,
    NO_NEED: '当前没有涉及手机旧事', NONE: '当前没有涉及手机旧事',
    JOIN: '接上刚刚推送的手机剧情', DIRECT: '当前正在询问相关手机旧事',
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
function chatIdentity(ctx) {
    if (!ctx || ctx.groupId || !Array.isArray(ctx.chat)) return null;
    const ch = ctx.characters?.[ctx.characterId];
    const id = ctx.getCurrentChatId?.() ?? ch?.chat;
    if (id === null || id === undefined || id === '') return null;
    return JSON.stringify([ch?.avatar ?? ctx.characterId ?? null, String(id)]);
}
function prefixSnapshot(chat, cutoff, allowGreetingMacros = false) {
    // 原文和版本直接比对，不依赖短哈希判断请求归属。
    // 自动隐藏只是提示可见性变化；不把同一原文的隐藏标记当成来源删除。
    return JSON.stringify(chat.slice(0, cutoff).map((m, floor) => [
        allowGreetingMacros && floor === 0 && !m?.is_user && !m?.extra?.from_uwu ? null : m?.mes, m?.is_user,
        m?.swipe_id ?? 0, m?.extra?.from_uwu, m?.extra?.bbs_omit,
        m?.extra?.uwu_msg_ids, m?.extra?.uwu_line_lens, m?.extra?.uwu_summary,
        m?.extra?.uwu_created, m?.extra?.uwu_internal, m?.extra?.isSmallSys, m?.name,
        core.isTypedSystemMessage(m)]));
}
function replyStartSnapshot(message, floor) {
    // 宿主会展开首楼招呼宏；目标时间字段也会在正常 Continue 中更新。
    return JSON.stringify([floor === 0 && !message?.extra?.from_uwu ? null : message?.mes, message?.swipe_id ?? 0]);
}
function contentTexts(content) {
    if (typeof content === 'string') return [content];
    if (Array.isArray(content)) return content.flatMap(part => typeof part === 'string'
        ? [part] : typeof part?.text === 'string' ? [part.text] : []);
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
            : typeof part?.text === 'string' ? { ...part, text: transform(part.text) } : part);
    }
    return content;
}
const clone = value => JSON.parse(JSON.stringify(value));
const VECTOR_DEFAULTS = Object.freeze({ enabled: false, transport: 'browser', provider: 'openai', url: '', model: '',
    dimensions: 0, threshold: 0.72, margin: 0.06, allowAnonymous: false, splitVersion: 'phone-units-v1' });
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

// 酒馆公开的账号模块提供实时账号信息；未知账号不共用凭据或缓存。
let accountModule = null;

/** 使用同一创建入口运行真实宿主和测试宿主，测试不绕过生成生命周期。 */
export function createPhoneMemoryAdapter(host = {}) {
    const getContext = host.getContext || (() => globalThis.SillyTavern?.getContext?.());
    const getDocument = () => host.document === undefined ? globalThis.document : host.document;
    let active = null, sequence = 0, topicRefs = [], topicChat = null, topicScope = null, manual = null, assemblyOwner = null;
    let initialized = false, disposed = false, preview = { stage: 'idle', reason: 'NO_NEED', selected: [], chars: 0, tokens: 0 };
    let previewOwner = null;
    const bindings = [], warnings = new Set(), knownBlocks = new Map();
    const fallbackSettings = { enabled: true };
    let indexTimer = null, vectorControls = null, vectorUiBusy = false;
    const contextCall = (name, ...args) => {
        const ctx = getContext();
        const fn = host[name] || ctx?.[name];
        return typeof fn === 'function' ? fn.apply(ctx, args) : undefined;
    };
    function settings() {
        const ctx = getContext();
        const container = host.extensionSettings || ctx?.extensionSettings;
        if (!container) return fallbackSettings;
        if (!container[MEMORY_SLOT]) container[MEMORY_SLOT] = { enabled: true };
        return container[MEMORY_SLOT];
    }
    function vectorSettings() {
        const stored = settings();
        stored.vector ||= { ...VECTOR_DEFAULTS };
        // 旧连接配置也使用浏览器直连；服务端凭据不会迁入扩展设置。
        const normalized = { ...VECTOR_DEFAULTS, ...stored.vector, transport: 'browser' };
        delete normalized.key; delete normalized.apiKey; delete normalized.secret;
        return normalized;
    }
    function userScope() {
        if (host.getUserScope) return host.getUserScope();
        if (!accountModule) return '';
        return accountModule.accountsEnabled ? accountModule.currentUser?.handle || '' : 'default-user';
    }
    function vectorProfileSnapshot() { return JSON.stringify(vectorSettings()); }
    function indexSourceSnapshot(scan) {
        return JSON.stringify([scan.sources.map(s => [s.key, s.floor, s.blockFingerprint, s.body, s.summary, s.msgIds]),
            scan.units.map(unit => [unit.id, unit.start, unit.end, unit.msgIds])]);
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
    function renderVectorStatus(state = vectors.getState()) {
        const status = getDocument()?.getElementById?.('uwu-phone-vector-status');
        if (!status) return;
        status.textContent = `${VECTOR_REASONS[state.reason] || state.reason || '向量尚未准备'}。${Number(state.cached) || 0}/${Number(state.total) || 0} 段已缓存。`
            + (state.available ? (state.hasKey
                ? ' 当前账号已保存 Key；更改地址后需重新保存。' : ' 当前账号尚未保存 Key。') : '')
            + (state.cacheWarning ? ` ${VECTOR_REASONS[state.cacheWarning] || state.cacheWarning}` : '');
    }
    function scheduleVectorIndex() {
        if (indexTimer !== null) clearTimeout(indexTimer);
        indexTimer = null;
        if (disposed || !initialized || !settings().enabled || !vectorSettings().enabled) return;
        indexTimer = setTimeout(() => {
            indexTimer = null;
            prepareVectorIndex().catch(() => renderVectorStatus());
        }, 100);
    }
    async function prepareVectorIndex() {
        if (disposed || !settings().enabled || !vectorSettings().enabled) return vectors.getState();
        const ctx = getContext(), chatId = chatIdentity(ctx);
        if (!chatId) return vectors.getState();
        const profile = vectorProfileSnapshot();
        const scan = core.scanSources(ctx.chat, { chatId });
        // 非手机普通对话增减不使内容索引失效；每个来源的原文版本必须保持一致。
        const sources = indexSourceSnapshot(scan);
        const isCurrent = () => !disposed && settings().enabled && vectorSettings().enabled
            && chatIdentity(getContext()) === chatId && vectorProfileSnapshot() === profile
            && indexSourceSnapshot(core.scanSources(getContext().chat, { chatId })) === sources;
        await vectors.sync(scan, { isCurrent });
        renderVectorStatus(); return vectors.getState();
    }
    function setVectorSettings(changes) {
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
        // Key 单独绑定账号及端点，不混入普通连接配置或补充预览。
        delete next.key; delete next.apiKey; delete next.secret;
        settings().vector = next;
        invalidate('VECTOR_CONFIG');
        contextCall('saveSettingsDebounced');
        scheduleVectorIndex(); renderVectorStatus();
        return clone(next);
    }
    async function saveVectorKey(key, { clear = false } = {}) {
        invalidate('VECTOR_CONFIG');
        const result = await vectors.saveKey(String(key || ''), { clear });
        scheduleVectorIndex(); renderVectorStatus(); return result;
    }
    async function testVectorConnection() {
        const result = await vectors.testConnection();
        renderVectorStatus(); return result;
    }
    async function clearVectorCache() {
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
        const key = `${reason}:${detail || ''}`;
        if (warnings.has(key)) return;
        warnings.add(key);
        console.warn('[小手机记忆]', REASONS[reason] || reason, detail || '');
        (host.notify || globalThis.toastr?.warning)?.(REASONS[reason] || reason, '小手机剧情补充');
    }
    function clearSlot() {
        contextCall('setExtensionPrompt', MEMORY_SLOT, '', 1, 1, false, 0, () => false);
    }
    function updatePreview(changes) {
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
        sequence++;
        vectors.cancel();
        if (active) { active.invalid = true; active.abortCleanup?.(); }
        active = null; assemblyOwner = null;
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
        settings().enabled = !!enabled;
        if (!enabled) invalidate('DISABLED');
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
        getPreview();
        clearSlot();
        const ctx = getContext();
        const scope = userScope();
        const mode = String(type || '').toLowerCase();
        const lastFloor = (ctx?.chat?.length ?? 0) - 1;
        const last = ctx?.chat?.[lastFloor];
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
        const startLength = ctx?.chat?.length ?? 0, startCutoff = initialTarget ?? startLength;
        active = { id: `m${Date.now().toString(36)}_${++sequence}_${Math.random().toString(36).slice(2, 10)}`,
            serial: sequence, chatId: chatIdentity(ctx), scope, mode, options, eligible,
            // 自动隐藏的角色楼仍是目标；真正的系统/内部楼和手机推送不能成为主回复目标。
            initialTarget, startLength, startCutoff,
            startPrefix: prefixSnapshot(ctx?.chat || [], startCutoff, true),
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
        if (!op || active !== op || op.invalid || !settings().enabled || chatIdentity(ctx) !== op.chatId
            || userScope() !== op.scope) return false;
        if (op.vectorProfile !== vectorProfileSnapshot()) return false;
        if (!Array.isArray(ctx.chat) || prefixSnapshot(ctx.chat, op.cutoff) !== op.prefix) return false;
        if (!allowReply) {
            const expected = ['swipe', 'continue'].includes(op.mode) ? op.cutoff + 1 : op.baseLength;
            if (ctx.chat.length !== expected) return false;
            if (Number.isInteger(op.initialTarget) && ctx.chat[op.replyFloor]
                && !core.isCompletedReply(ctx.chat[op.replyFloor])) return false;
            if (op.targetVersion !== null && JSON.stringify([ctx.chat[op.replyFloor]?.mes,
                ctx.chat[op.replyFloor]?.swipe_id ?? 0]) !== op.targetVersion) return false;
        }
        return true;
    }
    async function interceptor(_coreChat, contextSize, _abort, type) {
        clearSlot();
        const op = active, ctx = getContext();
        if (!op || !op.eligible || op.mode !== String(type || '').toLowerCase()) {
            assemblyOwner = null;
            if (op?.eligible && op.concurrentInternal) return;
            updatePreview({ stage: 'empty', reason: 'INTERNAL' }); return;
        }
        assemblyOwner = op.id;
        if (!settings().enabled) { updatePreview({ stage: 'empty', reason: 'DISABLED' }); return; }
        if (ctx?.groupId) { updatePreview({ stage: 'empty', reason: 'GROUP' }); return; }
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
            || prefixSnapshot(ctx.chat, op.startCutoff, true) !== op.startPrefix
            || (op.startTargetVersion !== null && ctx.chat[op.initialTarget]
                && replyStartSnapshot(ctx.chat[op.initialTarget], op.initialTarget) !== op.startTargetVersion)) {
            invalidate(); return;
        }
        const target = targetFor(op, ctx);
        if (!target) { updatePreview({ stage: 'empty', reason: 'TARGET_UNKNOWN' }); return; }
        Object.assign(op, target, { baseLength: ctx.chat.length, prefix: prefixSnapshot(ctx.chat, target.cutoff),
            targetVersion: ['swipe', 'continue'].includes(op.mode)
                ? JSON.stringify([ctx.chat[target.replyFloor]?.mes, ctx.chat[target.replyFloor]?.swipe_id ?? 0]) : null });
        try {
            const scan = core.scanSources(ctx.chat, { chatId: op.chatId, cutoff: op.cutoff });
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
            let decision = core.decideMemory(decisionInput);
            const vectorConfig = vectorSettings(), profile = vectorProfileSnapshot();
            const classification = decision.classification;
            // 当前需求先成立；承接、泛指、手选和内部请求无需另发查询。
            const maySearch = vectorConfig.enabled && scan.units.length && !manualRefs.length
                && !['JOIN', 'FOLLOW', 'MANUAL'].includes(decision.kind)
                && classification?.need && !classification.genericFollow
                && core.semanticQueryHasContent(classification,
                    [...decisionInput.roleNames, ...scan.units.map(unit => unit.speaker).filter(Boolean)]);
            if (maySearch) {
                const isCurrent = () => currentValid(op) && vectorProfileSnapshot() === profile;
                let result;
                try {
                    result = await vectors.search(scan, classification.demandText, {
                        isCurrent, signal: op.vectorAbort.signal, timeoutMs: 3000,
                    });
                } catch {
                    result = { candidates: [], reason: 'NETWORK_ERROR' };
                }
                if (!isCurrent()) return;
                if (result.candidates?.length) decision = core.decideMemory({ ...decisionInput,
                    semanticCandidates: result.candidates,
                    semanticThreshold: vectorConfig.threshold, semanticMargin: vectorConfig.margin });
                op.vectorReason = result.reason;
                updatePreview({ vector: { reason: result.reason,
                    explanation: VECTOR_REASONS[result.reason] || result.reason,
                    candidateCount: result.candidates?.length || 0 }, retrieval: decision.retrieval || { mode: 'keyword' } });
            } else updatePreview({ vector: { reason: vectorConfig.enabled ? 'NO_NEED' : 'DISABLED',
                explanation: vectorConfig.enabled ? '当前承接或输入无需向量查询' : VECTOR_REASONS.DISABLED },
                retrieval: { mode: 'keyword' } });
            if (!currentValid(op)) return;
            op.decision = decision;
            topicRefs = decision.topicRefs || []; topicChat = op.chatId; topicScope = op.scope;
            if (!decision.selected?.length) {
                updatePreview({ stage: 'empty', reason: decision.reason || 'NO_NEED', kind: decision.kind,
                    selected: [], query: op.query, chars: 0, tokens: 0 }); return;
            }
            const budget = await core.fitBudget(decision.selected, {
                countTokens: text => contextCall('getTokenCountAsync', text),
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
        for (const id of knownBlocks.keys()) {
            if (id.endsWith('_previous')) continue;
            const begin = `[[UWU_PHONE_MEMORY:${id}:BEGIN]]`, end = `[[UWU_PHONE_MEMORY:${id}:END]]`;
            let from = text.indexOf(begin);
            while (from !== -1) {
                const to = text.indexOf(end, from + begin.length);
                if (to === -1) break;
                ranges.push({ start: from, end: to + end.length });
                from = text.indexOf(begin, to + end.length);
            }
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
    async function prune(actual, shape, dryRun = false, sending = false, requestType, hasRequestType = false) {
        const op = active;
        const assembledBlock = op?.block;
        const sentAtEntry = op?.sent;
        let texts, replace;
        if (shape === 'messages') {
            if (!Array.isArray(actual)) return;
            // 同一消息的多个文本部分共同构成原文；图片和工具信息保持原样。
            texts = actual.map(m => contentTexts(m?.content).join(''));
            replace = fn => {
                for (let i = actual.length - 1; i >= 0; i--) {
                    const m = actual[i];
                    if (!m || !('content' in m)) continue;
                    const previous = contentTexts(m.content).join('');
                    m.content = mapContent(m.content, fn, knownRanges(previous));
                    // 只有本扩展移除后变空的纯消息才删除；别的空消息不归本扩展处理。
                    const hasMedia = Array.isArray(m.content) && m.content.some(part => typeof part === 'object' && part?.type !== 'text');
                    if (previous && !contentTexts(m.content).join('').trim()
                        && previous !== contentTexts(m.content).join('') && !hasMedia && !m.tool_calls) actual.splice(i, 1);
                }
            };
        } else {
            const field = shape === 'input' ? 'input' : 'prompt';
            if (typeof actual?.[field] !== 'string') return;
            texts = [actual[field]]; replace = fn => { actual[field] = fn(actual[field]); };
        }
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
        const scan = core.scanSources(getContext().chat, { chatId: op.chatId, cutoff: op.cutoff });
        const valid = core.validateSelection(op.selected, scan);
        const covered = core.filterCovered(valid, texts.map(withoutKnown));
        const kept = covered.selected;
        let next = kept.length ? core.buildMemoryBlock(kept, { operationId: op.id }) : '';
        let tokens = 0;
        try {
            if (next) tokens = await contextCall('getTokenCountAsync', next);
            if (next && (!Number.isFinite(tokens) || tokens < 0)) throw new Error('invalid token count');
        } catch (error) {
            next = ''; warn('TOKENIZER_ERROR');
        }
        if (!currentValid(op) || active !== op) { replace(withoutKnown); return; }
        // 另一份最终数据可能在 token 等待期间已确认主请求发送。
        // 迟到组装只清理自己的副本，不能把 sent 或实际采用来源退回未发送状态。
        if (op.sent && !sentAtEntry) { replace(withoutKnown); return; }
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
        if (next.length > op.block.length || tokens > op.tokens || next.length > 1800 || tokens > 1200) next = '';
        const previous = op.block;
        replace(text => text.split(previous).join(next));
        op.block = next; op.selected = next ? kept : []; op.tokens = next ? tokens : 0;
        if (next) knownBlocks.set(op.id, next);
        // 仍留旧block以便不同shape的回调拿到较早的组装副本时清理。
        if (previous !== next) knownBlocks.set(`${op.id}_previous`, previous);
        op.sent = sending && !!next;
        if (!next) clearSlot();
        updatePreview({ stage: next ? (sending ? 'retained' : 'assembled') : 'removed',
            reason: next ? op.decision.kind : valid.length ? 'COVERED' : 'SOURCE_CHANGED',
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
        op.replyVersion = JSON.stringify([reply?.mes, reply?.swipe_id ?? 0]);
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
        try {
            const ctx = getContext(), message = ctx?.chat?.[op.replyFloor];
            if ((!op.sent && !op.priorReceipt) || !op.replySeen || (!op.selected.length && !op.priorReceipt) || !currentValid(op, true)
                || !core.isCompletedReply(message)
                || JSON.stringify([message.mes, message.swipe_id ?? 0]) !== op.replyVersion
                || ctx.chat.length !== op.replyFloor + 1) return;
            const scan = core.scanSources(ctx.chat, { chatId: op.chatId, cutoff: op.cutoff });
            const previous = (op.priorReceipt?.sources || []).map(ref => {
                const source = scan.sources.find(s => s.key === ref.sourceKey);
                return { ref, floor: ref.floor, text: source?.body.slice(ref.start, ref.end) || '' };
            });
            const selected = core.validateSelection([...previous, ...op.selected], scan)
                .filter((s, index, all) => all.findIndex(x => JSON.stringify(x.ref) === JSON.stringify(s.ref)) === index);
            if (!selected.length) return;
            const receipt = core.createReceipt({ chatId: op.chatId, userFloor: op.userFloor,
                replyFloor: op.replyFloor, swipeId: message.swipe_id ?? 0, replyText: message.mes, selected,
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
            updatePreview({ stage: 'completed', persistence: 'saving' });
            const result = await save.call(ctx);
            // 保存可能跨越切账号、换聊、来源更新或下一次生成；结果只属于原操作。
            if (!currentValid(op, true)) {
                if (active === op) invalidate();
                return;
            }
            if (result === false || result?.ok === false) throw new Error('酒馆报告保存失败');
            if (active === op && chatIdentity(getContext()) === op.chatId) {
                // 有些酒馆版本saveChat会吞掉错误，void不能冒充已确认持久保存。
                updatePreview({ persistence: result === true || result?.ok === true ? 'saved' : 'requested' });
            }
        } catch (error) {
            if (!currentValid(op, true)) {
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
    function availableSources() {
        const ctx = getContext(), chatId = chatIdentity(ctx);
        return chatId ? core.scanSources(ctx.chat, { chatId }).units.map(s => ({ ref: s.ref, text: s.text })) : [];
    }
    function selectManual(refs) {
        getPreview();
        const ctx = getContext(), chatId = chatIdentity(ctx);
        if (!chatId || !settings().enabled || !Array.isArray(refs)) return false;
        manual = { chatId, scope: userScope(), refs: clone(refs.slice(0, 2)) };
        previewOwner = { scope: manual.scope, chatId };
        updatePreview({ stage: 'manual', reason: 'MANUAL' }); return true;
    }
    function showPreview() {
        const doc = getDocument();
        if (!doc) return;
        getPreview();
        const dialog = doc.createElement('dialog');
        dialog.style.cssText = 'max-width:720px;max-height:85vh;overflow:auto;background:var(--SmartThemeBlurTintColor,#222);color:var(--SmartThemeBodyColor,#eee);padding:20px;';
        const title = doc.createElement('h3'); title.textContent = '本次手机剧情补充'; dialog.append(title);
        const description = doc.createElement('p');
        const stageNames = { selected: '已预选，等待组装', assembled: '组装中保留，等待发送检查',
            retained: '发送数据中保留', completed: '本次回复已完成', empty: '本次没有补充', removed: '本次补充已移除' };
        description.textContent = `${stageNames[preview.stage] || '本次没有发送补充'}。${REASONS[preview.reason] || preview.reason}。${preview.chars} 字符，${preview.tokens} tokens。`;
        dialog.append(description);
        if (preview.vector) {
            const p = doc.createElement('p');
            p.textContent = preview.vector.explanation || VECTOR_REASONS[preview.vector.reason] || preview.vector.reason;
            dialog.append(p);
        }
        if (preview.persistence) {
            const p = doc.createElement('p');
            p.textContent = { saving: '正在保存采用标记', saved: '采用标记已保存',
                requested: '已请求酒馆保存采用标记；宿主未返回持久保存确认', failed: '采用标记保存失败，刷新后可能无法沿用这次重复抑制' }[preview.persistence];
            dialog.append(p);
        }
        for (const source of preview.selected || []) {
            const p = doc.createElement('pre'); p.style.whiteSpace = 'pre-wrap';
            p.textContent = `来源：聊天第 ${source.ref?.floor + 1} 楼\n${source.text}`; dialog.append(p);
        }
        const details = doc.createElement('details'), summary = doc.createElement('summary'), data = doc.createElement('pre');
        summary.textContent = '技术明细'; data.textContent = JSON.stringify(getPreview(), null, 2);
        data.style.whiteSpace = 'pre-wrap'; details.append(summary, data); dialog.append(details);
        const help = doc.createElement('p'); help.textContent = '自动定位失败时，可从下面选至多两段，只用于下一次主回复。仍会检查来源、已有内容和长度。'; dialog.append(help);
        const checks = [];
        for (const source of availableSources()) {
            const label = doc.createElement('label'), input = doc.createElement('input');
            input.type = 'checkbox'; input.addEventListener('change', () => {
                if (checks.filter(x => x.input.checked).length > 2) input.checked = false;
            });
            label.style.display = 'block'; label.append(input, doc.createTextNode(` 第 ${source.ref?.floor + 1} 楼：${source.text.slice(0, 180)}`));
            checks.push({ input, ref: source.ref }); dialog.append(label);
        }
        const use = doc.createElement('button'); use.className = 'menu_button'; use.textContent = '本次补充所选来源';
        use.addEventListener('click', () => { selectManual(checks.filter(x => x.input.checked).map(x => x.ref)); dialog.close(); });
        const close = doc.createElement('button'); close.className = 'menu_button'; close.textContent = '关闭';
        close.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', () => dialog.remove());
        dialog.append(use, close); doc.body.append(dialog); dialog.showModal();
    }
    function mountSettings() {
        const doc = getDocument();
        if (!doc?.body || disposed) return;
        mountVectorDialog();
        const menu = doc.getElementById('extensionsMenu');
        if (menu && !doc.getElementById('uwu-phone-vector-menu')) {
            const entry = doc.createElement('div'); entry.id = 'uwu-phone-vector-menu';
            entry.className = 'list-group-item flex-container flexGap5'; entry.tabIndex = 0;
            entry.textContent = '小手机向量 API'; entry.title = '配置手机记忆的独立向量 API';
            entry.addEventListener('click', showVectorSettings);
            entry.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showVectorSettings(); }
            });
            menu.append(entry);
        }
        const parent = doc?.getElementById?.('extensions_settings2') || doc?.getElementById?.('extensions_settings');
        if (!parent || doc.getElementById('uwu-phone-memory-settings')) return;
        const box = doc.createElement('div'); box.id = 'uwu-phone-memory-settings'; box.className = 'extension_container';
        const title = doc.createElement('h3'); title.textContent = '小手机 · 手机记忆';
        const label = doc.createElement('label'), toggle = doc.createElement('input');
        toggle.id = 'uwu-phone-memory-enabled';
        toggle.type = 'checkbox'; toggle.checked = settings().enabled !== false;
        toggle.addEventListener('change', () => setEnabled(toggle.checked));
        label.append(toggle, doc.createTextNode(' 按需补充手机剧情'));
        const button = doc.createElement('button'); button.className = 'menu_button'; button.textContent = '查看本次补充';
        button.addEventListener('click', showPreview);
        const configure = doc.createElement('button'); configure.id = 'uwu-phone-vector-configure';
        configure.className = 'menu_button'; configure.textContent = '配置向量 API';
        configure.addEventListener('click', showVectorSettings);
        const info = doc.createElement('p'); info.textContent = '只查找已推送的记录。隐藏手机楼仍可被召回；编辑或删除手机块可撤销来源。';
        const status = doc.createElement('p'); status.id = 'uwu-phone-memory-status'; status.textContent = REASONS[preview.reason];
        const buttons = doc.createElement('div'); buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:10px 0';
        buttons.append(configure, button); box.append(title, label, buttons, info, status); parent.append(box);
    }
    function mountVectorDialog() {
        const doc = getDocument();
        if (!doc?.body || doc.getElementById('uwu-phone-vector-dialog')) return;
        const dialog = doc.createElement('dialog'); dialog.id = 'uwu-phone-vector-dialog';
        dialog.style.cssText = 'box-sizing:border-box;width:560px;max-width:calc(100vw - 24px);max-height:85vh;overflow:auto;border:1px solid var(--SmartThemeBorderColor,#666);border-radius:14px;background:var(--SmartThemeBlurTintColor,#222);color:var(--SmartThemeBodyColor,#eee);padding:18px;text-align:left;';
        const header = doc.createElement('div'); header.style.cssText = 'position:sticky;top:-18px;margin:-18px -18px 0;padding:18px;z-index:1;background:var(--SmartThemeBlurTintColor,#222);display:flex;align-items:center;justify-content:space-between;gap:12px';
        const heading = doc.createElement('h3'); heading.textContent = '小手机向量 API'; heading.style.margin = '0';
        const close = doc.createElement('button'); close.className = 'menu_button'; close.id = 'uwu-phone-vector-close'; close.textContent = '关闭';
        close.addEventListener('click', () => dialog.close()); header.append(heading, close); dialog.append(header);
        const panel = doc.createElement('div'); panel.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:16px'; dialog.append(panel);
        const config = vectorSettings(), controls = {};
        vectorControls = controls;
        const card = title => {
            const section = doc.createElement('section'); section.style.cssText = 'min-width:0;padding:12px;border:1px solid var(--SmartThemeBorderColor,#666);border-radius:10px;';
            const caption = doc.createElement('h4'); caption.textContent = title; caption.style.cssText = 'margin:0 0 10px';
            section.append(caption); panel.append(section); return section;
        };
        const connection = card('向量连接');
        const addSelect = (name, title, options) => {
            const row = doc.createElement('label'), select = doc.createElement('select');
            row.style.cssText = 'display:block;margin:10px 0'; select.id = `uwu-phone-vector-${name}`;
            select.className = 'text_pole'; select.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:5px';
            for (const [value, text] of options) { const option = doc.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
            select.value = config[name]; controls[name] = select; row.append(doc.createTextNode(title), select); connection.append(row); return select;
        };
        const provider = addSelect('provider', '接口类型', [['openai', 'OpenAI 兼容'], ['ollama', 'Ollama'], ['gemini', 'Gemini']]);
        const addField = (name, title, type = 'text', value = config[name]) => {
            const row = doc.createElement('label'), input = doc.createElement('input');
            row.style.display = 'block'; row.style.margin = '8px 0';
            input.id = `uwu-phone-vector-${name}`; input.type = type;
            if (type === 'checkbox') input.checked = !!value;
            else { input.value = String(value ?? ''); input.className = 'text_pole'; input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:5px'; }
            if (type === 'checkbox') row.append(input, doc.createTextNode(` ${title}`));
            else row.append(doc.createTextNode(title), input);
            connection.append(row); controls[name] = input;
            return input;
        };
        const url = addField('url', '接口地址'); url.placeholder = 'https://你的接口/v1（或完整 embeddings 地址）';
        url.autocomplete = 'off';
        const key = addField('credential', 'API Key（留空保留此接口已保存的 Key）', 'password', ''); key.autocomplete = 'new-password';
        const reveal = doc.createElement('button'); reveal.id = 'uwu-phone-vector-reveal-key'; reveal.className = 'menu_button'; reveal.textContent = '显示输入的 Key';
        reveal.addEventListener('click', () => { key.type = key.type === 'password' ? 'text' : 'password'; reveal.textContent = key.type === 'password' ? '显示输入的 Key' : '隐藏输入的 Key'; });
        connection.append(reveal);
        addField('model', '嵌入模型').placeholder = '填写 Embedding 模型名称';
        addField('allowAnonymous', '此接口无需 API Key（仅用于开放服务）', 'checkbox');
        const notice = doc.createElement('p'); notice.style.cssText = 'font-size:0.9em;line-height:1.6;margin-bottom:0'; connection.append(notice);
        const updateNotice = () => {
            notice.textContent = '从 GitHub 安装扩展即可使用，无需复制文件或修改酒馆配置。Key 单独保存在当前酒馆账号的扩展设置中，浏览器可读取；不更改聊天 API。接口需允许浏览器跨域调用。';
            url.placeholder = provider.value === 'ollama' ? 'http://127.0.0.1:11434' : provider.value === 'gemini'
                ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://你的接口/v1（或完整 embeddings 地址）';
        };
        controls.updateNotice = updateNotice; provider.addEventListener('change', updateNotice); updateNotice();
        const retrieval = card('手机旧事检索');
        const enabled = addField('enabled', '启用向量辅助查找', 'checkbox'); retrieval.append(enabled.parentNode);
        const consent = doc.createElement('p'); consent.style.cssText = 'font-size:0.9em;line-height:1.6';
        consent.textContent = '启用后，已推送到当前酒馆聊天的手机片段会发送到向量 API 建立索引；需要查找旧事时会发送查询文字。关闭小手机后仍可用。连接失败时继续关键词查找。'; retrieval.append(consent);
        const advanced = doc.createElement('details'), advancedTitle = doc.createElement('summary');
        advancedTitle.textContent = '检索参数'; advanced.append(advancedTitle);
        for (const [name, title, step, max] of [['dimensions', '输出维度（0 为模型默认）', '1', '16384'],
            ['threshold', '语义相似度门槛', '0.01', '1'], ['margin', '不同事件的最小分差', '0.01', '1']]) {
            const input = addField(name, title, 'number'); input.min = '0'; input.max = max; input.step = step;
            advanced.append(input.parentNode);
        }
        const calibration = doc.createElement('p');
        calibration.textContent = '门槛需要用当前模型的相关和无关样例校准；连接测试只验证接口，不能证明剧情召回效果。';
        advanced.append(calibration); retrieval.append(advanced);
        const maintenance = card('连接状态与本聊天索引');
        const vectorStatus = doc.createElement('p'); vectorStatus.id = 'uwu-phone-vector-status'; vectorStatus.setAttribute?.('role', 'status');
        vectorStatus.style.cssText = 'font-size:0.9em;line-height:1.6;overflow-wrap:anywhere'; maintenance.append(vectorStatus);
        const buttons = doc.createElement('div'); buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px'; maintenance.append(buttons);
        const readForm = () => ({ enabled: controls.enabled.checked, provider: provider.value,
            url: controls.url.value, model: controls.model.value, allowAnonymous: controls.allowAnonymous.checked,
            dimensions: controls.dimensions.value, threshold: controls.threshold.value, margin: controls.margin.value });
        const saveForm = async () => {
            setVectorSettings(readForm());
            if (key.value.trim()) {
                const result = await saveVectorKey(key.value);
                if (!result.ok) return false;
                key.value = ''; key.type = 'password'; reveal.textContent = '显示输入的 Key';
            }
            return true;
        };
        const actionButtons = [];
        const action = (title, id, callback) => {
            const btn = doc.createElement('button'); btn.className = 'menu_button'; btn.id = id; btn.textContent = title;
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
            actionButtons.push(btn); buttons.append(btn); return btn;
        };
        action('保存设置与 Key', 'uwu-phone-vector-save', async () => {
            if (await saveForm()) { await vectors.refreshStatus(); renderVectorStatus(); }
        });
        action('清除已保存的 Key', 'uwu-phone-vector-clear-key', async () => {
            setVectorSettings(readForm()); const result = await saveVectorKey('', { clear: true });
            if (result.ok) key.value = '';
        });
        action('测试连接', 'uwu-phone-vector-test', async () => {
            if (await saveForm()) {
                const result = await testVectorConnection();
                if (result.ok && result.dimensions) vectorStatus.textContent += ` 返回 ${result.dimensions} 维向量。`;
            }
        });
        action('准备本聊天索引', 'uwu-phone-vector-index', async () => {
            if (await saveForm()) await prepareVectorIndex();
        });
        action('清除本聊天向量缓存', 'uwu-phone-vector-clear-cache', clearVectorCache);
        doc.body.append(dialog); renderVectorStatus();
    }
    function showVectorSettings() {
        mountVectorDialog();
        const dialog = getDocument()?.getElementById('uwu-phone-vector-dialog');
        if (!dialog || !vectorControls) return;
        if (!dialog.open && !vectorUiBusy) {
            const config = vectorSettings();
            for (const [name, value] of Object.entries(config)) {
                const control = vectorControls[name]; if (!control) continue;
                if (control.type === 'checkbox') control.checked = !!value;
                else control.value = String(value ?? '');
            }
            vectorControls.credential.value = ''; vectorControls.credential.type = 'password';
            getDocument().getElementById('uwu-phone-vector-reveal-key').textContent = '显示输入的 Key';
            vectorControls.updateNotice();
        }
        if (!dialog.open) dialog.showModal();
        return vectors.refreshStatus().then(() => renderVectorStatus()).catch(() => renderVectorStatus());
    }
    function initialize() {
        if (initialized || disposed) return;
        const ctx = getContext();
        const events = host.eventSource || ctx?.eventSource;
        const types = host.eventTypes || ctx?.eventTypes || ctx?.event_types;
        if (!events?.on || !types) throw new Error('酒馆生成事件接口未就绪');
        const on = (name, fn) => {
            if (!types[name]) return;
            events.on(types[name], fn); bindings.push([events, types[name], fn]);
        };
        if (!host.generationStartManaged) on('GENERATION_STARTED', start);
        on('CHAT_COMPLETION_PROMPT_READY', data => prune(data?.chat, 'messages', data?.dryRun));
        on('CHAT_COMPLETION_SETTINGS_READY', data => prune(data?.messages, 'messages', false, true,
            data?.type, !!data && Object.hasOwn(data, 'type')));
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
        initialized = true; clearSlot(); mountSettings();
        scheduleVectorIndex();
        if (!compatible(ctx)) { updatePreview({ reason: 'UNSUPPORTED' }); warn('UNSUPPORTED'); }
    }
    function dispose() {
        invalidate(); disposed = true;
        if (indexTimer !== null) { clearTimeout(indexTimer); indexTimer = null; }
        for (const [events, type, fn] of bindings) (events.removeListener || events.off)?.call(events, type, fn);
        bindings.length = 0;
        for (const id of ['uwu-phone-memory-settings', 'uwu-phone-vector-dialog', 'uwu-phone-vector-menu']) getDocument()?.getElementById?.(id)?.remove();
    }
    return { initialize, startGeneration: start, interceptor, invalidate, setEnabled, getPreview, selectManual, availableSources, dispose,
        getVectorSettings: () => clone(vectorSettings()), setVectorSettings,
        getVectorState: () => clone(vectors.getState()), refreshVectorStatus: () => vectors.refreshStatus(),
        saveVectorKey, testVectorConnection, prepareVectorIndex, clearVectorCache, showVectorSettings };
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

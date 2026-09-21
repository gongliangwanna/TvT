// --- 酒馆互通外挂：核心模块 (tavern/tavern_sync.js) ---
// 从 st 版 js/modules/tavern_sync.js 移植而来，不属于 yuan 原版文件。
// 整个文件包在一个函数里，避免和 yuan 自己的变量/函数重名；
// 对外只通过 window.TavernSync / window.setupTavernSyncScreen 等几个名字暴露。
(function () {


// 酒馆楼层发给 AI 时的包裹提示词（可在酒馆互联页面自定义）
// 可用变量：{{楼层}} 酒馆楼层号（从 0 数）、{{发言人}}、{{内容}}、{{时间}}（柏宝书记录的故事内时间，没有则为“时间不详”）
const DEFAULT_WRAP_NOTE = '聊天记录中以“[线下剧情”开头的内容，是你和{{用户}}在线下实际经历过的剧情，不是手机消息。请把它们当作已经发生的事自然衔接，你的回复仍然按手机聊天的格式输出，不要模仿其中的叙事文风。';
// 旧版默认说明（带“（酒馆）”）。没改过默认值的老数据会自动换成新版
const OLD_DEFAULT_WRAP_NOTE = '聊天记录中以“[线下剧情”开头的内容，是你和{{用户}}在线下（酒馆）实际经历过的剧情，不是手机消息。请把它们当作已经发生的事自然衔接，你的回复仍然按手机聊天的格式输出，不要模仿其中的叙事文风。';
const DEFAULT_WRAP_RAW = '[线下剧情·酒馆第{{楼层}}楼·{{发言人}}：\n{{内容}}\n]';
const DEFAULT_WRAP_SUMMARY = '[线下剧情摘要·酒馆第{{楼层}}楼（{{时间}}）：{{内容}}]';

// 读取柏宝书写在楼层上的摘要（extra.bbs_leaf）。
// 注意：这是柏宝书的内部数据格式，它的公开接口只能在酒馆页面里用，小手机页面调用不到，只能直接读。
// 判断方法照抄柏宝书 memory/apply.ts 的 leafValid：叶子结构完整，且属于当前显示的这一版回复（swipe）。
function readBaibaiSummary(m) {
    const leaf = m && m.extra && m.extra.bbs_leaf;
    if (!leaf) return null;
    if (!leaf.id || !leaf.delta || typeof leaf.text !== 'string') {
        TavernSync.reportIssue('读到的柏宝书摘要格式和预期不同，可能是柏宝书更新改了格式。这些楼层会先发原文，需要调整 tavern_sync.js 的 readBaibaiSummary');
        return null;
    }
    const leafSwipe = typeof leaf.swipe === 'number' ? leaf.swipe : 0;
    const msgSwipe = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
    if (leafSwipe !== msgSwipe) return null;
    const time = (leaf.timeStart && leaf.timeEnd && leaf.timeStart !== leaf.timeEnd)
        ? `${leaf.timeStart} ~ ${leaf.timeEnd}`
        : (leaf.timeEnd || leaf.timeStart || leaf.timeLabel || '');
    return { text: leaf.text.trim(), time };
}

// 读出酒馆楼层的真实发送时间（毫秒），用来把酒馆楼层按时间插进小手机聊天记录。读不懂返回 null。
// 酒馆的 send_date 是按界面语言格式化的文字，比如 "June 5, 2024 3:27pm"、中文界面下 "六月 5, 2024 3:27下午"，
// 浏览器（尤其手机 Safari）不一定认得，所以自己解析。AI 楼另有 gen_finished / gen_started（标准格式），优先用。
const MONTHS_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
function parseTimeValue(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v > 1e12 ? v : (v > 1e9 ? v * 1000 : null);
    const s = String(v).trim();
    if (/^\d{10,13}$/.test(s)) return parseTimeValue(Number(s));
    const valid = (t) => (Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t < Date.UTC(2100, 0, 1)) ? t : null;
    // 标准格式：2024-06-05T07:27:44.123Z
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return valid(Date.parse(s));
    // 月份名格式：June 5, 2024 3:27pm / 六月 5, 2024 3:27下午 / 6月 5, 2024 15:27
    let r = s.match(/^([A-Za-z]+|[一二三四五六七八九十]+月|\d{1,2}月)\.?\s*(\d{1,2})(?:日)?,?\s*(\d{4})\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|上午|下午|中午|晚上|凌晨|早上)?/i);
    if (r) {
        let month = null;
        const name = r[1].toLowerCase();
        if (/^[a-z]+$/.test(name)) month = MONTHS_EN[name.slice(0, 3)] || null;
        else if (/^\d+月$/.test(name)) month = parseInt(name, 10);
        else month = CN_NUM[name.replace('月', '')] || null;
        if (!month) return null;
        let hour = parseInt(r[4], 10);
        const ap = (r[7] || '').toLowerCase().replace(/\./g, '');
        if ((ap === 'pm' || ap === '下午' || ap === '晚上') && hour < 12) hour += 12;
        if (ap === '中午' && hour < 11) hour += 12;
        if ((ap === 'am' || ap === '上午' || ap === '凌晨' || ap === '早上') && hour === 12) hour = 0;
        return valid(new Date(+r[3], month - 1, +r[2], hour, +r[5], +(r[6] || 0)).getTime());
    }
    // 酒馆文件名那种格式：2024-6-5 @15h 27m 44s
    r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@?\s*(\d{1,2})h\s*(\d{1,2})m(?:\s*(\d{1,2})s)?/);
    if (r) return valid(new Date(+r[1], r[2] - 1, +r[3], +r[4], +r[5], +(r[6] || 0)).getTime());
    // 其他：交给浏览器试试（要求带四位年份，避免把奇怪的文字认成时间）
    return /\d{4}/.test(s) ? valid(Date.parse(s)) : null;
}
function readFloorTime(m) {
    return parseTimeValue(m.gen_finished) || parseTimeValue(m.gen_started) || parseTimeValue(m.send_date);
}

// 酒馆楼层里小手机推送的那一段 <phone_chat>。
// 小手机自己新开的楼层（uwu_created）整楼就是这一段；合并进剧情楼的，小手机那段总是接在楼层最末尾，
// 所以只认“最后一段”——前面如果还有 <phone_chat>，那是酒馆 AI 自己写的，不能动。
const PHONE_BLOCK_SRC = '<phone_chat>[\\s\\S]*?<\\/phone_chat>';
function lastPhoneBlock(mes) {
    const text = mes || '';
    const re = new RegExp(PHONE_BLOCK_SRC, 'g');
    let m, last = null;
    while ((m = re.exec(text))) last = { start: m.index, end: m.index + m[0].length, text: m[0] };
    return last;
}
// 去掉小手机那一段，留下酒馆原本的内容
function stripOwnPhoneBlock(mes) {
    const b = lastPhoneBlock(mes);
    if (!b) return (mes || '').trim();
    return (mes.slice(0, b.start) + mes.slice(b.end)).trim();
}
// 把小手机那一段换成新的
function replaceOwnPhoneBlock(mes, block) {
    const b = lastPhoneBlock(mes);
    if (!b) return mes;
    return mes.slice(0, b.start) + block + mes.slice(b.end);
}

// 柏宝书摘要是不是真的没了（酒馆里删掉了，或者属于另一个抽卡版本）。格式看不懂时不算“没了”，免得误删
function baibaiSummaryGone(m) {
    const leaf = m && m.extra && m.extra.bbs_leaf;
    if (!leaf) return true;
    if (!leaf.id || !leaf.delta || typeof leaf.text !== 'string') return false;
    const leafSwipe = typeof leaf.swipe === 'number' ? leaf.swipe : 0;
    const msgSwipe = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
    return leafSwipe !== msgSwipe || !leaf.text.trim();
}

const TavernSync = {
    // 文件版本：显示在“酒馆互联”页面最下面，用来确认手机上加载的是不是最新文件（浏览器有时会用缓存的旧文件）
    SYNC_VERSION: '2026-09-21 k',
    DEFAULT_WRAP_NOTE,
    DEFAULT_WRAP_RAW,
    DEFAULT_WRAP_SUMMARY,

    // ========== 问题记录 ==========
    // 手机上看控制台不方便，所以出问题时记在这里，显示在“酒馆互联”页面顶部。
    // 存在浏览器本地（localStorage），关掉页面再打开还在；最多留 20 条，可以在页面上手动清空。
    issues: [],
    _issuesKey: 'tavernSyncIssues',
    loadIssues() {
        if (this._issuesLoaded) return this.issues;
        this._issuesLoaded = true;
        try {
            const raw = localStorage.getItem(this._issuesKey);
            const list = raw ? JSON.parse(raw) : [];
            if (Array.isArray(list)) this.issues = list.filter(x => x && typeof x.text === 'string').slice(-20);
        } catch (e) { /* 读不出来就当没有 */ }
        return this.issues;
    },
    saveIssues() {
        try { localStorage.setItem(this._issuesKey, JSON.stringify(this.issues)); } catch (e) { /* 存不下就算了 */ }
    },
    clearIssues() {
        this.issues.length = 0;
        try { localStorage.removeItem(this._issuesKey); } catch (e) { /* 忽略 */ }
    },
    // kind：这条问题属于哪一类（'push' / 'pull'）。同一类的操作后来成功了，就把旧的失败记录撤掉，
    // 免得“其实已经好了”的红字一直留在页面上造成误会。不写 kind 的（格式看不懂之类）一直留着。
    reportIssue(message, kind) {
        const text = String(message);
        console.error('[酒馆外挂]', text);
        this.loadIssues();
        const last = this.issues[this.issues.length - 1];
        if (last && last.text === text) { last.count++; last.time = Date.now(); }
        else {
            this.issues.push({ text, time: Date.now(), count: 1, kind: kind || undefined });
            if (this.issues.length > 20) this.issues.shift();
        }
        this.saveIssues();
        this._notifyIssues();
    },

    // 页面开着时，同步/推送完成后重画绑定卡片（楼数、字数、“第一次…”那几行）。连着好几次只画一回
    _notifyData() {
        if (typeof this._onDataChanged !== 'function') return;
        clearTimeout(this._dataTimer);
        this._dataTimer = setTimeout(() => { try { this._onDataChanged(); } catch (e) { /* 画不出来就算了 */ } }, 50);
    },

    // 页面开着时，问题记录一变就重画（由酒馆互联页面挂上 _onIssuesChanged）
    _notifyIssues() {
        if (typeof this._onIssuesChanged === 'function') { try { this._onIssuesChanged(); } catch (e) { /* 页面画不出来就算了 */ } }
    },

    // 某一类操作成功了 → 把这一类的失败记录删掉（自动重试成功、或者你手动点成功了都会走这里）
    resolveIssues(kind) {
        if (!kind) return 0;
        this.loadIssues();
        const before = this.issues.length;
        const kept = this.issues.filter(it => it.kind !== kind);
        if (kept.length === before) return 0;
        this.issues.length = 0;
        this.issues.push(...kept);
        this.saveIssues();
        this._notifyIssues();
        return before - kept.length;
    },

    getConfig() {
        if (!db.tavernSync || typeof db.tavernSync !== 'object') {
            db.tavernSync = { enabled: false, bindings: [], maxInjectMessages: 50, cleanRules: [], pushIncludeStatusBar: true };
        }
        // 确保关键字段存在（防止旧数据缺少新字段）
        if (!Array.isArray(db.tavernSync.bindings)) db.tavernSync.bindings = [];
        if (!Array.isArray(db.tavernSync.cleanRules)) db.tavernSync.cleanRules = [];
        if (typeof db.tavernSync.pushIncludeStatusBar !== 'boolean') db.tavernSync.pushIncludeStatusBar = true;
        if (typeof db.tavernSync.pushIncludeOnlineStatus !== 'boolean') db.tavernSync.pushIncludeOnlineStatus = false;
        if (typeof db.tavernSync.injectUserFloors !== 'boolean') db.tavernSync.injectUserFloors = true;
        const numOr = (v, d) => (Number.isInteger(v) && v >= 0) ? v : d;
        db.tavernSync.initialImportCount = numOr(db.tavernSync.initialImportCount, 20);
        db.tavernSync.rawFloorCount = numOr(db.tavernSync.rawFloorCount, 3);
        if (typeof db.tavernSync.wrapNote !== 'string' || db.tavernSync.wrapNote === OLD_DEFAULT_WRAP_NOTE) db.tavernSync.wrapNote = DEFAULT_WRAP_NOTE;
        if (typeof db.tavernSync.wrapRaw !== 'string' || !db.tavernSync.wrapRaw.trim()) db.tavernSync.wrapRaw = DEFAULT_WRAP_RAW;
        if (typeof db.tavernSync.wrapSummary !== 'string' || !db.tavernSync.wrapSummary.trim()) db.tavernSync.wrapSummary = DEFAULT_WRAP_SUMMARY;
        return db.tavernSync;
    },

    async saveConfig(config) {
        db.tavernSync = config;
        await saveData();
        console.log('[TavernSync] Config saved, bindings:', (config.bindings || []).length);
    },

    // ========== API ==========
    // 作为 ST 扩展运行时，与 ST 同源，浏览器自动带 session cookie。
    // 但 ST 启用了 CSRF，需要在每个 POST 里带 X-CSRF-Token 头。
    _csrfToken: null,
    async _getCsrfToken() {
        if (this._csrfToken) return this._csrfToken;
        try {
            const r = await fetch('/csrf-token', { credentials: 'same-origin' });
            if (r.ok) {
                const j = await r.json();
                this._csrfToken = j.token || '';
            }
        } catch (e) { console.warn('[TavernSync] 获取 CSRF token 失败:', e.message); }
        return this._csrfToken || '';
    },
    async _stFetch(url, opts = {}) {
        const token = await this._getCsrfToken();
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (token) headers['X-CSRF-Token'] = token;
        return fetch(url, Object.assign({ credentials: 'same-origin' }, opts, { headers }));
    },

    async getUserList() {
        const resp = await this._stFetch('/api/users/list', { method: 'POST', body: '{}' });
        if (resp.status === 204) return [];
        if (!resp.ok) throw new Error(`获取用户列表失败: ${resp.status}`);
        return resp.json();
    },

    async login(handle, password) {
        const body = { handle };
        if (password) body.password = password;
        const resp = await this._stFetch('/api/users/login', { method: 'POST', body: JSON.stringify(body) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || `登录失败: ${resp.status}`); }
        return resp.json();
    },

    async apiCall(endpoint, body = {}) {
        const resp = await this._stFetch(`${endpoint}`, { method: 'POST', body: JSON.stringify(body) });
        if (resp.status === 403) throw new Error('未登录或会话过期，请刷新页面');
        if (!resp.ok) throw new Error(`API ${resp.status}`);
        const data = await resp.json();
        if (endpoint === '/api/chats/save') this._announceChatSaved(body.avatar_url, body.file_name);
        return data;
    },

    // 小手机改了酒馆的聊天文件后，通知同一浏览器里开着的酒馆页面（st-launcher.js 在那边听）。
    // 酒馆页面手里拿着的是改之前的聊天，不重新读一遍的话，它下次保存会把小手机写进去的内容盖掉。
    // 每次保存有一个编号 saveId：酒馆那边如果当时正忙（生成回复/编辑楼层），忙完会把这些编号回给小手机，
    // 小手机据此核对那几次推送的内容还在不在（见 recoverLostPushes）。
    _lastSaveId: null,
    _mySaveIds: new Set(),      // 这个页面自己发出的保存编号（别的小手机页面发的不归我们管，免得两个页面重复补推）
    _announceChatSaved(avatar, file) {
        const saveId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this._lastSaveId = saveId;
        this._mySaveIds.add(saveId);
        if (this._mySaveIds.size > 200) this._mySaveIds.delete(this._mySaveIds.values().next().value);
        try {
            const ch = this._getChannel();
            if (ch) ch.postMessage({ type: 'chat-saved', avatar, file, saveId, time: Date.now() });
        } catch (e) { /* 通知不了就算了，不影响保存 */ }
        return saveId;
    },

    _getChannel() {
        if (typeof BroadcastChannel !== 'function') return null;
        if (!this._channel) {
            this._channel = new BroadcastChannel('uwu-tavern-sync');
            // 酒馆那边回话：「你那几次保存的时候我正忙，忙完我存了自己手里的版本，可能把你写的盖掉了」
            this._channel.addEventListener('message', (e) => {
                const d = e.data;
                // 酒馆页面回答了“我在”（见 pingTavernPage）
                if (d && d.type === 'pong' && d.id && this._pings && this._pings.has(d.id)) {
                    this._pings.get(d.id)(true);
                    this._pings.delete(d.id);
                    return;
                }
                if (!d || d.type !== 'tavern-maybe-overwrote' || !Array.isArray(d.saveIds)) return;
                const mine = d.saveIds.filter(id => this._mySaveIds.has(id));
                if (!mine.length) return;
                const cfg = this.getConfig();
                if (!cfg.enabled) return;
                const binding = cfg.bindings.find(b => b.stCharAvatar === d.avatar && b.stChatFile === d.file);
                if (!binding) return;
                this.recoverLostPushes(binding, { saveIds: mine, report: d })
                    .catch(err => this.reportIssue('核对被酒馆盖掉的推送时出错：' + err.message, 'push'));
            });
        }
        return this._channel;
    },

    // 同一个浏览器里有没有开着的酒馆页面（装了本补丁的）。有 → 小手机推送后它会自动重新读取，不用手动刷新；
    // 没有 → 酒馆可能开在别的设备/浏览器，界面上提醒你回去继续玩之前先刷新。返回 true/false
    pingTavernPage(timeoutMs = 800) {
        const ch = this._getChannel();
        if (!ch) return Promise.resolve(false);
        if (!this._pings) this._pings = new Map();
        const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise(resolve => {
            this._pings.set(id, resolve);
            setTimeout(() => { if (this._pings.has(id)) { this._pings.delete(id); resolve(false); } }, timeoutMs);
            try { ch.postMessage({ type: 'ping', id }); } catch (e) { this._pings.delete(id); resolve(false); }
        });
    },

    // ========== 被酒馆盖掉的推送：发现后补推 ==========
    // 酒馆保存时是把它手里的整份聊天写回去。小手机推送的那一刻酒馆正在生成回复的话，
    // 它生成完保存的那份里没有小手机刚推的内容，等于盖掉了。
    // 做法：每次推送记一笔（binding.recentPushes：推了哪几条、什么时候、哪次保存），然后在两个时机核对：
    //   1. 酒馆那边回话说“刚才可能盖掉了”（带着那几次保存的编号）→ 马上核对那几次；
    //   2. 兜底：每次推送前核对最近 5 分钟推过的（酒馆回话时小手机页面已经关了、或者酒馆因为别的原因保存）。
    // 酒馆里找不到、小手机里还在、不是你用「清理酒馆」删掉的 → 重新推一次，并在页面顶部记一条。
    RECENT_PUSH_CHECK_MS: 5 * 60 * 1000,     // 兜底核对多久以内推的
    RECENT_PUSH_KEEP_MS: 30 * 60 * 1000,     // 记录最多留多久（酒馆生成特别久时，回话也能对上）

    _logPush(binding, entry) {
        if (!entry || !Array.isArray(entry.ids) || !entry.ids.length) return;
        const now = Date.now();
        const list = (Array.isArray(binding.recentPushes) ? binding.recentPushes : [])
            .filter(x => x && now - x.time < this.RECENT_PUSH_KEEP_MS);
        list.push(Object.assign({ time: now, saveId: this._lastSaveId }, entry));
        binding.recentPushes = list.slice(-50);
    },

    // “推过的消息名单”（binding.pushedIds）：推送窗口靠它找出“以前推过、现在酒馆里找不到”的消息。
    // 不能只看“上次推到哪一条”：第一次只推最近 50 条的话，更早的几千条从没推过，不该算成丢了
    _rememberPushed(binding, ids) {
        if (!ids || !ids.length) return;
        const set = new Set(Array.isArray(binding.pushedIds) ? binding.pushedIds : []);
        ids.forEach(id => set.add(id));
        binding.pushedIds = [...set];
    },

    // 推送窗口里点「忽略」：这些消息从名单里去掉，以后不再提示（再推一次会重新记上）
    async ignoreMissing(binding, ids) {
        const drop = new Set(ids || []);
        binding.pushedIds = (Array.isArray(binding.pushedIds) ? binding.pushedIds : []).filter(id => !drop.has(id));
        await this.saveConfig(this.getConfig());
    },

    // 从推送记录里去掉这些消息（「清理酒馆」删掉的，不该被当成“被盖掉”补回去，也不该在推送窗口里提示“丢了”）
    _forgetPushes(binding, ids) {
        if (!ids || !ids.size) return;
        if (Array.isArray(binding.pushedIds)) binding.pushedIds = binding.pushedIds.filter(id => !ids.has(id));
        if (!Array.isArray(binding.recentPushes)) return;
        binding.recentPushes = binding.recentPushes
            .map(x => Object.assign({}, x, { ids: x.ids.filter(id => !ids.has(id)) }))
            .filter(x => x.ids.length);
    },

    // opts.saveIds：只核对这几次保存（酒馆回话时）；不给就核对最近 5 分钟推过的（兜底）
    // opts.report：酒馆回话的完整内容，用来把原因写清楚
    async recoverLostPushes(binding, opts = {}) {
        return this._recoverLostPushes(binding, opts);
    },
    async _recoverLostPushes(binding, opts = {}) {
        const now = Date.now();
        const all = (Array.isArray(binding.recentPushes) ? binding.recentPushes : [])
            .filter(x => x && now - x.time < this.RECENT_PUSH_KEEP_MS);
        const bySave = Array.isArray(opts.saveIds) ? new Set(opts.saveIds) : null;
        const toCheck = all.filter(x => bySave ? bySave.has(x.saveId) : (now - x.time < this.RECENT_PUSH_CHECK_MS));
        if (!toCheck.length) return { recovered: 0 };
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) return { recovered: 0 };

        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const present = new Set();
        (Array.isArray(stMsgs) ? stMsgs : []).forEach(m => {
            const ids = m && m.extra && m.extra.uwu_msg_ids;
            if (Array.isArray(ids)) ids.forEach(id => present.add(id));
        });
        const { phoneById } = this._pushHelpers(char, binding);
        const lostRaw = new Set();
        const lostSummaries = [];
        const handled = new Set();     // 发现丢了、这次要补推的记录
        for (const entry of toCheck) {
            const missing = entry.ids.filter(id => !present.has(id) && phoneById.has(id));
            if (!missing.length) continue;
            if (entry.kind === 'summary') {
                // 小总结那一楼整楼没了才算被盖掉（还剩一部分说明楼还在，只是你在小手机里删了几条）
                if (!entry.ids.some(id => present.has(id)) && entry.text) { lostSummaries.push(entry); handled.add(entry); }
            } else {
                missing.forEach(id => lostRaw.add(id));
                handled.add(entry);
            }
        }
        if (!handled.size) return { recovered: 0 };
        // 只清掉丢了的那几笔（还在的留着：酒馆可能还没生成完，等它回话时还要对得上）。
        // 酒馆回话触发的补推会重新记一笔；兜底触发的不记
        binding.recentPushes = all.filter(x => !handled.has(x));

        const lostMsgs = char.history.filter(m => m && lostRaw.has(m.id));
        let pushedRaw = 0;
        if (lostMsgs.length) {
            // 酒馆回话触发的补推照样记一笔（万一又撞上酒馆生成）；兜底触发的不记，免得你在酒馆里故意删的被一遍遍推回来
            const r = await this._pushToTavern(binding, undefined, true, { messages: lostMsgs, recovering: true, noLog: !opts.report });
            pushedRaw = r.pushed;
        }
        for (const entry of lostSummaries) {
            await this._pushSummaryToTavern(binding, entry.text, entry.ids[entry.ids.length - 1], entry.ids, { noLog: !opts.report });
        }
        await this.saveConfig(this.getConfig());

        // 写清楚：丢了什么、为什么、补到哪了
        const fmt = (ts) => {
            if (!ts) return '?';
            const d = new Date(ts);
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        };
        const ch = db.characters.find(c => c.id === binding.uwuCharId);
        const who = ch ? (ch.remarkName || ch.name) : '这个角色';
        const preview = lostMsgs.slice(0, 3).map(m => {
            const t = String(m.content || '').replace(/\s+/g, ' ').trim();
            return `「${t.length > 20 ? t.slice(0, 20) + '…' : t}」`;
        }).join('、') + (lostMsgs.length > 3 ? ` 等 ${lostMsgs.length} 条` : '');
        const pushedAt = toCheck.filter(x => x.ids.some(id => lostRaw.has(id)) || lostSummaries.includes(x)).map(x => fmt(x.time));
        const parts = [];
        if (pushedRaw) parts.push(`${pushedRaw} 条消息${preview ? '（' + preview + '）' : ''}`);
        if (lostSummaries.length) parts.push(`${lostSummaries.length} 段小总结`);
        let why;
        const d = opts.report;
        if (d) {
            const doing = d.busyReason === 'editing' ? '你正在酒馆里编辑某一楼' : '酒馆正在生成回复';
            why = `小手机在 ${[...new Set(pushedAt)].join('、')} 推送时，${doing}`
                + `（酒馆 ${fmt(d.busySince)} 发现、${fmt(d.busyEnded)} 忙完）。`
                + `酒馆忙完后保存了它自己手里的那份聊天，那份里没有这些内容，于是盖掉了`
                + (typeof d.floorCount === 'number' ? `；酒馆重新读取后这个聊天共 ${d.floorCount} 楼` : '')
                + '。';
        } else {
            why = `小手机在 ${[...new Set(pushedAt)].join('、')} 推送过，5 分钟内再看时酒馆里已经找不到了。`
                + '可能是酒馆保存时把它们盖掉了（比如别的扩展在后台写摘要时保存了一次，或者酒馆开在另一个浏览器里），'
                + '也可能是你在酒馆里刚把那一楼删了——如果是你删的，去酒馆再删一次即可，之后不会再补。';
        }
        this.reportIssue(`「${who}」推到酒馆的 ${parts.join('、')}被酒馆盖掉了，已经重新推送到酒馆最后面。原因：${why}`);
        return { recovered: pushedRaw + lostSummaries.length };
    },

    async testConnection() {
        try { const chars = await this.apiCall('/api/characters/all', {}); return { ok: true, count: chars.length }; }
        catch (e) { return { ok: false, error: e.message }; }
    },

    async getSTCharacters() { return this.apiCall('/api/characters/all', {}); },
    async getSTCharacter(avatar) { return this.apiCall('/api/characters/get', { avatar_url: avatar }); },
    async getSTChats(avatar) { return this.apiCall('/api/characters/chats', { avatar_url: avatar, simple: true }); },
    async getSTChatMessages(avatar, file) { return this.apiCall('/api/chats/get', { avatar_url: avatar, file_name: file }); },
    async getSTWorldInfo(name) { return this.apiCall('/api/worldinfo/get', { name }); },
    async getSTSettings() {
        const resp = await this.apiCall('/api/settings/get', {});
        if (typeof resp.settings === 'string') return JSON.parse(resp.settings);
        return resp.settings || resp;
    },

    // ========== 正则清洗 ==========

    /**
     * @param {string} text - 消息文本
     * @param {number|null} depth - 消息深度（0 = 最新一条，1 = 倒数第二条…），null 表示不过滤深度
     */
    // direction：'pull' = 从酒馆同步进小手机，'push' = 从小手机推送到酒馆。
    // 每条规则的 scope 决定用在哪一头（'pull' / 'push' / 'both'，老规则没有这一项就当 'both'）。
    // 旧版的“生效深度”（minDepth/maxDepth）在 yuan 补丁里从来没起过作用，已经删掉。
    applyCleanRules(text, direction) {
        if (!text || typeof text !== 'string') return '';
        const config = this.getConfig();
        const rules = (config.cleanRules || []).filter(r => r.enabled
            && (!r.scope || r.scope === 'both' || !direction || r.scope === direction));
        let result = text;
        for (const rule of rules) {
            try {
                const regex = new RegExp(rule.regex, 'gs');
                if (rule.mode === 'extract') {
                    const matches = [...result.matchAll(regex)];
                    if (matches.length) result = matches.map(m => m[1] !== undefined ? m[1] : m[0]).join('\n');
                } else {
                    result = result.replace(regex, '');
                }
            } catch (e) { console.warn(`[TavernSync] Invalid regex "${rule.name}":`, e.message); }
        }
        return result.trim();
    },

    // ========== 同步操作 ==========

    // 从酒馆同步（yuan 版重写）：
    // 把酒馆里“上次同步之后”的新楼层接到小手机聊天记录末尾（fromTavern 消息），
    // 界面上显示成折叠卡片（见 tavern_hooks.js），发给 AI 时按 prepareHistoryForAI 换成包裹后的原文或柏宝书摘要。
    // 同时把柏宝书后来补写的摘要填进之前导入的楼层。
    async pullFromTavern(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        if (!Array.isArray(char.history)) char.history = [];
        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) return { imported: 0, summariesFilled: 0 };

        // 聊天文件第一行是聊天设置（没有 mes 字段），真正的楼层从下一行开始；楼层号和酒馆一样从 0 数
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const floors = raw.slice(offset).map((m, floor) => ({ m, floor }));
        // 跳过：小手机自己推送过去的楼层、柏宝书标记的番外/提示楼、空楼
        const candidates = floors.filter(({ m }) =>
            m && typeof m.mes === 'string' && m.mes.trim()
            && !(m.extra && m.extra.uwu_created)
            && !(m.extra && m.extra.bbs_omit));
        candidates.forEach((c, i) => { c.idx = i; });

        // 认楼层：发送时间 + 是不是用户；AI 楼再加上“开始生成时间”（精确到毫秒），
        // 因为发送时间只精确到分钟，同一分钟里的两楼光靠它分不开。旧版导入的楼层没记 genStarted，就不比这一项。
        // 楼层多时一楼楼比太慢，先按“发送时间 + 是不是用户”分好组再比。
        const findCandidate = this._floorLookup(candidates, c => c.m);
        const prevMemory = char.tavernMemory || {};
        const chatFile = binding.stChatFile;
        // 每张卡片记着自己来自哪个酒馆聊天（tavern.chatFile）。换绑到另一个聊天后，旧聊天的卡片留在小手机里当回忆，
        // 但不再拿来和新聊天比对，也不会被当成新聊天的起点（以前会拿旧聊天的楼层号当起点，导致新聊天迟迟导不进来）
        this._tagChatFiles(char, chatFile);
        const ofThisChat = (m) => !!(m && m.fromTavern && m.tavern && m.tavern.chatFile === chatFile);
        const sameChat = prevMemory.stChatFile === chatFile;

        // 柏宝书的一段摘要写的是「一整个回合」：某一楼 AI 回复 + 它前面紧挨着的那些非 AI 楼
        //（番外楼跳过，见柏宝书 engine.ts 的 floorTargets）。摘要存在那一楼 AI 上。
        // 这里按酒馆的完整楼层表算出「每一楼属于哪一回合」，记进 tavern.roundAi。
        // 有了它，发给 AI 时才敢拿某段摘要代表你发的那一楼——光看“挨着”会出错：
        // 比如中间那楼 AI 卡片被你在小手机里删了，后面那楼的摘要其实盖不到前面。
        const roundAiOf = new Map();
        {
            let waiting = [];
            for (const { m, floor } of floors) {
                if (!m || typeof m.mes !== 'string') continue;
                if (m.extra && m.extra.bbs_omit) continue;          // 番外楼：柏宝书当它不存在
                if (!m.is_user) {                                    // 一楼 AI 回复 → 这一回合到此为止
                    waiting.forEach(f => roundAiOf.set(f, floor));
                    roundAiOf.set(floor, floor);
                    waiting = [];
                } else {
                    waiting.push(floor);
                }
            }
            waiting.forEach(f => roundAiOf.set(f, null));            // 还没等到 AI 回复的那几楼
        }
        const roundAiFor = (floor) => (roundAiOf.has(floor) ? roundAiOf.get(floor) : null);

        // 0. 酒馆里被删掉的楼层，小手机里也删掉（只删这个酒馆聊天的卡片，不动小手机自己的消息）。
        //    保险：以前同步过（卡片的来源聊天记得准）；从酒馆读回来是空的（比如出错）就完全不动；
        //    认楼层用的是和导入完全一样的那套标准。在酒馆里给某楼重新抽卡（swipe）也会走这里：
        //    旧的算没了、新的当成新楼层导入，卡片内容跟着换。
        let removedGone = 0;
        if (prevMemory.stChatFile && candidates.length) {
            const before = char.history.length;
            char.history = char.history.filter(m => !ofThisChat(m) || findCandidate(m.tavern));
            removedGone = before - char.history.length;
        }

        const imported = char.history.filter(ofThisChat);

        // 1. 找出要导入的楼层：从“起点楼层”（第一次同步时导入的最早一楼）往后，所有小手机里还没有的楼层。
        //    所以在小手机里删掉的酒馆楼层，下次同步会重新出现。
        //    从没导入过：起点 = 最近“第一次同步导入楼数”楼中最早的一楼。
        //    换绑了另一个酒馆聊天时，旧的起点作废（小手机里已经有这个聊天的卡片时，从最早那张接着来）
        let start = (sameChat && prevMemory.importStart)
            || (imported[0] && { sendDate: imported[0].tavern.sendDate, isUser: imported[0].tavern.isUser, floor: imported[0].tavern.floor });
        // 用户在“管理同步范围”里选过结束楼层时：只要 [起点, 结束] 这一段，外加“当时酒馆最后一楼”之后的新楼层。
        // start.none 表示一楼旧的都不要，只要 resumeAfter 之后的新楼层。
        const importEnd = sameChat ? (prevMemory.importEnd || null) : null;
        let resumeAfter = sameChat ? (prevMemory.resumeAfter || null) : null;
        let startIdx;
        if (start) {
            const hit = start.none ? null : findCandidate(start);
            startIdx = hit ? hit.idx : candidates.findIndex(c => c.floor >= start.floor);   // 起点那楼在酒馆里被删了
            if (startIdx < 0) startIdx = candidates.length;
        } else {
            const firstCount = this.initialImportFor(binding);
            startIdx = firstCount > 0 ? Math.max(0, candidates.length - firstCount) : candidates.length;
            const first = candidates[startIdx];
            if (first) {
                start = { sendDate: first.m.send_date, isUser: !!first.m.is_user, floor: first.floor };
            } else {
                // 这次一楼都不导入（第一次同步填了 0 楼，或者酒馆里还没有楼层）：记下“从现在起只要新楼层”。
                // 不记的话下次同步又当成第一次、又导入 0 楼，新楼层永远进不来
                start = { none: true };
                const last = candidates[candidates.length - 1];
                resumeAfter = last ? this._markerOf(last.m, last.floor) : { floor: -1 };
            }
        }
        const findMarker = (mk) => {
            if (!mk) return -1;
            const hit = findCandidate(mk);
            if (hit) return hit.idx;
            for (let j = candidates.length - 1; j >= 0; j--) if (candidates[j].floor <= mk.floor) return j;
            return -1;
        };
        if (start && start.none) startIdx = candidates.length;
        const endIdx = importEnd ? findMarker(importEnd) : null;
        const resumeIdx = resumeAfter ? findMarker(resumeAfter) : null;
        const inRange = (i) => (i >= startIdx && (endIdx == null || i <= endIdx)) || (resumeIdx != null && i > resumeIdx);
        // 小手机里已经有的楼层，以及精简时连同 AI 楼一起收走的 user 楼（身份记在 AI 卡片的 roundUsers 里），都不要再导入
        const knownMarks = [];
        imported.forEach(h => {
            knownMarks.push(h.tavern);
            if (Array.isArray(h.tavern.roundUsers)) knownMarks.push(...h.tavern.roundUsers);
        });
        const isKnown = this._markerLookup(knownMarks);
        const newOnes = candidates.filter((c, i) => inRange(i) && !isKnown(c.m));

        // 每楼的真实发送时间：读不懂的沿用前一楼；并保证不早于前一楼（酒馆时间只精确到分钟，可能打平）
        let prevTime = null;
        const unreadable = [];
        for (const c of candidates) {
            let t = readFloorTime(c.m);
            if (t == null) { if (c.m.send_date) unreadable.push(String(c.m.send_date)); t = prevTime; }
            if (t != null && prevTime != null && t < prevTime) t = prevTime;
            c.time = t;
            if (t != null) prevTime = t;
        }
        if (unreadable.length) {
            this.reportIssue(`有 ${unreadable.length} 楼酒馆楼层的时间读不懂（例如“${unreadable[0]}”），这些楼会排在前一楼后面。需要调整 tavern_sync.js 的 parseTimeValue`);
        }

        let now = Date.now();
        let importedCount = 0;
        for (const c of newOnes) {
            const { m, floor, time } = c;
            let text = m.mes;
            // 合并到这一楼的小手机内容（最后那段 <phone_chat>）去掉，只保留酒馆原本的内容
            if (m.extra && m.extra.from_uwu) text = stripOwnPhoneBlock(text);
            const cleaned = this.applyCleanRules(text, 'pull');
            if (!cleaned) continue;
            char.history.push({
                id: `tavern_${now}_${Math.random().toString(36).slice(2, 8)}`,
                role: 'system',
                content: cleaned,
                parts: [],
                timestamp: time != null ? time : now++,
                fromTavern: true,
                tavern: {
                    floor,
                    time,
                    chatFile,
                    sendDate: m.send_date,
                    genStarted: String(m.gen_started || ''),
                    isUser: !!m.is_user,
                    name: m.is_user ? (char.myName || m.name || '我') : (char.realName || m.name || char.name),
                    roundAi: roundAiFor(floor),
                    summary: readBaibaiSummary(m),
                },
            });
            importedCount++;
        }

        // 2. 柏宝书的摘要通常比回复晚一步写好：把之前导入、当时还没有摘要（或摘要已更新）的楼层补上；
        //    柏宝书把摘要撤掉了（或属于另一个抽卡版本）的，小手机里也清掉，免得发给 AI 的是作废的摘要。
        //    顺便更新楼层号（酒馆里删了楼之后，后面的楼层号会往前挪）和所属回合
        let summariesFilled = 0, summariesCleared = 0;
        for (const h of char.history) {
            if (!ofThisChat(h)) continue;
            const found = findCandidate(h.tavern);
            if (!found) continue;
            if (typeof h.tavern.time !== 'number' && found.time != null) h.tavern.time = found.time;
            if (h.tavern.floor !== found.floor) h.tavern.floor = found.floor;
            h.tavern.roundAi = roundAiFor(found.floor);   // 所属回合（酒馆后来才回复的，这时候才算得出来）
            if (h.tavern.genStarted === undefined) h.tavern.genStarted = String(found.m.gen_started || '');
            const summary = readBaibaiSummary(found.m);
            const oldText = h.tavern.summary && h.tavern.summary.text;
            if (summary && summary.text !== oldText) {
                h.tavern.summary = summary;
                if (h.tavern.trimmed) h.content = summary.text;   // 已精简的楼层，正文就是摘要，一起更新
                summariesFilled++;
            } else if (!summary && oldText && !h.tavern.trimmed && baibaiSummaryGone(found.m)) {
                h.tavern.summary = null;                           // 已精简的不清：它的正文就是这段摘要
                summariesCleared++;
            }
        }

        // 3. 按真实时间把酒馆楼层排进小手机聊天记录（包括以前导入时排错位置的）
        const reordered = this.placeTavernFloors(char);

        // 3.5 打开了“自动精简旧楼层”时：保留范围以外、已经有摘要的楼层只留摘要（原文随时能从酒馆取回）
        //     这里已经在写入排队里了，直接调不排队的那一份，否则会自己等自己
        let autoTrimmed = 0;
        if (binding.autoTrim) {
            try { autoTrimmed = (await this._trimFloors(binding, { keepLast: this.keepRawFloorCount(binding) })).trimmed; }
            catch (e) { this.reportIssue('自动精简旧楼层失败：' + e.message); }
        }

        // 4. 打开了“自动更新复制过的世界书”时，把酒馆里改过的条目同步到小手机的世界书
        let worldUpdated = 0;
        if (binding.autoUpdateWorldBooks) {
            try { worldUpdated = (await this.syncCopiedWorldBooks(binding)).updated; }
            catch (e) { this.reportIssue("自动更新世界书失败：" + e.message); }
        }

        // 4.5 打开了“自动更新酒馆人设”时，把酒馆里改过的人设更新到小手机
        let personaUpdated = 0;
        if (binding.autoUpdatePersona) {
            try { personaUpdated = (await this.syncPersona(binding)).updated; }
            catch (e) { this.reportIssue('自动更新酒馆人设失败：' + e.message); }
        }

        char.tavernMemory = {
            lastSync: Date.now(),
            stCharAvatar: binding.stCharAvatar,
            stChatFile: chatFile,
            lastImported: importedCount,
            importStart: start || null,
            importEnd,
            resumeAfter: resumeAfter || null,
        };

        this.resolveIssues('pull');   // 这次同步成功了，之前“同步失败”的记录就不用留着了
        await saveData();
        // 正在看这个角色的聊天 → 重新画一遍，新卡片立刻出现
        if (importedCount > 0 || reordered || removedGone > 0 || summariesFilled > 0 || summariesCleared > 0) {
            this._rerender(char);
        }
        // 顺便看看酒馆里是不是开了新聊天（出错不影响这次同步）
        try { await this._checkNewerChat(binding); } catch (e) { console.warn('[TavernSync] 检查酒馆新聊天失败:', e.message); }
        this._notifyData();
        return { imported: importedCount, summariesFilled, summariesCleared, reordered, worldUpdated, personaUpdated, autoTrimmed, removedGone };
    },

    // 给还没记来源聊天的旧卡片补上：算作上次同步的那个聊天（没同步记录时算作现在绑定的聊天）
    _tagChatFiles(char, fallbackFile) {
        const legacy = (char && char.tavernMemory && char.tavernMemory.stChatFile) || fallbackFile;
        (char && Array.isArray(char.history) ? char.history : []).forEach(m => {
            if (m && m.fromTavern && m.tavern && !m.tavern.chatFile) m.tavern.chatFile = legacy;
        });
    },

    // 这个角色在小手机里、来自当前绑定的酒馆聊天的卡片
    _floorsOfChat(char, binding) {
        this._tagChatFiles(char, binding.stChatFile);
        return (char.history || []).filter(m => m && m.fromTavern && m.tavern && m.tavern.chatFile === binding.stChatFile);
    },

    // 一楼酒馆消息的“身份”（认楼层用）
    _markerOf(m, floor) {
        return { sendDate: m.send_date, isUser: !!m.is_user, floor, genStarted: String(m.gen_started || '') };
    },

    // 在一堆酒馆楼层里找“就是这一楼”的那个。getMsg 从每一项里取出酒馆消息。返回 (身份) => 找到的那一项
    _floorLookup(items, getMsg) {
        const map = new Map();
        items.forEach(it => {
            const m = getMsg(it);
            if (!m) return;
            const k = String(m.send_date) + '|' + (m.is_user ? 1 : 0);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(it);
        });
        return (t) => {
            const arr = t && map.get(String(t.sendDate) + '|' + (t.isUser ? 1 : 0));
            return arr ? arr.find(it => this._sameFloor(getMsg(it), t)) : undefined;
        };
    },

    // 反过来：给一堆身份，问某一楼酒馆消息在不在里面。返回 (酒馆消息) => true/false
    _markerLookup(markers) {
        const map = new Map();
        markers.forEach(t => {
            if (!t) return;
            const k = String(t.sendDate) + '|' + (t.isUser ? 1 : 0);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(t);
        });
        return (m) => {
            const arr = map.get(String(m.send_date) + '|' + (m.is_user ? 1 : 0));
            return !!arr && arr.some(t => this._sameFloor(m, t));
        };
    },

    // 按真实时间把酒馆楼层插到小手机聊天记录里的正确位置：
    // 小手机自己的消息顺序完全不动；每楼酒馆剧情放在“第一条比它晚的小手机消息”前面。
    // 读不出时间的酒馆楼层留在原位。返回是否改动了顺序。
    placeTavernFloors(char) {
        const history = char && char.history;
        if (!Array.isArray(history)) return false;
        const hasTime = (m) => m && m.fromTavern && m.tavern && typeof m.tavern.time === 'number';
        const floors = history.filter(hasTime)
            .sort((a, b) => (a.tavern.time - b.tavern.time) || (a.tavern.floor - b.tavern.floor));
        if (!floors.length) return false;
        const others = history.filter(m => !hasTime(m));
        const merged = [];
        let j = 0;
        for (const m of others) {
            const ts = Number(m && m.timestamp);
            if (Number.isFinite(ts)) {
                while (j < floors.length && floors[j].tavern.time <= ts) merged.push(floors[j++]);
            }
            merged.push(m);
        }
        while (j < floors.length) merged.push(floors[j++]);
        floors.forEach(m => { m.timestamp = m.tavern.time; });
        const changed = merged.some((m, i) => m !== history[i]);
        if (changed) history.splice(0, history.length, ...merged);   // 原地替换，保持 yuan 手里的引用有效
        return changed;
    },

    // 读出酒馆这个聊天现在的楼层情况（给“清空并重选范围”弹窗用）
    //   total：酒馆里一共几楼（楼层号 0 ~ total-1，和酒馆界面上的 # 号一致）
    //   usable：其中会被导入的楼层（去掉小手机推送的、番外楼、空楼），每项 { floor, marker }
    async getTavernFloorInfo(binding) {
        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) return { total: 0, usable: [] };
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = raw.slice(offset);
        const usable = [];
        list.forEach((m, floor) => {
            if (!m || typeof m.mes !== 'string' || !m.mes.trim()) return;
            if (m.extra && (m.extra.uwu_created || m.extra.bbs_omit)) return;
            usable.push({ floor, marker: { sendDate: m.send_date, isUser: !!m.is_user, floor, genStarted: String(m.gen_started || '') } });
        });
        return { total: list.length, usable };
    },

    // 清空这个角色在小手机里的全部酒馆楼层，并重新设置以后同步的范围（yuan 版新增）。
    //   range = { start, end }（酒馆楼层号）→ 下次同步导入这一段，外加以后的新楼层
    //   range = null → 旧楼层一楼都不要，只同步以后的新楼层
    // 已经写进 yuan 日记 / 记忆表格 / 向量记忆的内容不受影响（那些是另外存的）。
    async resetImportRange(binding, range) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const info = await this.getTavernFloorInfo(binding);
        const last = info.usable[info.usable.length - 1];
        let importStart = { none: true }, importEnd = null;
        if (range) {
            const inside = info.usable.filter(u => u.floor >= range.start && u.floor <= range.end);
            if (!inside.length) throw new Error(`第 ${range.start} ~ ${range.end} 楼里没有可以导入的楼层`);
            importStart = inside[0].marker;
            importEnd = inside[inside.length - 1].marker;
        }
        // 只清这个酒馆聊天导入的卡片；以前绑定的别的聊天留下的，用 removeOtherChatFloors 单独删
        const mine = new Set(this._floorsOfChat(char, binding));
        const removed = mine.size;
        char.history = (char.history || []).filter(m => !mine.has(m));
        char.tavernMemory = Object.assign({}, char.tavernMemory, {
            stCharAvatar: binding.stCharAvatar,
            stChatFile: binding.stChatFile,
            importStart,
            importEnd,
            // 酒馆里一楼能导入的都没有时，记成“第 -1 楼之后”，以后的新楼层照样进来
            resumeAfter: last ? last.marker : { floor: -1 },
        });
        await saveData();
        this._rerender(char);
        return { removed };
    },

    // 以前绑定的别的酒馆聊天留下的卡片（换了聊天之后，它们留在小手机里当回忆）
    otherChatFloors(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) return [];
        this._tagChatFiles(char, binding.stChatFile);
        return (char.history || []).filter(m => m && m.fromTavern && m.tavern && m.tavern.chatFile !== binding.stChatFile);
    },

    async removeOtherChatFloors(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const others = new Set(this.otherChatFloors(binding));
        if (!others.size) return { removed: 0 };
        char.history = char.history.filter(m => !others.has(m));
        await saveData();
        this._rerender(char);
        return { removed: others.size };
    },

    // ===== 酒馆里开了新聊天：自动发现，提示换过去 =====
    // 同步完顺便看一眼这个酒馆角色的聊天列表：最近一次发消息的那个聊天不是现在绑定的，就在绑定卡片上问要不要换过去。
    // 为了不拖慢同步，每个绑定最多 10 分钟看一次。点过「不换」的那个聊天不再问（酒馆里再开别的新聊天还会问）。
    _chatCheckTimes: new Map(),
    newerChatFor(binding) {
        const n = binding && binding.newerChat;
        if (!n || !n.file || n.file === binding.stChatFile || n.file === binding.dismissedChat) return null;
        return n;
    },
    async _checkNewerChat(binding, force = false) {
        const key = binding.uwuCharId + '|' + binding.stCharAvatar;
        const last = this._chatCheckTimes.get(key) || 0;
        if (!force && Date.now() - last < 10 * 60 * 1000) return;
        this._chatCheckTimes.set(key, Date.now());
        // simple:false 才会带上每个聊天最后一条消息的时间（last_mes）；老版本酒馆可能返回对象而不是数组
        const res = await this.apiCall('/api/characters/chats', { avatar_url: binding.stCharAvatar, simple: false });
        const arr = Array.isArray(res) ? res : (res && typeof res === 'object' ? Object.values(res) : []);
        const items = arr.filter(c => c && c.file_name)
            .map(c => ({ file: String(c.file_name).replace(/\.jsonl$/, ''), t: parseTimeValue(c.last_mes) }));
        if (!items.length) return;
        const cur = items.find(x => x.file === binding.stChatFile);
        const newest = items.filter(x => x.t != null).sort((a, b) => b.t - a.t)[0];
        // 现在绑定的聊天在酒馆里被删了，或者别的聊天最后一条消息更晚 → 算“最近在玩另一个聊天”。
        // 现在这个聊天的时间读不懂时没法比，不提示
        const isNewer = newest && newest.file !== binding.stChatFile && (!cur || (cur.t != null && newest.t > cur.t));
        const had = binding.newerChat && binding.newerChat.file;
        if (isNewer) {
            if (had === newest.file) return;
            binding.newerChat = { file: newest.file, time: newest.t };
            await this.saveConfig(this.getConfig());
            if (newest.file !== binding.dismissedChat && typeof showToast === 'function') {
                const ch = db.characters.find(c => c.id === binding.uwuCharId);
                showToast(`酒馆里「${ch ? (ch.remarkName || ch.name) : '这个角色'}」最近在玩另一个聊天，可以在「酒馆互联」的绑定卡片上换过去`);
            }
            this._notifyData();
        } else if (had) {
            delete binding.newerChat;
            await this.saveConfig(this.getConfig());
            this._notifyData();
        }
    },

    // 换绑到这个角色的另一个酒馆聊天（绑定卡片上的「更换」）。
    // 推送记录是跟着旧聊天的，一起清掉：新聊天里还一条小手机消息都没有，按“第一次自动推送最近 N 条”重新开始。
    // 同步不用特别处理：卡片记着来源聊天，下次同步会按“第一次同步最近 N 楼”从新聊天重新开始。
    async changeChatFile(binding, newFile) {
        if (!newFile || newFile === binding.stChatFile) return false;
        binding.stChatFile = newFile;
        delete binding.lastPushedMsgId;
        delete binding.hasPushed;
        delete binding.keptIds;
        delete binding.recentPushes;
        delete binding.pushedIds;
        delete binding.newerChat;
        await this.saveConfig(this.getConfig());
        return true;
    },

    // ========== 原文精简（yuan 版新增）==========
    // “精简”＝ 旧楼层只留柏宝书摘要、把原文丢掉，省下小手机里的空间。
    // 酒馆里的原文一直都在（酒馆的“隐藏”只是标记，楼层还在聊天文件里），所以随时能取回来。
    // 铁律：没有摘要的楼层永远不精简；user 楼没有柏宝书摘要，所以不会被精简。

    // 认楼层：发送时间 + 是不是用户；AI 楼再加上“开始生成时间”（send_date 只精确到分钟，分不开同一分钟的两楼）
    _sameFloor(m, t) {
        return m.send_date === t.sendDate && !!m.is_user === !!t.isUser
            && (t.genStarted === undefined || String(m.gen_started || '') === t.genStarted);
    },

    // 正在看这个角色的聊天就重画一遍；角色列表也刷一下（免得列表上还留着已经删掉的内容）
    _rerender(char) {
        if (typeof currentChatId !== 'undefined' && char && currentChatId === char.id && typeof renderMessages === 'function') {
            try { renderMessages(false, true); } catch (e) { /* 画不出来不影响数据 */ }
        }
        if (typeof renderChatList === 'function') {
            try { renderChatList(); } catch (e) { /* 画不出来不影响数据 */ }
        }
    },

    // 挑出要处理的楼层。opts：
    //   { ids: [消息id] }   指定的几条
    //   { keepLast: N }     最近 N 楼以外的全部
    //   { start, end }      酒馆楼层号范围（含两端）
    //   {}                  全部
    // 除了指定 ids，其余几种只挑当前绑定的酒馆聊天的卡片（别的聊天的楼层号会和它重号）
    _pickFloors(char, opts = {}, binding = null) {
        const all = (char.history || []).filter(m => m && m.fromTavern && m.tavern);
        if (Array.isArray(opts.ids)) { const set = new Set(opts.ids); return all.filter(m => set.has(m.id)); }
        const floors = binding ? this._floorsOfChat(char, binding) : all;
        if (Number.isInteger(opts.keepLast) && opts.keepLast > 0) return floors.slice(0, Math.max(0, floors.length - opts.keepLast));
        if (opts.start != null || opts.end != null) {
            const s = opts.start != null ? opts.start : -Infinity;
            const e = opts.end != null ? opts.end : Infinity;
            return floors.filter(m => m.tavern.floor >= s && m.tavern.floor <= e);
        }
        return floors;
    },

    // 这一楼能不能精简：还没精简过，而且有柏宝书摘要
    canTrim(m) {
        return !!(m && m.fromTavern && m.tavern && !m.tavern.trimmed
            && m.tavern.summary && typeof m.tavern.summary.text === 'string' && m.tavern.summary.text.trim());
    },

    // 保留原文的楼数：至少要不少于“最近几楼发原文”，不然刚导入的楼层马上被精简，那个设置就白填了
    keepRawFloorCount(binding) {
        const cfg = this.getConfig();
        const n = parseInt(binding && binding.keepRawFloors, 10);
        return Math.max(cfg.rawFloorCount || 0, (Number.isInteger(n) && n >= 0) ? n : 30);
    },

    // 精简：把原文换成摘要。返回 { trimmed 精简了几楼, skipped 因为没摘要跳过几楼, saved 省下多少字 }
    // trimFloors 会排进写入队列（见文件末尾）；已经在队列里的同步要调 _trimFloors，否则会自己等自己
    async trimFloors(binding, opts = {}) {
        return this._trimFloors(binding, opts);
    },
    async _trimFloors(binding, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        let trimmed = 0, skipped = 0, saved = 0, removedUsers = 0;
        const skippedFloors = [];
        const picked = this._pickFloors(char, opts, binding);
        for (const m of picked) {
            if (m.tavern.trimmed) continue;
            if (!this.canTrim(m)) {
                // 你自己在酒馆里发的楼层本来就没有摘要，不算进“还没有摘要”的名单
                if (!m.tavern.isUser) { skipped++; skippedFloors.push(m.tavern.floor); }
                continue;
            }
            const before = (m.content || '').length;
            m.content = m.tavern.summary.text;
            m.parts = [];
            m.tavern.trimmed = true;
            saved += Math.max(0, before - m.content.length);
            trimmed++;
        }
        // 这一回合的 AI 楼精简之后，同一回合里 user 楼的原文也没用了（摘要已经把这一回合写进去了），
        // 一起从小手机里删掉；身份记在 AI 卡片的 roundUsers 里，这样同步不会把它们又拉回来，
        // 点「取回原文」时也能连它们一起从酒馆取回来。
        // 已经精简过的楼层也顺带清一遍（比如上次精简时还没算出回合归属）。
        // 先按“属于哪一回合”把 user 楼归好类，最后一次性删，楼层多时才不会慢。
        // 按“哪个聊天 + 哪一回合”归类：不同酒馆聊天的楼层号会重号
        const roundKey = (chatFile, floor) => (chatFile || '') + '|' + floor;
        const usersByRound = new Map();
        (char.history || []).forEach(m => {
            if (!m || !m.fromTavern || !m.tavern || !m.tavern.isUser) return;
            const r = m.tavern.roundAi;
            if (typeof r !== 'number') return;
            const k = roundKey(m.tavern.chatFile, r);
            if (!usersByRound.has(k)) usersByRound.set(k, []);
            usersByRound.get(k).push(m);
        });
        const removeIds = new Set();
        for (const m of picked) {
            if (!m.tavern.trimmed || m.tavern.isUser) continue;
            const users = (usersByRound.get(roundKey(m.tavern.chatFile, m.tavern.floor)) || []).filter(u => !removeIds.has(u.id));
            if (!users.length) continue;
            const marks = Array.isArray(m.tavern.roundUsers) ? m.tavern.roundUsers.slice() : [];
            for (const u of users) {
                const mark = { floor: u.tavern.floor, sendDate: u.tavern.sendDate, genStarted: u.tavern.genStarted, isUser: true, name: u.tavern.name };
                if (!marks.some(x => x.sendDate === mark.sendDate && x.genStarted === mark.genStarted)) marks.push(mark);
                saved += (u.content || '').length;
                removeIds.add(u.id);
                removedUsers++;
            }
            m.tavern.roundUsers = marks;
        }
        if (removeIds.size) char.history = char.history.filter(m => !removeIds.has(m.id));
        if (trimmed || removedUsers) { await saveData(); this._rerender(char); }
        return { trimmed, skipped, saved, skippedFloors, removedUsers };
    },

    // 取回原文：从酒馆重新读那一楼的正文。返回 { restored 取回几楼, missing 酒馆里找不到几楼 }
    async restoreRawFloors(binding, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const targets = this._pickFloors(char, opts, binding).filter(m => m.tavern.trimmed);
        if (!targets.length) return { restored: 0, missing: 0 };
        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) throw new Error('读不到酒馆聊天');
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = raw.slice(offset);
        let restored = 0, missing = 0, restoredUsers = 0;
        let now = Date.now();
        const cleanOf = (stMsg) => {
            let text = stMsg.mes;
            if (stMsg.extra && stMsg.extra.from_uwu) text = stripOwnPhoneBlock(text);
            return this.applyCleanRules(text, 'pull');
        };
        for (const m of targets) {
            const found = list.find(x => x && typeof x.mes === 'string' && this._sameFloor(x, m.tavern));
            if (!found) { missing++; continue; }
            const cleaned = cleanOf(found);
            if (!cleaned) { missing++; continue; }
            m.content = cleaned;
            m.parts = [];
            m.tavern.trimmed = false;
            restored++;

            // 精简时一起收走的 user 楼，也从酒馆取回来（找不到的就算了，和 AI 楼一样报“找不到”）
            const marks = m.tavern.roundUsers || [];
            // 时间要夹在“上一楼”和“这一回合的 AI 楼”之间，否则取回来的楼层会排到别处去
            const aiTime = typeof m.tavern.time === 'number' ? m.tavern.time : null;
            let prevTime = null;
            if (aiTime != null) {
                (char.history || []).forEach(x => {
                    if (!x || !x.fromTavern || !x.tavern || typeof x.tavern.time !== 'number') return;
                    if (x.tavern.chatFile !== m.tavern.chatFile) return;
                    if (x.tavern.time < aiTime && (prevTime == null || x.tavern.time > prevTime)) prevTime = x.tavern.time;
                });
            }
            marks.forEach((mark, idx) => {
                const hit = list.find(x => x && typeof x.mes === 'string' && this._sameFloor(x, mark));
                if (!hit) { missing++; return; }
                const text = cleanOf(hit);
                if (!text) { missing++; return; }
                let time = readFloorTime(hit);
                if (aiTime != null && (time == null || time >= aiTime || (prevTime != null && time < prevTime))) {
                    time = aiTime - (marks.length - idx);     // 紧挨着排在这一回合的 AI 楼前面
                }
                char.history.push({
                    id: `tavern_${now}_${Math.random().toString(36).slice(2, 8)}`,
                    role: 'system',
                    content: text,
                    parts: [],
                    timestamp: time != null ? time : now++,
                    fromTavern: true,
                    tavern: {
                        floor: list.indexOf(hit),
                        time,
                        chatFile: m.tavern.chatFile,
                        sendDate: hit.send_date,
                        genStarted: String(hit.gen_started || ''),
                        isUser: true,
                        name: mark.name || char.myName || hit.name || '我',
                        roundAi: m.tavern.floor,
                        summary: null,
                    },
                });
                restoredUsers++;
            });
            m.tavern.roundUsers = [];
        }
        if (restored || restoredUsers) {
            if (restoredUsers) this.placeTavernFloors(char);   // 取回来的 user 楼按时间排回原位
            await saveData();
            this._rerender(char);
        }
        return { restored, missing, restoredUsers };
    },

    // 在小手机里（调试/编辑源码）改了酒馆剧情 → 写回酒馆对应的那一楼。
    // 由 tavern_hooks.js 在保存编辑后调用。oldContent 是改之前小手机里的文字，用来确认两边本来是一致的。
    // 写不了的情况一律不动酒馆，返回原因给用户看。
    async writeBackFloorEdit(binding, message, oldContent) {
        const t = message && message.tavern;
        if (!t) return { ok: false, reason: '这条不是酒馆剧情，没写回酒馆' };
        const newBody = String(message.content == null ? '' : message.content).trim();
        if (!newBody) return { ok: false, reason: '内容是空的，没写回酒馆' };

        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) return { ok: false, reason: '读不到酒馆聊天，改动只留在小手机里' };
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = raw.slice(offset);
        const stMsg = list.find(x => x && typeof x.mes === 'string' && this._sameFloor(x, t));
        if (!stMsg) return { ok: false, reason: '酒馆里找不到这一楼，改动只留在小手机里' };

        // 已精简的楼层，正文就是柏宝书摘要 → 改的是摘要，写回酒馆那一楼的柏宝书摘要（不动原文）
        if (t.trimmed) {
            const leaf = stMsg.extra && stMsg.extra.bbs_leaf;
            if (!leaf || typeof leaf.text !== 'string') {
                return { ok: false, reason: '酒馆里这一楼没有柏宝书摘要，改不了。先点“从酒馆取回原文”再改' };
            }
            const leafSwipe = typeof leaf.swipe === 'number' ? leaf.swipe : 0;
            const msgSwipe = typeof stMsg.swipe_id === 'number' ? stMsg.swipe_id : 0;
            if (leafSwipe !== msgSwipe) {
                return { ok: false, reason: '酒馆里这段摘要对应的是另一个版本的回复，没改' };
            }
            if (String(oldContent == null ? '' : oldContent).trim() !== leaf.text.trim()) {
                return { ok: false, reason: '酒馆里的摘要和小手机里的对不上（柏宝书可能重写过），先点“只补摘要”再改' };
            }
            leaf.text = newBody;
            await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: raw });
            // 小手机这边记着的摘要也一起更新，免得下次同步又被旧摘要覆盖
            t.summary = Object.assign({}, t.summary || {}, { text: newBody });
            await saveData();
            return { ok: true, floor: t.floor, what: 'summary' };
        }

        // 这一楼里夹着的小手机推送内容（最后那段 <phone_chat>）先摘出来，写回时原样放回去。
        // 和导入时一样：只有标着 from_uwu 的楼层才有小手机那段，其余的 <phone_chat> 是酒馆 AI 自己写的正文
        const own = (stMsg.extra && stMsg.extra.from_uwu) ? lastPhoneBlock(stMsg.mes) : null;
        const body = own ? stripOwnPhoneBlock(stMsg.mes) : stMsg.mes.trim();
        if (this.applyCleanRules(body, 'pull') !== body) {
            return { ok: false, reason: '这一楼导入时被清洗规则改过，写回会丢内容，酒馆保持原样' };
        }
        if (String(oldContent == null ? '' : oldContent).trim() !== body) {
            return { ok: false, reason: '酒馆里这一楼和小手机里的对不上（可能酒馆那边也改过），先同步一次再改' };
        }

        const newMes = own ? newBody + '\n' + own.text : newBody;
        stMsg.mes = newMes;
        // 酒馆里存了多个抽卡版本时，光改正文会被版本内容盖回去，当前那个版本也要一起改
        if (Array.isArray(stMsg.swipes) && stMsg.swipes.length) {
            const si = Number.isInteger(stMsg.swipe_id) ? stMsg.swipe_id : 0;
            if (si >= 0 && si < stMsg.swipes.length) stMsg.swipes[si] = newMes;
        }
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: raw });
        return { ok: true, floor: t.floor, what: 'text' };
    },

    // 只补摘要：读一遍酒馆，把已经导入的楼层的柏宝书摘要更新一遍。不导入新楼层、不动位置。
    // 柏宝书常常比回复晚一步才写好摘要，所以单独给一个按钮。
    async refreshSummaries(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) throw new Error('读不到酒馆聊天');
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = raw.slice(offset);
        const imported = this._floorsOfChat(char, binding);
        const findMsg = this._floorLookup(list.filter(x => x && typeof x.mes === 'string'), x => x);
        let filled = 0, stillNone = 0;
        for (const h of imported) {
            const found = findMsg(h.tavern);
            if (!found) continue;
            const summary = readBaibaiSummary(found);
            // 还没有摘要的只算 AI 楼：你自己在酒馆里发的楼层本来就不会有柏宝书摘要
            if (!summary || !summary.text) {
                // 柏宝书把摘要撤掉了（或属于另一个抽卡版本）：小手机里的旧摘要也清掉（已精简的不清，它的正文就是摘要）
                if (h.tavern.summary && h.tavern.summary.text && !h.tavern.trimmed && baibaiSummaryGone(found)) {
                    h.tavern.summary = null;
                    filled++;
                }
                if (!h.tavern.isUser && !(h.tavern.summary && h.tavern.summary.text)) stillNone++;
                continue;
            }
            const oldText = h.tavern.summary && h.tavern.summary.text;
            if (summary.text === oldText) continue;
            h.tavern.summary = summary;
            if (h.tavern.trimmed) h.content = summary.text;   // 已精简的楼层，正文就是摘要，一起更新
            filled++;
        }
        if (filled) { await saveData(); this._rerender(char); }
        return { filled, stillNone, total: imported.length };
    },

    // “单独限制酒馆上文”（每个绑定分别设置，yuan 版新增）：
    // yuan 发消息时取聊天记录最后“可见上文条数”（maxMemory）条。打开这个开关后改成：
    //   最新的 N 楼酒馆剧情 + 最新的（maxMemory - 实际取到的酒馆楼数）条小手机消息，按原来的顺序排好。
    // 例：可见上文 100，最近玩了 200 楼酒馆，之前有 100 条小手机消息，N 填 50 → 最新 50 楼酒馆 + 之前最新 50 条小手机消息。
    // 只处理 yuan 普通发消息时那种“聊天记录最后 maxMemory 条”的截取；其他情况（写日记、剧情节点等）返回 null，照原样。
    limitTavernContext(chat, slice, ignoreContextDisabled) {
        if (ignoreContextDisabled || !chat || !Array.isArray(chat.history) || !Array.isArray(slice) || !slice.length) return null;
        const binding = this.findBindingForChar(chat.id);
        if (!binding || !binding.limitTavernContext) return null;
        const max = parseInt(chat.maxMemory, 10);
        if (!(max > 0)) return null;
        const h = chat.history;
        // 剧情节点进行中：yuan 只看节点里的消息，不插手
        if (chat.activeNodeId && Array.isArray(chat.nodes) && chat.nodes.some(n => n.id === chat.activeNodeId)) return null;
        // 确认传进来的正是“聊天记录最后 maxMemory 条”
        if (slice.length !== Math.min(max, h.length)) return null;
        const tail = h.slice(-slice.length);
        if (!tail.every((m, i) => m === slice[i] || (m && slice[i] && m.id === slice[i].id))) return null;

        // 和 yuan 一样跳过已收纳剧情节点里的消息
        const archived = new Set((chat.nodes || []).filter(n => n.status === 'archived').map(n => n.id));
        const usable = [];
        let inArchived = null;
        h.forEach((m, i) => {
            if (!m) return;
            if (m.isNodeBoundary && m.nodeAction === 'start' && archived.has(m.nodeId)) { inArchived = m.nodeId; return; }
            if (m.isNodeBoundary && m.nodeAction === 'end' && m.nodeId === inArchived) { inArchived = null; return; }
            if (inArchived || (m.nodeId && archived.has(m.nodeId))) return;
            usable.push(i);
        });

        const n = Math.min(Math.max(0, parseInt(binding.tavernContextCount, 10) || 0), max);
        const picked = new Set();
        let tav = 0;
        for (let k = usable.length - 1; k >= 0 && tav < n; k--) { const i = usable[k]; if (h[i].fromTavern) { picked.add(i); tav++; } }
        let others = max - tav;
        for (let k = usable.length - 1; k >= 0 && others > 0; k--) { const i = usable[k]; if (!h[i].fromTavern) { picked.add(i); others--; } }
        return [...picked].sort((a, b) => a - b).map(i => h[i]);
    },

    // 发给 AI 前处理酒馆楼层（由 tavern_hooks.js 在 yuan 的 filterHistoryForAI 之后调用）：
    //   - 最近 rawFloorCount 楼酒馆剧情：原文，套“原文包裹”
    //   - 更早的：有柏宝书摘要的 AI 楼 → 套“摘要包裹”；user 楼没有摘要，一律发原文（发不发只看“包含 user 楼层”开关）
    //   - 更早但还没有摘要的：只能先发原文
    //   - 关闭“包含 user 楼层”时，user 楼一律不发
    // history 是 yuan 已经深拷贝过的副本，可以直接改。每条处理过的消息打上 __tavernView 方便预览统计。
    prepareHistoryForAI(chat, history) {
        if (!Array.isArray(history) || !history.some(m => m && m.fromTavern)) return history;
        const cfg = this.getConfig();
        const tavernIdx = [];
        history.forEach((m, i) => { if (m && m.fromTavern) tavernIdx.push(i); });
        const rawSet = new Set(cfg.rawFloorCount > 0 ? tavernIdx.slice(-cfg.rawFloorCount) : []);
        const fill = (tpl, m, text, time) => tpl
            .replace(/\{\{楼层\}\}/g, m.tavern ? m.tavern.floor : '?')
            .replace(/\{\{发言人\}\}/g, (m.tavern && m.tavern.name) || '')
            .replace(/\{\{时间\}\}/g, time || '时间不详')
            .replace(/\{\{内容\}\}/g, text);

        const out = [];
        history.forEach((m, i) => {
            if (!m || !m.fromTavern) { out.push(m); return; }
            const t = m.tavern || {};
            if (t.isUser && cfg.injectUserFloors === false) return;
            let view, content;
            if (rawSet.has(i) && !t.trimmed) {
                view = 'raw'; content = fill(cfg.wrapRaw, m, m.content, t.summary && t.summary.time);
            } else if (!t.isUser && t.summary && t.summary.text) {
                view = t.trimmed ? 'summary-trimmed' : 'summary';
                content = fill(cfg.wrapSummary, m, t.summary.text, t.summary.time);
            } else if (t.isUser) {
                // 你在酒馆里发的楼层自己没有摘要。柏宝书的一段摘要写的是「一整个回合」——
                // 你发的那楼（可以连着好几楼）+ 紧跟的那一楼 AI 回复，摘要存在 AI 那楼上
                // （见柏宝书 engine.ts 的 floorTargets：从 AI 楼往前收，遇到上一个 AI 楼才停）。
                // 酒馆里它也是把整个回合一起隐藏、只留摘要。所以这里同样：
                //   这一回合的 AI 楼这次确实以摘要形式发出去 → 你发的那楼省掉（内容已经在摘要里，再发就是重复）
                //   其余情况一律发原文：AI 楼这次发的是原文、还没写摘要、被删掉了、或者后面根本还没有 AI 楼
                let coveredBySummary = false;
                for (let k = i + 1; k < history.length; k++) {
                    const nx = history[k];
                    if (!nx || !nx.fromTavern) continue;          // 中间夹着的小手机消息不算数，继续往后找
                    const nt = nx.tavern || {};
                    if (nt.isUser) continue;                      // 连着的几楼 user 都归后面那一楼 AI 的摘要管
                    // 那一楼 AI 这次是发摘要还是发原文：已精简的即使在“最近几楼发原文”里也只有摘要
                    const asSummary = !!(nt.summary && nt.summary.text) && (!rawSet.has(k) || nt.trimmed);
                    // 还要确认这一楼 AI 真的是这一回合的（同步时记的 roundAi）。
                    // 万一中间那楼 AI 卡片被删了，后面那楼的摘要盖不到这一楼，就不能省。
                    // 旧数据没记 roundAi（undefined）时退回“紧跟着的就算”，免得老卡片全变成发原文。
                    // 另一个酒馆聊天的楼层号会重号，所以还要是同一个聊天
                    const sameRound = (t.chatFile === nt.chatFile)
                        && ((t.roundAi === undefined) ? true : (t.roundAi === nt.floor));
                    coveredBySummary = asSummary && sameRound;
                    break;                                        // 只看紧跟的第一楼 AI 剧情
                }
                if (coveredBySummary) return;
                view = 'raw-user'; content = fill(cfg.wrapRaw, m, m.content, '');
            } else {
                view = 'raw-nosummary'; content = fill(cfg.wrapRaw, m, m.content, '');
            }
            out.push(Object.assign({}, m, { role: 'user', content, parts: [{ type: 'text', text: content }], __tavernView: view }));
        });
        return out;
    },

    // 查酒馆里到底装了哪些小手机消息（yuan 版新增）。以酒馆的记录为准，比“上次推送到哪一条”可靠：
    //   - 在酒馆互联页面手动推送过的，也算已推送
    //   - 在酒馆里把那一楼删掉的，会重新算成未推送
    // “未推送”的口径：最后一条已推送的消息之后的所有消息（中间夹着的旧未推送消息不再单独算）
    //   - missing：以前推到过酒馆、小手机里还在、现在酒馆里却找不到的消息（见 binding.pushedIds）
    async getPushState(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const { allUwuMsgs, phoneById } = this._pushHelpers(char, binding);
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const pushed = new Set();
        (Array.isArray(stMsgs) ? stMsgs : []).forEach(m => {
            const ids = m && m.extra && m.extra.uwu_msg_ids;
            if (Array.isArray(ids)) ids.forEach(id => pushed.add(id));
        });
        // “推过的消息名单”：把酒馆里现在有的也补进去（以前推的、别处推的都算），小手机里已经删掉的顺手去掉。
        // 小总结覆盖的不算：那几条在酒馆里是一段总结，不是原文，丢了也不该按原文补推
        const before = JSON.stringify(binding.pushedIds || []);
        const ledger = new Set((Array.isArray(binding.pushedIds) ? binding.pushedIds : []).filter(id => phoneById.has(id)));
        (Array.isArray(stMsgs) ? stMsgs : []).forEach(m => {
            const ex = m && m.extra;
            if (ex && ex.from_uwu && !ex.uwu_summary && Array.isArray(ex.uwu_msg_ids)) ex.uwu_msg_ids.forEach(id => { if (phoneById.has(id)) ledger.add(id); });
        });
        binding.pushedIds = [...ledger];
        if (JSON.stringify(binding.pushedIds) !== before) await this.saveConfig(this.getConfig());
        const missing = allUwuMsgs.filter(m => ledger.has(m.id) && !pushed.has(m.id));
        let lastPushedIdx = -1;
        allUwuMsgs.forEach((m, i) => { if (pushed.has(m.id)) lastPushedIdx = i; });
        return { char, list: allUwuMsgs, pushed, lastPushedIdx, unpushed: allUwuMsgs.slice(lastPushedIdx + 1), missing };
    },

    // 把酒馆里的小手机消息删掉（yuan 版新增）：只删酒馆楼层里 <phone_chat> 的内容，
    // 不动小手机自己的聊天记录，也不动酒馆原有的剧情正文。ids 不给或为空表示删全部。
    // 小总结那一楼是一整段文字，没法只删其中几条：范围里只要包含它覆盖的任何一条，整楼小总结都删掉。
    async removePushedFromTavern(binding, ids) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const removeSet = ids && ids.length ? new Set(ids) : null;
        const { phoneById, toLine } = this._pushHelpers(char, binding);
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];
        let changed = false;
        let removedCount = 0;
        const removedIds = new Set();
        for (let i = 0; i < all.length; i++) {
            const stMsg = all[i];
            const floorIds = stMsg && stMsg.extra && stMsg.extra.from_uwu && Array.isArray(stMsg.extra.uwu_msg_ids) ? stMsg.extra.uwu_msg_ids : null;
            if (!floorIds) continue;
            let surviving = removeSet ? floorIds.filter(id => !removeSet.has(id)) : [];
            if (surviving.length === floorIds.length) continue;
            if (stMsg.extra.uwu_summary) surviving = [];          // 小总结：整楼一起删
            removedCount += floorIds.length - surviving.length;
            floorIds.forEach(id => { if (!surviving.includes(id)) removedIds.add(id); });
            changed = true;
            if (!surviving.length) {
                if (stMsg.extra.uwu_created) {
                    // 整楼都是小手机内容 → 整楼删掉
                    all.splice(i, 1); i--; continue;
                }
                // 合并在酒馆原有楼层里的 → 只去掉小手机那一段
                stMsg.mes = stripOwnPhoneBlock(stMsg.mes);
                delete stMsg.extra.from_uwu; delete stMsg.extra.uwu_msg_ids; delete stMsg.extra.uwu_push_time;
                continue;
            }
            const lines = surviving.map(id => phoneById.get(id)).filter(Boolean).map(toLine).filter(l => l && l.trim());
            const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            if (stMsg.extra.uwu_created) stMsg.mes = phoneChat;
            else stMsg.mes = replaceOwnPhoneBlock(stMsg.mes || '', phoneChat);
            stMsg.extra.uwu_msg_ids = surviving;
        }
        if (!changed) return { removed: 0 };
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        // “上次推送到哪一条”至少挪到清理掉的最后一条：自动推送从它后面接着推，刚清理掉的这些不会又被自动推回去
        //（以前这里会清掉追踪点，导致清理完马上又被推回酒馆）。想重新推，在推送窗口里自己选范围
        this._forgetPushes(binding, removedIds);
        let lastRemoved = null;
        char.history.forEach(m => { if (m && removedIds.has(m.id)) lastRemoved = m.id; });
        this._advancePushMark(binding, char, lastRemoved);
        await this.saveConfig(this.getConfig());
        return { removed: removedCount };
    },

    // 推送到酒馆（增量推送 + 删除同步）
    // trackProgress: 是否更新 lastPushedMsgId。手动推送传 false，让自动/聊天页推送不受影响，方便反悔
    // 推送用的公共部分（yuan 版把它从 pushToTavern 里抽出来，替换重新生成的回复时也要用）：
    //   allUwuMsgs：小手机里能推送到酒馆的消息
    //   toLine(消息)：把一条消息变成写进 <phone_chat> 的一行文字
    // 这个角色第一次同步时导入最近多少楼。每个绑定可以不一样；没设置过就用旧的全局值，再没有就 20。
    // 只在“从没同步过”（或清空过、换了酒馆聊天）时起作用，之后每次同步都会导入全部新楼层。
    initialImportFor(binding) {
        const n = parseInt(binding && binding.initialImportCount, 10);
        if (Number.isInteger(n) && n >= 0) return n;
        const g = this.getConfig().initialImportCount;
        return (Number.isInteger(g) && g >= 0) ? g : 20;
    },

    // 这个角色和现在绑定的这个酒馆聊天同步过没有（用来决定界面显示“开始同步”还是“清空并重选范围”，
    // 以及要不要显示“第一次同步最近 N 楼”）。换了酒馆聊天就算没同步过
    hasSynced(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        const mem = char && char.tavernMemory;
        return !!(mem && mem.lastSync && mem.stChatFile === binding.stChatFile);
    },

    // 这个角色第一次自动推送时，最多补推最近多少条。每个绑定可以不一样。
    // 只在“酒馆里一条都没有”时用得上；手动推送在推送窗口里自己选范围，不看这个数字。
    firstPushCountFor(binding) {
        const n = parseInt(binding && binding.firstPushCount, 10);
        if (Number.isInteger(n) && n >= 0) return n;
        const g = this.getConfig().maxInjectMessages;
        return (Number.isInteger(g) && g >= 0) ? g : 50;
    },

    // 推送状态栏 / 推送在线状态：每个角色分开设，没设过就用旧的全局设置（老数据照旧）
    pushIncludeStatusBarFor(binding) {
        if (binding && typeof binding.pushIncludeStatusBar === 'boolean') return binding.pushIncludeStatusBar;
        return this.getConfig().pushIncludeStatusBar !== false;
    },
    pushIncludeOnlineStatusFor(binding) {
        if (binding && typeof binding.pushIncludeOnlineStatus === 'boolean') return binding.pushIncludeOnlineStatus;
        return this.getConfig().pushIncludeOnlineStatus === true;
    },

    // 通话推送方式：'summary' 只推总结（默认）/ 'context' 只推记录 / 'both' 都推 / 'none' 不推送。
    // 兼容以前那个「通话连完整对话一起推」的开关（打开过的算“都推”）。
    callPushMode(binding) {
        const m = binding && binding.callPushMode;
        if (m === 'summary' || m === 'context' || m === 'both' || m === 'none') return m;
        return (binding && binding.pushCallContext) ? 'both' : 'summary';
    },

    _pushHelpers(char, binding) {
        // 状态栏剥离：当用户关闭"推送状态栏到酒馆"时，按角色状态栏正则把内联状态栏抹掉，
        // 并过滤掉专门的状态更新楼层（isStatusUpdate）
        const includeStatusBar = this.pushIncludeStatusBarFor(binding);
        let statusBarRegex = null;
        if (!includeStatusBar && char.statusPanel && char.statusPanel.enabled && char.statusPanel.regexPattern) {
            let pattern = char.statusPanel.regexPattern;
            let flags = 'gs';
            const m = pattern.match(/^\/(.*?)\/([a-z]*)$/);
            if (m) { pattern = m[1]; flags = m[2] || 'gs'; if (!flags.includes('g')) flags += 'g'; if (!flags.includes('s')) flags += 's'; }
            try { statusBarRegex = new RegExp(pattern, flags); } catch (e) { console.warn('[TavernSync] 状态栏正则无效:', e.message); }
        }
        const stripStatusBar = (text) => {
            if (!statusBarRegex || !text) return text;
            return text.replace(statusBarRegex, '').trim();
        };

        // 在线状态：AI 写的「[角色更新状态为：…]」，只用来改小手机界面上那行状态文字，聊天里本来就不显示。
        // 默认不推到酒馆（设置里的「推送在线状态到酒馆」）：整条只有这句的不推，夹在正文里的这段抹掉。
        const includeOnlineStatus = this.pushIncludeOnlineStatusFor(binding);
        const onlineStatusRe = /\[[^\[\]]*?更新状态为[：:][^\[\]]*\]/g;
        const stripOnlineStatus = (text) => {
            if (includeOnlineStatus || !text) return text;
            return text.replace(onlineStatusRe, '').trim();
        };
        const isOnlyOnlineStatus = (text) => {
            const t = (text || '').trim();
            return !!t && t.replace(onlineStatusRe, '').trim() === '';
        };

        // 推送前把 AI 输出里可能漏出来的 <thinking>...</thinking> 块整段抹掉
        // （isThinking=true 的独立消息已被下面 filter 排除；这里防的是和正文写在一条消息里的情况）
        const stripThinking = (text) => {
            if (!text) return text;
            return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
        };

        // 通话：yuan 把“打了多久 + 总结”存成一条普通消息（带 callRecordId），通话过程中的对话另存在 char.callHistory 里。
        // 绑定上的「通话推送」四选一（见 TavernSync.callPushMode）：
        //   summary 只推总结（默认）／ context 只推记录（通话里的每句对话，不带总结）／ both 都推 ／ none 不推送
        // 除了“不推送”，都会带上“打了多久”那一行。
        const callMode = this.callPushMode(binding);

        // 当前 UwU 中所有非酒馆来源且有内容的消息
        // 排除：thinking 独立消息、上下文禁用、role=system（time perception / 时间跳跃这类只用来 UI 展示的"[system-display:...]"）
        // 关闭状态栏推送时也剔除 isStatusUpdate
        const allUwuMsgs = char.history.filter(m =>
            !m.fromTavern
            && m.content?.trim()
            && !m.isThinking
            && !m.isContextDisabled
            && m.role !== 'system'
            && (includeStatusBar || !m.isStatusUpdate)
            && (includeOnlineStatus || !isOnlyOnlineStatus(m.content))
            && !(callMode === 'none' && m.callRecordId)      // 通话推送选了“不推送”
        );
        const callRecordOf = (m) => (m && m.callRecordId)
            ? (char.callHistory || []).find(r => r && r.id === m.callRecordId) : null;
        const dropSummary = (text, rec) => {
            const sum = rec && rec.summary ? String(rec.summary).trim() : '';
            if (!sum || !text.includes(sum)) return text;
            return text.split(sum).join('').replace(/；\s*；/g, '；').trim();
        };
        const callLines = (rec) => {
            if (!rec || !Array.isArray(rec.context)) return '';
            const charName = char.realName || char.name || '对方';
            const myName = char.myName || '我';
            const lines = [];
            rec.context.forEach(c => {
                const raw = (c && c.content ? String(c.content) : '').trim();
                if (!raw) return;
                lines.push(`[${c.role === 'user' ? myName : charName}${c.type === 'visual' ? '的画面' : '的声音'}：${raw}]`);
            });
            return lines.length ? '\n' + lines.join('\n') : '';
        };
        const toLine = (m) => {
            let base = this.applyCleanRules(stripOnlineStatus(stripThinking(stripStatusBar(m.content))), 'push');
            if (!base) return base;
            const rec = callRecordOf(m);
            if (!rec) return base;
            if (callMode === 'context') base = dropSummary(base, rec);
            if (callMode === 'context' || callMode === 'both') base += callLines(rec);
            return base;
        };
        // 小手机里现在还在的全部消息（不管设置让不让推送）。
        // 判断“酒馆里某条小手机消息是不是被删了”只看它在不在小手机里：
        // 改了推送设置（比如关掉状态栏、通话改成不推送）只影响以后推送，不会把酒馆里以前推过的删掉。
        const phoneById = new Map();
        char.history.forEach(m => { if (m && !m.fromTavern && m.id != null) phoneById.set(m.id, m); });
        const toLineSafe = (m) => { const l = toLine(m); return typeof l === 'string' ? l : ''; };
        return { allUwuMsgs, toLine: toLineSafe, phoneById };
    },

    // 把“上次推送到哪一条”往后挪到 id 那条；已经在更后面就不动（手动推一段较早的消息时不能往回退，
    // 否则下次自动推送会把中间已经推过的再推一遍）
    _advancePushMark(binding, char, id) {
        if (!id) return false;
        const order = new Map();
        char.history.forEach((m, i) => { if (m && m.id != null) order.set(m.id, i); });
        if (!order.has(id)) return false;
        const cur = binding.lastPushedMsgId && order.has(binding.lastPushedMsgId) ? order.get(binding.lastPushedMsgId) : -1;
        if (cur > order.get(id)) return false;
        binding.lastPushedMsgId = id;
        return true;
    },

    // opts.messages：明确指定要推送哪些消息（聊天页的推送窗口让用户自己填范围时用），优先于 pushCount
    // pushToTavern 会排进写入队列（见文件末尾）；已经在队列里的函数（比如补推）要调 _pushToTavern
    // opts.messages：只推这些（推送窗口里选的范围、补推被盖掉的）
    // opts.recovering：这是在补推被酒馆盖掉的内容，不要再先做兜底核对
    // opts.noLog：这次推送不记进 recentPushes（兜底补推时用，免得你在酒馆里故意删的被一遍遍推回来）
    async pushToTavern(binding, pushCount, trackProgress = true, opts = {}) {
        return this._pushToTavern(binding, pushCount, trackProgress, opts);
    },
    async _pushToTavern(binding, pushCount, trackProgress = true, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        // 兜底：先核对最近 5 分钟推过的还在不在（被酒馆盖掉的就补推）
        if (!opts.messages && !opts.recovering) {
            try { await this._recoverLostPushes(binding, {}); }
            catch (e) { this.reportIssue('核对被酒馆盖掉的推送时出错：' + e.message, 'push'); }
        }
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const { allUwuMsgs, toLine, phoneById } = this._pushHelpers(char, binding);
        // 小手机里还在的消息。只有从小手机里真的删掉了，才去酒馆里删（改推送设置不算删）。
        // binding.keptIds：被“重新生成”换掉的旧回复。它们在小手机里没了，但酒馆里的旧版本要保留，所以当作还在（yuan 版新增）
        const stillHere = new Set([...phoneById.keys(), ...(Array.isArray(binding.keptIds) ? binding.keptIds : [])]);

        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        // === 把删除推送到酒馆：小手机里删掉的消息，从酒馆楼层里去掉 ===
        let hadDeletions = false;
        for (let i = 0; i < all.length; i++) {
            const stMsg = all[i];
            if (!stMsg?.extra?.from_uwu || !Array.isArray(stMsg.extra.uwu_msg_ids)) continue;
            const survivingIds = stMsg.extra.uwu_msg_ids.filter(id => stillHere.has(id));
            if (survivingIds.length === stMsg.extra.uwu_msg_ids.length) continue; // 无变化
            hadDeletions = true;
            if (survivingIds.length === 0) {
                if (stMsg.extra.uwu_created) {
                    // 整楼都是小手机新开的，可以整楼删掉
                    all.splice(i, 1); i--; continue;
                }
                // 合并到剧情楼里的：只去掉小手机那一段，保留原来的剧情
                stMsg.mes = stripOwnPhoneBlock(stMsg.mes);
                delete stMsg.extra.from_uwu;
                delete stMsg.extra.uwu_msg_ids;
                delete stMsg.extra.uwu_push_time;
                continue;
            }
            if (stMsg.extra.uwu_summary) {
                // 小总结那一楼是一整段总结文字，不能换成剩下几条的原文：文字不动，只更新它覆盖了哪几条
                stMsg.extra.uwu_msg_ids = survivingIds;
                continue;
            }
            // 用还在的消息重建小手机那一段
            const lines = survivingIds.map(id => phoneById.get(id)).filter(Boolean).map(toLine).filter(l => l && l.trim());
            const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            if (stMsg.extra.uwu_created) stMsg.mes = phoneChat;
            else stMsg.mes = replaceOwnPhoneBlock(stMsg.mes || '', phoneChat);
            stMsg.extra.uwu_msg_ids = survivingIds;
        }

        // 酒馆里现在已经有的小手机消息（删除处理之后）
        const pushedIds = new Set();
        all.forEach(m => {
            const ids = m && m.extra && m.extra.uwu_msg_ids;
            if (Array.isArray(ids)) ids.forEach(id => pushedIds.add(id));
        });

        // === 找出要推送的新消息 ===
        // opts.messages：推送窗口里用户自己选的范围（用户明确要推，照推）
        // pushCount === 0：只把删除推送过去，不推新消息
        let newMsgs;
        if (Array.isArray(opts.messages)) {
            const wanted = new Set(opts.messages.map(m => m.id));
            newMsgs = allUwuMsgs.filter(m => wanted.has(m.id));
        } else if (pushCount === 0) {
            newMsgs = [];
        } else {
            // 正常情况：从“上次推到哪一条”之后接着推。
            // 按它在整个聊天记录里的位置找，不按“能推送的消息”找：那条消息可能因为改了设置（比如通话改成不推送）
            // 不在能推送的名单里了，按名单找会找不到，退回去把已经清理掉的消息又推一遍
            const order = new Map();
            char.history.forEach((m, i) => { if (m && m.id != null) order.set(m.id, i); });
            const lastPos = binding.lastPushedMsgId && order.has(binding.lastPushedMsgId) ? order.get(binding.lastPushedMsgId) : -1;
            if (lastPos >= 0) {
                newMsgs = allUwuMsgs.filter(m => order.get(m.id) > lastPos);
            } else {
                // 不知道上次推到哪（第一次推、或者那条消息被删了）→ 以酒馆里的记录为准，
                // 和推送窗口同一套口径：最后一条已经在酒馆里的消息之后的全推。
                let lastPushed = -1;
                allUwuMsgs.forEach((m, i) => { if (pushedIds.has(m.id)) lastPushed = i; });
                if (lastPushed >= 0) {
                    newMsgs = allUwuMsgs.slice(lastPushed + 1);
                } else {
                    // 酒馆里一条都没有（这个角色从没推过）→ 只补最近这些，免得把几千条老消息一次全推过去
                    const count = this.firstPushCountFor(binding);
                    newMsgs = count > 0 ? allUwuMsgs.slice(-count) : [];
                }
            }
            // 自动推送不重复推：酒馆里已经有的跳过（比如在推送窗口里手动推过这几条）
            newMsgs = newMsgs.filter(m => !pushedIds.has(m.id));
            // “重新生成”出来的回复（skipTavernPush）已经替换进酒馆了，不再推
            newMsgs = newMsgs.filter(m => !m.skipTavernPush);
        }

        let pushLines = [];
        if (newMsgs.length > 0) {
            pushLines = newMsgs.map(toLine).filter(l => l && l.trim());
            // 新消息剥掉状态栏等之后全部为空，就当没有新消息（删除照样处理）
            if (pushLines.length === 0) { newMsgs = []; }
        }
        if (newMsgs.length > 0) {
            const lines = pushLines;
            const mergedContent = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            const pushMode = this.getConfig().pushMode || 'new';
            // 最后一楼（聊天只有开头那行设置、一楼都没有时不算）
            const tail = all.length > 0 ? all[all.length - 1] : null;
            const lastMsg = (tail && typeof tail.mes === 'string') ? tail : null;
            // 决定是否合并到已有楼层：
            // 1. 新开楼层模式：只有最后一楼就是小手机上次自己新开的那层楼（uwu_created）才接着写进去。
            //    剧情楼（你写的、AI 写的）哪怕里面夹着小手机内容，也一律新开一楼；小总结那一楼也不往里写。
            // 2. 合并到最后一楼模式：不管最后一楼是什么，都接在它末尾
            const lastIsOwnFloor = !!(lastMsg && lastMsg.extra && lastMsg.extra.uwu_created
                && !lastMsg.extra.uwu_summary && Array.isArray(lastMsg.extra.uwu_msg_ids));
            if (lastIsOwnFloor || (pushMode === 'append' && lastMsg)) {
                const target = lastMsg;
                const existingContent = target.mes || '';
                // 这一楼里已经有小手机那一段（楼层末尾那段）→ 接着写进那一段；
                // 没有 → 在楼层末尾另起一段。不能往楼里第一段 <phone_chat> 里塞：那可能是酒馆 AI 自己写的
                const own = (target.extra && target.extra.from_uwu) ? lastPhoneBlock(existingContent) : null;
                if (own) {
                    const inner = own.text.slice(0, own.text.length - '</phone_chat>'.length);
                    target.mes = existingContent.slice(0, own.start) + inner + lines.join('\n') + '\n</phone_chat>' + existingContent.slice(own.end);
                } else {
                    target.mes = existingContent + '\n' + mergedContent;
                }
                if (!target.extra) target.extra = {};
                target.extra.from_uwu = true;
                target.extra.uwu_msg_ids = [...(target.extra.uwu_msg_ids || []), ...newMsgs.map(m => m.id)];
                target.extra.uwu_push_time = Date.now();
            } else {
                // 新楼层模式（默认）：推送为 user 侧消息，方便用正则只剥离 AI 输出的 phone_chat
                const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
                all.push({
                    name: char.myName || 'User',
                    is_user: true, is_system: false,
                    send_date: new Date().toISOString(),
                    mes: mergedContent,
                    extra: { from_uwu: true, uwu_created: true, uwu_push_time: Date.now(), uwu_msg_ids: newMsgs.map(m => m.id), st_char_name: stCharName },
                });
            }
        }

        // 有新消息或有删除才保存
        if (newMsgs.length > 0 || hadDeletions) {
            await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        }
        // 记一笔：万一酒馆正在生成回复、忙完把这次推的盖掉了，能发现并补推
        if (newMsgs.length > 0 && !opts.noLog) this._logPush(binding, { kind: 'raw', ids: newMsgs.map(m => m.id) });
        if (newMsgs.length > 0) this._rememberPushed(binding, newMsgs.map(m => m.id));

        // 更新“上次推送到哪一条”（只有真正推送了新消息才动，而且只往后挪不往回退）。
        // 只推删除时不能改它，否则下次推送会跳过中间的消息
        // 推送过就记一笔（手动、自动都算），卡片上“第一次自动推送最近 N 条”那一行就不再显示
        if (newMsgs.length > 0 && !binding.hasPushed) binding.hasPushed = true;
        if (newMsgs.length > 0 && !trackProgress) await this.saveConfig(this.getConfig());
        if (trackProgress && newMsgs.length > 0) {
            const markTo = opts.messages ? newMsgs[newMsgs.length - 1].id : allUwuMsgs[allUwuMsgs.length - 1].id;
            this._advancePushMark(binding, char, markTo);
            await this.saveConfig(this.getConfig());
        }

        this.resolveIssues('push');   // 这次推送成功了，之前“推送失败”的记录就不用留着了
        this._notifyData();
        return { pushed: newMsgs.length, deleted: hadDeletions };
    },

    // 已经推送过的某条小手机消息内容变了 → 把酒馆里那一行原地换成新的（yuan 版新增）。
    // 现在用在通话上：yuan 先把「打了多久」写进聊天记录，总结是过几秒才生成、回填进同一条消息的；
    // 推送是“推过就不再推”，所以要在这里把酒馆里那行补上总结。找不到就什么都不做（等下次正常推送即可）。
    async updatePushedMessage(binding, msg, oldContent) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char || !msg) return { updated: false };
        const { toLine } = this._pushHelpers(char, binding);
        const oldLine = toLine(Object.assign({}, msg, { content: oldContent }));
        const newLine = toLine(msg);
        if (!oldLine || !newLine || oldLine === newLine) return { updated: false };

        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];
        let updated = false;
        for (const stMsg of all) {
            const ids = stMsg && stMsg.extra && stMsg.extra.uwu_msg_ids;
            if (!Array.isArray(ids) || !ids.includes(msg.id)) continue;
            if (stMsg.extra.uwu_summary) continue;   // 小总结那一楼是总结文字，没有原来那一行
            if (typeof stMsg.mes !== 'string' || !stMsg.mes.includes(oldLine)) continue;
            stMsg.mes = stMsg.mes.replace(oldLine, newLine);
            updated = true;
            break;
        }
        if (updated) {
            await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        }
        return { updated };
    },

    // 重新生成后，把酒馆里对应楼层中的旧回复原地换成新回复（yuan 版新增，由 tavern_hooks.js 调用）：
    // 找到记着这些旧回复（uwu_msg_ids）的小手机楼层，在旧回复所在的位置换成新回复，楼层位置不动、不新增楼层。
    // 返回 { replaced: 是否在酒馆里找到并替换了 }。旧回复还没推送过（酒馆里没有）时返回 replaced:false，新回复按平常推送。
    async replaceRegeneratedInTavern(binding, oldIds, newReplies) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const oldSet = new Set(oldIds);
        const newIds = newReplies.map(m => m.id);
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];
        const { allUwuMsgs, toLine, phoneById } = this._pushHelpers(char, binding);
        const rebuild = (stMsg, nextIds) => {
            // 用新的编号列表重建这一楼小手机那一段；已经不在小手机里的消息（比如之前删掉的）照旧去掉
            const lines = nextIds.map(id => phoneById.get(id)).filter(Boolean).map(toLine).filter(l => l && l.trim());
            const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            if (stMsg.extra.uwu_created) stMsg.mes = phoneChat;
            else stMsg.mes = replaceOwnPhoneBlock(stMsg.mes || '', phoneChat);
            stMsg.extra.uwu_msg_ids = nextIds;
        };

        let changed = false;
        let inserted = false;   // 新回复只放进第一处出现旧回复的地方
        for (const stMsg of all) {
            const ids = stMsg && stMsg.extra && stMsg.extra.from_uwu && Array.isArray(stMsg.extra.uwu_msg_ids) ? stMsg.extra.uwu_msg_ids : null;
            if (!ids || !ids.some(id => oldSet.has(id))) continue;
            const nextIds = [];
            for (const id of ids) {
                if (!oldSet.has(id)) { nextIds.push(id); continue; }
                if (!inserted) { nextIds.push(...newIds); inserted = true; }
            }
            if (stMsg.extra.uwu_summary) {
                // 旧回复已经被浓缩进一段小总结：总结文字不动，只把“覆盖了哪几条”换成新回复
                stMsg.extra.uwu_msg_ids = nextIds;
            } else {
                rebuild(stMsg, nextIds);
            }
            changed = true;
        }
        // 酒馆里没有旧回复（从没推送过）：找到酒馆里记着“这轮之前最后一条小手机消息”的那一楼，把新回复接在它后面。
        // 不能按平常推送——那样会作为新楼层排在酒馆最后面，跑到之后的酒馆剧情后面去
        if (!changed) {
            const firstNewIdx = allUwuMsgs.findIndex(m => m.id === newIds[0]);
            const earlier = (firstNewIdx >= 0 ? allUwuMsgs.slice(0, firstNewIdx) : []).reverse();
            for (const prev of earlier) {
                const stMsg = all.find(x => x && x.extra && x.extra.from_uwu && Array.isArray(x.extra.uwu_msg_ids) && x.extra.uwu_msg_ids.includes(prev.id));
                if (!stMsg) continue;
                // 上一条在小总结里：没法把新回复写进总结文字，交给平常的推送
                if (stMsg.extra.uwu_summary) break;
                const nextIds = [...stMsg.extra.uwu_msg_ids];
                nextIds.splice(nextIds.indexOf(prev.id) + 1, 0, ...newIds.filter(id => !nextIds.includes(id)));
                rebuild(stMsg, nextIds);
                changed = true;
                break;
            }
        }
        if (!changed) return { replaced: false };
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        this._logPush(binding, { kind: 'raw', ids: newIds.slice() });
        this._rememberPushed(binding, newIds);
        return { replaced: true };
    },

    // 把推送窗口里选的那段消息浓缩成一段小总结（用专用总结 API，没配就用主 API）。
    // opts.messages：要总结的消息（推送窗口里用户自己填的范围）
    async summarizeUnpushedSlice(binding, opts) {
        const options = opts || {};
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');

        const wanted = new Set((Array.isArray(options.messages) ? options.messages : []).map(m => m.id));
        const unpushed = char.history.filter(m => m && !m.fromTavern && wanted.has(m.id) && m.content?.trim() && !m.isThinking);
        if (unpushed.length === 0) throw new Error('没有可总结的消息');

        const apiCfg = (db.summaryApiSettings && db.summaryApiSettings.url && db.summaryApiSettings.key && db.summaryApiSettings.model)
            ? db.summaryApiSettings : db.apiSettings;
        if (!apiCfg || !apiCfg.url || !apiCfg.key || !apiCfg.model) throw new Error('请先配置总结 API 或主 API');
        let url = apiCfg.url; if (url.endsWith('/')) url = url.slice(0, -1);

        const charName = char.realName || char.name || '对方';
        const myName = char.myName || '我';
        const transcript = unpushed.map(m => {
            const who = m.role === 'user' ? myName : charName;
            const text = (m.content || '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
            return `${who}：${text}`;
        }).filter(s => s.split('：')[1]).join('\n');

        const prompt = `请把以下手机聊天记录浓缩成一段简短的第三人称客观总结（约 100-250 字）：
- 保留关键事件、决定、情绪转折、新出现的设定
- 客观平实，不要价值升华或情绪渲染
- 不要包含"总结如下"之类的开场白，直接输出总结内容

【聊天双方】${myName}（用户）与 ${charName}
【聊天记录】
${transcript}`;

        const messages = [{ role: 'user', content: prompt }];
        let body = { model: apiCfg.model, messages, stream: false, temperature: 0.5 };
        let endpoint, headers;
        if (apiCfg.provider === 'gemini') {
            body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
            endpoint = `${url}/v1beta/models/${apiCfg.model}:generateContent?key=${apiCfg.key}`;
            headers = { 'Content-Type': 'application/json' };
        } else {
            endpoint = `${url}/v1/chat/completions`;
            headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiCfg.key}` };
        }

        const resp = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error(`总结 API 失败: ${resp.status}`);
        const data = await resp.json();
        let text = (apiCfg.provider === 'gemini')
            ? (data.candidates?.[0]?.content?.parts?.[0]?.text || '')
            : (data.choices?.[0]?.message?.content || '');
        text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
        if (!text) throw new Error('总结内容为空');

        return {
            text,
            coveredMsgIds: unpushed.map(m => m.id),
            coveredCount: unpushed.length,
            lastMsgId: unpushed[unpushed.length - 1].id,
        };
    },

    // 推送一条小总结到酒馆，并把 lastPushedMsgId 推进到被覆盖的最后一条
    async pushSummaryToTavern(binding, summaryText, lastCoveredMsgId, coveredMsgIds) {
        return this._pushSummaryToTavern(binding, summaryText, lastCoveredMsgId, coveredMsgIds);
    },
    async _pushSummaryToTavern(binding, summaryText, lastCoveredMsgId, coveredMsgIds, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const text = (summaryText || '').trim();
        if (!text) throw new Error('总结内容为空');

        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        const myName = char.myName || '我';
        const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
        const mergedContent = `<phone_chat>\n[小总结：${text}]\n</phone_chat>`;

        all.push({
            name: myName,
            is_user: true, is_system: false,
            send_date: new Date().toISOString(),
            mes: mergedContent,
            extra: { from_uwu: true, uwu_created: true, uwu_summary: true, uwu_push_time: Date.now(), uwu_msg_ids: coveredMsgIds || [], st_char_name: stCharName },
        });
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });

        if (!opts.noLog) this._logPush(binding, { kind: 'summary', ids: (coveredMsgIds || []).slice(), text });
        // 总结代表了那段消息：把“上次推送到哪一条”挪到它覆盖的最后一条（只往后挪，总结的是较早的一段时不往回退）
        binding.hasPushed = true;
        this._advancePushMark(binding, char, lastCoveredMsgId);
        await this.saveConfig(this.getConfig());
        this._notifyData();
        return { pushed: 1 };
    },

    // ========== 提示词注入 ==========

    // 生成要塞进 AI 系统提示词的酒馆内容，由 tavern_hooks.js 插进 yuan 提示词的 <memoir> 区域：
    //   - 聊天记录里有酒馆楼层时，加一段“线下剧情说明”（可在酒馆互联页面自定义）
    // 酒馆剧情本身已经在聊天记录里（见 pullFromTavern / prepareHistoryForAI），这里不再整块注入。
    buildPromptBlock(character) {
        if (!character) return '';
        const cfg = this.getConfig();
        const parts = [];
        const hasTavernFloors = Array.isArray(character.history) && character.history.some(m => m && m.fromTavern);
        if (hasTavernFloors && cfg.wrapNote && cfg.wrapNote.trim()) {
            parts.push(cfg.wrapNote.trim().replace(/\{\{用户\}\}/g, character.myName || '我'));
        }
        return parts.join('\n\n');
    },

    // ========== 自动同步 ==========

    // 查找角色对应的绑定
    findBindingForChar(charId) {
        const cfg = this.getConfig();
        return cfg.bindings.find(b => b.uwuCharId === charId);
    },

    // 自动同步开关按角色（绑定）分别设置（yuan 版新增）。key 是 'autoPull' 或 'autoPush'。
    // 旧版本是全局开关：这个角色还没单独设置过时，沿用旧的全局设置。
    isAuto(binding, key) {
        if (!binding) return false;
        if (typeof binding[key] === 'boolean') return binding[key];
        return !!this.getConfig()[key];
    },

    // 自动拉取（进入聊天时调用）
    async autoPullIfNeeded(charId) {
        const cfg = this.getConfig();
        if (!cfg.enabled) return;
        const binding = this.findBindingForChar(charId);
        if (!binding || !this.isAuto(binding, 'autoPull')) return;
        try {
            const r = await this.pullFromTavern(binding);
            if (r.imported > 0) console.log(`[TavernSync] Auto-pull: ${r.imported} messages`);
        } catch (e) { this.reportIssue('自动从酒馆同步失败：' + e.message, 'pull'); }
    },

    // 仅同步删除（消息被删后立即调用，不推送新消息）
    async autoDeletionSyncIfNeeded(charId) {
        const cfg = this.getConfig();
        if (!cfg.enabled) return;
        const binding = this.findBindingForChar(charId);
        if (!binding || !this.isAuto(binding, 'autoPush')) return;
        try {
            const r = await this.pushToTavern(binding, 0);
            if (r.deleted) console.log('[TavernSync] Deletion sync done');
        } catch (e) { this.reportIssue('把删除推送到酒馆失败：' + e.message, 'push'); }
    },

    // 自动推送（AI 回复后调用）
    async autoPushIfNeeded(charId) {
        const cfg = this.getConfig();
        if (!cfg.enabled) return;
        const binding = this.findBindingForChar(charId);
        if (!binding || !this.isAuto(binding, 'autoPush')) return;
        try {
            const r = await this.pushToTavern(binding);
            if (r.pushed > 0 || r.deleted) console.log(`[TavernSync] Auto-push: ${r.pushed} new, deleted=${r.deleted}`);
        } catch (e) { this.reportIssue('自动推送到酒馆失败：' + e.message, 'push'); }
    },

    // 页面可见时自动同步（从酒馆切回来时触发拉取 + 删除同步）
    _visibilityListenerAdded: false,
    setupVisibilitySync() {
        if (this._visibilityListenerAdded) return;
        this._visibilityListenerAdded = true;
        document.addEventListener('visibilitychange', () => {
            // 只在聊天界面时才运行同步，避免在主页触发意外操作
            // OVO 通过 active class 控制屏幕显示，不是 display:none
            const chatScreen = document.getElementById('chat-room-screen');
            if (!chatScreen || !chatScreen.classList.contains('active')) return;

            const cfg = this.getConfig();
            if (!cfg.enabled) return;
            const charId = typeof currentChatId !== 'undefined' ? currentChatId : null;
            if (!charId) return;
            const binding = this.findBindingForChar(charId);
            if (!binding) return;

            if (document.hidden) {
                // 用户正在离开小手机（切换到酒馆）→ 把还没推的消息推过去，顺便同步删除
                if (this.isAuto(binding, 'autoPush')) {
                    this.pushToTavern(binding).then(r => {
                        if (r.pushed > 0 || r.deleted) console.log('[TavernSync] Leave-sync: pushed to ST');
                    }).catch(e => this.reportIssue('离开小手机时推送到酒馆失败：' + e.message, 'push'));
                }
            } else {
                // 用户回到 OVO → 自动拉取最新记忆
                if (this.isAuto(binding, 'autoPull')) {
                    this.pullFromTavern(binding).then(r => {
                        if (r.imported > 0) console.log(`[TavernSync] Visibility pull: ${r.imported} messages`);
                    }).catch(e => this.reportIssue('切回小手机时自动同步失败：' + e.message, 'pull'));
                }
                // 回来时也做一次删除同步（兜底，防止离开时未能同步的情况）
                if (this.isAuto(binding, 'autoPush')) {
                    this.pushToTavern(binding, 0).then(r => {
                        if (r.deleted) console.log('[TavernSync] Return-sync: delete synced to ST');
                    }).catch(e => this.reportIssue('切回小手机时把删除推送到酒馆失败：' + e.message, 'push'));
                }
            }
        });
    },

    // 导入角色设定 + 用户人设
    async importCharSettings(binding) {
        const stChar = await this.getSTCharacter(binding.stCharAvatar);
        const d = stChar.data || stChar;
        const parts = [];
        if (d.description) parts.push(d.description);
        if (d.personality) parts.push(`性格：${d.personality}`);
        if (d.scenario) parts.push(`场景：${d.scenario}`);
        const charPersona = parts.join('\n\n');

        let userPersonas = [];
        let activePersona = '';
        try {
            const settings = await this.getSTSettings();
            const pu = settings.power_user || {};
            const personas = pu.personas || {};
            const descs = pu.persona_descriptions || {};
            activePersona = pu.persona_description || '';
            for (const [avatar, name] of Object.entries(personas)) {
                const descObj = descs[avatar] || {};
                userPersonas.push({ avatar, name, description: descObj.description || '' });
            }
        } catch (e) { console.warn('[TavernSync] Failed to load user personas:', e); }

        return { charPersona, charName: d.name, userPersonas, activePersona, postHistory: d.post_history_instructions || '' };
    },

    // 获取角色世界书（优先关联世界书，没有则用内嵌）+ 聊天世界书
    async getCharAndChatWorldBooks(binding) {
        const stChar = await this.getSTCharacter(binding.stCharAvatar);
        const d = stChar.data || stChar;
        const result = { charWorld: null, chatWorld: null };

        // 角色世界书：优先读取关联世界书，没有才读内嵌
        const worldName = d.extensions?.world;
        if (worldName) {
            try {
                const wi = await this.getSTWorldInfo(worldName);
                const entries = Object.values(wi.entries || {}).map(e => ({
                    uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
                    order: e.order ?? e.uid ?? 0, position: e.position, depth: e.depth, role: e.role, disabled: !!e.disable, constant: !!e.constant,
                }));
                entries.sort((a, b) => a.order - b.order);
                result.charWorld = { name: worldName, entries };
            } catch (e) { console.warn('[TavernSync] Failed to load char world:', e); }
        } else if (d.character_book?.entries) {
            const entries = Object.values(d.character_book.entries).map(e => ({
                uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
                order: e.order ?? e.uid ?? 0, position: e.position, depth: e.depth, role: e.role, disabled: !!e.disable, constant: !!e.constant,
            }));
            entries.sort((a, b) => a.order - b.order);
            result.charWorld = { name: '角色内嵌世界书', entries };
        }

        // 聊天世界书
        if (binding.stChatFile) {
            try {
                const msgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
                if (msgs?.[0]?.chat_metadata?.world_info) {
                    const chatWbName = msgs[0].chat_metadata.world_info;
                    const wi = await this.getSTWorldInfo(chatWbName);
                    const entries = Object.values(wi.entries || {}).map(e => ({
                        uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
                        order: e.order ?? e.uid ?? 0, position: e.position, depth: e.depth, role: e.role, disabled: !!e.disable, constant: !!e.constant,
                    }));
                    entries.sort((a, b) => a.order - b.order);
                    result.chatWorld = { name: chatWbName, entries };
                }
            } catch (e) { console.warn('[TavernSync] Failed to load chat world:', e); }
        }

        return result;
    },

    // ========== 复制到小手机的酒馆世界书条目 ==========
    // 复制时在小手机的世界书条目上记一条 tavernSource = { avatar, world, uid, hash }，
    // 之后就能认出“这条是从酒馆哪一条复制来的”，以及酒馆里有没有改过（比对 hash）。

    // 内容指纹：条目名 + 正文 + 关键词 + 蓝灯 + 开关 + 顺序。任意一项变了都算“酒馆里已改”
    wbHash(entry) {
        const keys = this.entryKeywords(entry).join(',');
        const text = [entry.comment || '', entry.content || '', keys, entry.constant ? 1 : 0, entry.disabled ? 1 : 0, entry.order ?? ''].join('\u0001');
        let h = 5381;
        for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
        return String(h);
    },

    // 酒馆里的插入位置说明。小手机的世界书只有“前/后”，所以除了“角色设定前”，其余都会变成“后”
    tavernPositionLabel(entry) {
        const p = entry && entry.position;
        const depth = Number.isInteger(entry && entry.depth) ? " " + entry.depth : "";
        // 深度插入还分用什么身份插：0=系统 1=用户 2=AI（酒馆里没写就按系统算）
        const roleName = { 0: "系统", 1: "用户", 2: "AI" }[entry && entry.role] || "系统";
        if (p === 0) return "角色定义前";
        if (p === 1) return "角色定义后";
        if (p === 2) return "作者注释前";
        if (p === 3) return "作者注释后";
        if (p === 4) return "[" + roleName + "]插入深度 @D" + depth;
        if (p === 5) return "示例消息前";
        if (p === 6) return "示例消息后";
        if (p === 7) return "锚点";   // 酒馆代码里叫 outlet（出口），没有固定位置，由预设模板决定
        return "不认识的位置（代号 " + p + "）";   // 酒馆以后加了新位置会显示成这样，把代号告诉维护补丁的人即可
    },

    // 酒馆条目的关键词（绿灯）。酒馆里可能存成数组，也可能是逗号分隔的字符串
    entryKeywords(entry) {
        const k = entry && entry.key;
        if (Array.isArray(k)) return k.map(x => String(x).trim()).filter(Boolean);
        if (typeof k === 'string' && k.trim()) return k.split(/[,，]+/).map(x => x.trim()).filter(Boolean);
        return [];
    },

    // 把酒馆条目的内容套到小手机的世界书条目上（复制和更新都走这里），让两边保持一致：
    //   酒馆的蓝灯（常驻）→ 小手机的“常驻”；绿灯的关键词原样搬过来
    //   酒馆里关掉的条目 → 小手机里也设成关闭
    //   酒馆里的顺序 → 小手机的权重，从 100 开始依次排（权重小的排前面）。
    //     更新时只有酒馆里的顺序真的变了才改权重，这样你自己在小手机里调过的顺序不会被冲掉。
    applyTavernEntry(target, entry, index, isNew) {
        const keywords = this.entryKeywords(entry);
        target.name = entry.comment || target.name || '未命名';
        target.content = entry.content || '';
        target.alwaysOn = !!entry.constant;
        target.keywords = target.alwaysOn ? [] : keywords;
        target.disabled = !!entry.disabled;
        target.position = (entry.position === 0) ? 'before' : 'after';
        const orderChanged = target.tavernSource && target.tavernSource.order !== entry.order;
        if (isNew || orderChanged) target.weight = 100 + (Number.isInteger(index) ? index : 0);
        return target;
    },

    // 找到“从酒馆这一条复制过来”的小手机世界书条目
    findCopiedWorldBook(binding, worldName, uid) {
        return (db.worldBooks || []).find(w => w && w.tavernSource
            && w.tavernSource.avatar === binding.stCharAvatar
            && w.tavernSource.world === worldName
            && w.tavernSource.uid === uid);
    },

    // 小手机世界书条目自己的指纹（名字、正文、关键词、常驻、开关、前/后）。顺序（weight）不算：
    // 你在小手机里调顺序本来就不会被冲掉。复制/更新时记下来，之后对不上就说明你在小手机里改过
    wbLocalHash(w) {
        return this.textHash([w.name || '', w.content || '', (Array.isArray(w.keywords) ? w.keywords : []).join(','),
            w.alwaysOn ? 1 : 0, w.disabled ? 1 : 0, w.position || ''].join('\u0001'));
    },
    textHash(text) {
        const s = String(text == null ? '' : text);
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return String(h);
    },

    // 这条复制过来的世界书，你在小手机里改过没有。更新前复制的条目没记指纹：返回 null（说不准）
    wbEditedLocally(w) {
        const t = w && w.tavernSource;
        if (!t || t.localHash === undefined) return null;
        return this.wbLocalHash(w) !== t.localHash;
    },

    // 自动更新复制过的世界书条目（绑定卡片上的开关打开时，每次从酒馆同步时调用）。
    // 酒馆里改了、小手机里没改 → 用酒馆的新内容更新；小手机里也改过 → 不覆盖，在页面顶部提示
    async syncCopiedWorldBooks(binding) {
        const linked = (db.worldBooks || []).filter(w => w && w.tavernSource && w.tavernSource.avatar === binding.stCharAvatar);
        if (!linked.length) return { updated: 0, kept: 0 };
        const worldBooks = await this.getCharAndChatWorldBooks(binding);
        const sources = [worldBooks.charWorld, worldBooks.chatWorld].filter(Boolean);
        let updated = 0, changedMeta = false;
        const kept = [];
        for (const w of linked) {
            const src = sources.find(s => s.name === w.tavernSource.world);
            if (!src) continue;
            const entry = src.entries.find(e => e.uid === w.tavernSource.uid);
            if (!entry) continue;                       // 酒馆里删掉了 → 小手机这条保留，不动
            const idx = src.entries.indexOf(entry);
            const hash = this.wbHash(entry);
            if (hash === w.tavernSource.hash) {
                // 酒馆里没变。更新前复制的条目没记指纹：趁现在补上——
                // 拿酒馆这一条重新套一遍，和小手机里现在的一样就说明没改过
                if (w.tavernSource.localHash === undefined) {
                    const expect = this.applyTavernEntry(Object.assign({}, w, { tavernSource: Object.assign({}, w.tavernSource) }), entry, idx, false);
                    w.tavernSource.localHash = this.wbLocalHash(expect);
                    changedMeta = true;
                }
                continue;
            }
            // 酒馆里改了。小手机里也改过（或者说不准）→ 不覆盖。
            // 酒馆这一版记在 keptHash 里（同一次改动只提示一次）；hash 不动，
            // 这样世界书窗口里照样标「酒馆里已改」，「更新小手机里的内容」也照样能用
            if (this.wbEditedLocally(w) !== false) {
                if (w.tavernSource.keptHash !== hash) {
                    kept.push(w.name || entry.comment || '未命名');
                    w.tavernSource.keptHash = hash;
                    changedMeta = true;
                }
                continue;
            }
            this.applyTavernEntry(w, entry, idx, false);
            w.tavernSource.hash = hash;
            w.tavernSource.order = entry.order;
            w.tavernSource.localHash = this.wbLocalHash(w);
            delete w.tavernSource.keptHash;
            updated++;
        }
        if (kept.length) {
            const names = kept.slice(0, 5).map(n => `「${n}」`).join('、') + (kept.length > 5 ? ` 等 ${kept.length} 条` : '');
            this.reportIssue(`酒馆中「${(binding.stCharAvatar || '').replace(/\.png$/i, '')}」的世界书条目 ${names} 已经被改动，但你在小手机里也改过，没有自动更新；如果想用酒馆的版本，点「导入酒馆世界书」，勾选这些条目后点「更新小手机里的内容」。`);
        }
        if ((updated || changedMeta) && typeof saveData === 'function') await saveData();
        return { updated, kept: kept.length };
    },

    // ========== 自动更新酒馆人设（yuan 版新增）==========
    // 绑定卡片上的开关「自动更新酒馆人设」+ 下拉「更新哪个」（binding.personaUpdateMode：char / user / both）。
    // 每次同步时看一眼酒馆里的人设：酒馆里改了、小手机里没改 → 更新；小手机里也改过 → 不覆盖，在页面顶部提示。
    // 记录在 binding.personaSync：
    //   charHash / userHash   上次用的酒馆版本的指纹
    //   charLocal / userLocal 上次写进小手机时的指纹（和现在的对不上 = 你在小手机里改过）
    //   userSource            用户人设跟着酒馆里的哪一个（人设头像名，或 '__active__' = 酒馆里当前选中的）
    // 导入酒馆人设窗口导入时也会记这些（见 recordPersonaImport）。
    personaUpdateMode(binding) {
        const m = binding && binding.personaUpdateMode;
        return (m === 'char' || m === 'user' || m === 'both') ? m : 'both';
    },

    _userPersonaText(result, source) {
        if (!source || source === '__active__') return result.activePersona || '';
        const p = (result.userPersonas || []).find(x => x.avatar === source);
        return p ? (p.description || '') : null;     // null = 酒馆里这个人设没了
    },

    // 导入窗口里点了「确认导入」：记下这次用的酒馆版本和写进小手机的内容，之后自动更新拿它们比
    recordPersonaImport(binding, char, result, what) {
        const ps = Object.assign({}, binding.personaSync);
        if (what.char) {
            ps.charHash = this.textHash(result.charPersona || '');
            ps.charLocal = this.textHash(char.persona || '');
            delete ps.charKept;
        }
        if (what.user) {
            if (what.userSource) ps.userSource = what.userSource;
            const tv = this._userPersonaText(result, ps.userSource);
            ps.userHash = this.textHash(tv == null ? '' : tv);
            ps.userLocal = this.textHash(char.myPersona || '');
            delete ps.userKept;
        }
        binding.personaSync = ps;
    },

    async syncPersona(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) return { updated: 0, kept: 0 };
        const mode = this.personaUpdateMode(binding);
        const result = await this.importCharSettings(binding);
        const ps = Object.assign({}, binding.personaSync);
        const tavernName = result.charName || (binding.stCharAvatar || '').replace(/\.png$/i, '');
        let updated = 0;
        const kept = [];
        // field：小手机里存在哪（persona / myPersona）；key：记录用的前缀（char / user）
        const one = (field, key, tavernText, label) => {
            if (tavernText == null || !String(tavernText).trim()) return;   // 酒馆里是空的或没了：不动
            const th = this.textHash(tavernText);
            if (ps[key + 'Hash'] === th) return;                            // 酒馆里没变
            const local = char[field] || '';
            const localUnchanged = ps[key + 'Local'] !== undefined && this.textHash(local) === ps[key + 'Local'];
            if (local === tavernText || !local.trim() || localUnchanged) {
                // 小手机里没改过（或本来就一样、或还是空的）→ 用酒馆的版本
                if (local !== tavernText) { char[field] = tavernText; updated++; }
                ps[key + 'Hash'] = th;
                ps[key + 'Local'] = this.textHash(tavernText);
                delete ps[key + 'Kept'];
                return;
            }
            // 小手机里改过（或者以前没记录、说不准）→ 不覆盖。酒馆这一版记在 Kept 里，同一次改动只提示一次；
            // 之后你点「导入酒馆人设」重新导入，会重新记 Hash / Local，从那以后照常自动更新
            if (ps[key + 'Kept'] !== th) {
                ps[key + 'Kept'] = th;
                kept.push(label);
            }
        };
        if (mode === 'char' || mode === 'both') one('persona', 'char', result.charPersona, '角色人设');
        if (mode === 'user' || mode === 'both') one('myPersona', 'user', this._userPersonaText(result, ps.userSource), '用户人设');
        const changed = JSON.stringify(ps) !== JSON.stringify(binding.personaSync || {});
        binding.personaSync = ps;
        if (kept.length) {
            this.reportIssue(`酒馆中「${tavernName}」的${kept.join('和')}已经被改动，但你在小手机里也改过，没有自动更新；如果想用酒馆的版本，点「导入酒馆人设」重新导入。`);
        }
        if (updated || changed) await this.saveConfig(this.getConfig());   // 会顺带存角色数据
        return { updated, kept: kept.length };
    },

    // 一次性清理：旧版“绑定世界书/跟随”功能留下的数据（yuan 版已删掉这个功能）
    // 以前绑定的条目内容会一直作为【世界设定】发给 AI，而且没有入口能删，所以直接清掉。
    // 想要酒馆世界书内容，改用“导入酒馆世界书”复制到小手机自己的世界书里。
    cleanupLegacyWorldMemory() {
        if (this._legacyCleaned) return 0;
        if (typeof db === 'undefined' || !Array.isArray(db.characters) || !db.characters.length) return 0;
        this._legacyCleaned = true;
        let n = 0;
        db.characters.forEach(c => { if (c && c.tavernWorldMemory) { delete c.tavernWorldMemory; n++; } });
        const cfg = db.tavernSync;
        if (cfg && Array.isArray(cfg.bindings)) {
            cfg.bindings.forEach(b => { if (b && b.boundWorldBook) { delete b.boundWorldBook; n++; } });
        }
        if (n && typeof saveData === 'function') saveData();
        return n;
    },

};

// 把文字里的尖括号等转义掉再放进页面。世界书条目、正则规则里常有 <char> 这类内容，
// 不转义会被浏览器当成页面标签，把后面的排版撑坏（世界书列表曾经因此缩进错乱）
function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 自己的小输入框弹窗。不用浏览器自带的 prompt：手机上点下拉选项弹出 prompt 时，
// 下拉列表会一直开着不关，看不到新建出来的分组，容易以为没建成功。
function askText(title, placeholder) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:10000; display:flex; align-items:center; justify-content:center; padding:20px;';
        overlay.classList.add('ts-overlay');
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:320px;';
        box.innerHTML = `
            <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">${esc(title)}</h3>
            <input id="ask-input" type="text" placeholder="${esc(placeholder || '')}" style="width:100%; box-sizing:border-box; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; margin-bottom:14px;">
            <div style="display:flex; gap:10px;">
                <button id="ask-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;">取消</button>
                <button id="ask-ok" style="flex:1; ${TS.btnP}">确定</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const input = box.querySelector('#ask-input');
        const done = (v) => { overlay.remove(); resolve(v); };
        box.querySelector('#ask-cancel').addEventListener('click', () => done(null));
        box.querySelector('#ask-ok').addEventListener('click', () => done(input.value.trim()));
        input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value.trim()); });
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        setTimeout(() => { try { input.focus(); } catch (e) { /* 聚焦失败不影响输入 */ } }, 50);
    });
}

// 输入框、下拉框、文本框统一照 yuan「思维链」设置页：
//   平时：边框 #e2e8f0、圆角 8、白底（下拉框浅灰底 #fafafa）
//   点进去编辑时：边框变成主题淡蓝 #cee4f1、底色变白
// 行内样式里原来写的边框/底色在这里用 !important 统一盖掉，只作用在“酒馆互联”页面和补丁自己的弹窗里。
(function addFieldStyle() {
    if (document.getElementById('ts-field-style')) return;
    const scope = ['#tavern-sync-screen', '.ts-overlay'];
    const fields = (suffix = '') => scope.map(sc => [
        `${sc} input:not([type=checkbox]):not([type=radio])${suffix}`,
        `${sc} select${suffix}`,
        `${sc} textarea${suffix}`,
    ].join(', ')).join(', ');
    const selects = scope.map(sc => `${sc} select`).join(', ');
    const style = document.createElement('style');
    style.id = 'ts-field-style';
    style.textContent = `
${fields()} { border: 1px solid #e2e8f0 !important; border-radius: 8px !important; background-color: var(--panel-bg, #fff) !important; outline: none; transition: border-color .2s, background-color .2s; }
${selects} { background-color: var(--panel-bg, #fafafa) !important; }
${fields(':focus')} { border-color: #cee4f1 !important; background-color: var(--panel-bg, #fff) !important; }
`;
    (document.head || document.documentElement).appendChild(style);
})();

// ========== UI 样式常量 ==========
const TS = {
    // 模块卡片：照 yuan 设置页的分组（.kkt-group）——白底、圆角 12。
    // 「酒馆互联」页面本身是白底，所以再照 yuan 白底页面（聊天设置、自定义）的做法加浅灰框 + 淡阴影，否则卡片和页面融在一起。
    // 夜间模式下 yuan 会定义 --panel-bg，跟着变深。（原来用的 --received-bg 在 yuan 里没定义，卡片几乎透明）
    card: 'background:var(--panel-bg, #fff); border:1px solid #edf0f3; box-shadow:0 2px 10px rgba(30,41,59,0.05); border-radius:12px; padding:16px; margin-bottom:12px;',
    // 卡片里再套的小卡片（每个角色的绑定）：照 yuan 思维链里的条目卡片（.cot-item-card）
    subCard: 'background:var(--panel-bg, #fff); border:1px solid #eee; border-radius:10px; padding:14px; margin-bottom:10px;',
    label: 'font-size:13px; color:#999; display:block; margin-bottom:4px;',
    input: 'width:100%; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; box-sizing:border-box;',
    // 主按钮用 yuan 通篇在用的那个淡蓝 #cee4f1 + 深色字。写死不跟 var(--primary-color) 走，
    // 免得换了主题或夜间模式时变成别的颜色（曾经显示成淡粉色）
    btnP: 'padding:10px; border-radius:10px; border:none; background:#cee4f1; color:#2a3032; font-size:14px; font-weight:500; cursor:pointer;',
    btnG: 'padding:8px; border-radius:8px; border:none; background:rgba(76,175,80,0.15); color:#4CAF50; font-size:13px; font-weight:500; cursor:pointer;',
    btnB: 'padding:8px; border-radius:8px; border:none; background:rgba(33,150,243,0.15); color:#2196F3; font-size:13px; font-weight:500; cursor:pointer;',
    btnO: 'padding:8px; border-radius:8px; border:none; background:rgba(255,152,0,0.15); color:#FF9800; font-size:13px; font-weight:500; cursor:pointer;',
    btnD: 'background:none; border:none; color:#f44; font-size:18px; cursor:pointer; padding:4px 8px;',
    title: 'font-size:15px; font-weight:600;',
};

// ========== 主界面 ==========
function setupTavernSyncScreen() {
    const screen = document.getElementById('tavern-sync-screen');
    if (!screen) return;
    const mainEl = screen.querySelector('main.content') || screen.querySelector('main');
    if (!mainEl) return;
    const config = TavernSync.getConfig();

    const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const numInput = (id, value) => `<input type="number" id="${id}" value="${value}" min="0" max="999"
                            style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;">`;
    const tplArea = (id, rows) => `<textarea id="${id}" rows="${rows}" spellcheck="false"
                        style="width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:rgba(0,0,0,0.2); color:inherit; font-size:12px; line-height:1.5; resize:vertical;"></textarea>`;
    const smallBtn = 'padding:4px 10px; border-radius:6px; border:none; background:rgba(128,128,128,0.15); color:inherit; font-size:12px; cursor:pointer;';

    mainEl.innerHTML = `
        <div style="padding:4px 0;">
            <div id="ts-issues-area" style="display:none; margin-bottom:12px;"></div>
            <div style="${TS.card}">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <span style="${TS.title}">SillyTavern 连接</span>
                    <span id="ts-status" style="font-size:12px; color:#999; display:inline-flex; align-items:center; gap:2px; white-space:nowrap;">检测中...</span>
                </div>
                <div id="ts-page-link" style="display:none; font-size:12px; color:#888; line-height:1.6; margin-top:8px;"></div>
                <div id="ts-login-area"></div>
            </div>
            <div id="ts-bindings-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <span style="${TS.title}">角色绑定</span>
                        <button id="ts-add-btn" style="padding:6px 14px; border-radius:8px; border:none; background:#cee4f1; color:#2a3032; font-size:13px; cursor:pointer;">+ 添加</button>
                    </div>
                    <div id="ts-bindings-list"></div>
                </div>
            </div>
            <div id="ts-settings-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <span style="${TS.title}">发给 AI 的酒馆剧情</span>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px; flex:1;">最近几楼发原文</span>
                        ${numInput('ts-raw-count', config.rawFloorCount)}
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:4px;">发给 AI 时，最近这么多楼酒馆剧情给完整原文，更早的换成柏宝书摘要（还没有摘要的暂时发原文）</div>
                    <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <div>
                            <div>发原文的酒馆楼层中包含 user 楼层</div>
                            <div style="font-size:11px; color:#888;">关闭后，发原文的酒馆楼层中只包含 AI 楼层，若不抢话不转述可能导致剧情不连贯</div>
                        </div>
                        <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" id="ts-inject-user-floors" ${config.injectUserFloors !== false ? 'checked' : ''}><span class="kkt-slider"></span></span>
                    </label>
                    <div id="ts-wrap-toggle" style="display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; margin-top:14px; padding-top:12px; border-top:1px solid #f0f0f0;">
                        <span style="font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">酒馆剧情包裹提示词自定义</span>
                        <span id="ts-wrap-arrow" style="font-size:12px; color:#888; white-space:nowrap; flex-shrink:0;">点击展开</span>
                    </div>
                    <div id="ts-wrap-body" style="display:none;">
                        <div style="font-size:12px; color:#888; margin:6px 0 10px; line-height:1.55;">
                            酒馆剧情发给 AI 时套用的格式。可用变量：<span style="color:#ffb380;">{{楼层}} {{发言人}} {{内容}} {{时间}}</span>（时间来自柏宝书）。改完点输入框外面即保存。
                        </div>
                        <div style="font-size:13px; margin-bottom:4px;">说明（放在系统提示词里，可用 {{用户}}；留空则不加）</div>
                        ${tplArea('ts-wrap-note', 4)}
                        <div style="font-size:13px; margin:10px 0 4px;">原文包裹（最近几楼）</div>
                        ${tplArea('ts-wrap-raw', 3)}
                        <div style="font-size:13px; margin:10px 0 4px;">摘要包裹（更早的楼层）</div>
                        ${tplArea('ts-wrap-summary', 3)}
                        <div style="display:flex; justify-content:flex-end; margin-top:10px;">
                            <button id="ts-wrap-reset" style="${smallBtn}">恢复默认</button>
                        </div>
                    </div>
                </div>
                <div style="${TS.card} margin-top:12px;">
                    <span style="${TS.title}">从小手机推送到酒馆</span>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px;">推送楼层模式</span>
                        <select id="ts-push-mode" aria-label="推送楼层模式" title="推送楼层模式" style="padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px;">
                            <option value="new" ${(config.pushMode || 'new') === 'new' ? 'selected' : ''}>新开楼层</option>
                            <option value="append" ${config.pushMode === 'append' ? 'selected' : ''}>合并到最后一楼</option>
                        </select>
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:4px; line-height:1.6;">新开楼层：小手机消息以你的身份单独发在新的一楼中。如果酒馆最后一楼就是上次新开的这层楼，就接着写进去，不会每次都新开。<br>合并到最后一楼：不管最后一楼是谁发的，都把小手机消息接在那一楼末尾。</div>
                    <div style="margin-top:14px; padding-top:12px; border-top:1px solid #f0f0f0;">
                        <div style="display:flex; align-items:center; gap:8px; font-size:14px;">
                            <span style="white-space:nowrap;">按角色设置</span>
                            <select id="ts-push-char" aria-label="按角色设置" title="按角色设置" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px;"></select>
                        </div>
                        <div id="ts-push-per-char"></div>
                    </div>
                </div>
            </div>
            <div id="ts-rules-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <span style="${TS.title}">正则清洗规则</span>
                        <button id="ts-add-rule-btn" style="${smallBtn}">+ 添加规则</button>
                    </div>
                    <div style="font-size:12px; color:#888; margin-bottom:10px;">用正则把文字里不想要的部分删掉，或者只挑出想要的部分，比如删掉酒馆 AI 回复里的思考过程。每条规则可以选用在同步（酒馆剧情进小手机时）、推送（小手机消息进酒馆时），还是两头都用；多条规则按列表顺序依次处理。</div>
                    <div id="ts-rules-list"></div>
                </div>
            </div>
        </div>`;

    const statusEl = mainEl.querySelector('#ts-status');
    const loginArea = mainEl.querySelector('#ts-login-area');
    const bindingsArea = mainEl.querySelector('#ts-bindings-area');
    const rulesArea = mainEl.querySelector('#ts-rules-area');
    const settingsArea = mainEl.querySelector('#ts-settings-area');
    const bindingsList = mainEl.querySelector('#ts-bindings-list');
    const rulesList = mainEl.querySelector('#ts-rules-list');

    // ===== 问题记录（出错时显示在页面顶部，手机上不用看控制台）=====
    const issuesArea = mainEl.querySelector('#ts-issues-area');
    function renderIssues() {
        const list = TavernSync.loadIssues();
        if (!list.length) { issuesArea.style.display = 'none'; issuesArea.innerHTML = ''; return; }
        issuesArea.style.display = 'block';
        issuesArea.innerHTML = `<div style="${TS.card} border:1px solid rgba(244,67,54,0.5);">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                <span style="${TS.title} color:#f66;">遇到的问题（${list.length}）</span>
                <button id="ts-issues-clear" style="${smallBtn} background:rgba(244,67,54,0.15); color:#f66;">清空</button>
            </div>
            <div style="max-height:38vh; overflow-y:auto;">
            ${list.slice().reverse().map(it => `<div style="font-size:12px; line-height:1.6; padding:6px 0; border-top:1px solid #f0f0f0; word-break:break-word;"><span style="color:#888;">${new Date(it.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${it.count > 1 ? ` ×${it.count}` : ''}</span> <span style="white-space:pre-wrap;">${escAttr(it.text)}</span></div>`).join('')}
            </div>
        </div>`;
        issuesArea.querySelector('#ts-issues-clear').addEventListener('click', () => { TavernSync.clearIssues(); renderIssues(); });
    }
    renderIssues();
    TavernSync._onIssuesChanged = renderIssues;
    TavernSync._onDataChanged = () => {
        // 你正在卡片上填数字时不重画，免得输入框被换掉、光标丢了
        if (document.activeElement && bindingsList.contains(document.activeElement)) return;
        if (bindingsArea.style.display === 'none') return;
        renderBindings();
    };

    const saveNum = (id, key, fallback) => mainEl.querySelector(id).addEventListener('change', async (e) => {
        const n = parseInt(e.target.value, 10);
        const cfg = TavernSync.getConfig();
        cfg[key] = Number.isInteger(n) && n >= 0 ? n : fallback;
        e.target.value = cfg[key];
        await TavernSync.saveConfig(cfg);
    });
    saveNum('#ts-raw-count', 'rawFloorCount', 3);
    // 绑定卡片上“保留最近 N 楼的原文”那一行会写“现在是 X 楼”、最小值也跟着它，改了要立刻重画卡片，
    // 否则得退出重进才更新，看着像没改成功
    mainEl.querySelector('#ts-raw-count').addEventListener('change', () => {
        try { renderBindings(); } catch (e) { /* 画不出来不影响保存 */ }
    });

    // ===== 推送内容：通话、状态栏、在线状态都按角色分开设 =====
    const pushCharSelect = mainEl.querySelector('#ts-push-char');
    const perCharBox = mainEl.querySelector('#ts-push-per-char');
    function renderPushPerChar() {
        const cfg = TavernSync.getConfig();
        const bindings = cfg.bindings || [];
        if (!bindings.length) {
            pushCharSelect.innerHTML = '<option>还没有绑定角色</option>';
            pushCharSelect.disabled = true;
            perCharBox.innerHTML = '<div style="font-size:12px; color:#888; margin-top:10px;">先在上面添加角色绑定，这里才能按角色设置。</div>';
            return;
        }
        pushCharSelect.disabled = false;
        // 记住选的是哪个角色（按角色认）：删掉前面的绑定后位置会变，按位置认会改到别的角色头上
        const keepChar = pushCharSelect.dataset.charId;
        let idx = bindings.findIndex(b => b.uwuCharId === keepChar);
        if (idx < 0) idx = 0;
        pushCharSelect.dataset.charId = bindings[idx].uwuCharId;
        pushCharSelect.innerHTML = bindings.map((b, i) => {
            const ch = db.characters.find(c => c.id === b.uwuCharId);
            const name = ch ? (ch.remarkName || ch.name) : '未知角色';
            return `<option value="${i}" ${i === idx ? 'selected' : ''}>${esc(name)}</option>`;
        }).join('');
        const b = bindings[idx];
        const callMode = TavernSync.callPushMode(b);
        const statusOn = TavernSync.pushIncludeStatusBarFor(b);
        const onlineOn = TavernSync.pushIncludeOnlineStatusFor(b);
        perCharBox.innerHTML = `
            <label style="display:flex; align-items:center; gap:8px; margin-top:12px; font-size:14px;">
                <span style="white-space:nowrap;">通话推送</span>
                <select id="ts-cc-call" aria-label="通话推送" title="通话推送" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px;">
                    <option value="summary" ${callMode === 'summary' ? 'selected' : ''}>只推总结</option>
                    <option value="context" ${callMode === 'context' ? 'selected' : ''}>只推记录</option>
                    <option value="both" ${callMode === 'both' ? 'selected' : ''}>都推送</option>
                    <option value="none" ${callMode === 'none' ? 'selected' : ''}>不推送</option>
                </select>
            </label>
            <div style="font-size:12px; color:#888; margin-top:4px;">总结 = yuan 自动写的那段通话总结；记录 = 通话过程中的每一句话。前三种都带“打了多久”。</div>
            <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; font-size:14px; cursor:pointer;">
                <div>
                    <div>推送状态栏到酒馆</div>
                    <div style="font-size:11px; color:#888;">关闭后，推送到酒馆的小手机消息会按这个角色的状态栏正则剥掉状态栏，专门的状态更新楼层也不推。</div>
                </div>
                <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" id="ts-cc-status" ${statusOn ? 'checked' : ''}><span class="kkt-slider"></span></span>
            </label>
            <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; font-size:14px; cursor:pointer;">
                <div>
                    <div>推送在线状态到酒馆</div>
                    <div style="font-size:11px; color:#888;">在线状态是 AI 写的“[角色更新状态为：…]”，用来改小手机界面上那行状态文字。默认不推。</div>
                </div>
                <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" id="ts-cc-online" ${onlineOn ? 'checked' : ''}><span class="kkt-slider"></span></span>
            </label>
            <div style="font-size:12px; color:#888; margin-top:10px;">这几项只影响以后推送的消息，已经在酒馆里的不会跟着改或被删掉。</div>`;
        const save = async (fn) => {
            const cfg2 = TavernSync.getConfig();
            const b2 = (cfg2.bindings || [])[idx];
            if (!b2) return;
            fn(b2);
            await TavernSync.saveConfig(cfg2);
        };
        perCharBox.querySelector('#ts-cc-call').addEventListener('change', (e) => save(b2 => {
            b2.callPushMode = e.target.value;
            delete b2.pushCallContext;   // 旧开关不再用
        }));
        perCharBox.querySelector('#ts-cc-status').addEventListener('change', (e) => save(b2 => { b2.pushIncludeStatusBar = e.target.checked; }));
        perCharBox.querySelector('#ts-cc-online').addEventListener('change', (e) => save(b2 => { b2.pushIncludeOnlineStatus = e.target.checked; }));
    }
    pushCharSelect.addEventListener('change', () => {
        const b = (TavernSync.getConfig().bindings || [])[parseInt(pushCharSelect.value, 10)];
        pushCharSelect.dataset.charId = b ? b.uwuCharId : '';
        renderPushPerChar();
    });
    renderPushPerChar();
    mainEl.querySelector('#ts-inject-user-floors').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.injectUserFloors = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-push-mode').addEventListener('change', async (e) => {
        const cfg = TavernSync.getConfig(); cfg.pushMode = e.target.value; await TavernSync.saveConfig(cfg);
    });
    mainEl.querySelector('#ts-add-btn').addEventListener('click', () => showBindingEditor(() => renderBindings()));
    mainEl.querySelector('#ts-add-rule-btn').addEventListener('click', () => showRuleEditor(null, () => renderRules()));

    // 酒馆剧情包裹提示词（用 JS 赋值，避免 HTML 转义把 {{ }} 或尖括号弄乱）
    const wrapFields = [
        ['#ts-wrap-note', 'wrapNote', DEFAULT_WRAP_NOTE],
        ['#ts-wrap-raw', 'wrapRaw', DEFAULT_WRAP_RAW],
        ['#ts-wrap-summary', 'wrapSummary', DEFAULT_WRAP_SUMMARY],
    ];
    wrapFields.forEach(([sel, key]) => {
        const el = mainEl.querySelector(sel);
        el.value = config[key];
        el.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            // 原文/摘要包裹必须带 {{内容}}，否则 AI 收不到剧情；说明可以留空
            if (key !== 'wrapNote' && !el.value.includes('{{内容}}')) {
                showToast('包裹提示词里必须有 {{内容}}，已恢复原来的内容');
                el.value = cfg[key];
                return;
            }
            cfg[key] = el.value;
            await TavernSync.saveConfig(cfg);
            showToast('已保存');
        });
    });
    // 包裹提示词默认收起，点标题展开/收起
    mainEl.querySelector('#ts-wrap-toggle').addEventListener('click', () => {
        const body = mainEl.querySelector('#ts-wrap-body');
        const open = body.style.display === 'none';
        body.style.display = open ? 'block' : 'none';
        mainEl.querySelector('#ts-wrap-arrow').textContent = open ? '点击收起' : '点击展开';
    });
    mainEl.querySelector('#ts-wrap-reset').addEventListener('click', async () => {
        if (!confirm('把三段包裹提示词恢复成默认内容？')) return;
        const cfg = TavernSync.getConfig();
        wrapFields.forEach(([sel, key, def]) => { cfg[key] = def; mainEl.querySelector(sel).value = def; });
        await TavernSync.saveConfig(cfg);
        showToast('已恢复默认');
    });

    // ===== 连接逻辑 =====
    function showConnected(charCount) {
        statusEl.innerHTML = `<span style="color:#4CAF50;">已连接（${charCount} 个角色）</span> <button id="ts-reconnect-btn" style="background:none; border:none; color:#999; font-size:14px; line-height:1; cursor:pointer; padding:0 2px; display:inline-flex; align-items:center;" title="重新连接">↻</button>`;
        statusEl.querySelector('#ts-reconnect-btn').addEventListener('click', checkAndLogin);
        loginArea.innerHTML = ''; loginArea.style.marginTop = '0';
        bindingsArea.style.display = 'block'; rulesArea.style.display = 'block'; settingsArea.style.display = 'block';
        renderBindings(); renderRules();
        renderPageLink();
    }

    // 同一个浏览器里有没有开着的酒馆页面：有就说明会自动处理；没有就提醒跨浏览器时要手动刷新酒馆
    const pageLinkEl = mainEl.querySelector('#ts-page-link');
    async function renderPageLink() {
        const found = await TavernSync.pingTavernPage();
        if (!pageLinkEl.isConnected) return;
        pageLinkEl.style.display = 'block';
        pageLinkEl.textContent = found
            ? '同一个浏览器里开着酒馆页面：小手机推送后，酒馆会自动重新读取聊天，不用手动刷新。'
            : '没有检测到同一个浏览器里开着的酒馆页面。如果你在别的设备或浏览器里开着酒馆，回到那边继续玩之前，请先刷新酒馆页面，否则酒馆保存时会把小手机推过去的消息盖掉。离开酒馆页面前，也最好等回复生成完、柏宝书写完摘要。';
    }

    function showLoginUI(users) {
        statusEl.textContent = '需要登录'; statusEl.style.color = '#FF9800';
        // 即使未登录也显示已有绑定（只是不能操作）
        const cfg = TavernSync.getConfig();
        if (cfg.bindings.length) {
            bindingsArea.style.display = 'block';
            renderBindings();
        }
        if (users?.length) {
            loginArea.style.marginTop = '10px';
            loginArea.innerHTML = `<div style="font-size:13px; color:#999; margin-bottom:8px;">选择酒馆账户</div>
                ${users.map(u => `<button class="ts-user-btn" data-handle="${u.handle}" data-pwd="${u.password}"
                    style="display:flex; align-items:center; gap:10px; width:100%; padding:12px; border-radius:10px; border:none; background:rgba(128,128,128,0.1); color:inherit; font-size:14px; cursor:pointer; margin-bottom:8px; text-align:left;">
                    <span>${esc(u.name || u.handle)}</span>
                    ${u.password ? '<span style="font-size:11px; color:#999; margin-left:auto;">需要密码</span>' : ''}</button>`).join('')}
                <div id="ts-password-area" style="display:none; margin-top:8px;">
                    <input type="password" id="ts-pwd-input" placeholder="输入密码" style="${TS.input} margin-bottom:8px;">
                    <button id="ts-pwd-submit" style="width:100%; ${TS.btnP}">登录</button></div>`;
            let selectedHandle = null;
            loginArea.querySelectorAll('.ts-user-btn').forEach(btn => {
                btn.addEventListener('click', () => { selectedHandle = btn.dataset.handle; if (btn.dataset.pwd === 'true') { loginArea.querySelector('#ts-password-area').style.display = 'block'; loginArea.querySelector('#ts-pwd-input').focus(); } else doLogin(selectedHandle, null); });
            });
            const pwdSubmit = loginArea.querySelector('#ts-pwd-submit'), pwdInput = loginArea.querySelector('#ts-pwd-input');
            if (pwdSubmit) { pwdSubmit.addEventListener('click', () => doLogin(selectedHandle, pwdInput.value)); pwdInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(selectedHandle, pwdInput.value); }); }
        } else {
            loginArea.style.marginTop = '10px';
            loginArea.innerHTML = `<button id="ts-retry-btn" style="width:100%; ${TS.btnP}">连接酒馆</button>`;
            loginArea.querySelector('#ts-retry-btn').addEventListener('click', checkAndLogin);
        }
    }

    async function doLogin(handle, password) {
        statusEl.textContent = '登录中...'; statusEl.style.color = '#999';
        try { await TavernSync.login(handle, password); const r = await TavernSync.testConnection();
            if (r.ok) {
                // 只更新 enabled 字段，不丢失其他数据
                const cfg = TavernSync.getConfig();
                cfg.enabled = true;
                await TavernSync.saveConfig(cfg);
                showConnected(r.count);
            } else { statusEl.textContent = `${r.error}`; statusEl.style.color = '#f44336'; }
        } catch (e) { statusEl.textContent = `${e.message}`; statusEl.style.color = '#f44336'; }
    }

    async function checkAndLogin() {
        statusEl.textContent = '连接中...'; statusEl.style.color = '#999'; loginArea.innerHTML = ''; loginArea.style.marginTop = '0';
        pageLinkEl.style.display = 'none';
        const r = await TavernSync.testConnection();
        if (r.ok) {
            const cfg = TavernSync.getConfig();
            cfg.enabled = true;
            await TavernSync.saveConfig(cfg);
            showConnected(r.count);
            return;
        }
        try { showLoginUI(await TavernSync.getUserList()); } catch { statusEl.textContent = '无法连接酒馆'; statusEl.style.color = '#f44336'; showLoginUI(null); }
    }

    // ===== 正则规则 =====
    function renderRules() {
        const cfg = TavernSync.getConfig();
        const rules = cfg.cleanRules || [];
        if (!rules.length) { rulesList.innerHTML = '<div style="text-align:center; color:#888; font-size:12px; padding:10px;">暂无规则，消息原样注入。</div>'; return; }
        rulesList.innerHTML = rules.map((r, i) => `
            <div style="display:flex; align-items:center; gap:8px; padding:8px; background:rgba(128,128,128,0.08); border-radius:8px; margin-bottom:6px;">
                <div style="flex:1; min-width:0; cursor:pointer;" data-edit="${i}">
                    <div style="font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.name || '未命名')}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.mode === 'extract' ? '提取' : '排除'} · ${r.scope === 'pull' ? '同步' : r.scope === 'push' ? '推送' : '同步和推送'} · /${esc(r.regex)}/</div>
                </div>
                <label class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-toggle="${i}" ${r.enabled ? 'checked' : ''}><span class="kkt-slider"></span></label>
                <button data-delrule="${i}" style="${TS.btnD} font-size:14px;">✕</button>
            </div>`).join('');
        rulesList.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('change', async () => { const cfg = TavernSync.getConfig(); cfg.cleanRules[parseInt(cb.dataset.toggle)].enabled = cb.checked; await TavernSync.saveConfig(cfg); }));
        rulesList.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => showRuleEditor(parseInt(el.dataset.edit), () => renderRules())));
        rulesList.querySelectorAll('[data-delrule]').forEach(btn => btn.addEventListener('click', async () => {
            const cfg = TavernSync.getConfig();
            const idx = parseInt(btn.dataset.delrule);
            const rule = cfg.cleanRules[idx];
            if (!rule) return;
            if (!confirm(`删除清洗规则「${rule.name || '未命名'}」？`)) return;
            cfg.cleanRules.splice(idx, 1);
            await TavernSync.saveConfig(cfg);
            renderRules();
        }));
    }

    // ===== 绑定列表 =====
    function renderBindings() {
        try { renderPushPerChar(); } catch (e) { /* 还没画到那一块时跳过 */ }
        const cfg = TavernSync.getConfig();
        if (!cfg.bindings?.length) { bindingsList.innerHTML = '<div style="text-align:center; color:#999; font-size:13px; padding:20px;">暂无绑定，点击上方「+ 添加」关联角色</div>'; return; }
        bindingsList.innerHTML = cfg.bindings.map((b, i) => {
            const char = db.characters.find(c => c.id === b.uwuCharId);
            const charName = char ? (char.remarkName || char.name) : '未知';
            const stName = b.stCharAvatar?.replace('.png', '') || '未知';
            const mem = char?.tavernMemory;
            // 只数现在绑定的这个酒馆聊天的楼层；以前绑定的聊天留下的另起一行写
            const tavernMsgs = char && Array.isArray(char.history) ? TavernSync._floorsOfChat(char, b) : [];
            const otherMsgs = char && Array.isArray(char.history) ? TavernSync.otherChatFloors(b) : [];
            const floorCount = tavernMsgs.length;
            // 占多少字：楼层原文 + 摘要都算，给维护者判断什么时候该清理
            const charsOf = (list) => list.reduce((n, m) => n + (m.content ? m.content.length : 0)
                + (m.tavern && !m.tavern.trimmed && m.tavern.summary && m.tavern.summary.text ? m.tavern.summary.text.length : 0), 0);
            const tavernChars = charsOf(tavernMsgs);
            const trimmedCount = tavernMsgs.filter(m => m.tavern && m.tavern.trimmed).length;
            const synced = TavernSync.hasSynced(b);                 // 和现在这个酒馆聊天同步过没有
            const newer = TavernSync.newerChatFor(b);                // 酒馆里这个角色最近在玩另一个聊天
            // 同一个小手机角色绑了两次：只有排在前面的那条起作用
            const dupOf = cfg.bindings.findIndex(x => x.uwuCharId === b.uwuCharId);
            const isDup = dupOf !== i;
            const firstCount = TavernSync.initialImportFor(b);
            const sizeOf = (n) => n >= 10000 ? `约 ${(n / 10000).toFixed(1)} 万字` : `约 ${n} 字`;
            const sizeText = sizeOf(tavernChars);
            // 时间写成“9月20日 10:30”，比 9/20 好认
            const fmtSync = (ts) => {
                const d = new Date(ts);
                return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            };
            const trimText = trimmedCount ? `，其中 ${trimmedCount} 个回合已精简` : '';
            // “上次同步”只写和现在这个聊天的；换了聊天还没同步时不写旧聊天的时间
            const syncInfo = (synced
                ? `小手机里有 ${floorCount} 楼酒馆剧情（${sizeText}${trimText}）<br>上次同步 ${fmtSync(mem.lastSync)}`
                : (mem && mem.lastSync ? '这个酒馆聊天还没同步' : '未同步'))
                + (otherMsgs.length ? `<br>另有 ${otherMsgs.length} 楼来自以前绑定的酒馆聊天（${sizeOf(charsOf(otherMsgs))}）` : '');
            const maxMem = parseInt(char && char.maxMemory, 10) || 20;   // 这个角色在聊天设置里的“可见上文条数”
            return `<div style="${TS.subCard}">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div style="min-width:0;"><div style="font-size:14px; font-weight:600;">${esc(charName)} ↔ ${esc(stName)}</div>
                        <div style="font-size:11px; color:#888; margin-top:2px; word-break:break-all;">酒馆聊天：${esc(b.stChatFile || '未选')} <button data-chat="${i}" style="background:none; border:none; padding:0 2px; color:#2196F3; font-size:11px; cursor:pointer;">更换</button>酒馆里开了新聊天时，记得点「更换」。</div>
                        ${newer ? `<div style="font-size:11px; color:#2196F3; margin-top:4px; word-break:break-all;">酒馆里这个角色最近玩的是另一个聊天「${esc(newer.file)}」，要换过去吗？
                            <button data-newer-go="${i}" style="padding:2px 8px; border-radius:6px; border:none; background:rgba(33,150,243,0.15); color:#2196F3; font-size:11px; cursor:pointer;">换过去</button>
                            <button data-newer-no="${i}" style="padding:2px 8px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:11px; cursor:pointer;">不换</button></div>` : ''}
                        <div style="font-size:11px; color:#888; margin-top:2px;">${syncInfo}</div>
                        ${isDup ? `<div style="font-size:11px; color:#f66; margin-top:2px;">这个角色上面已经绑定过，这一条不起作用，可以删掉。</div>` : ''}</div>
                    <button data-del="${i}" style="${TS.btnD}">✕</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button data-pull="${i}" style="flex:1; ${TS.btnB}">同步酒馆剧情</button>
                    <button data-reset="${i}" style="flex:1; ${TS.btnB}">管理同步范围</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-import-char="${i}" style="flex:1; ${TS.btnB}">导入酒馆人设</button>
                    <button data-import-wb="${i}" style="flex:1; ${TS.btnB}">导入酒馆世界书</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-fillsum="${i}" style="flex:1; ${TS.btnG}">只补摘要</button>
                    <button data-trim="${i}" style="flex:1; ${TS.btnG}">精简旧楼层</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-push="${i}" style="flex:1; ${TS.btnO}">推送/清理消息</button>
                    <button data-preview="${i}" style="flex:1; padding:8px; border-radius:8px; border:none; background:rgba(156,39,176,0.15); color:#CE93D8; font-size:13px; font-weight:500; cursor:pointer;">提示词预览</button></div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; font-size:13px; cursor:pointer;">
                    <span>自动同步酒馆剧情</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-auto="autoPull" data-idx="${i}" ${TavernSync.isAuto(b, 'autoPull') ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                ${!TavernSync.isAuto(b, 'autoPull') ? `<div style="font-size:11px; color:#888; margin:4px 0 0 12px;">关着时，酒馆里的新剧情要点「同步酒馆剧情」才会进来。</div>` : ''}
                <div style="display:${synced ? 'none' : 'flex'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    第一次同步最近
                    <input type="number" data-first-num="${i}" min="0" value="${firstCount}"
                        style="width:64px; padding:4px 6px; border-radius:6px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px; text-align:center;"> 楼
                    <span style="font-size:11px; color:#888; width:100%;">这个角色还没同步过。之后每次同步都会带进全部新楼层，不看这个数字；想挑具体楼层用「管理同步范围」</span>
                </div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>自动推送小手机消息</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-auto="autoPush" data-idx="${i}" ${TavernSync.isAuto(b, 'autoPush') ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                ${!TavernSync.isAuto(b, 'autoPush') ? `<div style="font-size:11px; color:#888; margin:4px 0 0 12px;">关着时，小手机消息要在「推送/清理消息」里手动推到酒馆。</div>` : ''}
                <div data-firstpush-row="${i}" style="display:${(b.lastPushedMsgId || b.hasPushed) ? 'none' : 'flex'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    第一次自动推送最近
                    <input type="number" data-firstpush="${i}" min="0" value="${TavernSync.firstPushCountFor(b)}"
                        style="width:64px; padding:4px 6px; border-radius:6px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px; text-align:center;"> 条
                    <span style="font-size:11px; color:#888; width:100%;">这个角色还没推送过。只有自动推送第一次执行时看这个数字（填 0 就不自动补推）；手动推送在「推送/清理消息」窗口里自己选范围</span>
                </div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>自动更新酒馆人设</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-personaauto="${i}" ${b.autoUpdatePersona ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="display:${b.autoUpdatePersona ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    更新
                    <select data-persona-mode="${i}" aria-label="自动更新哪个人设" title="自动更新哪个人设" style="padding:4px 6px; border-radius:6px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px;">
                        <option value="both" ${TavernSync.personaUpdateMode(b) === 'both' ? 'selected' : ''}>角色人设和用户人设</option>
                        <option value="char" ${TavernSync.personaUpdateMode(b) === 'char' ? 'selected' : ''}>只更新角色人设</option>
                        <option value="user" ${TavernSync.personaUpdateMode(b) === 'user' ? 'selected' : ''}>只更新用户人设</option>
                    </select>
                    <span style="font-size:11px; color:#888; width:100%;">每次同步时，酒馆里的人设改了就更新到小手机；你在小手机里改过的不会被覆盖。用户人设跟着你上次在「导入酒馆人设」里选的那个，没选过就跟着酒馆里当前选中的人设。</span>
                </div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>自动更新复制过的世界书</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-wbauto="${i}" ${b.autoUpdateWorldBooks ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="font-size:11px; color:#888; margin:4px 0 0 12px;">只更新已经复制过的条目，你在小手机里改过的不会被覆盖；酒馆里新加的条目，要在「导入酒馆世界书」里手动复制。</div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>自动精简旧楼层</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-trimauto="${i}" ${b.autoTrim ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="display:${b.autoTrim ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    保留最近
                    <input type="number" data-trim-num="${i}" min="${cfg.rawFloorCount}" value="${TavernSync.keepRawFloorCount(b)}"
                        style="width:64px; padding:4px 6px; border-radius:6px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px; text-align:center;"> 楼的原文
                    <span style="font-size:11px; color:#888; width:100%;">更早的楼层只留柏宝书摘要。不能少于“最近几楼发原文”（现在是 ${cfg.rawFloorCount} 楼）</span>
                </div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>单独限制酒馆上文</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-limit="${i}" ${b.limitTavernContext ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="display:${b.limitTavernContext ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    发给 AI 的酒馆剧情最多
                    <input type="number" data-limit-num="${i}" min="0" max="${maxMem}" value="${Math.min(maxMem, parseInt(b.tavernContextCount, 10) || 0)}"
                        style="width:64px; padding:4px 6px; border-radius:6px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px; text-align:center;"> 楼
                    <span style="font-size:11px; color:#888; width:100%;">这个角色的可见上文是 ${maxMem} 条：取最新的这么多楼酒馆剧情，剩下的名额给小手机消息</span>
                </div>
            </div>`;
        }).join('');

        // 单独限制酒馆上文：开关 + 楼数（不能超过这个角色的可见上文条数）
        bindingsList.querySelectorAll('[data-firstpush-row]').forEach(row => {
            if (row.style.display === 'none') return;
            const idx = parseInt(row.dataset.firstpushRow, 10);
            const b = TavernSync.getConfig().bindings[idx];
            if (!b) return;
            TavernSync.getPushState(b).then(async st => {
                if (!st || !st.pushed || !st.pushed.size) return;     // 酒馆里确实一条都没有，保留这一行
                const cfg = TavernSync.getConfig();
                if (cfg.bindings[idx]) { cfg.bindings[idx].hasPushed = true; await TavernSync.saveConfig(cfg); }
                row.style.display = 'none';
            }).catch(() => { /* 连不上酒馆就先照原样显示 */ });
        });

        bindingsList.querySelectorAll('[data-firstpush]').forEach(inp => inp.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(inp.dataset.firstpush)];
            if (!b) return;
            let n = parseInt(inp.value, 10);
            if (!Number.isInteger(n) || n < 0) n = 0;
            inp.value = n;
            b.firstPushCount = n;
            await TavernSync.saveConfig(cfg);
        }));
        bindingsList.querySelectorAll('[data-first-num]').forEach(inp => inp.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(inp.dataset.firstNum)];
            if (!b) return;
            let n = parseInt(inp.value, 10);
            if (!Number.isInteger(n) || n < 0) n = 0;
            inp.value = n;
            b.initialImportCount = n;
            await TavernSync.saveConfig(cfg);
        }));
        bindingsList.querySelectorAll('[data-personaauto]').forEach(cb => cb.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(cb.dataset.personaauto)];
            if (!b) return;
            b.autoUpdatePersona = cb.checked;
            await TavernSync.saveConfig(cfg);
            renderBindings();   // 下面“更新哪个”那一行跟着出现/消失
        }));
        bindingsList.querySelectorAll('[data-persona-mode]').forEach(sel => sel.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(sel.dataset.personaMode)];
            if (!b) return;
            b.personaUpdateMode = sel.value;
            await TavernSync.saveConfig(cfg);
        }));
        bindingsList.querySelectorAll('[data-wbauto]').forEach(cb => cb.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(cb.dataset.wbauto)];
            if (!b) return;
            b.autoUpdateWorldBooks = cb.checked;
            await TavernSync.saveConfig(cfg);
        }));
        // 自动精简旧楼层：开关 + 保留原文的楼数（不能少于“最近几楼发原文”）
        bindingsList.querySelectorAll('[data-trimauto]').forEach(cb => cb.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(cb.dataset.trimauto)];
            if (!b) return;
            b.autoTrim = cb.checked;
            if (cb.checked && !(parseInt(b.keepRawFloors, 10) >= 0)) b.keepRawFloors = TavernSync.keepRawFloorCount(b);
            await TavernSync.saveConfig(cfg);
            renderBindings();
        }));
        bindingsList.querySelectorAll('[data-trim-num]').forEach(inp => inp.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(inp.dataset.trimNum)];
            if (!b) return;
            const least = cfg.rawFloorCount || 0;
            let n = parseInt(inp.value, 10);
            if (!Number.isInteger(n) || n < 0) n = 0;
            if (n < least) { n = least; showToast(`不能少于“最近几楼发原文”的 ${least} 楼，已改成 ${least}`); }
            inp.value = n;
            b.keepRawFloors = n;
            await TavernSync.saveConfig(cfg);
        }));

        bindingsList.querySelectorAll('[data-limit]').forEach(cb => cb.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(cb.dataset.limit)];
            if (!b) return;
            b.limitTavernContext = cb.checked;
            if (cb.checked && !(parseInt(b.tavernContextCount, 10) >= 0)) {
                const ch = db.characters.find(c => c.id === b.uwuCharId);
                const max = parseInt(ch && ch.maxMemory, 10) || 20;
                b.tavernContextCount = Math.min(max, Math.floor(max / 2));
            }
            await TavernSync.saveConfig(cfg);
            renderBindings();
        }));
        bindingsList.querySelectorAll('[data-limit-num]').forEach(inp => inp.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(inp.dataset.limitNum)];
            if (!b) return;
            const ch = db.characters.find(c => c.id === b.uwuCharId);
            const max = parseInt(ch && ch.maxMemory, 10) || 20;
            let n = parseInt(inp.value, 10);
            if (!Number.isInteger(n) || n < 0) n = 0;
            if (n > max) { n = max; showToast(`不能超过可见上文条数 ${max}，已改成 ${max}`); }
            inp.value = n;
            b.tavernContextCount = n;
            await TavernSync.saveConfig(cfg);
        }));

        // 每个角色自己的自动同步 / 自动推送开关
        bindingsList.querySelectorAll('[data-auto]').forEach(cb => cb.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(cb.dataset.idx)];
            if (!b) return;
            b[cb.dataset.auto] = cb.checked;
            await TavernSync.saveConfig(cfg);
            renderBindings();   // 开关下面“关着时要手动…”那行跟着显示/隐藏
        }));

        const bindClick = (sel, handler) => bindingsList.querySelectorAll(sel).forEach(btn => btn.addEventListener('click', () => handler(btn)));

        bindClick('[data-del]', async (btn) => {
            const cfg = TavernSync.getConfig();
            const idx = parseInt(btn.dataset.del);
            const b = cfg.bindings[idx];
            if (!b) return;
            const ch = db.characters.find(c => c.id === b.uwuCharId);
            const name = `${ch ? (ch.remarkName || ch.name) : '未知'} ↔ ${(b.stCharAvatar || '').replace('.png', '') || '未知'}`;
            if (!confirm(`删除「${name}」的绑定？这个绑定的开关和设置会一起删掉；小手机里已经导入的酒馆剧情、酒馆里已经推送的消息都不受影响。`)) return;
            cfg.bindings.splice(idx, 1);
            await TavernSync.saveConfig(cfg);
            renderBindings();
        });

        bindClick('[data-newer-go]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.newerGo)];
            const newer = b && TavernSync.newerChatFor(b);
            if (!newer) return;
            btn.disabled = true;
            try {
                await TavernSync.changeChatFile(b, newer.file);
                showToast('已换成酒馆里最近在玩的聊天，下次同步从它开始');
                renderBindings();
            } catch (e) { showToast(`${e.message}`); btn.disabled = false; }
        });
        bindClick('[data-newer-no]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.newerNo)];
            if (!b || !b.newerChat) return;
            b.dismissedChat = b.newerChat.file;   // 这个聊天以后不再问；酒馆里再开别的新聊天还会提示
            await TavernSync.saveConfig(cfg);
            renderBindings();
        });

        bindClick('[data-chat]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.chat)];
            if (!b) return;
            try { await showChangeChatModal(b, () => renderBindings()); } catch (e) { showToast(`${e.message}`); }
        });

        bindClick('[data-pull]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.pull)];
            const orig = btn.textContent; btn.textContent = '同步中...'; btn.disabled = true;
            try { const r = await TavernSync.pullFromTavern(b); showToast([
                r.imported ? `同步了 ${r.imported} 楼新剧情` : '',
                r.removedGone ? `酒馆里删掉的 ${r.removedGone} 楼也删掉了` : '',
                r.summariesFilled ? `补上 ${r.summariesFilled} 段摘要` : '',
                r.summariesCleared ? `清掉 ${r.summariesCleared} 段柏宝书已作废的摘要` : '',
                r.reordered ? '已按时间重新排好位置' : '',
                r.autoTrimmed ? `精简 ${r.autoTrimmed} 楼旧剧情` : '',
                r.worldUpdated ? `更新 ${r.worldUpdated} 条世界书` : '',
                r.personaUpdated ? `更新了酒馆人设` : '',
            ].filter(Boolean).join('，') || '酒馆没有新楼层'); renderBindings(); }
            catch (e) { showToast(`${e.message}`); }
            btn.textContent = orig; btn.disabled = false;
        });

        // 和聊天页“+”里的推送窗口完全一样（原来那个“推送最近 N 条、不管推没推过”的窗口已删掉，容易重复推）
        bindClick('[data-push]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.push)];
            const orig = btn.textContent; btn.textContent = '读取中...'; btn.disabled = true;
            try { await showAutoPushModal(b, () => renderBindings()); } catch (e) { showToast(`${e.message}`); }
            btn.textContent = orig; btn.disabled = false;
        });

        bindClick('[data-import-char]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.importChar)];
            btn.textContent = '加载中...'; btn.disabled = true;
            try { await showImportCharModal(b); } catch (e) { showToast(`${e.message}`); }
            btn.textContent = '导入酒馆人设'; btn.disabled = false;
        });

        bindClick('[data-reset]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.reset)];
            const orig = btn.textContent; btn.textContent = '读取中...'; btn.disabled = true;
            try { await showResetRangeModal(b, () => renderBindings()); } catch (e) { showToast(`${e.message}`); }
            btn.textContent = orig; btn.disabled = false;
        });

        bindClick('[data-import-wb]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.importWb)];
            btn.textContent = '加载中...'; btn.disabled = true;
            try { await showWorldBookModal(b); renderBindings(); } catch (e) { showToast(`${e.message}`); }
            btn.textContent = '导入酒馆世界书'; btn.disabled = false;
        });

        bindClick('[data-fillsum]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.fillsum)];
            const orig = btn.textContent; btn.textContent = '读取中...'; btn.disabled = true;
            try {
                const r = await TavernSync.refreshSummaries(b);
                showToast(r.filled ? `补上/更新了 ${r.filled} 段摘要` + (r.stillNone ? `，还有 ${r.stillNone} 个回合柏宝书没写摘要` : '')
                    : (r.stillNone ? `没有新摘要，还有 ${r.stillNone} 个回合柏宝书没写摘要` : '摘要都是最新的'));
                renderBindings();
            } catch (e) { showToast(`${e.message}`); }
            btn.textContent = orig; btn.disabled = false;
        });

        bindClick('[data-trim]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.trim)];
            try { showTrimModal(b, () => renderBindings()); } catch (e) { showToast(`${e.message}`); }
        });

        bindClick('[data-preview]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.preview)];
            showPromptPreview(b);
        });
    }

    checkAndLogin();
}

// ========== 聊天页推送弹窗（半自动 · 带追踪）==========
// 入口：聊天页右侧扩展面板的「推送酒馆」按钮
// “已推送/未推送”以酒馆里的记录为准（见 TavernSync.getPushState），所以
//   - 在酒馆互联页面推送过的也算已推送；
//   - 在酒馆里把那一楼删掉的，会重新算成未推送。
// 三个页签：
//   原始消息：默认推未推送的那一段，可以自己填条数范围
//   小总结：把一段消息浓缩成一段总结后推送，默认也是未推送的那一段
//   清理酒馆：把推送到酒馆的小手机消息删掉（只删酒馆里的，不动小手机自己的聊天）
async function showAutoPushModal(binding, onDone) {
    let state;
    try {
        state = await TavernSync.getPushState(binding);
    } catch (e) { showToast(`读取酒馆失败：${e.message}`); return; }
    const { list, pushed, lastPushedIdx } = state;
    const missing = state.missing || [];
    const total = list.length;
    if (!total) { showToast('还没有可推送的消息'); return; }

    const pushedCount = list.filter(m => pushed.has(m.id)).length;
    const firstUnpushed = lastPushedIdx + 2;        // 给用户看的编号从 1 开始
    const unpushedCount = total - (lastPushedIdx + 1);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:85vh; display:flex; flex-direction:column;';

    const numStyle = 'width:66px; padding:6px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const tabBtn = (id, label, active) => `<button data-mode="${id}" class="auto-push-tab" style="flex:1; padding:8px 4px; border-radius:8px; border:1px solid rgba(128,128,128,0.35); background:${active ? 'rgba(33,150,243,0.18)' : 'transparent'}; color:${active ? '#2196F3' : '#999'}; font-size:13px; cursor:pointer;">${label}</button>`;
    const rangeRow = (idPrefix, from, to) => `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px; font-size:14px;">
            第 <input type="number" id="${idPrefix}-from" min="1" max="${total}" value="${from}" style="${numStyle}">
            到 <input type="number" id="${idPrefix}-to" min="1" max="${total}" value="${to}" style="${numStyle}"> 条
        </div>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 4px; font-size:16px; font-weight:600;">推送/清理小手机消息</h3>
        <div style="font-size:12px; color:#888; margin-bottom:10px; line-height:1.6;">
            小手机消息共 ${total} 条，酒馆里已有 ${pushedCount} 条。<br>${unpushedCount ? `未推送：第 ${firstUnpushed} ~ ${total} 条（${unpushedCount} 条）。` : '没有未推送的消息。'}
        </div>
        ${missing.length ? `
        <div id="auto-missing" style="font-size:12px; color:#888; line-height:1.6; margin-bottom:10px; padding:10px; border-radius:8px; border:1px solid rgba(255,152,0,0.45); background:rgba(255,152,0,0.08);">
            有 <b style="color:#FF9800;">${missing.length}</b> 条以前推到过酒馆、现在酒馆里找不到了（第 ${missing.map(m => list.indexOf(m) + 1).slice(0, 5).join('、')}${missing.length > 5 ? ' 等' : ''} 条）。
            可能是酒馆页面没刷新、保存时把它们盖掉了，也可能是你在酒馆里删的。
            <div style="margin:6px 0; color:#999;">${missing.slice(0, 3).map(m => {
                const t = String(m.content || '').replace(/\s+/g, ' ').trim();
                return esc(t.length > 30 ? t.slice(0, 30) + '...' : t);
            }).join('<br>')}${missing.length > 3 ? `<br>... 共 ${missing.length} 条` : ''}</div>
            <div style="display:flex; gap:8px; margin-top:6px;">
                <button id="auto-missing-push" style="flex:1; ${TS.btnO}">补推这些</button>
                <button id="auto-missing-ignore" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:13px; cursor:pointer;">忽略</button>
            </div>
            <div style="margin-top:6px;">补推会放在酒馆最后面。如果是你在酒馆里故意删的，点「忽略」，以后就不再提示。</div>
        </div>` : ''}
        <div style="display:flex; gap:6px; margin-bottom:12px;">
            ${tabBtn('raw', '原始消息', true)}
            ${tabBtn('summary', '小总结', false)}
            ${tabBtn('clean', '清理酒馆', false)}
        </div>

        <div id="auto-mode-raw" style="display:flex; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px;">推送这些消息（默认是未推送的那一段）。</div>
            ${rangeRow('auto-raw', unpushedCount ? firstUnpushed : total, total)}
            <div id="auto-raw-preview" style="font-size:12px; color:#ccc; background:rgba(128,128,128,0.08); border-radius:8px; padding:10px; margin-bottom:12px; max-height:180px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #2196F3;"></div>
        </div>

        <div id="auto-mode-summary" style="display:none; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px;">把这些消息浓缩成一段总结后推送（消耗 1 次总结 API）。</div>
            ${rangeRow('auto-sum', unpushedCount ? firstUnpushed : total, total)}
            <button id="auto-sum-gen" style="${TS.btnG} width:100%; margin-bottom:10px;">生成小总结</button>
            <textarea id="auto-sum-text" placeholder="生成后可在此编辑..." style="width:100%; box-sizing:border-box; min-height:130px; max-height:220px; padding:10px; border-radius:8px; border:1px solid rgba(128,128,128,0.35); background:rgba(128,128,128,0.08); color:inherit; font-size:13px; line-height:1.6; resize:vertical; margin-bottom:12px;"></textarea>
        </div>

        <div id="auto-mode-clean" style="display:none; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px; line-height:1.6;">
                把这些小手机消息从酒馆里删掉（默认全部）。只删酒馆楼层里的小手机内容，不动小手机自己的聊天记录，也不动酒馆原有的剧情。小总结是一整段文字，范围里只要包含它覆盖的任何一条，整段小总结都会删掉。删掉的消息以后不会被自动推送回去。
            </div>
            ${rangeRow('auto-clean', 1, total)}
            <div id="auto-clean-preview" style="font-size:12px; color:#ccc; background:rgba(128,128,128,0.08); border-radius:8px; padding:10px; margin-bottom:12px; max-height:180px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #f66;"></div>
        </div>

        <div style="display:flex; gap:10px;">
            <button id="auto-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="auto-confirm" style="flex:1; ${TS.btnP}">确认推送</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    let mode = 'raw';
    let summaryState = null;

    // 读取某个页签里填的范围，返回这段消息（编号从 1 开始）
    function readRange(idPrefix) {
        const fromEl = modal.querySelector(`#${idPrefix}-from`);
        const toEl = modal.querySelector(`#${idPrefix}-to`);
        let from = parseInt(fromEl.value, 10);
        let to = parseInt(toEl.value, 10);
        if (!Number.isInteger(from) || from < 1) from = 1;
        if (!Number.isInteger(to) || to > total) to = total;
        if (from > to) from = to;
        fromEl.value = from; toEl.value = to;
        return { from, to, msgs: list.slice(from - 1, to) };
    }

    function renderPreview(idPrefix, boxId, markPushed) {
        const { msgs } = readRange(idPrefix);
        const box = modal.querySelector(boxId);
        if (!msgs.length) { box.textContent = '这个范围里没有消息'; return; }
        const shown = msgs.slice(-12);
        const lines = shown.map(m => {
            const text = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
            const done = markPushed && pushed.has(m.id) ? '（酒馆里已有）' : '';
            return esc(text) + done;
        });
        box.innerHTML = (msgs.length > shown.length ? `<span style="color:#666;">... 共 ${msgs.length} 条，只显示最后 ${shown.length} 条</span>\n` : '')
            + lines.join('\n');
    }
    const refreshPreviews = () => {
        renderPreview('auto-raw', '#auto-raw-preview', true);
        renderPreview('auto-clean', '#auto-clean-preview', false);
    };
    modal.querySelectorAll('input[type=number]').forEach(inp => inp.addEventListener('input', refreshPreviews));
    refreshPreviews();

    const confirmBtn = modal.querySelector('#auto-confirm');
    modal.querySelectorAll('.auto-push-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            mode = btn.dataset.mode;
            modal.querySelectorAll('.auto-push-tab').forEach(b => {
                const active = b.dataset.mode === mode;
                b.style.background = active ? 'rgba(33,150,243,0.18)' : 'transparent';
                b.style.color = active ? '#2196F3' : '#999';
            });
            modal.querySelector('#auto-mode-raw').style.display = mode === 'raw' ? 'flex' : 'none';
            modal.querySelector('#auto-mode-summary').style.display = mode === 'summary' ? 'flex' : 'none';
            modal.querySelector('#auto-mode-clean').style.display = mode === 'clean' ? 'flex' : 'none';
            confirmBtn.textContent = mode === 'clean' ? '确认删除' : '确认推送';
            confirmBtn.style.background = mode === 'clean' ? 'rgba(244,67,54,0.8)' : '#cee4f1';
            confirmBtn.style.color = mode === 'clean' ? '#fff' : '#2a3032';
        });
    });

    const genBtn = modal.querySelector('#auto-sum-gen');
    const sumText = modal.querySelector('#auto-sum-text');
    genBtn.addEventListener('click', async () => {
        const { msgs } = readRange('auto-sum');
        if (!msgs.length) { showToast('这个范围里没有消息'); return; }
        genBtn.disabled = true; genBtn.textContent = '生成中...';
        try {
            const r = await TavernSync.summarizeUnpushedSlice(binding, { mode: 'list', messages: msgs });
            summaryState = { text: r.text, lastMsgId: r.lastMsgId, coveredMsgIds: r.coveredMsgIds };
            sumText.value = r.text;
            genBtn.textContent = `重新生成（已覆盖 ${r.coveredCount} 条）`;
        } catch (e) {
            showToast(`${e.message}`);
            genBtn.textContent = '生成小总结';
        } finally { genBtn.disabled = false; }
    });

    const close = () => { overlay.remove(); if (onDone) { try { onDone(); } catch (e) { /* 刷新失败不影响推送 */ } } };
    modal.querySelector('#auto-cancel').addEventListener('click', close);

    // 丢失提示：补推 / 忽略
    const missingPush = modal.querySelector('#auto-missing-push');
    if (missingPush) missingPush.addEventListener('click', async () => {
        missingPush.disabled = true; missingPush.textContent = '补推中...';
        try {
            const r = await TavernSync.pushToTavern(binding, undefined, true, { messages: missing });
            showToast(r.pushed ? `已补推 ${r.pushed} 条到酒馆最后面` : '没有消息被补推');
            close();
        } catch (e) {
            showToast(`${e.message}`);
            missingPush.disabled = false; missingPush.textContent = '补推这些';
        }
    });
    const missingIgnore = modal.querySelector('#auto-missing-ignore');
    if (missingIgnore) missingIgnore.addEventListener('click', async () => {
        await TavernSync.ignoreMissing(binding, missing.map(m => m.id));
        const box = modal.querySelector('#auto-missing');
        if (box) box.remove();
        showToast('已忽略，以后不再提示这些');
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    confirmBtn.addEventListener('click', async () => {
        const orig = confirmBtn.textContent;
        confirmBtn.textContent = '处理中...'; confirmBtn.disabled = true;
        try {
            if (mode === 'summary') {
                const finalText = (sumText.value || '').trim();
                if (!finalText) { showToast('请先生成或填入总结文本'); throw new Error('__cancel');
                }
                const { msgs } = readRange('auto-sum');
                const coveredIds = (summaryState && summaryState.coveredMsgIds && summaryState.coveredMsgIds.length)
                    ? summaryState.coveredMsgIds : msgs.map(m => m.id);
                const lastId = coveredIds[coveredIds.length - 1];
                await TavernSync.pushSummaryToTavern(binding, finalText, lastId, coveredIds);
                showToast(`已推送小总结 · 覆盖 ${coveredIds.length} 条`);
                close();
            } else if (mode === 'clean') {
                const { from, to, msgs } = readRange('auto-clean');
                const ids = msgs.filter(m => pushed.has(m.id)).map(m => m.id);
                if (!ids.length) { showToast('这个范围里没有推送到酒馆的消息'); throw new Error('__cancel'); }
                if (!confirm(`把第 ${from} ~ ${to} 条里已经推送到酒馆的 ${ids.length} 条消息从酒馆删掉？小手机里的聊天不受影响。`)) throw new Error('__cancel');
                const r = await TavernSync.removePushedFromTavern(binding, ids);
                showToast(r.removed > ids.length
                    ? `已从酒馆删掉 ${r.removed} 条小手机消息（含整段删掉的小总结）`
                    : `已从酒馆删掉 ${r.removed} 条小手机消息`);
                close();
            } else {
                const { msgs } = readRange('auto-raw');
                if (!msgs.length) { showToast('这个范围里没有消息'); throw new Error('__cancel'); }
                const r = await TavernSync.pushToTavern(binding, undefined, true, { messages: msgs });
                if (r.pushed > 0) {
                    showToast(`已推送 ${r.pushed} 条消息到酒馆`);
                } else if (r.deleted) {
                    showToast('已把删除推送到酒馆');
                } else {
                    showToast('没有消息被推送');
                }
                close();
            }
        } catch (e) {
            if (e.message !== '__cancel') showToast(`${e.message}`);
            confirmBtn.textContent = orig; confirmBtn.disabled = false;
        }
    });
}

// ========== 清空并重选范围弹窗 ==========
// 删掉这个角色在小手机里的全部酒馆楼层，然后让用户填从酒馆第几楼到第几楼重新导入（或者只同步以后的新楼层）
// ========== 精简旧楼层弹窗（yuan 版新增）==========
// 精简 = 旧楼层只留柏宝书摘要、把原文丢掉，省下小手机里的空间。
// 酒馆里的原文一直都在，点“取回原文”随时拿回来。没有摘要的楼层不会被精简。
function showTrimModal(binding, onDone) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }
    // 只看现在绑定的这个酒馆聊天的楼层（以前绑定的聊天楼层号会重号）
    const floors = TavernSync._floorsOfChat(char, binding);
    if (!floors.length) { showToast('小手机里还没有这个酒馆聊天的剧情'); return; }

    const keep = TavernSync.keepRawFloorCount(binding);
    const floorNo = (m) => (typeof m.tavern.floor === 'number' ? m.tavern.floor : 0);
    const firstFloor = Math.min(...floors.map(floorNo));
    const lastFloor = Math.max(...floors.map(floorNo));
    // 默认范围：留着最近 keep 楼的原文，更早的都精简
    const older = floors.slice(0, Math.max(0, floors.length - keep));
    const defEnd = older.length ? floorNo(older[older.length - 1]) : firstFloor;

    const can = floors.filter(m => TavernSync.canTrim(m));
    const trimmed = floors.filter(m => m.tavern.trimmed);
    // “还没有摘要”只算 AI 楼：你自己在酒馆里发的楼层本来就没有柏宝书摘要，列出来只会添乱
    const noSummary = floors.filter(m => !m.tavern.trimmed && !m.tavern.isUser && !(m.tavern.summary && m.tavern.summary.text));
    // 能省多少字：AI 楼原文换成摘要省下的 + 同一回合里会被一起收走的 user 楼
    const roundUserChars = (ai) => floors.filter(m => m.tavern.isUser && m.tavern.roundAi === ai.tavern.floor)
        .reduce((n, m) => n + (m.content || '').length, 0);
    const saveable = can.reduce((n, m) => n + Math.max(0, (m.content || '').length - m.tavern.summary.text.length) + roundUserChars(m), 0);
    const sizeOf = (n) => n >= 10000 ? `约 ${(n / 10000).toFixed(1)} 万字` : `约 ${n} 字`;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:380px; max-height:85vh; overflow-y:auto;';
    const numStyle = 'width:80px; padding:8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const cancelStyle = 'width:100%; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">精简旧楼层</h3>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:8px;">
            精简就是只留柏宝书摘要、把原文丢掉。原文在酒馆里一直都在，点下面的「取回原文」随时拿回来。
        </div>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:12px;">
            小手机里有 <b>${floors.length}</b> 楼酒馆剧情（第 ${firstFloor} ~ ${lastFloor} 楼）。
            其中 <b>${trimmed.length}</b> 个回合已精简、<b>${can.length}</b> 个回合可以精简（能省${sizeOf(saveable)}）${noSummary.length ? `、<b>${noSummary.length}</b> 个回合还没有摘要（不会精简）` : ''}。
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:14px;">
            从第 <input type="number" id="tm-start" min="0" value="${firstFloor}" style="${numStyle}">
            到第 <input type="number" id="tm-end" min="0" value="${defEnd}" style="${numStyle}"> 楼
        </div>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:16px;">
            填的是酒馆里的楼层号。默认留着最近 ${keep} 楼的原文（跟着「保留最近几楼的原文」走）。<br>
            精简过的楼层发给 AI 时一律用摘要，不算在「最近几楼发原文」里面。
        </div>
        <button id="tm-do" style="width:100%; ${TS.btnP} margin-bottom:8px;">精简成摘要</button>
        <button id="tm-restore" style="width:100%; padding:10px; border-radius:10px; border:none; background:rgba(76,175,80,0.15); color:#4CAF50; font-size:14px; font-weight:500; cursor:pointer; margin-bottom:8px;">取回原文</button>
        <button id="tm-cancel" style="${cancelStyle}">取消</button>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const close = () => overlay.remove();
    modal.querySelector('#tm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const readRange = () => {
        const start = parseInt(modal.querySelector('#tm-start').value, 10);
        const end = parseInt(modal.querySelector('#tm-end').value, 10);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) { showToast('请填正确的楼层范围，开始不能大于结束'); return null; }
        return { start, end };
    };
    const run = async (btn, job) => {
        const range = readRange();
        if (!range) return;
        const buttons = modal.querySelectorAll('button');
        buttons.forEach(b => { b.disabled = true; });
        const orig = btn.textContent; btn.textContent = '处理中...';
        try {
            await job(range);
            close();
            if (onDone) onDone();
        } catch (e) {
            showToast(`${e.message}`);
            buttons.forEach(b => { b.disabled = false; });
            btn.textContent = orig;
        }
    };
    // 把楼层号写成“第 0~3、7 楼”这样连着的几段；段数太多时只写前 5 段
    const floorRanges = (arr) => {
        const nums = [...new Set(arr.filter(n => typeof n === 'number'))].sort((a, b) => a - b);
        if (!nums.length) return '';
        const parts = [];
        let from = nums[0], prev = nums[0];
        for (let i = 1; i <= nums.length; i++) {
            if (i < nums.length && nums[i] === prev + 1) { prev = nums[i]; continue; }
            parts.push(from === prev ? `${from}` : `${from}~${prev}`);
            if (i < nums.length) { from = nums[i]; prev = nums[i]; }
        }
        return parts.length > 5 ? `（第 ${parts.slice(0, 5).join('、')} 等楼）` : `（第 ${parts.join('、')} 楼）`;
    };
    modal.querySelector('#tm-do').addEventListener('click', (e) => run(e.currentTarget, async (range) => {
        const r = await TavernSync.trimFloors(binding, range);
        const where = floorRanges(r.skippedFloors || []);
        showToast(r.trimmed ? `精简了 ${r.trimmed} 个回合，省下约 ${r.saved} 字` + (r.skipped ? `；${r.skipped} 个回合还没有摘要${where}` : '')
            : (r.removedUsers ? `已整理，省下约 ${r.saved} 字`
                : (r.skipped ? `这个范围里的 ${r.skipped} 个回合都还没有摘要${where}` : '这个范围里没有可以精简的回合')));
    }));
    modal.querySelector('#tm-restore').addEventListener('click', (e) => run(e.currentTarget, async (range) => {
        const r = await TavernSync.restoreRawFloors(binding, range);
        showToast(r.restored ? `取回了 ${r.restored} 个回合的原文` + (r.missing ? `；${r.missing} 楼在酒馆里已经找不到` : '')
            : (r.missing ? `${r.missing} 楼在酒馆里已经找不到，取不回来` : '这个范围里没有精简过的回合'));
    }));
}

async function showResetRangeModal(binding, onDone) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }
    const info = await TavernSync.getTavernFloorInfo(binding);
    const have = TavernSync._floorsOfChat(char, binding).length;
    const others = TavernSync.otherChatFloors(binding).length;   // 以前绑定的别的酒馆聊天留下的
    const lastFloor = Math.max(0, info.total - 1);
    const synced = TavernSync.hasSynced(binding);             // 同步过没有：没同步过就只是“选范围”，不用清空
    const firstCount = TavernSync.initialImportFor(binding);
    const defStart = Math.max(0, info.total - firstCount);

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:380px;';
    const numStyle = 'width:80px; padding:8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const cancelStyle = 'flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">管理同步范围</h3>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:12px;">
            ${synced ? `小手机里现在有 <b>${have}</b> 楼酒馆剧情，会全部删掉。<br>` : '这个角色还没同步过，选一段要同步的剧情。<br>'}
            酒馆里这个聊天一共 <b>${info.total}</b> 楼（第 0 ~ ${lastFloor} 楼，和酒馆里楼层的 # 号一致）。
        </div>
        <div style="display:flex; align-items:center; gap:8px; font-size:14px;">
            同步最近 <input type="number" id="rr-recent" min="0" max="${info.total}" value="${Math.min(firstCount, info.total)}" style="${numStyle}"> 楼
        </div>
        <div style="text-align:center; font-size:12px; color:#888; margin:2px 0;">or</div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:14px;">
            从第 <input type="number" id="rr-start" min="0" max="${lastFloor}" value="${defStart}" style="${numStyle}">
            到第 <input type="number" id="rr-end" min="0" max="${lastFloor}" value="${lastFloor}" style="${numStyle}"> 楼
        </div>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:16px;">
            上面填楼数，下面的范围会跟着算好；也可以直接改下面的楼层号。<br>
            小手机推送过去的楼层、番外楼不会同步进来。${synced ? '清空后，' : ''}酒馆里以后新玩的楼层照常同步，不受这里限制。<br>
            已经写进日记、记忆表格、向量记忆的内容不受影响。
        </div>
        <button id="rr-range" style="width:100%; ${TS.btnP} margin-bottom:8px;">${synced ? '清空，并同步这个范围' : '开始同步'}</button>
        <button id="rr-none" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(244,67,54,0.4); background:transparent; color:#f66; font-size:14px; cursor:pointer; margin-bottom:8px;">${synced ? '只清空（以后只同步新楼层）' : '不要旧剧情（只同步以后的新楼层）'}</button>
        ${others ? `<div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:8px;">另外还有 <b>${others}</b> 楼是以前绑定的酒馆聊天留下的，上面的操作不会动它们。</div>
        <button id="rr-others" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(244,67,54,0.4); background:transparent; color:#f66; font-size:14px; cursor:pointer; margin-bottom:8px;">删掉以前聊天留下的 ${others} 楼</button>` : ''}
        <button id="rr-cancel" style="width:100%; ${cancelStyle}">取消</button>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const close = () => overlay.remove();
    modal.querySelector('#rr-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const othersBtn = modal.querySelector('#rr-others');
    if (othersBtn) othersBtn.addEventListener('click', async () => {
        if (!confirm(`删掉小手机里以前绑定的酒馆聊天留下的 ${others} 楼剧情？酒馆里的原文不受影响。`)) return;
        othersBtn.disabled = true;
        try {
            const r = await TavernSync.removeOtherChatFloors(binding);
            showToast(`已删掉 ${r.removed} 楼`);
            close();
            if (onDone) onDone();
        } catch (e) { showToast(`${e.message}`); othersBtn.disabled = false; }
    });

    // 「导入最近 N 楼」和下面的楼层范围互相跟着算
    const recentInput = modal.querySelector('#rr-recent');
    const startInput = modal.querySelector('#rr-start');
    const endInput = modal.querySelector('#rr-end');
    recentInput.addEventListener('input', () => {
        let n = parseInt(recentInput.value, 10);
        if (!Number.isInteger(n) || n < 0) return;
        if (n > info.total) { n = info.total; recentInput.value = n; }
        startInput.value = Math.max(0, info.total - n);
        endInput.value = lastFloor;
    });
    const syncRecent = () => {
        const start = parseInt(startInput.value, 10);
        const end = parseInt(endInput.value, 10);
        if (Number.isInteger(start) && Number.isInteger(end) && end === lastFloor) recentInput.value = Math.max(0, info.total - start);
    };
    startInput.addEventListener('input', syncRecent);
    endInput.addEventListener('input', syncRecent);

    const run = async (range, btn) => {
        const buttons = modal.querySelectorAll('button');
        buttons.forEach(b => { b.disabled = true; });
        const orig = btn.textContent; btn.textContent = '处理中...';
        try {
            // 记住这个角色填的楼数，下次打开还是它（自动同步第一次跑时也用它）
            const n = parseInt(recentInput.value, 10);
            if (Number.isInteger(n) && n >= 0 && n !== TavernSync.initialImportFor(binding)) {
                const cfg = TavernSync.getConfig();
                const b2 = (cfg.bindings || []).find(x => x === binding || (x.uwuCharId === binding.uwuCharId && x.stChatFile === binding.stChatFile));
                if (b2) { b2.initialImportCount = n; await TavernSync.saveConfig(cfg); }
            }
            const r = await TavernSync.resetImportRange(binding, range);
            let msg = synced ? `已删掉 ${r.removed} 楼` : '';
            if (range) {
                const p = await TavernSync.pullFromTavern(binding);
                msg += msg ? `，重新同步 ${p.imported} 楼` : `同步了 ${p.imported} 楼`;
            }
            showToast(msg || '以后只同步新楼层');
            close();
            if (onDone) onDone();
        } catch (e) {
            showToast(`${e.message}`);
            buttons.forEach(b => { b.disabled = false; });
            btn.textContent = orig;
        }
    };
    modal.querySelector('#rr-range').addEventListener('click', (e) => {
        const start = parseInt(modal.querySelector('#rr-start').value, 10);
        const end = parseInt(modal.querySelector('#rr-end').value, 10);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > lastFloor || start > end) {
            showToast(`请填 0 ~ ${lastFloor} 之间的楼层，而且开始不能大于结束`);
            return;
        }
        run({ start, end }, e.currentTarget);
    });
    modal.querySelector('#rr-none').addEventListener('click', (e) => {
        if (synced && !confirm(`删掉小手机里全部 ${have} 楼酒馆剧情，以后只同步新楼层？`)) return;
        run(null, e.currentTarget);
    });
}

// ========== 正则规则编辑弹窗 ==========
function showRuleEditor(ruleIndex, onSave) {
    const cfg = TavernSync.getConfig(); if (!cfg.cleanRules) cfg.cleanRules = [];
    const existing = ruleIndex !== null ? cfg.cleanRules[ruleIndex] : null;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">${existing ? '编辑' : '添加'}清洗规则</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">规则名称</label><input id="rr-name" placeholder="去除思考过程" style="${TS.input}"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">正则表达式</label><input id="rr-regex" placeholder="<thinking>[\\s\\S]*?</thinking>" style="${TS.input} font-family:monospace;"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">用在</label><select id="rr-scope" aria-label="规则用在" title="规则用在" style="${TS.input}">
            <option value="pull" ${existing?.scope === 'pull' ? 'selected' : ''}>同步（酒馆剧情进小手机时）</option>
            <option value="push" ${existing?.scope === 'push' ? 'selected' : ''}>推送（小手机消息进酒馆时）</option>
            <option value="both" ${(!existing || !existing.scope || existing.scope === 'both') ? 'selected' : ''}>两头都用</option></select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">模式</label><select id="rr-mode" aria-label="规则模式" title="规则模式" style="${TS.input}">
            <option value="exclude" ${(!existing || existing.mode === 'exclude') ? 'selected' : ''}>排除</option>
            <option value="extract" ${existing?.mode === 'extract' ? 'selected' : ''}>提取</option></select>
            <div style="font-size:12px; color:#888; margin-top:4px; line-height:1.6;">排除：删掉匹配到的内容，其余保留。<br>提取：只保留匹配到的内容，其余全部去掉；一处都没匹配到就原样不动。</div></div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">测试</label>
            <textarea id="rr-test" placeholder="粘贴消息文本测试..." style="${TS.input} height:60px; resize:vertical;"></textarea>
            <div id="rr-result" style="margin-top:6px; font-size:12px; color:#888; background:rgba(128,128,128,0.08); border-radius:8px; padding:8px; white-space:pre-wrap; max-height:80px; overflow:auto;"></div></div>
        <div style="display:flex; gap:10px;">
            <button id="rr-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="rr-save" style="flex:1; ${TS.btnP}">保存</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);

    // 用 JS 赋值避免 HTML 属性转义导致正则乱码
    if (existing) {
        modal.querySelector('#rr-name').value = existing.name || '';
        modal.querySelector('#rr-regex').value = existing.regex || '';
    }

    function updateTest() {
        const regex = modal.querySelector('#rr-regex').value, mode = modal.querySelector('#rr-mode').value, text = modal.querySelector('#rr-test').value, res = modal.querySelector('#rr-result');
        if (!regex || !text) { res.textContent = ''; return; }
        try { const re = new RegExp(regex, 'gs');
            if (mode === 'extract') { const m = [...text.matchAll(re)]; res.textContent = m.length ? m.map(x => x[1] !== undefined ? x[1] : x[0]).join('\n') : '（无匹配）'; }
            else res.textContent = text.replace(re, '') || '（全部删除）';
        } catch (e) { res.textContent = `正则错误: ${e.message}`; }
    }
    ['#rr-test', '#rr-regex'].forEach(s => modal.querySelector(s).addEventListener('input', updateTest));
    modal.querySelector('#rr-mode').addEventListener('change', updateTest);
    modal.querySelector('#rr-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    modal.querySelector('#rr-save').addEventListener('click', async () => {
        const regex = modal.querySelector('#rr-regex').value; if (!regex) { showToast('请填写正则'); return; }
        try { new RegExp(regex); } catch { showToast('正则无效'); return; }
        const rule = { id: existing?.id || `rule_${Date.now()}`, name: modal.querySelector('#rr-name').value.trim() || '未命名', regex, mode: modal.querySelector('#rr-mode').value, scope: modal.querySelector('#rr-scope').value, enabled: existing?.enabled ?? true };
        const cfg = TavernSync.getConfig(); if (!cfg.cleanRules) cfg.cleanRules = [];
        if (ruleIndex !== null) cfg.cleanRules[ruleIndex] = rule; else cfg.cleanRules.push(rule);
        await TavernSync.saveConfig(cfg); overlay.remove(); showToast('规则已保存'); if (onSave) onSave();
    });
}

// ========== 导入角色设定弹窗 ==========
async function showImportCharModal(binding) {
    const result = await TavernSync.importCharSettings(binding);
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:80vh; overflow-y:auto;';

    const hasPersona = char.persona?.trim();
    const hasMyPersona = char.myPersona?.trim();

    let userPersonaHTML = '';
    if (result.userPersonas.length) {
        const opts = result.userPersonas.map(p => `<option value="${esc(p.avatar)}">${esc(p.name)}</option>`).join('');
        userPersonaHTML = `
            <div style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <label style="${TS.label} margin-bottom:0;">用户人设（"我"的设定）</label>
                    ${hasMyPersona ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
                </div>
                <select id="ic-persona-select" aria-label="用户人设" title="用户人设" style="${TS.input} margin-top:4px;">
                    <option value="">-- 选择要导入的用户人设 --</option>
                    <option value="__active__">酒馆中当前选中的人设</option>
                    ${opts}
                </select>
                <textarea id="ic-mypersona" style="${TS.input} height:80px; resize:vertical; margin-top:6px; font-size:12px;" placeholder="选择人设后显示内容..."></textarea>
                <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px;">
                    <input type="checkbox" id="ic-mypersona-check" checked> 导入用户人设
                </label>
            </div>`;
    }

    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">导入酒馆人设：${esc(result.charName)}</h3>
        ${result.charPersona ? `
            <div style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <label style="${TS.label} margin-bottom:0;">角色人设</label>
                    ${hasPersona ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
                </div>
                <textarea id="ic-persona" style="${TS.input} height:120px; resize:vertical; margin-top:4px; font-size:12px;">${esc(result.charPersona)}</textarea>
                <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px;">
                    <input type="checkbox" id="ic-persona-check" checked> 导入角色人设
                </label>
            </div>` : '<div style="color:#888; font-size:13px; margin-bottom:12px;">酒馆角色无人设描述</div>'}
        ${userPersonaHTML}
        ${result.postHistory ? `
            <div style="margin-bottom:12px;">
                <label style="${TS.label}">Post History Instructions</label>
                <textarea id="ic-posthistory" style="${TS.input} height:60px; resize:vertical; font-size:12px;" readonly>${esc(result.postHistory)}</textarea>
                <div style="font-size:12px; color:#888; margin-top:4px;">（仅供参考，不自动导入）</div>
            </div>` : ''}
        <div style="display:flex; gap:10px;">
            <button id="ic-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="ic-save" style="flex:1; ${TS.btnP}">确认导入</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    const personaSelect = modal.querySelector('#ic-persona-select');
    const myPersonaArea = modal.querySelector('#ic-mypersona');
    if (personaSelect) {
        personaSelect.addEventListener('change', () => {
            const val = personaSelect.value;
            if (val === '__active__') myPersonaArea.value = result.activePersona;
            else if (val) { const p = result.userPersonas.find(x => x.avatar === val); myPersonaArea.value = p?.description || ''; }
            else myPersonaArea.value = '';
        });
        // 上次导入的是哪个用户人设，这次默认还选它（自动更新也跟着它）
        const lastSource = binding.personaSync && binding.personaSync.userSource;
        if (lastSource && [...personaSelect.options].some(o => o.value === lastSource)) {
            personaSelect.value = lastSource;
            personaSelect.dispatchEvent(new Event('change'));
        }
    }

    modal.querySelector('#ic-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector('#ic-save').addEventListener('click', async () => {
        const importPersona = modal.querySelector('#ic-persona-check')?.checked;
        const importMyPersona = modal.querySelector('#ic-mypersona-check')?.checked;

        let didChar = false, didUser = false;
        if (importPersona && result.charPersona) {
            if (hasPersona && !confirm('当前角色已有人设，确定覆盖吗？')) { /* skip */ }
            else { char.persona = modal.querySelector('#ic-persona').value; didChar = true; }
        }
        if (importMyPersona && myPersonaArea?.value?.trim()) {
            if (hasMyPersona && !confirm('当前角色已有用户人设，确定覆盖吗？')) { /* skip */ }
            else { char.myPersona = myPersonaArea.value; didUser = true; }
        }
        // 记下这次导入的是酒馆哪个版本、写进小手机的是什么，「自动更新酒馆人设」拿它判断以后谁改过
        const src = personaSelect ? personaSelect.value : '';
        if (didChar || didUser) {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings.find(x => x === binding) || cfg.bindings.find(x => x.uwuCharId === binding.uwuCharId);
            if (b) TavernSync.recordPersonaImport(b, char, result, { char: didChar, user: didUser && !!src, userSource: src });
            await TavernSync.saveConfig(cfg);   // 会顺带存角色数据
        } else {
            await saveData();
        }
        overlay.remove(); showToast('设定已导入');
    });
}

// ========== 导入酒馆世界书弹窗（角色世界书 + 聊天世界书） ==========
// 把酒馆世界书的条目复制到小手机自己的世界书里。复制过去就是小手机自己的东西，可以随便编辑；
// 复制时记下它来自酒馆哪一条（entry.tavernSource），所以之后酒馆里改了内容，这里能认出来并更新。
// 旧版的“绑定记忆/跟随”已删掉（内容会偷偷一直发给 AI 且没法清理）。
async function showWorldBookModal(binding) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const worldBooks = await TavernSync.getCharAndChatWorldBooks(binding);
    const sources = [];
    if (worldBooks.charWorld) sources.push({ type: '角色世界书', ...worldBooks.charWorld });
    if (worldBooks.chatWorld) sources.push({ type: '聊天世界书', ...worldBooks.chatWorld });
    if (!sources.length) { showToast('该角色没有关联的世界书'); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:85vh; display:flex; flex-direction:column;';

    const tabsHTML = sources.length > 1
        ? sources.map((src, i) => `<button class="wb-tab" data-tab="${i}" style="padding:6px 12px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); background:${i === 0 ? 'rgba(33,150,243,0.18)' : 'transparent'}; color:inherit; font-size:12px; cursor:pointer;">${esc(src.type)}(${src.entries.length})</button>`).join('')
        : '';
    const smallBtn = 'padding:4px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:12px; cursor:pointer;';

    modal.innerHTML = `
        <h3 style="margin:0 0 8px; font-size:16px; font-weight:600;">导入酒馆世界书</h3>
        <div style="font-size:12px; color:#888; margin-bottom:8px; line-height:1.6;">复制过来就是小手机自己的世界书条目，可以随便改。酒馆里改了内容的，这里会标出来，可以选择更新。酒馆里以后改了内容，打开绑定卡片上的「自动更新复制过的世界书」，或者回到这里点「更新小手机里的内容」。</div>
        ${tabsHTML ? `<div style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">${tabsHTML}</div>` : ''}
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-select-all" style="${smallBtn}">全选</button>
            <button id="wb-select-enabled" style="${smallBtn}">只选酒馆里开着的</button>
            <button id="wb-select-changed" style="${smallBtn}">只选有改动的</button>
        </div>
        <div id="wb-entries" style="flex:1; overflow-y:auto; margin-bottom:10px;"></div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:13px;">
            <span style="white-space:nowrap;">加到分组</span>
            <select id="wb-category" aria-label="加到分组" title="加到分组" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:13px;"></select>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-import" style="flex:1; ${TS.btnB}">复制到小手机世界书</button>
            <button id="wb-update" style="flex:1; ${TS.btnG}">更新小手机里的内容</button>
        </div>
        <button id="wb-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    // ===== 分组下拉：小手机现有的分组 + 新建 =====
    const categorySelect = modal.querySelector('#wb-category');
    // 分组下拉 = 小手机世界书里现有的分组（+ 这次新建的）。
    // 注意：只认“现在真的还有条目在用”的分组。以前记住的分组如果在世界书页面被删了，就不该再出现在这里。
    let pendingNewCategory = '';
    function renderCategories(selected) {
        const exist = [...new Set((db.worldBooks || []).map(w => (w.category || '').trim()).filter(Boolean))].sort();
        const cats = [...exist];
        if (pendingNewCategory && !cats.includes(pendingNewCategory)) cats.unshift(pendingNewCategory);
        if (!cats.length) cats.push('未分类');
        const remembered = TavernSync.getConfig().lastWorldBookCategory;
        const want = selected || (cats.includes(remembered) ? remembered : cats[0]);
        categorySelect.innerHTML = cats.map(c => `<option value="${esc(c)}" ${c === want ? 'selected' : ''}>${esc(c)}</option>`).join('')
            + '<option value="__new__">＋ 新建分组…</option>';
    }
    renderCategories();
    categorySelect.addEventListener('change', async () => {
        if (categorySelect.value !== '__new__') {
            const cfg = TavernSync.getConfig(); cfg.lastWorldBookCategory = categorySelect.value; await TavernSync.saveConfig(cfg);
            return;
        }
        // 先把下拉收起来、选项复原，再弹输入框；否则手机上列表会一直开着，看不到新建的分组
        try { categorySelect.blur(); } catch (e) { /* 收不起来也不影响 */ }
        renderCategories(pendingNewCategory || undefined);
        const name = ((await askText('新分组的名字', '例如：世界观')) || '').trim();
        if (name) {
            pendingNewCategory = name;
            const cfg = TavernSync.getConfig(); cfg.lastWorldBookCategory = name; await TavernSync.saveConfig(cfg);
        }
        renderCategories(name || undefined);
        categorySelect.value = name || categorySelect.value;
    });

    // ===== 条目列表 =====
    let currentSourceIdx = 0;
    const boxes = () => [...modal.querySelectorAll('#wb-entries input[type=checkbox]')];
    // 三个筛选按钮：点一下按条件选中并高亮，再点一下取消选中并取消高亮（和“推送/清理消息”窗口的页签一个样式）
    const filterBtns = ['#wb-select-all', '#wb-select-enabled', '#wb-select-changed'].map(sel => modal.querySelector(sel));
    let activeFilter = null;
    function paintFilters() {
        filterBtns.forEach(btn => {
            const on = btn === activeFilter;
            btn.style.background = on ? 'rgba(33,150,243,0.18)' : 'transparent';
            btn.style.color = on ? '#2196F3' : 'inherit';
            btn.style.borderColor = on ? 'rgba(33,150,243,0.5)' : 'rgba(128,128,128,0.35)';
        });
    }
    function applyFilter(btn, pick) {
        if (activeFilter === btn) {          // 再点一次：取消选中
            boxes().forEach(cb => { cb.checked = false; });
            activeFilter = null;
        } else {
            boxes().forEach((cb, i) => { cb.checked = pick(i); });
            activeFilter = btn;
        }
        paintFilters();
    }
    function statusOf(src, e) {
        const copied = TavernSync.findCopiedWorldBook(binding, src.name, e.uid);
        if (!copied) return { text: '', color: '', changed: false, copied: null };
        const changed = copied.tavernSource.hash !== TavernSync.wbHash(e);
        const edited = TavernSync.wbEditedLocally(copied) === true;
        const text = changed ? (edited ? '酒馆里已改，小手机里也改过' : '酒馆里已改') : (edited ? '已复制，小手机里改过' : '已复制');
        return { text, color: changed ? '#FF9800' : '#4CAF50', changed, edited, copied };
    }
    function renderEntries(srcIdx) {
        currentSourceIdx = srcIdx;
        const src = sources[srcIdx];
        const container = modal.querySelector('#wb-entries');
        container.innerHTML = src.entries.map((e, i) => {
            const st = statusOf(src, e);
            const preview = (e.content || '').replace(/\s+/g, ' ').trim();
            return `
            <label style="display:flex; align-items:center; gap:10px; padding:10px; background:rgba(128,128,128,0.08); border-radius:8px; margin-bottom:6px; cursor:pointer; ${e.disabled ? 'opacity:0.55;' : ''}">
                <input type="checkbox" data-idx="${i}" style="flex-shrink:0; margin:0;">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:13px; font-weight:500; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(e.comment || '未命名')}${e.disabled ? '（酒馆里已关闭）' : ''}${st.text ? `<span style="font-size:11px; color:${st.color}; margin-left:6px;">${st.text}</span>` : ''}</div>
                    <div style="font-size:11px; color:#888; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><span style="color:#89a;">位置：${esc(TavernSync.tavernPositionLabel(e))}</span> · ${preview ? esc(preview.slice(0, 80)) : '（空条目）'}</div>
                </div>
            </label>`;
        }).join('');
        paintTabs();
        activeFilter = null;      // 换了来源，筛选重新算
        paintFilters();
    }
    function paintTabs() {
        modal.querySelectorAll('.wb-tab').forEach((t, i) => {
            const on = i === currentSourceIdx;
            t.style.background = on ? 'rgba(33,150,243,0.18)' : 'transparent';
            t.style.color = on ? '#2196F3' : 'inherit';
            t.style.borderColor = on ? 'rgba(33,150,243,0.5)' : 'rgba(128,128,128,0.35)';
        });
    }
    renderEntries(0);
    modal.querySelectorAll('.wb-tab').forEach(tab => tab.addEventListener('click', () => renderEntries(parseInt(tab.dataset.tab))));

    // 自己手动勾选/取消时，筛选按钮的高亮就不再准确了，取消高亮
    modal.querySelector('#wb-entries').addEventListener('change', () => { activeFilter = null; paintFilters(); });
    filterBtns[0].addEventListener('click', () => applyFilter(filterBtns[0], () => true));
    filterBtns[1].addEventListener('click', () => applyFilter(filterBtns[1], (i) => !sources[currentSourceIdx].entries[i].disabled));
    filterBtns[2].addEventListener('click', () => applyFilter(filterBtns[2], (i) => statusOf(sources[currentSourceIdx], sources[currentSourceIdx].entries[i]).changed));

    const getSelected = () => boxes().filter(cb => cb.checked).map(cb => sources[currentSourceIdx].entries[parseInt(cb.dataset.idx)]);

    // ===== 复制 =====
    modal.querySelector('#wb-import').addEventListener('click', async () => {
        const src = sources[currentSourceIdx];
        const selected = getSelected();
        if (!selected.length) { showToast('请先勾选条目'); return; }
        const category = categorySelect.value === '__new__' ? '未分类' : categorySelect.value;
        let added = 0, skipped = 0;
        for (const e of selected) {
            if (TavernSync.findCopiedWorldBook(binding, src.name, e.uid)) { skipped++; continue; }
            const newWb = TavernSync.applyTavernEntry({
                id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                category,
                tags: [],
                isGlobal: false,
                tavernSource: { avatar: binding.stCharAvatar, world: src.name, uid: e.uid, hash: TavernSync.wbHash(e), order: e.order },
            }, e, src.entries.indexOf(e), true);
            newWb.tavernSource.localHash = TavernSync.wbLocalHash(newWb);   // 以后对不上就说明你在小手机里改过
            db.worldBooks.push(newWb);
            if (!char.worldBookIds) char.worldBookIds = [];
            if (!char.worldBookIds.includes(newWb.id)) char.worldBookIds.push(newWb.id);
            added++;
        }
        await saveData();
        renderEntries(currentSourceIdx);
        // @深度 是酒馆特有的位置（插在聊天记录中间第 N 层），小手机没有这个概念，只能放到“后”
        const atDepth = selected.filter(e => e.position === 4).length;
        const depthNote = atDepth ? `。其中 ${atDepth} 条在酒馆里是 @深度 插入，已放到 注入位置：后` : '';
        showToast(added ? `已复制 ${added} 条到分组「${category}」${skipped ? `，${skipped} 条之前复制过（可用“更新”）` : ''}${depthNote}` : '勾选的条目之前都复制过了，可以用“更新小手机里的内容”');
    });

    // ===== 更新 =====
    modal.querySelector('#wb-update').addEventListener('click', async () => {
        const src = sources[currentSourceIdx];
        const selected = getSelected();
        if (!selected.length) { showToast('请先勾选条目'); return; }
        // 你在小手机里改过的条目，更新会用酒馆的版本覆盖，先问一声
        const editedNames = selected.map(e => TavernSync.findCopiedWorldBook(binding, src.name, e.uid))
            .filter(c => c && c.tavernSource.hash !== TavernSync.wbHash(src.entries.find(x => x.uid === c.tavernSource.uid)) && TavernSync.wbEditedLocally(c) === true)
            .map(c => c.name || '未命名');
        if (editedNames.length && !confirm(`勾选的条目里有 ${editedNames.length} 条你在小手机里改过（${editedNames.slice(0, 3).map(n => `「${n}」`).join('、')}${editedNames.length > 3 ? ' 等' : ''}），更新后会换成酒馆的版本，小手机里的改动会丢失。确定更新吗？`)) return;
        let updated = 0, missing = 0;
        for (const e of selected) {
            const copied = TavernSync.findCopiedWorldBook(binding, src.name, e.uid);
            if (!copied) { missing++; continue; }
            if (copied.tavernSource.hash === TavernSync.wbHash(e)) continue;
            TavernSync.applyTavernEntry(copied, e, src.entries.indexOf(e), false);
            copied.tavernSource.hash = TavernSync.wbHash(e);
            copied.tavernSource.order = e.order;
            copied.tavernSource.localHash = TavernSync.wbLocalHash(copied);
            delete copied.tavernSource.keptHash;
            updated++;
        }
        await saveData();
        renderEntries(currentSourceIdx);
        showToast(updated ? `已更新 ${updated} 条${missing ? `，${missing} 条还没复制过` : ''}` : (missing ? '勾选的条目还没复制过' : '勾选的条目内容没有变化'));
    });

    modal.querySelector('#wb-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ========== 提示词预览弹窗 ==========
// 显示 AI 实际会收到的酒馆相关内容（不截断，可滚动）：
//   - 系统提示词里的：线下剧情说明
//   - 聊天记录里的：最近“记忆条数”范围内的酒馆楼层，按原文/摘要处理后的样子
function showPromptPreview(binding) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:85vh; display:flex; flex-direction:column;';

    // 粗略 token 估算：中文约 1.5 字符/token，英文/数字约 4 字符/token
    function estimateTokens(text) {
        if (!text) return 0;
        let cjk = 0, other = 0;
        for (const ch of text) { if (/[一-鿿　-〿＀-￯]/.test(ch)) cjk++; else other++; }
        return Math.ceil(cjk / 1.5 + other / 4);
    }

    const sections = [];
    const promptBlock = TavernSync.buildPromptBlock(char);
    if (promptBlock) sections.push({ title: '系统提示词里（线下剧情说明）', content: promptBlock, color: '#FF9800' });

    // 和 yuan 发消息时一样：取最近“记忆条数”条聊天记录，再经过 filterHistoryForAI（已被补丁接管，会做原文/摘要处理）
    const maxMemory = Number(char.maxMemory) || 20;
    let slice = (char.history || []).slice(-maxMemory);
    if (typeof window.filterHistoryForAI === 'function') {
        try { slice = window.filterHistoryForAI(char, slice); } catch (e) { TavernSync.reportIssue('预览时处理聊天记录失败：' + e.message); }
    }
    const tavernViews = slice.filter(m => m && m.__tavernView);
    const totalFloors = (char.history || []).filter(m => m && m.fromTavern).length;
    const labels = { raw: '原文', summary: '摘要', 'summary-trimmed': '摘要（原文已精简）',
        'raw-nosummary': '原文（AI 楼还没有摘要）', 'raw-user': '原文（酒馆里你发的）' };
    const colors = { raw: '#2196F3', summary: '#4CAF50', 'summary-trimmed': '#26A69A',
        'raw-nosummary': '#FF7043', 'raw-user': '#9E9E9E' };
    if (tavernViews.length) {
        const counts = {};
        tavernViews.forEach(m => { counts[m.__tavernView] = (counts[m.__tavernView] || 0) + 1; });
        sections.push({
            title: '聊天记录里的酒馆剧情',
            meta: `最近 ${maxMemory} 条聊天记录中有 ${tavernViews.length} 楼（小手机里共 ${totalFloors} 楼）：`
                + Object.entries(counts).map(([k, n]) => `${labels[k]} ${n}`).join('，'),
            items: tavernViews.map(m => ({ label: labels[m.__tavernView], color: colors[m.__tavernView], content: m.content })),
            color: '#2196F3',
        });
    } else {
        sections.push({ title: '聊天记录里的酒馆剧情', content: totalFloors
            ? `最近 ${maxMemory} 条聊天记录里没有酒馆楼层（小手机里共 ${totalFloors} 楼，都已经在更早的位置，AI 这次看不到原文）。`
            : '还没有从酒馆导入任何楼层。点“同步记忆”导入。', color: '#999' });
    }

    sections.forEach(s => {
        s.tokens = estimateTokens(s.content || (s.items || []).map(it => it.content).join('\n'));
    });
    const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
    const box = 'font-size:12px; color:#ccc; background:rgba(128,128,128,0.08); border-radius:8px; padding:10px; white-space:pre-wrap; line-height:1.5;';

    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">提示词预览 — ${esc(char.remarkName || char.name)}</h3>
        <div style="font-size:12px; color:#888; margin-bottom:12px;">下面是 AI 下次会收到的酒馆相关内容，预估 <span style="color:#4CAF50; font-weight:600;">~${totalTokens.toLocaleString()}</span> tokens。</div>
        <div style="flex:1; overflow-y:auto; margin-bottom:12px;">
            ${sections.map(s => `
                <div style="margin-bottom:14px;">
                    <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                        <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; flex-shrink:0;"></span>
                        <span style="font-size:13px; font-weight:600; color:${s.color};">${esc(s.title)}</span>
                        <span style="font-size:11px; color:#888; margin-left:auto;">~${s.tokens.toLocaleString()} tokens</span>
                    </div>
                    ${s.meta ? `<div style="font-size:12px; color:#888; margin-bottom:6px;">${esc(s.meta)}</div>` : ''}
                    ${s.content ? `<div style="${box} border-left:3px solid ${s.color};">${esc(s.content)}</div>` : ''}
                    ${(s.items || []).map(it => `
                        <div style="font-size:11px; color:${it.color}; margin:8px 0 3px;">${esc(it.label)}</div>
                        <div style="${box} border-left:3px solid ${it.color};">${esc(it.content)}</div>`).join('')}
                </div>`).join('')}
        </div>
        <button id="pp-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);
    modal.querySelector('#pp-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ========== 更换酒馆聊天弹窗 ==========
// 酒馆里开了新聊天时用：不用删掉绑定重加，开关和设置都保留。
// 换了之后，同步按“第一次同步最近 N 楼”从新聊天重新开始；以前那个聊天导入的剧情留在小手机里，
// 可以在「管理同步范围」里一键删掉。推送也从头算（新聊天里还没有小手机消息）。
async function showChangeChatModal(binding, onDone) {
    const chats = await TavernSync.getSTChats(binding.stCharAvatar);
    const files = (Array.isArray(chats) ? chats : []).map(c => String(c.file_name || '').replace(/\.jsonl$/, '')).filter(Boolean);
    if (!files.length) { showToast('这个酒馆角色还没有聊天记录'); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    const firstCount = TavernSync.initialImportFor(binding);
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">更换酒馆聊天</h3>
        <select id="cc-chat" aria-label="酒馆聊天记录" title="酒馆聊天记录" style="${TS.input} margin-bottom:10px;">
            ${files.map(f => `<option value="${esc(f)}" ${f === binding.stChatFile ? 'selected' : ''}>${esc(f)}</option>`).join('')}
        </select>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:16px;">
            换了之后，下次同步从新聊天的最近 ${firstCount} 楼开始（在卡片上「第一次同步最近」那里可以改）。<br>
            以前那个聊天导入的剧情会留在小手机里，不想要可以在「管理同步范围」里删掉。<br>
            推送也从新聊天重新算，已经推到旧聊天里的消息不会搬过去。
        </div>
        <div style="display:flex; gap:10px;">
            <button id="cc-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="cc-save" style="flex:1; ${TS.btnP}">更换</button>
        </div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const close = () => overlay.remove();
    modal.querySelector('#cc-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    modal.querySelector('#cc-save').addEventListener('click', async () => {
        const file = modal.querySelector('#cc-chat').value;
        if (file === binding.stChatFile) { close(); return; }
        try {
            await TavernSync.changeChatFile(binding, file);
            showToast('已换成新的酒馆聊天');
            close();
            if (onDone) onDone();
        } catch (e) { showToast(`${e.message}`); }
    });
}

// ========== 绑定编辑弹窗 ==========
async function showBindingEditor(onSave) {
    let stCharacters;
    try { stCharacters = await TavernSync.getSTCharacters(); } catch (e) { showToast(`${e.message}`); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">添加角色绑定</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">小手机角色</label>
            <select id="be-uwu" aria-label="小手机角色" title="小手机角色" style="${TS.input}">${db.characters.map(c => `<option value="${c.id}">${esc(c.remarkName || c.name)}</option>`).join('')}</select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">酒馆角色</label>
            <select id="be-st" aria-label="酒馆角色" title="酒馆角色" style="${TS.input}">${stCharacters.map(c => `<option value="${c.avatar}">${esc(c.name)}</option>`).join('')}</select></div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">酒馆聊天记录</label>
            <select id="be-chat" aria-label="酒馆聊天记录" title="酒馆聊天记录" style="${TS.input}"><option>加载中...</option></select></div>
        <div style="display:flex; gap:10px;">
            <button id="be-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="be-save" style="flex:1; ${TS.btnP}">保存</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const stSelect = modal.querySelector('#be-st'), chatSelect = modal.querySelector('#be-chat');
    async function loadChats() {
        if (!stSelect.value) return; chatSelect.innerHTML = '<option>加载中...</option>';
        try { const chats = await TavernSync.getSTChats(stSelect.value);
            chatSelect.innerHTML = chats?.length ? chats.map(c => `<option value="${c.file_name.replace('.jsonl', '')}">${c.file_name}</option>`).join('') : '<option value="">暂无聊天</option>';
        } catch { chatSelect.innerHTML = '<option value="">加载失败</option>'; }
    }
    stSelect.addEventListener('change', loadChats); loadChats();
    modal.querySelector('#be-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    modal.querySelector('#be-save').addEventListener('click', async () => {
        const binding = { uwuCharId: modal.querySelector('#be-uwu').value, stCharAvatar: stSelect.value, stChatFile: chatSelect.value };
        if (!binding.uwuCharId || !binding.stCharAvatar) { showToast('请选择角色'); return; }
        if (!binding.stChatFile) { showToast('请选择酒馆聊天记录'); return; }
        const cfg = TavernSync.getConfig(); if (!cfg.bindings) cfg.bindings = [];
        // 一个小手机角色只能绑一个酒馆聊天（绑两次的话只有第一条起作用）
        if (cfg.bindings.some(b => b.uwuCharId === binding.uwuCharId)) {
            showToast('这个小手机角色已经绑定过了。想换酒馆聊天，点绑定卡片上的「更换」');
            return;
        }
        cfg.bindings.push(binding); await TavernSync.saveConfig(cfg);
        overlay.remove(); showToast('绑定已保存'); if (onSave) onSave();
    });
}

// 写酒馆的操作排队执行（yuan 版新增）：
// 推送、删除同步、小总结、写回修改都是“读取酒馆聊天 → 修改 → 整个存回去”。
// 两个操作同时进行时，后存的会把先存的改动覆盖掉。自动推送和删除同步可能同时触发，所以让它们一个接一个来。
// 从酒馆同步（pullFromTavern）也排进来：打开聊天和切回页面可能同时触发两次同步，同时进行会重复导入同一批楼层。
TavernSync._writeQueue = Promise.resolve();
// 精简、取回原文、只补摘要也会改同一份聊天记录，一起排队，免得和后台自动同步同时进行时互相覆盖。
// （同步里面要精简时调的是不排队的 _trimFloors，否则会自己等自己）
['pushToTavern', 'pushSummaryToTavern', 'pullFromTavern', 'replaceRegeneratedInTavern', 'resetImportRange', 'removePushedFromTavern', 'writeBackFloorEdit', 'updatePushedMessage',
    'trimFloors', 'restoreRawFloors', 'refreshSummaries', 'removeOtherChatFloors', 'changeChatFile', 'recoverLostPushes'].forEach(name => {
    const original = TavernSync[name];
    TavernSync[name] = function (...args) {
        const run = () => original.apply(TavernSync, args);
        const result = TavernSync._writeQueue.then(run, run);
        TavernSync._writeQueue = result.catch(() => {});
        return result;
    };
});

window.setupTavernSyncScreen = setupTavernSyncScreen;
window.TavernSync = TavernSync;
window.showAutoPushModal = showAutoPushModal;
// 注册页面可见性同步
TavernSync.setupVisibilitySync();
// 开始听酒馆那边的回话（“刚才可能盖掉了你写的”）
try { TavernSync._getChannel(); } catch (e) { /* 浏览器不支持就算了，靠兜底核对 */ }

})();

// --- 酒馆互通外挂：核心模块 (tavern/tavern_sync.js) ---
// 从 st 版 js/modules/tavern_sync.js 移植而来，不属于 yuan 原版文件。
// 整个文件包在一个函数里，避免和 yuan 自己的变量/函数重名；
// 对外只通过 window.TavernSync / window.setupTavernSyncScreen 等几个名字暴露。
(function () {


// 默认时间提取正则（命名捕获组）：从酒馆楼层文本里抓剧情时间
// 必需：year / month / day / hour / minute
// 可选：weekday / location / weather / mood（缺失则继承上一楼）
const DEFAULT_TIME_REGEX = String.raw`【\s*(?<year>\d{4})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})\s*日\s*(?<hour>\d{1,2})\s*[:：]\s*(?<minute>\d{2})\s*(?<weekday>星期[一二三四五六日天])?\s*(?:\|(?<location>[^|】]*)\|(?<weather>[^|】]*)\|(?<mood>[^】]*))?】?`;

// 酒馆楼层发给 AI 时的包裹提示词（可在酒馆互联页面自定义）
// 可用变量：{{楼层}} 酒馆楼层号（从 0 数）、{{发言人}}、{{内容}}、{{时间}}（柏宝书记录的故事内时间，没有则为“时间不详”）
const DEFAULT_WRAP_NOTE = '聊天记录中以“[线下剧情”开头的内容，是你和{{用户}}在线下（酒馆）实际经历过的剧情，不是手机消息。请把它们当作已经发生的事自然衔接，你的回复仍然按手机聊天的格式输出，不要模仿其中的叙事文风。';
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

const TavernSync = {
    // 文件版本：显示在“酒馆互联”页面最下面，用来确认手机上加载的是不是最新文件（浏览器有时会用缓存的旧文件）
    SYNC_VERSION: '2026-09-20 g',
    DEFAULT_TIME_REGEX,
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
        return before - kept.length;
    },

    getConfig() {
        if (!db.tavernSync || typeof db.tavernSync !== 'object') {
            db.tavernSync = { enabled: false, bindings: [], maxInjectMessages: 50, cleanRules: [], worldBookPosition: 'before_chat', pushIncludeStatusBar: true };
        }
        // 确保关键字段存在（防止旧数据缺少新字段）
        if (!Array.isArray(db.tavernSync.bindings)) db.tavernSync.bindings = [];
        if (!Array.isArray(db.tavernSync.cleanRules)) db.tavernSync.cleanRules = [];
        if (typeof db.tavernSync.pushIncludeStatusBar !== 'boolean') db.tavernSync.pushIncludeStatusBar = true;
        if (typeof db.tavernSync.pushIncludeOnlineStatus !== 'boolean') db.tavernSync.pushIncludeOnlineStatus = false;
        if (typeof db.tavernSync.timeRegex !== 'string' || !db.tavernSync.timeRegex.trim()) db.tavernSync.timeRegex = DEFAULT_TIME_REGEX;
        if (typeof db.tavernSync.injectUserFloors !== 'boolean') db.tavernSync.injectUserFloors = true;
        const numOr = (v, d) => (Number.isInteger(v) && v >= 0) ? v : d;
        db.tavernSync.initialImportCount = numOr(db.tavernSync.initialImportCount, 20);
        db.tavernSync.rawFloorCount = numOr(db.tavernSync.rawFloorCount, 3);
        if (typeof db.tavernSync.wrapNote !== 'string') db.tavernSync.wrapNote = DEFAULT_WRAP_NOTE;
        if (typeof db.tavernSync.wrapRaw !== 'string' || !db.tavernSync.wrapRaw.trim()) db.tavernSync.wrapRaw = DEFAULT_WRAP_RAW;
        if (typeof db.tavernSync.wrapSummary !== 'string' || !db.tavernSync.wrapSummary.trim()) db.tavernSync.wrapSummary = DEFAULT_WRAP_SUMMARY;
        return db.tavernSync;
    },

    // 编译用户自定义时间正则；失败回退默认。返回 RegExp（一定可用）
    compileTimeRegex(source) {
        const src = (source && String(source).trim()) || DEFAULT_TIME_REGEX;
        try { return new RegExp(src); }
        catch (e) {
            console.warn('[TavernSync] 自定义时间正则无效，回退默认:', e.message);
            try { return new RegExp(DEFAULT_TIME_REGEX); } catch { return /(?!)/; }
        }
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
        return resp.json();
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
    applyCleanRules(text, depth) {
        if (!text || typeof text !== 'string') return '';
        const config = this.getConfig();
        const rules = (config.cleanRules || []).filter(r => r.enabled);
        let result = text;
        for (const rule of rules) {
            // 深度过滤：规则可设置 minDepth / maxDepth 限定生效范围
            if (depth != null) {
                if (rule.minDepth != null && depth < rule.minDepth) continue;
                if (rule.maxDepth != null && depth > rule.maxDepth) continue;
            }
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
        const config = this.getConfig();

        // 聊天文件第一行是聊天设置（没有 mes 字段），真正的楼层从下一行开始；楼层号和酒馆一样从 0 数
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const floors = raw.slice(offset).map((m, floor) => ({ m, floor }));
        // 跳过：小手机自己推送过去的楼层、柏宝书标记的番外/提示楼、空楼
        const candidates = floors.filter(({ m }) =>
            m && typeof m.mes === 'string' && m.mes.trim()
            && !(m.extra && m.extra.uwu_created)
            && !(m.extra && m.extra.bbs_omit));

        // 认楼层：发送时间 + 是不是用户；AI 楼再加上“开始生成时间”（精确到毫秒），
        // 因为发送时间只精确到分钟，同一分钟里的两楼光靠它分不开。旧版导入的楼层没记 genStarted，就不比这一项。
        const sameFloor = (m, t) => this._sameFloor(m, t);
        const prevMemory = char.tavernMemory || {};

        // 0. 酒馆里被删掉的楼层，小手机里也删掉（只删酒馆卡片，不动小手机自己的消息）。
        //    三道保险：只在绑定的还是同一个酒馆聊天时做；从酒馆读回来是空的（比如出错）就完全不动；
        //    认楼层用的是和导入完全一样的那套标准。在酒馆里给某楼重新抽卡（swipe）也会走这里：
        //    旧的算没了、新的当成新楼层导入，卡片内容跟着换。
        let removedGone = 0;
        if (prevMemory.stChatFile === binding.stChatFile && candidates.length) {
            const before = char.history.length;
            char.history = char.history.filter(m => !(m && m.fromTavern && m.tavern)
                || candidates.some(c => sameFloor(c.m, m.tavern)));
            removedGone = before - char.history.length;
        }

        const imported = char.history.filter(h => h && h.fromTavern && h.tavern);

        // 1. 找出要导入的楼层：从“起点楼层”（第一次同步时导入的最早一楼）往后，所有小手机里还没有的楼层。
        //    所以在小手机里删掉的酒馆楼层，下次同步会重新出现。
        //    从没导入过：起点 = 最近“第一次同步导入楼数”楼中最早的一楼。
        // 换绑了另一个酒馆聊天时，旧的起点作废
        let start = (prevMemory.stChatFile === binding.stChatFile && prevMemory.importStart)
            || (imported[0] && { sendDate: imported[0].tavern.sendDate, isUser: imported[0].tavern.isUser, floor: imported[0].tavern.floor });
        let startIdx;
        if (start) {
            startIdx = candidates.findIndex(c => sameFloor(c.m, start));
            if (startIdx < 0) startIdx = candidates.findIndex(c => c.floor >= start.floor);   // 起点那楼在酒馆里被删了
            if (startIdx < 0) startIdx = candidates.length;
        } else {
            startIdx = config.initialImportCount > 0 ? Math.max(0, candidates.length - config.initialImportCount) : candidates.length;
            const first = candidates[startIdx];
            if (first) start = { sendDate: first.m.send_date, isUser: !!first.m.is_user, floor: first.floor };
        }
        // 用户在“清空并重选范围”里选过结束楼层时：只要 [起点, 结束] 这一段，外加“当时酒馆最后一楼”之后的新楼层。
        // start.none 表示当时选了“只清空”：旧楼层一楼都不要，只要之后的新楼层。
        const sameChat = prevMemory.stChatFile === binding.stChatFile;
        const findMarker = (mk) => {
            if (!mk) return -1;
            let i = candidates.findIndex(c => sameFloor(c.m, mk));
            if (i < 0) { for (let j = candidates.length - 1; j >= 0; j--) if (candidates[j].floor <= mk.floor) { i = j; break; } }
            return i;
        };
        if (start && start.none) startIdx = candidates.length;
        const endIdx = sameChat && prevMemory.importEnd ? findMarker(prevMemory.importEnd) : null;
        const resumeIdx = sameChat && prevMemory.resumeAfter ? findMarker(prevMemory.resumeAfter) : null;
        const inRange = (i) => (i >= startIdx && (endIdx == null || i <= endIdx)) || (resumeIdx != null && i > resumeIdx);
        const newOnes = candidates.filter((c, i) => inRange(i) && !imported.some(h => sameFloor(c.m, h.tavern)));

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
        const timeOf = (m) => { const c = candidates.find(x => x.m === m); return c ? c.time : null; };

        let now = Date.now();
        let importedCount = 0;
        for (const { m, floor } of newOnes) {
            let text = m.mes;
            // 合并到已有楼层的小手机内容（<phone_chat>）去掉，只保留酒馆原本的内容
            if (m.extra && m.extra.from_uwu) text = text.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, '').trim();
            const cleaned = this.applyCleanRules(text, null);
            if (!cleaned) continue;
            const time = timeOf(m);
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
                    sendDate: m.send_date,
                    genStarted: String(m.gen_started || ''),
                    isUser: !!m.is_user,
                    name: m.is_user ? (char.myName || m.name || '我') : (char.realName || m.name || char.name),
                    summary: readBaibaiSummary(m),
                },
            });
            importedCount++;
        }

        // 2. 柏宝书的摘要通常比回复晚一步写好：把之前导入、当时还没有摘要（或摘要已更新）的楼层补上；
        //    旧版补丁导入的楼层没记时间，也顺便补上
        let summariesFilled = 0;
        for (const h of char.history.filter(x => x && x.fromTavern && x.tavern).slice(-200)) {
            const found = candidates.find(c => sameFloor(c.m, h.tavern));
            if (!found) continue;
            if (typeof h.tavern.time !== 'number' && found.time != null) h.tavern.time = found.time;
            // 酒馆里删了楼之后，后面的楼层号会往前挪，卡片上的“第几楼”跟着更新
            if (h.tavern.floor !== found.floor) h.tavern.floor = found.floor;
            if (h.tavern.genStarted === undefined) h.tavern.genStarted = String(found.m.gen_started || '');
            const summary = readBaibaiSummary(found.m);
            const oldText = h.tavern.summary && h.tavern.summary.text;
            if (summary && summary.text !== oldText) {
                h.tavern.summary = summary;
                if (h.tavern.trimmed) h.content = summary.text;   // 已精简的楼层，正文就是摘要，一起更新
                summariesFilled++;
            }
        }

        // 3. 按真实时间把酒馆楼层排进小手机聊天记录（包括以前导入时排错位置的）
        const reordered = this.placeTavernFloors(char);

        // 3.5 打开了“自动精简旧楼层”时：保留范围以外、已经有摘要的楼层只留摘要（原文随时能从酒馆取回）
        let autoTrimmed = 0;
        if (binding.autoTrim) {
            try { autoTrimmed = (await this.trimFloors(binding, { keepLast: this.keepRawFloorCount(binding) })).trimmed; }
            catch (e) { this.reportIssue('自动精简旧楼层失败：' + e.message); }
        }

        // 4. 打开了“自动更新复制过的世界书”时，把酒馆里改过的条目同步到小手机的世界书
        let worldUpdated = 0;
        if (binding.autoUpdateWorldBooks) {
            try { worldUpdated = (await this.syncCopiedWorldBooks(binding)).updated; }
            catch (e) { this.reportIssue("自动更新世界书失败：" + e.message); }
        }

        char.tavernMemory = {
            lastSync: Date.now(),
            stCharAvatar: binding.stCharAvatar,
            stChatFile: binding.stChatFile,
            lastImported: importedCount,
            importStart: start || null,
            importEnd: sameChat ? (prevMemory.importEnd || null) : null,
            resumeAfter: sameChat ? (prevMemory.resumeAfter || null) : null,
        };

        this.resolveIssues('pull');   // 这次同步成功了，之前“同步失败”的记录就不用留着了
        await saveData();
        // 正在看这个角色的聊天 → 重新画一遍，新卡片立刻出现
        if (importedCount > 0 || reordered || removedGone > 0) {
            if (typeof currentChatId !== 'undefined' && currentChatId === char.id && typeof renderMessages === 'function') {
                try { renderMessages(false, true); } catch (e) { /* 画不出来不影响数据 */ }
            }
            if (typeof renderChatList === 'function') {
                try { renderChatList(); } catch (e) { /* 画不出来不影响数据 */ }
            }
        }
        return { imported: importedCount, summariesFilled, reordered, worldUpdated, autoTrimmed, removedGone };
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
        const removed = (char.history || []).filter(m => m && m.fromTavern).length;
        char.history = (char.history || []).filter(m => !(m && m.fromTavern));
        char.tavernMemory = Object.assign({}, char.tavernMemory, {
            stCharAvatar: binding.stCharAvatar,
            stChatFile: binding.stChatFile,
            importStart,
            importEnd,
            resumeAfter: last ? last.marker : null,
        });
        await saveData();
        if (typeof currentChatId !== 'undefined' && currentChatId === char.id && typeof renderMessages === 'function') {
            try { renderMessages(false, true); } catch (e) { /* 画不出来不影响数据 */ }
        }
        return { removed };
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
    _pickFloors(char, opts = {}) {
        const floors = (char.history || []).filter(m => m && m.fromTavern && m.tavern);
        if (Array.isArray(opts.ids)) { const set = new Set(opts.ids); return floors.filter(m => set.has(m.id)); }
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
    async trimFloors(binding, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        let trimmed = 0, skipped = 0, saved = 0;
        const skippedFloors = [];
        for (const m of this._pickFloors(char, opts)) {
            if (m.tavern.trimmed) continue;
            if (!this.canTrim(m)) { skipped++; skippedFloors.push(m.tavern.floor); continue; }
            const before = (m.content || '').length;
            m.content = m.tavern.summary.text;
            m.parts = [];
            m.tavern.trimmed = true;
            saved += Math.max(0, before - m.content.length);
            trimmed++;
        }
        if (trimmed) { await saveData(); this._rerender(char); }
        return { trimmed, skipped, saved, skippedFloors };
    },

    // 取回原文：从酒馆重新读那一楼的正文。返回 { restored 取回几楼, missing 酒馆里找不到几楼 }
    async restoreRawFloors(binding, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const targets = this._pickFloors(char, opts).filter(m => m.tavern.trimmed);
        if (!targets.length) return { restored: 0, missing: 0 };
        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) throw new Error('读不到酒馆聊天');
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = raw.slice(offset);
        let restored = 0, missing = 0;
        for (const m of targets) {
            const found = list.find(x => x && typeof x.mes === 'string' && this._sameFloor(x, m.tavern));
            if (!found) { missing++; continue; }
            let text = found.mes;
            if (found.extra && found.extra.from_uwu) text = text.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, '').trim();
            const cleaned = this.applyCleanRules(text, null);
            if (!cleaned) { missing++; continue; }
            m.content = cleaned;
            m.parts = [];
            m.tavern.trimmed = false;
            restored++;
        }
        if (restored) { await saveData(); this._rerender(char); }
        return { restored, missing };
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

        // 这一楼里夹着的小手机推送内容先摘出来，写回时原样放回去
        const phoneBlocks = stMsg.mes.match(/<phone_chat>[\s\S]*?<\/phone_chat>/g) || [];
        const body = stMsg.mes.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, '').trim();
        if (this.applyCleanRules(body, null) !== body) {
            return { ok: false, reason: '这一楼导入时被清洗规则改过，写回会丢内容，酒馆保持原样' };
        }
        if (String(oldContent == null ? '' : oldContent).trim() !== body) {
            return { ok: false, reason: '酒馆里这一楼和小手机里的对不上（可能酒馆那边也改过），先同步一次再改' };
        }

        const newMes = phoneBlocks.length ? [newBody].concat(phoneBlocks).join('\n') : newBody;
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
        const imported = (char.history || []).filter(h => h && h.fromTavern && h.tavern);
        let filled = 0, stillNone = 0;
        for (const h of imported) {
            const found = list.find(x => x && typeof x.mes === 'string' && this._sameFloor(x, h.tavern));
            if (!found) continue;
            const summary = readBaibaiSummary(found);
            if (!summary || !summary.text) { if (!(h.tavern.summary && h.tavern.summary.text)) stillNone++; continue; }
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
    //   - 更早的：有柏宝书摘要的 AI 楼 → 套“摘要包裹”；user 楼若后面紧跟有摘要的 AI 楼 → 省掉（已包含在那段摘要里）
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
                const next = history.slice(i + 1).find(x => x && x.fromTavern);
                if (next && next.tavern && !next.tavern.isUser && next.tavern.summary && !rawSet.has(history.indexOf(next))) return;
                view = 'raw-nosummary'; content = fill(cfg.wrapRaw, m, m.content, '');
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
    async getPushState(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const { allUwuMsgs } = this._pushHelpers(char, binding);
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const pushed = new Set();
        (Array.isArray(stMsgs) ? stMsgs : []).forEach(m => {
            const ids = m && m.extra && m.extra.uwu_msg_ids;
            if (Array.isArray(ids)) ids.forEach(id => pushed.add(id));
        });
        let lastPushedIdx = -1;
        allUwuMsgs.forEach((m, i) => { if (pushed.has(m.id)) lastPushedIdx = i; });
        return { char, list: allUwuMsgs, pushed, lastPushedIdx, unpushed: allUwuMsgs.slice(lastPushedIdx + 1) };
    },

    // 把酒馆里的小手机消息删掉（yuan 版新增）：只删酒馆楼层里 <phone_chat> 的内容，
    // 不动小手机自己的聊天记录，也不动酒馆原有的剧情正文。ids 不给或为空表示删全部。
    async removePushedFromTavern(binding, ids) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const removeSet = ids && ids.length ? new Set(ids) : null;
        const { allUwuMsgs, toLine } = this._pushHelpers(char, binding);
        const byId = new Map(allUwuMsgs.map(m => [m.id, m]));
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];
        const ops = [];
        let removedCount = 0;
        for (let i = 0; i < all.length; i++) {
            const stMsg = all[i];
            const floorIds = stMsg && stMsg.extra && stMsg.extra.from_uwu && Array.isArray(stMsg.extra.uwu_msg_ids) ? stMsg.extra.uwu_msg_ids : null;
            if (!floorIds) continue;
            const surviving = removeSet ? floorIds.filter(id => !removeSet.has(id)) : [];
            if (surviving.length === floorIds.length) continue;
            removedCount += floorIds.length - surviving.length;
            const originalIds = [...floorIds];
            if (!surviving.length) {
                if (stMsg.extra.uwu_created) {
                    // 整楼都是小手机内容 → 整楼删掉
                    ops.push({ action: 'remove', originalUwuMsgIds: originalIds });
                    all.splice(i, 1); i--; continue;
                }
                // 合并在酒馆原有楼层里的 → 只去掉 <phone_chat> 部分
                stMsg.mes = (stMsg.mes || '').replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, '').trim();
                ops.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, clearUwuFlags: true });
                delete stMsg.extra.from_uwu; delete stMsg.extra.uwu_msg_ids; delete stMsg.extra.uwu_push_time;
                continue;
            }
            const lines = surviving.map(id => byId.get(id)).filter(Boolean).map(toLine).filter(l => l && l.trim());
            const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            if (stMsg.extra.uwu_created) stMsg.mes = phoneChat;
            else if ((stMsg.mes || '').includes('<phone_chat>')) stMsg.mes = stMsg.mes.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, phoneChat);
            stMsg.extra.uwu_msg_ids = surviving;
            ops.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, newUwuMsgIds: surviving });
        }
        if (!ops.length) return { removed: 0 };
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ deletions: ops }); } catch {}
        // 删掉的消息如果正是“上次推送到哪一条”，把追踪点清掉，免得下次推送从错的位置接着算
        if (!removeSet || removeSet.has(binding.lastPushedMsgId)) {
            binding.lastPushedMsgId = null;
            await this.saveConfig(this.getConfig());
        }
        return { removed: removedCount };
    },

    // 推送到酒馆（增量推送 + 删除同步）
    // trackProgress: 是否更新 lastPushedMsgId。手动推送传 false，让自动/聊天页推送不受影响，方便反悔
    // 推送用的公共部分（yuan 版把它从 pushToTavern 里抽出来，替换重新生成的回复时也要用）：
    //   allUwuMsgs：小手机里能推送到酒馆的消息
    //   toLine(消息)：把一条消息变成写进 <phone_chat> 的一行文字
    // 通话推送方式：'summary' 只推总结（默认）/ 'context' 只推记录 / 'both' 都推。
    // 兼容以前那个「通话连完整对话一起推」的开关（打开过的算“都推”）。
    callPushMode(binding) {
        const m = binding && binding.callPushMode;
        if (m === 'summary' || m === 'context' || m === 'both') return m;
        return (binding && binding.pushCallContext) ? 'both' : 'summary';
    },

    _pushHelpers(char, binding) {
        // 状态栏剥离：当用户关闭"推送状态栏到酒馆"时，按角色状态栏正则把内联状态栏抹掉，
        // 并过滤掉专门的状态更新楼层（isStatusUpdate）
        const includeStatusBar = this.getConfig().pushIncludeStatusBar !== false;
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
        const includeOnlineStatus = this.getConfig().pushIncludeOnlineStatus === true;
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
        );
        // 通话：yuan 把“打了多久 + 总结”存成一条普通消息（带 callRecordId），通话过程中的对话另存在 char.callHistory 里。
        // 绑定上的「通话推送」三选一（见 TavernSync.callPushMode）：
        //   summary 只推总结（默认）／ context 只推记录（通话里的每句对话，不带总结）／ both 都推
        // 哪种都会带上“打了多久”那一行。
        const callMode = this.callPushMode(binding);
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
            let base = this.applyCleanRules(stripOnlineStatus(stripThinking(stripStatusBar(m.content))), null);
            if (!base) return base;
            const rec = callRecordOf(m);
            if (!rec) return base;
            if (callMode === 'context') base = dropSummary(base, rec);
            if (callMode === 'context' || callMode === 'both') base += callLines(rec);
            return base;
        };
        return { allUwuMsgs, toLine };
    },

    // opts.messages：明确指定要推送哪些消息（聊天页的推送窗口让用户自己填范围时用），优先于 pushCount
    async pushToTavern(binding, pushCount, trackProgress = true, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const { allUwuMsgs, toLine } = this._pushHelpers(char, binding);
        // 构建 ID 集合，用于检测已删除的消息
        // binding.keptIds：被“重新生成”换掉的旧回复。它们在小手机里没了，但酒馆里的旧版本要保留，所以当作还在（yuan 版新增）
        const uwuMsgIDs = new Set([...allUwuMsgs.map(m => m.id), ...(Array.isArray(binding.keptIds) ? binding.keptIds : [])]);

        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        // === 删除同步：重建已有的 from_uwu 消息，移除已删除的行 ===
        let hadDeletions = false;
        const deletionOps = []; // 记录每次变更，供 ST 端无感注入
        for (let i = 0; i < all.length; i++) {
            const stMsg = all[i];
            if (!stMsg?.extra?.from_uwu || !Array.isArray(stMsg.extra.uwu_msg_ids)) continue;
            const originalIds = [...stMsg.extra.uwu_msg_ids]; // 捕获原始 ID，用于 ST 端定位
            const survivingIds = stMsg.extra.uwu_msg_ids.filter(id => uwuMsgIDs.has(id));
            if (survivingIds.length === stMsg.extra.uwu_msg_ids.length) continue; // 无变化
            hadDeletions = true;
            if (survivingIds.length === 0) {
                if (stMsg.extra.uwu_created) {
                    // 这条消息完全由 uwu 创建（新楼层模式），可以安全删除
                    deletionOps.push({ action: 'remove', originalUwuMsgIds: originalIds });
                    all.splice(i, 1); i--; continue;
                } else {
                    // 这条消息是合并到已有楼层的，只清除 uwu 追加的内容，保留原始消息
                    stMsg.mes = (stMsg.mes || '').replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, '').trim();
                    // clearUwuFlags=true 通知 ST 端清除 from_uwu 标记，使该条消息不再被追踪
                    deletionOps.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, clearUwuFlags: true });
                    delete stMsg.extra.from_uwu;
                    delete stMsg.extra.uwu_msg_ids;
                    delete stMsg.extra.uwu_push_time;
                    continue;
                }
            }
            // 用幸存消息重建内容
            const survivingMsgs = survivingIds.map(id => allUwuMsgs.find(m => m.id === id)).filter(Boolean);
            const lines = survivingMsgs.map(toLine);
            if (stMsg.extra.uwu_created) {
                // 纯 uwu 楼层：整体重建
                stMsg.mes = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            } else {
                // 合并楼层：替换 phone_chat 部分，保留原始内容
                const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
                if (stMsg.mes.includes('<phone_chat>')) {
                    stMsg.mes = stMsg.mes.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, phoneChat);
                }
            }
            // newUwuMsgIds 传给 ST 端，让注入 JS 同步更新内存中的 uwu_msg_ids，使下次删除仍可命中
            deletionOps.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, newUwuMsgIds: survivingIds });
            stMsg.extra.uwu_msg_ids = survivingIds;
        }

        // === 增量推送：找出上次推送之后的新消息 ===
        // 手动推送（pushCount 明确传入）时，直接取最后 N 条，忽略增量追踪
        // pushCount === 0 表示仅同步删除，不推送新消息
        let newMsgs;
        if (Array.isArray(opts.messages)) {
            const wanted = new Set(opts.messages.map(m => m.id));
            newMsgs = allUwuMsgs.filter(m => wanted.has(m.id));
        } else if (pushCount === 0) {
            newMsgs = [];
        } else if (pushCount) {
            newMsgs = allUwuMsgs.slice(-pushCount);
        } else if (binding.lastPushedMsgId) {
            const lastIdx = allUwuMsgs.findIndex(m => m.id === binding.lastPushedMsgId);
            if (lastIdx >= 0) {
                newMsgs = allUwuMsgs.slice(lastIdx + 1);
            } else {
                const count = this.getConfig().maxInjectMessages || 50;
                newMsgs = allUwuMsgs.slice(-count);
            }
        } else {
            const count = this.getConfig().maxInjectMessages || 50;
            newMsgs = allUwuMsgs.slice(-count);
        }
        // “重新生成”出来的回复（skipTavernPush）不自动推送，酒馆里保留原来的版本；想换可以去酒馆手动改。
        // 手动“推送最近 N 条”（pushCount）时照样包含，由用户自己决定。
        if (!pushCount && !opts.messages) newMsgs = newMsgs.filter(m => !m.skipTavernPush);

        let newMsg = null;
        let pushLines = [];
        if (newMsgs.length > 0) {
            pushLines = newMsgs.map(toLine).filter(l => l && l.trim());
            // 如果新消息经过状态栏剥离后全部为空，则视为无新消息（deletionOps 仍会处理）
            if (pushLines.length === 0) { newMsgs = []; }
        }
        if (newMsgs.length > 0) {
            const lines = pushLines;
            const mergedContent = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            const pushMode = this.getConfig().pushMode || 'new';
            const lastMsg = all.length > 0 ? all[all.length - 1] : null;
            const lastIsUwu = lastMsg?.extra?.from_uwu;

            // 决定是否合并到已有楼层：
            // 1. 最后一楼是 from_uwu 且同侧（都是 user 侧）→ 合并（用户只是切了酒馆又回来）
            //    若是旧数据里的 AI 侧 from_uwu，不合并，新开 user 楼层保持干净
            // 2. 追加模式 → 合并到最后一楼（不管是谁的），配合正则隐藏实现视觉无新楼
            const lastIsUserSide = lastMsg?.is_user === true;
            if ((lastIsUwu && lastIsUserSide) || (pushMode === 'append' && lastMsg)) {
                const target = lastMsg;
                const existingContent = target.mes || '';
                const closingTag = '</phone_chat>';
                if (existingContent.includes(closingTag)) {
                    target.mes = existingContent.replace(closingTag, lines.join('\n') + '\n' + closingTag);
                } else {
                    target.mes = existingContent + '\n' + mergedContent;
                }
                if (!target.extra) target.extra = {};
                target.extra.from_uwu = true;
                target.extra.uwu_msg_ids = [...(target.extra.uwu_msg_ids || []), ...newMsgs.map(m => m.id)];
                target.extra.uwu_push_time = Date.now();
                // 合并模式：传递完整的更新后消息，标记 __mergeMode 供前端无感替换
                newMsg = Object.assign({}, target, { __mergeMode: true, avatar: binding.stCharAvatar });
            } else {
                // 新楼层模式（默认）：推送为 user 侧消息，方便用正则只剥离 AI 输出的 phone_chat
                const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
                const savedMsg = {
                    name: char.myName || 'User',
                    is_user: true, is_system: false,
                    send_date: new Date().toISOString(),
                    mes: mergedContent,
                    // st_char_name 让原生注入脚本能把 user 侧消息路由到绑定的酒馆角色（否则按 name/avatar 匹配会失败）
                    extra: { from_uwu: true, uwu_created: true, uwu_push_time: Date.now(), uwu_msg_ids: newMsgs.map(m => m.id), st_char_name: stCharName },
                };
                all.push(savedMsg);
                // 注入载荷额外附带 avatar，命中 Swift 匹配器的 cur.avatar === msg.avatar 分支
                newMsg = Object.assign({}, savedMsg, { avatar: binding.stCharAvatar });
            }
        }

        // 有新消息或有删除才保存
        if (newMsgs.length > 0 || hadDeletions) {
            await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        }

        // 更新推送追踪（只有真正推送了新消息才更新基准点）
        // 删除同步不能改变 lastPushedMsgId，否则下次推送会跳过中间的 user 消息
        // trackProgress=false 时（手动推送）也不改基准点，留出反悔余地
        if (trackProgress && opts.messages && newMsgs.length > 0) {
            // 指定了范围：追踪点记到这批消息的最后一条
            binding.lastPushedMsgId = newMsgs[newMsgs.length - 1].id;
            await this.saveConfig(this.getConfig());
        } else if (trackProgress && newMsgs.length > 0 && allUwuMsgs.length > 0) {
            binding.lastPushedMsgId = allUwuMsgs[allUwuMsgs.length - 1].id;
            await this.saveConfig(this.getConfig());
        }

        this.resolveIssues('push');   // 这次推送成功了，之前“推送失败”的记录就不用留着了
        return { pushed: newMsgs.length, deleted: hadDeletions, message: newMsg, deletionOps };
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
        const { allUwuMsgs, toLine } = this._pushHelpers(char, binding);
        const byId = new Map(allUwuMsgs.map(m => [m.id, m]));

        const ops = [];
        let inserted = false;   // 新回复只放进第一处出现旧回复的地方
        for (const stMsg of all) {
            const ids = stMsg && stMsg.extra && stMsg.extra.from_uwu && Array.isArray(stMsg.extra.uwu_msg_ids) ? stMsg.extra.uwu_msg_ids : null;
            if (!ids || !ids.some(id => oldSet.has(id))) continue;
            const originalIds = [...ids];
            const nextIds = [];
            for (const id of ids) {
                if (!oldSet.has(id)) { nextIds.push(id); continue; }
                if (!inserted) { nextIds.push(...newIds); inserted = true; }
            }
            // 用新的编号列表重建这一楼的 <phone_chat>；已经不在小手机里的消息（比如之前删掉的）照旧去掉
            const lines = nextIds.map(id => byId.get(id)).filter(Boolean).map(toLine).filter(l => l && l.trim());
            const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
            if (stMsg.extra.uwu_created) stMsg.mes = phoneChat;
            else if ((stMsg.mes || '').includes('<phone_chat>')) stMsg.mes = stMsg.mes.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, phoneChat);
            stMsg.extra.uwu_msg_ids = nextIds;
            ops.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, newUwuMsgIds: nextIds });
        }
        // 酒馆里没有旧回复（从没推送过）：找到酒馆里记着“这轮之前最后一条小手机消息”的那一楼，把新回复接在它后面。
        // 不能按平常推送——那样会作为新楼层排在酒馆最后面，跑到之后的酒馆剧情后面去
        if (!ops.length) {
            const firstNewIdx = allUwuMsgs.findIndex(m => m.id === newIds[0]);
            const earlier = (firstNewIdx >= 0 ? allUwuMsgs.slice(0, firstNewIdx) : []).reverse();
            for (const prev of earlier) {
                const stMsg = all.find(x => x && x.extra && x.extra.from_uwu && Array.isArray(x.extra.uwu_msg_ids) && x.extra.uwu_msg_ids.includes(prev.id));
                if (!stMsg) continue;
                const originalIds = [...stMsg.extra.uwu_msg_ids];
                const nextIds = [...originalIds];
                nextIds.splice(nextIds.indexOf(prev.id) + 1, 0, ...newIds.filter(id => !nextIds.includes(id)));
                const lines = nextIds.map(id => byId.get(id)).filter(Boolean).map(toLine).filter(l => l && l.trim());
                const phoneChat = `<phone_chat>\n${lines.join('\n')}\n</phone_chat>`;
                if (stMsg.extra.uwu_created) stMsg.mes = phoneChat;
                else if ((stMsg.mes || '').includes('<phone_chat>')) stMsg.mes = stMsg.mes.replace(/<phone_chat>[\s\S]*?<\/phone_chat>/g, phoneChat);
                stMsg.extra.uwu_msg_ids = nextIds;
                ops.push({ action: 'update', originalUwuMsgIds: originalIds, mes: stMsg.mes, newUwuMsgIds: nextIds });
                break;
            }
        }
        if (!ops.length) return { replaced: false };
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ deletions: ops }); } catch {}
        return { replaced: true };
    },

    // 把 lastPushedMsgId 之后的所有未推送消息浓缩成一条总结（用专用总结 API，没配就 fallback 主 API）
    // 通用总结：根据 mode 决定切片
    //   mode='unpushed' (默认)：自上次推送之后的所有消息（半自动 / 聊天页用）
    //   mode='lastN' + count：取最近 N 条（手动 / 绑定卡用，不限是否已推送）
    async summarizeUnpushedSlice(binding, opts) {
        const options = opts || {};
        const mode = options.mode || 'unpushed';
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');

        const allUwuMsgs = char.history.filter(m => !m.fromTavern && m.content?.trim() && !m.isThinking && !m.isContextDisabled);
        let unpushed;
        if (mode === 'list' && Array.isArray(options.messages)) {
            // 用户在推送窗口里自己填了范围
            const wanted = new Set(options.messages.map(m => m.id));
            unpushed = allUwuMsgs.filter(m => wanted.has(m.id));
        } else if (mode === 'lastN') {
            const n = Math.max(1, Math.min(options.count || 1, allUwuMsgs.length));
            unpushed = allUwuMsgs.slice(-n);
        } else if (binding.lastPushedMsgId) {
            const idx = allUwuMsgs.findIndex(m => m.id === binding.lastPushedMsgId);
            unpushed = idx >= 0 ? allUwuMsgs.slice(idx + 1) : allUwuMsgs;
        } else {
            unpushed = allUwuMsgs;
        }
        if (mode !== 'lastN' && mode !== 'list') unpushed = unpushed.filter(m => !m.skipTavernPush);   // 重新生成出来的回复不推送
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
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const text = (summaryText || '').trim();
        if (!text) throw new Error('总结内容为空');

        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        const myName = char.myName || '我';
        const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
        const mergedContent = `<phone_chat>\n[小总结：${text}]\n</phone_chat>`;

        const savedMsg = {
            name: myName,
            is_user: true, is_system: false,
            send_date: new Date().toISOString(),
            mes: mergedContent,
            extra: { from_uwu: true, uwu_created: true, uwu_summary: true, uwu_push_time: Date.now(), uwu_msg_ids: coveredMsgIds || [], st_char_name: stCharName },
        };
        all.push(savedMsg);
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });

        // 总结代表了那段消息，推进追踪点（与原始批量推送行为一致）
        if (lastCoveredMsgId) {
            binding.lastPushedMsgId = lastCoveredMsgId;
            await this.saveConfig(this.getConfig());
        }

        const injectMsg = Object.assign({}, savedMsg, { avatar: binding.stCharAvatar });
        try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: injectMsg }); } catch {}
        return { pushed: 1, message: injectMsg };
    },

    // 推送通话记录到酒馆（独立于 char.history 的增量追踪，不影响 lastPushedMsgId）
    async pushCallRecordToTavern(binding, callRecord) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        if (!callRecord || !Array.isArray(callRecord.context) || callRecord.context.length === 0) {
            throw new Error('通话记录为空');
        }

        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const all = Array.isArray(stMsgs) ? [...stMsgs] : [];

        const charName = char.realName || char.name || '对方';
        const myName = char.myName || '我';
        const typeLabel = callRecord.type === 'video' ? '视频通话' : '语音通话';

        // 头部时间行：优先用通话记录里锁定的 timeStr（story 模式下是 storyNow + duration 算出的剧情结束时间）；
        // 否则按旧逻辑兜底。story 模式找不到剧情时间就不写时间，避免真实时间污染
        const isStoryMode = (char.timeMode || 'real') === 'story';
        let timeStr = '';
        if (callRecord.timeStr) {
            timeStr = callRecord.timeStr;
        } else if (isStoryMode) {
            const storyNow = (typeof window !== 'undefined' && typeof window.getCharStoryNow === 'function') ? window.getCharStoryNow(char) : null;
            if (storyNow && storyNow.ms) {
                const endMs = storyNow.ms + (Number(callRecord.duration) || 0) * 1000;
                const d = new Date(endMs);
                timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            }
        } else {
            const startDate = new Date(callRecord.startTime || Date.now());
            timeStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')} ${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}`;
        }
        const durationStr = (() => {
            const s = Number(callRecord.duration || 0);
            return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
        })();

        const headerParts = [typeLabel];
        if (timeStr) headerParts.push(timeStr);
        headerParts.push(`时长 ${durationStr}`);
        const lines = [`[${headerParts.join(' · ')}]`];
        callRecord.context.forEach(m => {
            const who = m.role === 'user' ? myName : charName;
            const kind = m.type === 'visual' ? '的画面' : '的声音';
            const raw = (m.content || '').trim();
            if (!raw) return;
            lines.push(`[${who}${kind}：${raw}]`);
        });
        if (callRecord.summary && callRecord.summary.trim()) {
            lines.push(`[通话总结：${callRecord.summary.trim()}]`);
        }

        const mergedContent = `<phone_call>\n${lines.join('\n')}\n</phone_call>`;
        const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
        const savedMsg = {
            name: myName,
            is_user: true, is_system: false,
            send_date: new Date().toISOString(),
            mes: mergedContent,
            extra: { from_uwu: true, uwu_created: true, uwu_push_time: Date.now(), uwu_call_id: callRecord.id, st_char_name: stCharName },
        };
        all.push(savedMsg);
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });

        const injectMsg = Object.assign({}, savedMsg, { avatar: binding.stCharAvatar });
        try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: injectMsg }); } catch {}

        return { pushed: 1, lineCount: lines.length - 1, message: injectMsg };
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
            if (r.deletionOps && r.deletionOps.length > 0) {
                console.log('[TavernSync] Deletion sync: injecting into ST');
                try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ deletions: r.deletionOps }); } catch {}
            }
        } catch (e) { this.reportIssue('删除同步到酒馆失败：' + e.message, 'push'); }
    },

    // 自动推送（AI 回复后调用）
    async autoPushIfNeeded(charId) {
        const cfg = this.getConfig();
        if (!cfg.enabled) return;
        const binding = this.findBindingForChar(charId);
        if (!binding || !this.isAuto(binding, 'autoPush')) return;
        try {
            const r = await this.pushToTavern(binding);
            if (r.pushed > 0 || r.deleted) {
                console.log(`[TavernSync] Auto-push: ${r.pushed} new, deleted=${r.deleted}`);
                try {
                    var payload = r.message ? { message: r.message } : { reload: true };
                    window.webkit?.messageHandlers?.tavernPushDone?.postMessage(payload);
                } catch {}
            }
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
                        if (r.deleted) {
                            console.log('[TavernSync] Return-sync: delete synced to ST');
                            try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                        }
                    }).catch(e => this.reportIssue('切回小手机时同步删除失败：' + e.message, 'push'));
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

    // 自动更新复制过的世界书条目（绑定卡片上的开关打开时，每次从酒馆同步时调用）
    async syncCopiedWorldBooks(binding) {
        const linked = (db.worldBooks || []).filter(w => w && w.tavernSource && w.tavernSource.avatar === binding.stCharAvatar);
        if (!linked.length) return { updated: 0 };
        const worldBooks = await this.getCharAndChatWorldBooks(binding);
        const sources = [worldBooks.charWorld, worldBooks.chatWorld].filter(Boolean);
        let updated = 0;
        for (const w of linked) {
            const src = sources.find(s => s.name === w.tavernSource.world);
            if (!src) continue;
            const entry = src.entries.find(e => e.uid === w.tavernSource.uid);
            if (!entry) continue;                       // 酒馆里删掉了 → 小手机这条保留，不动
            const hash = this.wbHash(entry);
            if (hash === w.tavernSource.hash) continue;
            this.applyTavernEntry(w, entry, src.entries.indexOf(entry), false);
            w.tavernSource.hash = hash;
            w.tavernSource.order = entry.order;
            updated++;
        }
        return { updated };
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
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:320px;';
        box.innerHTML = `
            <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">${esc(title)}</h3>
            <input id="ask-input" type="text" placeholder="${esc(placeholder || '')}" style="width:100%; box-sizing:border-box; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; margin-bottom:14px;">
            <div style="display:flex; gap:10px;">
                <button id="ask-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
                <button id="ask-ok" style="flex:1; padding:10px; border-radius:10px; border:none; background:var(--primary-color, #cee4f1); color:var(--white-color, #2a3032); font-size:14px; font-weight:500; cursor:pointer;">确定</button>
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

// ========== UI 样式常量 ==========
const TS = {
    card: 'background:var(--received-bg, rgba(255,255,255,0.08)); border-radius:14px; padding:16px; margin-bottom:12px;',
    label: 'font-size:13px; color:#999; display:block; margin-bottom:4px;',
    input: 'width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; box-sizing:border-box;',
    btnP: 'padding:10px; border-radius:10px; border:none; background:var(--primary-color, #cee4f1); color:var(--white-color, #2a3032); font-size:14px; font-weight:500; cursor:pointer;',
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
                            style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;">`;
    const tplArea = (id, rows) => `<textarea id="${id}" rows="${rows}" spellcheck="false"
                        style="width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.2); color:inherit; font-size:12px; line-height:1.5; resize:vertical;"></textarea>`;
    const smallBtn = 'padding:4px 10px; border-radius:6px; border:none; background:rgba(255,255,255,0.1); color:inherit; font-size:12px; cursor:pointer;';

    mainEl.innerHTML = `
        <div style="padding:4px 0;">
            <div id="ts-issues-area" style="display:none; margin-bottom:12px;"></div>
            <div style="${TS.card}">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                    <span style="${TS.title}">SillyTavern 连接</span>
                    <span id="ts-status" style="font-size:12px; color:#999;">检测中...</span>
                </div>
                <div id="ts-login-area"></div>
            </div>
            <div id="ts-bindings-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <span style="${TS.title}">角色绑定</span>
                        <button id="ts-add-btn" style="padding:6px 14px; border-radius:8px; border:none; background:var(--primary-color, #cee4f1); color:var(--white-color, #2a3032); font-size:13px; cursor:pointer;">+ 添加</button>
                    </div>
                    <div id="ts-bindings-list"></div>
                </div>
            </div>
            <div id="ts-rules-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <span style="${TS.title}">正则清洗规则</span>
                        <button id="ts-add-rule-btn" style="${smallBtn}">+ 添加规则</button>
                    </div>
                    <div style="font-size:12px; color:#888; margin-bottom:10px;">从酒馆导入楼层时按顺序处理文字，推送到酒馆时也会用。提取=只保留匹配内容，排除=删除匹配内容。</div>
                    <div id="ts-rules-list"></div>
                </div>
            </div>
            <div id="ts-settings-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <span style="${TS.title}">同步设置</span>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px; flex:1;">第一次同步导入楼数</span>
                        ${numInput('ts-initial-count', config.initialImportCount)}
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:4px;">某个角色第一次同步时，从酒馆导入最近多少楼。之后每次同步只导入新楼层</div>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px; flex:1;">最近几楼发原文</span>
                        ${numInput('ts-raw-count', config.rawFloorCount)}
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:4px;">发给 AI 时，最近这么多楼酒馆剧情给完整原文，更早的换成柏宝书摘要（还没有摘要的暂时发原文）</div>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px; flex:1;">手动推送时默认条数</span>
                        ${numInput('ts-max', config.maxInjectMessages || 50)}
                    </div>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-inject-user-floors" ${config.injectUserFloors !== false ? 'checked' : ''}>
                        <div>
                            <div>发给 AI 时包含酒馆 user 楼层</div>
                            <div style="font-size:11px; color:#888;">关闭后，酒馆里你自己写的楼层不发给 AI（小手机里照样显示），节省 token</div>
                        </div>
                    </label>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-push-status-bar" ${config.pushIncludeStatusBar !== false ? 'checked' : ''}>
                        <div>
                            <div>推送状态栏到酒馆</div>
                            <div style="font-size:11px; color:#888;">关闭后，推送到酒馆的小手机消息将按角色状态栏正则剥离内联状态栏，并过滤专用状态更新楼层</div>
                        </div>
                    </label>
                    <label style="display:flex; align-items:center; gap:10px; margin-top:12px; font-size:14px; cursor:pointer;">
                        <input type="checkbox" id="ts-push-online-status" ${config.pushIncludeOnlineStatus === true ? 'checked' : ''}>
                        <div>
                            <div>推送在线状态到酒馆</div>
                            <div style="font-size:11px; color:#888;">在线状态是 AI 写的“[角色更新状态为：…]”，用来改小手机界面上那行状态文字。默认不推到酒馆</div>
                        </div>
                    </label>
                </div>
                <div style="${TS.card} margin-top:12px;">
                    <div style="display:flex; align-items:center; justify-content:space-between;">
                        <span style="${TS.title}">线下剧情包裹提示词</span>
                        <button id="ts-wrap-reset" style="${smallBtn}">恢复默认</button>
                    </div>
                    <div style="font-size:12px; color:#888; margin:6px 0 10px; line-height:1.55;">
                        酒馆楼层发给 AI 时套用的格式。可用变量：<span style="color:#ffb380;">{{楼层}} {{发言人}} {{内容}} {{时间}}</span>（时间来自柏宝书）。改完点输入框外面即保存。
                    </div>
                    <div style="font-size:13px; margin-bottom:4px;">说明（放在系统提示词里，可用 {{用户}}；留空则不加）</div>
                    ${tplArea('ts-wrap-note', 4)}
                    <div style="font-size:13px; margin:10px 0 4px;">原文包裹（最近几楼）</div>
                    ${tplArea('ts-wrap-raw', 3)}
                    <div style="font-size:13px; margin:10px 0 4px;">摘要包裹（更早的楼层）</div>
                    ${tplArea('ts-wrap-summary', 3)}
                </div>
                <div style="${TS.card} margin-top:12px;">
                    <span style="${TS.title}">推送设置</span>
                    <div style="font-size:12px; color:#888; margin-top:6px;">自动同步、自动推送的开关在上面每个角色的绑定卡片里，可以分别设置</div>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px;">推送楼层模式</span>
                        <select id="ts-push-mode" style="padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px;">
                            <option value="new" ${(config.pushMode || 'new') === 'new' ? 'selected' : ''}>新开楼层</option>
                            <option value="append" ${config.pushMode === 'append' ? 'selected' : ''}>合并到最后一楼</option>
                        </select>
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:4px;">新开楼层：每次推送创建新消息；合并末尾：追加到最后一楼末尾（配合正则隐藏）。注：若最后一楼已是小手机消息，无论模式都会自动合并</div>
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
            ${list.slice().reverse().map(it => `<div style="font-size:12px; line-height:1.6; padding:6px 0; border-top:1px solid rgba(255,255,255,0.08); word-break:break-word;"><span style="color:#888;">${new Date(it.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${it.count > 1 ? ` ×${it.count}` : ''}</span> <span style="white-space:pre-wrap;">${escAttr(it.text)}</span></div>`).join('')}
            </div>
        </div>`;
        issuesArea.querySelector('#ts-issues-clear').addEventListener('click', () => { TavernSync.clearIssues(); renderIssues(); });
    }
    renderIssues();

    const saveNum = (id, key, fallback) => mainEl.querySelector(id).addEventListener('change', async (e) => {
        const n = parseInt(e.target.value, 10);
        const cfg = TavernSync.getConfig();
        cfg[key] = Number.isInteger(n) && n >= 0 ? n : fallback;
        e.target.value = cfg[key];
        await TavernSync.saveConfig(cfg);
    });
    saveNum('#ts-initial-count', 'initialImportCount', 20);
    saveNum('#ts-raw-count', 'rawFloorCount', 3);
    saveNum('#ts-max', 'maxInjectMessages', 50);
    mainEl.querySelector('#ts-push-status-bar').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.pushIncludeStatusBar = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-push-online-status').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.pushIncludeOnlineStatus = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-inject-user-floors').addEventListener('change', async (e) => { const cfg = TavernSync.getConfig(); cfg.injectUserFloors = e.target.checked; await TavernSync.saveConfig(cfg); });
    mainEl.querySelector('#ts-push-mode').addEventListener('change', async (e) => {
        const cfg = TavernSync.getConfig(); cfg.pushMode = e.target.value; await TavernSync.saveConfig(cfg);
    });
    mainEl.querySelector('#ts-add-btn').addEventListener('click', () => showBindingEditor(() => renderBindings()));
    mainEl.querySelector('#ts-add-rule-btn').addEventListener('click', () => showRuleEditor(null, () => renderRules()));

    // 线下剧情包裹提示词（用 JS 赋值，避免 HTML 转义把 {{ }} 或尖括号弄乱）
    const wrapFields = [
        ['#ts-wrap-note', 'wrapNote', TavernSync.DEFAULT_WRAP_NOTE],
        ['#ts-wrap-raw', 'wrapRaw', TavernSync.DEFAULT_WRAP_RAW],
        ['#ts-wrap-summary', 'wrapSummary', TavernSync.DEFAULT_WRAP_SUMMARY],
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
    mainEl.querySelector('#ts-wrap-reset').addEventListener('click', async () => {
        if (!confirm('把三段包裹提示词恢复成默认内容？')) return;
        const cfg = TavernSync.getConfig();
        wrapFields.forEach(([sel, key, def]) => { cfg[key] = def; mainEl.querySelector(sel).value = def; });
        await TavernSync.saveConfig(cfg);
        showToast('已恢复默认');
    });

    // ===== 连接逻辑 =====
    function showConnected(charCount) {
        statusEl.innerHTML = `<span style="color:#4CAF50;">已连接（${charCount} 个角色）</span> <button id="ts-reconnect-btn" style="background:none; border:none; color:#999; font-size:14px; cursor:pointer; padding:2px 4px; vertical-align:middle;" title="重新连接">↻</button>`;
        statusEl.querySelector('#ts-reconnect-btn').addEventListener('click', checkAndLogin);
        loginArea.innerHTML = '';
        bindingsArea.style.display = 'block'; rulesArea.style.display = 'block'; settingsArea.style.display = 'block';
        renderBindings(); renderRules();
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
            loginArea.innerHTML = `<div style="font-size:13px; color:#999; margin-bottom:8px;">选择酒馆账户</div>
                ${users.map(u => `<button class="ts-user-btn" data-handle="${u.handle}" data-pwd="${u.password}"
                    style="display:flex; align-items:center; gap:10px; width:100%; padding:12px; border-radius:10px; border:none; background:rgba(255,255,255,0.06); color:inherit; font-size:14px; cursor:pointer; margin-bottom:8px; text-align:left;">
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
        statusEl.textContent = '连接中...'; statusEl.style.color = '#999'; loginArea.innerHTML = '';
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
            <div style="display:flex; align-items:center; gap:8px; padding:8px; background:rgba(255,255,255,0.04); border-radius:8px; margin-bottom:6px;">
                <input type="checkbox" data-toggle="${i}" ${r.enabled ? 'checked' : ''} style="flex-shrink:0;">
                <div style="flex:1; min-width:0; cursor:pointer;" data-edit="${i}">
                    <div style="font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.name || '未命名')}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.mode === 'extract' ? '提取' : '排除'} /${esc(r.regex)}/${r.minDepth != null || r.maxDepth != null ? ` 深度${r.minDepth ?? 0}~${r.maxDepth ?? '∞'}` : ''}</div>
                </div>
                <button data-delrule="${i}" style="${TS.btnD} font-size:14px;">✕</button>
            </div>`).join('');
        rulesList.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('change', async () => { const cfg = TavernSync.getConfig(); cfg.cleanRules[parseInt(cb.dataset.toggle)].enabled = cb.checked; await TavernSync.saveConfig(cfg); }));
        rulesList.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => showRuleEditor(parseInt(el.dataset.edit), () => renderRules())));
        rulesList.querySelectorAll('[data-delrule]').forEach(btn => btn.addEventListener('click', async () => { const cfg = TavernSync.getConfig(); cfg.cleanRules.splice(parseInt(btn.dataset.delrule), 1); await TavernSync.saveConfig(cfg); renderRules(); }));
    }

    // ===== 绑定列表 =====
    function renderBindings() {
        const cfg = TavernSync.getConfig();
        if (!cfg.bindings?.length) { bindingsList.innerHTML = '<div style="text-align:center; color:#999; font-size:13px; padding:20px;">暂无绑定，点击上方「+ 添加」关联角色</div>'; return; }
        bindingsList.innerHTML = cfg.bindings.map((b, i) => {
            const char = db.characters.find(c => c.id === b.uwuCharId);
            const charName = char ? (char.remarkName || char.name) : '未知';
            const stName = b.stCharAvatar?.replace('.png', '') || '未知';
            const mem = char?.tavernMemory;
            const tavernMsgs = char && Array.isArray(char.history) ? char.history.filter(h => h && h.fromTavern) : [];
            const floorCount = tavernMsgs.length;
            // 占多少字：楼层原文 + 摘要都算，给维护者判断什么时候该清理
            const tavernChars = tavernMsgs.reduce((n, m) => n + (m.content ? m.content.length : 0)
                + (m.tavern && !m.tavern.trimmed && m.tavern.summary && m.tavern.summary.text ? m.tavern.summary.text.length : 0), 0);
            const trimmedCount = tavernMsgs.filter(m => m.tavern && m.tavern.trimmed).length;
            const callMode = TavernSync.callPushMode(b);
            const sizeText = tavernChars >= 10000 ? `约 ${(tavernChars / 10000).toFixed(1)} 万字` : `约 ${tavernChars} 字`;
            // 时间写成“9月20日 10:30”，比 9/20 好认
            const fmtSync = (ts) => {
                const d = new Date(ts);
                return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            };
            const trimText = trimmedCount ? `，其中 ${trimmedCount} 楼已精简` : '';
            const syncInfo = mem && mem.lastSync ? `小手机里有 ${floorCount} 楼酒馆剧情（${sizeText}${trimText}）<br>上次同步 ${fmtSync(mem.lastSync)}` : '未同步';
            const maxMem = parseInt(char && char.maxMemory, 10) || 20;   // 这个角色在聊天设置里的“可见上文条数”
            return `<div style="${TS.card} padding:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div><div style="font-size:14px; font-weight:600;">${esc(charName)} ↔ ${esc(stName)}</div>
                        <div style="font-size:11px; color:#888; margin-top:2px;">${syncInfo}</div></div>
                    <button data-del="${i}" style="${TS.btnD}">✕</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button data-pull="${i}" style="flex:1; ${TS.btnB}">同步酒馆剧情</button>
                    <button data-push="${i}" style="flex:1; ${TS.btnO}">推送/清理消息</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-import-char="${i}" style="flex:1; ${TS.btnB}">导入酒馆人设</button>
                    <button data-import-wb="${i}" style="flex:1; ${TS.btnB}">导入酒馆世界书</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-fillsum="${i}" style="flex:1; ${TS.btnG}">只补摘要</button>
                    <button data-trim="${i}" style="flex:1; ${TS.btnG}">精简旧楼层</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-preview="${i}" style="flex:1; padding:8px; border-radius:8px; border:none; background:rgba(156,39,176,0.15); color:#CE93D8; font-size:13px; font-weight:500; cursor:pointer;">提示词预览</button>
                    <button data-reset="${i}" style="flex:1; padding:8px; border-radius:8px; border:none; background:rgba(244,67,54,0.12); color:#f66; font-size:13px; font-weight:500; cursor:pointer;">清空并重选范围</button></div>
                <label style="display:flex; align-items:center; gap:8px; margin-top:10px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" data-auto="autoPull" data-idx="${i}" ${TavernSync.isAuto(b, 'autoPull') ? 'checked' : ''}>
                    <span>自动同步<span style="font-size:11px; color:#888;">（打开这个角色的聊天、或从酒馆切回小手机时，自动导入新楼层）</span></span>
                </label>
                <label style="display:flex; align-items:center; gap:8px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" data-auto="autoPush" data-idx="${i}" ${TavernSync.isAuto(b, 'autoPush') ? 'checked' : ''}>
                    <span>自动推送<span style="font-size:11px; color:#888;">（AI 回复后把新消息推到酒馆；在小手机删消息时同步删酒馆里的）</span></span>
                </label>
                <div style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:13px; flex-wrap:wrap;">
                    <span>通话推送</span>
                    <select data-callmode="${i}" style="flex:1; min-width:120px; padding:5px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:13px;">
                        <option value="summary" ${callMode === 'summary' ? 'selected' : ''}>只推总结</option>
                        <option value="context" ${callMode === 'context' ? 'selected' : ''}>只推记录</option>
                        <option value="both" ${callMode === 'both' ? 'selected' : ''}>都推送</option>
                    </select>
                    <span style="font-size:11px; color:#888; width:100%;">总结 = yuan 自动写的那段通话总结；记录 = 通话过程中的每一句话。哪种都会带上“打了多久”</span>
                </div>
                <label style="display:flex; align-items:center; gap:8px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" data-wbauto="${i}" ${b.autoUpdateWorldBooks ? 'checked' : ''}>
                    <span>自动更新复制过的世界书<span style="font-size:11px; color:#888;">（从酒馆同步时，把酒馆里改过的条目更新到小手机的世界书）</span></span>
                </label>
                <label style="display:flex; align-items:center; gap:8px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" data-trimauto="${i}" ${b.autoTrim ? 'checked' : ''}>
                    <span>自动精简旧楼层<span style="font-size:11px; color:#888;">（每次同步时，把保留范围以外、已经有摘要的楼层只留摘要；原文随时能从酒馆取回）</span></span>
                </label>
                <div style="display:${b.autoTrim ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 24px; font-size:13px; flex-wrap:wrap;">
                    保留最近
                    <input type="number" data-trim-num="${i}" min="${cfg.rawFloorCount}" value="${TavernSync.keepRawFloorCount(b)}"
                        style="width:64px; padding:4px 6px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:13px; text-align:center;"> 楼的原文
                    <span style="font-size:11px; color:#888; width:100%;">更早的楼层只留柏宝书摘要。不能少于“最近几楼发原文”（现在是 ${cfg.rawFloorCount} 楼）</span>
                </div>
                <label style="display:flex; align-items:center; gap:8px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <input type="checkbox" data-limit="${i}" ${b.limitTavernContext ? 'checked' : ''}>
                    <span>单独限制酒馆上文<span style="font-size:11px; color:#888;">（关闭时按聊天设置里的可见上文条数，酒馆和小手机消息一起算）</span></span>
                </label>
                <div style="display:${b.limitTavernContext ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 24px; font-size:13px; flex-wrap:wrap;">
                    发给 AI 的酒馆剧情最多
                    <input type="number" data-limit-num="${i}" min="0" max="${maxMem}" value="${Math.min(maxMem, parseInt(b.tavernContextCount, 10) || 0)}"
                        style="width:64px; padding:4px 6px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:13px; text-align:center;"> 楼
                    <span style="font-size:11px; color:#888; width:100%;">这个角色的可见上文是 ${maxMem} 条：取最新的这么多楼酒馆剧情，剩下的名额给小手机消息</span>
                </div>
            </div>`;
        }).join('');

        // 单独限制酒馆上文：开关 + 楼数（不能超过这个角色的可见上文条数）
        bindingsList.querySelectorAll('[data-callmode]').forEach(sel => sel.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(sel.dataset.callmode)];
            if (!b) return;
            b.callPushMode = sel.value;
            delete b.pushCallContext;   // 旧开关不再用
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
        }));

        const bindClick = (sel, handler) => bindingsList.querySelectorAll(sel).forEach(btn => btn.addEventListener('click', () => handler(btn)));

        bindClick('[data-del]', async (btn) => { const cfg = TavernSync.getConfig(); cfg.bindings.splice(parseInt(btn.dataset.del), 1); await TavernSync.saveConfig(cfg); renderBindings(); });

        bindClick('[data-pull]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.pull)];
            const orig = btn.textContent; btn.textContent = '同步中...'; btn.disabled = true;
            try { const r = await TavernSync.pullFromTavern(b); showToast([
                r.imported ? `导入 ${r.imported} 楼新剧情` : '',
                r.removedGone ? `酒馆里删掉的 ${r.removedGone} 楼也删掉了` : '',
                r.summariesFilled ? `补上 ${r.summariesFilled} 段摘要` : '',
                r.reordered ? '已按时间重新排好位置' : '',
                r.autoTrimmed ? `精简 ${r.autoTrimmed} 楼旧剧情` : '',
                r.worldUpdated ? `更新 ${r.worldUpdated} 条世界书` : '',
            ].filter(Boolean).join('，') || '酒馆没有新楼层'); renderBindings(); }
            catch (e) { showToast(`${e.message}`); }
            btn.textContent = orig; btn.disabled = false;
        });

        // 和聊天页“+”里的推送窗口完全一样（原来那个“推送最近 N 条、不管推没推过”的窗口已删掉，容易重复推）
        bindClick('[data-push]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.push)];
            const orig = btn.textContent; btn.textContent = '读取中...'; btn.disabled = true;
            try { await showAutoPushModal(b); } catch (e) { showToast(`${e.message}`); }
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
                showToast(r.filled ? `补上/更新了 ${r.filled} 段摘要` + (r.stillNone ? `，还有 ${r.stillNone} 楼柏宝书没写摘要` : '')
                    : (r.stillNone ? `没有新摘要，还有 ${r.stillNone} 楼柏宝书没写摘要` : '摘要都是最新的'));
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
async function showAutoPushModal(binding) {
    let state;
    try {
        state = await TavernSync.getPushState(binding);
    } catch (e) { showToast(`读取酒馆失败：${e.message}`); return; }
    const { list, pushed, lastPushedIdx } = state;
    const total = list.length;
    if (!total) { showToast('还没有可推送的消息'); return; }

    const pushedCount = list.filter(m => pushed.has(m.id)).length;
    const firstUnpushed = lastPushedIdx + 2;        // 给用户看的编号从 1 开始
    const unpushedCount = total - (lastPushedIdx + 1);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:85vh; display:flex; flex-direction:column;';

    const numStyle = 'width:66px; padding:6px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const tabBtn = (id, label, active) => `<button data-mode="${id}" class="auto-push-tab" style="flex:1; padding:8px 4px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:${active ? 'rgba(33,150,243,0.18)' : 'transparent'}; color:${active ? '#2196F3' : 'inherit'}; font-size:13px; cursor:pointer;">${label}</button>`;
    const rangeRow = (idPrefix, from, to) => `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px; font-size:14px;">
            第 <input type="number" id="${idPrefix}-from" min="1" max="${total}" value="${from}" style="${numStyle}">
            到 <input type="number" id="${idPrefix}-to" min="1" max="${total}" value="${to}" style="${numStyle}"> 条
        </div>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 4px; font-size:16px; font-weight:600;">推送/清理小手机消息</h3>
        <div style="font-size:12px; color:#888; margin-bottom:10px; line-height:1.6;">
            小手机消息共 ${total} 条，酒馆里已有 ${pushedCount} 条。${unpushedCount ? `未推送：第 ${firstUnpushed} ~ ${total} 条（${unpushedCount} 条）` : '没有未推送的消息'}
        </div>
        <div style="display:flex; gap:6px; margin-bottom:12px;">
            ${tabBtn('raw', '原始消息', true)}
            ${tabBtn('summary', '小总结', false)}
            ${tabBtn('clean', '清理酒馆', false)}
        </div>

        <div id="auto-mode-raw" style="display:flex; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px;">推送这些消息（默认是未推送的那一段）</div>
            ${rangeRow('auto-raw', unpushedCount ? firstUnpushed : total, total)}
            <div id="auto-raw-preview" style="font-size:12px; color:#ccc; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; margin-bottom:12px; max-height:180px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #2196F3;"></div>
        </div>

        <div id="auto-mode-summary" style="display:none; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px;">把这些消息浓缩成一段总结后推送（消耗 1 次总结 API）</div>
            ${rangeRow('auto-sum', unpushedCount ? firstUnpushed : total, total)}
            <button id="auto-sum-gen" style="${TS.btnG} width:100%; margin-bottom:10px;">生成小总结</button>
            <textarea id="auto-sum-text" placeholder="生成后可在此编辑..." style="width:100%; box-sizing:border-box; min-height:130px; max-height:220px; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.04); color:inherit; font-size:13px; line-height:1.6; resize:vertical; margin-bottom:12px;"></textarea>
        </div>

        <div id="auto-mode-clean" style="display:none; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px; line-height:1.6;">
                把这些小手机消息从酒馆里删掉（默认全部）。只删酒馆楼层里的小手机内容，不动小手机自己的聊天记录，也不动酒馆原有的剧情。
            </div>
            ${rangeRow('auto-clean', 1, total)}
            <div id="auto-clean-preview" style="font-size:12px; color:#ccc; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; margin-bottom:12px; max-height:180px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #f66;"></div>
        </div>

        <div style="display:flex; gap:10px;">
            <button id="auto-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
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
                b.style.color = active ? '#2196F3' : 'inherit';
            });
            modal.querySelector('#auto-mode-raw').style.display = mode === 'raw' ? 'flex' : 'none';
            modal.querySelector('#auto-mode-summary').style.display = mode === 'summary' ? 'flex' : 'none';
            modal.querySelector('#auto-mode-clean').style.display = mode === 'clean' ? 'flex' : 'none';
            confirmBtn.textContent = mode === 'clean' ? '确认删除' : '确认推送';
            confirmBtn.style.background = mode === 'clean' ? 'rgba(244,67,54,0.8)' : '';
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

    const close = () => overlay.remove();
    modal.querySelector('#auto-cancel').addEventListener('click', close);
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
                const r = await TavernSync.pushSummaryToTavern(binding, finalText, lastId, coveredIds);
                if (r.pushed > 0) { try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: r.message }); } catch {} }
                showToast(`已推送小总结 · 覆盖 ${coveredIds.length} 条`);
                close();
            } else if (mode === 'clean') {
                const { from, to, msgs } = readRange('auto-clean');
                const ids = msgs.filter(m => pushed.has(m.id)).map(m => m.id);
                if (!ids.length) { showToast('这个范围里没有推送到酒馆的消息'); throw new Error('__cancel'); }
                if (!confirm(`把第 ${from} ~ ${to} 条里已经推送到酒馆的 ${ids.length} 条消息从酒馆删掉？小手机里的聊天不受影响。`)) throw new Error('__cancel');
                const r = await TavernSync.removePushedFromTavern(binding, ids);
                try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                showToast(`已从酒馆删掉 ${r.removed} 条小手机消息`);
                close();
            } else {
                const { msgs } = readRange('auto-raw');
                if (!msgs.length) { showToast('这个范围里没有消息'); throw new Error('__cancel'); }
                const r = await TavernSync.pushToTavern(binding, undefined, true, { messages: msgs });
                if (r.pushed > 0) {
                    try {
                        const payload = r.message ? { message: r.message } : { reload: true };
                        window.webkit?.messageHandlers?.tavernPushDone?.postMessage(payload);
                    } catch {}
                    showToast(`已推送 ${r.pushed} 条消息到酒馆`);
                } else if (r.deleted) {
                    try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                    showToast('已同步删除酒馆中的旧消息');
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
    const floors = (char.history || []).filter(m => m && m.fromTavern && m.tavern);
    if (!floors.length) { showToast('小手机里还没有酒馆剧情'); return; }

    const keep = TavernSync.keepRawFloorCount(binding);
    const floorNo = (m) => (typeof m.tavern.floor === 'number' ? m.tavern.floor : 0);
    const firstFloor = Math.min(...floors.map(floorNo));
    const lastFloor = Math.max(...floors.map(floorNo));
    // 默认范围：留着最近 keep 楼的原文，更早的都精简
    const older = floors.slice(0, Math.max(0, floors.length - keep));
    const defEnd = older.length ? floorNo(older[older.length - 1]) : firstFloor;

    const can = floors.filter(m => TavernSync.canTrim(m));
    const trimmed = floors.filter(m => m.tavern.trimmed);
    const noSummary = floors.filter(m => !m.tavern.trimmed && !(m.tavern.summary && m.tavern.summary.text));
    const saveable = can.reduce((n, m) => n + Math.max(0, (m.content || '').length - m.tavern.summary.text.length), 0);
    const sizeOf = (n) => n >= 10000 ? `约 ${(n / 10000).toFixed(1)} 万字` : `约 ${n} 字`;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:380px; max-height:85vh; overflow-y:auto;';
    const numStyle = 'width:80px; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const cancelStyle = 'width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">精简旧楼层</h3>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:8px;">
            精简就是只留柏宝书摘要、把原文丢掉。原文在酒馆里一直都在，点下面的「取回原文」随时拿回来。
        </div>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:12px;">
            小手机里有 <b>${floors.length}</b> 楼酒馆剧情（第 ${firstFloor} ~ ${lastFloor} 楼），其中 <b>${trimmed.length}</b> 楼已精简、
            <b>${can.length}</b> 楼可以精简（能省${sizeOf(saveable)}）${noSummary.length ? `、<b>${noSummary.length}</b> 楼还没有摘要（不会精简）` : ''}。
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
        showToast(r.trimmed ? `精简了 ${r.trimmed} 楼，省下约 ${r.saved} 字` + (r.skipped ? `；${r.skipped} 楼还没有摘要${where}` : '')
            : (r.skipped ? `这个范围里的 ${r.skipped} 楼都还没有摘要${where}` : '这个范围里没有可以精简的楼层'));
    }));
    modal.querySelector('#tm-restore').addEventListener('click', (e) => run(e.currentTarget, async (range) => {
        const r = await TavernSync.restoreRawFloors(binding, range);
        showToast(r.restored ? `取回了 ${r.restored} 楼的原文` + (r.missing ? `；${r.missing} 楼在酒馆里已经找不到` : '')
            : (r.missing ? `${r.missing} 楼在酒馆里已经找不到，取不回来` : '这个范围里没有精简过的楼层'));
    }));
}

async function showResetRangeModal(binding, onDone) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }
    const info = await TavernSync.getTavernFloorInfo(binding);
    const have = (char.history || []).filter(m => m && m.fromTavern).length;
    const lastFloor = Math.max(0, info.total - 1);
    const defStart = Math.max(0, info.total - (TavernSync.getConfig().initialImportCount || 20));

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:380px;';
    const numStyle = 'width:80px; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const cancelStyle = 'flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">清空并重选范围</h3>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:12px;">
            小手机里现在有 <b>${have}</b> 楼酒馆剧情，会全部删掉。<br>
            酒馆里这个聊天一共 <b>${info.total}</b> 楼（第 0 ~ ${lastFloor} 楼，和酒馆里楼层的 # 号一致）。
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:14px;">
            从第 <input type="number" id="rr-start" min="0" max="${lastFloor}" value="${defStart}" style="${numStyle}">
            到第 <input type="number" id="rr-end" min="0" max="${lastFloor}" value="${lastFloor}" style="${numStyle}"> 楼
        </div>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:16px;">
            小手机推送过去的楼层、番外楼不会导入。清空后，酒馆里以后新玩的楼层照常同步。<br>
            已经写进日记、记忆表格、向量记忆的内容不受影响。
        </div>
        <button id="rr-range" style="width:100%; ${TS.btnP} margin-bottom:8px;">清空，并导入这个范围</button>
        <button id="rr-none" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(244,67,54,0.4); background:transparent; color:#f66; font-size:14px; cursor:pointer; margin-bottom:8px;">只清空（以后只同步新楼层）</button>
        <button id="rr-cancel" style="width:100%; ${cancelStyle}">取消</button>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const close = () => overlay.remove();
    modal.querySelector('#rr-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const run = async (range, btn) => {
        const buttons = modal.querySelectorAll('button');
        buttons.forEach(b => { b.disabled = true; });
        const orig = btn.textContent; btn.textContent = '处理中...';
        try {
            const r = await TavernSync.resetImportRange(binding, range);
            let msg = `已删掉 ${r.removed} 楼`;
            if (range) {
                const p = await TavernSync.pullFromTavern(binding);
                msg += `，重新导入 ${p.imported} 楼`;
            }
            showToast(msg);
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
        if (!confirm(`删掉小手机里全部 ${have} 楼酒馆剧情，以后只同步新楼层？`)) return;
        run(null, e.currentTarget);
    });
}

// ========== 正则规则编辑弹窗 ==========
function showRuleEditor(ruleIndex, onSave) {
    const cfg = TavernSync.getConfig(); if (!cfg.cleanRules) cfg.cleanRules = [];
    const existing = ruleIndex !== null ? cfg.cleanRules[ruleIndex] : null;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">${existing ? '编辑' : '添加'}清洗规则</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">规则名称</label><input id="rr-name" placeholder="例如：去除thinking" style="${TS.input}"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">正则表达式</label><input id="rr-regex" placeholder="例如：<thinking>[\\s\\S]*?</thinking>" style="${TS.input} font-family:monospace;"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">模式</label><select id="rr-mode" style="${TS.input}">
            <option value="exclude" ${(!existing || existing.mode === 'exclude') ? 'selected' : ''}>排除（删除匹配内容）</option>
            <option value="extract" ${existing?.mode === 'extract' ? 'selected' : ''}>提取（只保留匹配/捕获组$1）</option></select></div>
        <div style="margin-bottom:12px;">
            <label style="${TS.label}">生效深度（从最新消息起算，0 = 最新一条）</label>
            <div style="display:flex; gap:8px; margin-top:4px;">
                <div style="flex:1;"><input id="rr-min-depth" type="number" min="0" value="${existing?.minDepth ?? ''}" placeholder="最小深度" style="${TS.input} text-align:center;"></div>
                <span style="align-self:center; color:#888;">~</span>
                <div style="flex:1;"><input id="rr-max-depth" type="number" min="0" value="${existing?.maxDepth ?? ''}" placeholder="最大深度" style="${TS.input} text-align:center;"></div>
            </div>
            <div style="font-size:12px; color:#888; margin-top:4px;">留空 = 不限。例如最小0最大4 = 只对最近5条生效；最小5留空 = 只对第6条及更早的生效</div>
        </div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">测试</label>
            <textarea id="rr-test" placeholder="粘贴消息文本测试..." style="${TS.input} height:60px; resize:vertical;"></textarea>
            <div id="rr-result" style="margin-top:6px; font-size:12px; color:#888; background:rgba(255,255,255,0.04); border-radius:8px; padding:8px; white-space:pre-wrap; max-height:80px; overflow:auto;"></div></div>
        <div style="display:flex; gap:10px;">
            <button id="rr-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
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
        const minD = modal.querySelector('#rr-min-depth').value, maxD = modal.querySelector('#rr-max-depth').value;
        const rule = { id: existing?.id || `rule_${Date.now()}`, name: modal.querySelector('#rr-name').value.trim() || '未命名', regex, mode: modal.querySelector('#rr-mode').value, enabled: existing?.enabled ?? true, minDepth: minD !== '' ? parseInt(minD) : null, maxDepth: maxD !== '' ? parseInt(maxD) : null };
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
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:80vh; overflow-y:auto;';

    const hasPersona = char.persona?.trim();
    const hasMyPersona = char.myPersona?.trim();

    let userPersonaHTML = '';
    if (result.userPersonas.length) {
        const opts = result.userPersonas.map(p => `<option value="${p.avatar}">${p.name}</option>`).join('');
        userPersonaHTML = `
            <div style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <label style="${TS.label} margin-bottom:0;">用户人设（"我"的设定）</label>
                    ${hasMyPersona ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
                </div>
                <select id="ic-persona-select" style="${TS.input} margin-top:4px;">
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
            <button id="ic-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
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
    }

    modal.querySelector('#ic-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector('#ic-save').addEventListener('click', async () => {
        const importPersona = modal.querySelector('#ic-persona-check')?.checked;
        const importMyPersona = modal.querySelector('#ic-mypersona-check')?.checked;

        if (importPersona && result.charPersona) {
            if (hasPersona && !confirm('当前角色已有人设，确定覆盖吗？')) { /* skip */ }
            else char.persona = modal.querySelector('#ic-persona').value;
        }
        if (importMyPersona && myPersonaArea?.value?.trim()) {
            if (hasMyPersona && !confirm('当前角色已有用户人设，确定覆盖吗？')) { /* skip */ }
            else char.myPersona = myPersonaArea.value;
        }

        await saveData(); overlay.remove(); showToast('设定已导入');
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
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:85vh; display:flex; flex-direction:column;';

    const tabsHTML = sources.length > 1
        ? sources.map((src, i) => `<button class="wb-tab" data-tab="${i}" style="padding:6px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:${i === 0 ? 'rgba(255,255,255,0.15)' : 'transparent'}; color:inherit; font-size:12px; cursor:pointer;">${esc(src.type)}(${src.entries.length})</button>`).join('')
        : '';
    const smallBtn = 'padding:4px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:12px; cursor:pointer;';

    modal.innerHTML = `
        <h3 style="margin:0 0 8px; font-size:16px; font-weight:600;">导入酒馆世界书</h3>
        <div style="font-size:12px; color:#888; margin-bottom:8px; line-height:1.6;">复制过来就是小手机自己的世界书条目，可以随便改。酒馆里改了内容的，这里会标出来，可以选择更新。</div>
        ${tabsHTML ? `<div style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">${tabsHTML}</div>` : ''}
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-select-all" style="${smallBtn}">全选</button>
            <button id="wb-select-enabled" style="${smallBtn}">只选酒馆里开着的</button>
            <button id="wb-select-changed" style="${smallBtn}">只选有改动的</button>
        </div>
        <div id="wb-entries" style="flex:1; overflow-y:auto; margin-bottom:10px;"></div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:13px;">
            <span style="white-space:nowrap;">加到分组</span>
            <select id="wb-category" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:13px;"></select>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-import" style="flex:1; ${TS.btnB}">复制到小手机世界书</button>
            <button id="wb-update" style="flex:1; ${TS.btnG}">更新小手机里的内容</button>
        </div>
        <button id="wb-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;

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
            btn.style.borderColor = on ? 'rgba(33,150,243,0.5)' : 'rgba(255,255,255,0.15)';
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
        return { text: changed ? '酒馆里已改' : '已复制', color: changed ? '#FF9800' : '#4CAF50', changed, copied };
    }
    function renderEntries(srcIdx) {
        currentSourceIdx = srcIdx;
        const src = sources[srcIdx];
        const container = modal.querySelector('#wb-entries');
        container.innerHTML = src.entries.map((e, i) => {
            const st = statusOf(src, e);
            const preview = (e.content || '').replace(/\s+/g, ' ').trim();
            return `
            <label style="display:flex; align-items:center; gap:10px; padding:10px; background:rgba(255,255,255,0.04); border-radius:8px; margin-bottom:6px; cursor:pointer; ${e.disabled ? 'opacity:0.55;' : ''}">
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
            t.style.borderColor = on ? 'rgba(33,150,243,0.5)' : 'rgba(255,255,255,0.15)';
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
        let updated = 0, missing = 0;
        for (const e of selected) {
            const copied = TavernSync.findCopiedWorldBook(binding, src.name, e.uid);
            if (!copied) { missing++; continue; }
            if (copied.tavernSource.hash === TavernSync.wbHash(e)) continue;
            TavernSync.applyTavernEntry(copied, e, src.entries.indexOf(e), false);
            copied.tavernSource.hash = TavernSync.wbHash(e);
            copied.tavernSource.order = e.order;
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
    const labels = { raw: '原文', summary: '摘要', 'summary-trimmed': '摘要（原文已精简）', 'raw-nosummary': '原文（还没有摘要）' };
    const colors = { raw: '#2196F3', summary: '#4CAF50', 'summary-trimmed': '#26A69A', 'raw-nosummary': '#FF7043' };
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
    const box = 'font-size:12px; color:#ccc; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; white-space:pre-wrap; line-height:1.5;';

    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">提示词预览 — ${esc(char.remarkName || char.name)}</h3>
        <div style="font-size:12px; color:#888; margin-bottom:12px;">下面是 AI 下次会收到的酒馆相关内容 · 预估 <span style="color:#4CAF50; font-weight:600;">~${totalTokens.toLocaleString()}</span> tokens</div>
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
        <button id="pp-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);
    modal.querySelector('#pp-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ========== 绑定编辑弹窗 ==========
async function showBindingEditor(onSave) {
    let stCharacters;
    try { stCharacters = await TavernSync.getSTCharacters(); } catch (e) { showToast(`${e.message}`); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">添加角色绑定</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">小手机角色</label>
            <select id="be-uwu" style="${TS.input}">${db.characters.map(c => `<option value="${c.id}">${esc(c.remarkName || c.name)}</option>`).join('')}</select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">酒馆角色</label>
            <select id="be-st" style="${TS.input}">${stCharacters.map(c => `<option value="${c.avatar}">${esc(c.name)}</option>`).join('')}</select></div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">酒馆聊天记录</label>
            <select id="be-chat" style="${TS.input}"><option>加载中...</option></select></div>
        <div style="display:flex; gap:10px;">
            <button id="be-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
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
        const cfg = TavernSync.getConfig(); if (!cfg.bindings) cfg.bindings = [];
        cfg.bindings.push(binding); await TavernSync.saveConfig(cfg);
        overlay.remove(); showToast('绑定已保存'); if (onSave) onSave();
    });
}

// 写酒馆的操作排队执行（yuan 版新增）：
// 推送、删除同步、小总结、通话记录都是“读取酒馆聊天 → 修改 → 整个存回去”。
// 两个操作同时进行时，后存的会把先存的改动覆盖掉。自动推送和删除同步可能同时触发，所以让它们一个接一个来。
// 从酒馆同步（pullFromTavern）也排进来：打开聊天和切回页面可能同时触发两次同步，同时进行会重复导入同一批楼层。
TavernSync._writeQueue = Promise.resolve();
['pushToTavern', 'pushSummaryToTavern', 'pushCallRecordToTavern', 'pullFromTavern', 'replaceRegeneratedInTavern', 'resetImportRange', 'removePushedFromTavern', 'writeBackFloorEdit', 'updatePushedMessage'].forEach(name => {
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

})();

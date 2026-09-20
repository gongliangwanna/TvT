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
    // 手机上看控制台不方便，所以出问题时记在这里，显示在“酒馆互联”页面顶部（只保存在本次打开期间）
    issues: [],
    reportIssue(message) {
        const text = String(message);
        console.error('[酒馆外挂]', text);
        const last = this.issues[this.issues.length - 1];
        if (last && last.text === text) { last.count++; last.time = Date.now(); return; }
        this.issues.push({ text, time: Date.now(), count: 1 });
        if (this.issues.length > 20) this.issues.shift();
    },

    getConfig() {
        if (!db.tavernSync || typeof db.tavernSync !== 'object') {
            db.tavernSync = { enabled: false, bindings: [], maxInjectMessages: 50, cleanRules: [], worldBookPosition: 'before_chat', pushIncludeStatusBar: true };
        }
        // 确保关键字段存在（防止旧数据缺少新字段）
        if (!Array.isArray(db.tavernSync.bindings)) db.tavernSync.bindings = [];
        if (!Array.isArray(db.tavernSync.cleanRules)) db.tavernSync.cleanRules = [];
        if (typeof db.tavernSync.pushIncludeStatusBar !== 'boolean') db.tavernSync.pushIncludeStatusBar = true;
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
        const sameFloor = (m, t) => m.send_date === t.sendDate && !!m.is_user === !!t.isUser
            && (t.genStarted === undefined || String(m.gen_started || '') === t.genStarted);
        const imported = char.history.filter(h => h && h.fromTavern && h.tavern);
        const prevMemory = char.tavernMemory || {};

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
            if (h.tavern.genStarted === undefined) h.tavern.genStarted = String(found.m.gen_started || '');
            const summary = readBaibaiSummary(found.m);
            const oldText = h.tavern.summary && h.tavern.summary.text;
            if (summary && summary.text !== oldText) { h.tavern.summary = summary; summariesFilled++; }
        }

        // 3. 按真实时间把酒馆楼层排进小手机聊天记录（包括以前导入时排错位置的）
        const reordered = this.placeTavernFloors(char);

        char.tavernMemory = {
            lastSync: Date.now(),
            stCharAvatar: binding.stCharAvatar,
            stChatFile: binding.stChatFile,
            lastImported: importedCount,
            importStart: start || null,
            importEnd: sameChat ? (prevMemory.importEnd || null) : null,
            resumeAfter: sameChat ? (prevMemory.resumeAfter || null) : null,
        };

        // 绑定的世界书条目跟着一起刷新（写到 char.tavernWorldMemory）
        try {
            const wbR = await this.refreshBoundWorldMemory(binding);
            if (wbR.refreshed) console.log(`[TavernSync] Bound world refreshed: ${wbR.entryCount} entries`);
        } catch (e) { this.reportIssue('刷新绑定的世界书失败：' + e.message); }

        await saveData();
        // 正在看这个角色的聊天 → 重新画一遍，新卡片立刻出现
        if ((importedCount > 0 || reordered) && typeof currentChatId !== 'undefined' && currentChatId === char.id
            && typeof renderMessages === 'function') {
            try { renderMessages(false, true); } catch (e) { /* 画不出来不影响数据 */ }
        }
        return { imported: importedCount, summariesFilled, reordered };
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
            if (rawSet.has(i)) {
                view = 'raw'; content = fill(cfg.wrapRaw, m, m.content, t.summary && t.summary.time);
            } else if (!t.isUser && t.summary && t.summary.text) {
                view = 'summary'; content = fill(cfg.wrapSummary, m, t.summary.text, t.summary.time);
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
        const { allUwuMsgs } = this._pushHelpers(char);
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
        const { allUwuMsgs, toLine } = this._pushHelpers(char);
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
    _pushHelpers(char) {
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
        );
        const toLine = (m) => this.applyCleanRules(stripThinking(stripStatusBar(m.content)), null);
        return { allUwuMsgs, toLine };
    },

    // opts.messages：明确指定要推送哪些消息（聊天页的推送窗口让用户自己填范围时用），优先于 pushCount
    async pushToTavern(binding, pushCount, trackProgress = true, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        const { allUwuMsgs, toLine } = this._pushHelpers(char);
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

        return { pushed: newMsgs.length, deleted: hadDeletions, message: newMsg, deletionOps };
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
        const { allUwuMsgs, toLine } = this._pushHelpers(char);
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
    //   - 绑定的酒馆世界书条目（“世界书 → 绑定记忆”）
    //   - 聊天记录里有酒馆楼层时，加一段“线下剧情说明”（可在酒馆互联页面自定义）
    // 酒馆剧情本身已经在聊天记录里（见 pullFromTavern / prepareHistoryForAI），这里不再整块注入。
    buildPromptBlock(character) {
        if (!character) return '';
        const cfg = this.getConfig();
        const parts = [];
        if (character.tavernWorldMemory && character.tavernWorldMemory.content) {
            parts.push(`【世界设定】\n以下是该世界观的背景设定，你需要了解并遵循：\n${character.tavernWorldMemory.content}`);
        }
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
        } catch (e) { this.reportIssue('自动从酒馆同步失败：' + e.message); }
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
        } catch (e) { this.reportIssue('删除同步到酒馆失败：' + e.message); }
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
        } catch (e) { this.reportIssue('自动推送到酒馆失败：' + e.message); }
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
                // 用户正在离开 OVO（切换到酒馆）→ 立即同步删除，静默写入不刷新 ST
                if (this.isAuto(binding, 'autoPush')) {
                    this.pushToTavern(binding, 0).then(r => {
                        if (r.deleted) console.log('[TavernSync] Leave-sync: delete synced to ST silently');
                    }).catch(e => this.reportIssue('离开小手机时同步删除失败：' + e.message));
                }
            } else {
                // 用户回到 OVO → 自动拉取最新记忆
                if (this.isAuto(binding, 'autoPull')) {
                    this.pullFromTavern(binding).then(r => {
                        if (r.imported > 0) console.log(`[TavernSync] Visibility pull: ${r.imported} messages`);
                    }).catch(e => this.reportIssue('切回小手机时自动同步失败：' + e.message));
                }
                // 回来时也做一次删除同步（兜底，防止离开时未能同步的情况）
                if (this.isAuto(binding, 'autoPush')) {
                    this.pushToTavern(binding, 0).then(r => {
                        if (r.deleted) {
                            console.log('[TavernSync] Return-sync: delete synced to ST');
                            try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                        }
                    }).catch(e => this.reportIssue('切回小手机时同步删除失败：' + e.message));
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
                    order: e.order ?? e.uid ?? 0, position: e.position, disabled: !!e.disable, constant: !!e.constant,
                }));
                entries.sort((a, b) => a.order - b.order);
                result.charWorld = { name: worldName, entries };
            } catch (e) { console.warn('[TavernSync] Failed to load char world:', e); }
        } else if (d.character_book?.entries) {
            const entries = Object.values(d.character_book.entries).map(e => ({
                uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
                order: e.order ?? e.uid ?? 0, position: e.position, disabled: !!e.disable, constant: !!e.constant,
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
                        order: e.order ?? e.uid ?? 0, position: e.position, disabled: !!e.disable, constant: !!e.constant,
                    }));
                    entries.sort((a, b) => a.order - b.order);
                    result.chatWorld = { name: chatWbName, entries };
                }
            } catch (e) { console.warn('[TavernSync] Failed to load chat world:', e); }
        }

        return result;
    },

    // 按 binding.boundWorldBook 重新拉取条目并刷新 char.tavernWorldMemory
    // 自动同步酒馆时调用，让总结世界书条目变化能跟着同步进来
    async refreshBoundWorldMemory(binding) {
        const bound = binding.boundWorldBook;
        if (!bound || !Array.isArray(bound.entryUids) || !bound.entryUids.length) return { refreshed: false };
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) return { refreshed: false };

        const worldBooks = await this.getCharAndChatWorldBooks(binding);
        const src = bound.sourceType === 'chat' ? worldBooks.chatWorld : worldBooks.charWorld;
        if (!src) return { refreshed: false };

        const uidSet = new Set(bound.entryUids);
        const matched = src.entries.filter(e => uidSet.has(e.uid));
        if (!matched.length) {
            // 全部条目都不在了，清空 memory，保留 binding 让用户感知
            char.tavernWorldMemory = { lastSync: Date.now(), entryCount: 0, source: src.name, content: '', bound: true };
            return { refreshed: true, entryCount: 0 };
        }
        matched.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const memoryText = matched.map(e => { let t = ''; if (e.comment) t += `[${e.comment}]\n`; t += e.content; return t; }).join('\n\n---\n\n');
        char.tavernWorldMemory = { lastSync: Date.now(), entryCount: matched.length, source: src.name, content: memoryText, bound: true };
        return { refreshed: true, entryCount: matched.length };
    },
};

// ========== UI 样式常量 ==========
const TS = {
    card: 'background:var(--received-bg, rgba(255,255,255,0.08)); border-radius:14px; padding:16px; margin-bottom:12px;',
    label: 'font-size:13px; color:#999; display:block; margin-bottom:4px;',
    input: 'width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; box-sizing:border-box;',
    btnP: 'padding:10px; border-radius:10px; border:none; background:linear-gradient(135deg, #667eea, #764ba2); color:white; font-size:14px; font-weight:500; cursor:pointer;',
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
                        <button id="ts-add-btn" style="padding:6px 14px; border-radius:8px; border:none; background:var(--sent-bg, rgba(255,204,204,0.9)); color:var(--sent-text, #a56767); font-size:13px; cursor:pointer;">+ 添加</button>
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
                    <div style="font-size:11px; color:#888; margin-top:4px;">某个角色第一次同步时，从酒馆导入最近多少楼。之后每次同步只导入新楼层</div>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px; flex:1;">最近几楼发原文</span>
                        ${numInput('ts-raw-count', config.rawFloorCount)}
                    </div>
                    <div style="font-size:11px; color:#888; margin-top:4px;">发给 AI 时，最近这么多楼酒馆剧情给完整原文，更早的换成柏宝书摘要（还没有摘要的暂时发原文）</div>
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
                    <div style="font-size:11px; color:#888; margin-top:6px;">自动同步、自动推送的开关在上面每个角色的绑定卡片里，可以分别设置</div>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:14px;">推送楼层模式</span>
                        <select id="ts-push-mode" style="padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px;">
                            <option value="new" ${(config.pushMode || 'new') === 'new' ? 'selected' : ''}>新开楼层</option>
                            <option value="append" ${config.pushMode === 'append' ? 'selected' : ''}>合并到最后一楼</option>
                        </select>
                    </div>
                    <div style="font-size:11px; color:#888; margin-top:4px;">新开楼层：每次推送创建新消息；合并末尾：追加到最后一楼末尾（配合正则隐藏）。注：若最后一楼已是小手机消息，无论模式都会自动合并</div>
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
        const list = TavernSync.issues;
        if (!list.length) { issuesArea.style.display = 'none'; issuesArea.innerHTML = ''; return; }
        issuesArea.style.display = 'block';
        issuesArea.innerHTML = `<div style="${TS.card} border:1px solid rgba(244,67,54,0.5);">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
                <span style="${TS.title} color:#f66;">遇到的问题（${list.length}）</span>
                <button id="ts-issues-clear" style="${smallBtn}">清空</button>
            </div>
            ${list.slice().reverse().map(it => `<div style="font-size:12px; line-height:1.5; padding:6px 0; border-top:1px solid rgba(255,255,255,0.08);">
                <span style="color:#888;">${new Date(it.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${it.count > 1 ? ` ×${it.count}` : ''}</span>
                ${escAttr(it.text)}</div>`).join('')}
        </div>`;
        issuesArea.querySelector('#ts-issues-clear').addEventListener('click', () => { TavernSync.issues.length = 0; renderIssues(); });
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
                    <span>${u.name || u.handle}</span>
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
                    <div style="font-size:13px; font-weight:500;">${r.name || '未命名'}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.mode === 'extract' ? '提取' : '排除'} /${r.regex}/${r.minDepth != null || r.maxDepth != null ? ` 深度${r.minDepth ?? 0}~${r.maxDepth ?? '∞'}` : ''}</div>
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
            const floorCount = char && Array.isArray(char.history) ? char.history.filter(h => h && h.fromTavern).length : 0;
            const syncInfo = mem && mem.lastSync ? `小手机里有 ${floorCount} 楼酒馆剧情 · 上次同步 ${new Date(mem.lastSync).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}` : '未同步';
            const wbMem = char?.tavernWorldMemory;
            const wbInfo = wbMem ? `${wbMem.entryCount} 条世界书` : '';
            const maxMem = parseInt(char && char.maxMemory, 10) || 20;   // 这个角色在聊天设置里的“可见上文条数”
            return `<div style="${TS.card} padding:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div><div style="font-size:14px; font-weight:600;">${charName} ↔ ${stName}</div>
                        <div style="font-size:11px; color:#888; margin-top:2px;">${syncInfo}${wbInfo ? ' · ' + wbInfo : ''}</div></div>
                    <button data-del="${i}" style="${TS.btnD}">✕</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button data-pull="${i}" style="flex:1; ${TS.btnG}">同步记忆</button>
                    <button data-push="${i}" style="flex:1; ${TS.btnB}">推送到酒馆</button></div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                    <button data-import-char="${i}" style="flex:1; ${TS.btnO}">导入设定</button>
                    <button data-import-wb="${i}" style="flex:1; ${TS.btnO}">世界书</button></div>
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
                r.summariesFilled ? `补上 ${r.summariesFilled} 段摘要` : '',
                r.reordered ? '已按时间重新排好位置' : '',
            ].filter(Boolean).join('，') || '酒馆没有新楼层'); renderBindings(); }
            catch (e) { showToast(`${e.message}`); }
            btn.textContent = orig; btn.disabled = false;
        });

        bindClick('[data-push]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.push)];
            showPushOptionsModal(b, btn);
        });

        bindClick('[data-import-char]', async (btn) => {
            const cfg = TavernSync.getConfig(); const b = cfg.bindings[parseInt(btn.dataset.importChar)];
            btn.textContent = '加载中...'; btn.disabled = true;
            try { await showImportCharModal(b); } catch (e) { showToast(`${e.message}`); }
            btn.textContent = '导入设定'; btn.disabled = false;
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
            btn.textContent = '世界书'; btn.disabled = false;
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
        <h3 style="margin:0 0 4px; font-size:16px; font-weight:600;">推送到酒馆</h3>
        <div style="font-size:11px; color:#888; margin-bottom:10px; line-height:1.6;">
            小手机消息共 ${total} 条，酒馆里已有 ${pushedCount} 条。${unpushedCount ? `未推送：第 ${firstUnpushed} ~ ${total} 条（${unpushedCount} 条）` : '没有未推送的消息'}
        </div>
        <div style="display:flex; gap:6px; margin-bottom:12px;">
            ${tabBtn('raw', '原始消息', true)}
            ${tabBtn('summary', '小总结', false)}
            ${tabBtn('clean', '清理酒馆', false)}
        </div>

        <div id="auto-mode-raw" style="display:flex; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px;">推送这些消息（默认是未推送的那一段，可以自己改）</div>
            ${rangeRow('auto-raw', unpushedCount ? firstUnpushed : total, total)}
            <div id="auto-raw-preview" style="font-size:12px; color:#ccc; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; margin-bottom:12px; max-height:180px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #2196F3;"></div>
        </div>

        <div id="auto-mode-summary" style="display:none; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px;">把这些消息浓缩成一段总结后推送（消耗 1 次总结 API）</div>
            ${rangeRow('auto-sum', unpushedCount ? firstUnpushed : total, total)}
            <button id="auto-sum-gen" style="${TS.btnB} width:100%; margin-bottom:10px;">生成小总结</button>
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

// ========== 推送选项弹窗（手动 · 不追踪）==========
// 入口：酒馆同步配置页绑定卡片的「推送到酒馆」按钮
// 不更新 lastPushedMsgId，给用户留反悔余地
//   - 原始：推送最近 N 条原始消息
//   - 小总结：用户手动输入一段总结文本，覆盖最近 N 条
async function showPushOptionsModal(binding, triggerBtn) {
    const char = db.characters.find(c => c.id === binding.uwuCharId);
    if (!char) { showToast('找不到角色'); return; }

    const allMsgs = char.history.filter(m => !m.fromTavern && m.content?.trim() && !m.isThinking && !m.isContextDisabled);
    if (!allMsgs.length) {
        // 没有新消息，但仍然尝试同步删除
        try {
            const r = await TavernSync.pushToTavern(binding, 0);
            if (r.deleted) {
                try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ reload: true }); } catch {}
                showToast('已同步删除酒馆中的旧消息');
            } else {
                showToast('没有可推送的消息');
            }
        } catch (e) { console.warn(e); showToast('没有可推送的消息'); }
        return;
    }

    const totalCount = allMsgs.length;
    const defaultCount = Math.min(totalCount, TavernSync.getConfig().maxInjectMessages || 50);

    // 找出已推送/未推送的分界点（用于预览渲染时高亮）
    let pushedBoundaryIdx = -1; // allMsgs 中 lastPushedMsgId 的索引；之后（不含）都是未推送
    if (binding.lastPushedMsgId) {
        pushedBoundaryIdx = allMsgs.findIndex(m => m.id === binding.lastPushedMsgId);
    }
    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:85vh; display:flex; flex-direction:column;';

    // 预览：显示最近 count 条消息（与实际推送一致）；已推送行用灰色弱化，未推送用正常色，
    // 在分界处插入一条 "↑ 已推送 / ↓ 待推送" 的虚线，提示用户哪些会被重推
    function buildPreview(count) {
        const startIdx = Math.max(0, allMsgs.length - count);
        const msgs = allMsgs.slice(startIdx);
        const renderLine = (m) => {
            const text = m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content;
            return escapeHtml(text);
        };
        const out = [`&lt;phone_chat&gt;`];
        // 仅渲染最后 12 行，避免过长；若总数 > 12，前面用 ... 省略
        const renderStart = Math.max(0, msgs.length - 12);
        if (renderStart > 0) out.push(`<span style="color:#666;">... 省略前 ${renderStart} 条</span>`);
        for (let i = renderStart; i < msgs.length; i++) {
            const absIdx = startIdx + i;
            const isPushed = pushedBoundaryIdx >= 0 && absIdx <= pushedBoundaryIdx;
            // 在分界处（未推送的第一条之前）插入虚线
            if (i > renderStart) {
                const prevAbsIdx = startIdx + i - 1;
                const prevPushed = pushedBoundaryIdx >= 0 && prevAbsIdx <= pushedBoundaryIdx;
                if (prevPushed && !isPushed) {
                    out.push(`<span style="color:#888; font-size:11px; display:inline-block; padding:2px 0; border-top:1px dashed rgba(255,255,255,0.25); width:100%;">↑ 已推送 · ↓ 此次会重新推送</span>`);
                }
            }
            const line = renderLine(msgs[i]);
            if (isPushed) {
                out.push(`<span style="color:#777;">${line}</span>`);
            } else {
                out.push(`<span style="color:#cfe6ff;">${line}</span>`);
            }
        }
        out.push(`&lt;/phone_chat&gt;`);
        return out.join('\n');
    }

    const tabBtn = (id, label, active) => `<button data-mode="${id}" class="push-mode-tab" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:${active ? 'rgba(33,150,243,0.18)' : 'transparent'}; color:${active ? '#2196F3' : 'inherit'}; font-size:13px; cursor:pointer;">${label}</button>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 4px; font-size:16px; font-weight:600;">推送到酒馆</h3>
        <div style="font-size:11px; color:#888; margin-bottom:12px;">手动 · 不更新追踪基准（保留反悔余地）</div>
        <div style="display:flex; gap:6px; margin-bottom:12px;">
            ${tabBtn('raw', '原始消息', true)}
            ${tabBtn('summary', '小总结', false)}
        </div>

        <div id="mode-raw" style="display:flex; flex-direction:column;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <span style="font-size:14px; white-space:nowrap;">推送最近</span>
                <input type="number" id="push-count" value="${defaultCount}" min="1" max="${totalCount}"
                    style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;">
                <span style="font-size:14px; white-space:nowrap;">条 <span style="font-size:11px; color:#888;">（共 ${totalCount}）</span></span>
            </div>
            <div style="font-size:11px; color:#888; margin-bottom:6px;">用 &lt;phone_chat&gt; 标签包裹</div>
            <div id="push-preview" style="font-size:12px; background:rgba(255,255,255,0.04); border-radius:8px; padding:10px; margin-bottom:12px; max-height:200px; overflow-y:auto; white-space:pre-wrap; line-height:1.6; border-left:3px solid #2196F3;">${buildPreview(defaultCount)}</div>
        </div>

        <div id="mode-summary" style="display:none; flex-direction:column;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                <span style="font-size:14px; white-space:nowrap;">总结最近</span>
                <input type="number" id="sum-count" value="${defaultCount}" min="1" max="${totalCount}"
                    style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:inherit; font-size:14px; text-align:center;">
                <span style="font-size:14px; white-space:nowrap;">条 <span style="font-size:11px; color:#888;">（共 ${totalCount}）</span></span>
            </div>
            <div style="font-size:11px; color:#888; margin-bottom:10px;">用 API 把最近 N 条消息浓缩成一段总结后推送（不更新追踪基准，可重复推送）</div>
            <button id="summary-gen" style="${TS.btnB} width:100%; margin-bottom:10px;">生成小总结</button>
            <textarea id="summary-text" placeholder="生成后可在此编辑..." style="width:100%; box-sizing:border-box; min-height:140px; max-height:240px; padding:10px; border-radius:8px; border:1px solid rgba(255,255,255,0.15); background:rgba(255,255,255,0.04); color:inherit; font-size:13px; line-height:1.6; resize:vertical; margin-bottom:12px;"></textarea>
        </div>

        <div style="display:flex; gap:10px;">
            <button id="push-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; cursor:pointer;">取消</button>
            <button id="push-confirm" style="flex:1; ${TS.btnP}">确认推送</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    let mode = 'raw';

    // 切换模式
    modal.querySelectorAll('.push-mode-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            mode = btn.dataset.mode;
            modal.querySelectorAll('.push-mode-tab').forEach(b => {
                const active = b.dataset.mode === mode;
                b.style.background = active ? 'rgba(33,150,243,0.18)' : 'transparent';
                b.style.color = active ? '#2196F3' : 'inherit';
            });
            modal.querySelector('#mode-raw').style.display = mode === 'raw' ? 'flex' : 'none';
            modal.querySelector('#mode-summary').style.display = mode === 'summary' ? 'flex' : 'none';
        });
    });

    // raw 模式：动态更新预览
    const countInput = modal.querySelector('#push-count');
    const previewEl = modal.querySelector('#push-preview');
    countInput.addEventListener('input', () => {
        let n = parseInt(countInput.value) || 1;
        if (n > totalCount) n = totalCount;
        if (n < 1) n = 1;
        previewEl.innerHTML = buildPreview(n);
    });

    // summary 模式：限制 count 输入范围 + API 生成
    const sumCountInput = modal.querySelector('#sum-count');
    const sumText = modal.querySelector('#summary-text');
    const genBtn = modal.querySelector('#summary-gen');
    let summaryState = null; // { text, coveredMsgIds } — 生成后填，count 改变时清空
    sumCountInput.addEventListener('input', () => {
        let n = parseInt(sumCountInput.value) || 1;
        if (n > totalCount) n = totalCount;
        if (n < 1) n = 1;
        sumCountInput.value = n;
        // count 变了就让用户重新生成，避免 coveredMsgIds 跟实际 N 不符
        if (summaryState) {
            summaryState = null;
            genBtn.textContent = '生成小总结';
        }
    });
    genBtn.addEventListener('click', async () => {
        let n = parseInt(sumCountInput.value) || defaultCount;
        if (n > totalCount) n = totalCount;
        if (n < 1) n = 1;
        genBtn.disabled = true; genBtn.textContent = '生成中...';
        try {
            const r = await TavernSync.summarizeUnpushedSlice(binding, { mode: 'lastN', count: n });
            summaryState = { text: r.text, coveredMsgIds: r.coveredMsgIds };
            sumText.value = r.text;
            genBtn.textContent = `重新生成（已覆盖 ${r.coveredCount} 条）`;
        } catch (e) {
            showToast(`${e.message}`);
            genBtn.textContent = '生成小总结';
        } finally { genBtn.disabled = false; }
    });

    modal.querySelector('#push-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    modal.querySelector('#push-confirm').addEventListener('click', async () => {
        const confirmBtn = modal.querySelector('#push-confirm');
        confirmBtn.textContent = '推送中...'; confirmBtn.disabled = true;
        try {
            if (mode === 'summary') {
                const finalText = (sumText.value || '').trim();
                if (!finalText) { showToast('请先生成或填入总结文本'); confirmBtn.textContent = '确认推送'; confirmBtn.disabled = false; return; }
                // 优先用生成时锁定的 coveredMsgIds；用户没生成（直接手写）时按当前 N 取最近 N 条
                let coveredMsgIds, coveredCount;
                if (summaryState && Array.isArray(summaryState.coveredMsgIds) && summaryState.coveredMsgIds.length) {
                    coveredMsgIds = summaryState.coveredMsgIds;
                    coveredCount = coveredMsgIds.length;
                } else {
                    let n = parseInt(sumCountInput.value) || defaultCount;
                    if (n > totalCount) n = totalCount;
                    if (n < 1) n = 1;
                    coveredMsgIds = allMsgs.slice(-n).map(m => m.id);
                    coveredCount = n;
                }
                // 第三参传 null → 不更新 lastPushedMsgId（手动模式不追踪）
                const r = await TavernSync.pushSummaryToTavern(binding, finalText, null, coveredMsgIds);
                if (r.pushed > 0) {
                    try { window.webkit?.messageHandlers?.tavernPushDone?.postMessage({ message: r.message }); } catch {}
                }
                showToast(`已推送小总结 · 覆盖 ${coveredCount} 条（未更新追踪）`);
                overlay.remove();
            } else {
                const pushCount = parseInt(countInput.value) || defaultCount;
                // 手动原始推送不追踪基准点，保留反悔余地
                const r = await TavernSync.pushToTavern(binding, pushCount, false);
                if (r.pushed > 0 || r.deleted) {
                    try {
                        var payload = r.message ? { message: r.message } : { reload: true };
                        window.webkit?.messageHandlers?.tavernPushDone?.postMessage(payload);
                    } catch {}
                }
                showToast(`已推送 ${r.pushed} 条消息到酒馆（未更新追踪）${r.deleted ? '；已同步删除' : ''}`);
                overlay.remove();
            }
        } catch (e) {
            showToast(`${e.message}`);
            confirmBtn.textContent = '确认推送'; confirmBtn.disabled = false;
        }
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
            <div style="font-size:11px; color:#888; margin-top:4px;">留空 = 不限。例如最小0最大4 = 只对最近5条生效；最小5留空 = 只对第6条及更早的生效</div>
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
                    <option value="__active__">当前激活的人设</option>
                    ${opts}
                </select>
                <textarea id="ic-mypersona" style="${TS.input} height:80px; resize:vertical; margin-top:6px; font-size:12px;" placeholder="选择人设后显示内容..."></textarea>
                <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px;">
                    <input type="checkbox" id="ic-mypersona-check" checked> 导入用户人设
                </label>
            </div>`;
    }

    modal.innerHTML = `
        <h3 style="margin:0 0 16px; font-size:16px; font-weight:600;">导入设定：${result.charName}</h3>
        ${result.charPersona ? `
            <div style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <label style="${TS.label} margin-bottom:0;">角色人设</label>
                    ${hasPersona ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
                </div>
                <textarea id="ic-persona" style="${TS.input} height:120px; resize:vertical; margin-top:4px; font-size:12px;">${result.charPersona}</textarea>
                <label style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:13px;">
                    <input type="checkbox" id="ic-persona-check" checked> 导入角色人设
                </label>
            </div>` : '<div style="color:#888; font-size:13px; margin-bottom:12px;">酒馆角色无人设描述</div>'}
        ${userPersonaHTML}
        ${result.postHistory ? `
            <div style="margin-bottom:12px;">
                <label style="${TS.label}">Post History Instructions</label>
                <textarea id="ic-posthistory" style="${TS.input} height:60px; resize:vertical; font-size:12px;" readonly>${result.postHistory}</textarea>
                <div style="font-size:11px; color:#888; margin-top:4px;">（仅供参考，不自动导入）</div>
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

// ========== 世界书弹窗（角色世界书 + 聊天世界书） ==========
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
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:80vh; display:flex; flex-direction:column;';

    const tabsHTML = sources.length > 1
        ? sources.map((src, i) => `<button class="wb-tab" data-tab="${i}" style="padding:6px 12px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:${i === 0 ? 'rgba(255,255,255,0.15)' : 'transparent'}; color:inherit; font-size:12px; cursor:pointer;">${src.type}(${src.entries.length})</button>`).join('')
        : '';

    const bound = binding.boundWorldBook || null;
    const boundUidSet = bound ? new Set(bound.entryUids || []) : null;
    const boundHint = bound
        ? `<div style="font-size:11px; color:#888; margin-bottom:6px;">已绑定 ${bound.entryUids.length} 条（${bound.sourceName}）· 自动同步酒馆时会跟着刷新</div>`
        : `<div style="font-size:11px; color:#888; margin-bottom:6px;">勾选条目后点"绑定记忆"，每次同步酒馆都会自动跟着刷新内容</div>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 8px; font-size:16px; font-weight:600;">世界书</h3>
        ${tabsHTML ? `<div style="display:flex; gap:6px; margin-bottom:10px; flex-wrap:wrap;">${tabsHTML}</div>` : ''}
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-select-all" style="padding:4px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:12px; cursor:pointer;">全选</button>
            <button id="wb-select-enabled" style="padding:4px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:12px; cursor:pointer;">仅已启用</button>
        </div>
        <div id="wb-entries" style="flex:1; overflow-y:auto; margin-bottom:8px;"></div>
        ${boundHint}
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-bind" style="flex:1; ${TS.btnG}">${bound ? '更新绑定' : '绑定记忆'}</button>
            <button id="wb-import" style="flex:1; ${TS.btnB}">添加到世界书</button>
        </div>
        ${bound ? `<button id="wb-unbind" style="width:100%; padding:8px; border-radius:8px; border:1px solid rgba(244,67,54,0.4); background:transparent; color:#f44; font-size:12px; cursor:pointer; margin-bottom:8px;">解除绑定</button>` : ''}
        <button id="wb-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,0.15); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    let currentSourceIdx = 0;
    function renderEntries(srcIdx) {
        currentSourceIdx = srcIdx;
        const src = sources[srcIdx];
        const entries = src.entries;
        // 绑定来源匹配当前 tab 时，按 boundUidSet 勾选；否则默认按是否禁用
        const matchesBound = bound && (
            (bound.sourceType === 'chat' && /聊天/.test(src.type)) ||
            (bound.sourceType === 'char' && /角色/.test(src.type))
        );
        const container = modal.querySelector('#wb-entries');
        container.innerHTML = entries.map((e, i) => {
            const checked = matchesBound ? boundUidSet.has(e.uid) : !e.disabled;
            return `
            <label style="display:flex; align-items:flex-start; gap:8px; padding:8px; background:rgba(255,255,255,0.04); border-radius:8px; margin-bottom:4px; cursor:pointer; ${e.disabled ? 'opacity:0.5;' : ''}">
                <input type="checkbox" data-idx="${i}" ${checked ? 'checked' : ''} style="flex-shrink:0; margin-top:2px;">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:13px; font-weight:500;">${e.comment}${e.disabled ? ' (禁用)' : ''}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${e.content.substring(0, 80)}...</div>
                </div>
            </label>`;
        }).join('');
        modal.querySelectorAll('.wb-tab').forEach((t, i) => t.style.background = i === srcIdx ? 'rgba(255,255,255,0.15)' : 'transparent');
    }
    // 若已有绑定，初始切到对应 tab；否则默认 0
    let initIdx = 0;
    if (bound) {
        const findIdx = sources.findIndex(s =>
            (bound.sourceType === 'chat' && /聊天/.test(s.type)) ||
            (bound.sourceType === 'char' && /角色/.test(s.type))
        );
        if (findIdx >= 0) initIdx = findIdx;
    }
    renderEntries(initIdx);

    modal.querySelectorAll('.wb-tab').forEach(tab => tab.addEventListener('click', () => renderEntries(parseInt(tab.dataset.tab))));

    function getSelectedEntries() {
        const cbs = modal.querySelectorAll('#wb-entries input[type=checkbox]:checked');
        return [...cbs].map(cb => sources[currentSourceIdx].entries[parseInt(cb.dataset.idx)]);
    }
    modal.querySelector('#wb-select-all').addEventListener('click', () => modal.querySelectorAll('#wb-entries input[type=checkbox]').forEach(cb => cb.checked = true));
    modal.querySelector('#wb-select-enabled').addEventListener('click', () => {
        const entries = sources[currentSourceIdx].entries;
        modal.querySelectorAll('#wb-entries input[type=checkbox]').forEach((cb, i) => cb.checked = !entries[i].disabled);
    });

    modal.querySelector('#wb-bind').addEventListener('click', async () => {
        const cbs = modal.querySelectorAll('#wb-entries input[type=checkbox]:checked');
        const selected = [...cbs].map(cb => sources[currentSourceIdx].entries[parseInt(cb.dataset.idx)]);
        if (!selected.length) { showToast('请勾选条目'); return; }
        selected.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const memoryText = selected.map(e => { let t = ''; if (e.comment) t += `[${e.comment}]\n`; t += e.content; return t; }).join('\n\n---\n\n');

        // 写入 binding：记下 source 和 entry uids，下次 pullFromTavern 自动按这套刷新
        const srcType = /聊天/.test(sources[currentSourceIdx].type) ? 'chat' : 'char';
        binding.boundWorldBook = {
            sourceType: srcType,
            sourceName: sources[currentSourceIdx].name,
            entryUids: selected.map(e => e.uid),
        };
        char.tavernWorldMemory = { lastSync: Date.now(), entryCount: selected.length, source: sources[currentSourceIdx].name, content: memoryText, bound: true };
        await TavernSync.saveConfig(TavernSync.getConfig());
        await saveData();
        showToast(`已绑定 ${selected.length} 条 · 之后同步酒馆会自动刷新`);
        overlay.remove();
    });

    if (bound) {
        modal.querySelector('#wb-unbind').addEventListener('click', async () => {
            delete binding.boundWorldBook;
            await TavernSync.saveConfig(TavernSync.getConfig());
            showToast('已解除绑定（已注入的记忆保留，不再自动刷新）');
            overlay.remove();
        });
    }

    modal.querySelector('#wb-import').addEventListener('click', async () => {
        const selected = getSelectedEntries();
        if (!selected.length) { showToast('请勾选条目'); return; }
        const categoryName = char.remarkName || char.realName || char.name || sources[currentSourceIdx].name;
        let addedCount = 0;
        for (const e of selected) {
            const newWb = { id: `wb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: e.comment || '未命名', content: e.content, position: (e.position === 0) ? 'before' : 'after', category: categoryName };
            db.worldBooks.push(newWb);
            if (!char.worldBookIds) char.worldBookIds = [];
            if (!char.worldBookIds.includes(newWb.id)) char.worldBookIds.push(newWb.id);
            addedCount++;
        }
        await saveData(); showToast(`已添加 ${addedCount} 条世界书（分类: ${categoryName}）`);
    });

    modal.querySelector('#wb-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ========== 清空并重选范围弹窗 ==========
// 删掉这个角色在小手机里的全部酒馆楼层，然后让用户填从酒馆第几楼到第几楼重新导入（或者只同步以后的新楼层）
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
        <div style="font-size:13px; line-height:1.7; margin-bottom:12px;">
            小手机里现在有 <b>${have}</b> 楼酒馆剧情，会全部删掉。<br>
            酒馆里这个聊天一共 <b>${info.total}</b> 楼（第 0 ~ ${lastFloor} 楼，和酒馆里楼层的 # 号一致）。
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:14px;">
            从第 <input type="number" id="rr-start" min="0" max="${lastFloor}" value="${defStart}" style="${numStyle}">
            到第 <input type="number" id="rr-end" min="0" max="${lastFloor}" value="${lastFloor}" style="${numStyle}"> 楼
        </div>
        <div style="font-size:11px; color:#888; line-height:1.6; margin-bottom:16px;">
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

// ========== 提示词预览弹窗 ==========
// 显示 AI 实际会收到的酒馆相关内容（不截断，可滚动）：
//   - 系统提示词里的：世界设定 + 线下剧情说明
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
    if (promptBlock) sections.push({ title: '系统提示词里（世界设定 / 线下剧情说明）', content: promptBlock, color: '#FF9800' });

    // 和 yuan 发消息时一样：取最近“记忆条数”条聊天记录，再经过 filterHistoryForAI（已被补丁接管，会做原文/摘要处理）
    const maxMemory = Number(char.maxMemory) || 20;
    let slice = (char.history || []).slice(-maxMemory);
    if (typeof window.filterHistoryForAI === 'function') {
        try { slice = window.filterHistoryForAI(char, slice); } catch (e) { TavernSync.reportIssue('预览时处理聊天记录失败：' + e.message); }
    }
    const tavernViews = slice.filter(m => m && m.__tavernView);
    const totalFloors = (char.history || []).filter(m => m && m.fromTavern).length;
    const labels = { raw: '原文', summary: '摘要', 'raw-nosummary': '原文（还没有摘要）' };
    const colors = { raw: '#2196F3', summary: '#4CAF50', 'raw-nosummary': '#FF7043' };
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
                    ${s.meta ? `<div style="font-size:11px; color:#888; margin-bottom:6px;">${esc(s.meta)}</div>` : ''}
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
            <select id="be-uwu" style="${TS.input}">${db.characters.map(c => `<option value="${c.id}">${c.remarkName || c.name}</option>`).join('')}</select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">酒馆角色</label>
            <select id="be-st" style="${TS.input}">${stCharacters.map(c => `<option value="${c.avatar}">${c.name}</option>`).join('')}</select></div>
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
['pushToTavern', 'pushSummaryToTavern', 'pushCallRecordToTavern', 'pullFromTavern', 'replaceRegeneratedInTavern', 'resetImportRange', 'removePushedFromTavern'].forEach(name => {
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

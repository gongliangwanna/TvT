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
        TavernSync.reportIssue('读到的柏宝书摘要格式和预期不同，可能是柏宝书更新改了格式。这些楼层会先发原文，需要调整 tavern_sync.js 的 readBaibaiSummary。');
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

// 一楼酒馆消息“酒馆原本的正文”：合并进这一楼的小手机内容（最后那段 <phone_chat>）去掉。还没过清洗规则
function floorBody(m) {
    if (!m || typeof m.mes !== 'string') return '';
    return (m.extra && m.extra.from_uwu) ? stripOwnPhoneBlock(m.mes) : m.mes.trim();
}

// 认楼层靠「发送时间 + 是不是你发的 + AI 开始写的时间」。酒馆的发送时间只精确到分钟，你发的楼层又没有“开始写的时间”，
// 所以同一分钟里你连发两楼时，这两楼长得一模一样，以前第二楼会被当成“已经导入过”，永远进不来。
// 这里给长得一样的楼层按先后编个序号（第 0 个、第 1 个……），认楼层时连序号一起比。
// 序号记在消息身上一个“不会被保存”的地方（不可枚举），整份聊天存回酒馆时不会带进去。
// list 必须是去掉开头设置行之后的完整楼层表（每次从酒馆读回来都要先调一次）。
function tagFloorNth(list) {
    const seen = new Map();
    (Array.isArray(list) ? list : []).forEach(m => {
        if (!m || typeof m !== 'object') return;
        const k = String(m.send_date) + '|' + (m.is_user ? 1 : 0) + '|' + String(m.gen_started || '');
        const n = seen.get(k) || 0;
        seen.set(k, n + 1);
        try { Object.defineProperty(m, '__uwuNth', { value: n, enumerable: false, configurable: true, writable: true }); }
        catch (e) { /* 冻结的对象标不上就算了，退回不比序号 */ }
    });
    return list;
}

const TavernSync = {
    // 文件版本：显示在“酒馆互联”页面最下面，用来确认手机上加载的是不是最新文件（浏览器有时会用缓存的旧文件）
    SYNC_VERSION: '2026-09-22 h',
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
    // 每次连接酒馆最多等这么久。写酒馆的操作是排队一个个做的，某一次请求卡住不返回的话（手机网络不好时会这样），
    // 后面所有推送、同步都会一直等着，看起来就像“自动推送突然不工作了”。超时就报错，让队伍接着往下走
    // 时间从发出请求算到内容全部下载完（parse 读完内容才算结束）。基础 60 秒；
    // 推送时要把整份酒馆聊天传回去，聊天很长、手机网络又慢时正常上传也可能超过 60 秒，
    // 所以要传的内容每多 1MB 再多给 FETCH_TIMEOUT_PER_MB_MS（否则大聊天会每次都被当成超时，推送永远失败）
    FETCH_TIMEOUT_MS: 60 * 1000,
    FETCH_TIMEOUT_PER_MB_MS: 50 * 1000,
    async _fetchWithTimeout(url, opts = {}, parse = null) {
        if (typeof AbortController !== 'function') {
            const resp = await fetch(url, opts);
            return parse ? parse(resp) : resp;
        }
        const ctrl = new AbortController();
        // 中文一个字上传时占 3 个字节，按字数 × 3 保守估大小（宁可多等，不能把正常的大上传当成超时）
        const bodyMB = typeof opts.body === 'string' ? opts.body.length * 3 / (1024 * 1024) : 0;
        const limit = this.FETCH_TIMEOUT_MS + Math.ceil(bodyMB * this.FETCH_TIMEOUT_PER_MB_MS);
        const timer = setTimeout(() => ctrl.abort(), limit);
        try {
            const resp = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
            return parse ? await parse(resp) : resp;
        } catch (e) {
            if (ctrl.signal.aborted) throw new Error(`连接酒馆超时（${Math.round(limit / 1000)} 秒没有回应），请检查网络后再试`);
            throw e;
        } finally {
            clearTimeout(timer);
        }
    },
    async _getCsrfToken() {
        if (this._csrfToken) return this._csrfToken;
        try {
            const r = await this._fetchWithTimeout('/csrf-token', { credentials: 'same-origin' });
            if (r.ok) {
                const j = await r.json();
                this._csrfToken = j.token || '';
            }
        } catch (e) { console.warn('[TavernSync] 获取 CSRF token 失败:', e.message); }
        return this._csrfToken || '';
    },
    async _stFetch(url, opts = {}, parse = null) {
        const token = await this._getCsrfToken();
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (token) headers['X-CSRF-Token'] = token;
        return this._fetchWithTimeout(url, Object.assign({ credentials: 'same-origin' }, opts, { headers }), parse);
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
        // 读内容也算在超时里（见 _fetchWithTimeout）
        const data = await this._stFetch(`${endpoint}`, { method: 'POST', body: JSON.stringify(body) }, (resp) => {
            if (resp.status === 403) throw new Error('未登录或会话过期，请刷新页面');
            if (!resp.ok) throw new Error(`API ${resp.status}`);
            return resp.json();
        });
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
                // 酒馆页面办完了小手机托它办的事（见 _askTavernPage，比如新建用户人设）
                if (d && d.type === 'page-answer' && d.id && this._pageAsks && this._pageAsks.has(d.id)) {
                    this._pageAsks.get(d.id)(d);
                    this._pageAsks.delete(d.id);
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

    // “被小总结推过的消息名单”（binding.summarizedIds）：和上面那份分开记，因为它们在酒馆里是一段总结、不是原文，
    // 不能算进“丢了要补推原文”。重新生成时靠它（和上面那份一起）判断旧回复在不在酒馆里
    _rememberSummarized(binding, ids) {
        if (!ids || !ids.length) return;
        const set = new Set(Array.isArray(binding.summarizedIds) ? binding.summarizedIds : []);
        ids.forEach(id => set.add(id));
        binding.summarizedIds = [...set];
    },

    // 这些消息有没有可能在酒馆里（推过原文、做成过小总结、最近推过、或者正是“上次推到的那一条”）。
    // 只查小手机自己的记录，不连酒馆：重新生成时旧回复从没推送过，就不用去酒馆替换，连不上酒馆也不会报错
    mayBeInTavern(binding, ids) {
        if (!binding || !ids || !ids.length) return false;
        const known = new Set([
            ...(Array.isArray(binding.pushedIds) ? binding.pushedIds : []),
            ...(Array.isArray(binding.summarizedIds) ? binding.summarizedIds : []),
        ]);
        (Array.isArray(binding.recentPushes) ? binding.recentPushes : []).forEach(x => (x && Array.isArray(x.ids) ? x.ids : []).forEach(id => known.add(id)));
        if (binding.lastPushedMsgId) known.add(binding.lastPushedMsgId);
        return ids.some(id => known.has(id));
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
        if (Array.isArray(binding.summarizedIds)) binding.summarizedIds = binding.summarizedIds.filter(id => !ids.has(id));
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

        // 推送时已经读过酒馆聊天的，直接用那一份（opts.stMsgs），不再下载一遍
        const stMsgs = opts.stMsgs || await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
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
            const doing = d.busyReason === 'editing' ? '你正在酒馆里编辑某一楼'
                : (d.busyReason === 'summary' ? '柏宝书刚写完摘要、正要存盘' : '酒馆正在生成回复');
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
    // 规则可以分组（rule.group，空 = 不分组）。整组关掉（config.ruleGroupsOff 里有组名）时组里的规则都不起作用。
    // 起作用的顺序和页面上显示的一样：不分组的在最前，然后各组按第一次出现的先后，组内按原来的先后。
    orderedCleanRules(config) {
        const rules = (config || this.getConfig()).cleanRules || [];
        const groups = [];
        rules.forEach(r => { const g = r.group || ''; if (g && !groups.includes(g)) groups.push(g); });
        return [...rules.filter(r => !r.group), ...groups.flatMap(g => rules.filter(r => r.group === g))];
    },

    ruleGroupsOf(config) {
        const groups = [];
        ((config || this.getConfig()).cleanRules || []).forEach(r => { if (r.group && !groups.includes(r.group)) groups.push(r.group); });
        return groups;
    },

    // 两条规则算重复：正则、模式、用在哪头都一样
    sameCleanRule(a, b) {
        return a.regex === b.regex && (a.mode || 'exclude') === (b.mode || 'exclude') && (a.scope || 'both') === (b.scope || 'both');
    },

    // 导出：ids = 要导出的规则编号（null 导出全部），按页面上的顺序
    exportCleanRules(ids) {
        const cfg = this.getConfig();
        const pick = ids ? new Set(ids) : null;
        const rules = this.orderedCleanRules(cfg).filter(r => !pick || pick.has(r.id));
        const groups = [...new Set(rules.map(r => r.group).filter(Boolean))];
        return {
            type: 'uwu-tavern-clean-rules', version: 1,
            rules: rules.map(r => {
                const o = { name: r.name || '未命名', regex: r.regex, mode: r.mode || 'exclude', scope: r.scope || 'both', enabled: r.enabled !== false };
                if (r.group) o.group = r.group;
                return o;
            }),
            groupsOff: (cfg.ruleGroupsOff || []).filter(g => groups.includes(g)),
        };
    },

    // 多选后的批量操作：action = 'enable' / 'disable' / 'move'（group：'' = 不分组）/ 'delete'，返回处理了几条。
    // 移动时按页面上的先后挪到末尾，排在目标分组最后。
    async batchCleanRules(ids, action, group) {
        const cfg = this.getConfig();
        if (!Array.isArray(cfg.cleanRules)) cfg.cleanRules = [];
        const pick = new Set(ids);
        const hit = this.orderedCleanRules(cfg).filter(r => pick.has(r.id));
        if (action === 'enable' || action === 'disable') hit.forEach(r => { r.enabled = action === 'enable'; });
        else if (action === 'delete') cfg.cleanRules = cfg.cleanRules.filter(r => !pick.has(r.id));
        else if (action === 'move') {
            cfg.cleanRules = cfg.cleanRules.filter(r => !pick.has(r.id));
            hit.forEach(r => { if (group) r.group = group; else delete r.group; cfg.cleanRules.push(r); });
        } else return 0;
        const left = this.ruleGroupsOf(cfg);
        cfg.ruleGroupsOff = (cfg.ruleGroupsOff || []).filter(x => left.includes(x));
        await this.saveConfig(cfg);
        return hit.length;
    },

    // 读导入文件。只认小手机（酒馆互联）自己导出的文件，别的抛错。
    parseCleanRulesFile(text) {
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('文件不是有效的 JSON'); }
        if (!data || data.type !== 'uwu-tavern-clean-rules' || !Array.isArray(data.rules)) throw new Error('不是酒馆互联导出的正则文件');
        const rules = data.rules.filter(r => r && typeof r.regex === 'string' && r.regex).map(r => {
            const o = {
                name: String(r.name || '未命名'), regex: r.regex,
                mode: r.mode === 'extract' ? 'extract' : 'exclude',
                scope: ['pull', 'push', 'both'].includes(r.scope) ? r.scope : 'both',
                enabled: r.enabled !== false,
            };
            if (typeof r.group === 'string' && r.group.trim()) o.group = r.group.trim();
            try { new RegExp(o.regex); } catch (e) { o.invalid = true; }
            return o;
        });
        return { rules, groupsOff: Array.isArray(data.groupsOff) ? data.groupsOff.filter(g => typeof g === 'string') : [] };
    },

    // 每条是不是重复：和现有规则一样，或者和文件里前面某条一样
    markDuplicateRules(list) {
        const existing = this.getConfig().cleanRules || [];
        return list.map((r, i) => existing.some(e => this.sameCleanRule(e, r)) || list.slice(0, i).some(p => this.sameCleanRule(p, r)));
    },

    // 把选中的规则加进来。target：'__file__' = 照文件里的分组（同名分组已有就放进去），'' = 不分组，其余 = 放进这个分组。
    // 文件里关着的分组，只在这次新建出来时才关；已有的分组开关不动。重复的跳过。
    async importCleanRules(list, target, fileGroupsOff) {
        const cfg = this.getConfig();
        if (!Array.isArray(cfg.cleanRules)) cfg.cleanRules = [];
        const before = new Set(this.ruleGroupsOf(cfg));
        let added = 0, skipped = 0;
        list.forEach((r, i) => {
            if (r.invalid) return;
            if (cfg.cleanRules.some(e => this.sameCleanRule(e, r))) { skipped++; return; }
            const rule = { id: `rule_${Date.now()}_${i}`, name: r.name, regex: r.regex, mode: r.mode, scope: r.scope, enabled: r.enabled };
            const g = target === '__file__' ? (r.group || '') : (target || '');
            if (g) rule.group = g;
            cfg.cleanRules.push(rule);
            added++;
        });
        if (target === '__file__') {
            const off = new Set(cfg.ruleGroupsOff || []);
            (fileGroupsOff || []).forEach(g => { if (!before.has(g) && this.ruleGroupsOf(cfg).includes(g)) off.add(g); });
            cfg.ruleGroupsOff = [...off];
        }
        await this.saveConfig(cfg);
        return { added, skipped };
    },

    // 同步那一头现在起作用的规则的指纹。卡片上记着清洗时用的指纹（tavern.rulesHash），
    // 和现在的对不上 = 你后来改过规则，同步时按现在的规则重新清洗（见 pullFromTavern 第 2.5 步）
    pullRulesHash() {
        const cfg = this.getConfig();
        const off = new Set(cfg.ruleGroupsOff || []);
        const eff = this.orderedCleanRules(cfg).filter(r => r.enabled && !(r.group && off.has(r.group))
            && (!r.scope || r.scope === 'both' || r.scope === 'pull')).map(r => [r.regex, r.mode === 'extract' ? 'extract' : 'exclude']);
        return this.textHash(JSON.stringify(eff));
    },

    applyCleanRules(text, direction) {
        if (!text || typeof text !== 'string') return '';
        const config = this.getConfig();
        const off = new Set(config.ruleGroupsOff || []);
        const rules = this.orderedCleanRules(config).filter(r => r.enabled && !(r.group && off.has(r.group))
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
        const floors = tagFloorNth(raw.slice(offset)).map((m, floor) => ({ m, floor }));
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

        // 0.5 以前导入、还没记“先后序号”的卡片补上序号（见 tagFloorNth）。
        //     同一分钟里连发的两楼以前可能各有一张卡：按楼层号对上，对不上就按先后分配，免得两张卡都认成第一楼
        {
            const needNth = char.history.filter(h => ofThisChat(h) && h.tavern.nth === undefined)
                .sort((a, b) => (a.tavern.floor || 0) - (b.tavern.floor || 0));
            const used = new Set();
            needNth.forEach(h => {
                const all = findCandidate.all(h.tavern);
                const pick = all.find(c => !used.has(c) && c.floor === h.tavern.floor) || all.find(c => !used.has(c));
                if (!pick) return;
                used.add(pick);
                h.tavern.nth = pick.m.__uwuNth;
            });
        }

        // 0.6 精简时收走的 user 楼（AI 卡片上的 roundUsers 记号）核对一遍：
        //     那楼在酒馆里被删了、或者现在已经不属于这一回合了，记号就作废。
        //     不然旧记号会把同一分钟里另一楼长得一样的 user 挡住，那一楼永远同步不进来（随机测试测出来的）。
        //     还在的顺便更新楼层号和先后序号（前面删了楼会变）
        char.history.forEach(h => {
            if (!ofThisChat(h) || !Array.isArray(h.tavern.roundUsers) || !h.tavern.roundUsers.length) return;
            const owner = findCandidate(h.tavern);
            if (!owner) return;
            const used = new Set();
            h.tavern.roundUsers = h.tavern.roundUsers.map(u => {
                const hit = findCandidate(u);
                if (!hit || used.has(hit) || roundAiFor(hit.floor) !== owner.floor) return null;
                used.add(hit);
                return Object.assign({}, u, { floor: hit.floor, nth: hit.m.__uwuNth });
            }).filter(Boolean);
        });

        const imported = char.history.filter(ofThisChat);

        // 1. 找出要导入的楼层：从“起点楼层”（第一次同步时导入的最早一楼）往后，所有小手机里还没有的楼层。
        //    所以在小手机里删掉的酒馆楼层，下次同步会重新出现。
        //    从没导入过：起点 = 最近“第一次同步导入楼数”楼中最早的一楼。
        //    换绑了另一个酒馆聊天时，旧的起点作废（小手机里已经有这个聊天的卡片时，从最早那张接着来）
        let start = (sameChat && prevMemory.importStart)
            || (imported[0] && { sendDate: imported[0].tavern.sendDate, isUser: imported[0].tavern.isUser, floor: imported[0].tavern.floor,
                genStarted: imported[0].tavern.genStarted, nth: imported[0].tavern.nth });
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
                start = this._markerOf(first.m, first.floor);
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
            this.reportIssue(`有 ${unreadable.length} 楼酒馆楼层的时间读不懂（例如“${unreadable[0]}”），这些楼会排在前一楼后面。需要调整 tavern_sync.js 的 parseTimeValue。`);
        }

        let now = Date.now();
        let importedCount = 0;
        const rulesHash = this.pullRulesHash();
        for (const c of newOnes) {
            const { m, floor, time } = c;
            // 合并到这一楼的小手机内容（最后那段 <phone_chat>）去掉，只保留酒馆原本的内容
            const body = floorBody(m);
            const cleaned = this.applyCleanRules(body, 'pull');
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
                    nth: m.__uwuNth,
                    isUser: !!m.is_user,
                    name: m.is_user ? (char.myName || m.name || '我') : (char.realName || m.name || char.name),
                    roundAi: roundAiFor(floor),
                    summary: readBaibaiSummary(m),
                    // 两个指纹，用来发现“酒馆里改了这一楼的字”（见下面第 2.5 步）：
                    //   rawHash   酒馆这一楼原本的正文（清洗前）
                    //   localHash 写进小手机的内容（和现在的对不上 = 你在小手机里改过）
                    rawHash: this.textHash(body),
                    localHash: this.textHash(cleaned),
                    rulesHash,           // 清洗时用的规则（改了规则后同步时会重新清洗）
                },
            });
            importedCount++;
        }

        // 2. 柏宝书的摘要通常比回复晚一步写好：把之前导入、当时还没有摘要（或摘要已更新）的楼层补上；
        //    柏宝书把摘要撤掉了（或属于另一个抽卡版本）的，小手机里也清掉，免得发给 AI 的是作废的摘要。
        //    顺便更新楼层号（酒馆里删了楼之后，后面的楼层号会往前挪）和所属回合
        let summariesFilled = 0, summariesCleared = 0, contentUpdated = 0, recleaned = 0;
        const editedBoth = [];    // 酒馆里改了、你在小手机里也改过的楼层号（不覆盖，提示一次）
        const editedRules = [];   // 改了规则、但你在小手机里改过字的楼层号（不覆盖，提示一次）
        for (const h of char.history) {
            if (!ofThisChat(h)) continue;
            const found = findCandidate(h.tavern);
            if (!found) continue;
            // 时间每次都按酒馆现在的楼层表重新算，不能只在导入时算一次：同一分钟里的楼层会被“抬”到和前一楼一样，
            // 前一楼后来在酒馆里被删了的话，旧卡片还留着按已删楼层算的时间，和新导入的楼一比顺序就乱了（随机测试测出来的）
            if (found.time != null && h.tavern.time !== found.time) h.tavern.time = found.time;
            if (h.tavern.floor !== found.floor) h.tavern.floor = found.floor;
            h.tavern.roundAi = roundAiFor(found.floor);   // 所属回合（酒馆后来才回复的，这时候才算得出来）
            if (h.tavern.genStarted === undefined) h.tavern.genStarted = String(found.m.gen_started || '');

            // 2.5 酒馆里改了这一楼的字 → 小手机里跟着改（以前只补摘要，正文永远是导入那一刻的）。
            //     和人设、世界书的自动更新同一个规矩：你在小手机里也改过的不覆盖，在页面顶部提示一次。
            //     已精简的楼层正文就是摘要，不在这里管（取回原文时会重新读酒馆）。
            if (!h.tavern.trimmed) {
                const body = floorBody(found.m);
                const bh = this.textHash(body);
                if (h.tavern.rawHash === undefined) {
                    // 这次更新之前导入的卡片还没有指纹：以酒馆为准对齐一次，之后照常比对
                    const cleaned = this.applyCleanRules(body, 'pull');
                    if (cleaned && cleaned !== h.content) { h.content = cleaned; h.parts = []; contentUpdated++; }
                    h.tavern.rawHash = bh;
                    h.tavern.localHash = this.textHash(h.content || '');
                    h.tavern.rulesHash = rulesHash;
                } else if (h.tavern.rawHash !== bh) {
                    const cleaned = this.applyCleanRules(body, 'pull');
                    const phoneUnchanged = this.textHash(h.content || '') === h.tavern.localHash;
                    if (!cleaned) {
                        h.tavern.rawHash = bh;              // 酒馆里改完清洗后是空的：小手机这边不动
                    } else if (phoneUnchanged || h.content === cleaned) {
                        if (h.content !== cleaned) { h.content = cleaned; h.parts = []; contentUpdated++; }
                        h.tavern.rawHash = bh;
                        h.tavern.localHash = this.textHash(cleaned);
                        h.tavern.rulesHash = rulesHash;
                        delete h.tavern.keptHash;
                    } else if (h.tavern.keptHash !== bh) {
                        h.tavern.keptHash = bh;             // 同一次改动只提示一次
                        editedBoth.push(h.tavern.floor);
                    }
                } else if (h.tavern.rulesHash !== rulesHash) {
                    // 酒馆里没改，但你后来改过清洗规则（没有记录的旧卡片也算）：按现在的规则重新清洗。
                    // 在小手机里改过字的不覆盖、提示一次；清洗后是空的不动（和上面酒馆改字时一样）。
                    // 不管哪种情况都记下现在的规则，同一次改动只处理一次。
                    const cleaned = this.applyCleanRules(body, 'pull');
                    const phoneUnchanged = this.textHash(h.content || '') === h.tavern.localHash;
                    if (cleaned && cleaned !== h.content) {
                        if (phoneUnchanged) {
                            h.content = cleaned; h.parts = [];
                            h.tavern.localHash = this.textHash(cleaned);
                            recleaned++;
                        } else if (h.tavern.rulesHash !== undefined) {
                            editedRules.push(h.tavern.floor);   // 旧卡片第一次补记录时不提示（说不准是不是规则改过）
                        }
                    }
                    h.tavern.rulesHash = rulesHash;
                }
            }
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
        if (editedBoth.length) {
            const ch = db.characters.find(c => c.id === binding.uwuCharId);
            const nums = editedBoth.slice(0, 5).join('、') + (editedBoth.length > 5 ? ` 等 ${editedBoth.length} 楼` : '');
            this.reportIssue(`「${ch ? (ch.remarkName || ch.name) : '这个角色'}」的酒馆第 ${nums} 楼在酒馆里改过字，但你在小手机里也改过这几楼，没有自动更新；如果想用酒馆的版本，在小手机里长按删掉这几张卡片，再点「同步酒馆剧情」重新导入。`);
        }
        if (editedRules.length) {
            const ch = db.characters.find(c => c.id === binding.uwuCharId);
            const nums = editedRules.slice(0, 5).join('、') + (editedRules.length > 5 ? ` 等 ${editedRules.length} 楼` : '');
            this.reportIssue(`正则清洗规则改过了，但「${ch ? (ch.remarkName || ch.name) : '这个角色'}」的酒馆第 ${nums} 楼你在小手机里改过字，没有按新规则重新清洗；如果想按新规则来，在小手机里长按删掉这几张卡片，再点「同步酒馆剧情」重新导入。`);
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

        // 4. 打开了「双向自动更新复制过的世界书」时：酒馆里改了的更新到小手机，小手机里改了的推到酒馆
        let worldUpdated = 0;
        if (binding.autoUpdateWorldBooks) {
            try { worldUpdated = (await this.syncCopiedWorldBooks(binding)).updated; }
            catch (e) { this.reportIssue('双向自动更新世界书失败：' + e.message); }
        }

        // 4.5 打开了「双向自动更新人设」时：人设和头像，哪边改了就更新到另一边
        let personaUpdated = 0;
        if (binding.autoUpdatePersona) {
            try { personaUpdated = (await this.syncPersona(binding)).updated; }
            catch (e) { this.reportIssue('双向自动更新人设失败：' + e.message); }
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
        if (importedCount > 0 || reordered || removedGone > 0 || summariesFilled > 0 || summariesCleared > 0 || contentUpdated > 0 || recleaned > 0) {
            this._rerender(char);
        }
        // 顺便看看酒馆里是不是开了新聊天（出错不影响这次同步）
        try { await this._checkNewerChat(binding); } catch (e) { console.warn('[TavernSync] 检查酒馆新聊天失败:', e.message); }
        this._notifyData();
        return { imported: importedCount, summariesFilled, summariesCleared, reordered, worldUpdated, personaUpdated, autoTrimmed, removedGone, contentUpdated, recleaned, editedBoth: editedBoth.length };
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
        return { sendDate: m.send_date, isUser: !!m.is_user, floor, genStarted: String(m.gen_started || ''), nth: m.__uwuNth };
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
        const find = (t) => {
            const arr = t && map.get(String(t.sendDate) + '|' + (t.isUser ? 1 : 0));
            return arr ? arr.find(it => this._sameFloor(getMsg(it), t)) : undefined;
        };
        // 不看先后序号、把长得一样的全找出来（给旧卡片补序号时用）
        find.all = (t) => {
            const arr = t && map.get(String(t.sendDate) + '|' + (t.isUser ? 1 : 0));
            const loose = t ? Object.assign({}, t, { nth: undefined }) : t;
            return arr ? arr.filter(it => this._sameFloor(getMsg(it), loose)) : [];
        };
        return find;
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

    // 两张酒馆卡片是不是同一楼（同一个酒馆聊天、同一个身份）
    _sameCard(a, b) {
        const x = a && a.tavern, y = b && b.tavern;
        if (!x || !y) return false;
        return (x.chatFile || '') === (y.chatFile || '') && x.sendDate === y.sendDate && !!x.isUser === !!y.isUser
            && (x.genStarted === undefined || y.genStarted === undefined || x.genStarted === y.genStarted)
            && (x.nth === undefined || y.nth === undefined || x.nth === y.nth);
    },

    // 把暂时拿开的酒馆卡片放回聊天记录（重新生成、切换消息版本时用），再按时间排好。
    // 拿开期间可能正好自动同步了一次（比如 AI 回复时你切出去又切回来），同一楼已经被重新导入了一份：
    // 留下原来那张（摘要、精简记录都在它身上），删掉新导入的那份，免得同一段剧情出现两次。返回删掉了几张
    putBackFloors(char, floors) {
        if (!char || !Array.isArray(char.history) || !Array.isArray(floors) || !floors.length) return 0;
        const present = new Set(char.history);
        const back = floors.filter(f => f && !present.has(f));
        const dup = new Set(char.history.filter(m => m && m.fromTavern && back.some(f => this._sameCard(f, m))));
        if (dup.size) {
            const kept = char.history.filter(m => !dup.has(m));
            char.history.splice(0, char.history.length, ...kept);   // 原地换，保持 yuan 手里的引用有效
        }
        char.history.push(...back);
        this.placeTavernFloors(char);
        return dup.size;
    },

    // 读出酒馆这个聊天现在的楼层情况（给“清空并重选范围”弹窗用）
    //   total：酒馆里一共几楼（楼层号 0 ~ total-1，和酒馆界面上的 # 号一致）
    //   usable：其中会被导入的楼层（去掉小手机推送的、番外楼、空楼），每项 { floor, marker }
    async getTavernFloorInfo(binding) {
        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) return { total: 0, usable: [] };
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = tagFloorNth(raw.slice(offset));
        const usable = [];
        list.forEach((m, floor) => {
            if (!m || typeof m.mes !== 'string' || !m.mes.trim()) return;
            if (m.extra && (m.extra.uwu_created || m.extra.bbs_omit)) return;
            usable.push({ floor, marker: this._markerOf(m, floor) });
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
            // curGone：现在绑定的酒馆聊天在酒馆里已经不存在了（卡片上的提示按这个分两种写法）
            if (had === newest.file && !!binding.newerChat.curGone === !cur) return;
            binding.newerChat = { file: newest.file, time: newest.t, curGone: !cur };
            await this.saveConfig(this.getConfig());
            if (newest.file !== binding.dismissedChat && typeof showToast === 'function') {
                const ch = db.characters.find(c => c.id === binding.uwuCharId);
                showToast(`酒馆里「${ch ? (ch.remarkName || ch.name) : '这个角色'}」最近在玩另一个酒馆聊天文件，可以在「酒馆互联」的绑定卡片上改绑`);
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
        delete binding.summarizedIds;
        delete binding.newerChat;
        delete binding.keepInTavern;
        delete binding.bulkDeleteNotice;
        await this.saveConfig(this.getConfig());
        return true;
    },

    // ========== 原文精简（yuan 版新增）==========
    // “精简”＝ 旧楼层只留柏宝书摘要、把原文丢掉，省下小手机里的空间。
    // 酒馆里的原文一直都在（酒馆的“隐藏”只是标记，楼层还在聊天文件里），所以随时能取回来。
    // 铁律：没有摘要的楼层永远不精简；user 楼没有柏宝书摘要，所以不会被精简。

    // 认楼层：发送时间 + 是不是用户；AI 楼再加上“开始生成时间”（send_date 只精确到分钟，分不开同一分钟的两楼）
    // 长得一样的楼层再比先后序号（见 tagFloorNth）。旧卡片没记序号时不比
    _sameFloor(m, t) {
        return m.send_date === t.sendDate && !!m.is_user === !!t.isUser
            && (t.genStarted === undefined || String(m.gen_started || '') === t.genStarted)
            && (t.nth === undefined || m.__uwuNth === undefined || m.__uwuNth === t.nth);
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
                const mark = { floor: u.tavern.floor, sendDate: u.tavern.sendDate, genStarted: u.tavern.genStarted, nth: u.tavern.nth, isUser: true, name: u.tavern.name };
                if (!marks.some(x => x.sendDate === mark.sendDate && x.genStarted === mark.genStarted && x.nth === mark.nth)) marks.push(mark);
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
        if (!Array.isArray(raw)) throw new Error('读不到酒馆聊天文件');
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = tagFloorNth(raw.slice(offset));
        let restored = 0, missing = 0, restoredUsers = 0;
        let now = Date.now();
        const cleanOf = (stMsg) => this.applyCleanRules(floorBody(stMsg), 'pull');
        for (const m of targets) {
            const found = list.find(x => x && typeof x.mes === 'string' && this._sameFloor(x, m.tavern));
            if (!found) { missing++; continue; }
            const cleaned = cleanOf(found);
            if (!cleaned) { missing++; continue; }
            m.content = cleaned;
            m.parts = [];
            m.tavern.trimmed = false;
            m.tavern.rawHash = this.textHash(floorBody(found));   // 取回的是酒馆现在的版本，指纹重新记
            m.tavern.localHash = this.textHash(cleaned);
            m.tavern.rulesHash = this.pullRulesHash();
            delete m.tavern.keptHash;
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
                        nth: hit.__uwuNth,
                        isUser: true,
                        name: mark.name || char.myName || hit.name || '我',
                        roundAi: m.tavern.floor,
                        summary: null,
                        rawHash: this.textHash(floorBody(hit)),
                        localHash: this.textHash(text),
                        rulesHash: this.pullRulesHash(),
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
        if (!Array.isArray(raw)) return { ok: false, reason: '读不到酒馆聊天文件，改动只留在小手机里' };
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = tagFloorNth(raw.slice(offset));
        const stMsg = list.find(x => x && typeof x.mes === 'string' && this._sameFloor(x, t));
        if (!stMsg) return { ok: false, reason: '酒馆里找不到这一楼，改动只留在小手机里' };

        // 已精简的楼层，正文就是柏宝书摘要 → 改的是摘要，写回酒馆那一楼的柏宝书摘要（不动原文）
        if (t.trimmed) {
            const leaf = stMsg.extra && stMsg.extra.bbs_leaf;
            if (!leaf || typeof leaf.text !== 'string') {
                return { ok: false, reason: '酒馆里这一楼没有柏宝书摘要，改不了。先点「从酒馆取回原文」再改' };
            }
            const leafSwipe = typeof leaf.swipe === 'number' ? leaf.swipe : 0;
            const msgSwipe = typeof stMsg.swipe_id === 'number' ? stMsg.swipe_id : 0;
            if (leafSwipe !== msgSwipe) {
                return { ok: false, reason: '酒馆里这段摘要对应的是另一个版本的回复，没改' };
            }
            if (String(oldContent == null ? '' : oldContent).trim() !== leaf.text.trim()) {
                return { ok: false, reason: '酒馆里的摘要和小手机里的对不上（柏宝书可能重写过），先点「只补摘要」再改' };
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
        // 两边现在一致了：指纹重新记，下次同步不会把这次改动当成“两边都改过”
        t.rawHash = this.textHash(floorBody(stMsg));
        t.localHash = this.textHash(message.content || '');
        t.rulesHash = this.pullRulesHash();
        delete t.keptHash;
        await saveData();
        return { ok: true, floor: t.floor, what: 'text' };
    },

    // 只补摘要：读一遍酒馆，把已经导入的楼层的柏宝书摘要更新一遍。不导入新楼层、不动位置。
    // 柏宝书常常比回复晚一步才写好摘要，所以单独给一个按钮。
    async refreshSummaries(binding) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        const raw = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        if (!Array.isArray(raw)) throw new Error('读不到酒馆聊天文件');
        const offset = (raw.length && raw[0] && !('mes' in raw[0])) ? 1 : 0;
        const list = tagFloorNth(raw.slice(offset));
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
        // 替换成的内容一律用 () => 值 的写法：直接写成文字的话，内容里的 $$、$& 这类组合会被当成特殊指令，文字会变样
        const fill = (tpl, m, text, time) => tpl
            .replace(/\{\{楼层\}\}/g, () => String(m.tavern ? m.tavern.floor : '?'))
            .replace(/\{\{发言人\}\}/g, () => (m.tavern && m.tavern.name) || '')
            .replace(/\{\{时间\}\}/g, () => time || '时间不详')
            .replace(/\{\{内容\}\}/g, () => text);

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
        // 小总结覆盖的另记一份（重新生成时用来判断旧回复在不在酒馆里），同样把酒馆里现有的补进去
        const sumBefore = JSON.stringify(binding.summarizedIds || []);
        const sumLedger = new Set((Array.isArray(binding.summarizedIds) ? binding.summarizedIds : []).filter(id => phoneById.has(id)));
        (Array.isArray(stMsgs) ? stMsgs : []).forEach(m => {
            const ex = m && m.extra;
            if (ex && ex.from_uwu && ex.uwu_summary && Array.isArray(ex.uwu_msg_ids)) ex.uwu_msg_ids.forEach(id => { if (phoneById.has(id)) sumLedger.add(id); });
        });
        binding.summarizedIds = [...sumLedger];
        if (JSON.stringify(binding.pushedIds) !== before || JSON.stringify(binding.summarizedIds) !== sumBefore) await this.saveConfig(this.getConfig());
        const missing = allUwuMsgs.filter(m => ledger.has(m.id) && !pushed.has(m.id));
        let lastPushedIdx = -1;
        allUwuMsgs.forEach((m, i) => { if (pushed.has(m.id)) lastPushedIdx = i; });
        // 小手机里删掉了、酒馆里还在的：超过 BULK_DELETE_LIMIT 条时自动推送不会删，窗口顶部让你决定
        const gone = this._goneFromPhone(binding, phoneById, stMsgs);
        const bulkGone = gone.length > this.BULK_DELETE_LIMIT ? gone : [];
        return { char, list: allUwuMsgs, pushed, lastPushedIdx, unpushed: allUwuMsgs.slice(lastPushedIdx + 1), missing, bulkGone };
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
                delete stMsg.extra.from_uwu; delete stMsg.extra.uwu_msg_ids; delete stMsg.extra.uwu_push_time; delete stMsg.extra.uwu_line_lens;
                continue;
            }
            this._rebuildPhoneBlock(stMsg, surviving, phoneById, toLine);
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

    // 酒馆楼层里小手机那一段，每条消息写进去的那一行（按 uwu_msg_ids 的顺序）。
    // 推送时在楼层上记下每一行有多长（extra.uwu_line_lens，写空的记 0），靠它从现有文字里把每一行原样切出来。
    // 返回 Map(编号 → 那一行)；没记过、或者这一段的文字被改过（长度对不上）返回 null
    _blockLines(stMsg) {
        const ex = stMsg && stMsg.extra;
        const ids = ex && ex.uwu_msg_ids, lens = ex && ex.uwu_line_lens;
        if (!Array.isArray(ids) || !Array.isArray(lens) || lens.length !== ids.length) return null;
        if (!lens.every(n => Number.isInteger(n) && n >= 0)) return null;
        const b = lastPhoneBlock(stMsg.mes);
        const head = '<phone_chat>\n', tail = '\n</phone_chat>';
        if (!b || !b.text.startsWith(head) || !b.text.endsWith(tail)) return null;
        const inner = b.text.slice(head.length, b.text.length - tail.length);
        const filled = lens.filter(n => n > 0);
        const expect = filled.reduce((s, n) => s + n, 0) + Math.max(0, filled.length - 1);
        if (inner.length !== expect) return null;
        const map = new Map();
        let pos = 0;
        ids.forEach((id, i) => {
            if (!lens[i]) { map.set(id, ''); return; }
            map.set(id, inner.slice(pos, pos + lens[i]));
            pos += lens[i] + 1;
        });
        return map;
    },
    // 每一行的长度（和 uwu_msg_ids 一一对应，写空的是 0）
    _lineLens(lines) {
        return lines.map(l => (typeof l === 'string' && l.trim()) ? l.length : 0);
    },
    // 用 nextIds 重写这一楼小手机那一段。
    // 每条优先用酒馆里原来那一行：「留在酒馆」的、重新生成时暂时保留的旧回复在小手机里已经没有了，
    // 按小手机现有消息重新生成会把它们的文字弄丢；改了推送设置也不该回头改以前推过去的行。
    // 原来那一行找不到的（修好之前推的旧楼层）才按小手机现在的消息生成，小手机里也没有的就只能去掉
    _rebuildPhoneBlock(stMsg, nextIds, phoneById, toLine) {
        const stored = this._blockLines(stMsg);
        const lines = nextIds.map(id => {
            if (stored && stored.has(id)) return stored.get(id);
            const m = phoneById.get(id);
            return m ? toLine(m) : '';
        });
        const phoneChat = `<phone_chat>\n${lines.filter(l => l && l.trim()).join('\n')}\n</phone_chat>`;
        if (stMsg.extra.uwu_created) stMsg.mes = phoneChat;
        else stMsg.mes = replaceOwnPhoneBlock(stMsg.mes || '', phoneChat);
        stMsg.extra.uwu_msg_ids = nextIds;
        stMsg.extra.uwu_line_lens = this._lineLens(lines);
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
    // opts.allowBulkDelete：一次要从酒馆删很多条时也照删（推送窗口里你点了「从酒馆删掉」时才传，见 BULK_DELETE_LIMIT）
    async pushToTavern(binding, pushCount, trackProgress = true, opts = {}) {
        return this._pushToTavern(binding, pushCount, trackProgress, opts);
    },
    // 小手机里一次少了这么多条已经推到酒馆的消息时，不自动从酒馆删，先等你在推送窗口里决定。
    // 多半是误操作（比如清空了小手机聊天），一口气把酒馆里几百条都删掉就很难找回来了
    BULK_DELETE_LIMIT: 20,
    // 酒馆里有、小手机里已经删掉的小手机消息（不算“重新生成”保留的旧回复和你选了「留在酒馆」的）
    _goneFromPhone(binding, phoneById, stMsgs) {
        const keep = new Set([...(Array.isArray(binding.keptIds) ? binding.keptIds : []),
            ...(Array.isArray(binding.keepInTavern) ? binding.keepInTavern : [])]);
        const gone = new Set();
        (Array.isArray(stMsgs) ? stMsgs : []).forEach(m => {
            const ids = m && m.extra && m.extra.from_uwu && m.extra.uwu_msg_ids;
            if (Array.isArray(ids)) ids.forEach(id => { if (!phoneById.has(id) && !keep.has(id)) gone.add(id); });
        });
        return [...gone];
    },
    // 推送窗口里点了「留在酒馆」：这些消息以后不再从酒馆删
    async keepGoneInTavern(binding, ids) {
        const set = new Set(Array.isArray(binding.keepInTavern) ? binding.keepInTavern : []);
        (ids || []).forEach(id => set.add(id));
        binding.keepInTavern = [...set];
        delete binding.bulkDeleteNotice;
        await this.saveConfig(this.getConfig());
    },
    async _pushToTavern(binding, pushCount, trackProgress = true, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) throw new Error('找不到角色');
        let stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
        // 兜底：先核对最近 5 分钟推过的还在不在（被酒馆盖掉的就补推）。
        // 核对直接用刚读到的聊天，不用再下载一遍；真的补推了（酒馆聊天变了）才重新读
        if (!opts.messages && !opts.recovering) {
            try {
                const rr = await this._recoverLostPushes(binding, { stMsgs });
                if (rr.recovered) stMsgs = await this.getSTChatMessages(binding.stCharAvatar, binding.stChatFile);
            } catch (e) { this.reportIssue('核对被酒馆盖掉的推送时出错：' + e.message, 'push'); }
        }
        const { allUwuMsgs, toLine, phoneById } = this._pushHelpers(char, binding);
        // 小手机里还在的消息。只有从小手机里真的删掉了，才去酒馆里删（改推送设置不算删）。
        // binding.keptIds：被“重新生成”换掉的旧回复。它们在小手机里没了，但酒馆里的旧版本要保留，所以当作还在（yuan 版新增）
        // binding.keepInTavern：小手机里删了、但你在推送窗口里选了「留在酒馆」的
        const stillHere = new Set([...phoneById.keys(), ...(Array.isArray(binding.keptIds) ? binding.keptIds : []),
            ...(Array.isArray(binding.keepInTavern) ? binding.keepInTavern : [])]);
        // 一次要删的太多：这次先不删，在页面顶部提示一次，等你在推送窗口里决定（新消息照常推）
        const gone = this._goneFromPhone(binding, phoneById, stMsgs);
        if (gone.length > this.BULK_DELETE_LIMIT && !opts.allowBulkDelete) {
            gone.forEach(id => stillHere.add(id));
            if (binding.bulkDeleteNotice !== gone.length) {
                binding.bulkDeleteNotice = gone.length;
                await this.saveConfig(this.getConfig());
                const who = char.remarkName || char.name || '这个角色';
                this.reportIssue(`「${who}」的小手机里一次少了 ${gone.length} 条以前推到酒馆的消息。为了防止误删，没有自动从酒馆里删掉。确实要删的话，打开「推送/清理消息」窗口，点顶部的「从酒馆删掉」；想留着就点「留在酒馆」。`);
            }
        } else if (binding.bulkDeleteNotice) {
            delete binding.bulkDeleteNotice;
        }

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
                delete stMsg.extra.uwu_line_lens;
                continue;
            }
            if (stMsg.extra.uwu_summary) {
                // 小总结那一楼是一整段总结文字，不能换成剩下几条的原文：文字不动，只更新它覆盖了哪几条
                stMsg.extra.uwu_msg_ids = survivingIds;
                continue;
            }
            // 用还在的消息重建小手机那一段（每条用酒馆里原来那一行，见 _rebuildPhoneBlock）
            this._rebuildPhoneBlock(stMsg, survivingIds, phoneById, toLine);
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
        let rawLines = [];      // 和 newMsgs 一一对应（写空的也在），用来记每一行多长
        if (newMsgs.length > 0) {
            rawLines = newMsgs.map(toLine);
            pushLines = rawLines.filter(l => l && l.trim());
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
                // 接着写之前先看原来每一行的长度记录还对不对得上，对得上才接着记（对不上就不记，以后重写这一楼时按旧办法）
                const hadIds = !!(target.extra && Array.isArray(target.extra.uwu_msg_ids) && target.extra.uwu_msg_ids.length);
                const oldLens = own ? (this._blockLines(target) ? target.extra.uwu_line_lens : null) : (hadIds ? null : []);
                if (own) {
                    const inner = own.text.slice(0, own.text.length - '</phone_chat>'.length);
                    target.mes = existingContent.slice(0, own.start) + inner + lines.join('\n') + '\n</phone_chat>' + existingContent.slice(own.end);
                } else {
                    target.mes = existingContent + '\n' + mergedContent;
                }
                if (!target.extra) target.extra = {};
                target.extra.from_uwu = true;
                target.extra.uwu_msg_ids = [...(target.extra.uwu_msg_ids || []), ...newMsgs.map(m => m.id)];
                if (oldLens) target.extra.uwu_line_lens = [...oldLens, ...this._lineLens(rawLines)];
                else delete target.extra.uwu_line_lens;
                target.extra.uwu_push_time = Date.now();
            } else {
                // 新楼层模式（默认）：推送为 user 侧消息，方便用正则只剥离 AI 输出的 phone_chat
                const stCharName = (binding.stCharAvatar || '').replace(/\.png$/i, '');
                all.push({
                    name: char.myName || 'User',
                    is_user: true, is_system: false,
                    send_date: new Date().toISOString(),
                    mes: mergedContent,
                    extra: { from_uwu: true, uwu_created: true, uwu_push_time: Date.now(), uwu_msg_ids: newMsgs.map(m => m.id), uwu_line_lens: this._lineLens(rawLines), st_char_name: stCharName },
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
            const stored = this._blockLines(stMsg);
            const at = typeof stMsg.mes === 'string' ? stMsg.mes.indexOf(oldLine) : -1;
            if (at < 0) continue;
            // 用切开再拼的办法换，不用 replace：总结里带 $ 符号时 replace 会把它当成特殊指令
            stMsg.mes = stMsg.mes.slice(0, at) + newLine + stMsg.mes.slice(at + oldLine.length);
            // 每一行的长度记录跟着改（原来记录就对不上的，改完也对不上，不用管）
            if (stored && stored.get(msg.id) === oldLine) {
                stMsg.extra.uwu_line_lens = stMsg.extra.uwu_line_lens.slice();
                stMsg.extra.uwu_line_lens[ids.indexOf(msg.id)] = newLine.length;
            }
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
        // 用新的编号列表重建这一楼小手机那一段：别的消息用酒馆里原来那一行，新回复按小手机里的生成
        const rebuild = (stMsg, nextIds) => this._rebuildPhoneBlock(stMsg, nextIds, phoneById, toLine);

        let changed = false;
        let intoSummary = false;   // 新回复是不是换进了小总结楼（那样只算“被小总结推过”，不算推过原文）
        let inserted = false;   // 新回复只放进第一处出现旧回复的地方
        for (const stMsg of all) {
            const ids = stMsg && stMsg.extra && stMsg.extra.from_uwu && Array.isArray(stMsg.extra.uwu_msg_ids) ? stMsg.extra.uwu_msg_ids : null;
            if (!ids || !ids.some(id => oldSet.has(id))) continue;
            const nextIds = [];
            let hereNew = false;
            for (const id of ids) {
                if (!oldSet.has(id)) { nextIds.push(id); continue; }
                if (!inserted) { nextIds.push(...newIds); inserted = true; hereNew = true; }
            }
            if (stMsg.extra.uwu_summary) {
                // 旧回复已经被浓缩进一段小总结：总结文字不动，只把“覆盖了哪几条”换成新回复
                stMsg.extra.uwu_msg_ids = nextIds;
                if (hereNew) intoSummary = true;
            } else {
                rebuild(stMsg, nextIds);
            }
            changed = true;
        }
        // 酒馆里没有旧回复（没推送过，或者你在酒馆里删掉了）：酒馆一概不动，新回复当成普通的未推送消息，
        // 开了自动推送就照常推过去（2026-09-22 维护者要求：旧回复不在酒馆里时不该去改酒馆）
        if (!changed) return { replaced: false };
        await this.apiCall('/api/chats/save', { avatar_url: binding.stCharAvatar, file_name: binding.stChatFile, chat: all });
        if (intoSummary) {
            // 换进小总结楼的不记推送记录：被盖掉时只能整段补推总结文字，这里没有
            this._rememberSummarized(binding, newIds);
        } else {
            this._logPush(binding, { kind: 'raw', ids: newIds.slice() });
            this._rememberPushed(binding, newIds);
        }
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
        // 每条消息先按推送的规矩处理一遍（和推原文时写进酒馆的那一行一样）：
        // 关掉了「推送状态栏」「推送在线状态」的，这些内容也不进总结；思考过程、推送方向的清洗规则、通话推送方式同样照办
        const { toLine } = this._pushHelpers(char, binding);
        const transcript = unpushed.map(m => {
            const text = (toLine(m) || '').trim();
            return text ? `${m.role === 'user' ? myName : charName}：${text}` : '';
        }).filter(Boolean).join('\n');
        if (!transcript) throw new Error('这些消息按推送设置处理后都是空的，没有可总结的内容');

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
        this._rememberSummarized(binding, coveredMsgIds || []);
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
            parts.push(cfg.wrapNote.trim().replace(/\{\{用户\}\}/g, () => character.myName || '我'));
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
            // 离开小手机页面时：打开了双向自动更新的角色，把小手机里改过的人设、世界书推到酒馆。
            // 设定是在设置页里改的，所以不管现在在哪个界面都做（下面的聊天同步只在聊天界面做）
            if (document.hidden) {
                try {
                    const cfg0 = this.getConfig();
                    if (cfg0.enabled) cfg0.bindings.filter(b => b.autoUpdatePersona || b.autoUpdateWorldBooks)
                        .forEach(b => this.syncSettingsBothWays(b).catch(e => this.reportIssue('离开小手机时双向更新人设和世界书失败：' + e.message)));
                } catch (e) { /* 不影响下面的聊天同步 */ }
            }
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
        const raw = { description: d.description || '', personality: d.personality || '', scenario: d.scenario || '' };
        const charPersona = this._composeCharPersona(raw);

        let userPersonas = [];
        let activePersona = '';
        let activeAvatar = '';     // 酒馆里当前选中的用户人设的头像文件名
        try {
            const settings = await this.getSTSettings();
            const pu = settings.power_user || {};
            const personas = pu.personas || {};
            const descs = pu.persona_descriptions || {};
            activePersona = pu.persona_description || '';
            activeAvatar = settings.user_avatar || '';
            for (const [avatar, name] of Object.entries(personas)) {
                const descObj = descs[avatar] || {};
                userPersonas.push({ avatar, name, description: descObj.description || '' });
            }
        } catch (e) { console.warn('[TavernSync] Failed to load user personas:', e); }

        return { charPersona, raw, charName: d.name, userPersonas, activePersona, activeAvatar, charAvatar: stChar.avatar || binding.stCharAvatar, postHistory: d.post_history_instructions || '' };
    },

    // 酒馆角色卡的「描述 + 性格 + 场景」拼成小手机的一段角色人设（导入时的格式）
    _composeCharPersona(f) {
        const parts = [];
        if (f.description) parts.push(f.description);
        if (f.personality) parts.push(`性格：${f.personality}`);
        if (f.scenario) parts.push(`场景：${f.scenario}`);
        return parts.join('\n\n');
    },
    // 反过来：小手机的角色人设拆回酒馆的三栏。只有酒馆那一栏原来有内容时才拆（说明是导入时拼进来的），
    // 否则整段都进「描述」——你自己在人设里写“场景：”不会被误拆。拆完再拼回去和原文一模一样
    _splitCharPersona(text, cur) {
        let rest = String(text || '');
        const out = { description: '', personality: '', scenario: '' };
        const cut = (field, mark) => {
            if (!(cur && cur[field])) return;
            if (rest.startsWith(mark)) { out[field] = rest.slice(mark.length); rest = ''; return; }
            const at = rest.lastIndexOf('\n\n' + mark);
            if (at < 0) return;
            out[field] = rest.slice(at + 2 + mark.length);
            rest = rest.slice(0, at);
        };
        cut('scenario', '场景：');
        cut('personality', '性格：');
        out.description = rest;
        return out;
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
    // 从小手机推到这一条的（tavernPushes）也算：两个世界书窗口认的是同一套对应关系
    findCopiedWorldBook(binding, worldName, uid) {
        const list = (db.worldBooks || []).filter(Boolean);
        return list.find(w => w.tavernSource
            && w.tavernSource.avatar === binding.stCharAvatar
            && w.tavernSource.world === worldName
            && w.tavernSource.uid === uid)
            || list.find(w => w.tavernPushes && w.tavernPushes[worldName] && w.tavernPushes[worldName].uid === uid);
    },
    // 这一条和酒馆 worldName 里 uid 那一条是怎么对应上的（推过去的优先，和 _wbLinksFor 一样）
    copiedLink(w, worldName, uid) {
        const p = w.tavernPushes && w.tavernPushes[worldName];
        return { world: worldName, uid, via: (p && p.uid === uid) ? 'push' : 'import' };
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

    // ========== 双向自动更新复制过的世界书（2026-09-22 改成双向）==========
    // 绑定卡片开关「双向自动更新复制过的世界书」（binding.autoUpdateWorldBooks）。每次同步时、离开小手机时检查
    // 这个角色的酒馆角色世界书、聊天世界书里，和小手机有对应关系的条目：
    //   从酒馆复制过来的（tavernSource，avatar 是这个角色）、从小手机推过去的（tavernPushes[这本]）。
    // 只有酒馆里改了 → 更新小手机；只有小手机里改了 → 推到酒馆；两边都改了 → 都不动，页面顶部提示一次。
    // 酒馆里删掉的条目不动小手机这边；角色内嵌的世界书不是单独的文件，推不回去，只更新小手机。

    // 小手机这一条和酒馆 world 里 uid 那一条的对应关系（推过去的优先）
    _wbLinksFor(w, binding, worldNames) {
        const links = [];
        const seen = new Set();
        if (w.tavernPushes && typeof w.tavernPushes === 'object') {
            for (const [world, link] of Object.entries(w.tavernPushes)) {
                if (!link || !worldNames.includes(world)) continue;
                links.push({ world, uid: link.uid, via: 'push' });
                seen.add(world + '\u0001' + link.uid);
            }
        }
        const t = w.tavernSource;
        if (t && t.avatar === binding.stCharAvatar && !seen.has(t.world + '\u0001' + t.uid)) links.push({ world: t.world, uid: t.uid, via: 'import' });
        return links;
    },

    // 两边的记录都换成现在这一版（推送、更新之后调用）
    _relinkEntry(w, world, uid, hash, order) {
        const t = w.tavernSource;
        if (t && t.world === world && t.uid === uid) {
            t.hash = hash;
            t.order = order;
            t.localHash = this.wbLocalHash(w);
            delete t.keptHash;
        }
        const link = w.tavernPushes && w.tavernPushes[world];
        if (link && link.uid === uid) {
            link.hash = hash;
            link.localHash = this.wbPushHash(w);
            delete link.keptHash;
        }
    },

    // 用酒馆那一条的内容更新小手机这一条（自动更新、「导入酒馆世界书」的「更新小手机里的内容」都走这里）
    //   via 'push'（从小手机推过去的）：权重直接取酒馆的顺序、常驻的也留着关键词——推过去时就是这么对应的
    //   小手机原来是「中」、酒馆里还是角色定义后：保持「中」（推过去时「中」「后」都变成了角色定义后）
    pullEntryInto(w, entry, idx, world, via) {
        const prevPos = w.position;
        this.applyTavernEntry(w, entry, idx, false);
        if (prevPos === 'middle' && entry.position !== 0) w.position = 'middle';
        if (via === 'push') {
            const n = Number(entry.order);
            if (Number.isFinite(n)) w.weight = n;
            w.keywords = this.entryKeywords(entry);
        }
        this._relinkEntry(w, world, entry.uid, this.wbHash(entry), entry.order);
    },

    // 这一条两边各自改过没有。localChanged：true / false / null（更新前复制的条目没记指纹，说不准）
    _wbChangeState(w, link, entry) {
        const hash = this.wbHash(entry);
        if (link.via === 'push') {
            const rec = w.tavernPushes[link.world];
            return { hash, tavernChanged: hash !== rec.hash, localChanged: this.wbPushHash(w) !== rec.localHash, rec };
        }
        return { hash, tavernChanged: hash !== w.tavernSource.hash, localChanged: this.wbEditedLocally(w), rec: w.tavernSource };
    },

    async syncCopiedWorldBooks(binding) {
        const all = (db.worldBooks || []).filter(Boolean);
        if (!all.some(w => (w.tavernSource && w.tavernSource.avatar === binding.stCharAvatar) || (w.tavernPushes && Object.keys(w.tavernPushes).length))) {
            return { updated: 0, pushed: 0, kept: 0 };
        }
        const worldBooks = await this.getCharAndChatWorldBooks(binding);
        const sources = [worldBooks.charWorld, worldBooks.chatWorld].filter(Boolean);
        const fileNames = sources.map(s => s.name).filter(n => n !== '角色内嵌世界书');
        const names = sources.map(s => s.name);
        let updated = 0, changedMeta = false;
        const kept = [];
        const toPush = [];          // [小手机条目, link]
        for (const w of all) {
            for (const link of this._wbLinksFor(w, binding, names)) {
                const src = sources.find(s => s.name === link.world);
                const entry = src && src.entries.find(e => e.uid === link.uid);
                if (!entry) continue;                       // 酒馆里删掉了 → 小手机这条保留，不动
                const idx = src.entries.indexOf(entry);
                const st = this._wbChangeState(w, link, entry);
                if (!st.tavernChanged) {
                    if (st.localChanged === true) { if (fileNames.includes(link.world)) toPush.push([w, link]); continue; }
                    // 两边都没改。更新前复制的条目没记指纹：趁现在补上——拿酒馆这一条重新套一遍，一样就说明没改过
                    if (st.localChanged === null) {
                        const expect = this.applyTavernEntry(Object.assign({}, w, { tavernSource: Object.assign({}, w.tavernSource) }), entry, idx, false);
                        w.tavernSource.localHash = this.wbLocalHash(expect);
                        changedMeta = true;
                        if (w.tavernSource.localHash !== this.wbLocalHash(w) && fileNames.includes(link.world)) toPush.push([w, link]);
                    }
                    continue;
                }
                if (st.localChanged === false) {
                    this.pullEntryInto(w, entry, idx, link.world, link.via);
                    updated++;
                    continue;
                }
                // 两边都改过（或者说不准）→ 不覆盖。同一次改动只提示一次；指纹不动，
                // 这样两个世界书窗口里照样标出改动，手动更新照样能用
                const keptKey = st.hash + '|' + (link.via === 'push' ? this.wbPushHash(w) : this.wbLocalHash(w));
                if (st.rec.keptHash !== keptKey) {
                    kept.push(w.name || entry.comment || '未命名');
                    st.rec.keptHash = keptKey;
                    changedMeta = true;
                }
            }
        }
        // 小手机里改了的推到酒馆：按世界书分组，每本读一次、存一次
        let pushed = 0;
        const byWorld = new Map();
        toPush.forEach(([w, link]) => { if (!byWorld.has(link.world)) byWorld.set(link.world, []); byWorld.get(link.world).push([w, link]); });
        for (const [world, list] of byWorld) {
            const data = await this.getSTWorldInfo(world);
            if (!data || !data.entries) continue;
            const done = [];
            for (const [w, link] of list) {
                const target = data.entries[link.uid];
                if (!target) continue;
                this._applyPhoneEntry(target, w, { keepOrder: link.via === 'import' });
                done.push([w, link, target]);
            }
            if (!done.length) continue;
            await this.apiCall('/api/worldinfo/edit', { name: world, data });
            this._tellTavernPage({ type: 'worldinfo-saved', name: world });
            done.forEach(([w, link, target]) => this._relinkEntry(w, world, link.uid, this.wbHash(this._normTavernEntry(target)), target.order));
            pushed += done.length;
        }
        if (kept.length) {
            const names2 = kept.slice(0, 5).map(n => `「${n}」`).join('、') + (kept.length > 5 ? ` 等 ${kept.length} 条` : '');
            this.reportIssue(`酒馆中「${(binding.stCharAvatar || '').replace(/\.png$/i, '')}」的世界书条目 ${names2} 在酒馆和小手机里都改过，没有自动更新。想用酒馆的版本：点「导入酒馆世界书」，勾选这些条目后点「更新小手机里的内容」；想用小手机的版本：点「推送小手机世界书」，选这本世界书，勾选这些条目后点「更新酒馆里的内容」。`);
        }
        if ((updated || pushed || changedMeta) && typeof saveData === 'function') await saveData();
        return { updated, pushed, kept: kept.length };
    },

    // ========== 双向自动更新人设（2026-09-22 改成双向，头像也算）==========
    // 绑定卡片上的开关「双向自动更新人设」（binding.autoUpdatePersona）+ 下拉「更新」（binding.personaUpdateMode：char / user / both）。
    // 每次同步时、离开小手机时检查四样：角色人设、角色头像、用户人设、用户头像（角色的两样跟着 char，用户的两样跟着 user）。
    //   只有酒馆里改了 → 更新小手机；只有小手机里改了 → 推到酒馆；两边都改了 → 都不动，绑定卡片上让你选用哪边的。
    // 记录在 binding.personaSync，每一样一组（key = char / user / charAvatar / userAvatar）：
    //   <key>Hash   上次两边一致时酒馆那一版的指纹（头像用酒馆缩略图的指纹）
    //   <key>Local  上次两边一致时小手机那一版的指纹
    //   <key>Kept   两边都改过、还没选用哪边时记下（同一次改动只提示一次；绑定卡片上据此显示「用酒馆的 / 用小手机的」）
    //   userSource  用户人设跟着酒馆里的哪一个（人设头像名，或 '__active__' = 酒馆里当前选中的）
    // 导入酒馆人设窗口导入时也会记这些（见 recordPersonaImport / recordAvatarImport）。
    personaUpdateMode(binding) {
        const m = binding && binding.personaUpdateMode;
        return (m === 'char' || m === 'user' || m === 'both') ? m : 'both';
    },
    PERSONA_LABELS: { char: '角色人设', charAvatar: '角色头像', user: '用户人设', userAvatar: '用户头像' },

    _userPersonaText(result, source) {
        if (!source || source === '__active__') return result.activePersona || '';
        const p = (result.userPersonas || []).find(x => x.avatar === source);
        return p ? (p.description || '') : null;     // null = 酒馆里这个人设没了
    },
    // 用户人设在酒馆里的头像文件名（也就是这个人设的编号）
    _userPersonaAvatar(result, source) {
        if (!source || source === '__active__') return result.activeAvatar || '';
        return (result.userPersonas || []).some(x => x.avatar === source) ? source : '';
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
    // 导入窗口里换了头像：同样记下两边这一版
    async recordAvatarImport(binding, char, result, what) {
        const ps = Object.assign({}, binding.personaSync);
        if (what.char) {
            const h = await this._imageHash(this.tavernCharThumbUrl(result.charAvatar || binding.stCharAvatar));
            if (h) { ps.charAvatarHash = h; ps.charAvatarLocal = this.textHash(char.avatar || ''); delete ps.charAvatarKept; }
        }
        if (what.userFile) {
            const h = await this._imageHash(this.tavernUserThumbUrl(what.userFile));
            if (h) { ps.userAvatarHash = h; ps.userAvatarLocal = this.textHash(char.myAvatar || ''); delete ps.userAvatarKept; }
        }
        binding.personaSync = ps;
    },

    // 缩略图（小，每次同步都要拿来比一比，不能每次都下整张大图）
    tavernCharThumbUrl(avatar) { return avatar ? `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}` : ''; },
    tavernUserThumbUrl(file) { return file ? `/thumbnail?type=persona&file=${encodeURIComponent(file)}` : ''; },
    // 一张酒馆图片的指纹；读不到返回 null
    async _imageHash(url) {
        if (!url) return null;
        try {
            const r = await this._fetchWithTimeout(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' });
            if (!r || !r.ok || typeof r.arrayBuffer !== 'function') return null;
            const bytes = new Uint8Array(await r.arrayBuffer());
            if (!bytes.length) return null;
            let h = 5381;
            for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h + bytes[i]) | 0;
            return 'img' + bytes.length + '_' + h;
        } catch (e) { return null; }
    },
    // 小手机头像是不是你自己传过的（默认头像是外链，当作“还没有”）
    _isOwnAvatar(src) { return /^data:/i.test(String(src || '')); },

    // 不需要读回内容的请求（酒馆有的接口只回一个 OK，不是 JSON）
    async _apiPostText(endpoint, body) {
        return this._stFetch(endpoint, { method: 'POST', body: JSON.stringify(body) }, (resp) => {
            if (resp.status === 404) throw new Error('你的酒馆版本不支持这个功能，请更新酒馆');
            if (!resp.ok) throw new Error(`API ${resp.status}`);
            return resp.text();
        });
    },
    // 写酒馆角色卡的描述、性格、场景（只改这三栏，别的不动）
    async _writeCharFields(avatar, f) {
        await this._apiPostText('/api/characters/merge-attributes', {
            avatar, description: f.description, personality: f.personality, scenario: f.scenario,
            data: { description: f.description, personality: f.personality, scenario: f.scenario },
        });
        this._tellTavernPage({ type: 'character-updated', avatar, fields: f });
    },
    async _writeCharAvatar(avatar, blob) {
        const form = new FormData();
        form.append('avatar', blob, 'avatar.png');
        form.append('avatar_url', avatar);
        await this._stFetchForm('/api/characters/edit-avatar', form, (resp) => {
            if (resp.status === 404) throw new Error('你的酒馆版本不支持换角色头像，请更新酒馆');
            if (!resp.ok) throw new Error(`API ${resp.status}`);
            return resp.text();
        });
        this._tellTavernPage({ type: 'character-updated', avatar, avatarChanged: true });
    },
    async _writePersonaAvatar(file, blob) {
        const form = new FormData();
        form.append('avatar', blob, 'avatar.png');
        form.append('overwrite_name', file);
        await this._stFetchForm('/api/avatars/upload', form, (resp) => {
            if (!resp.ok) throw new Error(`API ${resp.status}`);
            return resp.text();
        });
        this._tellTavernPage({ type: 'persona-updated', avatarId: file, avatarChanged: true });
    },
    // 改酒馆用户人设的内容。和新建一样：开着酒馆页面时让它自己改，没开才直接改设置文件
    async _writePersonaText(file, text, activeAvatar) {
        const answer = await this._askTavernPage({ type: 'update-persona', avatarId: file, description: text, activeAvatar });
        if (answer && answer.ok) return 'page';
        const resp = await this.apiCall('/api/settings/get', {});
        const settings = typeof resp.settings === 'string' ? JSON.parse(resp.settings) : (resp.settings || {});
        const pu = settings.power_user || (settings.power_user = {});
        if (!pu.persona_descriptions || typeof pu.persona_descriptions !== 'object') pu.persona_descriptions = {};
        pu.persona_descriptions[file] = Object.assign({ position: 0, depth: 2, role: 0, lorebook: '' }, pu.persona_descriptions[file], { description: text });
        if (settings.user_avatar === file) pu.persona_description = text;
        await this.apiCall('/api/settings/save', settings);
        return 'file';
    },

    // opts.force = { key, use: 'tavern' | 'phone' }：绑定卡片上点了「用酒馆的」「用小手机的」，只处理这一样
    async syncPersona(binding, opts = {}) {
        const char = db.characters.find(c => c.id === binding.uwuCharId);
        if (!char) return { updated: 0, pushed: 0, kept: 0 };
        const mode = this.personaUpdateMode(binding);
        const result = await this.importCharSettings(binding);
        const ps = Object.assign({}, binding.personaSync);
        const tavernName = result.charName || (binding.stCharAvatar || '').replace(/\.png$/i, '');
        const force = opts.force || null;
        let updated = 0, pushed = 0, viaFile = false;
        const kept = [];
        const errors = [];
        const userFile = this._userPersonaAvatar(result, ps.userSource);

        // 每一样怎么读、怎么写
        const items = [];
        if (mode === 'char' || mode === 'both') {
            items.push({
                key: 'char', text: true,
                tavern: async () => result.charPersona,
                local: () => char.persona || '',
                pull: async () => { char.persona = result.charPersona; },
                push: async () => {
                    const f = this._splitCharPersona(char.persona || '', result.raw);
                    await this._writeCharFields(binding.stCharAvatar, f);
                    return this.textHash(this._composeCharPersona(f));
                },
            });
            items.push({
                key: 'charAvatar',
                tavernHash: () => this._imageHash(this.tavernCharThumbUrl(binding.stCharAvatar)),
                local: () => char.avatar || '',
                empty: () => !this._isOwnAvatar(char.avatar),
                pull: async () => { char.avatar = await this.avatarToSquare(this.tavernCharAvatarUrl(binding.stCharAvatar) + '?_t=' + Date.now()); },
                push: async () => {
                    const a = await this.avatarToTall(char.avatar);
                    await this._writeCharAvatar(binding.stCharAvatar, a.blob);
                    return this._imageHash(this.tavernCharThumbUrl(binding.stCharAvatar));
                },
            });
        }
        if ((mode === 'user' || mode === 'both') && userFile !== null) {
            const tv = this._userPersonaText(result, ps.userSource);
            if (tv !== null) {
                items.push({
                    key: 'user', text: true,
                    tavern: async () => tv,
                    local: () => char.myPersona || '',
                    pull: async () => { char.myPersona = tv; },
                    push: userFile ? async () => {
                        if ((await this._writePersonaText(userFile, char.myPersona || '', result.activeAvatar)) === 'file') viaFile = true;
                        return this.textHash(char.myPersona || '');
                    } : null,
                });
            }
            if (userFile) {
                items.push({
                    key: 'userAvatar',
                    tavernHash: () => this._imageHash(this.tavernUserThumbUrl(userFile)),
                    local: () => char.myAvatar || '',
                    empty: () => !this._isOwnAvatar(char.myAvatar),
                    pull: async () => { char.myAvatar = await this.avatarToSquare(this.tavernUserAvatarUrl(userFile) + '?_t=' + Date.now()); },
                    push: async () => {
                        const a = await this.avatarToTall(char.myAvatar);
                        await this._writePersonaAvatar(userFile, a.blob);
                        return this._imageHash(this.tavernUserThumbUrl(userFile));
                    },
                });
            }
        }

        for (const it of items) {
            if (force && force.key !== it.key) continue;
            const K = it.key;
            try {
                const tavernText = it.text ? await it.tavern() : null;
                const th = it.text ? this.textHash(tavernText) : await it.tavernHash();
                if (th == null) continue;                                   // 酒馆那边读不到：这次不管
                const local = it.local();
                const lh = this.textHash(local);
                const record = (t, l) => { ps[K + 'Hash'] = t; ps[K + 'Local'] = l; delete ps[K + 'Kept']; };
                const doPull = async () => { await it.pull(); record(th, this.textHash(it.local())); updated++; };
                const doPush = async () => { const nt = await it.push(); if (nt) record(nt, this.textHash(it.local())); pushed++; };
                const tavernEmpty = it.text ? !String(tavernText || '').trim() : false;
                const localEmpty = it.text ? !String(local).trim() : it.empty();
                const same = it.text && local === tavernText;
                if (force) {
                    if (force.use === 'tavern') { if (!tavernEmpty) await doPull(); }
                    else if (it.push) await doPush();
                    continue;
                }
                if (same) { if (ps[K + 'Hash'] !== th || ps[K + 'Local'] !== lh || ps[K + 'Kept']) record(th, lh); continue; }
                const H = ps[K + 'Hash'], L = ps[K + 'Local'];
                const tChanged = H === undefined ? true : th !== H;
                const lChanged = L === undefined ? !localEmpty : lh !== L;
                if (!tChanged && !lChanged) continue;
                if (localEmpty && !tavernEmpty) { await doPull(); continue; }        // 小手机这边还是空的 / 默认头像 → 用酒馆的
                if (H === undefined && !it.text) { record(th, lh); continue; }       // 以前没记过头像：先记下现在两边，不动
                if (tChanged && !lChanged) { if (!tavernEmpty) await doPull(); continue; }
                if (!tChanged && lChanged) { if (it.push) await doPush(); continue; }
                // 两边都改过 → 都不动，等你在绑定卡片上选
                const keptKey = th + '|' + lh;
                if (ps[K + 'Kept'] !== keptKey) { ps[K + 'Kept'] = keptKey; kept.push(this.PERSONA_LABELS[K]); }
            } catch (e) {
                errors.push(`${this.PERSONA_LABELS[K]}：${e.message}`);
            }
        }
        const changed = JSON.stringify(ps) !== JSON.stringify(binding.personaSync || {});
        binding.personaSync = ps;
        if (kept.length) {
            this.reportIssue(`酒馆中「${tavernName}」的${kept.join('、')}在酒馆和小手机里都改过，没有自动更新；在绑定卡片「双向自动更新人设」下面选用哪一边的。`);
        }
        if (errors.length) this.reportIssue(`「${tavernName}」双向自动更新人设时出错：${errors.join('；')}`);
        if (viaFile) this.reportIssue(`「${tavernName}」的用户人设是直接写进酒馆设置文件的（同一个浏览器里没有开着的酒馆页面）。如果别的设备或浏览器里开着酒馆，请先刷新那边的酒馆页面，否则酒馆保存设置时会把它盖回去。`);
        if (updated || pushed || changed) await this.saveConfig(this.getConfig());   // 会顺带存角色数据
        return { updated, pushed, kept: kept.length, errors: errors.length };
    },

    // 绑定卡片上「用酒馆的」「用小手机的」
    async resolvePersonaConflict(binding, key, use) {
        return this.syncPersona(binding, { force: { key, use } });
    },
    // 离开小手机页面时：人设、世界书双向检查一次（小手机里改完设定就去酒馆玩的情况）
    async syncSettingsBothWays(binding) {
        if (binding.autoUpdateWorldBooks) {
            try { await this.syncCopiedWorldBooks(binding); } catch (e) { this.reportIssue('双向自动更新世界书失败：' + e.message); }
        }
        if (binding.autoUpdatePersona) {
            try { await this.syncPersona(binding); } catch (e) { this.reportIssue('双向自动更新人设失败：' + e.message); }
        }
    },
    // 两边都改过、还没选的那几样（绑定卡片上显示）
    personaConflicts(binding) {
        const ps = binding && binding.personaSync;
        if (!ps || !binding.autoUpdatePersona) return [];
        const mode = this.personaUpdateMode(binding);
        return ['char', 'charAvatar', 'user', 'userAvatar'].filter(k => ps[k + 'Kept']
            && (mode === 'both' || (mode === 'char' ? k.startsWith('char') : k.startsWith('user'))));
    },

    // ========== 把小手机设定推送到酒馆（2026-09-22 加）==========
    // 设置「从小手机推送到酒馆」卡片最下面的两个按钮：
    //   「推送小手机人设」：在酒馆里新建一个角色（可以连同用户人设、世界书一起建），每次都是新建，不动酒馆里已有的；
    //   「推送小手机世界书」：把小手机的世界书条目加进酒馆的某一本世界书，推过的以后可以再更新过去。
    // 推过去的世界书条目在小手机那条上记 tavernPushes[酒馆世界书名] = { uid, hash, localHash }：
    //   hash      = 推送那一刻酒馆那一条的指纹（和 wbHash 同一套），对不上 = 酒馆里改过
    //   localHash = 推送那一刻小手机这一条的指纹（wbPushHash，含权重），对不上 = 小手机里改过
    // 从这本酒馆世界书导入进来的条目（tavernSource.world 是这本）也算已经在里面，只能更新，不会再加一条。

    // 小手机角色的名字（推到酒馆当角色名、世界书名用）：优先真名，其次备注
    phoneCharName(ch) {
        return (ch && (ch.realName || ch.name || ch.remarkName)) || '';
    },

    // 小手机角色用的线下世界书条目。没设线下的，小手机线下时用线上那套，这里也跟着用（offline = false）
    phoneOfflineWorldBooks(ch) {
        const off = Array.isArray(ch && ch.offlineWorldBookIds) ? ch.offlineWorldBookIds : [];
        const ids = off.length ? off : (Array.isArray(ch && ch.worldBookIds) ? ch.worldBookIds : []);
        const books = ids.map(id => (db.worldBooks || []).find(w => w && w.id === id)).filter(Boolean);
        const globals = (db.worldBooks || []).filter(w => w && w.isGlobal && !ids.includes(w.id));
        return { offline: off.length > 0, books, globals };
    },

    // 小手机条目的指纹：wbLocalHash 再加上权重（权重要推到酒馆的「顺序」，改了也算改过）
    wbPushHash(w) {
        return this.textHash(this.wbLocalHash(w) + '\u0001' + this._phoneWeight(w));
    },
    _phoneWeight(w) {
        const n = Number(w && w.weight);
        return Number.isFinite(n) ? n : 100;      // yuan 里没填权重时按 100 算
    },

    // 酒馆世界书条目 → 和 getCharAndChatWorldBooks 一样的格式（wbHash 用的就是这个格式）
    _normTavernEntry(e) {
        return {
            uid: e.uid, comment: e.comment || '未命名', content: e.content || '', key: e.key || '',
            order: e.order ?? e.uid ?? 0, position: e.position, depth: e.depth, role: e.role, disabled: !!(e.disable ?? e.disabled), constant: !!e.constant,
        };
    },

    // 小手机条目的内容写到酒馆条目上：名字、正文、关键词、常驻、开关、顺序、位置。
    // 位置：「前」→ 角色定义前（0）；「中」「后」→ 角色定义后（1）。
    // 更新时如果酒馆里那条放在别的位置（比如 @深度），而小手机是「中」「后」，就不动酒馆的位置
    // （导入时这些位置都变成了「后」，推回去不该把你在酒馆里设的位置冲掉）
    // opts.keepOrder：这条是从酒馆导入来的。导入时小手机的权重是按列表位置排的（100、101…），不是酒馆的顺序数字，
    //   所以推回去不动酒馆的顺序；常驻条目导入时关键词被清空了，小手机里还是没有关键词的话，也不动酒馆的关键词
    _applyPhoneEntry(target, w, opts = {}) {
        const keys = (Array.isArray(w.keywords) ? w.keywords : []).map(k => String(k).trim()).filter(Boolean);
        const alwaysOn = w.alwaysOn !== false;      // yuan 里没写 alwaysOn 就算常驻
        target.comment = w.name || '未命名';
        target.content = w.content || '';
        if (!(opts.keepOrder && alwaysOn && !keys.length)) target.key = keys;
        target.constant = alwaysOn;
        target.disable = !!w.disabled;
        if (!opts.keepOrder) target.order = this._phoneWeight(w);
        if (w.position === 'before') target.position = 0;
        else if (target.position === undefined || target.position === null || target.position === 0) target.position = 1;
        return target;
    },

    // 酒馆新条目的完整格式（照酒馆自己新建条目时的默认值，缺字段酒馆有的地方会出错）
    _newTavernEntry(uid, w) {
        const e = {
            uid, key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
            selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 1, disable: false,
            ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
            matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
            delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4, outletName: '',
            group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
            matchWholeWords: null, useGroupScoring: null, automationId: '', role: null,
            sticky: 0, cooldown: 0, delay: 0, triggers: [], displayIndex: uid,
            characterFilter: { isExclude: false, names: [], tags: [] },
        };
        return this._applyPhoneEntry(e, w);
    },

    // 小手机这一条和酒馆世界书 worldName 的关系。tavernEntries：{ uid: 酒馆原始条目 }
    // 返回 { linked, uid, via: 'push'|'import', tavernChanged, localChanged }；酒馆里那条被删了算没推过
    wbPushStatus(w, worldName, tavernEntries) {
        const none = { linked: false };
        if (!w || !tavernEntries) return none;
        const link = w.tavernPushes && w.tavernPushes[worldName];
        if (link && tavernEntries[link.uid]) {
            const cur = this.wbHash(this._normTavernEntry(tavernEntries[link.uid]));
            return { linked: true, uid: link.uid, via: 'push', tavernChanged: cur !== link.hash, localChanged: this.wbPushHash(w) !== link.localHash };
        }
        const src = w.tavernSource;
        if (src && src.world === worldName && tavernEntries[src.uid]) {
            const cur = this.wbHash(this._normTavernEntry(tavernEntries[src.uid]));
            return { linked: true, uid: src.uid, via: 'import', tavernChanged: cur !== src.hash, localChanged: this.wbEditedLocally(w) === true };
        }
        return none;
    },

    // 酒馆里所有世界书的名字（酒馆的设置接口顺带返回）
    async getSTWorldNames() {
        const resp = await this.apiCall('/api/settings/get', {});
        return Array.isArray(resp && resp.world_names) ? resp.world_names : [];
    },

    // 通知同一个浏览器里开着的酒馆页面（st-launcher.js 在听）：刷新角色列表、世界书、人设
    _tellTavernPage(msg) {
        try {
            const ch = this._getChannel();
            if (ch) ch.postMessage(msg);
        } catch (e) { /* 通知不了就算了，酒馆刷新页面后也能看到 */ }
    },

    // 发一个请求给酒馆页面并等它回话（用来让酒馆页面自己新建用户人设）。没回话返回 null
    _askTavernPage(msg, timeoutMs = 5000) {
        const ch = this._getChannel();
        if (!ch) return Promise.resolve(null);
        if (!this._pageAsks) this._pageAsks = new Map();
        const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise(resolve => {
            this._pageAsks.set(id, resolve);
            setTimeout(() => { if (this._pageAsks.has(id)) { this._pageAsks.delete(id); resolve(null); } }, timeoutMs);
            try { ch.postMessage(Object.assign({}, msg, { id })); } catch (e) { this._pageAsks.delete(id); resolve(null); }
        });
    },

    // 上传用的表单请求（新建角色、上传人设头像）。和 _stFetch 一样带 CSRF，但不能写死 JSON 的 Content-Type
    async _stFetchForm(url, form, parse) {
        const token = await this._getCsrfToken();
        const headers = {};
        if (token) headers['X-CSRF-Token'] = token;
        return this._fetchWithTimeout(url, { method: 'POST', credentials: 'same-origin', headers, body: form }, parse);
    },

    // 把小手机条目推到酒馆世界书 worldName。
    //   opts.create：新建这本世界书（酒馆里已有同名的就报错，重名会直接盖掉原来那本）
    //   opts.mode：'add' 只加没推过的（推过的跳过）/ 'update' 只更新推过的（没推过的跳过）
    // 返回 { added, updated, skipped, notLinked }
    async pushWorldBooksToTavern(worldName, entries, opts = {}) {
        return this._pushWorldBooksToTavern(worldName, entries, opts);
    },
    async _pushWorldBooksToTavern(worldName, entries, opts = {}) {
        const name = String(worldName || '').trim();
        if (!name) throw new Error('酒馆世界书的名字不能空着');
        let data;
        if (opts.create) {
            const names = await this.getSTWorldNames();
            if (names.includes(name)) throw new Error(`酒馆里已经有叫「${name}」的世界书了，换个名字`);
            data = { entries: {} };
        } else {
            data = await this.getSTWorldInfo(name);
            if (!data || typeof data !== 'object') data = {};
            if (!data.entries || typeof data.entries !== 'object') data.entries = {};
        }
        const mode = opts.mode === 'update' ? 'update' : 'add';
        let nextUid = Object.keys(data.entries).reduce((m, k) => Math.max(m, Number(k) || 0, Number(data.entries[k] && data.entries[k].uid) || 0), -1) + 1;
        let added = 0, updated = 0, skipped = 0, notLinked = 0;
        const touched = [];     // [小手机条目, 酒馆 uid]：保存成功后再记下关系
        for (const w of entries || []) {
            const st = this.wbPushStatus(w, name, data.entries);
            if (mode === 'add') {
                if (st.linked) { skipped++; continue; }
                const uid = nextUid++;
                data.entries[uid] = this._newTavernEntry(uid, w);
                touched.push([w, uid]);
                added++;
            } else {
                if (!st.linked) { notLinked++; continue; }
                this._applyPhoneEntry(data.entries[st.uid], w, { keepOrder: st.via === 'import' });
                touched.push([w, st.uid]);
                updated++;
            }
        }
        if (!opts.create && !touched.length) return { added, updated, skipped, notLinked };
        await this.apiCall('/api/worldinfo/edit', { name, data });
        for (const [w, uid] of touched) {
            const hash = this.wbHash(this._normTavernEntry(data.entries[uid]));
            if (!w.tavernPushes || typeof w.tavernPushes !== 'object') w.tavernPushes = {};
            // 原来就是从这本导入的条目不另记推送关系（导入那边的记录已经认得它），两边记录都更新成现在这一版，
            // 免得「导入酒馆世界书」里标成「酒馆里已改」
            const fromHere = w.tavernSource && w.tavernSource.world === name && w.tavernSource.uid === uid;
            if (!fromHere || w.tavernPushes[name]) w.tavernPushes[name] = { uid };
            this._relinkEntry(w, name, uid, hash, data.entries[uid].order);
        }
        if (touched.length && typeof saveData === 'function') await saveData();
        this._tellTavernPage({ type: 'worldinfo-saved', name, created: !!opts.create });
        return { added, updated, skipped, notLinked };
    },

    // 酒馆消息时间的写法（和维护者酒馆里的一样：June 5, 2026 3:27pm）
    _stSendDate(d = new Date()) {
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const h = d.getHours();
        return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
    },
    // 酒馆聊天文件名里的时间（酒馆自己的写法：2026-9-22@15h27m03s）
    _stFileDate(d = new Date()) {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}@${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
    },

    // ========== 头像（2026-09-22 加）==========
    // 酒馆的角色头像、用户头像都是竖长方形（2:3，400×600），列表里显示成圆形，只露出正中间；
    // 小手机头像保持上传时的比例，显示时也只露出正中间。所以：
    //   酒馆 → 小手机：从正中间截一个正方形（就是酒馆圆形/方形头像里看到的那块）
    //   小手机 → 酒馆：把整张图放在 2:3 画布正中间，上下空的地方用这张图模糊放大铺满（圆形里露出的正好是原图）
    TALL_W: 400,
    TALL_H: 600,
    // 正中间最大的正方形：{ sx, sy, s }
    _squareCrop(w, h) {
        const s = Math.min(w, h);
        return { sx: Math.round((w - s) / 2), sy: Math.round((h - s) / 2), s };
    },
    // 整张图放进 W×H 里、居中不裁（contain）/ 铺满 W×H、居中裁掉多的（cover）：{ dx, dy, dw, dh }
    _fitRect(w, h, W, H, cover) {
        const k = cover ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
        const dw = Math.round(w * k), dh = Math.round(h * k);
        return { dx: Math.round((W - dw) / 2), dy: Math.round((H - dh) / 2), dw, dh };
    },
    // 读一张图。外链图片要对方网站允许才能读（否则画到画布上后拿不出来），读不到就报错
    _loadImage(src, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (!src) { reject(new Error('没有头像')); return; }
            const img = new Image();
            if (!/^data:|^blob:/i.test(src)) img.crossOrigin = 'anonymous';
            const timer = setTimeout(() => reject(new Error('读取头像超时')), timeoutMs);
            img.onload = () => { clearTimeout(timer); resolve(img); };
            img.onerror = () => { clearTimeout(timer); reject(new Error('头像读不到')); };
            img.src = src;
        });
    },
    // 酒馆头像地址（和酒馆同一个网址，一定能读）
    tavernCharAvatarUrl(avatar) { return avatar ? `/characters/${encodeURIComponent(avatar)}` : ''; },
    tavernUserAvatarUrl(file) { return file ? `/User%20Avatars/${encodeURIComponent(file)}` : ''; },

    // 酒馆 → 小手机：截正中间的正方形，压成 JPEG（和 yuan 自己上传头像时一样的格式）
    async avatarToSquare(src, size = 400) {
        const img = await this._loadImage(src);
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('头像读不到');
        const c = this._squareCrop(w, h);
        const out = Math.min(size, c.s);
        const canvas = document.createElement('canvas');
        canvas.width = out; canvas.height = out;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';           // 透明底的 PNG 转 JPEG 会变黑，先铺白
        ctx.fillRect(0, 0, out, out);
        ctx.drawImage(img, c.sx, c.sy, c.s, c.s, 0, 0, out, out);
        return canvas.toDataURL('image/jpeg', 0.85);
    },

    // 小手机 → 酒馆：2:3 画布，整张图居中，上下用模糊放大的同一张图铺满。返回 { blob, url }（url 给窗口里预览）
    // 模糊用“先缩到很小再放大”的办法：手机浏览器（苹果）不一定支持画布的模糊滤镜
    async avatarToTall(src) {
        const img = await this._loadImage(src);
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error('头像读不到');
        const W = this.TALL_W, H = this.TALL_H;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        const tiny = document.createElement('canvas');
        tiny.width = 12; tiny.height = 18;
        const cv = this._fitRect(w, h, tiny.width, tiny.height, true);
        tiny.getContext('2d').drawImage(img, cv.dx, cv.dy, cv.dw, cv.dh);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tiny, 0, 0, W, H);
        const r = this._fitRect(w, h, W, H, false);
        ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
        const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('头像处理失败')), 'image/png'));
        return { blob, url: canvas.toDataURL('image/jpeg', 0.8) };
    },

    // 人设头像：先用酒馆自带的默认头像，读不到就用一张灰色小图
    async _defaultAvatarBlob() {
        try {
            const r = await this._fetchWithTimeout('/img/ai4.png', { credentials: 'same-origin' });
            if (r && r.ok && typeof r.blob === 'function') return await r.blob();
        } catch (e) { /* 用下面的灰色小图 */ }
        const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+P//fwAJ4gP5qIAqVAAAAABJRU5ErkJggg==';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: 'image/png' });
    },

    // 在酒馆新建用户人设。同一个浏览器开着酒馆页面时让酒馆页面自己加（它手里的设置不会把我们盖掉）；
    // 没开时直接改酒馆的设置文件，这时返回 via: 'file'，界面上提醒先刷新酒馆页面
    // avatarBlob：用这张图当头像（avatarToTall 做好的）；不给就用酒馆默认头像
    async createTavernPersona(name, description, avatarBlob) {
        const form = new FormData();
        form.append('avatar', avatarBlob || await this._defaultAvatarBlob(), 'avatar.png');
        const up = await this._stFetchForm('/api/avatars/upload', form, (resp) => {
            if (!resp.ok) throw new Error(`上传人设头像失败（API ${resp.status}）`);
            return resp.json();
        });
        const avatarId = up && up.path;
        if (!avatarId) throw new Error('上传人设头像失败：酒馆没有返回头像文件名');
        const answer = await this._askTavernPage({ type: 'add-persona', avatarId, name, description });
        if (answer && answer.ok) return { avatarId, via: 'page' };
        const resp = await this.apiCall('/api/settings/get', {});
        const settings = typeof resp.settings === 'string' ? JSON.parse(resp.settings) : (resp.settings || {});
        const pu = settings.power_user || (settings.power_user = {});
        if (!pu.personas || typeof pu.personas !== 'object') pu.personas = {};
        if (!pu.persona_descriptions || typeof pu.persona_descriptions !== 'object') pu.persona_descriptions = {};
        pu.personas[avatarId] = name;
        pu.persona_descriptions[avatarId] = { description, position: 0, depth: 2, role: 0, lorebook: '' };
        await this.apiCall('/api/settings/save', settings);
        return { avatarId, via: 'file' };
    },

    // 「推送小手机人设」：在酒馆里新建角色。opts：
    //   charId          小手机角色（绑定用）
    //   name / description / firstMes   酒馆角色卡的角色名、角色描述、开场白
    //   avatarBlob      角色头像（avatarToTall 做好的），不给就用酒馆默认头像
    //   userPersona     { name, description, avatarBlob } 或 null：同时新建用户人设
    //   world           { name, entries: [小手机条目] } 或 null：同时新建世界书并设成这个角色的角色世界书
    //   bind            建好后绑定到这个小手机角色（已经绑定过的不绑）
    // 中途失败时，已经建好的写在报错里（done）
    async createTavernCharacter(opts) {
        return this._createTavernCharacter(opts);
    },
    async _createTavernCharacter(opts) {
        const name = String(opts.name || '').trim();
        if (!name) throw new Error('角色名不能空着');
        const done = [];
        const fail = (what, e) => {
            const err = new Error(`${what}失败：${e.message}${done.length ? `（已经建好：${done.join('、')}）` : ''}`);
            err.done = done;
            return err;
        };
        let worldName = '';
        const result = { avatar: null, chatFile: null, world: null, persona: null, bound: false };
        if (opts.world && opts.world.entries && opts.world.entries.length) {
            worldName = String(opts.world.name || '').trim();
            if (!worldName) throw new Error('世界书名字不能空着');
            try {
                const r = await this._pushWorldBooksToTavern(worldName, opts.world.entries, { create: true, mode: 'add' });
                result.world = { name: worldName, added: r.added };
                done.push(`世界书「${worldName}」`);
            } catch (e) { throw fail('新建世界书', e); }
        }
        // 角色卡（酒馆自己新建角色时发的也是表单，照着发）
        let avatar;
        try {
            const form = new FormData();
            const fields = {
                ch_name: name, description: opts.description || '', first_mes: opts.firstMes || '',
                personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '',
                post_history_instructions: '', tags: '', creator: '', character_version: '',
                talkativeness: '0.5', fav: 'false', world: worldName, extensions: '{}',
                depth_prompt_prompt: '', depth_prompt_depth: '4', depth_prompt_role: 'system',
            };
            Object.entries(fields).forEach(([k, v]) => form.append(k, v));
            if (opts.avatarBlob) form.append('avatar', opts.avatarBlob, 'avatar.png');
            avatar = await this._stFetchForm('/api/characters/create', form, (resp) => {
                if (!resp.ok) throw new Error(`API ${resp.status}`);
                return resp.text();
            });
            avatar = String(avatar || '').trim();
            if (!avatar) throw new Error('酒馆没有返回角色文件名');
            result.avatar = avatar;
            done.push(`角色「${name}」`);
        } catch (e) { throw fail('新建角色卡', e); }
        this._tellTavernPage({ type: 'character-created', avatar });

        if (opts.userPersona) {
            try {
                const p = await this.createTavernPersona(String(opts.userPersona.name || '').trim() || 'User', opts.userPersona.description || '', opts.userPersona.avatarBlob);
                result.persona = p;
                done.push('用户人设');
            } catch (e) { throw fail('新建用户人设', e); }
        }

        const cfg = this.getConfig();
        if (opts.bind && opts.charId && !cfg.bindings.some(b => b.uwuCharId === opts.charId)) {
            try {
                // 酒馆新建角色时会在角色卡里写好第一个聊天文件的名字，照着建，酒馆打开这个角色时就是它
                let file = '';
                try {
                    const card = await this.getSTCharacter(avatar);
                    file = String((card && (card.chat || (card.data && card.data.chat))) || '').replace(/\.jsonl$/i, '');
                } catch (e) { /* 读不到就自己起名 */ }
                const now = new Date();
                if (!file) file = `${name} - ${this._stFileDate(now)}`;
                const userName = (opts.userPersona && String(opts.userPersona.name || '').trim()) || 'User';
                const chat = [{ user_name: userName, character_name: name, create_date: this._stFileDate(now), chat_metadata: {} }];
                if (opts.firstMes) chat.push({ name, is_user: false, is_system: false, send_date: this._stSendDate(now), mes: opts.firstMes, extra: {} });
                await this.apiCall('/api/chats/save', { avatar_url: avatar, file_name: file, chat });
                cfg.bindings.push({ uwuCharId: opts.charId, stCharAvatar: avatar, stChatFile: file });
                await this.saveConfig(cfg);
                result.chatFile = file;
                result.bound = true;
            } catch (e) { throw fail('建酒馆聊天文件并绑定', e); }
        }
        return result;
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
function askText(title, placeholder, value) {
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
                <button id="ask-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
                <button id="ask-ok" style="flex:1; ${TS.btnP}">确定</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const input = box.querySelector('#ask-input');
        if (value) input.value = value;
        const done = (v) => { overlay.remove(); resolve(v); };
        box.querySelector('#ask-cancel').addEventListener('click', () => done(null));
        box.querySelector('#ask-ok').addEventListener('click', () => done(input.value.trim()));
        input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value.trim()); });
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
        setTimeout(() => { try { input.focus(); } catch (e) { /* 聚焦失败不影响输入 */ } }, 50);
    });
}

// 自己的多选一小弹窗（浏览器的 confirm 只有两个按钮）。buttons = [{ label, value, style }]，点外面或「取消」返回 null。
function askChoice(title, text, buttons) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:10000; display:flex; align-items:center; justify-content:center; padding:20px;';
        overlay.classList.add('ts-overlay');
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:320px;';
        box.innerHTML = `
            <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">${esc(title)}</h3>
            ${text ? `<div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:14px;">${esc(text)}</div>` : ''}
            <div style="display:flex; flex-direction:column; gap:8px;">
                ${buttons.map((b, i) => `<button data-choice="${i}" style="${b.style || TS.btnP}">${esc(b.label)}</button>`).join('')}
                <button data-choice="cancel" style="padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const done = (v) => { overlay.remove(); resolve(v); };
        box.querySelectorAll('[data-choice]').forEach(btn => btn.addEventListener('click', () => {
            done(btn.dataset.choice === 'cancel' ? null : buttons[parseInt(btn.dataset.choice)].value);
        }));
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
    });
}

// 下载一个文字文件（导出用）
function downloadText(fileName, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    btnPu: 'padding:8px; border-radius:8px; border:none; background:rgba(156,39,176,0.15); color:#9C27B0; font-size:13px; font-weight:500; cursor:pointer;',
    title: 'font-size:16px; font-weight:600;',
    // 页签（推送窗口、世界书窗口）：选中蓝、没选中灰字 #999（不要 inherit，主题文字色可能是粉的）
    tab: (on) => `flex:1; padding:8px 4px; border-radius:8px; border:1px solid ${on ? 'rgba(33,150,243,0.5)' : 'rgba(128,128,128,0.35)'}; background:${on ? 'rgba(33,150,243,0.18)' : 'transparent'}; color:${on ? '#2196F3' : '#999'}; font-size:14px; cursor:pointer;`,
    // 小按钮（恢复默认、+ 添加规则、全选…）：透明底 + 灰框
    // 卡片标题栏右边的「+ 添加」「+ 添加规则」
    btnAdd: 'padding:6px 14px; border-radius:8px; border:none; background:#cee4f1; color:#2a3032; font-size:13px; cursor:pointer;',
    // 弹窗里整行的彩色按钮：接在 btnB/btnG/btnO 后面，和「确认」「取消」一样大
    big: 'padding:10px; border-radius:10px; font-size:14px;',
    btnS: 'padding:4px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:12px; cursor:pointer;',
    // 弹窗里删东西的次要按钮：淡红底（最终确认的「确认删除」才用实心红）
    btnR: 'padding:10px; border-radius:10px; border:none; background:rgba(244,67,54,0.15); color:#f66; font-size:14px; font-weight:500; cursor:pointer;',
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
    const smallBtn = TS.btnS;

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
                        <button id="ts-add-btn" style="${TS.btnAdd}">+ 添加</button>
                    </div>
                    <div id="ts-bindings-list"></div>
                </div>
            </div>
            <div id="ts-settings-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <span style="${TS.title}">从小手机推送到酒馆</span>
                    <div style="display:flex; gap:8px; margin-top:12px;">
                        <button id="ts-push-persona" style="flex:1; ${TS.btnO}">推送小手机人设</button>
                        <button id="ts-push-wb" style="flex:1; ${TS.btnO}">推送小手机世界书</button>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:14px; padding-top:12px; border-top:1px solid #f0f0f0;">
                        <span style="font-size:13px; white-space:nowrap;">推送楼层模式</span>
                        <select id="ts-push-mode" aria-label="推送楼层模式" title="推送楼层模式" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px;">
                            <option value="new" ${(config.pushMode || 'new') === 'new' ? 'selected' : ''}>新开楼层</option>
                            <option value="append" ${config.pushMode === 'append' ? 'selected' : ''}>合并到最后一楼</option>
                        </select>
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:4px; line-height:1.6;">新开楼层：小手机消息以你的身份单独发在新的一楼中。如果酒馆最后一楼就是上次新开的这层楼，就接着写进去，不会每次都新开。<br>合并到最后一楼：不管最后一楼是谁发的，都把小手机消息接在那一楼末尾。</div>
                    <div style="margin-top:14px; padding-top:12px; border-top:1px solid #f0f0f0;">
                        <div style="display:flex; align-items:center; gap:8px; font-size:13px;">
                            <span style="white-space:nowrap;">按角色设置</span>
                            <select id="ts-push-char" aria-label="按角色设置" title="按角色设置" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px;"></select>
                        </div>
                        <div id="ts-push-per-char"></div>
                    </div>
                </div>
                <div style="${TS.card} margin-top:12px;">
                    <span style="${TS.title}">发给 AI 的酒馆剧情</span>
                    <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
                        <span style="font-size:13px; flex:1;">最近几楼发原文</span>
                        ${numInput('ts-raw-count', config.rawFloorCount)}
                    </div>
                    <div style="font-size:12px; color:#888; margin-top:4px; line-height:1.6;">发给 AI 时，最近这么多楼酒馆剧情给完整原文，更早的换成柏宝书摘要（还没有摘要的暂时发原文）。</div>
                    <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; font-size:13px; cursor:pointer;">
                        <div>
                            <div>发原文的酒馆楼层中包含 user 楼层</div>
                            <div style="font-size:12px; color:#888; line-height:1.6; margin-top:2px;">关闭后，发原文的酒馆楼层中只包含 AI 楼层，若不抢话不转述可能导致剧情不连贯。</div>
                        </div>
                        <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" id="ts-inject-user-floors" ${config.injectUserFloors !== false ? 'checked' : ''}><span class="kkt-slider"></span></span>
                    </label>
                    <div id="ts-wrap-toggle" style="display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; margin-top:14px; padding-top:12px; border-top:1px solid #f0f0f0;">
                        <span style="font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">酒馆剧情包裹提示词自定义</span>
                        <span id="ts-wrap-arrow" style="font-size:12px; color:#888; white-space:nowrap; flex-shrink:0;">点击展开</span>
                    </div>
                    <div id="ts-wrap-body" style="display:none;">
                        <div style="font-size:12px; color:#888; margin:6px 0 10px; line-height:1.6;">
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
            </div>
            <div id="ts-rules-area" style="display:none; margin-top:12px;">
                <div style="${TS.card}">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <span style="${TS.title}">正则清洗规则</span>
                        <button id="ts-add-rule-btn" style="${TS.btnAdd}">+ 添加规则</button>
                    </div>
                    <input type="file" id="ts-import-rules-file" accept=".json,application/json" style="display:none;">
                    <div style="font-size:12px; color:#888; line-height:1.6;">同步和推送时，文字会复制一份到另一边。这里的规则在复制的那一刻先把文字处理一遍，删掉不想要的部分，原来那边的内容不动。</div>
                    <div id="ts-rules-help-toggle" style="display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer; margin:10px 0; padding:8px 0; border-top:1px solid #f0f0f0; border-bottom:1px solid #f0f0f0;">
                        <span style="font-size:13px; white-space:nowrap;">正则清洗怎么用</span>
                        <span id="ts-rules-help-arrow" style="font-size:12px; color:#888; white-space:nowrap; flex-shrink:0;">点击展开</span>
                    </div>
                    <div id="ts-rules-help-body" style="display:none; font-size:12px; color:#888; line-height:1.6; margin-bottom:12px;">
                        <div style="font-size:13px; color:inherit; margin-bottom:2px;">什么时候起作用</div>
                        <div>同步：酒馆剧情复制进小手机之前。小手机里的酒馆剧情卡片、发给小手机 AI 的内容，都是处理后的文字；酒馆里的原文不变。一楼处理完什么都不剩时，这一楼不会同步进来。</div>
                        <div>推送：小手机消息复制进酒馆之前。酒馆里收到的是处理后的文字；小手机里的原文不变。</div>
                        <div>每条规则在「用在」里选同步、推送，还是两头都用。</div>
                        <div style="font-size:13px; color:inherit; margin:10px 0 2px;">为什么需要</div>
                        <div>酒馆自己的正则大多只改显示出来的样子，酒馆存着的原文不变，而小手机读到的是原文。所以在酒馆里被藏起来的思考过程、状态栏、前端卡片代码，同步时会原样进小手机，既占地方，又会发给小手机的 AI。在这里加一条「排除」规则就能去掉。</div>
                        <div style="font-size:13px; color:inherit; margin:10px 0 2px;">两种模式</div>
                        <div>排除：删掉匹配到的部分，其余留着。例如 <code>&lt;status&gt;[\\s\\S]*?&lt;/status&gt;</code> 会删掉状态栏那一段。</div>
                        <div>提取：只留匹配到的部分，其余全部去掉。例如正文写在 &lt;content&gt; 标签里，就用 <code>&lt;content&gt;([\\s\\S]*?)&lt;/content&gt;</code> 只留标签里面那段（写了小括号时，只留第一对小括号圈住的部分）。一处都没匹配到时，整段原样不动。</div>
                        <div style="font-size:13px; color:inherit; margin:10px 0 2px;">顺序和分组</div>
                        <div>多条规则按列表从上往下依次处理，上一条处理完的结果交给下一条。分组只是为了整理，关掉分组的开关，组里的规则就都不起作用。</div>
                        <div style="font-size:13px; color:inherit; margin:10px 0 2px;">新加或修改规则以后</div>
                        <div>同步：下次同步时，已经在小手机里的酒馆剧情也会按新规则重新处理。这几种不动：你在小手机里改过字的楼层（页面顶部会提示）、精简过的楼层（正文是柏宝书摘要）、按新规则处理完什么都不剩的楼层。</div>
                        <div>推送：只对以后推送的消息起作用，已经推到酒馆的不会变。想换掉，用「推送/清理消息」里的「清理酒馆」删掉再重新推。</div>
                        <div style="font-size:13px; color:inherit; margin:10px 0 2px;">其他</div>
                        <div>被规则改过的酒馆剧情，在小手机里编辑后不能写回酒馆，因为写回会把被删掉的那部分从酒馆原文里一起弄丢。</div>
                        <div>这里和小手机自带的「正则过滤」不是一回事：那个是在小手机 AI 的回复存进小手机之前处理，删掉的内容在小手机里也看不到了。</div>
                    </div>
                    <div id="ts-rules-tools" style="margin-bottom:10px;"></div>
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
                <button id="ts-issues-clear" style="${smallBtn} border-color:transparent; background:rgba(244,67,54,0.15); color:#f66;">清空</button>
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
        // 清空了就当没改，退回原来的数（原来也没有才用默认值）
        const old = parseInt(cfg[key], 10);
        cfg[key] = Number.isInteger(n) && n >= 0 ? n : (Number.isInteger(old) && old >= 0 ? old : fallback);
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
            perCharBox.innerHTML = '<div style="font-size:12px; color:#888; margin-top:10px; line-height:1.6;">先在上面添加角色绑定，这里才能按角色设置。</div>';
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
            <label style="display:flex; align-items:center; gap:8px; margin-top:12px; font-size:13px;">
                <span style="white-space:nowrap;">通话推送</span>
                <select id="ts-cc-call" aria-label="通话推送" title="通话推送" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px;">
                    <option value="summary" ${callMode === 'summary' ? 'selected' : ''}>只推总结</option>
                    <option value="context" ${callMode === 'context' ? 'selected' : ''}>只推记录</option>
                    <option value="both" ${callMode === 'both' ? 'selected' : ''}>都推送</option>
                    <option value="none" ${callMode === 'none' ? 'selected' : ''}>不推送</option>
                </select>
            </label>
            <div style="font-size:12px; color:#888; margin-top:4px; line-height:1.6;">总结 = 小手机自动写的那段通话总结；记录 = 通话过程中的每一句话。前三种都带“打了多久”。</div>
            <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; font-size:13px; cursor:pointer;">
                <div>
                    <div>推送状态栏到酒馆</div>
                    <div style="font-size:12px; color:#888; line-height:1.6; margin-top:2px;">关闭后，推送到酒馆的小手机消息会按这个角色的状态栏正则剥掉状态栏，专门的状态更新楼层也不推。</div>
                </div>
                <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" id="ts-cc-status" ${statusOn ? 'checked' : ''}><span class="kkt-slider"></span></span>
            </label>
            <label style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px; font-size:13px; cursor:pointer;">
                <div>
                    <div>推送在线状态到酒馆</div>
                    <div style="font-size:12px; color:#888; line-height:1.6; margin-top:2px;">在线状态是 AI 写的“[角色更新状态为：…]”，用来改小手机界面上那行状态文字。默认不推。</div>
                </div>
                <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" id="ts-cc-online" ${onlineOn ? 'checked' : ''}><span class="kkt-slider"></span></span>
            </label>
            <div style="font-size:12px; color:#888; margin-top:10px; line-height:1.6;">这几项只影响以后推送的消息，已经在酒馆里的不会跟着改或被删掉。</div>`;
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
    // 推送小手机人设（建好后可能多了一个绑定，要重画绑定卡片）/ 推送小手机世界书（新建世界书时默认填「按角色设置」里选的那个角色的名字）
    mainEl.querySelector('#ts-push-persona').addEventListener('click', () => showPushPersonaModal(() => renderBindings()));
    mainEl.querySelector('#ts-push-wb').addEventListener('click', () => {
        const ch = db.characters.find(c => c.id === pushCharSelect.dataset.charId);
        showPushWorldBookModal(ch ? TavernSync.phoneCharName(ch) : '');
    });
    mainEl.querySelector('#ts-add-rule-btn').addEventListener('click', () => showRuleEditor(null, () => renderRules()));
    const importFile = mainEl.querySelector('#ts-import-rules-file');
    importFile.addEventListener('change', () => {
        const file = importFile.files && importFile.files[0];
        importFile.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => showImportRulesModal(String(reader.result || ''), () => renderRules());
        reader.onerror = () => showToast('读不了这个文件');
        reader.readAsText(file);
    });

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
    mainEl.querySelector('#ts-rules-help-toggle').addEventListener('click', () => {
        const body = mainEl.querySelector('#ts-rules-help-body');
        const open = body.style.display === 'none';
        body.style.display = open ? 'block' : 'none';
        mainEl.querySelector('#ts-rules-help-arrow').textContent = open ? '点击收起' : '点击展开';
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
            ? '同一个浏览器里开着酒馆页面：小手机推送后，酒馆会自动重新读取酒馆聊天文件，不用手动刷新。'
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
                    ${u.password ? '<span style="font-size:11px; color:#888; margin-left:auto;">需要密码</span>' : ''}</button>`).join('')}
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
    // 多选：rulesSelected 不是 null 时处在多选状态，里面是勾上的规则编号（rule.id）
    let rulesSelected = null;
    let rulesMode = 'multi';
    const rulesTools = mainEl.querySelector('#ts-rules-tools');
    const smallDisabled = (on) => on ? '' : 'disabled';

    function exportRules(ids, total) {
        const data = TavernSync.exportCleanRules(ids);
        const groups = [...new Set(data.rules.map(r => r.group || ''))];
        const label = data.rules.length === total ? '全部'
            : (groups.length === 1 && groups[0]) ? groups[0] : `${data.rules.length}条`;
        downloadText(`酒馆互联正则_${label.replace(/[\\/:*?"<>|]/g, '_')}.json`, JSON.stringify(data, null, 2));
        showToast(`已导出 ${data.rules.length} 条正则`);
    }

    // 两种勾选状态：rulesMode = 'multi'（多选：开启、关闭、移动分组、删除，做完留在多选里）
    //                         'export'（导出：一进来全部勾上，只有「导出」，导完就退出）
    function renderRuleTools(rules) {
        if (!rulesSelected) {
            rulesTools.innerHTML = `<div style="display:flex; gap:6px;">
                <button id="ts-rules-multi" style="${TS.btnS}">多选</button>
                <button id="ts-rules-import" style="${TS.btnS}">导入</button>
                <button id="ts-rules-export" style="${TS.btnS}">导出</button>
            </div>`;
            rulesTools.querySelector('#ts-rules-multi').addEventListener('click', () => {
                if (!rules.length) { showToast('还没有规则'); return; }
                rulesSelected = new Set(); rulesMode = 'multi'; renderRules();
            });
            rulesTools.querySelector('#ts-rules-import').addEventListener('click', () => mainEl.querySelector('#ts-import-rules-file').click());
            rulesTools.querySelector('#ts-rules-export').addEventListener('click', () => {
                if (!rules.length) { showToast('还没有规则可以导出'); return; }
                rulesSelected = new Set(rules.map(r => r.id)); rulesMode = 'export'; renderRules();
            });
            return;
        }
        const n = rules.filter(r => rulesSelected.has(r.id)).length;
        const any = n > 0;
        const allOn = any && n === rules.length;
        const dim = any ? '' : 'opacity:0.5; cursor:default;';
        const exporting = rulesMode === 'export';
        const btnRs = 'padding:8px; border-radius:8px; border:none; background:rgba(244,67,54,0.15); color:#f66; font-size:13px; font-weight:500; cursor:pointer;';
        const actions = exporting ? `
                <div style="font-size:12px; color:#888; line-height:1.6; margin-top:6px;">勾上要导出的规则，再点下面的「导出」。</div>
                <div style="display:flex; margin-top:8px;">
                    <button data-batch="export" ${smallDisabled(any)} style="flex:1; ${TS.btnG} ${dim}">导出</button>
                </div>` : `
                <div style="display:flex; gap:6px; margin-top:8px;">
                    <button data-batch="enable" ${smallDisabled(any)} style="flex:1; ${TS.btnG} ${dim}">开启</button>
                    <button data-batch="disable" ${smallDisabled(any)} style="flex:1; ${TS.btnG} ${dim}">关闭</button>
                </div>
                <div style="display:flex; gap:6px; margin-top:6px;">
                    <button data-batch="move" ${smallDisabled(any)} style="flex:1; ${TS.btnG} ${dim}">移动分组</button>
                    <button data-batch="delete" ${smallDisabled(any)} style="flex:1; ${btnRs} ${dim}">删除</button>
                </div>`;
        rulesTools.innerHTML = `
            <div style="border:1px solid #eee; border-radius:10px; padding:10px;">
                <div style="display:flex; align-items:center; gap:6px;">
                    <span style="flex:1; font-size:12px; color:#888;">${exporting ? '导出' : '多选'} · 已选 ${n} 条</span>
                    <button id="ts-rules-all" style="${TS.btnS}">${allOn ? '取消全选' : '全选'}</button>
                    <button id="ts-rules-done" style="${TS.btnS}">${exporting ? '取消' : '完成'}</button>
                </div>${actions}
            </div>`;
        rulesTools.querySelector('#ts-rules-all').addEventListener('click', () => {
            rulesSelected = allOn ? new Set() : new Set(rules.map(r => r.id)); renderRules();
        });
        rulesTools.querySelector('#ts-rules-done').addEventListener('click', () => { rulesSelected = null; renderRules(); });
        rulesTools.querySelectorAll('[data-batch]').forEach(btn => btn.addEventListener('click', async () => {
            const ids = rules.filter(r => rulesSelected.has(r.id)).map(r => r.id);
            if (!ids.length) return;
            const action = btn.dataset.batch;
            if (action === 'export') {
                exportRules(ids, rules.length);
                rulesSelected = null; renderRules();
                return;
            }
            let group;
            if (action === 'move') {
                group = await askRuleGroup(`把选中的 ${ids.length} 条规则移到`);
                if (group == null) return;
            }
            if (action === 'delete' && !confirm(`删除选中的 ${ids.length} 条规则？`)) return;
            const done = await TavernSync.batchCleanRules(ids, action, group);
            const verb = { enable: '开启了', disable: '关闭了', move: '移动了', delete: '删除了' }[action];
            showToast(`${verb} ${done} 条规则`);
            rulesSelected = new Set(); renderRules();
        }));
    }

    function renderRules() {
        const cfg = TavernSync.getConfig();
        const rules = cfg.cleanRules || [];
        // 很老的规则可能没有编号，多选要靠编号认规则，补上
        if (rules.some(r => !r.id)) {
            rules.forEach((r, i) => { if (!r.id) r.id = `rule_${Date.now()}_${i}`; });
            TavernSync.saveConfig(cfg);
        }
        if (!rules.length) rulesSelected = null;
        if (rulesSelected) rulesSelected = new Set([...rulesSelected].filter(id => rules.some(r => r.id === id)));
        renderRuleTools(rules);
        if (!rules.length) { rulesList.innerHTML = '<div style="text-align:center; color:#888; font-size:12px; padding:10px;">暂无规则，文字原样同步和推送。</div>'; return; }
        const multi = !!rulesSelected;
        // 哪些分组收起来了：只是看着方便，记在这个浏览器里就行
        let collapsed = [];
        try { collapsed = JSON.parse(localStorage.getItem('tavernSyncRuleGroupsCollapsed') || '[]') || []; } catch (e) { collapsed = []; }
        const off = new Set(cfg.ruleGroupsOff || []);
        const ruleRow = (r) => {
            const i = rules.indexOf(r);
            const picked = multi && rulesSelected.has(r.id);
            return `
            <div ${multi ? `data-pick="${i}"` : ''} style="display:flex; align-items:center; gap:8px; padding:8px; background:${picked ? 'rgba(33,150,243,0.12)' : 'rgba(128,128,128,0.08)'}; border-radius:8px; margin-bottom:6px; ${multi ? 'cursor:pointer;' : ''}">
                ${multi ? `<input type="checkbox" ${picked ? 'checked' : ''} style="flex-shrink:0; pointer-events:none;">` : ''}
                <div style="flex:1; min-width:0; ${multi ? '' : 'cursor:pointer;'}" ${multi ? '' : `data-edit="${i}"`}>
                    <div style="font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.name || '未命名')}${multi && !r.enabled ? '<span style="font-size:11px; color:#888; font-weight:normal;">（关着）</span>' : ''}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.mode === 'extract' ? '提取' : '排除'} · ${r.scope === 'pull' ? '同步' : r.scope === 'push' ? '推送' : '同步和推送'} · /${esc(r.regex)}/</div>
                </div>
                ${multi ? '' : `<label class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-toggle="${i}" ${r.enabled ? 'checked' : ''}><span class="kkt-slider"></span></label>
                <button data-delrule="${i}" style="${TS.btnD} font-size:14px;">✕</button>`}
            </div>`;
        };
        const groups = TavernSync.ruleGroupsOf(cfg);
        rulesList.innerHTML = rules.filter(r => !r.group).map(ruleRow).join('') + groups.map((g, gi) => {
            const inGroup = rules.filter(r => r.group === g);
            const isCollapsed = collapsed.includes(g);
            const nPicked = multi ? inGroup.filter(r => rulesSelected.has(r.id)).length : 0;
            return `
            <div style="border:1px solid #eee; border-radius:10px; padding:8px 8px 2px; margin-bottom:8px;">
                <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                    ${multi ? `<input type="checkbox" data-gpick="${gi}" ${nPicked === inGroup.length ? 'checked' : ''} style="flex-shrink:0;">` : ''}
                    <div data-fold="${gi}" style="flex:1; min-width:0; cursor:pointer; display:flex; align-items:center; gap:6px;">
                        <span style="font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(g)}</span>
                        <span style="font-size:11px; color:#888; white-space:nowrap; flex-shrink:0;">${multi && nPicked ? `选了 ${nPicked} / ${inGroup.length} 条` : `${inGroup.length} 条`} · ${isCollapsed ? '展开' : '收起'}</span>
                    </div>
                    ${multi ? '' : `<button data-rename="${gi}" style="${TS.btnS} flex-shrink:0;">改名</button>
                    <button data-delgroup="${gi}" style="${TS.btnS} flex-shrink:0;">删除</button>
                    <label class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-gtoggle="${gi}" ${off.has(g) ? '' : 'checked'}><span class="kkt-slider"></span></label>`}
                </div>
                <div style="${isCollapsed ? 'display:none;' : ''} padding-left:8px;">${inGroup.map(ruleRow).join('')}</div>
            </div>`;
        }).join('');
        // 一部分勾上的分组，勾选框显示成“半选”
        if (multi) rulesList.querySelectorAll('[data-gpick]').forEach(cb => {
            const inGroup = rules.filter(r => r.group === groups[parseInt(cb.dataset.gpick)]);
            const k = inGroup.filter(r => rulesSelected.has(r.id)).length;
            cb.indeterminate = k > 0 && k < inGroup.length;
        });
        rulesList.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => {
            const r = rules[parseInt(el.dataset.pick)];
            if (rulesSelected.has(r.id)) rulesSelected.delete(r.id); else rulesSelected.add(r.id);
            renderRules();
        }));
        rulesList.querySelectorAll('[data-gpick]').forEach(cb => cb.addEventListener('change', () => {
            const inGroup = rules.filter(r => r.group === groups[parseInt(cb.dataset.gpick)]);
            const allOn = inGroup.every(r => rulesSelected.has(r.id));
            inGroup.forEach(r => { if (allOn) rulesSelected.delete(r.id); else rulesSelected.add(r.id); });
            renderRules();
        }));
        rulesList.querySelectorAll('[data-fold]').forEach(el => el.addEventListener('click', () => {
            const g = groups[parseInt(el.dataset.fold)];
            collapsed = collapsed.includes(g) ? collapsed.filter(x => x !== g) : [...collapsed, g];
            try { localStorage.setItem('tavernSyncRuleGroupsCollapsed', JSON.stringify(collapsed)); } catch (e) { /* 记不住也不影响 */ }
            renderRules();
        }));
        rulesList.querySelectorAll('[data-gtoggle]').forEach(cb => cb.addEventListener('change', async () => {
            const g = groups[parseInt(cb.dataset.gtoggle)];
            const cfg = TavernSync.getConfig();
            const list = (cfg.ruleGroupsOff || []).filter(x => x !== g);
            if (!cb.checked) list.push(g);
            cfg.ruleGroupsOff = list;
            await TavernSync.saveConfig(cfg);
        }));
        rulesList.querySelectorAll('[data-rename]').forEach(btn => btn.addEventListener('click', async () => {
            const g = groups[parseInt(btn.dataset.rename)];
            const name = ((await askText('分组改名', '新名字', g)) || '').trim();
            if (!name || name === g) return;
            const cfg = TavernSync.getConfig();
            if (TavernSync.ruleGroupsOf(cfg).includes(name)) { showToast('已经有叫这个名字的分组'); return; }
            (cfg.cleanRules || []).forEach(r => { if (r.group === g) r.group = name; });
            cfg.ruleGroupsOff = (cfg.ruleGroupsOff || []).map(x => x === g ? name : x);
            if (cfg.lastRuleGroup === g) cfg.lastRuleGroup = name;
            await TavernSync.saveConfig(cfg);
            if (collapsed.includes(g)) {
                collapsed = collapsed.map(x => x === g ? name : x);
                try { localStorage.setItem('tavernSyncRuleGroupsCollapsed', JSON.stringify(collapsed)); } catch (e) { /* 记不住也不影响 */ }
            }
            renderRules();
        }));
        rulesList.querySelectorAll('[data-delgroup]').forEach(btn => btn.addEventListener('click', async () => {
            const g = groups[parseInt(btn.dataset.delgroup)];
            const n = rules.filter(r => r.group === g).length;
            const how = await askChoice(`删除分组「${g}」`, `这个分组里有 ${n} 条规则。`, [
                { label: '只删分组，规则留着', value: 'keep', style: TS.btnP },
                { label: '连规则一起删', value: 'all', style: TS.btnR },
            ]);
            if (!how) return;
            const cfg = TavernSync.getConfig();
            if (how === 'all') cfg.cleanRules = (cfg.cleanRules || []).filter(r => r.group !== g);
            else (cfg.cleanRules || []).forEach(r => { if (r.group === g) delete r.group; });
            cfg.ruleGroupsOff = (cfg.ruleGroupsOff || []).filter(x => x !== g);
            if (cfg.lastRuleGroup === g) cfg.lastRuleGroup = '';
            await TavernSync.saveConfig(cfg);
            renderRules();
        }));
        rulesList.querySelectorAll('[data-toggle]').forEach(cb => cb.addEventListener('change', async () => { const cfg = TavernSync.getConfig(); cfg.cleanRules[parseInt(cb.dataset.toggle)].enabled = cb.checked; await TavernSync.saveConfig(cfg); }));
        rulesList.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => showRuleEditor(parseInt(el.dataset.edit), () => renderRules())));
        rulesList.querySelectorAll('[data-delrule]').forEach(btn => btn.addEventListener('click', async () => {
            const cfg = TavernSync.getConfig();
            const idx = parseInt(btn.dataset.delrule);
            const rule = cfg.cleanRules[idx];
            if (!rule) return;
            if (!confirm(`删除清洗规则「${rule.name || '未命名'}」？`)) return;
            cfg.cleanRules.splice(idx, 1);
            // 分组里最后一条删掉后分组就没了，它的开关记录也一起去掉，免得以后新建同名分组时一上来就是关着的
            const left = TavernSync.ruleGroupsOf(cfg);
            cfg.ruleGroupsOff = (cfg.ruleGroupsOff || []).filter(x => left.includes(x));
            await TavernSync.saveConfig(cfg);
            renderRules();
        }));
    }

    // ===== 绑定列表 =====
    function renderBindings() {
        try { renderPushPerChar(); } catch (e) { /* 还没画到那一块时跳过 */ }
        const cfg = TavernSync.getConfig();
        if (!cfg.bindings?.length) { bindingsList.innerHTML = '<div style="text-align:center; color:#888; font-size:12px; padding:20px;">暂无绑定，点击上方「+ 添加」关联角色。</div>'; return; }
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
                ? `小手机里有 ${floorCount} 楼酒馆剧情（${sizeText}${trimText}）。<br>上次同步 ${fmtSync(mem.lastSync)}`
                : (mem && mem.lastSync ? '这个酒馆聊天文件还没同步。' : '未同步'))
                + (otherMsgs.length ? `<br>另有 ${otherMsgs.length} 楼来自以前绑定的酒馆聊天文件（${sizeOf(charsOf(otherMsgs))}）。` : '');
            const maxMem = parseInt(char && char.maxMemory, 10) || 20;   // 这个角色在聊天设置里的“可见上文条数”
            return `<div style="${TS.subCard}">
                <div style="margin-bottom:6px;">
                    <div><div style="display:flex; align-items:center; gap:8px;">
                            <span style="flex:1; min-width:0; font-size:14px; font-weight:600; word-break:break-all;">${esc(charName)} ↔ ${esc(stName)}</span>
                            <button data-del="${i}" style="${TS.btnD} flex-shrink:0; padding:0 4px; line-height:1;">✕</button></div>
                        <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
                            <span style="flex:1; min-width:0; font-size:11px; color:#888; word-break:break-all;">酒馆聊天文件：${esc(b.stChatFile || '未选')}</span>
                            <button data-chat="${i}" style="${TS.btnS} flex-shrink:0; padding:2px 8px; font-size:11px; line-height:1.5;">更换</button></div>
                        <div style="font-size:11px; color:#888; margin-top:2px;">酒馆里开了新的酒馆聊天文件时，记得更换。</div>
                        ${newer ? `<div style="font-size:11px; color:#2196F3; margin-top:4px; word-break:break-all;">${newer.curGone
                            ? `现在绑定的酒馆聊天文件「${esc(b.stChatFile || '')}」已不存在，可能已被删除或重命名。这个酒馆角色最近玩的是酒馆聊天文件「${esc(newer.file)}」。`
                            : `这个酒馆角色还有另一个酒馆聊天文件「${esc(newer.file)}」，它的最后一条消息比现在绑定的酒馆聊天文件更晚，你可能在酒馆里换到那个酒馆聊天文件玩了。`}要把绑定改成酒馆聊天文件「${esc(newer.file)}」吗？改了之后，从酒馆同步剧情、往酒馆推送小手机消息都改用它；以前同步进小手机的酒馆剧情会留着，如果不想要，改绑后点「管理同步范围」，在里面点红色的「删掉以前的酒馆聊天文件留下的……楼」。</div>
                        <div style="display:flex; justify-content:flex-end; gap:6px; margin-top:4px; margin-bottom:8px;">
                            <button data-newer-go="${i}" style="padding:2px 8px; border-radius:6px; border:1px solid rgba(33,150,243,0.5); background:rgba(33,150,243,0.15); color:#2196F3; font-size:11px; line-height:1.5; cursor:pointer;">改绑</button>
                            <button data-newer-no="${i}" style="padding:2px 8px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:11px; line-height:1.5; cursor:pointer;">不改</button></div>` : ''}
                        <div style="font-size:11px; color:#888; margin-top:2px;">${syncInfo}</div>
                        ${isDup ? `<div style="font-size:11px; color:#f66; margin-top:2px;">这个角色上面已经绑定过，这一条不起作用，可以删掉。</div>` : ''}</div></div>
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
                    <button data-preview="${i}" style="flex:1; ${TS.btnPu}">提示词预览</button></div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; font-size:13px; cursor:pointer;">
                    <span>自动同步酒馆剧情</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-auto="autoPull" data-idx="${i}" ${TavernSync.isAuto(b, 'autoPull') ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                ${!TavernSync.isAuto(b, 'autoPull') ? `<div style="font-size:11px; color:#888; margin:4px 0 0 12px;">关着时，酒馆里的新剧情要点「同步酒馆剧情」才会进来。</div>` : ''}
                <div style="display:${synced ? 'none' : 'flex'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    第一次同步最近
                    <input type="number" data-first-num="${i}" min="0" value="${firstCount}"
                        style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;"> 楼
                    <span style="font-size:11px; color:#888; width:100%;">这个角色还没同步过。之后每次同步都会带进全部新楼层，不看这个数字；想挑具体楼层用「管理同步范围」。</span>
                </div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>自动推送小手机消息</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-auto="autoPush" data-idx="${i}" ${TavernSync.isAuto(b, 'autoPush') ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                ${!TavernSync.isAuto(b, 'autoPush') ? `<div style="font-size:11px; color:#888; margin:4px 0 0 12px;">关着时，小手机消息要在「推送/清理消息」里手动推到酒馆。</div>` : ''}
                <div data-firstpush-row="${i}" style="display:${(b.lastPushedMsgId || b.hasPushed) ? 'none' : 'flex'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    第一次自动推送最近
                    <input type="number" data-firstpush="${i}" min="0" value="${TavernSync.firstPushCountFor(b)}"
                        style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;"> 条
                    <span style="font-size:11px; color:#888; width:100%;">这个角色还没推送过。只有自动推送第一次执行时看这个数字（填 0 就不自动补推）；手动推送在「推送/清理消息」窗口里自己选范围。</span>
                </div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>双向自动更新人设</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-personaauto="${i}" ${b.autoUpdatePersona ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="display:${b.autoUpdatePersona ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    更新
                    <select data-persona-mode="${i}" aria-label="自动更新哪个人设" title="自动更新哪个人设" style="padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px;">
                        <option value="both" ${TavernSync.personaUpdateMode(b) === 'both' ? 'selected' : ''}>角色人设和用户人设</option>
                        <option value="char" ${TavernSync.personaUpdateMode(b) === 'char' ? 'selected' : ''}>只更新角色人设</option>
                        <option value="user" ${TavernSync.personaUpdateMode(b) === 'user' ? 'selected' : ''}>只更新用户人设</option>
                    </select>
                    <span style="font-size:11px; color:#888; width:100%;">每次同步和离开小手机时检查：酒馆里改了就更新到小手机，小手机里改了就推送到酒馆，头像也一样；两边都改过的不动，会在这里让你选用哪边的。用户人设跟着你上次在「导入酒馆人设」里选的那个，没选过就跟着酒馆里当前选中的人设。</span>
                </div>
                ${TavernSync.personaConflicts(b).map(k => `
                <div style="display:flex; align-items:center; gap:6px; margin:6px 0 0 12px; font-size:11px; color:#FF9800; line-height:1.5; flex-wrap:wrap;">
                    <span style="flex:1; min-width:0;">${TavernSync.PERSONA_LABELS[k]}在酒馆和小手机里都改过，选用哪边的：</span>
                    <button data-pconf="${i}" data-key="${k}" data-use="tavern" style="${TS.btnS} font-size:11px; padding:2px 8px; line-height:1.5;">用酒馆的</button>
                    <button data-pconf="${i}" data-key="${k}" data-use="phone" style="${TS.btnS} font-size:11px; padding:2px 8px; line-height:1.5;">用小手机的</button>
                </div>`).join('')}
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>双向自动更新复制过的世界书</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-wbauto="${i}" ${b.autoUpdateWorldBooks ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="font-size:11px; color:#888; margin:4px 0 0 12px;">酒馆里改了就更新到小手机，小手机里改了就推送到酒馆；两边都改过的不动，页面顶部会提示。只管两边已经互通过的条目：从这个角色的酒馆世界书导入到小手机的，和从小手机推送到这个角色的酒馆世界书里的。以后新加的条目不会自动过去，要在「导入酒馆世界书」或「推送小手机世界书」里手动加。</div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>自动精简旧楼层</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-trimauto="${i}" ${b.autoTrim ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="display:${b.autoTrim ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    保留最近
                    <input type="number" data-trim-num="${i}" min="${cfg.rawFloorCount}" value="${TavernSync.keepRawFloorCount(b)}"
                        style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;"> 楼的原文
                    <span style="font-size:11px; color:#888; width:100%;">更早的楼层只留柏宝书摘要。不能少于「最近几楼发原文」（现在是 ${cfg.rawFloorCount} 楼）。</span>
                </div>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; font-size:13px; cursor:pointer;">
                    <span>单独限制酒馆上文</span>
                    <span class="kkt-switch" style="flex-shrink:0;"><input type="checkbox" data-limit="${i}" ${b.limitTavernContext ? 'checked' : ''}><span class="kkt-slider"></span></span>
                </label>
                <div style="display:${b.limitTavernContext ? 'flex' : 'none'}; align-items:center; gap:8px; margin:6px 0 0 12px; font-size:13px; flex-wrap:wrap;">
                    发给 AI 的酒馆剧情最多
                    <input type="number" data-limit-num="${i}" min="0" max="${maxMem}" value="${Math.min(maxMem, parseInt(b.tavernContextCount, 10) || 0)}"
                        style="width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;"> 楼
                    <span style="font-size:11px; color:#888; width:100%;">这个角色的可见上文是 ${maxMem} 条：取最新的这么多楼酒馆剧情，剩下的名额给小手机消息。</span>
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
            if (!Number.isInteger(n) || n < 0) n = TavernSync.firstPushCountFor(b);   // 清空了就当没改
            inp.value = n;
            b.firstPushCount = n;
            await TavernSync.saveConfig(cfg);
        }));
        bindingsList.querySelectorAll('[data-first-num]').forEach(inp => inp.addEventListener('change', async () => {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings[parseInt(inp.dataset.firstNum)];
            if (!b) return;
            let n = parseInt(inp.value, 10);
            if (!Number.isInteger(n) || n < 0) n = TavernSync.initialImportFor(b);   // 清空了就当没改
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
        // 人设两边都改过：选用哪边的
        bindingsList.querySelectorAll('[data-pconf]').forEach(btn => btn.addEventListener('click', async () => {
            const b = TavernSync.getConfig().bindings[parseInt(btn.dataset.pconf, 10)];
            if (!b) return;
            const label = TavernSync.PERSONA_LABELS[btn.dataset.key];
            const phone = btn.dataset.use === 'phone';
            if (!confirm(phone ? `用小手机的${label}覆盖酒馆里的？酒馆里的改动会丢失。` : `用酒馆的${label}覆盖小手机里的？小手机里的改动会丢失。`)) return;
            btn.disabled = true;
            try {
                const r = await TavernSync.resolvePersonaConflict(b, btn.dataset.key, btn.dataset.use);
                showToast(r.errors ? '没有成功，原因写在页面顶部' : (phone ? `已用小手机的${label}更新酒馆` : `已用酒馆的${label}更新小手机`));
            } catch (e) { showToast(e.message); }
            renderBindings();
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
            if (!Number.isInteger(n) || n < 0) n = TavernSync.keepRawFloorCount(b);   // 清空了就当没改
            if (n < least) { n = least; showToast(`不能少于「最近几楼发原文」的 ${least} 楼，已改成 ${least}`); }
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
            if (!Number.isInteger(n) || n < 0) n = Math.min(max, parseInt(b.tavernContextCount, 10) || 0);   // 清空了就当没改
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
            if (!confirm(`删除「${name}」的绑定？这个绑定的开关和设置会一起删掉；已经同步进小手机的酒馆剧情、酒馆里已经推送的消息都不受影响。`)) return;
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
                showToast(`已改绑到酒馆聊天文件「${newer.file}」，下次同步从它开始`);
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
                r.contentUpdated ? `更新了 ${r.contentUpdated} 楼在酒馆里改过的内容` : '',
                r.recleaned ? `按新的正则重新清洗了 ${r.recleaned} 楼` : '',
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
    const bulkGone = state.bulkGone || [];
    const total = list.length;
    // 小手机聊天被清空时 total 是 0，但被拦下来的删除还要在这里决定，所以那种情况照样打开窗口
    if (!total && !bulkGone.length) { showToast('还没有可推送的消息'); return; }

    const pushedCount = list.filter(m => pushed.has(m.id)).length;
    const firstUnpushed = lastPushedIdx + 2;        // 给用户看的编号从 1 开始
    const unpushedCount = total - (lastPushedIdx + 1);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:400px; max-height:85vh; display:flex; flex-direction:column;';

    const numStyle = 'width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const tabBtn = (id, label, active) => `<button data-mode="${id}" class="auto-push-tab" style="${TS.tab(active)}">${label}</button>`;
    const rangeRow = (idPrefix, from, to) => `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px; font-size:14px;">
            第 <input type="number" id="${idPrefix}-from" min="1" max="${total}" value="${from}" style="${numStyle}">
            到 <input type="number" id="${idPrefix}-to" min="1" max="${total}" value="${to}" style="${numStyle}"> 条
        </div>`;

    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">推送/清理小手机消息</h3>
        <div style="font-size:12px; color:#888; margin-bottom:10px; line-height:1.6;">
            小手机消息共 ${total} 条，酒馆里已有 ${pushedCount} 条。<br>${unpushedCount ? `未推送：第 ${firstUnpushed} ~ ${total} 条（${unpushedCount} 条）。` : '没有未推送的消息。'}
        </div>
        ${missing.length ? `
        <div id="auto-missing" style="font-size:12px; color:#888; line-height:1.6; margin-bottom:10px; padding:10px; border-radius:8px; border:1px solid rgba(255,152,0,0.45); background:rgba(255,152,0,0.08);">
            有 ${missing.length} 条以前推到过酒馆、现在酒馆里找不到了（第 ${missing.map(m => list.indexOf(m) + 1).slice(0, 5).join('、')}${missing.length > 5 ? ' 等' : ''} 条）。
            可能是酒馆页面没刷新、保存时把它们盖掉了，也可能是你在酒馆里删的。
            <div style="margin:6px 0;">${missing.slice(0, 3).map(m => {
                const t = String(m.content || '').replace(/\s+/g, ' ').trim();
                return esc(t.length > 30 ? t.slice(0, 30) + '...' : t);
            }).join('<br>')}${missing.length > 3 ? `<br>... 共 ${missing.length} 条` : ''}</div>
            <div style="display:flex; gap:8px; margin-top:6px;">
                <button id="auto-missing-push" style="flex:1; ${TS.btnO}">补推这些</button>
                <button id="auto-missing-ignore" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:13px; cursor:pointer;">忽略</button>
            </div>
            <div style="margin-top:6px;">补推会放在酒馆最后面。如果是你在酒馆里故意删的，点「忽略」，以后就不再提示。</div>
        </div>` : ''}
        ${bulkGone.length ? `
        <div id="auto-bulk" style="font-size:12px; color:#888; line-height:1.6; margin-bottom:10px; padding:10px; border-radius:8px; border:1px solid rgba(244,67,54,0.45); background:rgba(244,67,54,0.06);">
            小手机里一次少了 ${bulkGone.length} 条以前推到酒馆的消息。为了防止误删，没有自动从酒馆里删掉。
            <div style="display:flex; gap:8px; margin-top:8px;">
                <button id="auto-bulk-delete" style="flex:1; padding:8px; border-radius:8px; border:none; background:rgba(244,67,54,0.15); color:#f66; font-size:13px; font-weight:500; cursor:pointer;">从酒馆删掉</button>
                <button id="auto-bulk-keep" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:13px; cursor:pointer;">留在酒馆</button>
            </div>
            <div style="margin-top:6px;">选「留在酒馆」后，这些消息以后也不会被自动删掉。</div>
        </div>` : ''}
        <div id="auto-main" style="display:${total ? 'block' : 'none'};">
        <div style="display:flex; gap:6px; margin-bottom:12px;">
            ${tabBtn('raw', '原始消息', true)}
            ${tabBtn('summary', '小总结', false)}
            ${tabBtn('clean', '清理酒馆', false)}
        </div>

        <div id="auto-mode-raw" style="display:flex; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px; line-height:1.6;">推送这些消息（默认是未推送的那一段）。</div>
            ${rangeRow('auto-raw', unpushedCount ? firstUnpushed : total, total)}
            <div id="auto-raw-preview" style="font-size:12px; color:inherit; background:rgba(128,128,128,0.08); border-radius:8px; padding:10px; margin-bottom:12px; max-height:180px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #2196F3;"></div>
        </div>

        <div id="auto-mode-summary" style="display:none; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px; line-height:1.6;">把这些消息浓缩成一段总结后推送（消耗 1 次总结 API）。</div>
            ${rangeRow('auto-sum', unpushedCount ? firstUnpushed : total, total)}
            <button id="auto-sum-gen" style="${TS.btnG} ${TS.big} width:100%; margin-bottom:10px;">生成小总结</button>
            <textarea id="auto-sum-text" placeholder="生成后可在此编辑..." style="width:100%; box-sizing:border-box; min-height:130px; max-height:220px; padding:10px; border-radius:8px; border:1px solid rgba(128,128,128,0.35); background:rgba(128,128,128,0.08); color:inherit; font-size:13px; line-height:1.6; resize:vertical; margin-bottom:12px;"></textarea>
        </div>

        <div id="auto-mode-clean" style="display:none; flex-direction:column;">
            <div style="font-size:12px; color:#888; margin-bottom:6px; line-height:1.6;">
                把这些小手机消息从酒馆里删掉（默认全部）。只删酒馆楼层里的小手机内容，不动小手机自己的聊天记录，也不动酒馆原有的剧情。小总结是一整段文字，范围里只要包含它覆盖的任何一条，整段小总结都会删掉。删掉的消息以后不会被自动推送回去。
            </div>
            ${rangeRow('auto-clean', 1, total)}
            <div id="auto-clean-preview" style="font-size:12px; color:inherit; background:rgba(128,128,128,0.08); border-radius:8px; padding:10px; margin-bottom:12px; max-height:180px; overflow-y:auto; white-space:pre-wrap; line-height:1.5; border-left:3px solid #f66;"></div>
        </div>
        </div>

        <div style="display:flex; gap:10px;">
            <button id="auto-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">${total ? '取消' : '关闭'}</button>
            <button id="auto-confirm" style="flex:1; ${TS.btnP} display:${total ? 'block' : 'none'};">确认推送</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    let mode = 'raw';
    let summaryState = null;

    // 读取某个页签里填的范围，返回这段消息（编号从 1 开始）。
    // keepInput = true 时只算、不把改正后的数字写回框里：打字时用，否则删空一个框会马上跳回原来的数
    function readRange(idPrefix, keepInput) {
        const fromEl = modal.querySelector(`#${idPrefix}-from`);
        const toEl = modal.querySelector(`#${idPrefix}-to`);
        let from = parseInt(fromEl.value, 10);
        let to = parseInt(toEl.value, 10);
        if (!Number.isInteger(from) || from < 1) from = 1;
        if (!Number.isInteger(to) || to > total) to = total;
        if (from > to) from = to;
        if (!keepInput) { fromEl.value = fromEl.dataset.good = from; toEl.value = toEl.dataset.good = to; }
        return { from, to, msgs: list.slice(from - 1, to) };
    }

    function renderPreview(idPrefix, boxId, markPushed) {
        const { msgs } = readRange(idPrefix, true);
        const box = modal.querySelector(boxId);
        if (!msgs.length) { box.textContent = '这个范围里没有消息'; return; }
        const shown = msgs.slice(-12);
        const lines = shown.map(m => {
            const text = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
            const done = markPushed && pushed.has(m.id) ? '（酒馆里已有）' : '';
            return esc(text) + done;
        });
        box.innerHTML = (msgs.length > shown.length ? `<span style="color:#888;">... 共 ${msgs.length} 条，只显示最后 ${shown.length} 条</span>\n` : '')
            + lines.join('\n');
    }
    const refreshPreviews = () => {
        renderPreview('auto-raw', '#auto-raw-preview', true);
        renderPreview('auto-clean', '#auto-clean-preview', false);
    };
    // 打字时只刷新预览；离开框时：清空了就退回改之前的数，超出范围的拉回 1 ~ 总条数
    // （开始大于结束留到按确认时再改，免得先改一个框时把另一个框的数动了）
    modal.querySelectorAll('input[type=number]').forEach(inp => {
        inp.dataset.good = inp.value;
        inp.addEventListener('input', refreshPreviews);
        inp.addEventListener('change', () => {
            let n = parseInt(inp.value, 10);
            if (!Number.isInteger(n)) n = parseInt(inp.dataset.good, 10);
            n = Math.min(total, Math.max(1, n));
            inp.value = n; inp.dataset.good = n;
            refreshPreviews();
        });
    });
    refreshPreviews();

    const confirmBtn = modal.querySelector('#auto-confirm');
    modal.querySelectorAll('.auto-push-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            mode = btn.dataset.mode;
            modal.querySelectorAll('.auto-push-tab').forEach(b => {
                const active = b.dataset.mode === mode;
                b.style.background = active ? 'rgba(33,150,243,0.18)' : 'transparent';
                b.style.color = active ? '#2196F3' : '#999';
                b.style.borderColor = active ? 'rgba(33,150,243,0.5)' : 'rgba(128,128,128,0.35)';
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

    // 一次少了很多条：从酒馆删掉 / 留在酒馆
    const bulkDelete = modal.querySelector('#auto-bulk-delete');
    if (bulkDelete) bulkDelete.addEventListener('click', async () => {
        if (!confirm(`从酒馆里删掉这 ${bulkGone.length} 条小手机消息？小手机里它们已经没有了，删掉后酒馆里也找不回来。`)) return;
        bulkDelete.disabled = true; bulkDelete.textContent = '删除中...';
        try {
            await TavernSync.pushToTavern(binding, 0, true, { allowBulkDelete: true });
            showToast(`已从酒馆删掉 ${bulkGone.length} 条`);
            close();
        } catch (e) {
            showToast(`${e.message}`);
            bulkDelete.disabled = false; bulkDelete.textContent = '从酒馆删掉';
        }
    });
    const bulkKeep = modal.querySelector('#auto-bulk-keep');
    if (bulkKeep) bulkKeep.addEventListener('click', async () => {
        await TavernSync.keepGoneInTavern(binding, bulkGone);
        const box = modal.querySelector('#auto-bulk');
        if (box) box.remove();
        showToast('已留在酒馆，以后不会自动删掉这些');
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
    if (!floors.length) { showToast('小手机里还没有这个酒馆聊天文件的剧情'); return; }

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
    const numStyle = 'width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const cancelStyle = 'width:100%; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">精简旧楼层</h3>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:8px;">
            精简就是只留柏宝书摘要、把原文丢掉。原文在酒馆里一直都在，点下面的「取回原文」随时拿回来。
        </div>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:12px;">
            小手机里有 ${floors.length} 楼酒馆剧情（第 ${firstFloor} ~ ${lastFloor} 楼）。
            其中 ${trimmed.length} 个回合已精简、${can.length} 个回合可以精简（能省${sizeOf(saveable)}）${noSummary.length ? `、${noSummary.length} 个回合还没有摘要（不会精简）` : ''}。
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
        <button id="tm-restore" style="width:100%; ${TS.btnG} ${TS.big} margin-bottom:8px;">取回原文</button>
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
    const numStyle = 'width:70px; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px; text-align:center;';
    const cancelStyle = 'flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">管理同步范围</h3>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:12px;">
            ${synced ? `小手机里现在有 ${have} 楼酒馆剧情，会全部删掉。<br>` : '这个角色还没同步过，选一段要同步的剧情。<br>'}
            这个酒馆聊天文件一共 ${info.total} 楼（第 0 ~ ${lastFloor} 楼，和酒馆里楼层的 # 号一致）。
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
        <button id="rr-none" style="width:100%; ${TS.btnR} margin-bottom:8px;">${synced ? '只清空（以后只同步新楼层）' : '不要旧剧情（只同步以后的新楼层）'}</button>
        ${others ? `<div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:8px;">另外还有 ${others} 楼是以前绑定的酒馆聊天文件留下的，上面的操作不会动它们。</div>
        <button id="rr-others" style="width:100%; ${TS.btnR} margin-bottom:8px;">删掉以前的酒馆聊天文件留下的 ${others} 楼</button>` : ''}
        <button id="rr-cancel" style="width:100%; ${cancelStyle}">取消</button>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const close = () => overlay.remove();
    modal.querySelector('#rr-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const othersBtn = modal.querySelector('#rr-others');
    if (othersBtn) othersBtn.addEventListener('click', async () => {
        if (!confirm(`删掉小手机里以前绑定的酒馆聊天文件留下的 ${others} 楼剧情？酒馆里的原文不受影响。`)) return;
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
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">${existing ? '编辑' : '添加'}清洗规则</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">规则名称</label><input id="rr-name" placeholder="去除思考过程" style="${TS.input}"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">正则表达式</label><input id="rr-regex" placeholder="<thinking>[\\s\\S]*?</thinking>" style="${TS.input} font-family:monospace;"></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">分组</label><select id="rr-group" aria-label="规则分组" title="规则分组" style="${TS.input}"></select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">用在</label><select id="rr-scope" aria-label="规则用在" title="规则用在" style="${TS.input}">
            <option value="pull" ${existing?.scope === 'pull' ? 'selected' : ''}>同步（酒馆剧情进小手机时）</option>
            <option value="push" ${existing?.scope === 'push' ? 'selected' : ''}>推送（小手机消息进酒馆时）</option>
            <option value="both" ${(!existing || !existing.scope || existing.scope === 'both') ? 'selected' : ''}>两头都用</option></select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">模式</label><select id="rr-mode" aria-label="规则模式" title="规则模式" style="${TS.input}">
            <option value="exclude" ${(!existing || existing.mode === 'exclude') ? 'selected' : ''}>排除</option>
            <option value="extract" ${existing?.mode === 'extract' ? 'selected' : ''}>提取</option></select>
            <div style="font-size:12px; color:#888; margin-top:4px; line-height:1.6;">排除：删掉匹配到的内容，其余保留。例如 <code>&lt;status&gt;[\\s\\S]*?&lt;/status&gt;</code> 删掉状态栏那一段。<br>提取：只保留匹配到的内容，其余全部去掉。例如 <code>&lt;content&gt;([\\s\\S]*?)&lt;/content&gt;</code> 只留 &lt;content&gt; 标签里面那段；写了小括号时只留第一对小括号圈住的部分，一处都没匹配到就原样不动。<br>可以在下面的「测试」里粘一段文字，看处理完是什么样。</div></div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">测试</label>
            <textarea id="rr-test" placeholder="粘贴消息文本测试..." style="${TS.input} height:60px; resize:vertical;"></textarea>
            <div id="rr-result" style="margin-top:6px; font-size:12px; color:#888; background:rgba(128,128,128,0.08); border-radius:8px; padding:8px; white-space:pre-wrap; max-height:80px; overflow:auto;"></div></div>
        <div style="display:flex; gap:10px;">
            <button id="rr-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
            <button id="rr-save" style="flex:1; ${TS.btnP}">保存</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);

    // 用 JS 赋值避免 HTML 属性转义导致正则乱码
    if (existing) {
        modal.querySelector('#rr-name').value = existing.name || '';
        modal.querySelector('#rr-regex').value = existing.regex || '';
    }

    // 分组下拉：不分组 + 现有的分组 + 新建。新规则默认放进上次选的分组。
    const groupSelect = modal.querySelector('#rr-group');
    let pendingGroup = '';
    function renderGroups(selected) {
        const groups = TavernSync.ruleGroupsOf(TavernSync.getConfig());
        if (pendingGroup && !groups.includes(pendingGroup)) groups.push(pendingGroup);
        groupSelect.innerHTML = '<option value="">不分组</option>'
            + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')
            + '<option value="__new__">＋ 新建分组…</option>';
        groupSelect.value = groups.includes(selected) ? selected : '';
    }
    const lastGroup = TavernSync.getConfig().lastRuleGroup || '';
    renderGroups(existing ? (existing.group || '') : lastGroup);
    let groupValue = groupSelect.value;
    groupSelect.addEventListener('change', async () => {
        if (groupSelect.value !== '__new__') { groupValue = groupSelect.value; return; }
        // 先把下拉收起来、选项复原，再弹输入框；否则手机上列表会一直开着
        try { groupSelect.blur(); } catch (e) { /* 收不起来也不影响 */ }
        groupSelect.value = groupValue;
        const name = ((await askText('新分组的名字', '例如：删状态栏')) || '').trim();
        if (name) { pendingGroup = name; groupValue = name; }
        renderGroups(groupValue);
    });

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
        if (groupValue) rule.group = groupValue;
        const cfg = TavernSync.getConfig(); if (!cfg.cleanRules) cfg.cleanRules = [];
        // 换了分组的规则挪到末尾，这样它排在新分组的最后
        if (ruleIndex !== null && (existing.group || '') === groupValue) cfg.cleanRules[ruleIndex] = rule;
        else { if (ruleIndex !== null) cfg.cleanRules.splice(ruleIndex, 1); cfg.cleanRules.push(rule); }
        if (!existing) cfg.lastRuleGroup = groupValue;
        const left = TavernSync.ruleGroupsOf(cfg);
        cfg.ruleGroupsOff = (cfg.ruleGroupsOff || []).filter(x => left.includes(x));
        await TavernSync.saveConfig(cfg); overlay.remove(); showToast('规则已保存'); if (onSave) onSave();
    });
}

// ========== 正则规则导出 / 导入弹窗 ==========
// 选一个规则分组（多选后「移动分组」用）：返回组名，'' = 不分组，点「取消」或外面返回 null
function askRuleGroup(title) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
        overlay.classList.add('ts-overlay');
        const modal = document.createElement('div');
        modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:320px;';
        modal.innerHTML = `
            <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">${esc(title)}</h3>
            <select id="rg-group" aria-label="移到哪个分组" title="移到哪个分组" style="${TS.input} margin-bottom:14px;"></select>
            <div style="display:flex; gap:10px;">
                <button id="rg-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
                <button id="rg-ok" style="flex:1; ${TS.btnP}">移动</button></div>`;
        overlay.appendChild(modal); document.body.appendChild(overlay);
        const select = modal.querySelector('#rg-group');
        let pending = '';
        let value = '';
        function render() {
            const groups = TavernSync.ruleGroupsOf(TavernSync.getConfig());
            if (pending && !groups.includes(pending)) groups.push(pending);
            select.innerHTML = '<option value="">不分组</option>'
                + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')
                + '<option value="__new__">＋ 新建分组…</option>';
            select.value = value;
        }
        render();
        select.addEventListener('change', async () => {
            if (select.value !== '__new__') { value = select.value; return; }
            // 先把下拉收起来、选项复原，再弹输入框；否则手机上列表会一直开着
            try { select.blur(); } catch (e) { /* 收不起来也不影响 */ }
            select.value = value;
            const name = ((await askText('新分组的名字', '例如：删状态栏')) || '').trim();
            if (name) { pending = name; value = name; }
            render();
        });
        const done = (v) => { overlay.remove(); resolve(v); };
        modal.querySelector('#rg-cancel').addEventListener('click', () => done(null));
        modal.querySelector('#rg-ok').addEventListener('click', () => done(value));
        overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
    });
}

function showImportRulesModal(text, onDone) {
    let parsed;
    try { parsed = TavernSync.parseCleanRulesFile(text); } catch (e) { showToast(`导入失败：${e.message}`); return; }
    const list = parsed.rules;
    if (!list.length) { showToast('文件里没有正则'); return; }
    const dup = TavernSync.markDuplicateRules(list);
    const dupCount = dup.filter(Boolean).length;
    const invalidCount = list.filter((r, i) => r.invalid && !dup[i]).length;
    const selectable = (i) => !dup[i] && !list[i].invalid;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:380px; max-height:85vh; display:flex; flex-direction:column;';
    const scopeText = (s) => s === 'pull' ? '同步' : s === 'push' ? '推送' : '同步和推送';
    const notes = [];
    if (dupCount) notes.push(`其中 ${dupCount} 条和现有的正则重复，会跳过`);
    if (invalidCount) notes.push(`${invalidCount} 条正则写法有错，不能导入`);
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">导入正则</h3>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:10px;">文件里有 ${list.length} 条正则${notes.length ? '，' + notes.join('，') : ''}。</div>
        <div style="margin-bottom:10px;"><label style="${TS.label}">放进哪个分组</label><select id="ri-group" aria-label="导入的正则放进哪个分组" title="导入的正则放进哪个分组" style="${TS.input}"></select></div>
        <div style="display:flex; justify-content:flex-end; margin-bottom:6px;"><button id="ri-all" style="${TS.btnS}">取消全选</button></div>
        <div id="ri-list" style="flex:1; min-height:0; overflow:auto; margin-bottom:14px;">
            ${list.map((r, i) => `
            <label style="display:flex; align-items:center; gap:8px; padding:8px; background:rgba(128,128,128,0.08); border-radius:8px; margin-bottom:6px; ${selectable(i) ? 'cursor:pointer;' : 'opacity:0.5;'}">
                <input type="checkbox" data-i="${i}" ${selectable(i) ? 'checked' : 'disabled'} style="flex-shrink:0;">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:13px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.name)}${dup[i] ? '（已有）' : r.invalid ? '（写法有错）' : ''}</div>
                    <div style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${r.group ? `${esc(r.group)} · ` : ''}${r.mode === 'extract' ? '提取' : '排除'} · ${scopeText(r.scope)} · /${esc(r.regex)}/</div>
                </div>
            </label>`).join('')}
        </div>
        <div style="display:flex; gap:10px;">
            <button id="ri-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
            <button id="ri-ok" style="flex:1; ${TS.btnP}">导入</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);

    // 分组下拉：照文件里的分组（文件里有分组时才有这一项）/ 不分组 / 现有分组 / 新建
    const fileHasGroups = list.some(r => r.group);
    const groupSelect = modal.querySelector('#ri-group');
    let pendingGroup = '';
    let groupValue = fileHasGroups ? '__file__' : '';
    function renderGroups() {
        const groups = TavernSync.ruleGroupsOf(TavernSync.getConfig());
        if (pendingGroup && !groups.includes(pendingGroup)) groups.push(pendingGroup);
        groupSelect.innerHTML = (fileHasGroups ? '<option value="__file__">照文件里的分组</option>' : '')
            + '<option value="">不分组</option>'
            + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')
            + '<option value="__new__">＋ 新建分组…</option>';
        groupSelect.value = groupValue;
    }
    renderGroups();
    groupSelect.addEventListener('change', async () => {
        if (groupSelect.value !== '__new__') { groupValue = groupSelect.value; return; }
        try { groupSelect.blur(); } catch (e) { /* 收不起来也不影响 */ }
        groupSelect.value = groupValue;
        const name = ((await askText('新分组的名字', '例如：删状态栏')) || '').trim();
        if (name) { pendingGroup = name; groupValue = name; }
        renderGroups();
    });

    const boxes = () => [...modal.querySelectorAll('#ri-list input[type=checkbox]:not(:disabled)')];
    const allBtn = modal.querySelector('#ri-all');
    const paintAll = () => { allBtn.textContent = boxes().length && boxes().every(b => b.checked) ? '取消全选' : '全选'; };
    paintAll();
    allBtn.addEventListener('click', () => { const on = !boxes().every(b => b.checked); boxes().forEach(b => { b.checked = on; }); paintAll(); });
    modal.querySelector('#ri-list').addEventListener('change', paintAll);

    modal.querySelector('#ri-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    modal.querySelector('#ri-ok').addEventListener('click', async () => {
        const picked = boxes().filter(b => b.checked).map(b => list[parseInt(b.dataset.i)]);
        if (!picked.length && !dupCount) { showToast('没有选中要导入的正则'); return; }
        const r = await TavernSync.importCleanRules(picked, groupValue, parsed.groupsOff);
        overlay.remove();
        const skipped = dupCount + r.skipped;
        showToast(`导入了 ${r.added} 条正则${skipped ? `，跳过了 ${skipped} 条重复的正则` : ''}`);
        if (onDone) onDone();
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
    // 你自己传过的头像（小手机里存成图片数据）才标「将覆盖」；默认头像是外链，换掉没关系
    const isUserAvatar = (src) => /^data:/i.test(String(src || ''));

    let userPersonaHTML = '';
    if (result.userPersonas.length) {
        const opts = result.userPersonas.map(p => `<option value="${esc(p.avatar)}">${esc(p.name)}</option>`).join('');
        userPersonaHTML = `
            <div style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <label style="${TS.label} margin-bottom:0;">用户人设（“我”的人设）</label>
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
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">导入酒馆人设：${esc(result.charName)}</h3>
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
            </div>` : '<div style="color:#888; font-size:12px; margin-bottom:12px;">酒馆角色没有人设描述。</div>'}
        ${userPersonaHTML}
        <div style="margin-bottom:12px;">
            <label style="${TS.label}">头像</label>
            <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:6px;">从酒馆头像的正中间截一个正方形，就是酒馆圆形/方形头像里看到的那块。</div>
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin-bottom:6px; cursor:pointer;">
                <input type="checkbox" id="ic-avatar-check" checked>
                <img id="ic-avatar-prev" src="${esc(TavernSync.tavernCharAvatarUrl(result.charAvatar))}" style="width:40px; height:40px; border-radius:50%; object-fit:cover; flex-shrink:0; background:rgba(128,128,128,0.15);">
                <span style="flex:1;">导入角色头像</span>
                ${isUserAvatar(char.avatar) ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
            </label>
            <label id="ic-myavatar-row" style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
                <input type="checkbox" id="ic-myavatar-check" checked>
                <img id="ic-myavatar-prev" style="width:40px; height:40px; border-radius:50%; object-fit:cover; flex-shrink:0; background:rgba(128,128,128,0.15);">
                <span id="ic-myavatar-text" style="flex:1;">导入用户头像</span>
                ${isUserAvatar(char.myAvatar) ? '<span style="font-size:11px; color:#FF9800;">将覆盖</span>' : ''}
            </label>
        </div>
        ${result.postHistory ? `
            <div style="margin-bottom:12px;">
                <label style="${TS.label}">Post History Instructions</label>
                <textarea id="ic-posthistory" style="${TS.input} height:60px; resize:vertical; font-size:12px;" readonly>${esc(result.postHistory)}</textarea>
                <div style="font-size:12px; color:#888; margin-top:4px; line-height:1.6;">仅供参考，不会自动导入。</div>
            </div>` : ''}
        <div style="display:flex; gap:10px;">
            <button id="ic-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
            <button id="ic-save" style="flex:1; ${TS.btnP}">确认导入</button>
        </div>`;

    overlay.appendChild(modal); document.body.appendChild(overlay);

    const personaSelect = modal.querySelector('#ic-persona-select');
    const myPersonaArea = modal.querySelector('#ic-mypersona');
    // 用户头像：跟着上面选的用户人设走（「酒馆中当前选中的人设」= 酒馆现在选中的那个的头像）
    const myAvatarFile = () => {
        const val = personaSelect ? personaSelect.value : '';
        if (val === '__active__') return result.activeAvatar || '';
        return val || '';
    };
    function paintMyAvatar() {
        const file = myAvatarFile();
        const prev = modal.querySelector('#ic-myavatar-prev');
        const cb = modal.querySelector('#ic-myavatar-check');
        const text = modal.querySelector('#ic-myavatar-text');
        if (file) { prev.src = TavernSync.tavernUserAvatarUrl(file); prev.style.visibility = 'visible'; cb.disabled = false; text.textContent = '导入用户头像'; }
        else { prev.removeAttribute('src'); prev.style.visibility = 'hidden'; cb.disabled = true; text.textContent = '导入用户头像（先在上面选用户人设）'; }
    }
    paintMyAvatar();
    if (personaSelect) {
        personaSelect.addEventListener('change', () => {
            paintMyAvatar();
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
        // 头像：截好正方形再换上；读不到的不换，告诉你是哪张
        const avatarFails = [];
        let didAvatar = false, didCharAv = false, didUserAv = false;
        if (modal.querySelector('#ic-avatar-check').checked && result.charAvatar) {
            try { char.avatar = await TavernSync.avatarToSquare(TavernSync.tavernCharAvatarUrl(result.charAvatar)); didAvatar = didCharAv = true; }
            catch (e) { avatarFails.push('角色头像'); }
        }
        const myFile = myAvatarFile();
        if (modal.querySelector('#ic-myavatar-check').checked && myFile) {
            try { char.myAvatar = await TavernSync.avatarToSquare(TavernSync.tavernUserAvatarUrl(myFile)); didAvatar = didUserAv = true; }
            catch (e) { avatarFails.push('用户头像'); }
        }
        // 记下这次导入的是酒馆哪个版本、写进小手机的是什么，「双向自动更新人设」拿它判断以后谁改过
        const src = personaSelect ? personaSelect.value : '';
        if (didChar || didUser || didAvatar) {
            const cfg = TavernSync.getConfig();
            const b = cfg.bindings.find(x => x === binding) || cfg.bindings.find(x => x.uwuCharId === binding.uwuCharId);
            if (b) {
                TavernSync.recordPersonaImport(b, char, result, { char: didChar, user: didUser && !!src, userSource: src });
                // 头像也记下两边这一版，「双向自动更新人设」拿它判断以后谁改过
                try { await TavernSync.recordAvatarImport(b, char, result, { char: didCharAv, userFile: didUserAv ? myFile : '' }); } catch (e) { /* 记不下就当以前没记过 */ }
            }
            await TavernSync.saveConfig(cfg);   // 会顺带存角色数据
        } else {
            await saveData();
        }
        overlay.remove();
        showToast(avatarFails.length ? `人设已导入，${avatarFails.join('和')}读不到，没有换` : (didChar || didUser || didAvatar ? '人设已导入' : '没有要导入的内容'));
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
        ? sources.map((src, i) => `<button class="wb-tab" data-tab="${i}" style="${TS.btnS} ${i === 0 ? 'background:rgba(33,150,243,0.18); color:#2196F3; border-color:rgba(33,150,243,0.5);' : 'color:#999;'}">${esc(src.type)}（${src.entries.length}）</button>`).join('')
        : '';
    const smallBtn = TS.btnS;

    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">导入酒馆世界书</h3>
        <div style="font-size:12px; color:#888; margin-bottom:8px; line-height:1.6;">复制过来就是小手机自己的世界书条目，可以随便改。酒馆里改了内容的，这里会标出来，可以选择更新。以后想让两边的改动自动跟过去，打开绑定卡片上的「双向自动更新复制过的世界书」；也可以回到这里点「更新小手机里的内容」。</div>
        ${tabsHTML ? `<div style="display:flex; justify-content:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;">${tabsHTML}</div>` : ''}
        <div style="display:flex; justify-content:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
            <button id="wb-select-all" style="${smallBtn}">全选</button>
            <button id="wb-select-enabled" style="${smallBtn}">只选酒馆里开着的</button>
            <button id="wb-select-changed" style="${smallBtn}">只选有改动的</button>
        </div>
        <div id="wb-entries" style="flex:1; overflow-y:auto; margin-bottom:10px;"></div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:13px;">
            <span style="white-space:nowrap;">加到分组</span>
            <select id="wb-category" aria-label="加到分组" title="加到分组" style="flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px;"></select>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="wb-import" style="flex:1; ${TS.btnB} ${TS.big}">复制到小手机世界书</button>
            <button id="wb-update" style="flex:1; ${TS.btnG} ${TS.big}">更新小手机里的内容</button>
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
            btn.style.color = on ? '#2196F3' : '#999';
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
        const cs = TavernSync._wbChangeState(copied, TavernSync.copiedLink(copied, src.name, e.uid), e);
        const changed = cs.tavernChanged;
        const edited = cs.localChanged === true;
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
            t.style.color = on ? '#2196F3' : '#999';
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
        const depthNote = atDepth ? `。其中 ${atDepth} 条在酒馆里是 @深度 插入，已放到「注入位置：后」` : '';
        showToast(added ? `已复制 ${added} 条到分组「${category}」${skipped ? `，${skipped} 条之前复制过（可用「更新小手机里的内容」）` : ''}${depthNote}` : '勾选的条目之前都复制过了，可以用「更新小手机里的内容」');
    });

    // ===== 更新 =====
    modal.querySelector('#wb-update').addEventListener('click', async () => {
        const src = sources[currentSourceIdx];
        const selected = getSelected();
        if (!selected.length) { showToast('请先勾选条目'); return; }
        // 你在小手机里改过的条目，更新会用酒馆的版本覆盖，先问一声
        const editedNames = selected.map(e => [e, TavernSync.findCopiedWorldBook(binding, src.name, e.uid)])
            .filter(([e, c]) => c && statusOf(src, e).edited)
            .map(([, c]) => c.name || '未命名');
        if (editedNames.length && !confirm(`勾选的条目里有 ${editedNames.length} 条你在小手机里改过（${editedNames.slice(0, 3).map(n => `「${n}」`).join('、')}${editedNames.length > 3 ? ' 等' : ''}），更新后会换成酒馆的版本，小手机里的改动会丢失。确定更新吗？`)) return;
        let updated = 0, missing = 0;
        for (const e of selected) {
            const copied = TavernSync.findCopiedWorldBook(binding, src.name, e.uid);
            if (!copied) { missing++; continue; }
            const st = statusOf(src, e);
            if (!st.changed && !st.edited) continue;           // 两边一样，不用更新
            TavernSync.pullEntryInto(copied, e, src.entries.indexOf(e), src.name, TavernSync.copiedLink(copied, src.name, e.uid).via);
            updated++;
        }
        await saveData();
        renderEntries(currentSourceIdx);
        showToast(updated ? `已更新 ${updated} 条${missing ? `，${missing} 条还没复制过` : ''}` : (missing ? '勾选的条目还没复制过' : '勾选的条目内容没有变化'));
    });

    modal.querySelector('#wb-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// 小手机世界书条目列表里的一行字：位置 · 常驻或关键词 · 正文开头
function phoneWbLine(w) {
    const pos = { before: '前', middle: '中', after: '后' }[w.position] || '后';
    const trig = w.alwaysOn !== false ? '常驻' : ('关键词：' + ((w.keywords || []).join('、') || '（没有）'));
    const preview = String(w.content || '').replace(/\s+/g, ' ').trim();
    return `位置：${pos} · ${esc(trig)} · ${preview ? esc(preview.slice(0, 60)) : '（空条目）'}`;
}

// ========== 推送小手机人设（在酒馆里新建角色）==========
// 每次都是新建：角色卡、用户人设、世界书都新建，不改动酒馆里已有的东西。
async function showPushPersonaModal(onDone) {
    const chars = (db.characters || []).filter(c => c && c.id);
    if (!chars.length) { showToast('小手机里还没有角色'); return; }
    const cfg = TavernSync.getConfig();
    const presets = Array.isArray(db.myPersonaPresets) ? db.myPersonaPresets.filter(p => p && p.id) : [];
    const firstBound = cfg.bindings.map(b => chars.find(c => c.id === b.uwuCharId)).find(Boolean);

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:85vh; overflow-y:auto;';
    const sep = 'margin-top:14px; padding-top:12px; border-top:1px solid #f0f0f0;';
    const check = (id, text, on) => `<label style="display:flex; align-items:center; gap:6px; font-size:13px; cursor:pointer;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${text}</label>`;
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">推送小手机人设</h3>
        <div style="font-size:12px; color:#888; margin-bottom:12px; line-height:1.6;">在酒馆里新建一个角色，不会改动酒馆里已有的角色、人设和世界书。</div>
        <label style="${TS.label}">小手机角色</label>
        <select id="pp-char" aria-label="小手机角色" title="小手机角色" style="${TS.input}">
            ${chars.map(c => `<option value="${esc(c.id)}" ${firstBound && c.id === firstBound.id ? 'selected' : ''}>${esc(c.remarkName || c.name || TavernSync.phoneCharName(c))}</option>`).join('')}
        </select>
        <div style="${sep}">
            <div style="font-size:13px; font-weight:600; margin-bottom:8px;">酒馆角色卡</div>
            <label style="${TS.label}">角色名</label>
            <input id="pp-name" type="text" style="${TS.input} margin-bottom:8px;">
            <label style="${TS.label}">角色描述</label>
            <textarea id="pp-desc" style="${TS.input} height:120px; resize:vertical; font-size:12px; margin-bottom:8px;"></textarea>
            <label style="${TS.label}">开场白</label>
            <textarea id="pp-first" style="${TS.input} height:70px; resize:vertical; font-size:12px;" placeholder="可以不填"></textarea>
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin-top:8px; cursor:pointer;">
                <input type="checkbox" id="pp-av-on" checked>
                <img id="pp-av-prev" style="width:40px; height:60px; border-radius:6px; object-fit:cover; flex-shrink:0; background:rgba(128,128,128,0.15); visibility:hidden;">
                <div style="flex:1; min-width:0;">
                    <div>推送角色头像</div>
                    <div id="pp-av-note" style="font-size:11px; color:#888; line-height:1.5;"></div>
                </div>
            </label>
            <div style="font-size:12px; color:#888; line-height:1.6; margin-top:6px;">酒馆头像是竖长方形。小手机头像会完整放在正中间，上下用这张图模糊铺满，酒馆圆形/方形头像里露出的正好是原图。</div>
        </div>
        <div style="${sep}">
            ${check('pp-user-on', '同时在酒馆新建用户人设', true)}
            <div id="pp-user-body" style="margin-top:8px;">
                <select id="pp-user-src" aria-label="用户人设来源" title="用户人设来源" style="${TS.input} margin-bottom:8px;">
                    <option value="__char__">这个角色卡里填的人设</option>
                    ${presets.map(p => `<option value="${esc(p.id)}">人设预设：${esc(p.name || '未命名')}</option>`).join('')}
                </select>
                <label style="${TS.label}">名字</label>
                <input id="pp-user-name" type="text" style="${TS.input} margin-bottom:8px;">
                <label style="${TS.label}">内容</label>
                <textarea id="pp-user-desc" style="${TS.input} height:80px; resize:vertical; font-size:12px;"></textarea>
            <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin-top:8px; cursor:pointer;">
                <input type="checkbox" id="pp-uav-on" checked>
                <img id="pp-uav-prev" style="width:40px; height:60px; border-radius:6px; object-fit:cover; flex-shrink:0; background:rgba(128,128,128,0.15); visibility:hidden;">
                <div style="flex:1; min-width:0;">
                    <div>推送用户头像</div>
                    <div id="pp-uav-note" style="font-size:11px; color:#888; line-height:1.5;"></div>
                </div>
            </label>
            </div>
        </div>
        <div style="${sep}">
            ${check('pp-wb-on', '同时推送世界书', true)}
            <div id="pp-wb-body" style="margin-top:8px;">
                <div id="pp-wb-note" style="font-size:12px; color:#888; line-height:1.6; margin-bottom:6px;"></div>
                ${check('pp-wb-global', '带上全局条目', false)}
                <div id="pp-wb-list" style="max-height:30vh; overflow-y:auto; margin-top:8px;"></div>
                <label style="${TS.label} margin-top:8px;">酒馆世界书名字</label>
                <input id="pp-wb-name" type="text" style="${TS.input}">
                <div style="font-size:12px; color:#888; line-height:1.6; margin-top:4px;">新建这本世界书，并设成新角色的角色世界书。注入位置「前」放到角色定义前，「中」「后」放到角色定义后；关键词、常驻、开关、权重都一起带过去。</div>
            </div>
        </div>
        <div id="pp-bind-box" style="${sep}"></div>
        <div id="pp-page-note" style="display:none; font-size:12px; color:#888; line-height:1.6; margin-top:12px;"></div>
        <div style="display:flex; gap:10px; margin-top:16px;">
            <button id="pp-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
            <button id="pp-save" style="flex:1; ${TS.btnO} ${TS.big}">在酒馆新建</button>
        </div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const $ = (sel) => modal.querySelector(sel);
    const close = () => overlay.remove();
    $('#pp-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    let wbData = { books: [], globals: [] };
    // 头像：选了角色 / 换了用户人设来源就重新做一张 2:3 的，窗口里显示做好的样子
    const avatars = { 'pp-av': null, 'pp-uav': null };     // { blob, url } 或 null（读不到 / 没有）
    const avatarTokens = { 'pp-av': 0, 'pp-uav': 0 };
    async function prepareAvatar(id, src) {
        const token = ++avatarTokens[id];
        avatars[id] = null;
        const prev = $('#' + id + '-prev'), note = $('#' + id + '-note');
        prev.style.visibility = 'hidden';
        if (!src) { note.textContent = '没有头像，会用酒馆默认头像。'; return; }
        note.textContent = '处理中...';
        try {
            const a = await TavernSync.avatarToTall(src);
            if (token !== avatarTokens[id]) return;
            avatars[id] = a;
            prev.src = a.url; prev.style.visibility = 'visible';
            note.textContent = '';
        } catch (e) {
            if (token !== avatarTokens[id]) return;
            note.textContent = '这张头像读不到（外链图片的网站不让读），会用酒馆默认头像。';
        }
    }
    const curChar = () => chars.find(c => c.id === $('#pp-char').value);
    function renderWbList() {
        const withGlobal = $('#pp-wb-global').checked;
        const list = [...wbData.books.map(w => ({ w, g: false })), ...(withGlobal ? wbData.globals.map(w => ({ w, g: true })) : [])];
        $('#pp-wb-list').innerHTML = list.length ? list.map(({ w, g }) => `
            <label style="display:flex; align-items:center; gap:10px; padding:8px 10px; background:rgba(128,128,128,0.08); border-radius:8px; margin-bottom:6px; cursor:pointer; ${w.disabled ? 'opacity:0.55;' : ''}">
                <input type="checkbox" data-wb="${esc(w.id)}" checked style="flex-shrink:0; margin:0;">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:13px; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(w.name || '未命名')}${g ? '（全局）' : ''}${w.disabled ? '（已关闭）' : ''}</div>
                    <div style="font-size:11px; color:#888; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${phoneWbLine(w)}</div>
                </div>
            </label>`).join('') : '<div style="font-size:12px; color:#888; line-height:1.6;">没有可以推送的条目。</div>';
    }
    // 换了小手机角色：下面的内容全部按这个角色重新填
    function fillFromChar() {
        const ch = curChar();
        if (!ch) return;
        const nm = TavernSync.phoneCharName(ch);
        $('#pp-name').value = nm;
        $('#pp-desc').value = ch.persona || '';
        $('#pp-user-src').value = '__char__';
        fillUser();
        prepareAvatar('pp-av', ch.avatar);
        wbData = TavernSync.phoneOfflineWorldBooks(ch);
        $('#pp-wb-note').textContent = wbData.offline
            ? '下面是这个角色绑定的线下世界书条目。'
            : '这个角色没有设线下世界书，小手机线下时会用线上那套，这里也列线上的。';
        $('#pp-wb-name').value = nm;
        renderWbList();
        const bound = cfg.bindings.some(b => b.uwuCharId === ch.id);
        $('#pp-bind-box').innerHTML = bound
            ? '<div style="font-size:12px; color:#888; line-height:1.6;">这个小手机角色已经绑定过酒馆角色，不会再绑定到新角色。</div>'
            : `${check('pp-bind', '建好后绑定到这个小手机角色', true)}<div style="font-size:12px; color:#888; line-height:1.6; margin-top:4px;">会一起建好新角色的第一个酒馆聊天文件（开头是开场白），不用再手动添加绑定。</div>`;
    }
    function fillUser() {
        const ch = curChar();
        const src = $('#pp-user-src').value;
        if (src === '__char__') {
            $('#pp-user-name').value = (ch && ch.myName) || '';
            $('#pp-user-desc').value = (ch && ch.myPersona) || '';
            prepareAvatar('pp-uav', ch && ch.myAvatar);
        } else {
            const p = presets.find(x => x.id === src);
            $('#pp-user-name').value = (p && p.name) || '';
            $('#pp-user-desc').value = (p && p.persona) || '';
            prepareAvatar('pp-uav', p && p.avatar);
        }
    }
    $('#pp-char').addEventListener('change', fillFromChar);
    $('#pp-user-src').addEventListener('change', fillUser);
    $('#pp-wb-global').addEventListener('change', renderWbList);
    $('#pp-user-on').addEventListener('change', (e) => { $('#pp-user-body').style.display = e.target.checked ? 'block' : 'none'; renderPageNote(); });
    $('#pp-wb-on').addEventListener('change', (e) => { $('#pp-wb-body').style.display = e.target.checked ? 'block' : 'none'; });
    fillFromChar();

    // 用户人设存在酒馆设置里：没开酒馆页面时只能直接写设置文件，要提醒先刷新酒馆
    let pageOpen = null;
    function renderPageNote() {
        const el = $('#pp-page-note');
        if (pageOpen === null || pageOpen || !$('#pp-user-on').checked) { el.style.display = 'none'; return; }
        el.style.display = 'block';
        el.textContent = '没有检测到同一个浏览器里开着的酒馆页面，用户人设会直接写进酒馆的设置文件。如果你在别的设备或浏览器里开着酒馆，建好后请先刷新那边的酒馆页面，否则酒馆保存设置时会把新人设盖掉。';
    }
    TavernSync.pingTavernPage().then(found => { pageOpen = found; if (modal.isConnected) renderPageNote(); });

    $('#pp-save').addEventListener('click', async () => {
        const ch = curChar();
        const name = $('#pp-name').value.trim();
        if (!ch) { showToast('请选择小手机角色'); return; }
        if (!name) { showToast('角色名不能空着'); return; }
        let world = null;
        if ($('#pp-wb-on').checked) {
            const ids = new Set([...modal.querySelectorAll('#pp-wb-list input[data-wb]')].filter(cb => cb.checked).map(cb => cb.dataset.wb));
            const entries = [...wbData.books, ...wbData.globals].filter(w => ids.has(w.id));
            if (entries.length) {
                const wn = $('#pp-wb-name').value.trim();
                if (!wn) { showToast('世界书名字不能空着'); return; }
                world = { name: wn, entries };
            }
        }
        const userOn = $('#pp-user-on').checked;
        const pick = (id) => ($('#' + id + '-on').checked && avatars[id]) ? avatars[id].blob : null;
        const userPersona = userOn ? { name: $('#pp-user-name').value.trim(), description: $('#pp-user-desc').value, avatarBlob: pick('pp-uav') } : null;
        if (userPersona && !userPersona.name) { showToast('用户人设的名字不能空着'); return; }
        const bindEl = $('#pp-bind');
        const btn = $('#pp-save');
        btn.disabled = true; btn.textContent = '新建中...';
        try {
            const r = await TavernSync.createTavernCharacter({
                charId: ch.id, name, description: $('#pp-desc').value, firstMes: $('#pp-first').value, avatarBlob: pick('pp-av'),
                userPersona, world, bind: !!(bindEl && bindEl.checked),
            });
            const parts = [`已在酒馆新建角色「${name}」`];
            if (r.world) parts.push(`世界书「${r.world.name}」（${r.world.added} 条）`);
            if (r.persona) parts.push('用户人设');
            if (r.bound) parts.push('并绑定好了');
            showToast(parts.join('、'));
            if (r.persona && r.persona.via === 'file') {
                TavernSync.reportIssue(`用户人设「${userPersona.name}」是直接写进酒馆设置文件的（当时同一个浏览器里没有开着的酒馆页面）。如果别的设备或浏览器里开着酒馆，请先刷新那边的酒馆页面再操作，否则酒馆保存设置时会把它盖掉。`);
            }
            close();
            if (onDone) onDone();
        } catch (e) {
            btn.disabled = false; btn.textContent = '在酒馆新建';
            showToast(e.message);
            if (e.done && e.done.length) TavernSync.reportIssue(`推送小手机人设时${e.message}`);
        }
    });
}

// ========== 推送小手机世界书 ==========
// 先选小手机世界书的分组，再勾条目，推到酒馆里已有的世界书或新建一本。
// 推过的会记下来（tavernPushes），以后能标出「已推送」「小手机里改过」，并用「更新酒馆里的内容」再推一次。
async function showPushWorldBookModal(defaultName) {
    const all = (db.worldBooks || []).filter(w => w && w.id);
    if (!all.length) { showToast('小手机里还没有世界书'); return; }
    const catOf = (w) => (w.category || '').trim() || '未分类';
    const cats = [...new Set(all.map(catOf))].sort();

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:420px; max-height:85vh; display:flex; flex-direction:column;';
    const selStyle = 'flex:1; min-width:0; padding:6px 8px; border-radius:8px; border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; font-size:14px;';
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">推送小手机世界书</h3>
        <div style="font-size:12px; color:#888; margin-bottom:10px; line-height:1.6;">把小手机的世界书条目加进酒馆的世界书。只会新加条目、或者更新以前推过去的条目，不会改动那本世界书里原来的其他条目。</div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:13px;">
            <span style="white-space:nowrap;">小手机分组</span>
            <select id="pw-cat" aria-label="小手机分组" title="小手机分组" style="${selStyle}">
                ${cats.map(c => `<option value="${esc(c)}">${esc(c)}（${all.filter(w => catOf(w) === c).length}）</option>`).join('')}
            </select>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:13px;">
            <span style="white-space:nowrap;">推到酒馆的</span>
            <select id="pw-target" aria-label="推到酒馆的世界书" title="推到酒馆的世界书" style="${selStyle}"><option value="__new__">新建世界书</option></select>
        </div>
        <div id="pw-new-row" style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:13px;">
            <span style="white-space:nowrap;">新世界书名字</span>
            <input id="pw-new-name" type="text" style="${selStyle}" value="${esc(defaultName || '')}">
        </div>
        <div style="display:flex; justify-content:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
            <button id="pw-all" style="${TS.btnS}">全选</button>
            <button id="pw-changed" style="${TS.btnS}">只选有改动的</button>
        </div>
        <div id="pw-list" style="flex:1; overflow-y:auto; margin-bottom:10px; min-height:60px;"></div>
        <div id="pw-page-note" style="display:none; font-size:12px; color:#888; line-height:1.6; margin-bottom:10px;"></div>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button id="pw-add" style="flex:1; ${TS.btnO} ${TS.big}">推送到酒馆世界书</button>
            <button id="pw-update" style="flex:1; ${TS.btnG} ${TS.big}">更新酒馆里的内容</button>
        </div>
        <button id="pw-close" style="width:100%; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">关闭</button>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const $ = (sel) => modal.querySelector(sel);
    const close = () => overlay.remove();
    $('#pw-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const target = $('#pw-target');
    let tavernEntries = null;     // 选中的那本酒馆世界书的条目（新建时是 null）
    const curList = () => all.filter(w => catOf(w) === $('#pw-cat').value).sort((a, b) => TavernSync._phoneWeight(a) - TavernSync._phoneWeight(b));
    const statusOf = (w) => (target.value === '__new__' || !tavernEntries) ? { linked: false } : TavernSync.wbPushStatus(w, target.value, tavernEntries);
    function statusLabel(st) {
        if (!st.linked) return '';
        if (st.localChanged && st.tavernChanged) return '<span style="font-size:11px; color:#FF9800; margin-left:6px;">两边都改过</span>';
        if (st.localChanged) return '<span style="font-size:11px; color:#FF9800; margin-left:6px;">小手机里改过</span>';
        if (st.tavernChanged) return '<span style="font-size:11px; color:#FF9800; margin-left:6px;">酒馆里改过</span>';
        return '<span style="font-size:11px; color:#4CAF50; margin-left:6px;">已推送</span>';
    }
    function renderList() {
        const list = curList();
        $('#pw-list').innerHTML = list.map((w, i) => `
            <label style="display:flex; align-items:center; gap:10px; padding:10px; background:rgba(128,128,128,0.08); border-radius:8px; margin-bottom:6px; cursor:pointer; ${w.disabled ? 'opacity:0.55;' : ''}">
                <input type="checkbox" data-idx="${i}" style="flex-shrink:0; margin:0;">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:13px; font-weight:500; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(w.name || '未命名')}${w.isGlobal ? '（全局）' : ''}${w.disabled ? '（已关闭）' : ''}${statusLabel(statusOf(w))}</div>
                    <div style="font-size:11px; color:#888; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${phoneWbLine(w)}</div>
                </div>
            </label>`).join('') || '<div style="font-size:12px; color:#888; line-height:1.6;">这个分组里没有条目。</div>';
        activeFilter = null; paintFilters();
    }
    // 筛选按钮：点一下按条件选中并高亮，再点一下取消（和「导入酒馆世界书」一样）
    const boxes = () => [...modal.querySelectorAll('#pw-list input[type=checkbox]')];
    const filterBtns = [$('#pw-all'), $('#pw-changed')];
    let activeFilter = null;
    function paintFilters() {
        filterBtns.forEach(btn => {
            const on = btn === activeFilter;
            btn.style.background = on ? 'rgba(33,150,243,0.18)' : 'transparent';
            btn.style.color = on ? '#2196F3' : '#999';
            btn.style.borderColor = on ? 'rgba(33,150,243,0.5)' : 'rgba(128,128,128,0.35)';
        });
    }
    function applyFilter(btn, pick) {
        const list = curList();
        if (activeFilter === btn) { boxes().forEach(cb => { cb.checked = false; }); activeFilter = null; }
        else { boxes().forEach(cb => { cb.checked = pick(list[parseInt(cb.dataset.idx, 10)]); }); activeFilter = btn; }
        paintFilters();
    }
    filterBtns[0].addEventListener('click', () => applyFilter(filterBtns[0], () => true));
    filterBtns[1].addEventListener('click', () => applyFilter(filterBtns[1], (w) => { const st = statusOf(w); return st.linked && (st.localChanged || st.tavernChanged); }));
    $('#pw-list').addEventListener('change', () => { activeFilter = null; paintFilters(); });
    const getSelected = () => { const list = curList(); return boxes().filter(cb => cb.checked).map(cb => list[parseInt(cb.dataset.idx, 10)]).filter(Boolean); };

    async function loadTarget() {
        $('#pw-new-row').style.display = target.value === '__new__' ? 'flex' : 'none';
        tavernEntries = null;
        if (target.value !== '__new__') {
            const want = target.value;
            $('#pw-list').innerHTML = '<div style="font-size:12px; color:#888; line-height:1.6;">读取酒馆世界书中...</div>';
            try {
                const data = await TavernSync.getSTWorldInfo(want);
                if (target.value !== want) return;     // 读的时候又换了别的
                tavernEntries = (data && data.entries) || {};
            } catch (e) { showToast(`读取酒馆世界书失败：${e.message}`); }
        }
        renderList();
    }
    async function loadTargets(selectName) {
        let names = [];
        try { names = await TavernSync.getSTWorldNames(); } catch (e) { showToast(`读取酒馆世界书列表失败：${e.message}`); }
        target.innerHTML = '<option value="__new__">新建世界书</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
        if (selectName && names.includes(selectName)) target.value = selectName;
        await loadTarget();
    }
    $('#pw-cat').addEventListener('change', renderList);
    target.addEventListener('change', loadTarget);
    renderList();
    loadTargets();

    TavernSync.pingTavernPage().then(found => {
        if (!modal.isConnected || found) return;
        const el = $('#pw-page-note');
        el.style.display = 'block';
        el.textContent = '没有检测到同一个浏览器里开着的酒馆页面。如果你在别的设备或浏览器里开着酒馆，推送后请先刷新那边的酒馆页面再编辑这本世界书，否则酒馆会用它手里的旧版本把推过去的条目盖掉。';
    });

    const busy = (on) => { ['#pw-add', '#pw-update'].forEach(s => { $(s).disabled = on; }); };
    $('#pw-add').addEventListener('click', async () => {
        const selected = getSelected();
        if (!selected.length) { showToast('请先勾选条目'); return; }
        const creating = target.value === '__new__';
        const name = creating ? $('#pw-new-name').value.trim() : target.value;
        if (!name) { showToast('请填新世界书的名字'); return; }
        busy(true);
        try {
            const r = await TavernSync.pushWorldBooksToTavern(name, selected, { create: creating, mode: 'add' });
            showToast(r.added
                ? `已推送 ${r.added} 条到酒馆世界书「${name}」${r.skipped ? `，${r.skipped} 条之前推过（可以用「更新酒馆里的内容」）` : ''}`
                : '勾选的条目之前都推过了，可以用「更新酒馆里的内容」');
            await loadTargets(name);
        } catch (e) { showToast(e.message); }
        busy(false);
    });
    $('#pw-update').addEventListener('click', async () => {
        const selected = getSelected();
        if (!selected.length) { showToast('请先勾选条目'); return; }
        if (target.value === '__new__') { showToast('新建的世界书里还没有条目，先点「推送到酒馆世界书」'); return; }
        const name = target.value;
        const sts = selected.map(w => [w, statusOf(w)]);
        const changedInTavern = sts.filter(([, st]) => st.linked && st.tavernChanged).map(([w]) => w.name || '未命名');
        if (changedInTavern.length && !confirm(`勾选的条目里有 ${changedInTavern.length} 条在酒馆里改过（${changedInTavern.slice(0, 3).map(n => `「${n}」`).join('、')}${changedInTavern.length > 3 ? ' 等' : ''}），更新后会换成小手机的版本，酒馆里的改动会丢失。确定更新吗？`)) return;
        busy(true);
        try {
            const r = await TavernSync.pushWorldBooksToTavern(name, selected, { mode: 'update' });
            showToast(r.updated
                ? `已更新酒馆里的 ${r.updated} 条${r.notLinked ? `，${r.notLinked} 条还没推过` : ''}`
                : '勾选的条目还没推到这本世界书，先点「推送到酒馆世界书」');
            await loadTarget();
        } catch (e) { showToast(e.message); }
        busy(false);
    });
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
        try { slice = window.filterHistoryForAI(char, slice); } catch (e) { TavernSync.reportIssue('预览时处理小手机聊天记录失败：' + e.message); }
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
            title: '小手机聊天记录里的酒馆剧情',
            meta: `最近 ${maxMemory} 条小手机聊天记录中有 ${tavernViews.length} 楼（一共 ${totalFloors} 楼）：`
                + Object.entries(counts).map(([k, n]) => `${labels[k]} ${n}`).join('，') + '。',
            items: tavernViews.map(m => ({ label: labels[m.__tavernView], color: colors[m.__tavernView], content: m.content })),
            color: '#2196F3',
        });
    } else {
        sections.push({ title: '小手机聊天记录里的酒馆剧情', content: totalFloors
            ? `最近 ${maxMemory} 条小手机聊天记录里没有酒馆楼层（一共 ${totalFloors} 楼，都已经在更早的位置，AI 这次看不到原文）。`
            : '小手机里还没有酒馆剧情，点「同步酒馆剧情」同步进来。', color: '#999' });
    }

    sections.forEach(s => {
        s.tokens = estimateTokens(s.content || (s.items || []).map(it => it.content).join('\n'));
    });
    const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
    const box = 'font-size:12px; color:inherit; background:rgba(128,128,128,0.08); border-radius:8px; padding:10px; white-space:pre-wrap; line-height:1.5;';

    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">提示词预览 — ${esc(char.remarkName || char.name)}</h3>
        <div style="font-size:12px; color:#888; margin-bottom:12px; line-height:1.6;">下面是 AI 下次会收到的酒馆相关内容。<br>预估约 ${totalTokens.toLocaleString()} tokens。</div>
        <div style="flex:1; overflow-y:auto; margin-bottom:12px;">
            ${sections.map(s => `
                <div style="margin-bottom:14px;">
                    <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                        <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; flex-shrink:0;"></span>
                        <span style="font-size:13px; font-weight:600; color:${s.color};">${esc(s.title)}</span>
                        <span style="font-size:11px; color:#888; margin-left:auto;">约 ${s.tokens.toLocaleString()} tokens</span>
                    </div>
                    ${s.meta ? `<div style="font-size:12px; color:#888; margin-bottom:6px; line-height:1.6;">${esc(s.meta)}</div>` : ''}
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
    if (!files.length) { showToast('这个酒馆角色还没有酒馆聊天文件'); return; }
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    overlay.classList.add('ts-overlay');
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-color, #1a1a2e); border-radius:16px; padding:20px; width:100%; max-width:360px;';
    const firstCount = TavernSync.initialImportFor(binding);
    modal.innerHTML = `
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">更换酒馆聊天文件</h3>
        <select id="cc-chat" aria-label="酒馆聊天文件" title="酒馆聊天文件" style="${TS.input} margin-bottom:10px;">
            ${files.map(f => `<option value="${esc(f)}" ${f === binding.stChatFile ? 'selected' : ''}>${esc(f)}</option>`).join('')}
        </select>
        <div style="font-size:12px; color:#888; line-height:1.6; margin-bottom:16px;">
            换了之后，下次同步从新的酒馆聊天文件的最近 ${firstCount} 楼开始（在卡片上「第一次同步最近」那里可以改）。<br>
            以前那个酒馆聊天文件同步进来的剧情会留在小手机里，不想要可以在「管理同步范围」里删掉。<br>
            推送也从新的酒馆聊天文件重新算，已经推到旧的酒馆聊天文件里的消息不会搬过去。
        </div>
        <div style="display:flex; gap:10px;">
            <button id="cc-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
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
            showToast('已换成新的酒馆聊天文件');
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
        <h3 style="margin:0 0 12px; font-size:16px; font-weight:600;">添加角色绑定</h3>
        <div style="margin-bottom:12px;"><label style="${TS.label}">小手机角色</label>
            <select id="be-uwu" aria-label="小手机角色" title="小手机角色" style="${TS.input}">${db.characters.map(c => `<option value="${esc(c.id)}">${esc(c.remarkName || c.name)}</option>`).join('')}</select></div>
        <div style="margin-bottom:12px;"><label style="${TS.label}">酒馆角色</label>
            <select id="be-st" aria-label="酒馆角色" title="酒馆角色" style="${TS.input}">${stCharacters.map(c => `<option value="${esc(c.avatar)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div style="margin-bottom:16px;"><label style="${TS.label}">酒馆聊天文件</label>
            <select id="be-chat" aria-label="酒馆聊天文件" title="酒馆聊天文件" style="${TS.input}"><option value="">加载中...</option></select></div>
        <div style="display:flex; gap:10px;">
            <button id="be-cancel" style="flex:1; padding:10px; border-radius:10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; font-size:14px; cursor:pointer;">取消</button>
            <button id="be-save" style="flex:1; ${TS.btnP}">保存</button></div>`;
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const stSelect = modal.querySelector('#be-st'), chatSelect = modal.querySelector('#be-chat');
    // 「加载中」那一项不带值：没加载完就点保存会提示先选，不会把“加载中...”当成聊天文件名绑上。
    // 快速换酒馆角色时，只认最后一次读到的列表（先发的请求后回来，会把上一个角色的聊天填进来）
    let loadToken = 0;
    async function loadChats() {
        if (!stSelect.value) return;
        const token = ++loadToken;
        chatSelect.innerHTML = '<option value="">加载中...</option>';
        try { const chats = await TavernSync.getSTChats(stSelect.value);
            if (token !== loadToken) return;
            const list = (Array.isArray(chats) ? chats : []).filter(c => c && c.file_name);
            chatSelect.innerHTML = list.length ? list.map(c => `<option value="${esc(String(c.file_name).replace(/\.jsonl$/, ''))}">${esc(c.file_name)}</option>`).join('') : '<option value="">暂无酒馆聊天文件</option>';
        } catch { if (token === loadToken) chatSelect.innerHTML = '<option value="">加载失败</option>'; }
    }
    stSelect.addEventListener('change', loadChats); loadChats();
    modal.querySelector('#be-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    modal.querySelector('#be-save').addEventListener('click', async () => {
        const binding = { uwuCharId: modal.querySelector('#be-uwu').value, stCharAvatar: stSelect.value, stChatFile: chatSelect.value };
        if (!binding.uwuCharId || !binding.stCharAvatar) { showToast('请选择角色'); return; }
        if (!binding.stChatFile) { showToast('请选择酒馆聊天文件'); return; }
        const cfg = TavernSync.getConfig(); if (!cfg.bindings) cfg.bindings = [];
        // 一个小手机角色只能绑一个酒馆聊天（绑两次的话只有第一条起作用）
        if (cfg.bindings.some(b => b.uwuCharId === binding.uwuCharId)) {
            showToast('这个小手机角色已经绑定过了。想换酒馆聊天文件，点绑定卡片上的「更换」');
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
    'trimFloors', 'restoreRawFloors', 'refreshSummaries', 'removeOtherChatFloors', 'changeChatFile', 'recoverLostPushes',
    // 推送小手机人设/世界书：会改小手机世界书条目上的记录、加绑定，也排进来（里面互相调用的是不排队的版本）
    'pushWorldBooksToTavern', 'createTavernCharacter',
    // 双向更新人设/世界书：同步里面调的是它们本身（同步已经在排队），单独触发的这两个排进来
    'resolvePersonaConflict', 'syncSettingsBothWays'].forEach(name => {
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

// 小手机 - 酒馆扩展启动器（酒馆互通补丁的一部分，从 st 版 st-launcher.js 改来）
// 加载方式：酒馆读取仓库根目录的 manifest.json，把本文件当 ES module 注入到酒馆主页面
// 作用：
//   1. 在酒馆的“扩展菜单 (wand menu / #extensionsMenu)”加一个入口按钮，点击后新标签打开小手机
//   2. 小手机改了酒馆的聊天文件（推送、删除、写回修改）时，如果酒馆页面正开着同一个聊天，就让酒馆重新读一遍。
//      酒馆页面手里拿着的是改之前的聊天，不重新读的话，它下次保存（你发消息、扩展写摘要）会把小手机写进去的内容盖掉。
//   3. 小手机「推送小手机人设」「推送小手机世界书」之后：刷新角色列表和世界书、替小手机新建用户人设。
//
// 小手机地址按本文件自己的位置推算（本文件在 tavern/ 里，小手机主页在上一层），
// 所以仓库叫什么名字、装在酒馆的哪个文件夹都不用改这里。
const PHONE_URL = new URL('../index.html', import.meta.url).href;

// 记忆模块只在酒馆页加载。异步加载出错时，原来的手机入口和推送监听仍能使用。
let phoneMemoryModule = null;
let phoneMemoryAdapter = null;
let phoneMemoryLoadTask = null;
let phoneMemoryGenerationEpoch = 0;
let phoneMemoryCancellationEpoch = 0;
let phoneMemoryBridgeReady = false;
let phoneMemoryObservedSnapshot = null;

function isPrimaryPhoneMemoryGeneration(type, options = {}, dryRun = false) {
    return !dryRun && ['', 'normal', 'regenerate', 'swipe', 'continue'].includes(String(type || '').toLowerCase())
        && !options?.quiet_prompt && !options?.quietToLoud && !options?.quietImage
        && !options?.depth && !options?.internal;
}

function hasOnlyPhoneBlocks(message) {
    if (!message?.extra?.from_uwu) return false;
    const text = String(message.mes || '');
    let depth = 0, end = 0, found = false;
    for (const tag of text.matchAll(/<\/?phone_chat>/g)) {
        if (!depth && text.slice(end, tag.index).trim()) return false;
        if (tag[0] === '<phone_chat>') depth++;
        else if (!depth) return false;
        else depth--;
        end = tag.index + tag[0].length; found = true;
    }
    return found && !depth && !text.slice(end).trim();
}

function phoneMemoryChatSnapshot() {
    const ctx = getCtx();
    if (!ctx || !Array.isArray(ctx.chat)) return null;
    const character = ctx.characters?.[ctx.characterId];
    return JSON.stringify([ctx.groupId ?? null, character?.avatar ?? ctx.characterId ?? null,
        ctx.getCurrentChatId?.() ?? character?.chat ?? null,
        ctx.chat.map((message, index) => [message?.mes, message?.is_user,
            // 历史手机楼和普通角色楼的 is_system 是原生隐藏标志。
            // 当前普通用户输入及真正 System 楼的身份变化仍须阻止旧开始。
            Boolean(message?.is_system && !hasOnlyPhoneBlocks(message) && (/^system$/i.test(message?.name || '')
                || (message?.is_user && (!message?.extra?.from_uwu || index === ctx.chat.length - 1)))),
            message?.swipe_id ?? 0, message?.extra?.from_uwu,
            message?.extra?.bbs_omit, message?.extra?.uwu_msg_ids, message?.extra?.uwu_line_lens,
            message?.extra?.uwu_summary, message?.extra?.uwu_created,
            message?.extra?.uwu_internal, message?.extra?.isSmallSys, message?.name,
            // /role system 可只改原生 type，保持原名和可见性；其他插件的 type 不改变此身份。
            message?.extra?.type === 'narrator' || message?.extra?.type === 'comment',
            message?.send_date, message?.gen_started, message?.gen_finished])]);
}

function installPhoneMemoryLifecycleBridge() {
    if (phoneMemoryBridgeReady) return true;
    const ctx = getCtx();
    const events = ctx?.eventSource;
    const types = ctx?.eventTypes || ctx?.event_types;
    if (!events?.on || !types?.GENERATION_STARTED) return false;
    phoneMemoryObservedSnapshot = phoneMemoryChatSnapshot();
    events.on(types.GENERATION_STARTED, async (...args) => {
        // 并行摘要/预览并非新的主回复，不能取消正在等模块加载的主开始事件。
        const primary = isPrimaryPhoneMemoryGeneration(...args);
        const epoch = primary ? ++phoneMemoryGenerationEpoch : phoneMemoryGenerationEpoch;
        const cancellationEpoch = phoneMemoryCancellationEpoch;
        const snapshot = phoneMemoryChatSnapshot();
        // 后台开始不能掩盖等待中的主生成所要观察的来源变更。
        if (primary) phoneMemoryObservedSnapshot = snapshot;
        try {
            // 模块就绪后同步进入适配器；无须再让出微任务给并行后台的结束事件。
            const adapter = phoneMemoryAdapter || await phoneMemoryLoadTask;
            if ((primary && epoch !== phoneMemoryGenerationEpoch) || cancellationEpoch !== phoneMemoryCancellationEpoch
                || snapshot !== phoneMemoryChatSnapshot()
                || args[1]?.signal?.aborted) return;
            // 宿主会 await 开始事件，再删除 regenerate 的目标楼；必须在此处捕获目标。
            // 适配器使用 managed 模式，不在本次 emit 过程中追加第二个开始监听。
            if (typeof adapter?.startGeneration === 'function') return await adapter.startGeneration(...args);
            clearPhoneMemorySlotAfterFailure();
        } catch (error) {
            if (epoch !== phoneMemoryGenerationEpoch) return;
            clearPhoneMemorySlotAfterFailure();
            console.warn('[小手机] 手机剧情生成准备失败:', error);
            if (globalThis.toastr) globalThis.toastr.error('本次手机剧情补充失败，已清理临时补充；酒馆仍可正常回复。');
        }
    });
    for (const name of ['GENERATION_STOPPED', 'GENERATION_ENDED', 'CHAT_CHANGED',
        'CHARACTER_DELETED', 'PERSONA_CHANGED', 'MAIN_API_CHANGED', 'CONNECTION_PROFILE_LOADED',
        'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        if (types[name]) events.on(types[name], () => {
            phoneMemoryGenerationEpoch++;
            phoneMemoryCancellationEpoch++;
            phoneMemoryObservedSnapshot = phoneMemoryChatSnapshot();
        });
    }
    if (types.MESSAGE_UPDATED) events.on(types.MESSAGE_UPDATED, () => {
        const snapshot = phoneMemoryChatSnapshot();
        if (snapshot === phoneMemoryObservedSnapshot) return;
        phoneMemoryObservedSnapshot = snapshot;
        phoneMemoryGenerationEpoch++;
        phoneMemoryCancellationEpoch++;
    });
    phoneMemoryBridgeReady = true;
    return true;
}

function clearPhoneMemorySlotAfterFailure() {
    try {
        const ctx = getCtx();
        if (typeof ctx?.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt('uwu_phone_memory', '', 1, 1, false, 0, () => false);
        }
    } catch (error) { console.warn('[小手机] 清理手机剧情临时补充失败:', error); }
}

// 宿主加载 manifest 时就能找到拦截器。加载中的第一次生成等待初始化，
// 随后直接调用返回的适配器，避免重新读取全局函数而调回代理自身。
globalThis.uwuPhoneMemoryInterceptor = async (...args) => {
    const epoch = phoneMemoryGenerationEpoch;
    try {
        const adapter = phoneMemoryAdapter || await phoneMemoryLoadTask;
        if (epoch !== phoneMemoryGenerationEpoch) return;
        if (typeof adapter?.interceptor !== 'function') {
            clearPhoneMemorySlotAfterFailure();
            return;
        }
        return await adapter.interceptor(...args);
    } catch (error) {
        clearPhoneMemorySlotAfterFailure();
        console.warn('[小手机] 按需补充手机剧情执行失败:', error);
        if (globalThis.toastr) globalThis.toastr.error('本次手机剧情补充失败，已清理临时补充；酒馆仍可正常回复。');
    }
};

async function initializePhoneMemoryFeature() {
    // 重新加载失败时不能继续调用上一次的适配器。
    phoneMemoryAdapter = null;
    try {
        const module = await import('./st-phone-memory.js');
        // 少数宿主先执行扩展、再提供事件接口；等它就绪后仍由同步桥接管理开始事件。
        const deadline = Date.now() + 10000;
        while (!installPhoneMemoryLifecycleBridge()) {
            if (Date.now() >= deadline) throw new Error('酒馆生成事件接口尚未就绪');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const adapter = await module.initializePhoneMemory({ generationStartManaged: true });
        phoneMemoryModule = module;
        phoneMemoryAdapter = adapter;
        return adapter;
    } catch (error) {
        clearPhoneMemorySlotAfterFailure();
        console.warn('[小手机] 按需补充手机剧情初始化失败:', error);
        if (globalThis.toastr) {
            globalThis.toastr.error('按需补充手机剧情未能加载，请确认补丁文件完整并刷新酒馆。小手机入口与原推送仍可使用。');
        }
        return null;
    }
}

function invalidatePhoneMemoryAfterReload() {
    phoneMemoryGenerationEpoch++;
    phoneMemoryCancellationEpoch++;
    try {
        phoneMemoryModule?.invalidatePhoneMemory('phone-chat-reloaded');
    } catch (error) {
        console.warn('[小手机] 手机剧情来源更新失败:', error);
        if (globalThis.toastr) globalThis.toastr.error('手机剧情来源缓存未能更新，请刷新酒馆后再继续。');
    }
}

// 酒馆页面不受小手机的旧离线缓存控制，可以在打开前先把缓存版本更新完。
let phoneUpdateTask = null;
function preparePhoneUpdate() {
    if (phoneUpdateTask) return phoneUpdateTask;
    phoneUpdateTask = (async () => {
        if (!globalThis.isSecureContext || !globalThis.navigator?.serviceWorker) return;
        const base = new URL('./', PHONE_URL).href;
        const registration = await navigator.serviceWorker.register(new URL('sw.js', base).href,
            { scope: base, updateViaCache: 'none' });
        let candidate = registration.installing;
        const found = () => { candidate = registration.installing; };
        registration.addEventListener('updatefound', found);
        try {
            await registration.update();
            const deadline = Date.now() + 180000;
            while (true) {
                if (candidate?.state === 'redundant') throw new Error('新版本下载或校验失败，请稍后重试');
                if (!registration.installing && !registration.waiting && registration.active
                    && registration.active.state === 'activated') break;
                if (Date.now() >= deadline) throw new Error('更新检查超时，请检查网络后重试');
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        } finally {
            registration.removeEventListener('updatefound', found);
        }
    })().finally(() => { phoneUpdateTask = null; });
    return phoneUpdateTask;
}

function addPhoneMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        // 启动早于 wand menu 注入完成 → 轮询
        setTimeout(addPhoneMenuButton, 500);
        return;
    }
    if (document.getElementById('yuan-phone-wand-btn')) return; // 已存在不重复加

    const container = document.createElement('div');
    container.className = 'extension_container interactable';
    container.innerHTML = `
        <div id="yuan-phone-wand-btn" class="list-group-item flex-container flexGap5 interactable" title="小手机 - 在新标签打开">
            <div class="fa-fw fa-solid fa-mobile-screen-button extensionsMenuExtensionButton"></div>
            <span>小手机</span>
        </div>
    `;
    container.addEventListener('click', async () => {
        // 让事件冒泡（酒馆会自动收起 wand menu）
        // 先同步开一个窗口，避免等待下载以后被浏览器当成弹窗拦截。
        const phone = window.open('about:blank', '_blank');
        if (!phone) return;
        phone.opener = null;
        phone.document.title = '小手机';
        phone.document.body.textContent = '正在检查小手机更新，首次下载新版本可能需要一点时间…';
        try {
            await preparePhoneUpdate();
            const url = new URL(PHONE_URL);
            url.searchParams.set('tavern-open', Date.now().toString());
            if (!phone.closed) phone.location.replace(url.href);
        } catch (error) {
            console.warn('[小手机] 更新检查失败:', error);
            if (!phone.closed) {
                phone.document.body.textContent = `小手机更新检查失败：${error.message}。请关闭此页，稍后从酒馆重新打开。`;
            }
        }
    });
    menu.appendChild(container);
    console.log('[小手机] 入口按钮已注入:', PHONE_URL);
}

// ===== 小手机改了聊天 → 酒馆重新读一遍 =====
// 小手机和酒馆是同一个网址，用浏览器自带的 BroadcastChannel 互相通知（只在同一个浏览器里有效）。
// 小手机保存时酒馆正忙（生成回复/编辑某一楼）的话，酒馆忙完会先存一遍它手里的旧版本，可能把小手机写的盖掉。
// 柏宝书刚写完摘要、还没存盘时也算忙（见下面 busyReason）。
// 所以忙完、重新读完之后，回话告诉小手机是哪几次保存、当时在忙什么、什么时候忙完的，小手机据此核对并补推。
let channel = null;
let pendingReload = null;   // { avatar, file, saves: [{ saveId, time }], busySince, busyReason }：等着重新读的聊天
let activeReload = null;    // 在途读取完成后再处理新的保存通知，避免旧读取覆盖新读取。
let reloadTimer = null;
const SETTLE_MS = 1500;     // 忙完后再等一会儿：让酒馆把生成完的回复存好，再去读，免得读到半截

function currentChat() {
    const ctx = globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function'
        ? globalThis.SillyTavern.getContext() : null;
    if (!ctx || ctx.groupId) return null;
    const ch = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
    return ch ? { ctx, avatar: ch.avatar, file: ch.chat } : null;
}

// 柏宝书刚写好（或改了）摘要：它会等 1.5 秒再存盘。这时候重新读聊天，内存里那段还没存的摘要就没了。
// 柏宝书每次摘要有变化都会发一个公开通知 st-baibai-book:changed，收到后几秒内都算“忙”，等它存完再读。
const SUMMARY_SETTLE_MS = 4000;
let lastSummaryChange = 0;
try {
    if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('st-baibai-book:changed', () => { lastSummaryChange = Date.now(); });
    }
} catch (e) { /* 听不了就算了 */ }

// 酒馆正在生成回复、你正在酒馆里编辑某一楼、或者柏宝书刚写完摘要还没存时，先不重新读（会打断它），过一会儿再试。
// 返回在忙什么：'generating' / 'editing' / 'summary'，不忙返回 null
function busyReason() {
    const stop = document.getElementById('mes_stop');
    if (stop && getComputedStyle(stop).display !== 'none') return 'generating';
    if (document.getElementById('curEditTextarea')) return 'editing';
    if (Date.now() - lastSummaryChange < SUMMARY_SETTLE_MS) return 'summary';
    return null;
}

// 告诉小手机：这几次保存的时候酒馆在忙，忙完后酒馆存了自己手里的版本，可能盖掉了小手机写的内容
function replyMaybeOverwrote(p, ctx) {
    if (!channel) return;
    try {
        channel.postMessage({
            type: 'tavern-maybe-overwrote',
            avatar: p.avatar,                              // 哪个酒馆角色
            file: p.file,                                  // 哪个聊天
            saveIds: p.saves.map(x => x.saveId),           // 小手机哪几次保存（小手机据此找到那几次推了什么）
            phoneSaveTimes: p.saves.map(x => x.time),      // 那几次保存是什么时候
            busyReason: p.busyReason,                      // 当时酒馆在忙什么：generating 生成回复 / editing 编辑楼层 / summary 柏宝书存摘要
            busySince: p.busySince,                        // 酒馆这边什么时候发现在忙
            busyEnded: p.busyEnded,                        // 什么时候忙完
            reloadedAt: Date.now(),                        // 什么时候重新读完
            reloaded: !!p.reloaded,                        // 有没有真的重新读（酒馆版本太旧没有这个功能时是 false）
            floorCount: ctx && Array.isArray(ctx.chat) ? ctx.chat.length : null,   // 重新读完后这个聊天一共几楼
        });
    } catch (e) { console.warn('[小手机] 回话失败:', e); }
}

function tryReload() {
    reloadTimer = null;
    const p = pendingReload;
    if (!p) return;
    if (activeReload) return; // 完成回调会重新安排待处理任务。
    const cur = currentChat();
    // 酒馆现在开的不是这个聊天：它会在打开时自己从文件读，不用管
    if (!cur || cur.avatar !== p.avatar || cur.file !== p.file) { pendingReload = null; return; }
    const reason = busyReason();
    if (reason) {
        if (!p.busySince) { p.busySince = Date.now(); p.busyReason = reason; }
        p.busyEnded = null; // 等待保存时再次变忙，下一次结束仍须重新等待保存。
        reloadTimer = setTimeout(tryReload, 2000);
        return;
    }
    // 刚忙完：再等一会儿，让酒馆把它的保存做完
    if (p.busySince && !p.busyEnded) {
        p.busyEnded = Date.now();
        reloadTimer = setTimeout(tryReload, SETTLE_MS);
        return;
    }
    pendingReload = null;
    let reloadedContext = null;
    const done = () => { if (p.busySince) replyMaybeOverwrote(p, reloadedContext); };
    if (typeof cur.ctx.reloadCurrentChat === 'function') {
        activeReload = p;
        p.reloaded = false;
        // async 包裹也接住旧宿主的同步抛错，确保队列释放、覆盖风险回话都能完成。
        (async () => {
            try {
                await cur.ctx.reloadCurrentChat();
                const after = currentChat();
                if (after && after.avatar === p.avatar && after.file === p.file) {
                    p.reloaded = true;
                    reloadedContext = after.ctx;
                    invalidatePhoneMemoryAfterReload();
                }
            } catch (e) { console.warn('[小手机] 重新读取聊天失败:', e); }
            finally {
                activeReload = null;
                done();
                if (pendingReload && !reloadTimer) reloadTimer = setTimeout(tryReload, 300);
            }
        })();
    } else {
        if (globalThis.toastr) globalThis.toastr.info('小手机改了这个聊天，请刷新酒馆页面，否则酒馆下次保存会把小手机的改动盖掉');
        done();
    }
}

// ===== 小手机往酒馆里新建了角色、世界书、用户人设 =====
function getCtx() {
    return globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function'
        ? globalThis.SillyTavern.getContext() : null;
}

// 新建了角色：让酒馆重新读一遍角色列表，不用刷新页面就能看到
function refreshCharacters() {
    const ctx = getCtx();
    if (ctx && typeof ctx.getCharacters === 'function') {
        Promise.resolve(ctx.getCharacters()).catch(e => console.warn('[小手机] 刷新角色列表失败:', e));
    }
}

// 小手机改了某一本世界书：酒馆手里有这本的旧副本（缓存），不丢掉的话，你在酒馆里编辑这本世界书时
// 会拿旧副本存回去，把小手机加的条目盖掉。所以丢掉缓存，再刷新世界书列表和编辑器
async function refreshWorldInfo(name) {
    try {
        let wi = null;
        try { wi = await import('/scripts/world-info.js'); } catch (e) { wi = null; }
        const ctx = getCtx() || {};
        if (wi && wi.worldInfoCache && typeof wi.worldInfoCache.delete === 'function') wi.worldInfoCache.delete(name);
        const updateList = (wi && wi.updateWorldInfoList) || ctx.updateWorldInfoList;
        if (typeof updateList === 'function') await updateList();
        const reload = (wi && wi.reloadEditor) || ctx.reloadWorldInfoEditor;
        if (typeof reload === 'function') await reload(name, false);
    } catch (e) { console.warn('[小手机] 刷新世界书失败:', e); }
}

// 新建用户人设：酒馆的人设存在设置里，酒馆页面随时会把它手里的整份设置存回去，
// 所以由酒馆页面自己加进去再存，不会被盖掉。头像小手机已经传好了（avatarId 是头像文件名）
function addPersona(d) {
    const reply = (ok, error) => { try { channel.postMessage({ type: 'page-answer', id: d.id, ok, error }); } catch (e) { /* 回不了话，小手机会改用直接写文件 */ } };
    try {
        const ctx = getCtx();
        const pu = ctx && ctx.powerUserSettings;
        if (!pu || typeof ctx.saveSettingsDebounced !== 'function') { reply(false, '酒馆版本不支持'); return; }
        if (!pu.personas || typeof pu.personas !== 'object') pu.personas = {};
        if (!pu.persona_descriptions || typeof pu.persona_descriptions !== 'object') pu.persona_descriptions = {};
        pu.personas[d.avatarId] = d.name;
        pu.persona_descriptions[d.avatarId] = { description: d.description || '', position: 0, depth: 2, role: 0, lorebook: '' };
        ctx.saveSettingsDebounced();
        reply(true);
    } catch (e) { reply(false, e.message); }
}

// 小手机改了某个角色卡的描述/性格/场景或头像：重新读角色列表（酒馆生成回复时用的是它手里的这份）。
// 这个角色正开在酒馆的编辑页里时，把页面上的三栏也换成新的——否则你在编辑页随手改一个字，
// 酒馆会拿页面上的旧内容整份存回去，把小手机刚推过来的盖掉
function characterUpdated(d) {
    refreshCharacters();
    try {
        const ctx = getCtx();
        const ch = ctx && Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        if (!ch || ch.avatar !== d.avatar || !d.fields) return;
        const set = (id, v) => { const el = document.getElementById(id); if (el && typeof v === 'string') el.value = v; };
        set('description_textarea', d.fields.description);
        set('personality_textarea', d.fields.personality);
        set('scenario_pole', d.fields.scenario);
    } catch (e) { console.warn('[小手机] 更新编辑页失败:', e); }
}

// 小手机改了某个用户人设的内容：和新建一样，由酒馆页面自己改再存，不会被它手里的旧设置盖掉。
// 这个人设正在用时，酒馆另外存着一份“当前人设内容”和页面上的输入框，也一起换掉
async function updatePersona(d) {
    const reply = (ok, error) => { try { channel.postMessage({ type: 'page-answer', id: d.id, ok, error }); } catch (e) { /* 回不了话，小手机会改用直接写文件 */ } };
    try {
        const ctx = getCtx();
        const pu = ctx && ctx.powerUserSettings;
        if (!pu || typeof ctx.saveSettingsDebounced !== 'function') { reply(false, '酒馆版本不支持'); return; }
        if (!pu.persona_descriptions || typeof pu.persona_descriptions !== 'object') pu.persona_descriptions = {};
        pu.persona_descriptions[d.avatarId] = Object.assign({ position: 0, depth: 2, role: 0, lorebook: '' }, pu.persona_descriptions[d.avatarId], { description: d.description || '' });
        let current = d.activeAvatar;
        try { const mod = await import('/scripts/personas.js'); if (mod && typeof mod.user_avatar === 'string') current = mod.user_avatar; } catch (e) { /* 用小手机读到的 */ }
        if (current === d.avatarId) {
            pu.persona_description = d.description || '';
            const el = document.getElementById('persona_description');
            if (el) el.value = d.description || '';
        }
        ctx.saveSettingsDebounced();
        reply(true);
    } catch (e) { reply(false, e.message); }
}

// 小手机换了用户人设的头像：酒馆页面上的小图可能还是旧的（浏览器缓存），刷新人设列表
function refreshPersonaAvatar() {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.getUserAvatars === 'function') Promise.resolve(ctx.getUserAvatars()).catch(() => {});
    } catch (e) { /* 刷新不了就等下次打开 */ }
}

try {
    if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel('uwu-tavern-sync');
        channel.addEventListener('message', (e) => {
            const d = e.data;
            // 小手机问“同一个浏览器里有没有开着的酒馆页面”：回答一声（小手机据此决定要不要提醒你手动刷新酒馆）
            if (d && d.type === 'ping' && d.id) {
                try { channel.postMessage({ type: 'pong', id: d.id }); } catch (err) { /* 回答不了就算了 */ }
                return;
            }
            // 「推送小手机人设」「推送小手机世界书」之后：酒馆页面刷新角色列表 / 世界书、新建用户人设
            if (d && d.type === 'character-created') { refreshCharacters(); return; }
            if (d && d.type === 'worldinfo-saved' && d.name) { refreshWorldInfo(d.name); return; }
            if (d && d.type === 'add-persona' && d.id) { addPersona(d); return; }
            // 「双向自动更新人设」把小手机的改动推过来了
            if (d && d.type === 'character-updated' && d.avatar) { characterUpdated(d); return; }
            if (d && d.type === 'update-persona' && d.id) { updatePersona(d); return; }
            if (d && d.type === 'persona-updated') { refreshPersonaAvatar(d.avatarId); return; }
            if (!d || d.type !== 'chat-saved' || !d.avatar || !d.file) return;
            // 其他聊天的通知不能覆盖当前聊天已排队的重载和保存编号。
            const cur = currentChat();
            if (!cur || cur.avatar !== d.avatar || cur.file !== d.file) return;
            const same = pendingReload && pendingReload.avatar === d.avatar && pendingReload.file === d.file;
            if (!same) pendingReload = { avatar: d.avatar, file: d.file, saves: [] };
            if (d.saveId) pendingReload.saves.push({ saveId: d.saveId, time: d.time });
            // 已经在等酒馆忙完了：不用重新计时，忙完一起处理
            if (pendingReload.busySince) return;
            // 这一刻酒馆就在忙：记下来（小手机这次写的内容很可能会被忙完后的保存盖掉）
            const reason = busyReason();
            if (reason) { pendingReload.busySince = Date.now(); pendingReload.busyReason = reason; }
            clearTimeout(reloadTimer);
            // 稍等一下，小手机连着保存好几次时只读一遍
            reloadTimer = setTimeout(tryReload, 300);
        });
    }
} catch (e) { console.warn('[小手机] 无法监听小手机的改动:', e); }

// 启动
addPhoneMenuButton();
installPhoneMemoryLifecycleBridge();
phoneMemoryLoadTask = initializePhoneMemoryFeature();

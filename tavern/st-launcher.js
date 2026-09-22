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
    container.addEventListener('click', () => {
        // 让事件冒泡（酒馆会自动收起 wand menu）
        window.open(PHONE_URL, '_blank', 'noopener');
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
    const cur = currentChat();
    // 酒馆现在开的不是这个聊天：它会在打开时自己从文件读，不用管
    if (!cur || cur.avatar !== p.avatar || cur.file !== p.file) { pendingReload = null; return; }
    const reason = busyReason();
    if (reason) {
        if (!p.busySince) { p.busySince = Date.now(); p.busyReason = reason; }
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
    const done = () => { if (p.busySince) replyMaybeOverwrote(p, currentChat() && currentChat().ctx); };
    if (typeof cur.ctx.reloadCurrentChat === 'function') {
        p.reloaded = true;
        Promise.resolve(cur.ctx.reloadCurrentChat())
            .catch(e => { p.reloaded = false; console.warn('[小手机] 重新读取聊天失败:', e); })
            .finally(done);
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
            if (!d || d.type !== 'chat-saved' || !d.avatar || !d.file) return;
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

// 小手机 - 酒馆扩展启动器（酒馆互通补丁的一部分，从 st 版 st-launcher.js 改来）
// 加载方式：酒馆读取仓库根目录的 manifest.json，把本文件当 ES module 注入到酒馆主页面
// 作用：
//   1. 在酒馆的“扩展菜单 (wand menu / #extensionsMenu)”加一个入口按钮，点击后新标签打开小手机
//   2. 小手机改了酒馆的聊天文件（推送、删除、写回修改）时，如果酒馆页面正开着同一个聊天，就让酒馆重新读一遍。
//      酒馆页面手里拿着的是改之前的聊天，不重新读的话，它下次保存（你发消息、扩展写摘要）会把小手机写进去的内容盖掉。
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
let pendingReload = null;   // { avatar, file }：等着重新读的聊天
let reloadTimer = null;

function currentChat() {
    const ctx = globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function'
        ? globalThis.SillyTavern.getContext() : null;
    if (!ctx || ctx.groupId) return null;
    const ch = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
    return ch ? { ctx, avatar: ch.avatar, file: ch.chat } : null;
}

// 酒馆正在生成回复、或者你正在酒馆里编辑某一楼时，先不重新读（会打断它），过一会儿再试
function busy() {
    const stop = document.getElementById('mes_stop');
    const generating = !!stop && getComputedStyle(stop).display !== 'none';
    const editing = !!document.getElementById('curEditTextarea');
    return generating || editing;
}

function tryReload() {
    reloadTimer = null;
    if (!pendingReload) return;
    const cur = currentChat();
    // 酒馆现在开的不是这个聊天：它会在打开时自己从文件读，不用管
    if (!cur || cur.avatar !== pendingReload.avatar || cur.file !== pendingReload.file) { pendingReload = null; return; }
    if (busy()) { reloadTimer = setTimeout(tryReload, 2000); return; }
    pendingReload = null;
    if (typeof cur.ctx.reloadCurrentChat === 'function') {
        Promise.resolve(cur.ctx.reloadCurrentChat()).catch(e => console.warn('[小手机] 重新读取聊天失败:', e));
    } else if (globalThis.toastr) {
        globalThis.toastr.info('小手机改了这个聊天，请刷新酒馆页面，否则酒馆下次保存会把小手机的改动盖掉');
    }
}

try {
    if (typeof BroadcastChannel === 'function') {
        const channel = new BroadcastChannel('uwu-tavern-sync');
        channel.addEventListener('message', (e) => {
            const d = e.data;
            if (!d || d.type !== 'chat-saved' || !d.avatar || !d.file) return;
            pendingReload = { avatar: d.avatar, file: d.file };
            clearTimeout(reloadTimer);
            // 稍等一下，小手机连着保存好几次时只读一遍
            reloadTimer = setTimeout(tryReload, 300);
        });
    }
} catch (e) { console.warn('[小手机] 无法监听小手机的改动:', e); }

// 启动
addPhoneMenuButton();

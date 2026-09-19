// 小手机 - 酒馆扩展启动器（酒馆互通补丁的一部分，从 st 版 st-launcher.js 改来）
// 加载方式：酒馆读取仓库根目录的 manifest.json，把本文件当 ES module 注入到酒馆主页面
// 作用：在酒馆的“扩展菜单 (wand menu / #extensionsMenu)”加一个入口按钮，点击后新标签打开小手机
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

// 启动
addPhoneMenuButton();

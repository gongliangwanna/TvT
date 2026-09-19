// --- 酒馆互通外挂：挂钩子 (tavern/tavern_hooks.js) ---
// 不属于 yuan 原版文件。作用：不改 yuan 的任何文件，在运行时把酒馆互通功能“接”进 yuan。
//
// 加载位置有要求：必须放在 index.html 里 js/generated/html/99-mount.js 之后、js/ui.js 之前。
// 原因：99-mount.js 执行完页面结构才存在；而 ui.js 一加载就会记下“所有页面”的名单，
// 新加的“酒馆互联”页面必须在那之前放进去，否则切换页面时它关不掉。
//
// yuan 更新后如果某个钩子挂不上，控制台会出现“[酒馆外挂] 挂载失败”的红字，照着提示修这个文件即可。
(function () {
    const TAG = '[酒馆外挂]';
    function fail(what) {
        console.error(`${TAG} 挂载失败：${what}。可能是 yuan 更新后改了结构，需要调整 tavern/tavern_hooks.js`);
    }

    // ========== 1. “酒馆互联”页面 ==========
    function addScreen() {
        if (document.getElementById('tavern-sync-screen')) return;
        const moreScreen = document.getElementById('more-screen');
        if (!moreScreen) return fail('找不到“更多”页面 #more-screen');
        const screen = document.createElement('div');
        screen.id = 'tavern-sync-screen';
        screen.className = 'screen';
        screen.innerHTML = `
            <header class="app-header">
                <button class="back-btn" data-target="more-screen">‹</button>
                <div class="title-container"><h1 class="title">酒馆互联</h1></div>
                <div class="placeholder"></div>
            </header>
            <main class="content" style="padding: 15px;">
                <!-- 内容由 tavern_sync.js 的 setupTavernSyncScreen() 动态生成 -->
            </main>`;
        moreScreen.parentNode.appendChild(screen);
    }

    // ========== 2. “更多”菜单里的入口 ==========
    function addMenuItem() {
        if (document.querySelector('#more-screen .menu-item[data-action="tavern-sync"]')) return;
        const grids = document.querySelectorAll('#more-screen .menu-grid');
        if (!grids.length) return fail('找不到“更多”页面里的菜单格子 .menu-grid');
        const item = document.createElement('div');
        item.className = 'menu-item';
        item.dataset.action = 'tavern-sync';
        item.innerHTML = `
            <div class="menu-icon-wrapper">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            </div>
            <span class="menu-item-label">酒馆互联</span>`;
        item.addEventListener('click', () => {
            if (typeof window.setupTavernSyncScreen !== 'function') return fail('tavern_sync.js 没有加载成功');
            if (typeof switchScreen !== 'function') return fail('找不到 yuan 的页面切换函数 switchScreen');
            window.setupTavernSyncScreen();
            switchScreen('tavern-sync-screen');
        });
        grids[grids.length - 1].appendChild(item);
    }

    // ========== 3. 让“酒馆互联”的设置能保存 ==========
    // yuan 只保存 globalSettingKeys 名单里的设置项，把 tavernSync 加进名单。
    // 名单在 yuan 后面的脚本里才定义，所以等页面脚本全部加载完（DOMContentLoaded）再加；
    // 这个监听比 main.js 的注册得早，所以会赶在 yuan 读取数据（loadData）之前执行。
    function registerSettingKey() {
        if (typeof globalSettingKeys === 'undefined' || !Array.isArray(globalSettingKeys)) {
            return fail('找不到 yuan 的设置名单 globalSettingKeys，酒馆互联设置将无法保存');
        }
        if (!globalSettingKeys.includes('tavernSync')) globalSettingKeys.push('tavernSync');
    }

    addScreen();
    addMenuItem();
    document.addEventListener('DOMContentLoaded', registerSettingKey);
})();

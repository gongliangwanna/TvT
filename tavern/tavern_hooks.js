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
        const grid = grids[grids.length - 1];
        grid.appendChild(item);
        keepLast(grid, item);
    }

    // 让外挂加的按钮始终排在最后：yuan 以后如果用代码往同一处再加按钮，就把我们的挪回末尾
    function keepLast(container, item) {
        new MutationObserver(() => {
            if (item.parentNode === container && container.lastElementChild !== item) container.appendChild(item);
        }).observe(container, { childList: true });
    }

    // ========== 3. 聊天页“+”面板里的“推送酒馆”按钮 ==========
    // 只有当前私聊角色绑定了酒馆时才显示（每次打开“+”面板时判断，见下面的 hookShowPanel）
    function addChatPushButton() {
        if (document.getElementById('push-tavern-btn')) return;
        const grid = document.querySelector('#panel-function-area .expansion-grid');
        if (!grid) return fail('找不到聊天页“+”面板的按钮区 #panel-function-area .expansion-grid');
        const item = document.createElement('div');
        item.className = 'expansion-item';
        item.id = 'push-tavern-btn';
        item.style.display = 'none';
        item.innerHTML = `
            <div class="expansion-item-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12,2L4,9H9V15H15V9H20L12,2M4,19V21H20V19H4Z"/>
                </svg>
            </div>
            <span class="expansion-item-name">推送酒馆</span>`;
        item.addEventListener('click', async () => {
            if (!window.TavernSync) { showToast('酒馆同步未启用'); return; }
            const binding = window.TavernSync.findBindingForChar(currentChatId);
            if (!binding) { showToast('该角色未绑定酒馆'); return; }
            if (typeof showPanel === 'function') showPanel('none');
            window.showAutoPushModal(binding);
        });
        grid.appendChild(item);
        // “+”面板第一次打开时 yuan 会把这些按钮按每页 8 个重新分页，之后 grid 就不存在了，
        // 所以只在分页前保持“最后一个”即可
        keepLast(grid, item);
    }

    function updateChatPushButton() {
        const btn = document.getElementById('push-tavern-btn');
        if (!btn) return;
        let hasBinding = false;
        try {
            hasBinding = currentChatType === 'private' && !!window.TavernSync
                && !!window.TavernSync.findBindingForChar(currentChatId);
        } catch (e) { /* 取不到当前聊天就当作没绑定 */ }
        btn.style.display = hasBinding ? '' : 'none';
    }

    // yuan 用 showPanel('function') 打开“+”面板。在它外面套一层：打开前先决定按钮显不显示
    function hookShowPanel() {
        if (typeof window.showPanel !== 'function') {
            return fail('找不到 yuan 的面板函数 showPanel，聊天页的“推送酒馆”按钮不会显示');
        }
        const originalShowPanel = window.showPanel;
        window.showPanel = function (type) {
            if (type === 'function') updateChatPushButton();
            return originalShowPanel.apply(this, arguments);
        };
    }

    // ========== 4. 把酒馆剧情塞进发给 AI 的提示词 ==========
    // yuan 用 generatePrivateSystemPrompt(角色) 生成私聊的系统提示词（普通模式、自定义模板、分层提示词、剧情节点都走它）。
    // 在它外面套一层：yuan 生成完之后，把酒馆内容插进去：
    //   - 有 </memoir>（共同回忆区）→ 插在它前面，和 st 版位置一致
    //   - 没有（比如没收藏任何日记时，yuan 不输出回忆区）→ 自己包一个 <memoir> 放在 <logic_rules> 前面
    //   - 连 <logic_rules> 都没有（用户自定义模板）→ 放在最后
    function insertTavernBlock(prompt, block) {
        const memoirEnd = prompt.indexOf('</memoir>');
        if (memoirEnd !== -1) return prompt.slice(0, memoirEnd) + '\n' + block + '\n' + prompt.slice(memoirEnd);
        const wrapped = `<memoir>\n${block}\n</memoir>\n\n`;
        const logicStart = prompt.indexOf('<logic_rules>');
        if (logicStart !== -1) return prompt.slice(0, logicStart) + wrapped + prompt.slice(logicStart);
        return prompt + '\n\n' + wrapped;
    }

    function hookSystemPrompt() {
        if (typeof window.generatePrivateSystemPrompt !== 'function') {
            return fail('找不到 yuan 的提示词函数 generatePrivateSystemPrompt，AI 将看不到酒馆剧情');
        }
        const originalGenerate = window.generatePrivateSystemPrompt;
        window.generatePrivateSystemPrompt = function (character) {
            const prompt = originalGenerate.apply(this, arguments);
            if (typeof prompt !== 'string' || !window.TavernSync) return prompt;
            let block = '';
            try { block = window.TavernSync.buildPromptBlock(character); }
            catch (e) { console.error(`${TAG} 生成酒馆提示词失败：`, e); }
            return block ? insertTavernBlock(prompt, block) : prompt;
        };
    }

    // ========== 5. 让“酒馆互联”的设置能保存 ==========
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
    addChatPushButton();
    document.addEventListener('DOMContentLoaded', () => {
        registerSettingKey();
        hookShowPanel();
        hookSystemPrompt();
    });
})();

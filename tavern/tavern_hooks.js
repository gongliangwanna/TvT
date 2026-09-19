// --- 酒馆互通外挂：挂钩子 (tavern/tavern_hooks.js) ---
// 不属于 yuan 原版文件。作用：不改 yuan 的任何文件，在运行时把酒馆互通功能“接”进 yuan。
//
// 加载位置有要求：必须放在 index.html 里 js/generated/html/99-mount.js 之后、js/ui.js 之前。
// 原因：99-mount.js 执行完页面结构才存在；而 ui.js 一加载就会记下“所有页面”的名单，
// 新加的“酒馆互联”页面必须在那之前放进去，否则切换页面时它关不掉。
//
// yuan 更新后如果某个钩子挂不上，“酒馆互联”页面顶部会出现“挂载失败”的提示（控制台也有），照着提示修这个文件即可。
(function () {
    const TAG = '[酒馆外挂]';
    // 文件版本：显示在“酒馆互联”页面最下面（见 tavern_sync.js 的 SYNC_VERSION）
    const HOOKS_VERSION = '2026-09-20 b';
    if (window.TavernSync) window.TavernSync.HOOKS_VERSION = HOOKS_VERSION;
    function fail(what) {
        const text = `挂载失败：${what}。可能是 yuan 更新后改了结构，需要调整 tavern/tavern_hooks.js`;
        // 记到“酒馆互联”页面顶部的问题记录里（手机上看控制台不方便）
        if (window.TavernSync && typeof window.TavernSync.reportIssue === 'function') window.TavernSync.reportIssue(text);
        else console.error(`${TAG} ${text}`);
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
            catch (e) { fail('生成酒馆提示词出错：' + e.message); }
            return block ? insertTavernBlock(prompt, block) : prompt;
        };
    }

    // ========== 5. 重新生成、AI 回复后自动推送 ==========
    // yuan 的“重新生成”（handleRegenerate）只能对最后一轮用：删掉最后一条用户消息之后的所有内容，再调用 getAiReply。
    // 补丁的处理（维护者的设计）：“重新生成”是换掉当时那几句回复，不是在后面接着聊，所以
    //   - 被一起删掉的酒馆楼层先不放回 → AI 重新生成时看不到“之后才发生的”酒馆剧情；
    //   - 回复生成完，把新回复的时间设成紧跟在那条用户消息之后，再把酒馆楼层放回来 → 新回复留在原位置；
    //   - 酒馆里如果已经有旧回复（推送过），就在那一楼里原地换成新回复（位置不动、不新增楼层），
    //     酒馆里没有旧回复（没推送过），就把新回复接在酒馆里“这轮之前最后一条小手机消息”那一楼里；
    //     成功后新回复标记 skipTavernPush，免得再推一次；
    //   - 生成期间旧回复记在 binding.keptIds 里，删除同步当作还在，免得在替换前就被删掉；
    //     替换失败时退回“酒馆保留旧回复、新回复不推送”，并在页面上报问题。
    // 你自己长按删掉的酒馆卡片不受影响（不是“重新生成”删的），下次同步时才会重新出现。
    let regenSnapshot = null;

    function hookRegenerate() {
        if (typeof window.handleRegenerate !== 'function') {
            return fail('找不到 yuan 的重新生成函数 handleRegenerate，“重新生成”会删掉后面的酒馆剧情（下次同步会恢复），旧回复也会从酒馆删掉');
        }
        const originalRegenerate = window.handleRegenerate;
        window.handleRegenerate = function () {
            try {
                const char = currentChatType === 'private' ? db.characters.find(c => c.id === currentChatId) : null;
                // yuan 有时会先弹“保存旧版本？”的确认框，用户点完才真正重新生成，所以快照保留一会儿（2 分钟）
                regenSnapshot = char && Array.isArray(char.history)
                    ? { chatId: currentChatId, history: char.history.slice(), time: Date.now() } : null;
            } catch (e) { regenSnapshot = null; }
            return originalRegenerate.apply(this, arguments);
        };
    }

    // 调用 AI 之前：如果这是一次“重新生成”，算出被删掉了什么，先不放回酒馆楼层
    function beginRegenerate(chatId, chatType) {
        const snap = regenSnapshot;
        if (!snap || chatType !== 'private' || snap.chatId !== chatId) return null;
        regenSnapshot = null;
        if (Date.now() - snap.time > 2 * 60 * 1000) return null;
        const char = db.characters.find(c => c.id === chatId);
        if (!char || !Array.isArray(char.history)) return null;
        const present = new Set(char.history.map(m => m && m.id));
        const removed = snap.history.filter(m => m && !present.has(m.id));
        if (!removed.length) return null;
        let anchorTime = null;   // 最后一条用户消息的时间：新回复要紧跟在它后面
        for (let i = char.history.length - 1; i >= 0; i--) {
            const m = char.history[i];
            if (m && m.role === 'user' && !m.fromTavern) { anchorTime = Number(m.timestamp); break; }
        }
        const removedReplies = removed.filter(m => !m.fromTavern);
        // 旧回复要在酒馆里保留：必须现在就记下，不能等 AI 回完——
        // “删消息时同步删酒馆”每 1.5 秒检查一次，可能在 AI 回复期间就去酒馆删它们
        const binding = window.TavernSync.findBindingForChar(char.id);
        if (binding && removedReplies.length) {
            binding.keptIds = [...(Array.isArray(binding.keptIds) ? binding.keptIds : []), ...removedReplies.map(m => m.id)].slice(-500);
            if (typeof saveData === 'function') saveData();
        }
        return {
            char,
            binding,
            anchorTime: Number.isFinite(anchorTime) ? anchorTime : null,
            removedFloors: removed.filter(m => m.fromTavern),
            removedReplies,
            idsBefore: present,
        };
    }

    // AI 回完之后：新回复放回原位置；酒馆里的旧回复原地换成新回复；酒馆楼层放回来
    async function finishRegenerate(regen) {
        const { char, binding } = regen;
        const newReplies = char.history.filter(m => m && !regen.idsBefore.has(m.id) && !m.fromTavern);

        if (regen.removedFloors.length && regen.anchorTime != null) {
            newReplies.forEach((m, i) => { m.timestamp = regen.anchorTime + i + 1; });
        }
        const oldIds = regen.removedReplies.map(m => m.id);
        if (binding && oldIds.length && newReplies.length) {
            const oldSet = new Set(oldIds);
            const dropKept = () => { binding.keptIds = (binding.keptIds || []).filter(id => !oldSet.has(id)); };
            try {
                const r = await window.TavernSync.replaceRegeneratedInTavern(binding, oldIds, newReplies);
                if (r.replaced) {
                    // 新回复已经在酒馆里了（替换进去的），不要再推一次
                    newReplies.forEach(m => { m.skipTavernPush = true; });
                    if (oldSet.has(binding.lastPushedMsgId)) binding.lastPushedMsgId = newReplies[newReplies.length - 1].id;
                } else if (oldSet.has(binding.lastPushedMsgId)) {
                    // 酒馆里没找到旧回复（没推送过或被手动删了）：新回复按平常推送，“上次推送到”退回这轮之前
                    const before = char.history.filter(m => m && !m.fromTavern && !newReplies.includes(m) && Number(m.timestamp) <= (regen.anchorTime ?? Infinity));
                    binding.lastPushedMsgId = before.length ? before[before.length - 1].id : null;
                }
                dropKept();   // 旧回复在酒馆里已经被换掉（或本来就没有），不用再保护
            } catch (e) {
                // 替换失败（比如连不上酒馆）：退回“不推送新回复、酒馆保留旧回复”，免得酒馆里出现重复或错位
                window.TavernSync.reportIssue('重新生成后替换酒馆里的旧回复失败：' + e.message + '。酒馆里保留了旧回复，可以去酒馆手动修改');
                newReplies.forEach(m => { m.skipTavernPush = true; });
                if (oldSet.has(binding.lastPushedMsgId)) binding.lastPushedMsgId = newReplies[newReplies.length - 1].id;
            }
        }
        if (regen.removedFloors.length) {
            char.history.push(...regen.removedFloors);
            window.TavernSync.placeTavernFloors(char);
        }
        if (typeof saveData === 'function') await saveData();
        if (typeof renderMessages === 'function' && currentChatId === char.id) {
            try { renderMessages(false, true); } catch (e) { /* 画不出来不影响数据 */ }
        }
    }

    // yuan 的 getAiReply(聊天ID, 聊天类型, ...) 负责一轮 AI 回复，成功结束时返回 true。
    // 在它外面套一层：处理“重新生成”（见上面），私聊回复成功后按“自动推送”设置推到酒馆。
    function hookAiReply() {
        if (typeof window.getAiReply !== 'function') {
            return fail('找不到 yuan 的回复函数 getAiReply，“AI 回复后自动推送”将不起作用');
        }
        const originalGetAiReply = window.getAiReply;
        window.getAiReply = async function (chatId, chatType) {
            let regen = null;
            try { if (window.TavernSync) regen = beginRegenerate(chatId, chatType); }
            catch (e) { fail('处理重新生成出错：' + e.message); }
            let result;
            try {
                result = await originalGetAiReply.apply(this, arguments);
            } finally {
                // 不管回复成功与否，都要把酒馆楼层放回来
                if (regen) {
                    try { await finishRegenerate(regen); }
                    catch (e) { fail('重新生成后整理酒馆楼层出错：' + e.message); }
                }
            }
            if (result === true && chatType === 'private' && window.TavernSync) {
                window.TavernSync.autoPushIfNeeded(chatId).catch(e => console.warn(`${TAG} 自动推送失败：`, e));
            }
            return result;
        };
    }


    // ========== 6. 打开聊天时自动拉取、删消息时同步删酒馆 ==========
    // yuan 打开聊天、删消息的写法有很多处（单删、多选删、按范围删、重新生成、清空……），
    // 一处处挂钩子容易在 yuan 更新后断掉。所以改成每 1.5 秒看一眼当前打开的聊天：
    //   - 换到了另一个私聊 → 按“自动拉取”设置从酒馆拉取记忆
    //   - 当前私聊里有消息消失了 → 按“自动推送”设置，把删除同步到酒馆（稍等 1.5 秒，把连续删除合并成一次）
    // 只在内存里对比消息编号，不联网；只有真的发现变化才会去连酒馆。
    // 酒馆剧情卡片可以像普通消息一样长按删除，删掉后 AI 就读不到了，下次同步会重新出现。
    function startChatWatcher() {
        let lastChatId = null;
        let knownIds = null;
        let deletionTimer = null;
        setInterval(() => {
            try { ensureGrouped(); } catch (e) { /* 分组失败不影响同步 */ }
            const TS = window.TavernSync;
            if (!TS || typeof db === 'undefined' || !Array.isArray(db.characters)) return;
            const chatId = (typeof currentChatType !== 'undefined' && currentChatType === 'private'
                && typeof currentChatId !== 'undefined') ? currentChatId : null;

            if (chatId !== lastChatId) {
                lastChatId = chatId;
                knownIds = null;
                if (chatId) TS.autoPullIfNeeded(chatId).catch(() => {});
            }
            if (!chatId || !TS.findBindingForChar(chatId)) { knownIds = null; return; }

            const char = db.characters.find(c => c.id === chatId);
            if (!char || !Array.isArray(char.history)) return;
            const ids = new Set(char.history.map(m => m.id));
            if (knownIds) {
                for (const id of knownIds) {
                    if (!ids.has(id)) {
                        clearTimeout(deletionTimer);
                        deletionTimer = setTimeout(() => TS.autoDeletionSyncIfNeeded(chatId).catch(() => {}), 1500);
                        break;
                    }
                }
            }
            knownIds = ids;
        }, 1500);
    }


    // ========== 7. 酒馆楼层在聊天里显示成折叠卡片 ==========
    // 从酒馆导入的楼层（fromTavern）放在聊天记录里，但不应该像普通气泡那样显示。
    // yuan 用 createMessageBubbleElement(消息) 画每一条消息，在它外面套一层：遇到酒馆楼层就画成可点开的卡片，
    // 样式借用 yuan 剧情节点摘要的那种折叠卡片。
    function buildTavernCard(message) {
        const t = message.tavern || {};
        const wrapper = document.createElement('div');
        wrapper.className = 'message-wrapper system-notification independent-summary-wrapper received tavern-floor-wrapper';
        wrapper.dataset.id = message.id;
        wrapper.dataset.tavernFloor = t.floor != null ? String(t.floor) : "";
        wrapper.style.margin = '6px 0';

        const box = document.createElement('div');
        box.className = 'node-summary-container independent-summary';
        box.style.maxWidth = '90%';

        const toggle = document.createElement('div');
        toggle.className = 'node-summary-toggle';
        toggle.textContent = `酒馆剧情 · 第${t.floor}楼${t.name ? ' · ' + t.name : ''}${t.summary ? ' · 有摘要' : ''}`;

        const body = document.createElement('div');
        body.className = 'node-summary-content';
        body.style.display = 'none';
        body.style.whiteSpace = 'pre-wrap';
        body.style.textAlign = 'left';
        body.textContent = message.content || '';
        if (t.summary && t.summary.text) {
            const sum = document.createElement('div');
            sum.style.cssText = 'margin-top:10px; padding-top:8px; border-top:1px dashed rgba(128,128,128,0.4); opacity:0.85;';
            sum.textContent = `柏宝书摘要${t.summary.time ? `（${t.summary.time}）` : ''}：${t.summary.text}`;
            body.appendChild(sum);
        }

        toggle.addEventListener('click', () => {
            body.style.display = body.style.display === 'none' ? 'block' : 'none';
        });
        box.appendChild(toggle);
        box.appendChild(body);
        wrapper.appendChild(box);
        return wrapper;
    }

    function hookBubbleRender() {
        if (typeof window.createMessageBubbleElement !== 'function') {
            return fail('找不到 yuan 画消息的函数 createMessageBubbleElement，酒馆楼层会显示成普通消息');
        }
        const originalCreate = window.createMessageBubbleElement;
        window.createMessageBubbleElement = function (message) {
            if (message && message.fromTavern) {
                try { return buildTavernCard(message); }
                catch (e) { fail('画酒馆剧情卡片出错：' + e.message); }
            }
            return originalCreate.apply(this, arguments);
        };
    }

    // ========== 7.5 连续的酒馆剧情整组折叠 ==========
    // 聊天界面里连着的一串酒馆楼层，默认收成一张“酒馆剧情 · N 楼”的卡片，免得把小手机上文挤得看不到。
    // 点开后显示原来的一张张楼层卡片（再点某一楼看原文）；组的开头和结尾都有“收起”，
    // 楼层很多时不用翻回开头也能收起，从结尾收起后会滚回这一组的位置。
    // 做法：不改 yuan 画消息的流程，而是在聊天区内容变化后，把连续的 .tavern-floor-wrapper 分组，
    // 在每组前后插入我们自己的“组头/组尾”，并按展开状态显示或隐藏组里的楼层。
    // 夹在酒馆楼层之间的时间分隔线也算进组里一起收起。
    const expandedGroups = new Set();   // 展开着的组（用组里第一楼的消息编号记），重新画聊天后保持
    let groupObserver = null;
    let regroupScheduled = false;

    function makeGroupBar(text, onClick) {
        const outer = document.createElement('div');
        outer.className = 'tavern-group-bar';
        outer.style.cssText = 'display:flex; justify-content:center; margin:8px 0;';
        const box = document.createElement('div');
        box.className = 'node-summary-container independent-summary';
        box.style.maxWidth = '90%';
        const toggle = document.createElement('div');
        toggle.className = 'node-summary-toggle';
        toggle.textContent = text;
        toggle.addEventListener('click', (e) => { e.stopPropagation(); onClick(outer); });
        box.appendChild(toggle);
        outer.appendChild(box);
        return outer;
    }

    function regroupTavernFloors() {
        const area = document.getElementById('message-area');
        if (!area) return;
        if (groupObserver) groupObserver.disconnect();
        try {
            area.querySelectorAll(':scope > .tavern-group-bar').forEach(el => el.remove());
            // 找出连续的酒馆楼层（中间只隔着时间分隔线也算连续）
            const groups = [];
            let current = null, pendingDividers = [];
            const isFloor = (el) => el.classList.contains('tavern-floor-wrapper') || el.hasAttribute('data-tavern-floor');
            for (const el of Array.from(area.children)) {
                if (isFloor(el)) {
                    if (!current) { current = { floors: [], members: [] }; groups.push(current); }
                    else current.members.push(...pendingDividers);
                    pendingDividers = [];
                    current.floors.push(el);
                    current.members.push(el);
                } else if (current && el.classList.contains('time-divider')) {
                    pendingDividers.push(el);
                } else {
                    current = null; pendingDividers = [];
                }
            }
            for (const g of groups) {
                const key = g.floors[0].dataset.id;
                const open = expandedGroups.has(key);
                const count = g.floors.length;
                const floorNos = g.floors.map(el => el.dataset.tavernFloor).filter(x => x !== undefined && x !== '');
                const range = floorNos.length ? `（第${floorNos[0]}${floorNos.length > 1 ? '~' + floorNos[floorNos.length - 1] : ''}楼）` : '';
                g.members.forEach(el => { el.style.display = open ? '' : 'none'; });
                const toggleGroup = (bar, fromBottom) => {
                    if (expandedGroups.has(key)) expandedGroups.delete(key); else expandedGroups.add(key);
                    regroupTavernFloors();
                    // 从组尾收起：滚回这一组的位置，不然会停在很下面
                    if (fromBottom) {
                        const head = Array.from(area.querySelectorAll(':scope > .tavern-group-bar')).find(el => el.dataset.group === key);
                        if (head) head.scrollIntoView({ block: 'center' });
                    }
                };
                const head = makeGroupBar(
                    open ? `酒馆剧情 · ${count} 楼${range} · 点击收起` : `酒馆剧情 · ${count} 楼${range} · 点击展开`,
                    (bar) => toggleGroup(bar, false));
                head.dataset.group = key;
                area.insertBefore(head, g.members[0]);
                if (open) {
                    const tail = makeGroupBar(`收起酒馆剧情（${count} 楼）`, (bar) => toggleGroup(bar, true));
                    const last = g.members[g.members.length - 1];
                    area.insertBefore(tail, last.nextSibling);
                }
            }
        } catch (e) {
            fail('整理酒馆剧情分组出错：' + e.message);
        } finally {
            if (groupObserver) groupObserver.observe(area, { childList: true });
        }
    }

    // 保险：万一“监听页面变化”在某些浏览器里没触发，每 1.5 秒的检查里也看一眼——
    // 聊天里有酒馆卡片却没有分组标题，就重新分一次组。只比对数量，很省事。
    function ensureGrouped() {
        const area = document.getElementById('message-area');
        if (!area) return;
        const floors = area.querySelectorAll(':scope > .tavern-floor-wrapper, :scope > [data-tavern-floor]').length;
        if (!floors) {
            diagnoseGrouping(area);
            return;
        }
        if (area.querySelectorAll(':scope > .tavern-group-bar').length) return;
        regroupTavernFloors();
        // 分了组还是没有组标题 → 说明分组这步没起作用，报出来好排查（同一句话只会记一次）
        if (!area.querySelectorAll(':scope > .tavern-group-bar').length) {
            fail(`聊天里有 ${floors} 张酒馆剧情卡片，但整组折叠没能生效`);
        }
    }

    // 找不到酒馆剧情卡片时的现场勘查：把聊天区里的真实情况报到“酒馆互联”页面，方便排查（只报一次）
    let diagnosed = false;
    function diagnoseGrouping(area) {
        if (diagnosed) return;
        try {
            if (typeof currentChatType === 'undefined' || currentChatType !== 'private' || !currentChatId) return;
            const chatScreen = document.getElementById('chat-room-screen');
            if (!chatScreen || !chatScreen.classList.contains('active')) return;
            const char = db.characters.find(c => c.id === currentChatId);
            const floorMsgs = char && Array.isArray(char.history) ? char.history.filter(m => m && m.fromTavern) : [];
            if (!floorMsgs.length) return;
            diagnosed = true;
            const ids = new Set(floorMsgs.map(m => m.id));
            const found = document.querySelector('[data-id]') ? Array.from(document.querySelectorAll('[data-id]')).find(el => ids.has(el.dataset.id)) : null;
            const kids = Array.from(area.children).slice(0, 6).map(el => el.tagName.toLowerCase() + '.' + (el.className || '(无类名)')).join(' ｜ ');
            const where = found
                ? `酒馆消息被画成了：${found.tagName.toLowerCase()}.${found.className || '(无类名)'}，它的上一层是 ${found.parentElement ? found.parentElement.tagName.toLowerCase() + '.' + (found.parentElement.className || '(无类名)') + (found.parentElement === area ? '（就是聊天区）' : '（不是聊天区）') : '没有'}`
                : '聊天区里找不到任何一条酒馆消息的元素';
            fail(`整组折叠找不到酒馆剧情卡片。聊天里有 ${floorMsgs.length} 条酒馆消息。${where}。聊天区前几个元素：${kids}`);
        } catch (e) { /* 勘查失败就算了 */ }
    }

    function startTavernGrouping() {
        const area = document.getElementById('message-area');
        if (!area) return fail('找不到聊天消息区 #message-area，酒馆剧情不会整组折叠');
        groupObserver = new MutationObserver((records) => {
            // 只是我们自己插入/删除组头组尾引起的变化 → 不理会，否则会“分组 → 触发 → 再分组”无限循环
            const ours = (n) => n.nodeType === 1 && n.classList.contains('tavern-group-bar');
            if (records.every(r => [...r.addedNodes, ...r.removedNodes].every(ours))) return;
            if (regroupScheduled) return;
            regroupScheduled = true;
            // 等 yuan 这一轮把消息都画完再分组
            Promise.resolve().then(() => { regroupScheduled = false; regroupTavernFloors(); });
        });
        groupObserver.observe(area, { childList: true });
        regroupTavernFloors();
    }

    // ========== 8. 发给 AI 前处理酒馆楼层 ==========
    // yuan 发消息、写日记、更新记忆表格前，都会用 filterHistoryForAI(聊天, 消息列表) 整理聊天记录。
    // 在它外面套一层：整理完之后，把酒馆楼层换成“包裹后的原文”或“柏宝书摘要”（规则见 TavernSync.prepareHistoryForAI）。
    function hookHistoryFilter() {
        if (typeof window.filterHistoryForAI !== 'function') {
            return fail('找不到 yuan 整理聊天记录的函数 filterHistoryForAI，酒馆楼层会以未处理的原文发给 AI');
        }
        const originalFilter = window.filterHistoryForAI;
        window.filterHistoryForAI = function (chat) {
            // 打开了“单独限制酒馆上文”：先按“最新 N 楼酒馆 + 其余名额给小手机消息”重新挑一遍上文
            let args = arguments;
            if (window.TavernSync) {
                try {
                    const picked = window.TavernSync.limitTavernContext(chat, arguments[1], arguments[2]);
                    if (picked) { args = Array.prototype.slice.call(arguments); args[1] = picked; }
                } catch (e) { fail('按酒馆上文条数挑选消息出错：' + e.message); }
            }
            const result = originalFilter.apply(this, args);
            if (!window.TavernSync) return result;
            try { return window.TavernSync.prepareHistoryForAI(chat, result); }
            catch (e) { fail('处理酒馆楼层出错：' + e.message); return result; }
        };
    }

    // ========== 9. 让“酒馆互联”的设置能保存 ==========
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
        hookRegenerate();
        hookAiReply();
        startChatWatcher();
        hookBubbleRender();
        hookHistoryFilter();
        startTavernGrouping();
    });
})();

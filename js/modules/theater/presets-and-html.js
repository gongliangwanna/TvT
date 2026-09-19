async function saveTheaterPromptPreset() {
    const promptInput = document.getElementById('theater-custom-prompt');
    const presetSelect = document.getElementById('theater-prompt-preset-select');
    if (!promptInput || !presetSelect) return;

    const content = promptInput.value.trim();
    if (!content) {
        showToast('提示词内容不能为空');
        return;
    }

    const name = prompt('请输入预设名称：');
    if (!name) return;

    // 让用户选择保存范围：
    // 确定：同时保存当前选择的人设、角色、世界书
    // 取消：仅保存剧情提示词
    const saveFullContext = confirm(
        '请选择保存范围：\n\n' +
        '【确定】同时保存：人设 + 角色 + 世界书 + 剧情提示词\n' +
        '【取消】只保存：剧情提示词'
    );

    const personaSelect = document.getElementById('theater-persona-select');
    const charOptions = document.getElementById('theater-char-options');
    const worldbookOptions = document.getElementById('theater-worldbook-options');

    const presets = getTheaterPromptPresets();
    const id = Date.now().toString();
    let newPreset = { id, name, content };

    if (saveFullContext) {
        // 收集当前人设、角色、世界书选择，一并写入预设
        const personaId = personaSelect ? (personaSelect.value || '').trim() || null : null;
        
        // 获取选中的多个角色ID
        let charIds = [];
        if (charOptions) {
            const selectedOptions = charOptions.querySelectorAll('.theater-multiselect-option.selected');
            charIds = Array.from(selectedOptions).map(opt => opt.dataset.id).filter(Boolean);
        }
        // 为了向后兼容，单个角色保存为字符串，多个角色保存为数组
        const charId = charIds.length === 1 ? charIds[0] : (charIds.length > 1 ? charIds : null);

        let worldBookIds = [];
        if (worldbookOptions) {
            worldBookIds = Array.from(
                worldbookOptions.querySelectorAll('.theater-multiselect-option.selected')
            )
                .map(opt => opt.dataset.id)
                .filter(Boolean);
        }

        newPreset = {
            ...newPreset,
            type: 'full',           // 带上下文的预设
            personaId,
            charId,
            worldBookIds
        };
    } else {
        // 仅保存提示词内容
        newPreset = {
            ...newPreset,
            type: 'prompt-only'
        };
    }

    presets.push(newPreset);
    setTheaterPromptPresets(presets);

    await saveData();
    showToast(saveFullContext ? '已保存为完整预设（含人设/角色/世界书）' : '已保存为提示词预设');
    populateTheaterForm();

    presetSelect.value = id;
}

// 应用提示词预设（模式隔离）
function applyTheaterPromptPreset() {
    const presetSelect = document.getElementById('theater-prompt-preset-select');
    const promptInput = document.getElementById('theater-custom-prompt');
    const personaSelect = document.getElementById('theater-persona-select');
    const charOptions = document.getElementById('theater-char-options');
    const worldbookOptions = document.getElementById('theater-worldbook-options');
    if (!presetSelect || !promptInput) return;

    const presetId = presetSelect.value;
    const presets = getTheaterPromptPresets();
    if (!presetId || !presets) return;

    const preset = presets.find(p => (p.id || p.name) === presetId);
    if (!preset) return;

    promptInput.value = preset.content || '';

    // 如果该预设包含人设/角色/世界书信息，则一并恢复
    if (personaSelect && preset.personaId) {
        personaSelect.value = preset.personaId;
    }

    // 恢复角色选择（支持向后兼容：字符串或数组）
    if (charOptions && preset.charId) {
        // 先清空当前选择
        Array.from(charOptions.querySelectorAll('.theater-multiselect-option.selected'))
            .forEach(opt => opt.classList.remove('selected'));
        
        // 处理 charId：可能是字符串（单个角色）或数组（多个角色）
        const charIds = Array.isArray(preset.charId) ? preset.charId : [preset.charId];
        const idSet = new Set(charIds.filter(Boolean));
        Array.from(charOptions.querySelectorAll('.theater-multiselect-option'))
            .forEach(opt => {
                const cid = opt.dataset.id;
                if (cid && idSet.has(cid)) {
                    opt.classList.add('selected');
                }
            });
        updateCharDisplay();
    }

    if (worldbookOptions) {
        // 先清空当前选择
        Array.from(worldbookOptions.querySelectorAll('.theater-multiselect-option.selected'))
            .forEach(opt => opt.classList.remove('selected'));

        if (Array.isArray(preset.worldBookIds) && preset.worldBookIds.length > 0) {
            const idSet = new Set(preset.worldBookIds);
            Array.from(worldbookOptions.querySelectorAll('.theater-multiselect-option'))
                .forEach(opt => {
                    const wid = opt.dataset.id;
                    if (wid && idSet.has(wid)) {
                        opt.classList.add('selected');
                    }
                });
        }

        // 更新世界书展示文案
        updateWorldbookDisplay();
    }
}

// 管理提示词预设（支持单选/多选删除）
async function openTheaterPromptPresetManager() {
    // 创建或获取管理模态框
    let modal = document.getElementById('theater-preset-manager-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'theater-preset-manager-modal';
        modal.className = 'theater-preset-manager-modal';
        modal.innerHTML = `
            <div class="theater-preset-manager-dialog">
                <div class="theater-preset-manager-header">
                    <h3>管理提示词预设</h3>
                    <button class="theater-preset-manager-close" id="theater-preset-manager-close">×</button>
                </div>
                <div class="theater-preset-manager-body">
                    <div class="theater-preset-manager-toolbar">
                        <button id="theater-preset-select-all" class="theater-preset-toolbar-btn">全选/全不选</button>
                        <button id="theater-preset-delete-selected" class="theater-preset-toolbar-btn danger">删除选中</button>
                    </div>
                    <div id="theater-preset-manager-list" class="theater-preset-manager-list"></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const listEl = modal.querySelector('#theater-preset-manager-list');
    const closeBtn = modal.querySelector('#theater-preset-manager-close');
    const selectAllBtn = modal.querySelector('#theater-preset-select-all');
    const deleteSelectedBtn = modal.querySelector('#theater-preset-delete-selected');
    if (!listEl || !closeBtn || !selectAllBtn || !deleteSelectedBtn) return;

    const renderList = () => {
        const presets = getTheaterPromptPresets();
        if (!presets.length) {
            listEl.innerHTML = '<div class="theater-preset-manager-empty">暂无提示词预设</div>';
            return;
        }

        listEl.innerHTML = '';
        presets.forEach(preset => {
            const item = document.createElement('div');
            item.className = 'theater-preset-manager-item';

            const previewContent = (preset.content || '').length > 40
                ? (preset.content || '').slice(0, 40) + '...'
                : (preset.content || '');

            item.innerHTML = `
                <label class="theater-preset-manager-checkbox-wrap">
                    <input type="checkbox" class="theater-preset-manager-checkbox" data-id="${preset.id}">
                    <span class="theater-preset-manager-checkbox-mark"></span>
                </label>
                <div class="theater-preset-manager-item-main">
                    <div class="theater-preset-manager-item-name">${DOMPurify.sanitize(preset.name || '')}</div>
                    <div class="theater-preset-manager-item-preview">${DOMPurify.sanitize(previewContent)}</div>
                </div>
                <button class="theater-preset-manager-delete-btn" data-id="${preset.id}">删除</button>
            `;
            listEl.appendChild(item);
        });

        // 绑定删除按钮事件
        const deleteButtons = listEl.querySelectorAll('.theater-preset-manager-delete-btn');
        deleteButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-id');
                if (!id) return;
                if (!confirm('确定删除该预设吗？')) return;

                const presets = getTheaterPromptPresets();
                const index = presets.findIndex(p => p.id === id);
                if (index === -1) return;

                presets.splice(index, 1);
                setTheaterPromptPresets(presets);
                await saveData();
                showToast('已删除预设');
                populateTheaterForm();
                renderList();
            });
        });
    };

    renderList();

    // 关闭事件
    closeBtn.onclick = () => {
        modal.classList.remove('visible');
    };
    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.classList.remove('visible');
        }
    };

    // 全选 / 全不选
    selectAllBtn.onclick = () => {
        const checkboxes = listEl.querySelectorAll('.theater-preset-manager-checkbox');
        if (!checkboxes.length) return;
        const hasUnchecked = Array.from(checkboxes).some(cb => !cb.checked);
        checkboxes.forEach(cb => {
            cb.checked = hasUnchecked;
        });
    };

    // 删除选中的预设（多选删除）
    deleteSelectedBtn.onclick = async () => {
        const checkboxes = Array.from(listEl.querySelectorAll('.theater-preset-manager-checkbox')).filter(cb => cb.checked);
        if (!checkboxes.length) {
            showToast('请先选择要删除的预设');
            return;
        }
        const ids = checkboxes.map(cb => cb.getAttribute('data-id')).filter(Boolean);
        if (!ids.length) return;
        if (!confirm(`确定删除选中的 ${ids.length} 个预设吗？`)) return;

        setTheaterPromptPresets(getTheaterPromptPresets().filter(p => !ids.includes(p.id)));
        await saveData();
        showToast('已删除选中预设');
        populateTheaterForm();
        renderList();
    };

    modal.classList.add('visible');
}

// ===================== 模式切换 =====================

/** 切换小剧场模式 */
function switchTheaterMode(mode) {
    if (mode === theaterCurrentMode) return;
    theaterCurrentMode = mode;

    // 持久化当前模式
    db.theaterMode = mode;
    saveData();

    // 更新开关 UI
    const modeSwitch = document.getElementById('theater-mode-switch');
    if (modeSwitch) {
        modeSwitch.setAttribute('data-mode', mode);
        modeSwitch.querySelectorAll('.theater-mode-option').forEach(opt => {
            opt.classList.toggle('active', opt.dataset.mode === mode);
        });
    }

    // 切换两个独立的主内容区
    const textMain = document.getElementById('theater-text-main');
    const htmlMain = document.getElementById('theater-html-main');
    if (textMain) textMain.style.display = (mode === 'text') ? '' : 'none';
    if (htmlMain) htmlMain.style.display = (mode === 'html') ? '' : 'none';

    // 退出多选状态
    exitTheaterMultiSelectMode();

    // 重新渲染当前模式列表
    renderTheaterScenarios();

    // 系统提示
    showToast(mode === 'html' ? '已切换至 HTML 模式' : '已切换至纯文字模式');
}

// ===================== HTML 模式详情页 =====================

/** HTML 模式：显示详情页（独立 DOM） */
function showTheaterHtmlScenarioDetail(scenario) {
    currentTheaterScenarioId = scenario.id;
    const detailContent = document.getElementById('theater-html-detail-content');
    if (!detailContent) return;

    // 获取角色信息（支持向后兼容：字符串或数组）
    let charName = '未指定';
    let charPersona = '';
    let charNames = [];
    if (scenario.charId) {
        const charIds = Array.isArray(scenario.charId) ? scenario.charId : [scenario.charId];
        const chars = charIds.map(id => db.characters.find(c => c.id === id)).filter(Boolean);
        if (chars.length > 0) {
            charNames = chars.map(char => char.realName || char.remarkName || '未知角色');
            charName = charNames.join('、'); // 多个角色用顿号连接
            charPersona = chars[0].persona || ''; // 使用第一个角色的人设
        }
    }

    let personaName = '';
    let personaContent = '';
    if (scenario.personaId) {
        const persona = db.myPersonaPresets.find(p => (p.id || p.name) === scenario.personaId);
        if (persona) {
            personaName = persona.name || '';
            personaContent = persona.content || '';
        }
    }

    const category = scenario.category || '未分类';
    const date = new Date(scenario.createdAt || scenario.timestamp || Date.now());
    const dateStr = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });

    const isEditing = scenario.isEditing || scenario.isEditingTitle || false;

    // HTML 模式：正文直接渲染 HTML（使用 DOMPurify 净化）
    let displayContent = scenario.content || '';
    if (!isEditing && typeof displayContent === 'string') {
        const userName = personaName || '我';
        if (userName) {
            displayContent = displayContent.replace(/\{\{\s*(user|User|USER|user_name)\s*\}\}/g, userName);
        }
        // 如果有多个角色，{{char_name}} 使用第一个角色的名字
        if (charNames.length > 0) {
            const firstCharName = charNames[0];
            displayContent = displayContent.replace(/\{\{\s*(char|Char|CHAR|char_name)\s*\}\}/g, firstCharName);
        }
    }

    // HTML 模式渲染：使用 iframe(srcdoc) 隔离 CSS，避免被全局样式影响；同时保持纯 HTML+CSS 交互可用
    // 重要：不再使用 DOMPurify 对 iframe 内容做二次清洗！
    // 原因：DOMPurify 会删掉 <dl>/<dt>/<dd>/<nav> 等非白名单标签、@import、CSS 变量等，
    //       导致渲染全部崩坏。iframe sandbox="allow-forms" 已提供足够安全隔离：
    //       - 禁止 JavaScript 执行（无 allow-scripts）
    //       - 禁止访问父文档（无 allow-same-origin）
    //       - 仅允许表单元素交互（checkbox/radio 切换状态）
    let htmlForIframe = String(displayContent || '');

    const contentDisplay = isEditing
        // 注意：这里不能用 DOMPurify.sanitize()，否则会把 <style>/<input>/<label> 等交互结构“编辑时”清掉
        ? `<textarea id="theater-html-edit-content" class="theater-edit-textarea" style="min-height:300px;">${theaterEscapeHtml(scenario.content || '')}</textarea>`
        : `<div class="theater-html-detail-body">
                <iframe id="theater-html-render-frame" class="theater-html-render-frame" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe>
           </div>`;

    let metaInfo = `<span class="theater-detail-badge" style="background: rgba(100,181,246,0.2); color: #1976d2;">HTML</span>`;
    metaInfo += `<span class="theater-detail-badge">${DOMPurify.sanitize(category)}</span>`;
    if (charName !== '未指定') {
        metaInfo += `<span>角色：${DOMPurify.sanitize(charName)}</span>`;
    }
    if (personaName) {
        metaInfo += `<span>人设：${DOMPurify.sanitize(personaName)}</span>`;
    }
    metaInfo += `<span>${dateStr}</span>`;

    detailContent.innerHTML = `
        <div class="theater-detail-header">
            <h2 class="theater-detail-title" style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px;">
                ${scenario.isFavorite ? '<span class="theater-favorite-icon" style="color: #ffd700; margin-right: 5px;">★</span>' : ''}
                ${scenario.charGenerated ? '<span title="由角色主动创作">❤️</span>' : ''}
                ${scenario.isEditingTitle || (isEditing && !scenario.isEditing)
                    ? `<input type="text" id="theater-html-edit-title" class="theater-edit-title-input" value="${DOMPurify.sanitize(scenario.title || 'HTML 剧情')}">`
                    : `<span class="theater-detail-title-text">${DOMPurify.sanitize(scenario.title || 'HTML 剧情')}</span>${!isEditing ? '<button class="theater-edit-title-btn" id="theater-html-edit-title-btn">编辑标题</button>' : ''}`
                }
            </h2>
            <div class="theater-detail-meta">
                ${metaInfo}
            </div>
        </div>
        ${contentDisplay}
    `;

    // 注入 iframe 内容（用完整 HTML 文档包装，保证 charset / 默认样式 / 解析行为一致）
    if (!isEditing) {
        const frame = document.getElementById('theater-html-render-frame');
        if (frame) {
            // 自动测高脚本：iframe 加载后把实际内容高度 postMessage 给父页面，父页面据此撑开 iframe
            const autoHeightScript = `<script>
(function(){
  function report(){
    var h = Math.max(document.body.scrollHeight, document.body.offsetHeight, document.documentElement.scrollHeight);
    parent.postMessage({type:'theater-iframe-height', height: h}, '*');
  }
  // 首次 + 图片/字体加载后再测一次
  window.addEventListener('load', function(){ setTimeout(report, 100); });
  document.addEventListener('DOMContentLoaded', report);
  // 持续观察 DOM 变化（如 details 展开）
  if(window.MutationObserver){
    new MutationObserver(function(){ setTimeout(report, 50); }).observe(document.documentElement, {childList:true, subtree:true, attributes:true});
  }
  // checkbox/radio 切换后也重新测高
  document.addEventListener('change', function(){ setTimeout(report, 50); });
})();
<\/script>`;

            // 检查内容中是否已包含 <body> 标签；如果已有则直接用，否则包一层
            const hasBodyTag = /<body[\s>]/i.test(htmlForIframe);
            const bodyStyle = `margin:0;padding:12px;box-sizing:border-box;`;
            const wrapped = hasBodyTag
                ? `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>${htmlForIframe}${autoHeightScript}</html>`
                : `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="${bodyStyle}">
${htmlForIframe || ''}
${autoHeightScript}
</body>
</html>`;
            frame.srcdoc = wrapped;

            if (!htmlForIframe || !String(htmlForIframe).trim()) {
                showToast('HTML 内容为空：请确认输出包含完整 <style> 与结构');
            }
        }
    }

    // 更新按钮显示状态
    const favoriteBtn = document.getElementById('theater-html-favorite-btn');
    const saveEditBtn = document.getElementById('theater-html-save-edit-btn');
    const shareBtn = document.getElementById('theater-html-share-btn');
    const editCategoryBtn = document.getElementById('theater-html-edit-category-btn');
    const deleteBtn = document.getElementById('theater-html-delete-btn');
    const exportBtn = document.getElementById('theater-html-export-btn');

    if (favoriteBtn) favoriteBtn.textContent = scenario.isFavorite ? '取消收藏' : '收藏';
    if (saveEditBtn) saveEditBtn.style.display = isEditing ? 'block' : 'none';
    if (shareBtn) shareBtn.style.display = isEditing ? 'none' : 'block';
    if (editCategoryBtn) editCategoryBtn.style.display = isEditing ? 'none' : 'block';
    if (deleteBtn) deleteBtn.style.display = isEditing ? 'none' : 'block';
    if (exportBtn) exportBtn.style.display = isEditing ? 'none' : 'block';

    scenario.isEditing = isEditing;

    // 绑定编辑标题按钮
    const editTitleBtn = document.getElementById('theater-html-edit-title-btn');
    if (editTitleBtn && !isEditing) {
        editTitleBtn.addEventListener('click', () => {
            const s = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
            if (s) {
                s.isEditingTitle = true;
                showTheaterHtmlScenarioDetail(s);
            }
        });
    }

    if (scenario.isEditingTitle && document.getElementById('theater-html-edit-title')) {
        const titleInput = document.getElementById('theater-html-edit-title');
        setTimeout(() => {
            titleInput.focus();
            titleInput.select();
        }, 100);

        const handleKeyDown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveHtmlEditScenario();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                const s = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
                if (s) {
                    s.isEditingTitle = false;
                    showTheaterHtmlScenarioDetail(s);
                }
            }
        };
        titleInput.addEventListener('keydown', handleKeyDown);
    }

    switchScreen('theater-html-detail-screen');

    // 若从聊天气泡跳转而来，将返回按钮的目标改为聊天界面
    if (window._theaterDetailFromChat) {
        window._theaterDetailFromChat = false;
        const backBtn = document.querySelector('#theater-html-detail-screen .back-btn');
        if (backBtn) backBtn.setAttribute('data-target', 'chat-room-screen');
    } else {
        // 恢复默认
        const backBtn = document.querySelector('#theater-html-detail-screen .back-btn');
        if (backBtn) backBtn.setAttribute('data-target', 'theater-screen');
    }
}

/** HTML 模式：保存编辑 */
async function saveHtmlEditScenario() {
    if (!currentTheaterScenarioId) return;
    const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
    if (!scenario) return;

    const contentInput = document.getElementById('theater-html-edit-content');
    const titleInput = document.getElementById('theater-html-edit-title');
    if (!contentInput) return;

    const newContent = contentInput.value.trim();
    if (!newContent) {
        showToast('内容不能为空');
        return;
    }

    scenario.content = newContent;
    if (titleInput && titleInput.value.trim()) {
        scenario.title = titleInput.value.trim();
    }
    scenario.isEditing = false;
    scenario.isEditingTitle = false;

    await saveData();
    showToast('已保存修改');
    showTheaterHtmlScenarioDetail(scenario);
    renderTheaterScenarios();
}

// ===================== 角色主动生成小剧场 =====================

/**
 * 由角色主动创作小剧场并存入小剧场App（以 charGenerated:true 和 ❤️ 标记）
 * @param {string} charId - 角色ID
 */

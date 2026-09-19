// --- 小剧场功能 (js/modules/theater.js) ---

let currentTheaterScenarioId = null;
/** 列表多选：是否处于多选模式、已选中的 scenario id 集合 */
let theaterMultiSelectMode = false;
let theaterSelectedIds = new Set();

/** 当前小剧场模式：'text'(纯文字，默认) | 'html' */
let theaterCurrentMode = 'text';

/** 用于把 HTML 安全地塞进 textarea / innerHTML（避免标签被当成 DOM 解析） */
function theaterEscapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 获取当前模式的剧情列表 */
function getTheaterScenarios() {
    if (theaterCurrentMode === 'html') {
        if (!db.theaterHtmlScenarios) db.theaterHtmlScenarios = [];
        return db.theaterHtmlScenarios;
    }
    if (!db.theaterScenarios) db.theaterScenarios = [];
    return db.theaterScenarios;
}

/** 设置当前模式的剧情列表 */
function setTheaterScenarios(list) {
    if (theaterCurrentMode === 'html') {
        db.theaterHtmlScenarios = list;
    } else {
        db.theaterScenarios = list;
    }
}

/** 获取当前模式的提示词预设列表 */
function getTheaterPromptPresets() {
    if (theaterCurrentMode === 'html') {
        if (!db.theaterHtmlPromptPresets) db.theaterHtmlPromptPresets = [];
        return db.theaterHtmlPromptPresets;
    }
    if (!db.theaterPromptPresets) db.theaterPromptPresets = [];
    return db.theaterPromptPresets;
}

/** 设置当前模式的提示词预设列表 */
function setTheaterPromptPresets(list) {
    if (theaterCurrentMode === 'html') {
        db.theaterHtmlPromptPresets = list;
    } else {
        db.theaterPromptPresets = list;
    }
}

/**
 * 小剧场生成专用：兼容旧代码期望的 OpenAI ChatCompletions 返回结构。
 * 之前这里调用了未定义的 callChatCompletion，导致 “callChatCompletion is not defined”。
 * 这里复用 utils.js 的 fetchAiResponse() 发请求，然后包装成 {choices:[{message:{content}}]}。
 */
async function callChatCompletion(apiPayload, overrideSettings) {
    // 如果提供了独立API覆盖设置，则优先使用
    let settings;
    if (overrideSettings && overrideSettings.url && overrideSettings.key && overrideSettings.model) {
        settings = {
            url: overrideSettings.url,
            key: overrideSettings.key,
            model: overrideSettings.model,
            provider: 'newapi',  // 独立API默认使用 newapi 兼容模式
            temperature: (db.apiSettings && db.apiSettings.temperature !== undefined) ? db.apiSettings.temperature : 1.0
        };
    } else {
        settings = (typeof db !== 'undefined' && db && db.apiSettings) ? db.apiSettings : null;
        if (!settings) throw new Error('未找到 API 设置(db.apiSettings)');
    }
    if (typeof getApiConfigForFeature === 'function') settings = getApiConfigForFeature('theater', settings);

    let { url, key, model, provider } = settings;
    if (!model) model = apiPayload?.model;

    if (typeof isApiConfigReady === 'function' ? !isApiConfigReady(settings) : (!url || !key || !model)) {
        throw new Error('请先在"api"应用中完成设置（Base URL / Key / Model）');
    }

    const blockedDomains = (typeof BLOCKED_API_DOMAINS !== 'undefined') ? BLOCKED_API_DOMAINS : [];
    if (blockedDomains.some(domain => url.includes(domain))) {
        throw new Error('当前 API 站点已被屏蔽，无法发送请求');
    }

    if (url.endsWith('/')) url = url.slice(0, -1);

    const endpoint = (provider === 'gemini')
        ? `${url}/v1beta/models/${model}:generateContent?key=${getRandomValue(key)}`
        : `${url}/v1/chat/completions`;

    const headers = (provider === 'gemini')
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

    let requestBody;
    if (provider === 'gemini') {
        // Gemini：简单合并 system+user，避免引入额外 schema（system_instruction 等）复杂度
        const prompt = (apiPayload?.messages || [])
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');
        requestBody = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        };
    } else {
        const rawMessages = apiPayload?.messages || [];
        requestBody = {
            model: model,
            messages: normalizeMessagesForProvider(rawMessages, provider),
            stream: false,
            temperature: settings.temperature !== undefined ? settings.temperature : 1.0
        };
    }

    if (typeof fetchAiResponse !== 'function') {
        throw new Error('缺少 fetchAiResponse()：请确认 utils.js 已被正确加载');
    }

    const content = await fetchAiResponse(settings, requestBody, headers, endpoint, false);
    return { choices: [{ message: { content: (content || '').toString() } }] };
}

/** 去掉 AI 开场白，只保留剧本正文 */
function stripTheaterIntro(text) {
    if (!text || typeof text !== 'string') return text;
    let s = text.trim();
    // 去掉开头的「好的，编剧。这是一段根据…」类开场白（含换行）
    const introRe = /^好的[，,]?\s*编剧[。.]?\s*[^\n]*?(根据你提供的提示词|根据提示词|根据设定)[^\n]*(短剧脚本|剧情脚本|脚本)[^\n]*[。.!\s]*\n?/i;
    s = s.replace(introRe, '');
    // 去掉仅由这类说明组成的首行
    const firstLineRe = /^[^\n]*(这是一段|下面是根据|以下是)[^\n]*(根据你提供的提示词|短剧脚本|剧情脚本)[^\n]*[。.!\s]*\n?/im;
    s = s.replace(firstLineRe, '');
    return s.trim();
}

/** 将剧本正文中的 Markdown 转为 HTML（**粗体**、*斜体*、换行），并做安全过滤 */
function renderTheaterMarkdown(text) {
    if (!text || typeof text !== 'string') return '';
    const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    let html = escaped
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');
    if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['strong', 'em', 'b', 'i', 'br'] });
    }
    return html;
}

// 渲染小剧场列表（同时处理纯文字和 HTML 模式）
function renderTheaterScenarios() {
    // 根据当前模式选择正确的 DOM 元素
    const isHtml = theaterCurrentMode === 'html';
    const scenariosList = document.getElementById(isHtml ? 'theater-html-scenarios-list' : 'theater-scenarios-list');
    const categoryFilter = document.getElementById(isHtml ? 'theater-html-category-filter' : 'theater-category-filter');
    if (!scenariosList) return;

    scenariosList.innerHTML = '';

    const allScenarios = getTheaterScenarios();
    if (!allScenarios || allScenarios.length === 0) {
        scenariosList.innerHTML = isHtml
            ? '<div class="theater-empty-state">还没有生成的 HTML 剧情，点击右上角"+"创建吧~</div>'
            : '<div class="theater-empty-state">还没有生成的剧情，点击右上角"+"创建吧~</div>';
        return;
    }

    // 获取所有分类
    const categories = [...new Set(allScenarios.map(s => s.category || '未分类'))];
    const currentSelectedCategory = categoryFilter ? categoryFilter.value : '';
    
    if (categoryFilter) {
        categoryFilter.innerHTML = '<option value="">全部分类</option>';
        categories.forEach(cat => {
            const option = document.createElement('option');
            option.value = cat;
            option.textContent = cat;
            if (cat === currentSelectedCategory) {
                option.selected = true;
            }
            categoryFilter.appendChild(option);
        });
    }

    // 过滤场景
    const selectedCategory = categoryFilter ? categoryFilter.value : '';
    let filteredScenarios = allScenarios;
    if (selectedCategory) {
        filteredScenarios = allScenarios.filter(s => (s.category || '未分类') === selectedCategory);
    }

    if (filteredScenarios.length === 0) {
        scenariosList.innerHTML = '<div class="theater-empty-state">该分类下暂无剧情</div>';
        updateTheaterMultiSelectBar();
        return;
    }

    // 按收藏状态和创建时间排序（收藏的置顶）
    filteredScenarios.sort((a, b) => {
        const aFav = a.isFavorite ? 1 : 0;
        const bFav = b.isFavorite ? 1 : 0;
        if (aFav !== bFav) {
            return bFav - aFav; // 收藏的在前
        }
        return (b.createdAt || 0) - (a.createdAt || 0); // 同收藏状态下按时间倒序
    });

    const isMultiSelect = theaterMultiSelectMode;

    filteredScenarios.forEach(scenario => {
        const card = document.createElement('div');
        card.className = 'theater-scenario-card' + (isMultiSelect ? ' selectable' : '');
        card.dataset.id = scenario.id;

        const date = new Date(scenario.createdAt || scenario.timestamp || Date.now());
        const dateStr = date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        // 获取角色名（支持向后兼容：字符串或数组）
        let charName = '未指定';
        if (scenario.charId) {
            const charIds = Array.isArray(scenario.charId) ? scenario.charId : [scenario.charId];
            const chars = charIds.map(id => db.characters.find(c => c.id === id)).filter(Boolean);
            if (chars.length > 0) {
                const charNames = chars.map(char => char.realName || char.remarkName || '未知角色');
                charName = charNames.join('、'); // 多个角色用顿号连接
            }
        }
        const category = scenario.category || '未分类';
        const checked = theaterSelectedIds.has(scenario.id);

        // HTML 模式下：在卡片底部添加 iframe 缩略预览
        const htmlPreviewHtml = (isHtml && scenario.content)
            ? `<div class="theater-scenario-html-preview">
                    <iframe class="theater-scenario-preview-frame" data-scenario-id="${scenario.id}" sandbox="allow-forms" referrerpolicy="no-referrer" scrolling="no" tabindex="-1"></iframe>
               </div>`
            : '';

        const cardBody = `
            <div class="theater-scenario-header">
                <div class="theater-scenario-title">
                    ${scenario.isFavorite ? '<span class="theater-favorite-icon" style="color: #ffd700; margin-right: 5px;">★</span>' : ''}
                    ${scenario.charGenerated ? '<span class="theater-char-generated-icon" title="由角色主动创作" style="margin-right: 4px;">❤️</span>' : ''}
                    ${DOMPurify.sanitize(scenario.title || '剧情')}
                </div>
                <div class="theater-scenario-badge">${DOMPurify.sanitize(category)}</div>
            </div>
            <div class="theater-scenario-meta">
                <span>角色：${DOMPurify.sanitize(charName)}</span>
                <span>${dateStr}</span>
            </div>
            ${isHtml ? htmlPreviewHtml : `<div class="theater-scenario-content">${DOMPurify.sanitize(scenario.content)}</div>`}
        `;

        if (isMultiSelect) {
            card.innerHTML = `
                <div class="theater-card-checkbox ${checked ? 'checked' : ''}" role="button" tabindex="0" aria-label="选择"></div>
                <div class="theater-card-content-wrap">${cardBody}</div>
            `;
        } else {
            card.innerHTML = cardBody;
        }

        card.addEventListener('click', (e) => {
            if (isMultiSelect) {
                e.preventDefault();
                e.stopPropagation();
                toggleTheaterSelection(scenario.id);
                return;
            }
            if (theaterCurrentMode === 'html') {
                showTheaterHtmlScenarioDetail(scenario);
            } else {
                showTheaterScenarioDetail(scenario);
            }
        });

        if (isMultiSelect) {
            const checkbox = card.querySelector('.theater-card-checkbox');
            if (checkbox) {
                checkbox.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleTheaterSelection(scenario.id);
                });
            }
        }

        scenariosList.appendChild(card);

        // HTML 模式：为预览 iframe 注入内容
        if (isHtml && scenario.content) {
            const previewFrame = card.querySelector('.theater-scenario-preview-frame');
            if (previewFrame) {
                const htmlContent = String(scenario.content || '');
                const hasBodyTag = /<body[\s>]/i.test(htmlContent);
                const wrapped = hasBodyTag
                    ? `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{pointer-events:none;overflow:hidden;}</style></head>${htmlContent}</html>`
                    : `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{pointer-events:none;overflow:hidden;}</style></head><body style="margin:0;padding:8px;box-sizing:border-box;">${htmlContent}</body></html>`;
                previewFrame.srcdoc = wrapped;
            }
        }
    });

    updateTheaterMultiSelectBar();
}

function updateTheaterMultiSelectBar() {
    const bar = document.getElementById('theater-multi-select-bar');
    const countEl = document.getElementById('theater-selected-count');
    const deleteBtn = document.getElementById('theater-delete-selected-btn');
    if (countEl) countEl.textContent = '已选 ' + theaterSelectedIds.size + ' 项';
    if (deleteBtn) deleteBtn.disabled = theaterSelectedIds.size === 0;
    if (bar) bar.classList.toggle('visible', theaterMultiSelectMode);
}

function toggleTheaterSelection(id) {
    if (theaterSelectedIds.has(id)) {
        theaterSelectedIds.delete(id);
    } else {
        theaterSelectedIds.add(id);
    }
    updateTheaterMultiSelectBar();
    // 只更新当前列表中的勾选状态，避免整表重绘
    const listId = theaterCurrentMode === 'html' ? 'theater-html-scenarios-list' : 'theater-scenarios-list';
    const card = document.querySelector(`#${listId} .theater-scenario-card[data-id="${id}"]`);
    const checkbox = card && card.querySelector('.theater-card-checkbox');
    if (checkbox) checkbox.classList.toggle('checked', theaterSelectedIds.has(id));
}

function exitTheaterMultiSelectMode() {
    theaterMultiSelectMode = false;
    theaterSelectedIds.clear();
    updateTheaterMultiSelectBar();
    renderTheaterScenarios();
}

function theaterSelectAll() {
    const filterId = theaterCurrentMode === 'html' ? 'theater-html-category-filter' : 'theater-category-filter';
    const categoryFilter = document.getElementById(filterId);
    const selectedCategory = categoryFilter ? categoryFilter.value : '';
    let list = getTheaterScenarios();
    if (selectedCategory) {
        list = list.filter(s => (s.category || '未分类') === selectedCategory);
    }
    list.forEach(s => { theaterSelectedIds.add(s.id); });
    updateTheaterMultiSelectBar();
    renderTheaterScenarios();
}

function theaterDeleteSelected() {
    if (theaterSelectedIds.size === 0) return;
    if (!confirm('确定删除选中的 ' + theaterSelectedIds.size + ' 个剧情吗？')) return;
    setTheaterScenarios(getTheaterScenarios().filter(s => !theaterSelectedIds.has(s.id)));
    saveData().then(() => {
        showToast('已删除选中剧情');
        exitTheaterMultiSelectMode();
    }).catch(() => showToast('删除失败'));
}

// 显示详情页
function showTheaterScenarioDetail(scenario) {
    currentTheaterScenarioId = scenario.id;
    const detailContent = document.getElementById('theater-detail-content');
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
    
    // 获取人设信息
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

    // 正文占位符替换：使用用户/角色名字替换 {{user}} / {{char}} 等
    let displayContent = scenario.content || '';
    if (!isEditing && typeof displayContent === 'string') {
        // 用户名优先使用人设名称，其次退回“我”
        const userName = personaName || '我';
        if (userName) {
            displayContent = displayContent
                // {{user}} / {{User}} / {{USER}} / {{user_name}}
                .replace(/\{\{\s*(user|User|USER|user_name)\s*\}\}/g, userName);
        }
        // 如果有多个角色，{{char_name}} 使用第一个角色的名字
        if (charNames.length > 0) {
            const firstCharName = charNames[0];
            displayContent = displayContent
                // {{char}} / {{Char}} / {{CHAR}} / {{char_name}}
                .replace(/\{\{\s*(char|Char|CHAR|char_name)\s*\}\}/g, firstCharName);
        }
    }

    // 获取字号设置，默认15px
    const fontSize = (db.theaterFontSize !== undefined) ? db.theaterFontSize : 15;
    // 获取字体预设设置
    const fontPresetName = db.theaterFontPreset || null;
    
    const contentDisplay = isEditing 
        ? `<textarea id="theater-edit-content" class="theater-edit-textarea">${DOMPurify.sanitize(scenario.content)}</textarea>
           <div class="theater-edit-controls" style="margin-top: 15px; padding: 15px; background: rgba(255, 255, 255, 0.9); border-radius: 12px; border: 0.5px solid rgba(0, 0, 0, 0.06);">
               <div class="theater-action-row-font-size">
                   <label class="theater-font-size-label">字号：</label>
                   <input type="range" id="theater-edit-font-size-slider" class="theater-font-size-slider" min="10" max="24" value="${fontSize}" step="1">
                   <span id="theater-edit-font-size-value" class="theater-font-size-value">${fontSize}px</span>
                   <button id="theater-edit-save-font-size-btn" class="theater-action-btn theater-save-font-size-btn">保存字号</button>
               </div>
               <div class="theater-action-row-font-preset" style="margin-top: 12px;">
                   <label class="theater-font-size-label">字体预设：</label>
                   <select id="theater-edit-font-preset-select" class="theater-font-preset-select">
                       <option value="">— 选择字体预设 —</option>
                   </select>
                   <button id="theater-edit-apply-font-preset-btn" class="theater-action-btn theater-save-font-size-btn">应用字体</button>
               </div>
           </div>`
        : `<div class="theater-detail-body" style="font-size: ${fontSize}px;" id="theater-detail-body-content">${renderTheaterMarkdown(displayContent)}</div>`;
    
    // 构建元信息显示
    let metaInfo = `<span class="theater-detail-badge">${DOMPurify.sanitize(category)}</span>`;
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
                    ? `<input type="text" id="theater-edit-title" class="theater-edit-title-input" value="${DOMPurify.sanitize(scenario.title || '剧情')}">`
                    : `<span class="theater-detail-title-text">${DOMPurify.sanitize(scenario.title || '剧情')}</span>${!isEditing ? '<button class="theater-edit-title-btn" id="theater-edit-title-btn">编辑标题</button>' : ''}`
                }
            </h2>
            <div class="theater-detail-meta">
                ${metaInfo}
            </div>
        </div>
        ${contentDisplay}
    `;
    
    // 更新按钮显示状态
    const favoriteBtn = document.getElementById('theater-favorite-btn');
    const saveEditBtn = document.getElementById('theater-save-edit-btn');
    const shareBtn = document.getElementById('theater-share-btn');
    const editCategoryBtn = document.getElementById('theater-edit-category-btn');
    const deleteBtn = document.getElementById('theater-delete-btn');
    const exportBtn = document.getElementById('theater-export-btn');
    
    if (favoriteBtn) {
        favoriteBtn.textContent = scenario.isFavorite ? '取消收藏' : '收藏';
    }
    if (saveEditBtn) {
        saveEditBtn.style.display = isEditing ? 'block' : 'none';
    }
    if (shareBtn) {
        shareBtn.style.display = isEditing ? 'none' : 'block';
    }
    if (editCategoryBtn) {
        editCategoryBtn.style.display = isEditing ? 'none' : 'block';
    }
    if (deleteBtn) {
        deleteBtn.style.display = isEditing ? 'none' : 'block';
    }
    if (exportBtn) {
        exportBtn.style.display = isEditing ? 'none' : 'block';
    }
    
    // 保存编辑状态到scenario对象
    scenario.isEditing = isEditing;
    
    // 应用字体预设到详情页内容（非编辑状态）
    if (!isEditing && fontPresetName) {
        const presets = (typeof _getFontPresets === 'function') ? _getFontPresets() : (db.fontPresets || []);
        const preset = presets.find(p => p.name === fontPresetName);
        if (preset) {
            setTimeout(() => {
                const detailBody = document.getElementById('theater-detail-body-content');
                if (detailBody) {
                    applyTheaterFontPresetToElement(detailBody, preset);
                }
            }, 100);
        }
    }
    
    // 如果是编辑状态，初始化编辑区域的字号和字体预设控件
    if (isEditing) {
        // 初始化字号滑块（编辑模式）
        const editFontSizeSlider = document.getElementById('theater-edit-font-size-slider');
        const editFontSizeValue = document.getElementById('theater-edit-font-size-value');
        if (editFontSizeSlider && editFontSizeValue) {
            editFontSizeSlider.value = fontSize;
            editFontSizeValue.textContent = fontSize + 'px';
            
            // 监听滑块变化
            editFontSizeSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value, 10);
                editFontSizeValue.textContent = value + 'px';
                // 实时应用到编辑框
                const textarea = document.getElementById('theater-edit-content');
                if (textarea) {
                    textarea.style.fontSize = value + 'px';
                }
            });
        }
        
        // 初始化字体预设选择器（编辑模式）
        const editFontPresetSelect = document.getElementById('theater-edit-font-preset-select');
        if (editFontPresetSelect) {
            const presets = (typeof _getFontPresets === 'function') ? _getFontPresets() : (db.fontPresets || []);
            editFontPresetSelect.innerHTML = '<option value="">— 选择字体预设 —</option>';
            presets.forEach(preset => {
                const option = document.createElement('option');
                option.value = preset.name;
                option.textContent = preset.name;
                if (fontPresetName && preset.name === fontPresetName) {
                    option.selected = true;
                }
                editFontPresetSelect.appendChild(option);
            });
            
            // 如果已有保存的字体预设，应用到编辑框
            if (fontPresetName) {
                const preset = presets.find(p => p.name === fontPresetName);
                if (preset) {
                    const textarea = document.getElementById('theater-edit-content');
                    if (textarea) {
                        applyTheaterFontPresetToElement(textarea, preset);
                    }
                }
            }
        }
        
        // 绑定应用字体预设按钮（编辑模式）
        const editApplyFontPresetBtn = document.getElementById('theater-edit-apply-font-preset-btn');
        if (editApplyFontPresetBtn) {
            editApplyFontPresetBtn.addEventListener('click', async () => {
                const select = document.getElementById('theater-edit-font-preset-select');
                if (!select || !select.value) {
                    showToast('请选择一个字体预设');
                    return;
                }
                const presetName = select.value;
                const presets = (typeof _getFontPresets === 'function') ? _getFontPresets() : (db.fontPresets || []);
                const preset = presets.find(p => p.name === presetName);
                if (!preset) {
                    showToast('未找到该字体预设');
                    return;
                }
                
                // 保存字体预设到数据库
                db.theaterFontPreset = presetName;
                await saveData();
                
                // 应用到当前编辑框
                const textarea = document.getElementById('theater-edit-content');
                if (textarea) {
                    applyTheaterFontPresetToElement(textarea, preset);
                }
                
                showToast(`字体预设「${presetName}」已保存并应用到全部纯文字小剧场`);
            });
        }
        
        // 绑定保存字号按钮（编辑模式）
        const editSaveFontSizeBtn = document.getElementById('theater-edit-save-font-size-btn');
        if (editSaveFontSizeBtn) {
            editSaveFontSizeBtn.addEventListener('click', async () => {
                const slider = document.getElementById('theater-edit-font-size-slider');
                if (!slider) return;
                const fontSize = parseInt(slider.value, 10);
                if (isNaN(fontSize) || fontSize < 10 || fontSize > 24) {
                    showToast('字号必须在10-24之间');
                    return;
                }
                db.theaterFontSize = fontSize;
                await saveData();
                showToast('字号已保存并应用到全部小剧场');
            });
        }
    }
    
    // 绑定编辑标题按钮
    const editTitleBtn = document.getElementById('theater-edit-title-btn');
    if (editTitleBtn && !isEditing) {
        editTitleBtn.addEventListener('click', () => {
            const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
            if (scenario) {
                scenario.isEditingTitle = true;
                showTheaterScenarioDetail(scenario);
            }
        });
    }
    
    // 如果正在编辑标题，自动聚焦输入框
    if (scenario.isEditingTitle && document.getElementById('theater-edit-title')) {
        const titleInput = document.getElementById('theater-edit-title');
        setTimeout(() => {
            titleInput.focus();
            titleInput.select();
        }, 100);
        
        // 监听回车键保存，ESC键取消
        const handleKeyDown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveEditScenario();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
                if (scenario) {
                    scenario.isEditingTitle = false;
                    showTheaterScenarioDetail(scenario);
                }
            }
        };
        titleInput.addEventListener('keydown', handleKeyDown);
    }
    
    switchScreen('theater-detail-screen');

    // 若从聊天气泡跳转而来，将返回按钮的目标改为聊天界面
    if (window._theaterDetailFromChat) {
        window._theaterDetailFromChat = false;
        const backBtn = document.querySelector('#theater-detail-screen .back-btn');
        if (backBtn) backBtn.setAttribute('data-target', 'chat-room-screen');
    } else {
        // 恢复默认（防止上次从聊天跳转后遗留的覆盖）
        const backBtn = document.querySelector('#theater-detail-screen .back-btn');
        if (backBtn) backBtn.setAttribute('data-target', 'theater-screen');
    }
}

// 更新角色显示

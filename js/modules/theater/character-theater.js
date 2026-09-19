async function generateCharTheater(charId) {
    const char = db.characters.find(c => c.id === charId);
    if (!char || !char.charTheaterEnabled) return;

    const format = char.charTheaterFormat || 'text';
    const customPrompt = (char.charTheaterPrompt || '').trim();
    const charName = char.realName || char.remarkName || '角色';
    const charPersona = char.persona || '';

    // ── 1. 读取聊天记录（条数可配置）────────────────────────────
    const chatCount = Math.max(0, Math.min(parseInt(char.charTheaterChatCount) || 20, 200));
    const myName = char.myName || '用户';
    const recentHistory = chatCount > 0
        ? (char.history || [])
            .filter(m => !m.isContextDisabled && !m.isThinking && (m.role === 'user' || m.role === 'assistant'))
            .slice(-chatCount)
            .map(m => {
                let content = '';
                if (m.parts && m.parts.length > 0) {
                    content = m.parts.map(p => p.text || '').join('');
                } else {
                    content = m.content || '';
                }
                // 过滤 system 标记、分享卡片等杂项
                content = content.replace(/\[system[^\]]*\]/gi, '').replace(/\[小剧场分享:[^\]]*\]/gi, '').trim();
                const sender = m.role === 'user' ? myName : charName;
                return `${sender}：${content.slice(0, 300)}`;
            })
            .filter(line => line.length > 4)
            .join('\n')
        : '';

    // ── 2. 读取日记总结（条数可配置）────────────────────────────
    const journalCount = Math.max(0, Math.min(parseInt(char.charTheaterJournalCount) || 0, 50));
    let journalText = '';
    if (journalCount > 0 && Array.isArray(char.memoryJournals) && char.memoryJournals.length > 0) {
        const journals = char.memoryJournals
            .slice()
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .slice(0, journalCount);
        if (journals.length > 0) {
            journalText = journals
                .map(j => `【${j.title || '日记'}】${(j.content || '').slice(0, 400)}`)
                .join('\n\n');
        }
    }

    // ── 3. 读取绑定的世界书──────────────────────────────────────
    const wbIds = Array.isArray(char.charTheaterWorldBookIds) ? char.charTheaterWorldBookIds : [];
    let worldBookText = '';
    if (wbIds.length > 0 && Array.isArray(db.worldBooks)) {
        const selectedBooks = db.worldBooks.filter(wb => wbIds.includes(wb.id) && !wb.disabled);
        if (selectedBooks.length > 0) {
            worldBookText = selectedBooks
                .map(wb => `【${wb.name || wb.title || '世界书'}】\n${(wb.content || '').slice(0, 600)}`)
                .join('\n\n');
        }
    }

    // ── 4. 读取当前用户人设──────────────────────────────────────
    // 优先使用角色绑定的 myPersona，其次尝试全局当前人设预设
    let userPersonaText = (char.myPersona || '').trim();
    if (!userPersonaText && db.myPersonaPresets && db.myPersonaPresets.length > 0) {
        // 取第一个预设作为默认（若存在）
        const firstPreset = db.myPersonaPresets[0];
        if (firstPreset) userPersonaText = `${firstPreset.name}：${firstPreset.content || ''}`;
    }

    // ── 5. 决定格式（"both"随机选一种）──────────────────────────
    // Math.random() 是真随机，确保不固定
    const useHtml = (format === 'html') || (format === 'both' && Math.random() < 0.5);
    const mode = useHtml ? 'html' : 'text';

    // ── 6. 构建系统提示词（角色视角）───────────────────────────
    let systemPrompt;
    if (useHtml) {
        systemPrompt = `你是"${charName}"，一个有自己独立想法和情感的角色。你平时喜欢写作，会把自己的感受和与身边人的故事写成小剧场。
现在，你要基于自己的人设和最近与用户的聊天，主动写一段你自己的HTML小剧场作品。

【最高优先级规则 —— 必须包含完整 CSS】
你的输出第一行必须是 <style> 标签，里面包含本次所有 class / id 的完整 CSS 规则。
绝对禁止只输出 HTML 结构而省略 CSS！

其他要求：
1. 以角色自己的视角写作——就像角色亲手写的，不要透露"你是AI"。
2. 输出纯 HTML+CSS，禁止使用 <script> 标签或 JavaScript。
3. 可以包含 :hover、:checked 选择器等纯CSS交互效果。
4. 直接输出 HTML，不要输出开场白、说明文字或 markdown 代码块包裹（不要写 \`\`\`html）。`;
    } else {
        systemPrompt = `你是"${charName}"，一个有自己独立想法和情感的角色。你平时喜欢写作，会把自己的感受和与身边人的故事写成小短篇。
现在，你要基于自己的人设和最近与用户的聊天，主动写一段你自己的小剧场作品（纯文字短篇故事）。

要求：
1. 以角色自己的视角写作——就像角色亲手写的，用第一人称或全知视角均可，体现角色独特性格。
2. 剧情结构完整，有开端、发展和结尾。
3. 直接输出正文，不要输出任何开场白或"这是根据……生成的"等说明。`;
    }

    // ── 7. 构建用户提示词──────────────────────────────────────
    let userPrompt = `【我的角色设定（${charName}）】\n${charPersona || '（未设定）'}`;

    if (userPersonaText) {
        userPrompt += `\n\n【与我互动的用户人设】\n用户名：${myName}\n${userPersonaText}`;
    }

    if (worldBookText) {
        userPrompt += `\n\n【世界观参考设定】\n${worldBookText}`;
    }

    if (journalText) {
        userPrompt += `\n\n【我们之间的记忆总结】\n${journalText}`;
    }

    userPrompt += `\n\n【最近的聊天记录（共${chatCount}条）】\n${recentHistory || '（暂无聊天记录）'}`;

    if (customPrompt) {
        userPrompt += `\n\n【额外创作要求】\n${customPrompt}`;
    }

    userPrompt += `\n\n请现在写一段小剧场作品，题材和风格由你自由发挥，但需要体现你（${charName}）的性格特点，以及你与用户（${myName}）之间的关系和最近发生的事。`;

    const isCurrentChat = () => (typeof currentChatId !== 'undefined' && currentChatId === charId
        && typeof currentChatType !== 'undefined' && currentChatType === 'private');

    if (!char.history) char.history = [];

    // ── 显示"正在创作小剧场中"提示（复用 typing-indicator）──────
    const _typingEl = document.getElementById('typing-indicator');
    if (_typingEl && isCurrentChat()) {
        _typingEl.textContent = `"${charName}"正在创作小剧场中...`;
        _typingEl.style.display = 'block';
        _typingEl.setAttribute('data-theater-generating', 'true');
        const msgArea = document.getElementById('message-area');
        if (msgArea) msgArea.scrollTop = msgArea.scrollHeight;
    }

    /** 生成结束后隐藏 typing-indicator 的辅助函数 */
    const _hideTheaterTyping = () => {
        if (_typingEl && isCurrentChat()) {
            // 始终隐藏——若主 AI 随后启动新一轮回复，getAiReply 会自行重新显示
            _typingEl.style.display = 'none';
            _typingEl.removeAttribute('data-theater-generating');
        }
    };

    // ── 9. 调用 API 生成─────────────────────────────────────────
    try {
        const apiPayload = {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        };

        // 若角色开启了独立 API，则优先使用
        let charApiOverride = null;
        if (char.charTheaterUseCustomApi && char.charTheaterApiUrl && char.charTheaterApiKey && char.charTheaterApiModel) {
            charApiOverride = { url: char.charTheaterApiUrl, key: char.charTheaterApiKey, model: char.charTheaterApiModel };
        }
        const response = await callChatCompletion(apiPayload, charApiOverride);
        if (!response || !response.choices || !response.choices[0]) {
            _hideTheaterTyping();
            return;
        }

        let content = (response.choices[0].message.content || '').trim();

        // 处理内容格式
        if (useHtml) {
            content = content.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
            // 安全检查：有 class 但缺 <style>
            if (/class\s*=\s*["']/i.test(content) && !/<style\b/i.test(content)) {
                content = '<style>body{font-family:sans-serif;padding:12px;line-height:1.7;}</style>\n' + content;
            }
        } else {
            content = stripTheaterIntro(content);
        }

        if (!content) {
            _hideTheaterTyping();
            return;
        }

        // ── 10. 构建剧情对象并存储────────────────────────────────
        const now = new Date();
        const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
        const title = `${charName}的小剧场 · ${dateStr}`;

        const scenario = {
            id: Date.now().toString(),
            title: title,
            content: content,
            category: '角色创作',
            charId: charId,
            charGenerated: true,
            charGeneratedBy: charName,
            personaId: null,
            worldBookIds: wbIds,
            createdAt: Date.now(),
            mode: mode
        };

        // 存入对应模式的小剧场列表（临时切换模式，存完恢复）
        const savedMode = theaterCurrentMode;
        theaterCurrentMode = mode;
        const list = getTheaterScenarios();
        list.unshift(scenario);
        setTheaterScenarios(list);
        theaterCurrentMode = savedMode;

        // ── 11. 根据 charTheaterSelfAware 决定显示方式
        // 注意：历史数据里该字段可能被保存为字符串 "false"/"true"，因此这里使用严格布尔判断
        const isSelfAware = (char.charTheaterSelfAware === true || char.charTheaterSelfAware === 'true');
        if (isSelfAware) {
            // 开启自知：显示分享卡片，AI 可以读取内容
            const shareCardMsg = {
                id: `msg_theater_share_${Date.now()}`,
                role: 'assistant',
                content: `[小剧场分享:${scenario.id}]`,
                timestamp: Date.now() + 1,
                hiddenFromDisplay: false
            };
            char.history.push(shareCardMsg);

            if (isCurrentChat()) {
                const msgArea = document.getElementById('message-area');
                if (msgArea && typeof createMessageBubbleElement === 'function') {
                    const shareEl = createMessageBubbleElement(shareCardMsg, false);
                    if (shareEl) {
                        msgArea.appendChild(shareEl);
                        msgArea.scrollTop = msgArea.scrollHeight;
                    }
                }
            }
        } else {
            // 关闭自知：显示系统提示，不可点击查看详情
            const systemNotifyMsg = {
                id: `msg_theater_notify_${Date.now()}`,
                role: 'system',
                content: `[system-display:${charName} 创作了一篇小剧场「${title}」]`,
                parts: [],
                timestamp: Date.now() + 1,
                isContextDisabled: true,
                theaterScenarioId: scenario.id,
                theaterScenarioMode: mode
            };
            char.history.push(systemNotifyMsg);

            if (isCurrentChat() && typeof addMessageBubble === 'function') {
                addMessageBubble(systemNotifyMsg, charId, 'private');
                const msgArea = document.getElementById('message-area');
                if (msgArea) msgArea.scrollTop = msgArea.scrollHeight;
            }
        }

        _hideTheaterTyping();
        await saveData();
        console.log(`[小剧场] ${charName} 主动创作了小剧场：${title}`);
    } catch (err) {
        _hideTheaterTyping();
        console.warn('[小剧场] 角色主动生成小剧场失败：', err);
    }
}

/**
 * 在每次AI回复后，根据概率决定是否触发角色主动生成小剧场
 * @param {string} charId - 角色ID
 */
function maybeGenerateCharTheater(charId) {
    const char = db.characters.find(c => c.id === charId);
    if (!char || !char.charTheaterEnabled) return;

    const probability = (char.charTheaterProbability !== undefined ? char.charTheaterProbability : 20) / 100;
    if (Math.random() < probability) {
        // 立即显示"正在创作小剧场中"提示
        const charName = char.realName || char.remarkName || '角色';
        const isCurrentChat = () => (typeof currentChatId !== 'undefined' && currentChatId === charId
            && typeof currentChatType !== 'undefined' && currentChatType === 'private');
        const typingEl = document.getElementById('typing-indicator');
        if (typingEl && isCurrentChat()) {
            typingEl.textContent = `"${charName}"正在创作小剧场中...`;
            typingEl.style.display = 'block';
            typingEl.setAttribute('data-theater-generating', 'true');
            const msgArea = document.getElementById('message-area');
            if (msgArea) msgArea.scrollTop = msgArea.scrollHeight;
        }
        // 直接调用（async 不阻塞主线程），通知消息会在函数内立即推送
        generateCharTheater(charId).catch(e => {
            console.warn('[小剧场] 触发失败:', e);
            // 失败时隐藏提示
            if (typingEl && isCurrentChat()) {
                typingEl.style.display = 'none';
                typingEl.removeAttribute('data-theater-generating');
            }
        });
    }
}

// ===================== 初始化 =====================

// 初始化小剧场系统
let theaterSystemInitialized = false;
function setupTheaterSystem() {
    if (theaterSystemInitialized) return;
    theaterSystemInitialized = true;

    // 监听 iframe postMessage，自动调整 iframe 高度以完整显示 HTML 内容
    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'theater-iframe-height' && typeof e.data.height === 'number') {
            const frame = document.getElementById('theater-html-render-frame');
            if (frame) {
                // 加一点余量避免出现滚动条
                frame.style.height = (e.data.height + 20) + 'px';
            }
        }
    });

    // 主页：创建按钮
    const createBtn = document.getElementById('theater-create-btn');
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            populateTheaterForm();
            switchScreen('theater-create-screen');
        });
    }

    // 创建页：生成按钮
    const generateBtn = document.getElementById('theater-generate-btn');
    if (generateBtn) {
        generateBtn.addEventListener('click', generateTheaterScenario);
    }

    // 创建页：提示词预设
    const promptPresetSelect = document.getElementById('theater-prompt-preset-select');
    if (promptPresetSelect) {
        promptPresetSelect.addEventListener('change', applyTheaterPromptPreset);
    }

    const savePromptBtn = document.getElementById('theater-save-prompt-btn');
    if (savePromptBtn) {
        savePromptBtn.addEventListener('click', (e) => {
            e.preventDefault();
            saveTheaterPromptPreset();
        });
    }

    const managePromptBtn = document.getElementById('theater-manage-prompt-btn');
    if (managePromptBtn) {
        managePromptBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openTheaterPromptPresetManager();
        });
    }

    // 创建页：角色下拉
    const charDisplay = document.getElementById('theater-char-display');
    const charDropdown = document.getElementById('theater-char-dropdown');
    if (charDisplay && charDropdown) {
        const charWrapper = charDisplay.closest('.theater-multiselect-wrapper');
        charDisplay.addEventListener('click', () => {
            charDropdown.classList.toggle('open');
        });

        document.addEventListener('click', (e) => {
            if (charWrapper && !charWrapper.contains(e.target)) {
                charDropdown.classList.remove('open');
            }
        });
    }

    // 创建页：世界书下拉
    const worldbookDisplay = document.getElementById('theater-worldbook-display');
    const worldbookDropdown = document.getElementById('theater-worldbook-dropdown');
    if (worldbookDisplay && worldbookDropdown) {
        worldbookDisplay.addEventListener('click', () => {
            worldbookDropdown.classList.toggle('open');
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.theater-multiselect-wrapper')) {
                worldbookDropdown.classList.remove('open');
            }
        });
    }

    // 详情页：右上角编辑按钮（与下方编辑按钮同一逻辑）
    const headerEditBtn = document.getElementById('theater-header-edit-btn');
    if (headerEditBtn) {
        headerEditBtn.addEventListener('click', () => {
            if (!currentTheaterScenarioId) return;
            const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
            if (scenario) {
                scenario.isEditing = true;
                showTheaterScenarioDetail(scenario);
            }
        });
    }

    // 详情页：按钮绑定
    const favoriteBtn = document.getElementById('theater-favorite-btn');
    const saveEditBtn = document.getElementById('theater-save-edit-btn');
    const shareBtn = document.getElementById('theater-share-btn');
    const editCategoryBtn = document.getElementById('theater-edit-category-btn');
    const deleteBtn = document.getElementById('theater-delete-btn');
    const exportBtn = document.getElementById('theater-export-btn');

    if (favoriteBtn) {
        favoriteBtn.addEventListener('click', toggleFavoriteScenario);
    }
    if (saveEditBtn) {
        saveEditBtn.addEventListener('click', saveEditScenario);
    }
    if (shareBtn) {
        shareBtn.addEventListener('click', showShareTheaterModal);
    }
    if (editCategoryBtn) {
        editCategoryBtn.addEventListener('click', editScenarioCategory);
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deleteCurrentScenario);
    }
    if (exportBtn) {
        exportBtn.addEventListener('click', exportTheaterScenario);
    }

    // 字号调节功能
    // 列表页：多选删除
    const batchDeleteBtn = document.getElementById('theater-batch-delete-btn');
    if (batchDeleteBtn) {
        batchDeleteBtn.addEventListener('click', () => {
            const scenarios = getTheaterScenarios();
            if (!scenarios || scenarios.length === 0) {
                showToast('暂无剧情可删除');
                return;
            }
            theaterMultiSelectMode = true;
            theaterSelectedIds.clear();
            updateTheaterMultiSelectBar();
            renderTheaterScenarios();
        });
    }
    const selectAllBtn = document.getElementById('theater-select-all-btn');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', theaterSelectAll);
    }
    const deleteSelectedBtn = document.getElementById('theater-delete-selected-btn');
    if (deleteSelectedBtn) {
        deleteSelectedBtn.addEventListener('click', theaterDeleteSelected);
    }
    const cancelMultiBtn = document.getElementById('theater-cancel-multi-btn');
    if (cancelMultiBtn) {
        cancelMultiBtn.addEventListener('click', exitTheaterMultiSelectMode);
    }

    // 分类筛选器：监听change事件（纯文字模式）
    const categoryFilter = document.getElementById('theater-category-filter');
    if (categoryFilter) {
        categoryFilter.addEventListener('change', () => {
            renderTheaterScenarios();
        });
    }

    // 分类筛选器：监听change事件（HTML 模式）
    const htmlCategoryFilter = document.getElementById('theater-html-category-filter');
    if (htmlCategoryFilter) {
        htmlCategoryFilter.addEventListener('change', () => {
            renderTheaterScenarios();
        });
    }

    // ====== 模式切换开关 ======
    const modeSwitch = document.getElementById('theater-mode-switch');
    if (modeSwitch) {
        modeSwitch.querySelectorAll('.theater-mode-option').forEach(opt => {
            opt.addEventListener('click', () => {
                const mode = opt.dataset.mode;
                if (mode) switchTheaterMode(mode);
            });
        });
    }

    // 恢复上次保存的模式
    if (db.theaterMode && (db.theaterMode === 'html' || db.theaterMode === 'text')) {
        theaterCurrentMode = db.theaterMode;
        // 同步 UI 但不触发 toast（初始化时静默恢复）
        if (modeSwitch) {
            modeSwitch.setAttribute('data-mode', theaterCurrentMode);
            modeSwitch.querySelectorAll('.theater-mode-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.mode === theaterCurrentMode);
            });
        }
        const textMain = document.getElementById('theater-text-main');
        const htmlMain = document.getElementById('theater-html-main');
        if (textMain) textMain.style.display = (theaterCurrentMode === 'text') ? '' : 'none';
        if (htmlMain) htmlMain.style.display = (theaterCurrentMode === 'html') ? '' : 'none';
    }

    // ====== HTML 模式详情页按钮绑定 ======
    const htmlHeaderEditBtn = document.getElementById('theater-html-header-edit-btn');
    if (htmlHeaderEditBtn) {
        htmlHeaderEditBtn.addEventListener('click', () => {
            if (!currentTheaterScenarioId) return;
            const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
            if (scenario) {
                scenario.isEditing = true;
                showTheaterHtmlScenarioDetail(scenario);
            }
        });
    }

    const htmlFavoriteBtn = document.getElementById('theater-html-favorite-btn');
    if (htmlFavoriteBtn) {
        htmlFavoriteBtn.addEventListener('click', toggleFavoriteScenario);
    }
    const htmlSaveEditBtn = document.getElementById('theater-html-save-edit-btn');
    if (htmlSaveEditBtn) {
        htmlSaveEditBtn.addEventListener('click', saveHtmlEditScenario);
    }
    const htmlShareBtn = document.getElementById('theater-html-share-btn');
    if (htmlShareBtn) {
        htmlShareBtn.addEventListener('click', showShareTheaterModal);
    }
    const htmlEditCategoryBtn = document.getElementById('theater-html-edit-category-btn');
    if (htmlEditCategoryBtn) {
        htmlEditCategoryBtn.addEventListener('click', editScenarioCategory);
    }
    const htmlDeleteBtn = document.getElementById('theater-html-delete-btn');
    if (htmlDeleteBtn) {
        htmlDeleteBtn.addEventListener('click', deleteCurrentScenario);
    }
    const htmlExportBtn = document.getElementById('theater-html-export-btn');
    if (htmlExportBtn) {
        htmlExportBtn.addEventListener('click', exportTheaterScenario);
    }

    // ====== 独立API设置 ======
    const theaterApiToggle = document.getElementById('theater-api-toggle');
    const theaterApiConfig = document.getElementById('theater-api-config');
    if (theaterApiToggle && theaterApiConfig) {
        // 恢复已保存的状态
        const savedTheaterApi = db.theaterApiSettings || {};
        if (savedTheaterApi.useTheaterApi) {
            theaterApiToggle.setAttribute('aria-checked', 'true');
            theaterApiConfig.style.display = '';
        }

        if (!theaterApiToggle._theaterApiBound) {
            theaterApiToggle._theaterApiBound = true;
            const toggleHandler = () => {
                const isOn = theaterApiToggle.getAttribute('aria-checked') === 'true';
                const newState = !isOn;
                theaterApiToggle.setAttribute('aria-checked', String(newState));
                theaterApiConfig.style.display = newState ? '' : 'none';
            };
            theaterApiToggle.addEventListener('click', toggleHandler);
            theaterApiToggle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHandler(); }
            });
        }
    }

    // 填充 API 预设下拉（读取主 API 预设 + 各副 API 预设）
    const theaterApiPresetSelect = document.getElementById('theater-api-preset-select');
    if (theaterApiPresetSelect) {
        theaterApiPresetSelect.innerHTML = '<option value="">— 选择预设配置 —</option>';
        const mainPresets = db.apiPresets || [];
        mainPresets.forEach(p => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify(p.data);
            opt.textContent = p.name + '（主API预设）';
            theaterApiPresetSelect.appendChild(opt);
        });

        // 也加入副API预设
        const subKeys = [
            { key: 'summaryApiPresets', label: '总结API' },
            { key: 'backgroundApiPresets', label: '后台API' },
            { key: 'supplementPersonaApiPresets', label: '补齐人设API' },
            { key: 'peekApiPresets', label: '偷看手机API' }
        ];
        subKeys.forEach(({ key, label }) => {
            const presets = db[key] || [];
            presets.forEach(p => {
                const opt = document.createElement('option');
                opt.value = JSON.stringify(p.data);
                opt.textContent = p.name + `（${label}预设）`;
                theaterApiPresetSelect.appendChild(opt);
            });
        });

        theaterApiPresetSelect.addEventListener('change', () => {
            if (!theaterApiPresetSelect.value) return;
            try {
                const data = JSON.parse(theaterApiPresetSelect.value);
                const urlEl = document.getElementById('theater-api-url');
                const keyEl = document.getElementById('theater-api-key');
                const modelEl = document.getElementById('theater-api-model');
                if (urlEl && data.apiUrl !== undefined) urlEl.value = data.apiUrl || data.url || '';
                if (urlEl && data.url !== undefined && !data.apiUrl) urlEl.value = data.url || '';
                if (keyEl && data.apiKey !== undefined) keyEl.value = data.apiKey || data.key || '';
                if (keyEl && data.key !== undefined && !data.apiKey) keyEl.value = data.key || '';
                if (modelEl && (data.model)) {
                    modelEl.innerHTML = `<option value="${data.model}">${data.model}</option>`;
                    modelEl.value = data.model;
                }
                showToast('已应用预设配置');
            } catch (err) {
                console.error('应用预设失败', err);
            }
        });
    }

    // 恢复已保存的独立API字段值
    const savedTheaterApiSettings = db.theaterApiSettings || {};
    if (savedTheaterApiSettings.url) {
        const urlEl = document.getElementById('theater-api-url');
        if (urlEl) urlEl.value = savedTheaterApiSettings.url;
    }
    if (savedTheaterApiSettings.key) {
        const keyEl = document.getElementById('theater-api-key');
        if (keyEl) keyEl.value = savedTheaterApiSettings.key;
    }
    if (savedTheaterApiSettings.model) {
        const modelEl = document.getElementById('theater-api-model');
        if (modelEl) {
            modelEl.innerHTML = `<option value="${savedTheaterApiSettings.model}">${savedTheaterApiSettings.model}</option>`;
            modelEl.value = savedTheaterApiSettings.model;
        }
    }

    // 拉取模型按钮
    const theaterApiFetchBtn = document.getElementById('theater-api-fetch-models-btn');
    if (theaterApiFetchBtn) {
        theaterApiFetchBtn.addEventListener('click', async () => {
            const urlEl = document.getElementById('theater-api-url');
            const keyEl = document.getElementById('theater-api-key');
            const modelEl = document.getElementById('theater-api-model');
            if (!urlEl || !keyEl || !modelEl) return;

            let apiUrl = urlEl.value.trim();
            const apiKey = keyEl.value.trim();
            if (!apiUrl || !apiKey) {
                showToast('请先填写API地址和密钥！');
                return;
            }

            const blockedDomains = (typeof BLOCKED_API_DOMAINS !== 'undefined') ? BLOCKED_API_DOMAINS : [];
            if (blockedDomains.some(domain => apiUrl.includes(domain))) {
                showToast('该API站点已被屏蔽，无法使用！');
                return;
            }

            if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
            const endpoint = `${apiUrl}/v1/models`;

            theaterApiFetchBtn.disabled = true;
            const origText = theaterApiFetchBtn.textContent;
            theaterApiFetchBtn.textContent = '拉取中...';

            try {
                const resp = await fetch(endpoint, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                const models = (json.data || []).map(m => m.id).filter(Boolean).sort();
                if (models.length === 0) {
                    showToast('未找到可用模型');
                    return;
                }
                const currentVal = modelEl.value;
                modelEl.innerHTML = '';
                models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    modelEl.appendChild(opt);
                });
                if (models.includes(currentVal)) {
                    modelEl.value = currentVal;
                }
                showToast(`成功拉取 ${models.length} 个模型`);
            } catch (err) {
                console.error('拉取模型失败', err);
                showToast('拉取模型失败：' + (err.message || '未知错误'));
            } finally {
                theaterApiFetchBtn.disabled = false;
                theaterApiFetchBtn.textContent = origText;
            }
        });
    }

    // 保存独立API设置
    const theaterApiSaveBtn = document.getElementById('theater-api-save-btn');
    if (theaterApiSaveBtn) {
        theaterApiSaveBtn.addEventListener('click', async () => {
            const toggle = document.getElementById('theater-api-toggle');
            const urlEl = document.getElementById('theater-api-url');
            const keyEl = document.getElementById('theater-api-key');
            const modelEl = document.getElementById('theater-api-model');
            db.theaterApiSettings = {
                useTheaterApi: toggle ? toggle.getAttribute('aria-checked') === 'true' : false,
                url: (urlEl && urlEl.value.trim()) || '',
                key: (keyEl && keyEl.value.trim()) || '',
                model: (modelEl && modelEl.value.trim()) || ''
            };
            await saveData();
            showToast('独立API设置已保存！');
        });
    }

    // 初次渲染列表
    renderTheaterScenarios();

    // 监听屏幕切换，更新列表
    document.addEventListener('click', (e) => {
        if (e.target.closest('[data-target="theater-screen"]')) {
            setTimeout(() => {
                renderTheaterScenarios();
            }, 100);
        }
    });
}

// 自动初始化（防止主入口未显式调用时小剧场无法使用）
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (typeof setupTheaterSystem === 'function') {
                setupTheaterSystem();
            }
        });
    } else {
        if (typeof setupTheaterSystem === 'function') {
            setupTheaterSystem();
        }
    }
}

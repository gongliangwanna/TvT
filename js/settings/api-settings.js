const saveMainApiSettings = () => saveGlobalSettings(['apiSettings', 'gptImageSettings', 'imageRecognitionEnabled', 'weatherApiSettings']);

function apiProviderToGenerationProtocol(provider) {
    if (provider === 'claude') return 'anthropic';
    if (provider === 'gemini') return 'gemini';
    if (provider === 'deepseek') return 'deepseek';
    return 'openai_chat';
}

function createApiGenerationParameterEditor(container, initialParams, options = {}) {
    if (!container) return null;
    const nodeMode = !!options.nodeMode;
    const controls = new Map();
    let params = normalizeApiGenerationParams(initialParams, nodeMode, options.legacyTemperature);
    let protocol = options.protocol || 'openai_chat';

    const readValue = (input, def) => {
        if (def.type === 'integer' || def.type === 'number') {
            const parsed = def.type === 'integer' ? Number.parseInt(input.value, 10) : Number.parseFloat(input.value);
            const fallback = Number(def.defaultValue);
            if (!Number.isFinite(parsed)) return fallback;
            return Math.min(Number(def.max), Math.max(Number(def.min), parsed));
        }
        return input.value;
    };
    const notify = () => {
        if (typeof options.onChange === 'function') options.onChange(controller.get());
    };
    const updateRow = (key) => {
        const control = controls.get(key);
        if (!control) return;
        const active = nodeMode ? control.state.value === 'on' : control.state.checked;
        const inherited = nodeMode && control.state.value === 'inherit';
        control.input.disabled = !active;
        if (control.rangeInput) control.rangeInput.disabled = !active;
        control.row.classList.toggle('is-disabled', !active);
        control.row.classList.toggle('is-inherited', inherited);
        const supported = API_GENERATION_PARAMETER_DEFINITIONS[key].support.includes(protocol) || protocol === 'custom';
        const isRequiredAnthropicMax = protocol === 'anthropic' && key === 'maxOutputTokens' && !active && !inherited;
        control.support.textContent = isRequiredAnthropicMax
            ? 'Anthropic 必填，关闭时使用兼容值 4096'
            : supported ? (inherited ? '继承' : active ? '将发送' : '不发送') : '当前协议不支持，将忽略';
        control.support.classList.toggle('is-warning', !supported && active);
    };
    const build = () => {
        container.replaceChildren();
        controls.clear();
        Object.entries(API_GENERATION_PARAMETER_DEFINITIONS).forEach(([key, def]) => {
            const entry = params[key];
            const row = document.createElement('div'); row.className = 'api-generation-row'; row.dataset.param = key;
            const heading = document.createElement('div'); heading.className = 'api-generation-row-heading';
            const titleBox = document.createElement('div'); titleBox.className = 'api-generation-row-title';
            const title = document.createElement('span'); title.textContent = def.label;
            const apiName = document.createElement('small'); apiName.textContent = def.apiName;
            titleBox.append(title, apiName);
            const state = nodeMode ? document.createElement('select') : document.createElement('input');
            state.className = 'api-generation-state';
            if (nodeMode) {
                [['inherit', '继承'], ['on', '启用'], ['off', '禁用']].forEach(([value, label]) => {
                    const option = document.createElement('option'); option.value = value; option.textContent = label; state.appendChild(option);
                });
                state.value = entry.mode;
            } else {
                state.type = 'checkbox'; state.checked = !!entry.enabled; state.setAttribute('aria-label', `${def.label}开关`);
            }
            const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'api-generation-reset'; reset.textContent = '重置'; reset.title = `恢复 ${def.label} 建议值`;
            const actions = document.createElement('div'); actions.className = 'api-generation-row-actions'; actions.append(state, reset);
            heading.append(titleBox, actions);

            let input;
            if (def.type === 'select') {
                input = document.createElement('select');
                def.options.forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; input.appendChild(option); });
            } else if (def.type === 'text') {
                input = document.createElement('textarea'); input.rows = 2; input.placeholder = '每行一个停止序列';
            } else {
                input = document.createElement('input'); input.type = 'number'; input.min = def.min; input.max = def.max; input.step = def.step;
            }
            input.className = 'api-generation-value'; input.value = entry.value;
            const valueWrap = document.createElement('div'); valueWrap.className = 'api-generation-value-wrap';
            let rangeInput = null;
            if (key === 'temperature') {
                valueWrap.classList.add('has-range');
                rangeInput = document.createElement('input'); rangeInput.type = 'range'; rangeInput.className = 'api-generation-range';
                rangeInput.min = def.min; rangeInput.max = def.max; rangeInput.step = def.step; rangeInput.value = entry.value;
                rangeInput.addEventListener('input', () => { input.value = rangeInput.value; entry.value = readValue(input, def); notify(); });
                valueWrap.append(rangeInput);
            }
            valueWrap.append(input);
            const support = document.createElement('div'); support.className = 'api-generation-support';
            input.addEventListener('input', () => { entry.value = readValue(input, def); if (rangeInput) rangeInput.value = entry.value; notify(); });
            input.addEventListener('change', () => { entry.value = readValue(input, def); input.value = entry.value; if (rangeInput) rangeInput.value = entry.value; notify(); });
            state.addEventListener('change', () => {
                if (nodeMode) entry.mode = state.value; else entry.enabled = state.checked;
                updateRow(key); notify();
            });
            reset.addEventListener('click', () => { entry.value = cloneApiGenerationValue(def.defaultValue); input.value = entry.value; if (rangeInput) rangeInput.value = entry.value; notify(); });
            row.append(heading, valueWrap, support); container.appendChild(row);
            controls.set(key, { row, state, input, rangeInput, support });
            updateRow(key);
        });
    };
    const controller = {
        get() {
            const result = normalizeApiGenerationParams(params, nodeMode);
            controls.forEach((control, key) => {
                const def = API_GENERATION_PARAMETER_DEFINITIONS[key];
                result[key].value = readValue(control.input, def);
                if (nodeMode) result[key].mode = control.state.value; else result[key].enabled = control.state.checked;
            });
            return result;
        },
        set(nextParams, legacyTemperature) { params = normalizeApiGenerationParams(nextParams, nodeMode, legacyTemperature); build(); notify(); },
        setProtocol(nextProtocol) { protocol = nextProtocol || 'openai_chat'; controls.forEach((_, key) => updateRow(key)); },
        resetValues() {
            Object.entries(API_GENERATION_PARAMETER_DEFINITIONS).forEach(([key, def]) => { params[key].value = cloneApiGenerationValue(def.defaultValue); });
            build(); notify();
        },
        disableAll() {
            Object.values(params).forEach(entry => { if (nodeMode) entry.mode = 'off'; else entry.enabled = false; });
            build(); notify();
        },
        inheritAll() {
            if (!nodeMode) return;
            Object.values(params).forEach(entry => { entry.mode = 'inherit'; });
            build(); notify();
        }
    };
    build();
    return controller;
}

function setupApiSettingsApp() {
    const e = document.getElementById('api-form'), t = document.getElementById('fetch-models-btn'),
        a = document.getElementById('api-model'), n = document.getElementById('api-provider'),
        r = document.getElementById('api-url'), s = document.getElementById('api-key'), c = {
            newapi: '',
            deepseek: 'https://api.deepseek.com',
            claude: 'https://api.anthropic.com',
            gemini: 'https://generativelanguage.googleapis.com'
        };
    db.apiSettings && (n.value = db.apiSettings.provider || 'newapi', r.value = db.apiSettings.url || '', s.value = db.apiSettings.key || '', db.apiSettings.model && (a.innerHTML = `<option value="${db.apiSettings.model}">${db.apiSettings.model}</option>`));
    if (db.apiSettings && typeof db.apiSettings.onlineRoleEnabled !== 'undefined') { document.getElementById('online-role-switch').checked = db.apiSettings.onlineRoleEnabled; } else { document.getElementById('online-role-switch').checked = true; }
    if (db.apiSettings && typeof db.apiSettings.timePerceptionEnabled !== 'undefined') { document.getElementById('time-perception-switch').checked = db.apiSettings.timePerceptionEnabled; }
    if (db.apiSettings && typeof db.apiSettings.streamEnabled !== 'undefined') { document.getElementById('stream-switch').checked = db.apiSettings.streamEnabled; } else { document.getElementById('stream-switch').checked = true; }
    if (db.apiSettings && typeof db.apiSettings.quickReplyEnabled !== 'undefined') { document.getElementById('quick-reply-switch').checked = db.apiSettings.quickReplyEnabled; } else { document.getElementById('quick-reply-switch').checked = false; }
    if (db.apiSettings && typeof db.apiSettings.latestTurnProtectionEnabled !== 'undefined') { document.getElementById('latest-turn-protection-switch').checked = db.apiSettings.latestTurnProtectionEnabled; } else { document.getElementById('latest-turn-protection-switch').checked = false; }

    const generationSummary = document.getElementById('api-generation-summary');
    const updateGenerationSummary = params => {
        if (!generationSummary) return;
        const enabled = Object.values(params || {}).filter(entry => entry.enabled).length;
        generationSummary.textContent = `${enabled} 项启用`;
    };
    const mainGenerationEditor = createApiGenerationParameterEditor(
        document.getElementById('api-generation-params'),
        db.apiSettings?.generationParams,
        { legacyTemperature: db.apiSettings?.temperature, protocol: apiProviderToGenerationProtocol(n.value), onChange: updateGenerationSummary }
    );
    updateGenerationSummary(mainGenerationEditor?.get());
    window.setMainApiGenerationParams = (params, legacyTemperature) => mainGenerationEditor?.set(params, legacyTemperature);
    window.getMainApiGenerationParams = () => mainGenerationEditor?.get();
    window.updateMainApiGenerationProtocol = provider => mainGenerationEditor?.setProtocol(apiProviderToGenerationProtocol(provider));
    document.getElementById('api-generation-reset-values')?.addEventListener('click', () => { mainGenerationEditor?.resetValues(); showToast('生成参数已恢复建议值，保存后生效'); });
    document.getElementById('api-generation-disable-all')?.addEventListener('click', () => { mainGenerationEditor?.disableAll(); showToast('已关闭全部生成参数，保存后由模型决定'); });

    populateApiSelect();
    n?.addEventListener('change', () => {
        if (r) r.value = c[n.value] || '';
        mainGenerationEditor?.setProtocol(apiProviderToGenerationProtocol(n.value));
    });

    // 提取为全局函数以便复用
    window.fetchAndPopulateModels = async (showToastFlag = true) => {
        const provider = n.value;
        let apiUrl = r.value.trim();
        const apiKey = s.value.trim();
        const modelSelect = a;
        const fetchBtn = t;

        if (!apiUrl || !apiKey) {
            if (showToastFlag) showToast('请先填写API地址和密钥！');
            return;
        }

        if (BLOCKED_API_DOMAINS.some(domain => apiUrl.includes(domain))) {
            if (showToastFlag) showToast('该 API 站点已被屏蔽，无法使用！');
            return;
        }

        if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
        
        const endpoint = provider === 'gemini' 
            ? `${apiUrl}/v1beta/models?key=${getRandomValue(apiKey)}` 
            : `${apiUrl}/v1/models`;

        if (fetchBtn) {
            fetchBtn.classList.add('loading');
            fetchBtn.disabled = true;
        }

        try {
            const headers = provider === 'gemini' ? {} : { Authorization: `Bearer ${apiKey}` };
            const response = await fetch(endpoint, { method: 'GET', headers });
            
            if (!response.ok) {
                const error = new Error(`网络响应错误: ${response.status}`);
                error.response = response;
                throw error;
            }

            const data = await response.json();
            let models = [];
            
            if (provider !== 'gemini' && data.data) {
                models = data.data.map(e => e.id);
            } else if (provider === 'gemini' && data.models) {
                models = data.models.map(e => e.name.replace('models/', ''));
            }

            // 保留当前选中的值（如果仍在列表中）
            const currentVal = modelSelect.value;
            
            modelSelect.innerHTML = '';
            if (models.length > 0) {
                models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    modelSelect.appendChild(opt);
                });
                
                // 尝试恢复之前的选择，或者使用设置中的值
                if (models.includes(currentVal)) {
                    modelSelect.value = currentVal;
                } else if (db.apiSettings && db.apiSettings.model && models.includes(db.apiSettings.model)) {
                    modelSelect.value = db.apiSettings.model;
                }
                
                if (showToastFlag) showToast('模型列表拉取成功！');
            } else {
                modelSelect.innerHTML = '<option value="">未找到任何模型</option>';
                if (showToastFlag) showToast('未找到任何模型');
            }
        } catch (err) {
            console.error(err);
            if (showToastFlag) {
                showApiError(err);
                modelSelect.innerHTML = '<option value="">拉取失败</option>';
            }
        } finally {
            if (fetchBtn) {
                fetchBtn.classList.remove('loading');
                fetchBtn.disabled = false;
            }
        }
    };

    t?.addEventListener('click', () => window.fetchAndPopulateModels(true));
    e?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!a.value) return showToast('请选择模型后保存！');
        if (BLOCKED_API_DOMAINS.some(domain => r.value.includes(domain))) {
            return showToast('该 API 站点已被屏蔽，无法保存！');
        }
        const generationParams = mainGenerationEditor?.get() || normalizeApiGenerationParams(null, false, 1);
        db.apiSettings = {
            provider: n.value,
            url: r.value,
            key: s.value,
            model: a.value,
            onlineRoleEnabled: document.getElementById('online-role-switch').checked,
            timePerceptionEnabled: document.getElementById('time-perception-switch').checked,
            streamEnabled: document.getElementById('stream-switch').checked,
            quickReplyEnabled: document.getElementById('quick-reply-switch').checked,
            latestTurnProtectionEnabled: document.getElementById('latest-turn-protection-switch').checked,
            generationParams,
            temperature: Number(generationParams.temperature.value)
        };
        
        // 保存自动识图全局开关
        const irSwitch = document.getElementById('imageRecognition-enabled-switch');
        if (irSwitch) {
            db.imageRecognitionEnabled = irSwitch.checked;
        }

        await saveMainApiSettings();
        showToast('API设置已保存！')
    });
    
    // === 副API设置：总结API ===
    setupSubApiSettings('summary', 'summaryApiSettings', 'summaryApiPresets');
    
    // === 副API设置：后台活动API ===
    setupSubApiSettings('background', 'backgroundApiSettings', 'backgroundApiPresets');

    // === 副API设置：向量记忆 Embedding API ===
    setupSubApiSettings('vector', 'vectorApiSettings', 'vectorApiPresets');
    
    // === 副API设置：补齐人设API ===
    setupSubApiSettings('supplementPersona', 'supplementPersonaApiSettings', 'supplementPersonaApiPresets');
    
    // === 副API设置：偷看手机API ===
    setupSubApiSettings('peek', 'peekApiSettings', 'peekApiPresets');

    // === 副API设置：自动识图 API ===
    setupSubApiSettings('imageRecognition', 'imageRecognitionApiSettings', 'imageRecognitionApiPresets');
    
    if (db.imageRecognitionEnabled !== undefined) {
        document.getElementById('imageRecognition-enabled-switch').checked = db.imageRecognitionEnabled;
    } else {
        document.getElementById('imageRecognition-enabled-switch').checked = false; // 默认关闭
    }

    // === 副API设置：表情包识图 API ===
    setupSubApiSettings('stickerRecognition', 'stickerRecognitionApiSettings', 'stickerRecognitionApiPresets');

    // === 全局天气服务 API ===
    const weatherProviderEl = document.getElementById('weather-api-provider');
    const weatherKeyEl = document.getElementById('weather-api-key');
    const weatherKeyCont = document.getElementById('weather-api-key-container');
    const weatherSaveBtn = document.getElementById('weather-api-save-btn');

    if (weatherProviderEl) {
        if (db.weatherApiSettings) {
            weatherProviderEl.value = db.weatherApiSettings.provider || 'openmeteo';
            if (weatherKeyEl) weatherKeyEl.value = db.weatherApiSettings.key || '';
        }
        
        const updateWeatherKeyVisibility = () => {
            const provider = weatherProviderEl.value;
            if (provider === 'qweather' || provider === 'seniverse') {
                if (weatherKeyCont) weatherKeyCont.style.display = 'flex';
            } else {
                if (weatherKeyCont) weatherKeyCont.style.display = 'none';
            }
        };
        weatherProviderEl.addEventListener('change', updateWeatherKeyVisibility);
        updateWeatherKeyVisibility();

        if (weatherSaveBtn) {
            weatherSaveBtn.addEventListener('click', async () => {
                db.weatherApiSettings = {
                    provider: weatherProviderEl.value,
                    key: weatherKeyEl ? weatherKeyEl.value.trim() : ''
                };
                await saveMainApiSettings();
                showToast('全局天气 API 设置已保存！');
            });
        }
    }

    // === NovelAI 生图 API 设置 ===
    setupNovelAiSettings();

    // === GPT 生图 API 设置 ===
    setupGptImageSettings();

    // === Google、Stability 与跨平台氛围组 ===
    setupAdditionalImageProviders();
    setupImageAtmosphereGroups();

    // 自定义 API 节点与功能路由（旧 API 配置继续保留并作为未分配时的兼容路径）
    setupApiNodeManager();

    // === iOS 分段场景控制器 (Segmented Tab) 交互 ===
    const segButtons = document.querySelectorAll('#api-settings-screen .api-seg-btn');
    const tabPanes = document.querySelectorAll('#api-settings-screen .api-tab-pane');

    segButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            segButtons.forEach(b => b.classList.toggle('active', b === btn));
            tabPanes.forEach(pane => {
                const paneCategory = pane.getAttribute('data-category');
                pane.classList.toggle('active', paneCategory === targetTab);
            });
            const scrollContainer = document.querySelector('#api-settings-screen .api-settings-scroll-content');
            if (scrollContainer) scrollContainer.scrollTop = 0;
        });
    });

    // === 灵动全局过滤搜索 ===
    const searchInput = document.getElementById('api-settings-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const keyword = e.target.value.trim().toLowerCase();
            const cards = document.querySelectorAll('#api-settings-screen .api-section-card');

            if (!keyword) {
                // 恢复当前 Tab 显示
                const activeBtn = document.querySelector('#api-settings-screen .api-seg-btn.active');
                const currentTab = activeBtn ? activeBtn.getAttribute('data-tab') : 'chat';
                tabPanes.forEach(pane => {
                    pane.classList.toggle('active', pane.getAttribute('data-category') === currentTab);
                });
                cards.forEach(c => {
                    c.style.display = '';
                    c.querySelectorAll('.kkt-item, .api-generation-row').forEach(i => i.style.display = '');
                });
                return;
            }

            // 搜索态：全分类联动检索
            tabPanes.forEach(pane => pane.classList.add('active'));

            cards.forEach(card => {
                const titleText = card.querySelector('.api-card-title')?.textContent.toLowerCase() || '';
                const descText = card.querySelector('.api-card-desc')?.textContent.toLowerCase() || '';
                const cardHeaderMatch = titleText.includes(keyword) || descText.includes(keyword);

                let hasItemMatch = false;
                const items = card.querySelectorAll('.kkt-item, .api-generation-row');
                items.forEach(item => {
                    const text = item.textContent.toLowerCase();
                    if (cardHeaderMatch || text.includes(keyword)) {
                        item.style.display = '';
                        hasItemMatch = true;
                    } else {
                        item.style.display = 'none';
                    }
                });

                if (cardHeaderMatch || hasItemMatch) {
                    card.style.display = '';
                } else {
                    card.style.display = 'none';
                }
            });
        });
    }
}

const API_NODE_FEATURE_GROUPS = [
    ['聊天', ['chat', 'groupChat', 'background', 'call']],
    ['内容', ['summary', 'journal', 'forum', 'theater', 'peek', 'shop', 'pomodoro', 'battery']],
    ['图片', ['imageChat', 'stickerVision', 'avatarVision', 'callVision']],
    ['扩展', ['memorySummary', 'webSearch']]
];

function setupApiNodeManager() {
    const list = document.getElementById('api-node-list');
    const editorScreen = document.getElementById('api-node-editor-screen');
    const form = document.getElementById('api-node-edit-form');
    if (!list || !editorScreen || !form || form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    if (!Array.isArray(db.apiNodes)) db.apiNodes = [];
    if (!db.apiNodeRoutes || typeof db.apiNodeRoutes !== 'object') db.apiNodeRoutes = {};

    const featureBox = document.getElementById('api-node-feature-list');
    API_NODE_FEATURE_GROUPS.forEach(([groupName, keys]) => {
        const group = document.createElement('div');
        group.className = 'api-node-feature-group';
        const title = document.createElement('span');
        title.textContent = groupName;
        group.appendChild(title);
        keys.forEach(key => {
            const def = typeof API_NODE_FEATURES !== 'undefined' ? API_NODE_FEATURES[key] : null;
            if (!def) return;
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox'; input.name = 'api-node-feature'; input.value = key;
            label.append(input, document.createTextNode(def));
            group.appendChild(label);
        });
        featureBox.appendChild(group);
    });

    const fields = {
        id: 'api-node-id', name: 'api-node-name', protocol: 'api-node-protocol', url: 'api-node-url',
        key: 'api-node-key', model: 'api-node-model', enabled: 'api-node-enabled', streamMode: 'api-node-stream', authMode: 'api-node-auth',
        chatEndpoint: 'api-node-chat-endpoint', modelEndpoint: 'api-node-model-endpoint',
        customHeaders: 'api-node-headers', customBody: 'api-node-body', imageMode: 'api-node-image-mode', generationParamMode: 'api-node-generation-mode'
    };
    const el = key => document.getElementById(fields[key]);
    const status = document.getElementById('api-node-form-status');
    const setStatus = (message, error = false) => {
        status.textContent = message || '';
        status.classList.toggle('error', error);
    };
    const nodeGenerationEditor = createApiGenerationParameterEditor(
        document.getElementById('api-node-generation-params'), null,
        { nodeMode: true, protocol: 'openai_chat' }
    );
    const updateNodeGenerationVisibility = () => {
        const mode = el('generationParamMode')?.value || 'inherit';
        document.getElementById('api-node-generation-params')?.classList.toggle('is-readonly', mode !== 'custom');
        document.getElementById('api-node-generation-reset')?.toggleAttribute('disabled', mode !== 'custom');
    };
    el('generationParamMode')?.addEventListener('change', updateNodeGenerationVisibility);
    el('protocol')?.addEventListener('change', () => nodeGenerationEditor?.setProtocol(el('protocol').value || 'openai_chat'));
    document.getElementById('api-node-generation-reset')?.addEventListener('click', () => { nodeGenerationEditor?.inheritAll(); showToast('节点参数已恢复为逐项继承'); });
    let editorSnapshot = '';
    const snapshotEditor = () => JSON.stringify({
        fields: Object.keys(fields).map(key => el(key)?.value || ''),
        features: Array.from(document.querySelectorAll('input[name="api-node-feature"]')).map(input => input.checked),
        generationParams: nodeGenerationEditor?.get()
    });
    const close = async (force = false) => {
        if (!force && editorScreen.classList.contains('active') && snapshotEditor() !== editorSnapshot) {
            if (typeof customConfirm !== 'function') return showToast('请先保存节点或使用页面内取消按钮');
            const discard = await customConfirm('当前节点有尚未保存的修改，确定放弃并返回吗？', '放弃修改');
            if (!discard) return;
        }
        setStatus('');
        if (typeof switchScreen === 'function') switchScreen('api-settings-screen');
    };
    const open = node => {
        form.reset();
        const resultRow = document.getElementById('api-node-model-results-row');
        if (resultRow) resultRow.hidden = true;
        Object.keys(fields).forEach(key => { if (el(key)) el(key).value = ''; });
        document.querySelectorAll('input[name="api-node-feature"]').forEach(input => { input.checked = false; });
        if (node) {
            Object.keys(fields).forEach(key => {
                if (!el(key)) return;
                if (key === 'enabled') el(key).value = node.enabled === true ? 'enabled' : 'paused';
                else if (key === 'streamMode') el(key).value = node.streamMode || (node.streamEnabled === true ? 'enabled' : node.streamEnabled === false ? 'disabled' : 'inherit');
                else if (key === 'customHeaders' || key === 'customBody') el(key).value = node[key] ? JSON.stringify(node[key], null, 2) : '';
                else el(key).value = node[key] || '';
            });
            el('generationParamMode').value = node.generationParamMode || 'inherit';
            nodeGenerationEditor?.set(node.generationParams);
            document.querySelectorAll('input[name="api-node-feature"]').forEach(input => {
                input.checked = Array.isArray(node.features) && node.features.includes(input.value);
            });
            document.getElementById('api-node-editor-title').textContent = '编辑 API 节点';
        } else {
            document.getElementById('api-node-editor-title').textContent = '新建 API 节点';
            el('generationParamMode').value = 'inherit';
            nodeGenerationEditor?.set(null);
        }
        nodeGenerationEditor?.setProtocol(el('protocol').value || 'openai_chat');
        updateNodeGenerationVisibility();
        if (typeof switchScreen === 'function') switchScreen('api-node-editor-screen');
        const content = editorScreen.querySelector('.content');
        if (content) content.scrollTop = 0;
        editorSnapshot = snapshotEditor();
    };

    const parseJson = (value, label) => {
        if (!value.trim()) return null;
        try { return JSON.parse(value); }
        catch (_) { throw new Error(`${label}不是有效 JSON`); }
    };
    const readDraft = () => ({
        id: el('id').value || `api_node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: el('name').value.trim(), protocol: el('protocol').value, url: el('url').value.trim().replace(/\/$/, ''),
        key: el('key').value.trim(), model: el('model').value.trim(), enabled: el('enabled').value === 'enabled', streamMode: el('streamMode').value,
        streamEnabled: el('streamMode').value === 'enabled' ? true : el('streamMode').value === 'disabled' ? false : undefined,
        authMode: el('authMode').value, chatEndpoint: el('chatEndpoint').value.trim(), modelEndpoint: el('modelEndpoint').value.trim(),
        customHeaders: parseJson(el('customHeaders').value, '自定义请求头'),
        customBody: parseJson(el('customBody').value, '自定义请求体'), imageMode: el('imageMode').value,
        generationParamMode: el('generationParamMode').value || 'inherit',
        generationParams: nodeGenerationEditor?.get() || normalizeApiGenerationParams(null, true),
        features: Array.from(document.querySelectorAll('input[name="api-node-feature"]:checked')).map(input => input.value)
    });

    const render = () => {
        list.replaceChildren();
        if (!db.apiNodes.length) {
            const empty = document.createElement('p'); empty.className = 'api-node-empty';
            empty.textContent = '尚未创建节点。下方原 API 配置仍照常使用。'; list.appendChild(empty);
        }
        db.apiNodes.forEach(node => {
            const card = document.createElement('article'); card.className = `api-node-card ${node.enabled ? '' : 'paused'}`;
            const body = document.createElement('div'); body.className = 'api-node-card-main';
            const heading = document.createElement('div'); heading.className = 'api-node-card-title';
            const name = document.createElement('strong'); name.textContent = node.name;
            const badge = document.createElement('span'); badge.className = 'api-node-state'; badge.textContent = node.enabled ? '启用' : '暂停';
            heading.append(name, badge);
            const meta = document.createElement('div'); meta.className = 'api-node-card-meta'; meta.textContent = `${node.protocol || '未选协议'} · ${node.model || '未选模型'}`;
            const features = document.createElement('div'); features.className = 'api-node-card-meta';
            features.textContent = node.features?.length ? node.features.map(k => API_NODE_FEATURES[k] || k).join('、') : '未分配功能';
            const generation = document.createElement('div'); generation.className = 'api-node-card-meta';
            const generationMode = node.generationParamMode || 'inherit';
            if (generationMode === 'inherit') generation.textContent = '生成参数：继承默认主 API';
            else if (generationMode === 'provider') generation.textContent = '生成参数：全部交给渠道';
            else {
                const enabledNames = Object.entries(normalizeApiGenerationParams(node.generationParams, true))
                    .filter(([, entry]) => entry.mode === 'on').map(([key]) => API_GENERATION_PARAMETER_DEFINITIONS[key].apiName);
                generation.textContent = enabledNames.length ? `节点参数：${enabledNames.join('、')}` : '节点参数：按项继承或禁用';
            }
            body.append(heading, meta, features, generation);
            const actions = document.createElement('div'); actions.className = 'api-node-card-actions';
            const button = (text, handler) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-small'; b.textContent = text; b.addEventListener('click', handler); return b; };
            actions.append(
                button('编辑', () => open(node)),
                button('复制', async () => { db.apiNodes.push({ ...JSON.parse(JSON.stringify(node)), id: `api_node_${Date.now()}`, name: `${node.name} 副本`, features: [] }); await saveGlobalSettings(['apiNodes']); render(); showToast('已复制，功能分配留空'); }),
                button('删除', async e => {
                    if (e.currentTarget.dataset.confirm !== '1') {
                        const target = e.currentTarget;
                        target.dataset.confirm = '1'; target.textContent = '再点确认';
                        setTimeout(() => { if (target.isConnected) { delete target.dataset.confirm; target.textContent = '删除'; } }, 3000);
                        return;
                    }
                    db.apiNodes = db.apiNodes.filter(item => item.id !== node.id);
                    Object.keys(db.apiNodeRoutes).forEach(key => { if (db.apiNodeRoutes[key]?.primaryNodeId === node.id) delete db.apiNodeRoutes[key].primaryNodeId; });
                    await saveGlobalSettings(['apiNodes', 'apiNodeRoutes']); render(); showToast('节点已删除，原 API 配置未受影响');
                })
            );
            card.append(body, actions); list.appendChild(card);
        });
        renderApiNodeConflicts();
    };

    form.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const node = readDraft();
            if (!node.name || !node.protocol || !node.url || !node.model || !el('enabled').value || !node.streamMode) throw new Error('请完成所有必选项');
            if (typeof BLOCKED_API_DOMAINS !== 'undefined' && BLOCKED_API_DOMAINS.some(domain => node.url.includes(domain))) throw new Error('该 API 站点已被屏蔽');
            const index = db.apiNodes.findIndex(item => item.id === node.id);
            if (index >= 0) db.apiNodes[index] = node; else db.apiNodes.push(node);
            await saveGlobalSettings(['apiNodes']); await close(true); render(); showToast('API 节点已保存');
        } catch (error) { setStatus(error.message, true); }
    });
    document.getElementById('api-node-add-btn').addEventListener('click', () => open(null));
    document.getElementById('api-node-cancel-btn').addEventListener('click', () => close());
    document.getElementById('api-node-back-btn').addEventListener('click', event => {
        // This back button has draft-confirmation behavior of its own. Keep the
        // global delegated .back-btn handler from switching to a null target.
        event.preventDefault();
        event.stopPropagation();
        close();
    });
    document.getElementById('api-node-fetch-models').addEventListener('click', () => fetchApiNodeModels(readDraft, setStatus));
    document.getElementById('api-node-model-results').addEventListener('change', event => { el('model').value = event.target.value; });
    document.getElementById('api-node-test-btn').addEventListener('click', async () => {
        try { const node = readDraft(); await testApiNode(node); setStatus('连接成功，服务返回了有效响应'); }
        catch (error) { setStatus(`连接失败：${error.message}`, true); }
    });
    render();
}

function renderApiNodeConflicts() {
    const box = document.getElementById('api-node-conflicts');
    if (!box) return;
    box.replaceChildren();
    Object.keys(API_NODE_FEATURES).forEach(feature => {
        const nodes = (db.apiNodes || []).filter(node => node.enabled && node.features?.includes(feature));
        if (nodes.length < 2) return;
        const route = db.apiNodeRoutes?.[feature] || {};
        const row = document.createElement('div'); row.className = 'api-node-route';
        const label = document.createElement('span'); label.className = 'api-node-route-label'; label.textContent = `${API_NODE_FEATURES[feature]}有 ${nodes.length} 个节点，请指定路由`;
        const primary = document.createElement('select');
        primary.innerHTML = '<option value="">请选择主节点</option>';
        nodes.forEach(node => { const option = document.createElement('option'); option.value = node.id; option.textContent = node.name; primary.appendChild(option); });
        primary.value = nodes.some(node => node.id === route.primaryNodeId) ? route.primaryNodeId : '';
        const failure = document.createElement('select');
        failure.innerHTML = '<option value="">请选择失败处理</option><option value="manual">报错后由用户处理</option><option value="automatic">按节点列表自动尝试</option><option value="error">立即停止并报错</option>';
        failure.value = route.failureMode || '';
        const parameterMode = document.createElement('select');
        parameterMode.innerHTML = '<option value="node">参数跟随节点</option><option value="global">参数跟随主 API</option><option value="provider">参数交给渠道</option>';
        parameterMode.value = route.parameterMode || 'node';
        const save = async () => {
            db.apiNodeRoutes[feature] = { primaryNodeId: primary.value, failureMode: failure.value, parameterMode: parameterMode.value };
            await saveGlobalSettings(['apiNodeRoutes']); showToast('节点路由已保存');
        };
        primary.addEventListener('change', save); failure.addEventListener('change', save); parameterMode.addEventListener('change', save);
        row.append(label, primary, failure, parameterMode); box.appendChild(row);
    });
}

async function fetchApiNodeModels(readDraft, setStatus) {
    try {
        const node = readDraft();
        if (!node.protocol || !node.url) throw new Error('请先选择协议并填写地址');
        const result = await requestApiNodeModels(node);
        const select = document.getElementById('api-node-model-results'); select.replaceChildren();
        result.forEach(model => { const option = document.createElement('option'); option.value = model; option.textContent = model; select.appendChild(option); });
        const resultRow = document.getElementById('api-node-model-results-row');
        if (resultRow) resultRow.hidden = !result.length;
        if (result.length) { select.value = result[0]; document.getElementById('api-node-model').value = result[0]; }
        setStatus(result.length ? `已拉取 ${result.length} 个模型` : '接口未返回模型', !result.length);
    } catch (error) { setStatus(error.message, true); }
}

async function requestApiNodeModels(node) {
    let endpoint = node.modelEndpoint || `${node.url}/v1/models`;
    endpoint = endpoint.replace(/\{model\}/g, encodeURIComponent(node.model || '')).replace(/\{key\}/g, encodeURIComponent(getRandomValue(node.key || '')));
    if (node.protocol === 'gemini' && !node.modelEndpoint) endpoint = `${node.url}/v1beta/models?key=${encodeURIComponent(getRandomValue(node.key))}`;
    const headers = buildApiNodeHeaders(node, node.protocol !== 'gemini');
    const response = await fetch(endpoint, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
    const data = await response.json();
    return node.protocol === 'gemini' ? (data.models || []).map(item => item.name?.replace('models/', '')).filter(Boolean) : (data.data || data.models || []).map(item => item.id || item.name).filter(Boolean);
}

function buildApiNodeHeaders(node, json = true) {
    const headers = json ? { 'Content-Type': 'application/json' } : {};
    if (node.authMode === 'x-api-key' || node.protocol === 'anthropic') headers['x-api-key'] = getRandomValue(node.key || '');
    else if (node.authMode !== 'none' && node.protocol !== 'gemini' && node.key) headers.Authorization = `Bearer ${getRandomValue(node.key)}`;
    if (node.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    return Object.assign(headers, node.customHeaders || {});
}

async function testApiNode(node) {
    if (!node.protocol || !node.url || !node.model) throw new Error('请先完成协议、地址和模型');
    const config = { ...apiNodeToConfig(node), generationParams: null };
    let endpoint = config.chatEndpoint || `${config.url}/v1/chat/completions`;
    let headers = buildApiNodeHeaders(node);
    if (node.protocol === 'anthropic' && !config.chatEndpoint) endpoint = `${config.url}/v1/messages`;
    if (node.protocol === 'gemini' && !config.chatEndpoint) endpoint = `${config.url}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(getRandomValue(config.key))}`;
    const body = { model: config.model, messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 8, stream: false };
    await fetchAiResponse(config, body, headers, endpoint, false);
}

// 提取为全局函数以便复用
window.fetchAndPopulateGptModels = async (showToastFlag = true) => {
    const urlEl = document.getElementById('gpt-image-url');
    const keyEl = document.getElementById('gpt-image-key');
    const modelEl = document.getElementById('gpt-image-model');
    const modelSelectEl = document.getElementById('gpt-image-model-select');
    const fetchModelsBtn = document.getElementById('gpt-image-fetch-models-btn');

    // 如果是通过自动调用且没有 DOM，尝试从 db 中读取
    const apiUrl = urlEl ? urlEl.value.trim() : (db.gptImageSettings?.url || '');
    const apiKey = keyEl ? keyEl.value.trim() : (db.gptImageSettings?.key || '');

    if (!apiUrl || !apiKey) {
        if (showToastFlag) showToast('请先填写 GPT API 地址和 Key');
        return;
    }

    const blockedDomains = (typeof BLOCKED_API_DOMAINS !== 'undefined') ? BLOCKED_API_DOMAINS : [];
    if (blockedDomains.some(d => apiUrl.includes(d))) {
        if (showToastFlag) showToast('该API站点已被屏蔽');
        return;
    }

    const endpoint = `${apiUrl.replace(/\/$/, '')}/v1/models`;
    let origText = '';
    if (fetchModelsBtn) {
        fetchModelsBtn.disabled = true;
        origText = fetchModelsBtn.textContent;
        fetchModelsBtn.textContent = '拉取中…';
    }

    try {
        const resp = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const models = (json.data || []).map(m => m.id).filter(Boolean).sort();
        
        if (!models.length) {
            if (showToastFlag) showToast('未找到可用模型');
            if (modelSelectEl) modelSelectEl.innerHTML = '<option value="">未找到任何模型</option>';
            return;
        }

        const cur = modelEl ? modelEl.value : (db.gptImageSettings?.model || '');
        if (modelSelectEl) {
            modelSelectEl.innerHTML = '<option value="">— 请选择 —</option>';
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                modelSelectEl.appendChild(opt);
            });
            if (models.includes(cur)) modelSelectEl.value = cur;
        }
        if (showToastFlag) showToast(`成功拉取 ${models.length} 个模型`);
    } catch (err) {
        console.error('[GPT Image] 拉取模型失败:', err);
        if (showToastFlag) showToast('拉取模型失败：' + (err.message || '未知错误'));
        if (modelSelectEl) modelSelectEl.innerHTML = '<option value="">拉取失败</option>';
    } finally {
        if (fetchModelsBtn) {
            fetchModelsBtn.disabled = false;
            fetchModelsBtn.textContent = origText;
        }
    }
};

// --- 预设管理 ---

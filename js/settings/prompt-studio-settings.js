(function () {
    function estimateTokens(text) {
        const value = String(text || '');
        const chinese = (value.match(/[\u4e00-\u9fa5]/g) || []).length;
        return Math.ceil(chinese * 1.2 + (value.length - chinese) * 0.4);
    }

    function setupPromptStudioEditor() {
        const studio = window.PromptStudio;
        const room = db.magicRoom || (db.magicRoom = {});
        const root = document.getElementById('magic-room-prompt-editor');
        if (!studio || !root) return null;
        if (root.dataset.promptStudioReady === 'true') return window.PromptStudioUI || null;
        root.dataset.promptStudioReady = 'true';

        const itemPanel = document.getElementById('prompt-studio-items-panel');
        const sourcePanel = document.getElementById('prompt-studio-source-panel');
        const itemList = document.getElementById('prompt-studio-item-list');
        const status = document.getElementById('prompt-studio-status');
        const sourceTextarea = document.getElementById('magic-room-custom-prompt');
        const variablesDrawer = document.getElementById('prompt-studio-variables');
        const variableList = document.getElementById('prompt-studio-variable-list');
        const previewPanel = document.getElementById('prompt-studio-preview-panel');
        const previewCharacter = document.getElementById('prompt-studio-preview-character');
        const previewContent = document.getElementById('prompt-studio-preview-content');
        const previewMeta = document.getElementById('prompt-studio-preview-meta');
        const previewWarnings = document.getElementById('prompt-studio-preview-warnings');
        const modeButtons = [...root.querySelectorAll('[data-prompt-mode]')];

        let mode = room.promptEditMode || (Array.isArray(room.customPromptItems) && room.customPromptItems.length ? 'items' : (room.customPromptTemplate ? 'source' : 'items'));
        let items = studio.normalizeItems(room.customPromptItems);
        if (!items.length) items = studio.createDefaultItems();
        let expandedId = '';
        let activeTextarea = null;
        let dirty = false;

        function markDirty(message = '有未保存的修改') {
            dirty = true;
            status.textContent = message;
        }

        function setMode(nextMode, mark = true) {
            mode = nextMode === 'source' ? 'source' : 'items';
            modeButtons.forEach(button => button.classList.toggle('active', button.dataset.promptMode === mode));
            itemPanel.hidden = mode !== 'items';
            sourcePanel.hidden = mode !== 'source';
            variablesDrawer.hidden = true;
            previewPanel.hidden = true;
            if (mark) markDirty(mode === 'items' ? '已切换为条目编辑，保存后生效' : '已切换为完整源码，保存后生效');
        }

        function categoryOptions(selected) {
            const fragment = document.createDocumentFragment();
            Object.entries(studio.CATEGORY_LABELS).forEach(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                option.selected = value === selected;
                fragment.appendChild(option);
            });
            return fragment;
        }

        function conditionOptions(selected) {
            const conditions = [
                ['always', '始终生效'], ['characterTime', '已开启角色年龄或时区'], ['onlineRole', '开启纯线上角色'],
                ['weather', '有天气信息'], ['activeNode', '存在当前节点'], ['worldBefore', '世界书·前不为空'],
                ['worldMiddle', '世界书·中不为空'], ['worldAfter', '世界书·后不为空'], ['userContext', '用户设定不为空'],
                ['relationshipContext', '存在关系/手机功能上下文'], ['enhancementContext', '存在提醒/头像/活人运转'],
                ['memory', '共同回忆不为空'], ['statusPanel', '已开启状态栏'], ['bilingual', '已开启双语模式'],
                ['autoFavorite', '已开启角色自主收藏'], ['userFavorites', '角色可感知用户收藏']
            ];
            const fragment = document.createDocumentFragment();
            conditions.forEach(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                option.selected = value === selected;
                fragment.appendChild(option);
            });
            return fragment;
        }

        function createButton(text, className, onClick) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = className;
            button.textContent = text;
            button.addEventListener('click', onClick);
            return button;
        }

        async function confirmAction(message, title) {
            if (typeof customConfirm === 'function') return customConfirm(message, title);
            return false;
        }

        function renderItems() {
            itemList.replaceChildren();
            const defaultMap = new Map(studio.createDefaultItems().map(entry => [entry.id, entry]));
            items.forEach((entry, index) => {
                const card = document.createElement('div');
                card.className = 'prompt-studio-item';
                card.dataset.itemId = entry.id;

                const head = document.createElement('div');
                head.className = 'prompt-studio-item-head';
                const order = document.createElement('div');
                order.className = 'prompt-studio-order';
                const up = createButton('↑', '', () => moveItem(index, -1));
                const down = createButton('↓', '', () => moveItem(index, 1));
                up.disabled = index === 0;
                down.disabled = index === items.length - 1;
                order.append(up, down);

                const summary = document.createElement('div');
                summary.className = 'prompt-studio-item-summary';
                const name = document.createElement('div');
                name.className = 'prompt-studio-item-name';
                name.textContent = entry.name;
                const meta = document.createElement('div');
                meta.className = 'prompt-studio-item-meta';
                const category = document.createElement('span');
                category.textContent = studio.CATEGORY_LABELS[entry.category] || '自定义';
                const token = document.createElement('span');
                token.textContent = `约 ${estimateTokens(entry.content)} Token`;
                const condition = document.createElement('span');
                condition.textContent = entry.condition === 'always' ? '始终' : '条件生效';
                meta.append(category, token, condition);
                summary.append(name, meta);

                const toggleLabel = document.createElement('label');
                toggleLabel.className = 'kkt-switch prompt-studio-item-toggle';
                const toggle = document.createElement('input');
                toggle.type = 'checkbox';
                toggle.checked = entry.enabled;
                const slider = document.createElement('span');
                slider.className = 'kkt-slider';
                toggle.addEventListener('change', () => {
                    entry.enabled = toggle.checked;
                    markDirty();
                    renderItems();
                });
                toggleLabel.append(toggle, slider);
                const edit = createButton(expandedId === entry.id ? '收起' : '编辑', 'btn btn-small btn-secondary prompt-studio-edit-btn', () => {
                    expandedId = expandedId === entry.id ? '' : entry.id;
                    renderItems();
                });
                head.append(order, summary, toggleLabel, edit);
                card.appendChild(head);

                if (expandedId === entry.id) {
                    const editor = document.createElement('div');
                    editor.className = 'prompt-studio-item-editor';
                    const nameField = createField('条目名称');
                    const nameInput = document.createElement('input');
                    nameInput.type = 'text';
                    nameInput.value = entry.name;
                    nameInput.addEventListener('input', () => { entry.name = nameInput.value; markDirty(); name.textContent = entry.name || '未命名条目'; });
                    nameField.appendChild(nameInput);

                    const categoryField = createField('分类');
                    const categorySelect = document.createElement('select');
                    categorySelect.appendChild(categoryOptions(entry.category));
                    categorySelect.addEventListener('change', () => { entry.category = categorySelect.value; markDirty(); });
                    categoryField.appendChild(categorySelect);

                    const conditionField = createField('生效条件');
                    const conditionSelect = document.createElement('select');
                    conditionSelect.appendChild(conditionOptions(entry.condition));
                    conditionSelect.addEventListener('change', () => { entry.condition = conditionSelect.value; markDirty(); });
                    conditionField.appendChild(conditionSelect);

                    const contentField = createField('提示词内容');
                    const textarea = document.createElement('textarea');
                    textarea.value = entry.content;
                    textarea.addEventListener('focus', () => { activeTextarea = textarea; });
                    textarea.addEventListener('input', () => { entry.content = textarea.value; markDirty(); token.textContent = `约 ${estimateTokens(entry.content)} Token`; });
                    contentField.appendChild(textarea);

                    const actions = document.createElement('div');
                    actions.className = 'prompt-studio-editor-actions';
                    actions.appendChild(createButton('插入变量', 'btn btn-small btn-secondary', () => {
                        activeTextarea = textarea;
                        variablesDrawer.hidden = false;
                        previewPanel.hidden = true;
                    }));
                    if (defaultMap.has(entry.id)) {
                        actions.appendChild(createButton('恢复本条默认', 'btn btn-small btn-secondary', async () => {
                            if (!await confirmAction(`确定恢复“${entry.name}”的默认内容和条件吗？`, '恢复条目')) return;
                            items[index] = studio.clone(defaultMap.get(entry.id));
                            markDirty();
                            renderItems();
                        }));
                    }
                    actions.appendChild(createButton('复制条目', 'btn btn-small btn-secondary', () => {
                        const copy = studio.clone(entry);
                        copy.id = studio.uid('prompt-item');
                        copy.name = `${entry.name} 副本`;
                        copy.protected = false;
                        items.splice(index + 1, 0, copy);
                        expandedId = copy.id;
                        markDirty();
                        renderItems();
                    }));
                    if (!entry.protected) {
                        actions.appendChild(createButton('删除', 'btn btn-small btn-danger', async () => {
                            if (!await confirmAction(`确定删除条目“${entry.name}”吗？`, '删除条目')) return;
                            items.splice(index, 1);
                            expandedId = '';
                            markDirty();
                            renderItems();
                        }));
                    }
                    editor.append(nameField, categoryField, conditionField, contentField, actions);
                    card.appendChild(editor);
                }
                itemList.appendChild(card);
            });
            const enabledCount = items.filter(entry => entry.enabled).length;
            if (!dirty) status.textContent = `${items.length} 个条目，已启用 ${enabledCount} 个`;
        }

        function createField(labelText) {
            const field = document.createElement('div');
            field.className = 'prompt-studio-field';
            const label = document.createElement('label');
            label.textContent = labelText;
            field.appendChild(label);
            return field;
        }

        function moveItem(index, delta) {
            const target = index + delta;
            if (target < 0 || target >= items.length) return;
            [items[index], items[target]] = [items[target], items[index]];
            markDirty();
            renderItems();
        }

        function renderVariables() {
            variableList.replaceChildren();
            studio.VARIABLE_CATALOG.forEach(([, title, variables]) => {
                const group = document.createElement('div');
                group.className = 'prompt-studio-variable-group';
                const heading = document.createElement('div');
                heading.className = 'prompt-studio-variable-title';
                heading.textContent = title;
                const buttons = document.createElement('div');
                buttons.className = 'prompt-studio-variable-buttons';
                variables.forEach(([key, label]) => {
                    const button = createButton(`${label} ${key}`, 'prompt-studio-variable-btn', () => insertVariable(key));
                    button.title = key;
                    buttons.appendChild(button);
                });
                group.append(heading, buttons);
                variableList.appendChild(group);
            });
        }

        function insertVariable(key) {
            if (!activeTextarea || !document.body.contains(activeTextarea)) {
                showToast('请先展开一个条目并点击内容编辑框');
                return;
            }
            const start = activeTextarea.selectionStart ?? activeTextarea.value.length;
            const end = activeTextarea.selectionEnd ?? start;
            activeTextarea.setRangeText(key, start, end, 'end');
            activeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            activeTextarea.focus();
        }

        function populatePreviewCharacters() {
            const previous = previewCharacter.value;
            previewCharacter.replaceChildren();
            const characters = (db.characters || []).filter(character => character && character.id);
            characters.forEach(character => {
                const option = document.createElement('option');
                option.value = character.id;
                option.textContent = character.remarkName || character.realName || '未命名角色';
                previewCharacter.appendChild(option);
            });
            if (characters.some(character => character.id === previous)) previewCharacter.value = previous;
        }

        function renderPreview() {
            const character = (db.characters || []).find(entry => entry.id === previewCharacter.value);
            if (!character) {
                previewContent.textContent = '当前没有可用的私聊角色。';
                previewMeta.textContent = '无法解析动态变量';
                previewWarnings.textContent = '';
                return;
            }
            const result = studio.compileItems(character, items, { preview: true });
            previewContent.textContent = result.prompt || '（最终提示词为空）';
            previewMeta.textContent = `${result.details.filter(entry => entry.text).length} 个条目实际注入 · 约 ${estimateTokens(result.prompt)} Token`;
            previewWarnings.textContent = result.unresolved.length ? `未识别变量：${result.unresolved.map(key => `{{${key}}}`).join('、')}` : '';
        }

        modeButtons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.promptMode)));
        document.getElementById('prompt-studio-add-item').addEventListener('click', () => {
            const entry = { id: studio.uid('prompt-item'), name: '新条目', category: 'custom', content: '', condition: 'always', enabled: true, protected: false };
            items.push(entry);
            expandedId = entry.id;
            markDirty();
            renderItems();
        });
        document.getElementById('prompt-studio-open-variables').addEventListener('click', () => {
            variablesDrawer.hidden = false;
            previewPanel.hidden = true;
        });
        document.getElementById('prompt-studio-close-variables').addEventListener('click', () => { variablesDrawer.hidden = true; });
        document.getElementById('prompt-studio-preview').addEventListener('click', () => {
            populatePreviewCharacters();
            previewPanel.hidden = false;
            variablesDrawer.hidden = true;
            renderPreview();
        });
        document.getElementById('prompt-studio-close-preview').addEventListener('click', () => { previewPanel.hidden = true; });
        previewCharacter.addEventListener('change', renderPreview);
        document.getElementById('prompt-studio-reset-items').addEventListener('click', async () => {
            if (!await confirmAction('确定恢复全部默认条目吗？当前条目修改会被替换。', '恢复默认条目')) return;
            items = studio.createDefaultItems();
            expandedId = '';
            markDirty();
            renderItems();
        });
        sourceTextarea.addEventListener('input', () => markDirty());

        const api = {
            getDraft() {
                return { mode, items: studio.clone(items), template: sourceTextarea.value };
            },
            loadPreset(preset) {
                if (!preset) return;
                mode = preset.mode || (Array.isArray(preset.items) && preset.items.length ? 'items' : 'source');
                if (Array.isArray(preset.items) && preset.items.length) items = studio.normalizeItems(studio.clone(preset.items));
                sourceTextarea.value = preset.template || '';
                expandedId = '';
                dirty = true;
                setMode(mode, false);
                status.textContent = `已加载预设“${preset.name}”，保存后应用`;
                renderItems();
            },
            saveToDb() {
                room.promptEditMode = mode;
                room.customPromptItems = studio.clone(items);
                dirty = false;
                renderItems();
            },
            isDirty() { return dirty; }
        };
        window.PromptStudioUI = api;
        renderVariables();
        setMode(mode, false);
        renderItems();
        return api;
    }

    window.setupPromptStudioEditor = setupPromptStudioEditor;
})();

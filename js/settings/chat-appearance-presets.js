// 仅保存角色设置「主题颜色」至「头像圆角」之间的选项。
const chatAppearanceFields = [
    ['theme', 'setting-theme-color', 'value'],
    ['avatarMode', 'setting-avatar-mode', 'value'],
    ['titleLayout', 'setting-title-layout', 'value'],
    ['showTimestamp', 'setting-show-timestamp', 'checked'],
    ['timestampStyle', 'setting-timestamp-style', 'value'],
    ['timestampFormat', 'setting-timestamp-format', 'value'],
    ['showStatus', 'setting-show-status', 'checked'],
    ['showStatusUpdateMsg', 'setting-show-status-update-msg', 'checked'],
    ['showReminderMsg', 'setting-show-reminder-msg', 'checked'],
    ['showAvatarActionMsg', 'setting-show-avatar-action-msg', 'checked'],
    ['bubbleBlurEnabled', 'setting-bubble-blur', 'checked'],
    ['avatarRadius', 'setting-avatar-radius', 'radius']
];

function getChatAppearancePresets() {
    return Array.isArray(db.chatAppearancePresets) ? db.chatAppearancePresets : [];
}

function readChatAppearanceControls() {
    const values = {};
    for (const [key, id, kind] of chatAppearanceFields) {
        const control = document.getElementById(id);
        if (!control) return null;
        values[key] = kind === 'checked' ? control.checked
            : kind === 'radius' ? Number(control.value) : control.value;
    }
    return values;
}

function validateChatAppearanceValues(values) {
    if (!values || typeof values !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(colorThemes, values.theme)) return false;
    if (!['full', 'merge', 'kkt', 'hidden'].includes(values.avatarMode)) return false;
    if (!['left', 'center'].includes(values.titleLayout)) return false;
    if (!['bubble', 'avatar'].includes(values.timestampStyle)) return false;
    if (!['hm', 'hms', 'ymd'].includes(values.timestampFormat)) return false;
    if (!Number.isInteger(values.avatarRadius) || values.avatarRadius < 0 || values.avatarRadius > 50) return false;
    return chatAppearanceFields.every(([key, , kind]) => kind !== 'checked' || typeof values[key] === 'boolean');
}

function writeChatAppearanceControls(values) {
    for (const [key, id, kind] of chatAppearanceFields) {
        const control = document.getElementById(id);
        if (!control) continue;
        if (kind === 'checked') control.checked = values[key];
        else control.value = values[key];
    }
    const radiusLabel = document.getElementById('setting-avatar-radius-value');
    if (radiusLabel) radiusLabel.textContent = `${values.avatarRadius}%`;
}

function refreshCurrentChatAppearance(values) {
    const screen = document.getElementById('chat-room-screen');
    if (screen) {
        screen.classList.toggle('disable-blur', !values.bubbleBlurEnabled);
        screen.classList.toggle('show-timestamp', values.showTimestamp);
        screen.classList.remove('timestamp-side', 'timestamp-style-bubble', 'timestamp-style-avatar');
        screen.classList.add(`timestamp-style-${values.timestampStyle}`);
    }
    const header = document.getElementById('chat-room-header-default');
    if (header) header.classList.toggle('title-centered', values.titleLayout === 'center');
    const subtitle = document.getElementById('chat-room-subtitle');
    if (subtitle) subtitle.style.display = values.showStatus ? 'flex' : 'none';
    document.documentElement.style.setProperty('--chat-avatar-radius', `${values.avatarRadius}%`);
    if (typeof renderMessages === 'function') renderMessages(false, true);
}

async function applyChatAppearancePresetToCharacters(preset, ids) {
    if (!preset || !validateChatAppearanceValues(preset.values)) {
        showToast('预设数据无效');
        return false;
    }
    const idSet = new Set(ids);
    const targets = db.characters.filter(char => idSet.has(char.id));
    if (!targets.length) { showToast('请至少选择一个角色'); return false; }
    const values = Object.fromEntries(chatAppearanceFields.map(([key]) => [key, preset.values[key]]));
    const updated = targets.map(char => ({ ...char, ...values }));
    try {
        await dexieDB.transaction('rw', dexieDB.characters, () => dexieDB.characters.bulkPut(updated));
    } catch (error) {
        console.error('应用美化预设失败:', error);
        showToast('应用失败，角色设置未更新', 6000);
        return false;
    }
    targets.forEach(char => Object.assign(char, values));
    if (currentChatType === 'private' && idSet.has(currentChatId)) {
        writeChatAppearanceControls(values);
        refreshCurrentChatAppearance(values);
    }
    showToast(`已将「${preset.name}」应用到 ${targets.length} 个角色`);
    return true;
}

function setupChatAppearancePresets() {
    const byId = id => document.getElementById(id);
    const picker = byId('chat-appearance-preset-select');
    if (!picker) return;
    const nameModal = byId('chat-appearance-name-modal');
    const manageModal = byId('chat-appearance-manage-modal');
    const targetModal = byId('chat-appearance-target-modal');
    const confirmModal = byId('chat-appearance-confirm-modal');
    let nameMode = 'save';
    let editingId = '';
    let targetPresetId = '';
    let targetSelection = new Set();
    let confirmAction = null;

    const show = modal => modal.classList.add('visible');
    const hide = modal => modal.classList.remove('visible');
    const findPreset = id => getChatAppearancePresets().find(p => p.id === id);
    const selectedPreset = () => {
        const preset = findPreset(picker.value);
        if (!preset) showToast('请先选择美化预设');
        return preset;
    };

    function refreshPicker(id = picker.value) {
        picker.replaceChildren(new Option('选择预设', ''));
        for (const preset of getChatAppearancePresets()) picker.add(new Option(preset.name, preset.id));
        picker.value = findPreset(id) ? id : '';
    }

    async function persistPresets(next) {
        const before = db.chatAppearancePresets;
        db.chatAppearancePresets = next;
        const ok = await saveGlobalSettings(['chatAppearancePresets']);
        if (!ok) {
            db.chatAppearancePresets = before;
            return false;
        }
        return true;
    }

    function openNameModal(mode, id = '') {
        nameMode = mode;
        editingId = id;
        byId('chat-appearance-name-title').textContent = mode === 'rename' ? '重命名美化预设' : '保存美化预设';
        byId('chat-appearance-name-confirm').textContent = mode === 'rename' ? '确认修改' : '保存';
        byId('chat-appearance-name-input').value = mode === 'rename' ? (findPreset(id)?.name || '') : '';
        byId('chat-appearance-name-error').textContent = '';
        hide(manageModal);
        show(nameModal);
        byId('chat-appearance-name-input').focus();
    }

    async function confirmName() {
        const input = byId('chat-appearance-name-input');
        const name = input.value.trim();
        const error = byId('chat-appearance-name-error');
        if (!name) { error.textContent = '请输入预设名称'; return; }
        if (getChatAppearancePresets().some(p => p.id !== editingId && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            error.textContent = '已有同名预设，请换个名称';
            return;
        }
        const values = nameMode === 'save' ? readChatAppearanceControls() : null;
        if (nameMode === 'save' && !validateChatAppearanceValues(values)) {
            error.textContent = '当前美化设置不完整，请重试';
            return;
        }
        let next;
        let chosenId;
        if (nameMode === 'rename') {
            const existing = findPreset(editingId);
            if (!existing) { error.textContent = '预设不存在'; return; }
            next = getChatAppearancePresets().map(p => p.id === editingId ? { ...p, name } : p);
            chosenId = editingId;
        } else {
            chosenId = `appearance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            next = [...getChatAppearancePresets(), { id: chosenId, name, values }];
        }
        const button = byId('chat-appearance-name-confirm');
        button.disabled = true;
        try {
            if (!await persistPresets(next)) return;
            hide(nameModal);
            refreshPicker(chosenId);
            if (nameMode === 'rename') { renderManageList(); show(manageModal); }
            showToast(nameMode === 'rename' ? '预设已重命名' : '美化预设已保存');
        } finally {
            button.disabled = false;
        }
    }

    function openConfirm(title, message, action, buttonText = '确认') {
        byId('chat-appearance-confirm-title').textContent = title;
        byId('chat-appearance-confirm-message').textContent = message;
        byId('chat-appearance-confirm-ok').textContent = buttonText;
        confirmAction = action;
        hide(manageModal);
        show(confirmModal);
    }

    function renderManageList() {
        const list = byId('chat-appearance-manage-list');
        list.replaceChildren();
        const presets = getChatAppearancePresets();
        if (!presets.length) {
            const empty = document.createElement('p');
            empty.className = 'chat-appearance-modal-note';
            empty.textContent = '暂无美化预设';
            list.appendChild(empty);
        }
        for (const preset of presets) {
            const row = document.createElement('div');
            row.className = 'chat-appearance-manage-row';
            const label = document.createElement('span');
            label.textContent = preset.name;
            row.appendChild(label);
            for (const [text, handler] of [
                ['重命名', () => openNameModal('rename', preset.id)],
                ['覆盖', () => openConfirm('覆盖美化预设', `用当前页面的美化设置覆盖「${preset.name}」？`, async () => {
                    const values = readChatAppearanceControls();
                    if (!validateChatAppearanceValues(values)) { showToast('当前美化设置不完整'); return false; }
                    const next = getChatAppearancePresets().map(p => p.id === preset.id ? { ...p, values } : p);
                    if (!await persistPresets(next)) return false;
                    showToast('预设已更新');
                    return true;
                }, '覆盖')],
                ['删除', () => openConfirm('删除美化预设', `确定删除「${preset.name}」？已应用到角色的设置不会改变。`, async () => {
                    if (!await persistPresets(getChatAppearancePresets().filter(p => p.id !== preset.id))) return false;
                    refreshPicker();
                    showToast('预设已删除');
                    return true;
                }, '删除')]
            ]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-small btn-secondary';
                button.textContent = text;
                button.addEventListener('click', handler);
                row.appendChild(button);
            }
            list.appendChild(row);
        }
    }

    function updateTargetCount() {
        const total = db.characters.length;
        const count = targetSelection.size;
        const all = byId('chat-appearance-select-all');
        all.checked = total > 0 && count === total;
        all.indeterminate = count > 0 && count < total;
        byId('chat-appearance-target-count').textContent = `已选择 ${count} / ${total} 个角色；只会覆盖主题颜色至头像圆角的设置`;
        const button = byId('chat-appearance-target-confirm');
        button.textContent = `应用到 ${count} 个角色`;
        button.disabled = count === 0;
    }

    function renderTargetList() {
        const list = byId('chat-appearance-target-list');
        const query = byId('chat-appearance-target-search').value.trim().toLocaleLowerCase();
        list.replaceChildren();
        let visible = 0;
        for (const char of db.characters) {
            const name = char.remarkName || char.realName || char.name || '未命名角色';
            if (query && !name.toLocaleLowerCase().includes(query)) continue;
            visible++;
            const row = document.createElement('label');
            row.className = 'chat-appearance-target-row';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = targetSelection.has(char.id);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) targetSelection.add(char.id);
                else targetSelection.delete(char.id);
                updateTargetCount();
            });
            const text = document.createElement('span');
            text.textContent = name;
            row.append(checkbox, text);
            list.appendChild(row);
        }
        if (!visible) {
            const empty = document.createElement('p');
            empty.className = 'chat-appearance-modal-note';
            empty.textContent = query ? '没有找到匹配的角色' : '暂无角色';
            list.appendChild(empty);
        }
        updateTargetCount();
    }

    function openTargets(all) {
        const preset = selectedPreset();
        if (!preset) return;
        if (!db.characters.length) { showToast('暂无可应用的角色'); return; }
        targetPresetId = preset.id;
        targetSelection = new Set(all ? db.characters.map(char => char.id) : []);
        byId('chat-appearance-target-search').value = '';
        renderTargetList();
        show(targetModal);
    }

    byId('chat-appearance-preset-save').addEventListener('click', () => openNameModal('save'));
    byId('chat-appearance-preset-manage').addEventListener('click', () => { renderManageList(); show(manageModal); });
    byId('chat-appearance-preset-apply-current').addEventListener('click', async () => {
        const preset = selectedPreset();
        if (preset && currentChatType === 'private') await applyChatAppearancePresetToCharacters(preset, [currentChatId]);
    });
    byId('chat-appearance-preset-apply-selected').addEventListener('click', () => openTargets(false));
    byId('chat-appearance-preset-apply-all').addEventListener('click', () => openTargets(true));
    byId('chat-appearance-name-cancel').addEventListener('click', () => {
        hide(nameModal);
        if (nameMode === 'rename') { renderManageList(); show(manageModal); }
    });
    byId('chat-appearance-name-confirm').addEventListener('click', confirmName);
    byId('chat-appearance-name-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); confirmName(); }
    });
    byId('chat-appearance-manage-close').addEventListener('click', () => hide(manageModal));
    byId('chat-appearance-confirm-cancel').addEventListener('click', () => {
        hide(confirmModal);
        confirmAction = null;
        renderManageList();
        show(manageModal);
    });
    byId('chat-appearance-confirm-ok').addEventListener('click', async () => {
        if (!confirmAction) return;
        const button = byId('chat-appearance-confirm-ok');
        button.disabled = true;
        try {
            if (await confirmAction()) {
                hide(confirmModal);
                confirmAction = null;
                renderManageList();
                show(manageModal);
            }
        } finally {
            button.disabled = false;
        }
    });
    byId('chat-appearance-select-all').addEventListener('change', event => {
        targetSelection = new Set(event.target.checked ? db.characters.map(char => char.id) : []);
        renderTargetList();
    });
    byId('chat-appearance-target-search').addEventListener('input', renderTargetList);
    byId('chat-appearance-target-cancel').addEventListener('click', () => hide(targetModal));
    byId('chat-appearance-target-confirm').addEventListener('click', async () => {
        const button = byId('chat-appearance-target-confirm');
        button.disabled = true;
        try {
            if (await applyChatAppearancePresetToCharacters(findPreset(targetPresetId), targetSelection)) hide(targetModal);
        } finally {
            updateTargetCount();
        }
    });
    for (const modal of [nameModal, manageModal, targetModal, confirmModal]) {
        modal.addEventListener('click', event => { if (event.target === modal) hide(modal); });
    }
    refreshPicker('');
}

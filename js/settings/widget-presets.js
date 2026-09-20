const DEFAULT_HOME_SIGNATURE = '编辑个性签名...';
const DEFAULT_INS_WIDGET = { avatar1: 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg', bubble1: 'love u.', avatar2: 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg', bubble2: 'miss u.' };

function _getWidgetWallpaperPresets() {
    return db.widgetWallpaperPresets || [];
}
function _saveWidgetWallpaperPresets(arr) {
    db.widgetWallpaperPresets = arr || [];
    saveData();
}

function _captureCurrentWidgetWallpaperScheme() {
    // 收集当前角色的偷看图标
    let peekCustomIcons = {};
    if (typeof currentChatId !== 'undefined' && db.characters) {
        const char = db.characters.find(c => c.id === currentChatId);
        if (char && char.peekScreenSettings && char.peekScreenSettings.customIcons) {
            peekCustomIcons = JSON.parse(JSON.stringify(char.peekScreenSettings.customIcons));
        }
    }
    return {
        wallpaper: db.wallpaper || DEFAULT_WALLPAPER_URL,
        homeWidgetSettings: JSON.parse(JSON.stringify(db.homeWidgetSettings || {})),
        homeSignature: db.homeSignature !== undefined ? db.homeSignature : DEFAULT_HOME_SIGNATURE,
        insWidgetSettings: JSON.parse(JSON.stringify(db.insWidgetSettings || DEFAULT_INS_WIDGET)),
        customIcons: JSON.parse(JSON.stringify(db.customIcons || {})),
        customAppNames: JSON.parse(JSON.stringify(db.customAppNames || {})),
        peekCustomIcons: peekCustomIcons
    };
}

function populateWidgetWallpaperPresetSelect() {
    const sel = document.getElementById('widget-wallpaper-preset-select');
    if (!sel) return;
    const presets = _getWidgetWallpaperPresets();
    sel.innerHTML = '<option value="">— 选择方案 —</option>';
    presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        sel.appendChild(opt);
    });
}

function saveCurrentWidgetWallpaperAsPreset() {
    const scheme = _captureCurrentWidgetWallpaperScheme();
    const name = prompt('请输入方案名称（将覆盖同名方案）：');
    if (!name || !name.trim()) return;
    const presets = _getWidgetWallpaperPresets();
    const idx = presets.findIndex(p => p.name === name.trim());
    const preset = { name: name.trim(), ...scheme };
    if (idx >= 0) presets[idx] = preset;
    else presets.push(preset);
    _saveWidgetWallpaperPresets(presets);
    populateWidgetWallpaperPresetSelect();
    showToast('方案已保存到预设库');
}

function applyWidgetWallpaperPreset(name) {
    const presets = _getWidgetWallpaperPresets();
    const p = presets.find(x => x.name === name);
    if (!p) return showToast('未找到该方案');
    db.wallpaper = p.wallpaper || DEFAULT_WALLPAPER_URL;
    if (typeof applyWallpaper === 'function') applyWallpaper(db.wallpaper);
    db.homeWidgetSettings = JSON.parse(JSON.stringify(p.homeWidgetSettings || {}));
    db.homeSignature = p.homeSignature !== undefined ? p.homeSignature : DEFAULT_HOME_SIGNATURE;
    db.insWidgetSettings = JSON.parse(JSON.stringify(p.insWidgetSettings || DEFAULT_INS_WIDGET));
    if (p.customIcons && typeof p.customIcons === 'object') {
        db.customIcons = JSON.parse(JSON.stringify(p.customIcons));
    }
    if (p.customAppNames && typeof p.customAppNames === 'object') {
        db.customAppNames = JSON.parse(JSON.stringify(p.customAppNames));
    }
    // 应用偷看图标
    if (p.peekCustomIcons && typeof p.peekCustomIcons === 'object' && Object.keys(p.peekCustomIcons).length > 0) {
        if (typeof currentChatId !== 'undefined' && db.characters) {
            const char = db.characters.find(c => c.id === currentChatId);
            if (char) {
                if (!char.peekScreenSettings) {
                    char.peekScreenSettings = { wallpaper: '', customIcons: {}, unlockAvatar: '', unlockCommentsEnabled: false, charAwarePeek: false, refreshCounts: {} };
                }
                char.peekScreenSettings.customIcons = JSON.parse(JSON.stringify(p.peekCustomIcons));
            }
        }
    }
    saveData();
    if (typeof setupHomeScreen === 'function') setupHomeScreen();
    if (typeof updatePolaroidImage === 'function' && db.homeWidgetSettings.polaroidImage) {
        updatePolaroidImage(db.homeWidgetSettings.polaroidImage);
    }
    const preview = document.getElementById('wallpaper-preview');
    if (preview) {
        preview.style.backgroundImage = `url(${db.wallpaper})`;
        preview.textContent = '';
    }
    renderCustomizeForm();
    showToast('已应用方案');
}

function openWidgetWallpaperManageModal() {
    const modal = document.getElementById('widget-wallpaper-presets-modal');
    const list = document.getElementById('widget-wallpaper-presets-list');
    if (!modal || !list) return;
    list.innerHTML = '';
    const presets = _getWidgetWallpaperPresets();
    if (!presets.length) {
        list.innerHTML = '<p style="color:#888;margin:6px 0;">暂无方案</p>';
    }
    presets.forEach((p, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0;';
        const nameDiv = document.createElement('div');
        nameDiv.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameDiv.textContent = p.name;
        row.appendChild(nameDiv);
        const btnWrap = document.createElement('div');
        btnWrap.style.cssText = 'display:flex;gap:8px;';
        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-primary';
        applyBtn.style.cssText = 'padding:6px 8px;border-radius:8px;';
        applyBtn.textContent = '应用';
        applyBtn.onclick = function () { applyWidgetWallpaperPreset(p.name); modal.style.display = 'none'; };
        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn';
        renameBtn.style.cssText = 'padding:6px 8px;border-radius:8px;';
        renameBtn.textContent = '重命名';
        renameBtn.onclick = function () {
            const newName = prompt('输入新名称：', p.name);
            if (!newName || !newName.trim()) return;
            const all = _getWidgetWallpaperPresets();
            all[idx].name = newName.trim();
            _saveWidgetWallpaperPresets(all);
            openWidgetWallpaperManageModal();
            populateWidgetWallpaperPresetSelect();
        };
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn';
        deleteBtn.style.cssText = 'padding:6px 8px;border-radius:8px;color:#e53935;';
        deleteBtn.textContent = '删除';
        deleteBtn.onclick = function () {
            if (!confirm('确认删除该方案？')) return;
            const all = _getWidgetWallpaperPresets();
            all.splice(idx, 1);
            _saveWidgetWallpaperPresets(all);
            openWidgetWallpaperManageModal();
            populateWidgetWallpaperPresetSelect();
        };
        btnWrap.appendChild(applyBtn);
        btnWrap.appendChild(renameBtn);
        btnWrap.appendChild(deleteBtn);
        row.appendChild(btnWrap);
        list.appendChild(row);
    });
    modal.style.display = 'flex';
}

function exportWidgetWallpaperScheme() {
    const presets = _getWidgetWallpaperPresets();
    const sel = document.getElementById('widget-wallpaper-preset-select');
    const chosen = sel && sel.value;
    let payload;
    if (chosen) {
        const p = presets.find(x => x.name === chosen);
        if (!p) return showToast('未找到所选方案');
        const schemeName = prompt('请输入导出方案名称（留空则使用预设名称）：', p.name);
        if (schemeName === null) return; // 用户取消
        const exportPreset = JSON.parse(JSON.stringify(p));
        if (schemeName.trim()) exportPreset.name = schemeName.trim();
        payload = { type: 'widget-wallpaper-scheme', version: 1, preset: exportPreset };
    } else {
        const current = _captureCurrentWidgetWallpaperScheme();
        const schemeName = prompt('请输入导出方案名称（留空则使用默认名称）：', '当前主屏');
        if (schemeName === null) return; // 用户取消
        const finalName = schemeName.trim() || '当前主屏';
        payload = { type: 'widget-wallpaper-scheme', version: 1, preset: { name: finalName, ...current } };
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (payload.preset.name || '主屏幕预设方案') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('方案已导出');
}

function importWidgetWallpaperScheme(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
        try {
            const data = JSON.parse(reader.result);
            if (!data || data.type !== 'widget-wallpaper-scheme' || !data.preset) {
                showToast('不是有效的主屏幕预设方案文件');
                return;
            }
            const preset = data.preset;
            const name = preset.name || '导入的方案';
            const presets = _getWidgetWallpaperPresets();
            const existingIdx = presets.findIndex(p => p.name === name);
            const toAdd = { name, wallpaper: preset.wallpaper, homeWidgetSettings: preset.homeWidgetSettings || {}, homeSignature: preset.homeSignature, insWidgetSettings: preset.insWidgetSettings || {}, customIcons: preset.customIcons || {}, customAppNames: preset.customAppNames || {}, peekCustomIcons: preset.peekCustomIcons || {} };
            if (existingIdx >= 0) presets[existingIdx] = toAdd;
            else presets.push(toAdd);
            _saveWidgetWallpaperPresets(presets);
            populateWidgetWallpaperPresetSelect();
            if (confirm('已加入预设库。是否立即应用该方案？')) {
                applyWidgetWallpaperPreset(name);
            } else {
                showToast('方案已导入到预设库');
            }
        } catch (e) {
            showToast('导入失败：' + (e.message || '文件格式错误'));
        }
    };
    reader.readAsText(file);
}

function resetWidgetWallpaperToDefault() {
    if (!confirm('确定要恢复默认吗？将清除当前所有主屏幕预设设置（小组件、壁纸、应用图标）。')) return;
    db.wallpaper = DEFAULT_WALLPAPER_URL;
    if (typeof applyWallpaper === 'function') applyWallpaper(DEFAULT_WALLPAPER_URL);
    db.homeWidgetSettings = JSON.parse(JSON.stringify(defaultWidgetSettings));
    db.homeSignature = DEFAULT_HOME_SIGNATURE;
    db.insWidgetSettings = JSON.parse(JSON.stringify(DEFAULT_INS_WIDGET));
    db.customIcons = {};
    db.customAppNames = {};
    // 同时清除当前角色的偷看图标
    if (typeof currentChatId !== 'undefined' && db.characters) {
        const char = db.characters.find(c => c.id === currentChatId);
        if (char && char.peekScreenSettings) {
            char.peekScreenSettings.customIcons = {};
        }
    }
    saveData();
    if (typeof setupHomeScreen === 'function') setupHomeScreen();
    const preview = document.getElementById('wallpaper-preview');
    if (preview) {
        preview.style.backgroundImage = `url(${DEFAULT_WALLPAPER_URL})`;
        preview.textContent = '';
    }
    renderCustomizeForm();
    showToast('已恢复默认（主屏幕预设）');
}

function _getIconPresets() {
    return db.iconPresets || [];
}
function _saveIconPresets(arr) {
    db.iconPresets = arr || [];
    saveData();
}

function populateIconPresetSelect() {
    const sel = document.getElementById('icon-preset-select');
    if (!sel) return;
    const presets = _getIconPresets();
    sel.innerHTML = '<option value="">— 选择预设 —</option>';
    presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        sel.appendChild(opt);
    });
}

function saveCurrentIconsAsPreset() {
    const customIcons = db.customIcons ? JSON.parse(JSON.stringify(db.customIcons)) : {};
    const name = prompt('请输入预设名称（将覆盖同名预设）：');
    if (!name) return;
    const presets = _getIconPresets();
    const idx = presets.findIndex(p => p.name === name);
    const preset = { name, customIcons };
    if (idx >= 0) presets[idx] = preset;
    else presets.push(preset);
    _saveIconPresets(presets);
    populateIconPresetSelect();
    showToast('图标预设已保存');
}

function applyIconPreset(name) {
    const presets = _getIconPresets();
    const p = presets.find(x => x.name === name);
    if (!p) return showToast('未找到该预设');
    db.customIcons = p.customIcons ? JSON.parse(JSON.stringify(p.customIcons)) : {};
    saveData();
    const iconIds = Object.keys(defaultIcons || {});
    iconIds.forEach(id => {
        const url = (db.customIcons && db.customIcons[id]) || (defaultIcons[id] && defaultIcons[id].url) || '';
        const input = document.querySelector(`input[data-icon-id="${id}"][type="url"]`);
        const preview = document.getElementById(`icon-preview-${id}`);
        if (input) input.value = url || '';
        if (preview) preview.src = url;
    });
    if (typeof setupHomeScreen === 'function') setupHomeScreen();
    showToast('已应用图标预设');
}

function openIconPresetManageModal() {
    const modal = document.getElementById('icon-presets-modal');
    const list = document.getElementById('icon-presets-list');
    if (!modal || !list) return;
    list.innerHTML = '';
    const presets = _getIconPresets();
    if (!presets.length) list.innerHTML = '<p style="color:#888;margin:6px 0;">暂无预设</p>';
    presets.forEach((p, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '8px 0';
        row.style.borderBottom = '1px solid #f0f0f0';
        const nameDiv = document.createElement('div');
        nameDiv.style.flex = '1';
        nameDiv.style.whiteSpace = 'nowrap';
        nameDiv.style.overflow = 'hidden';
        nameDiv.style.textOverflow = 'ellipsis';
        nameDiv.textContent = p.name;
        row.appendChild(nameDiv);
        const btnWrap = document.createElement('div');
        btnWrap.style.display = 'flex';
        btnWrap.style.gap = '6px';
        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-primary';
        applyBtn.style.padding = '6px 8px;border-radius:8px';
        applyBtn.textContent = '应用';
        applyBtn.onclick = function () { applyIconPreset(p.name); modal.style.display = 'none'; };
        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn';
        renameBtn.style.padding = '6px 8px;border-radius:8px';
        renameBtn.textContent = '重命名';
        renameBtn.onclick = function () {
            const newName = prompt('输入新名称：', p.name);
            if (!newName) return;
            const all = _getIconPresets();
            all[idx].name = newName;
            _saveIconPresets(all);
            openIconPresetManageModal();
            populateIconPresetSelect();
        };
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn';
        deleteBtn.style.padding = '6px 8px;border-radius:8px;color:#e53935';
        deleteBtn.textContent = '删除';
        deleteBtn.onclick = function () {
            if (!confirm('确认删除该预设？')) return;
            const all = _getIconPresets();
            all.splice(idx, 1);
            _saveIconPresets(all);
            openIconPresetManageModal();
            populateIconPresetSelect();
        };
        btnWrap.appendChild(applyBtn);
        btnWrap.appendChild(renameBtn);
        btnWrap.appendChild(deleteBtn);
        row.appendChild(btnWrap);
        list.appendChild(row);
    });
    modal.style.display = 'flex';
}

function _getNamePresets() {
    return db.namePresets || [];
}
function _saveNamePresets(arr) {
    db.namePresets = arr || [];
    saveData();
}

function populateNamePresetSelect() {
    const sel = document.getElementById('name-preset-select');
    if (!sel) return;
    const presets = _getNamePresets();
    sel.innerHTML = '<option value="">— 选择预设 —</option>';
    presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        sel.appendChild(opt);
    });
}

function saveCurrentNamesAsPreset() {
    const customAppNames = db.customAppNames ? JSON.parse(JSON.stringify(db.customAppNames)) : {};
    if (!Object.keys(customAppNames).length) return showToast('当前没有自定义名称，无法保存');
    const name = prompt('请输入预设名称（将覆盖同名预设）：');
    if (!name) return;
    const presets = _getNamePresets();
    const idx = presets.findIndex(p => p.name === name);
    const preset = { name, customAppNames };
    if (idx >= 0) presets[idx] = preset;
    else presets.push(preset);
    _saveNamePresets(presets);
    populateNamePresetSelect();
    showToast('名称预设已保存');
}

function applyNamePreset(name) {
    const presets = _getNamePresets();
    const p = presets.find(x => x.name === name);
    if (!p) return showToast('未找到该预设');
    db.customAppNames = p.customAppNames ? JSON.parse(JSON.stringify(p.customAppNames)) : {};
    saveData();
    if (typeof setupHomeScreen === 'function') setupHomeScreen();
    renderCustomizeForm();
    showToast('已应用名称预设');
}

function openNamePresetManageModal() {
    const modal = document.getElementById('name-presets-modal');
    const list = document.getElementById('name-presets-list');
    if (!modal || !list) return;
    list.innerHTML = '';
    const presets = _getNamePresets();
    if (!presets.length) list.innerHTML = '<p style="color:#888;margin:6px 0;">暂无预设</p>';
    presets.forEach((p, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0;';
        const nameDiv = document.createElement('div');
        nameDiv.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        nameDiv.textContent = p.name;
        row.appendChild(nameDiv);
        const btnWrap = document.createElement('div');
        btnWrap.style.cssText = 'display:flex;gap:6px;';
        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-primary';
        applyBtn.style.cssText = 'padding:6px 8px;border-radius:8px';
        applyBtn.textContent = '应用';
        applyBtn.onclick = function(){ applyNamePreset(p.name); modal.style.display = 'none'; };
        const renameBtn = document.createElement('button');
        renameBtn.className = 'btn';
        renameBtn.style.cssText = 'padding:6px 8px;border-radius:8px';
        renameBtn.textContent = '重命名';
        renameBtn.onclick = function(){
            const newName = prompt('输入新名称：', p.name);
            if (!newName) return;
            const all = _getNamePresets();
            all[idx].name = newName;
            _saveNamePresets(all);
            openNamePresetManageModal();
            populateNamePresetSelect();
        };
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn';
        deleteBtn.style.cssText = 'padding:6px 8px;border-radius:8px;color:#e53935';
        deleteBtn.textContent = '删除';
        deleteBtn.onclick = function(){
            if (!confirm('确认删除该预设？')) return;
            const all = _getNamePresets();
            all.splice(idx, 1);
            _saveNamePresets(all);
            openNamePresetManageModal();
            populateNamePresetSelect();
        };
        btnWrap.appendChild(applyBtn);
        btnWrap.appendChild(renameBtn);
        btnWrap.appendChild(deleteBtn);
        row.appendChild(btnWrap);
        list.appendChild(row);
    });
    modal.style.display = 'flex';
}


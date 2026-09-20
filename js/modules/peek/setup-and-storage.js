// --- 偷看手机功能 (js/modules/peek.js) ---

function parseXmlToJson(xmlString) {
    const match = xmlString.match(/<result>([\s\S]*?)<\/result>/i);
    const xmlContent = match ? match[0] : xmlString;

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlContent, "text/xml");
    
    const parseError = xmlDoc.getElementsByTagName("parsererror");
    if (parseError.length > 0) {
        throw new Error("XML 解析错误: " + parseError[0].textContent);
    }

    function parseNode(node) {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
            let text = node.textContent.trim();
            if (text === 'true') return true;
            if (text === 'false') return false;
            if (!isNaN(text) && text !== '') return Number(text);
            return text;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const children = Array.from(node.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE || ((n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE) && n.textContent.trim() !== ''));
            
            if (children.length === 0) return "";
            
            if (children.length === 1 && (children[0].nodeType === Node.TEXT_NODE || children[0].nodeType === Node.CDATA_SECTION_NODE)) {
                return parseNode(children[0]);
            }

            const obj = {};
            const isArrayMap = {};

            children.forEach(child => {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    const name = child.nodeName;
                    if (obj[name] !== undefined) {
                        if (!isArrayMap[name]) {
                            obj[name] = [obj[name]];
                            isArrayMap[name] = true;
                        }
                        obj[name].push(parseNode(child));
                    } else {
                        obj[name] = parseNode(child);
                    }
                }
            });

            for (const key in obj) {
                if (typeof obj[key] === 'object' && !Array.isArray(obj[key]) && obj[key] !== null) {
                    const subKeys = Object.keys(obj[key]);
                    if (subKeys.length === 1) {
                        const subKey = subKeys[0];
                        const listKeys = ['item', 'entry', 'photo', 'memo', 'thought', 'post', 'conversation', 'reply', 'message', 'comment'];
                        if (key.endsWith('s') || listKeys.includes(subKey) || key === 'history' || key === 'trajectory') {
                            if (Array.isArray(obj[key][subKey])) {
                                obj[key] = obj[key][subKey];
                            } else {
                                obj[key] = [obj[key][subKey]];
                            }
                        }
                    }
                }
            }
            return obj;
        }
        return null;
    }

    const result = parseNode(xmlDoc.documentElement);
    return xmlDoc.documentElement.nodeName === 'result' ? result : { [xmlDoc.documentElement.nodeName]: result };
}

/** 当前打开的偷看对话（代发消息时用于发送/API回复） */
let currentPeekConversation = null;
/** NPC 主动发来的好友申请（弹窗用） */
let peekPendingFriendRequestConversation = null;

function normalizePeekConversation(conv, index) {
    if (!conv) return;
    if (!conv.partnerId) conv.partnerId = 'peek_npc_' + Date.now() + '_' + (index != null ? index : Math.random().toString(36).slice(2, 10));
    if (typeof conv.suspicionLevel !== 'number') conv.suspicionLevel = 0;
    if (typeof conv.isFriend !== 'boolean') conv.isFriend = false;
    if (typeof conv.friendRequestPending !== 'boolean') conv.friendRequestPending = false;
    if (conv.supplementPersona == null) conv.supplementPersona = '';
    if (conv.partnerPersona == null) conv.partnerPersona = '';
    if (conv.partnerRelation == null) conv.partnerRelation = '熟人';
    if (!Array.isArray(conv.history)) conv.history = [];
}

function peekEscapeHtml(str) {
    if (str == null) return '';
    const s = String(str);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setupPeekFeature() {
    const peekBtn = document.getElementById('peek-btn');
    const peekConfirmModal = document.getElementById('peek-confirm-modal');
    const peekConfirmYes = document.getElementById('peek-confirm-yes');
    const peekConfirmNo = document.getElementById('peek-confirm-no');
    const peekSettingsBtn = document.getElementById('peek-settings-btn');
    const peekWallpaperModal = document.getElementById('peek-wallpaper-modal');
    const peekWallpaperUpload = document.getElementById('peek-wallpaper-upload');

    document.getElementById('clear-peek-data-btn')?.addEventListener('click', async () => {
        if (confirm('确定要清空该角色的所有偷看数据吗？清空后下次进入各应用将重新生成。')) {
            const char = db.characters.find(c => c.id === currentChatId);
            if (char) {
                char.peekData = {};
                char.peekViewedByUser = [];
                char.lastPeekViewedAt = undefined;
                await saveData();   
                showToast('偷看数据已清空');
            }
        }
    });

    peekBtn?.addEventListener('click', () => {
        if (currentChatType !== 'private') return;
        peekConfirmModal.classList.add('visible');
    });

    peekConfirmNo?.addEventListener('click', () => {
        peekConfirmModal.classList.remove('visible');
    });

    peekConfirmYes?.addEventListener('click', () => {
        peekConfirmModal.classList.remove('visible');
        renderPeekScreen(); 
        switchScreen('peek-screen');
    });

    peekSettingsBtn?.addEventListener('click', () => {
        renderPeekSettings();
        peekWallpaperModal.classList.add('visible');
    });

    peekWallpaperUpload?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            try {
                const compressedUrl = await compressImage(file, { quality: 0.85, maxWidth: 1080, maxHeight: 1920 });
                document.getElementById('peek-wallpaper-url-input').value = compressedUrl;
                showToast('图片已压缩并填入URL输入框');
            } catch (error) {
                showToast('壁纸压缩失败，请重试');
            }
        }
    });

    // 应用图标：本地上传（事件委托，因图标设置为动态渲染）
    document.addEventListener('change', async (e) => {
        if (e.target.classList.contains('peek-icon-file-upload')) {
            const file = e.target.files[0];
            const appId = e.target.dataset.appId;
            if (file && appId) {
                try {
                    const compressedUrl = await compressImage(file, { quality: 0.85, maxWidth: 512, maxHeight: 512 });
                    const urlInput = document.querySelector(`#peek-app-icons-settings input.peek-icon-url-input[data-app-id="${appId}"]`);
                    if (urlInput) urlInput.value = compressedUrl;
                    showToast('图标已压缩并填入输入框');
                } catch (err) {
                    showToast('图标压缩失败，请重试');
                }
            }
            e.target.value = '';
        }
    });

    // 应用图标：重置为默认
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('peek-icon-reset-btn')) {
            const appId = e.target.dataset.appId;
            const urlInput = document.querySelector(`#peek-app-icons-settings input.peek-icon-url-input[data-app-id="${appId}"]`);
            if (urlInput) {
                urlInput.value = '';
                showToast('已重置为默认图标');
            }
        }
        // 微博小号头像：重置为默认
        if (e.target.classList.contains('peek-unlock-avatar-reset-btn')) {
            const urlInput = document.getElementById('peek-unlock-avatar-url');
            if (urlInput) {
                urlInput.value = '';
                showToast('已重置为默认头像');
            }
        }
    });

    // 微博小号头像：本地上传
    document.addEventListener('change', async (e) => {
        if (e.target.classList.contains('peek-unlock-avatar-file-upload')) {
            const file = e.target.files[0];
            if (file) {
                try {
                    const compressedUrl = await compressImage(file, { quality: 0.85, maxWidth: 512, maxHeight: 512 });
                    const urlInput = document.getElementById('peek-unlock-avatar-url');
                    if (urlInput) {
                        urlInput.value = compressedUrl;
                        showToast('头像已压缩并填入输入框');
                    }
                } catch (err) {
                    showToast('头像压缩失败，请重试');
                }
            }
            e.target.value = '';
        }
    });

    document.getElementById('save-peek-settings-btn')?.addEventListener('click', async () => {
        const character = db.characters.find(c => c.id === currentChatId);
        if (!character) {
            showToast('错误：未找到当前角色');
            return;
        }

        if (!character.peekScreenSettings) {
            character.peekScreenSettings = { wallpaper: '', customIcons: {}, unlockAvatar: '', unlockCommentsEnabled: false, charAwarePeek: false, impersonateEnabled: false, refreshCounts: {}, browserDetailEnabled: false, browserDetailWords: { min: 200, max: 500 } };
        }

        character.peekScreenSettings.wallpaper = document.getElementById('peek-wallpaper-url-input').value.trim();

        const iconInputs = document.querySelectorAll('#peek-app-icons-settings input[type="url"]');
        iconInputs.forEach(input => {
            const appId = input.dataset.appId;
            const newUrl = input.value.trim();
            if (newUrl) {
                if (!character.peekScreenSettings.customIcons) {
                    character.peekScreenSettings.customIcons = {};
                }
                character.peekScreenSettings.customIcons[appId] = newUrl;
            } else {
                if (character.peekScreenSettings.customIcons) {
                    delete character.peekScreenSettings.customIcons[appId];
                }
            }
        });
        
        character.peekScreenSettings.unlockAvatar = document.getElementById('peek-unlock-avatar-url').value.trim();
        character.peekScreenSettings.unlockCommentsEnabled = document.getElementById('peek-unlock-comments-enabled').checked;
        const charAwarePeekEl = document.getElementById('peek-char-aware-peek-enabled');
        character.peekScreenSettings.charAwarePeek = charAwarePeekEl ? charAwarePeekEl.checked : false;
        const impersonateEl = document.getElementById('peek-impersonate-enabled');
        character.peekScreenSettings.impersonateEnabled = impersonateEl ? impersonateEl.checked : false;

        // 刷新条数：聊天、时光想说、备忘录
        if (!character.peekScreenSettings.refreshCounts) character.peekScreenSettings.refreshCounts = {};
        const parseNum = (id, defaultVal) => {
            const v = parseInt(document.getElementById(id)?.value, 10);
            return Number.isFinite(v) ? v : defaultVal;
        };
        character.peekScreenSettings.refreshCounts.messages = { min: parseNum('peek-refresh-min-messages', 3), max: parseNum('peek-refresh-max-messages', 5) };
        character.peekScreenSettings.refreshCounts.timeThoughts = { min: parseNum('peek-refresh-min-timeThoughts', 3), max: parseNum('peek-refresh-max-timeThoughts', 5) };
        character.peekScreenSettings.refreshCounts.memos = { min: parseNum('peek-refresh-min-memos', 3), max: parseNum('peek-refresh-max-memos', 4) };

        // 浏览器详情开关与字数
        const bdCheckbox = document.getElementById('peek-browser-detail-enabled');
        character.peekScreenSettings.browserDetailEnabled = bdCheckbox ? bdCheckbox.checked : false;
        if (!character.peekScreenSettings.browserDetailWords) {
            character.peekScreenSettings.browserDetailWords = { min: 200, max: 500 };
        }
        character.peekScreenSettings.browserDetailWords.min = parseNum('peek-browser-detail-min-words', 200);
        character.peekScreenSettings.browserDetailWords.max = parseNum('peek-browser-detail-max-words', 500);

        await saveData();
        renderPeekScreen(); 
        showToast('已保存！');
        peekWallpaperModal.classList.remove('visible');
    });

    peekWallpaperModal.addEventListener('click', (e) => {
        const header = e.target.closest('.collapsible-header');
        if (header) {
            header.parentElement.classList.toggle('open');
        }
    });

    const peekMessagesScreen = document.getElementById('peek-messages-screen');
    peekMessagesScreen.addEventListener('click', (e) => {
        const chatItem = e.target.closest('.chat-item');
        if (chatItem) {
            const partnerName = chatItem.dataset.name;
            const char = db.characters.find(c => c.id === currentChatId);
            const cachedData = char ? char.peekData.messages : null;
            if (cachedData && cachedData.conversations) {
                const conversation = cachedData.conversations.find(c => c.partnerName === partnerName);
                if (conversation) {
                    const idx = cachedData.conversations.indexOf(conversation);
                    normalizePeekConversation(conversation, idx);
                    currentPeekConversation = conversation;
                    renderPeekConversation(conversation);
                    switchScreen('peek-conversation-screen');
                } else {
                    showToast('找不到对话记录');
                }
            }
        } else if (e.target.closest('.action-btn')) {
            generateAndRenderPeekContent('messages', { forceRefresh: true });
        }
    });

    const peekConversationScreen = document.getElementById('peek-conversation-screen');
    peekConversationScreen.addEventListener('click', (e) => {
        if (e.target.closest('.action-btn') && !e.target.closest('#peek-impersonate-bar')) {
            generateAndRenderPeekContent('messages', { forceRefresh: true });
        }
    });

    document.getElementById('peek-impersonate-send-btn')?.addEventListener('click', sendPeekImpersonateMessage);
    document.getElementById('peek-impersonate-api-btn')?.addEventListener('click', requestPeekNPCReply);
    document.getElementById('peek-impersonate-friend-btn')?.addEventListener('click', peekAddNPCAsFriend);
    document.getElementById('peek-impersonate-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendPeekImpersonateMessage();
        }
    });
    document.getElementById('peek-friend-request-accept-btn')?.addEventListener('click', peekAcceptFriendRequest);
    document.getElementById('peek-friend-request-reject-btn')?.addEventListener('click', peekRejectFriendRequest);
    document.getElementById('peek-edit-persona-save-btn')?.addEventListener('click', savePeekEditPersona);
    document.getElementById('peek-edit-persona-cancel-btn')?.addEventListener('click', () => document.getElementById('peek-edit-persona-modal')?.classList.remove('visible'));

    const refreshAlbumBtn = document.getElementById('refresh-album-btn');
    if(refreshAlbumBtn) {
        refreshAlbumBtn.addEventListener('click', () => generateAndRenderPeekContent('album', { forceRefresh: true }));
    }

    const photoModal = document.getElementById('peek-photo-modal');
    if(photoModal) {
        photoModal.addEventListener('click', (e) => {
            if (e.target === photoModal) {
                photoModal.classList.remove('visible');
            }
        });
    }

    document.getElementById('refresh-all-peek-apps-btn')?.addEventListener('click', () => refreshAllPeekApps());

    document.getElementById('manage-peek-data-btn')?.addEventListener('click', () => {
        renderPeekDataManagement();
        document.getElementById('peek-data-management-modal').classList.add('visible');
    });

    document.getElementById('close-peek-data-management-btn')?.addEventListener('click', () => {
        document.getElementById('peek-data-management-modal').classList.remove('visible');
    });

    document.getElementById('delete-selected-peek-data-btn')?.addEventListener('click', deleteSelectedPeekData);
    document.getElementById('delete-all-peek-data-btn')?.addEventListener('click', deleteAllPeekData);
}

async function refreshAllPeekApps() {
    const char = db.characters.find(c => c.id === currentChatId);
    if (!char) {
        showToast('错误：未找到当前角色');
        return;
    }

    const allAppIds = Object.keys(peekScreenApps);
    const confirmMessage = `确定要刷新所有应用吗？\n\n这将消耗 ${allAppIds.length} 次 API 调用，请留意您的 API 额度。\n刷新过程可能需要 1～2 分钟，请耐心等待。`;

    if (!confirm(confirmMessage)) {
        return;
    }

    showToast('开始批量刷新…');

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < allAppIds.length; i++) {
        const appId = allAppIds[i];
        const appName = peekScreenApps[appId].name;

        showToast(`正在刷新 ${appName}… (${i + 1}/${allAppIds.length})`);

        try {
            await generateAndRenderPeekContent(appId, { forceRefresh: true });
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error(`刷新 ${appName} 失败:`, error);
            failCount++;
        }
    }

    if (failCount === 0) {
        showToast(`✓ 全部刷新完成！已更新 ${successCount} 个应用`);
    } else {
        showToast(`刷新完成！成功: ${successCount}，失败: ${failCount}`);
    }

    renderPeekScreen();
}

function renderPeekDataManagement() {
    const char = db.characters.find(c => c.id === currentChatId);
    const peekDataList = document.getElementById('peek-data-list');
    if (!peekDataList) return;

    if (!char || !char.peekData || Object.keys(char.peekData).length === 0) {
        peekDataList.innerHTML = '<p style="text-align: center; color: #999; padding: 20px;">暂无已刷新的数据</p>';
        return;
    }

    let html = `
        <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #eee;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" id="select-all-peek-data" style="width: auto;">
                <span style="font-weight: bold;">全选</span>
            </label>
        </div>
    `;

    Object.keys(char.peekData).forEach(appId => {
        const appName = (peekScreenApps[appId] && peekScreenApps[appId].name) ? peekScreenApps[appId].name : appId;
        html += `
            <label class="peek-data-item" style="display: flex; align-items: center; gap: 8px; padding: 8px; cursor: pointer; border-radius: 4px;">
                <input type="checkbox" class="peek-data-checkbox" data-app-id="${peekEscapeHtml(appId)}" style="width: auto;">
                <span>${peekEscapeHtml(appName)} <span style="color: #999; font-size: 12px;">(已有数据)</span></span>
            </label>
        `;
    });

    peekDataList.innerHTML = html;

    const selectAll = document.getElementById('select-all-peek-data');
    if (selectAll) {
        selectAll.addEventListener('change', (e) => {
            const checkboxes = peekDataList.querySelectorAll('.peek-data-checkbox');
            checkboxes.forEach(cb => { cb.checked = e.target.checked; });
        });
    }

    peekDataList.querySelectorAll('.peek-data-item').forEach(label => {
        label.addEventListener('mouseenter', () => { label.style.backgroundColor = '#f0f0f0'; });
        label.addEventListener('mouseleave', () => { label.style.backgroundColor = 'transparent'; });
    });
}

async function deleteSelectedPeekData() {
    const char = db.characters.find(c => c.id === currentChatId);
    if (!char || !char.peekData) return;

    const selectedCheckboxes = document.querySelectorAll('.peek-data-checkbox:checked');
    if (selectedCheckboxes.length === 0) {
        showToast('请至少选择一个应用');
        return;
    }

    const appNames = Array.from(selectedCheckboxes).map(cb => {
        const appId = cb.dataset.appId;
        return (peekScreenApps[appId] && peekScreenApps[appId].name) ? peekScreenApps[appId].name : appId;
    }).join('、');

    if (!confirm('确定要删除以下应用的数据吗？\n\n' + appNames + '\n\n删除后下次点击将重新生成。')) {
        return;
    }

    selectedCheckboxes.forEach(cb => {
        const appId = cb.dataset.appId;
        delete char.peekData[appId];
        if (char.peekViewedByUser && char.peekViewedByUser.length > 0) {
            char.peekViewedByUser = char.peekViewedByUser.filter(e => e.appId !== appId);
        }
    });

    await saveData();
    showToast('已删除 ' + selectedCheckboxes.length + ' 个应用的数据');

    renderPeekDataManagement();

    if (!char.peekData || Object.keys(char.peekData).length === 0) {
        document.getElementById('peek-data-management-modal').classList.remove('visible');
    }
}

async function deleteAllPeekData() {
    const char = db.characters.find(c => c.id === currentChatId);
    if (!char || !char.peekData || Object.keys(char.peekData).length === 0) {
        showToast('没有可删除的数据');
        return;
    }

    const appCount = Object.keys(char.peekData).length;

    if (!confirm('确定要删除所有 ' + appCount + ' 个应用的偷看数据吗？\n\n删除后下次点击应用时将重新生成。')) {
        return;
    }

    char.peekData = {};
    char.peekViewedByUser = [];
    char.lastPeekViewedAt = undefined;
    await saveData();
    showToast('已清空所有偷看数据');

    document.getElementById('peek-data-management-modal').classList.remove('visible');
}

function renderPeekSettings() {
    const character = db.characters.find(c => c.id === currentChatId);
    const peekSettings = character?.peekScreenSettings || { wallpaper: '', customIcons: {}, unlockAvatar: '', unlockCommentsEnabled: false, charAwarePeek: false, impersonateEnabled: false, refreshCounts: {} };

    // 1. 设置壁纸输入框
    const wallpaperInput = document.getElementById('peek-wallpaper-url-input');
    if (wallpaperInput) {
        wallpaperInput.value = peekSettings.wallpaper || '';
    }

    // 2. 设置解锁头像输入框
    const unlockAvatarInput = document.getElementById('peek-unlock-avatar-url');
    if (unlockAvatarInput) {
        unlockAvatarInput.value = peekSettings.unlockAvatar || '';
    }

    const unlockCommentsCheckbox = document.getElementById('peek-unlock-comments-enabled');
    if (unlockCommentsCheckbox) {
        unlockCommentsCheckbox.checked = !!peekSettings.unlockCommentsEnabled;
    }

    const charAwarePeekCheckbox = document.getElementById('peek-char-aware-peek-enabled');
    if (charAwarePeekCheckbox) {
        charAwarePeekCheckbox.checked = !!peekSettings.charAwarePeek;
    }
    const impersonateCheckbox = document.getElementById('peek-impersonate-enabled');
    if (impersonateCheckbox) {
        impersonateCheckbox.checked = !!peekSettings.impersonateEnabled;
    }

    // 3. 生成应用图标设置（支持 URL、本地上传、重置）
    const container = document.getElementById('peek-app-icons-settings');
    if (container) {
        container.innerHTML = '';
        Object.keys(peekScreenApps).forEach(appId => {
            const appData = peekScreenApps[appId];
            const currentIcon = peekSettings.customIcons?.[appId] || '';
            const safeValue = peekEscapeHtml(currentIcon);

            const div = document.createElement('div');
            div.className = 'form-group';
            div.innerHTML = `
                <label>${peekEscapeHtml(appData.name)} 图标</label>
                <input type="url" data-app-id="${appId}" class="peek-icon-url-input" value="${safeValue}" placeholder="粘贴图片URL">
                <p style="text-align:center; color:#888; margin: -10px 0 10px;">或</p>
                <input type="file" id="peek-icon-upload-${appId}" class="peek-icon-file-upload" accept="image/*" style="display:none;" data-app-id="${appId}">
                <label for="peek-icon-upload-${appId}" class="btn btn-secondary" style="width:100%; margin-bottom: 10px;">从本地上传</label>
                <button type="button" class="btn btn-neutral peek-icon-reset-btn" data-app-id="${appId}" style="width:100%;">重置为默认图标</button>
            `;
            container.appendChild(div);
        });
    }

    // 4. 刷新条数：聊天、时光想说、备忘录
    const defaults = { messages: { min: 3, max: 5 }, timeThoughts: { min: 3, max: 5 }, memos: { min: 3, max: 4 } };
    const rc = peekSettings.refreshCounts || {};
    ['messages', 'timeThoughts', 'memos'].forEach(appType => {
        const d = defaults[appType];
        const c = rc[appType] || d;
        const minEl = document.getElementById(`peek-refresh-min-${appType}`);
        const maxEl = document.getElementById(`peek-refresh-max-${appType}`);
        if (minEl) minEl.value = Number.isFinite(c.min) ? c.min : d.min;
        if (maxEl) maxEl.value = Number.isFinite(c.max) ? c.max : d.max;
    });

    // 浏览器详情开关与字数
    const browserDetailCheckbox = document.getElementById('peek-browser-detail-enabled');
    if (browserDetailCheckbox) browserDetailCheckbox.checked = !!peekSettings.browserDetailEnabled;
    const bWords = peekSettings.browserDetailWords || { min: 200, max: 500 };
    const minWordsEl = document.getElementById('peek-browser-detail-min-words');
    const maxWordsEl = document.getElementById('peek-browser-detail-max-words');
    if (minWordsEl) minWordsEl.value = Number.isFinite(bWords.min) ? bWords.min : 200;
    if (maxWordsEl) maxWordsEl.value = Number.isFinite(bWords.max) ? bWords.max : 500;
}

/** 当角色开启「知晓用户窥屏」时，记录用户刚查看的应用及内容，并更新 lastPeekViewedAt */
function recordPeekViewedByUser(char, appType) {
    if (!char || !char.peekScreenSettings?.charAwarePeek) return;
    const content = char.peekData?.[appType];
    if (!content) return;
    const appName = (peekScreenApps[appType] && peekScreenApps[appType].name) ? peekScreenApps[appType].name : appType;
    if (!char.peekViewedByUser) char.peekViewedByUser = [];
    const idx = char.peekViewedByUser.findIndex(e => e.appId === appType);
    const entry = { appId: appType, appName, content: JSON.parse(JSON.stringify(content)) };
    if (idx >= 0) char.peekViewedByUser[idx] = entry;
    else char.peekViewedByUser.push(entry);
    char.lastPeekViewedAt = Date.now();
}


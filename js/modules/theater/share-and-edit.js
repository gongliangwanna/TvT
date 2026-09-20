function showShareTheaterModal() {
    if (!currentTheaterScenarioId) return;

    const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
    if (!scenario) {
        showToast('找不到该剧情');
        return;
    }

    // 创建或获取模态框
    let modal = document.getElementById('theater-share-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'theater-share-modal';
        modal.className = 'theater-share-modal';
        modal.innerHTML = `
            <div class="theater-share-modal-content">
                <div class="theater-share-modal-header">
                    <h3>选择分享对象</h3>
                    <button class="theater-share-modal-close" id="theater-share-modal-close">×</button>
                </div>
                <div class="theater-share-modal-body">
                    <div class="theater-share-search">
                        <input type="text" id="theater-share-search-input" placeholder="搜索联系人..." class="theater-share-search-input">
                    </div>
                    <div class="theater-share-list" id="theater-share-list">
                        <!-- 联系人列表将在这里渲染 -->
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // 添加样式
        if (!document.getElementById('theater-share-modal-style')) {
            const style = document.createElement('style');
            style.id = 'theater-share-modal-style';
            style.textContent = `
                .theater-share-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    z-index: 10000;
                    display: none;
                    justify-content: center;
                    align-items: center;
                    backdrop-filter: blur(5px);
                }
                .theater-share-modal.visible {
                    display: flex;
                }
                .theater-share-modal-content {
                    background: #fff;
                    border-radius: 16px;
                    width: 90%;
                    max-width: 400px;
                    max-height: 80vh;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
                }
                .theater-share-modal-header {
                    padding: 20px;
                    border-bottom: 1px solid #f0f0f0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .theater-share-modal-header h3 {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 600;
                    color: #333;
                }
                .theater-share-modal-close {
                    border: none;
                    background: transparent;
                    font-size: 20px;
                    cursor: pointer;
                    color: #999;
                }
                .theater-share-modal-body {
                    padding: 15px 20px 20px;
                }
                .theater-share-search-input {
                    width: 100%;
                    padding: 8px 10px;
                    border-radius: 8px;
                    border: 1px solid #eee;
                    font-size: 14px;
                    margin-bottom: 10px;
                }
                .theater-share-list {
                    max-height: 300px;
                    overflow-y: auto;
                }
                .theater-share-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 8px 0;
                    cursor: pointer;
                    border-bottom: 1px solid #f5f5f5;
                }
                .theater-share-item:last-child {
                    border-bottom: none;
                }
                .theater-share-avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    object-fit: cover;
                }
                .theater-share-name {
                    font-size: 14px;
                    color: #333;
                }
                .theater-share-meta {
                    font-size: 12px;
                    color: #999;
                }
            `;
            document.head.appendChild(style);
        }
    }

    // 渲染联系人 / 群聊列表
    const list = document.getElementById('theater-share-list');
    const searchInput = document.getElementById('theater-share-search-input');
    const closeBtn = document.getElementById('theater-share-modal-close');

    if (!list || !searchInput || !closeBtn) return;

    const renderRecipients = (keyword = '') => {
        const normalizedKeyword = keyword.trim().toLowerCase();
        list.innerHTML = '';

        const contacts = db.characters || [];
        const groups = db.groups || [];

        const filteredContacts = normalizedKeyword
            ? contacts.filter(c => 
                (c.remarkName && c.remarkName.toLowerCase().includes(normalizedKeyword)) ||
                (c.realName && c.realName.toLowerCase().includes(normalizedKeyword))
            )
            : contacts;
        
        const filteredGroups = normalizedKeyword
            ? groups.filter(g => 
                (g.name && g.name.toLowerCase().includes(normalizedKeyword))
            )
            : groups;

        if (filteredContacts.length === 0 && filteredGroups.length === 0) {
            list.innerHTML = '<div style="padding: 10px; font-size: 13px; color: #999;">没有找到匹配的联系人或群聊</div>';
            return;
        }

        if (filteredContacts.length > 0) {
            const contactsTitle = document.createElement('div');
            contactsTitle.className = 'theater-share-section-title';
            contactsTitle.textContent = '联系人';
            list.appendChild(contactsTitle);
        }

        filteredContacts.forEach(char => {
            const item = document.createElement('div');
            item.className = 'theater-share-item';
            item.dataset.id = char.id;

            const rawStatus = char.status || (char.persona ? (char.persona.slice(0, 20) + (char.persona.length > 20 ? '...' : '')) : '');
            const statusText = rawStatus || '暂无状态';

            item.innerHTML = `
                <img src="${char.avatar || 'https://i.postimg.cc/HLXK1Z0L/chan-120.png'}" alt="${DOMPurify.sanitize(char.remarkName || char.realName || '角色')}" class="theater-share-avatar">
                <div class="theater-share-info">
                    <div class="theater-share-name">${DOMPurify.sanitize(char.remarkName || char.realName || '角色')}</div>
                    <div class="theater-share-meta">${DOMPurify.sanitize(statusText)}</div>
                </div>
            `;
            item.addEventListener('click', () => {
                shareTheaterToContact(char.id);
                modal.classList.remove('visible');
            });
            list.appendChild(item);
        });

        if (filteredGroups.length > 0) {
            const groupsTitle = document.createElement('div');
            groupsTitle.className = 'theater-share-section-title';
            groupsTitle.textContent = '群聊';
            list.appendChild(groupsTitle);
        }

        filteredGroups.forEach(group => {
            const item = document.createElement('div');
            item.className = 'theater-share-item';
            item.dataset.id = group.id;

            const memberCount = (group.members && group.members.length) ? group.members.length : 0;
            const metaText = `成员 ${memberCount} 人`;

            item.innerHTML = `
                <img src="${group.avatar || 'https://i.postimg.cc/fTLCngk1/image.jpg'}" alt="${DOMPurify.sanitize(group.name || '群聊')}" class="theater-share-avatar">
                <div class="theater-share-info">
                    <div class="theater-share-name">${DOMPurify.sanitize(group.name || '群聊')}</div>
                    <div class="theater-share-meta">${DOMPurify.sanitize(metaText)}</div>
                </div>
            `;
            item.addEventListener('click', () => {
                shareTheaterToGroup(group.id);
                modal.classList.remove('visible');
            });
            list.appendChild(item);
        });
    };

    renderRecipients();

    searchInput.oninput = (e) => {
        renderRecipients(e.target.value);
    };

    closeBtn.onclick = () => {
        modal.classList.remove('visible');
    };

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('visible');
        }
    });

    modal.classList.add('visible');
}

// 分享小剧场到指定联系人
async function shareTheaterToContact(charId) {
    if (!currentTheaterScenarioId) return;

    const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
    if (!scenario) {
        showToast('找不到该剧情');
        return;
    }

    const char = db.characters.find(c => c.id === charId);
    if (!char) {
        showToast('找不到联系人');
        return;
    }

    // 这里采用特殊占位格式，由 chat_render.js 识别并渲染为“小卡片”：
    // 实际内容只是一条短指令，不直接塞入长剧情，避免刷屏。
    const shareText = `[小剧场分享:${scenario.id}]`;

    const shareMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: shareText,
        timestamp: Date.now()
    };

    if (!char.history) {
        char.history = [];
    }
    char.history.push(shareMessage);

    await saveData();
    showToast(`已分享给 ${char.remarkName || char.realName || '联系人'}`);
}

// 分享小剧场到指定群聊
async function shareTheaterToGroup(groupId) {
    if (!currentTheaterScenarioId) return;

    const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
    if (!scenario) {
        showToast('找不到该剧情');
        return;
    }

    const group = (db.groups || []).find(g => g.id === groupId);
    if (!group) {
        showToast('找不到群聊');
        return;
    }

    const shareText = `[小剧场分享:${scenario.id}]`;
    const shareMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: shareText,
        timestamp: Date.now()
    };

    if (!group.history) {
        group.history = [];
    }
    group.history.push(shareMessage);

    await saveData();
    showToast(`已分享至群聊「${group.name || '群聊'}」`);
}

// 保存编辑后的剧情
async function saveEditScenario() {
    if (!currentTheaterScenarioId) return;

    const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
    if (!scenario) return;

    const contentInput = document.getElementById('theater-edit-content');
    const titleInput = document.getElementById('theater-edit-title');
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
    if (theaterCurrentMode === 'html') {
        showTheaterHtmlScenarioDetail(scenario);
    } else {
        showTheaterScenarioDetail(scenario);
    }
    renderTheaterScenarios();
}

// 删除剧情
async function deleteCurrentScenario() {
    if (!currentTheaterScenarioId) return;

    const scenarios = getTheaterScenarios();
    const index = scenarios.findIndex(s => s.id === currentTheaterScenarioId);
    if (index === -1) return;

    if (!confirm('确定要删除这条剧情吗？此操作不可撤销。')) return;

    scenarios.splice(index, 1);
    setTheaterScenarios(scenarios);
    await saveData();
    
    showToast('剧情已删除');
    switchScreen('theater-screen');
    renderTheaterScenarios();
    currentTheaterScenarioId = null;
}

// 收藏/取消收藏
async function toggleFavoriteScenario() {
    if (!currentTheaterScenarioId) return;

    const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
    if (!scenario) return;

    scenario.isFavorite = !scenario.isFavorite;
    await saveData();

    showToast(scenario.isFavorite ? '已收藏' : '已取消收藏');
    if (theaterCurrentMode === 'html') {
        showTheaterHtmlScenarioDetail(scenario);
    } else {
        showTheaterScenarioDetail(scenario);
    }
    renderTheaterScenarios();
}

// 修改分类
async function editScenarioCategory() {
    if (!currentTheaterScenarioId) return;

    const scenario = getTheaterScenarios().find(s => s.id === currentTheaterScenarioId);
    if (!scenario) return;

    const newCategory = prompt('请输入新的分类名称：', scenario.category || '未分类');
    if (newCategory === null) return;

    const trimmed = newCategory.trim();
    scenario.category = trimmed || '未分类';

    await saveData();
    showToast('分类已更新');
    if (theaterCurrentMode === 'html') {
        showTheaterHtmlScenarioDetail(scenario);
    } else {
        showTheaterScenarioDetail(scenario);
    }
    renderTheaterScenarios();
}

// 应用字体预设到指定元素
function applyTheaterFontPresetToElement(element, preset) {
    if (!element || !preset) return;
    
    // 创建或更新字体样式
    const styleId = 'theater-font-preset-style';
    let styleElement = document.getElementById(styleId);
    if (!styleElement) {
        styleElement = document.createElement('style');
        styleElement.id = styleId;
        document.head.appendChild(styleElement);
    }
    
    if (preset.url) {
        const fontName = 'TheaterCustomFont_' + preset.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
        const elementId = element.id || 'theater-content-element';
        styleElement.innerHTML = `
            @font-face {
                font-family: '${fontName}';
                src: url('${preset.url}');
            }
            #${elementId},
            .theater-detail-body {
                font-family: '${fontName}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
            }
        `;
    } else {
        // 如果没有字体URL，恢复默认字体
        const elementId = element.id || 'theater-content-element';
        styleElement.innerHTML = `
            #${elementId},
            .theater-detail-body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
            }
        `;
    }
}

// 保存提示词为预设（模式隔离）

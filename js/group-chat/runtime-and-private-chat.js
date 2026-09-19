// --- 群聊系统逻辑 (js/group_chat.js) ---

let gossipUnreadMap = {};

function setupGroupChatSystem() {
    const createGroupForm = document.getElementById('create-group-form');
    const groupSettingsForm = document.getElementById('group-settings-form');
    const createGroupModal = document.getElementById('create-group-modal');
    const memberSelectionList = document.getElementById('member-selection-list');
    const groupNameInput = document.getElementById('group-name-input');
    const groupMembersListContainer = document.getElementById('group-members-list-container');
    const addMemberActionSheet = document.getElementById('add-member-actionsheet');
    const editGroupMemberModal = document.getElementById('edit-group-member-modal');
    const editGroupMemberForm = document.getElementById('edit-group-member-form');
    const inviteExistingMemberBtn = document.getElementById('invite-existing-member-btn');
    const createNewMemberBtn = document.getElementById('create-new-member-btn');
    const inviteMemberModal = document.getElementById('invite-member-modal');
    const inviteMemberSelectionList = document.getElementById('invite-member-selection-list');
    const confirmInviteBtn = document.getElementById('confirm-invite-btn');
    const createMemberForGroupModal = document.getElementById('create-member-for-group-modal');
    const createMemberForGroupForm = document.getElementById('create-member-for-group-form');
    const groupRecipientSelectionModal = document.getElementById('group-recipient-selection-modal');
    const groupRecipientSelectionList = document.getElementById('group-recipient-selection-list');
    const confirmGroupRecipientBtn = document.getElementById('confirm-group-recipient-btn');
    const linkGroupWorldBookBtn = document.getElementById('link-group-world-book-btn');
    const worldBookSelectionModal = document.getElementById('world-book-selection-modal');
    const worldBookSelectionList = document.getElementById('world-book-selection-list');
    const peekBtn = document.getElementById('peek-btn');

    if (peekBtn) {
        peekBtn.addEventListener('click', () => {
            if (currentChatType !== 'group') return;
            const overlay = document.getElementById('private-chat-overlay');
            overlay.classList.add('visible');
            renderPrivateChatMonitor();
            // 打开时清除全局未读状态
            peekBtn.classList.remove('has-unread');
            document.getElementById('gossip-badge').style.display = 'none';
            // 清空未读计数数据
            gossipUnreadMap = {};
        });
    }

    if (createGroupForm) {
        createGroupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const selectedMemberIds = Array.from(memberSelectionList.querySelectorAll('input:checked')).map(input => input.value);
            const groupName = groupNameInput.value.trim();
            // if (selectedMemberIds.length < 1) return showToast('请至少选择一个群成员。'); // 允许创建空群
            if (!groupName) return showToast('请输入群聊名称。');
            const firstChar = db.characters.length > 0 ? db.characters[0] : null;
            const newGroup = {
                id: `group_${Date.now()}`,
                name: groupName,
                avatar: 'https://i.postimg.cc/fTLCngk1/image.jpg',
                me: {
                    nickname: (firstChar && firstChar.myName) ? firstChar.myName : 'user',
                    persona: firstChar ? firstChar.myPersona : '',
                    avatar: firstChar ? firstChar.myAvatar : 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg',
                    birthday: firstChar ? (firstChar.myBirthday || '') : '',
                    enableDynamicAge: firstChar ? (firstChar.myEnableDynamicAge || false) : false
                },
                members: selectedMemberIds.map(charId => {
                    const char = db.characters.find(c => c.id === charId);
                    return {
                        id: `member_${char.id}`,
                        originalCharId: char.id,
                        realName: char.realName,
                        groupNickname: char.remarkName,
                        persona: char.persona,
                        avatar: char.avatar
                    };
                }),
                theme: 'white_pink',
                maxMemory: 100,
                chatBg: '',
                history: [],
                pokeEnabled: false,
                isPinned: false,
                unreadCount: 0,
                useCustomBubbleCss: false,
                customBubbleCss: '',
                worldBookIds: [],
                allowGossip: false,
                privateSessions: {},
                // 群聊 <- 私聊：是否允许群聊中的角色读取其私聊记忆（默认关闭）
                syncPrivateMemory: false,
                privateMemoryHistoryCount: 20,
                privateMemorySummaryCount: 0
            };
            db.groups.push(newGroup);
            await saveGroup(newGroup.id);
            renderChatList();
            createGroupModal.classList.remove('visible');
            showToast(`群聊“${groupName}”创建成功！`);
        });
    }

    if (groupSettingsForm) {
        groupSettingsForm.addEventListener('submit', e => {
            e.preventDefault();
            saveGroupSettingsFromSidebar();
        });
    }

    // --- 自动保存逻辑 (Group Chat) ---
    const groupAutoSaveInputs = [
        'setting-group-name', 'setting-group-my-nickname', 'setting-group-my-persona',
        'setting-group-max-memory', 'setting-group-auto-journal-interval', 'setting-group-custom-bubble-css', 'setting-group-notice',
        'setting-group-poke-user-suffix',
        'setting-group-private-memory-history-count', 'setting-group-private-memory-summary-count'
    ];
    groupAutoSaveInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('blur', () => saveGroupSettingsFromSidebar(false));
    });

    const groupAutoSaveChanges = [
        'setting-group-theme-color', 'setting-group-use-custom-css', 'setting-group-show-timestamp',
        'setting-group-show-notice', 'setting-group-allow-gossip', 'setting-group-avatar-radius',
        'setting-group-bilingual-mode', 'setting-group-bilingual-style', 'setting-group-auto-journal-enabled',
        'setting-group-poke-enabled', 'setting-group-poke-character-initiated', 'setting-group-poke-member-to-member',
        'setting-group-poke-self', 'setting-group-poke-trigger-reply', 'setting-group-poke-effect-mode',
        'setting-group-poke-vibration', 'setting-group-poke-notification-mode', 'setting-group-poke-context',
        'setting-group-timestamp-format'
    ];
    groupAutoSaveChanges.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => saveGroupSettingsFromSidebar(false));
    });

    // 群聊角色私聊记忆互通（群聊 <- 私聊）
    const syncPrivateMemorySwitch = document.getElementById('setting-group-sync-private-memory');
    if (syncPrivateMemorySwitch) {
        syncPrivateMemorySwitch.addEventListener('change', (e) => {
            const historyContainer = document.getElementById('setting-group-private-memory-history-container');
            const summaryContainer = document.getElementById('setting-group-private-memory-summary-container');
            if (historyContainer) historyContainer.style.display = e.target.checked ? 'flex' : 'none';
            if (summaryContainer) summaryContainer.style.display = e.target.checked ? 'flex' : 'none';
            saveGroupSettingsFromSidebar(false);
        });
    }

    const showGroupNoticeCheckbox = document.getElementById('setting-group-show-notice');
    const groupNoticeTextarea = document.getElementById('setting-group-notice');
    if (showGroupNoticeCheckbox && groupNoticeTextarea) {
        showGroupNoticeCheckbox.addEventListener('change', (e) => {
            groupNoticeTextarea.disabled = !e.target.checked;
        });
    }

    const useGroupCustomCssCheckbox = document.getElementById('setting-group-use-custom-css'),
        groupCustomCssTextarea = document.getElementById('setting-group-custom-bubble-css'),
        resetGroupCustomCssBtn = document.getElementById('reset-group-custom-bubble-css-btn'),
        groupPreviewBox = document.getElementById('group-bubble-css-preview');
        
    if (useGroupCustomCssCheckbox) {
        useGroupCustomCssCheckbox.addEventListener('change', (e) => {
            groupCustomCssTextarea.disabled = !e.target.checked;
            const group = db.groups.find(g => g.id === currentChatId);
            if (group) {
                const theme = colorThemes[group.theme || 'white_pink'];
                updateBubbleCssPreview(groupPreviewBox, groupCustomCssTextarea.value, !e.target.checked, theme);
            }
        });
    }
    if (groupCustomCssTextarea) {
        groupCustomCssTextarea.addEventListener('input', (e) => {
            const group = db.groups.find(g => g.id === currentChatId);
            if (group && useGroupCustomCssCheckbox.checked) {
                const theme = colorThemes[group.theme || 'white_pink'];
                updateBubbleCssPreview(groupPreviewBox, e.target.value, false, theme);
            }
        });
    }
    if (resetGroupCustomCssBtn) {
        resetGroupCustomCssBtn.addEventListener('click', () => {
            const group = db.groups.find(g => g.id === currentChatId);
            if (group) {
                groupCustomCssTextarea.value = '';
                useGroupCustomCssCheckbox.checked = false;
                groupCustomCssTextarea.disabled = true;
                const theme = colorThemes[group.theme || 'white_pink'];
                updateBubbleCssPreview(groupPreviewBox, '', true, theme);
                showToast('样式已重置为默认');
            }
        });
    }

    const groupAvatarUpload = document.getElementById('setting-group-avatar-upload');
    if (groupAvatarUpload) {
        groupAvatarUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const compressedUrl = await compressImage(file, {quality: 0.8, maxWidth: 400, maxHeight: 400});
                    const group = db.groups.find(g => g.id === currentChatId);
                    if (group) {
                        group.avatar = compressedUrl;
                        document.getElementById('setting-group-avatar-preview').src = compressedUrl;
                        saveGroupSettingsFromSidebar(false);
                    }
                } catch (error) {
                    showToast('群头像压缩失败，请重试');
                }
            }
        });
    }

    const groupChatBgUpload = document.getElementById('setting-group-chat-bg-upload');
    if (groupChatBgUpload) {
        groupChatBgUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const compressedUrl = await compressImage(file, {
                        quality: 0.85,
                        maxWidth: 1080,
                        maxHeight: 1920
                    });
                    const group = db.groups.find(g => g.id === currentChatId);
                    if (group) {
                        group.chatBg = compressedUrl;
                        chatRoomScreen.style.backgroundImage = `url(${compressedUrl})`;
                        await saveGroup(group.id);
                        showToast('聊天背景已更换');
                    }
                } catch (error) {
                    showToast('群聊背景压缩失败，请重试');
                }
            }
        });
    }

    const clearGroupHistoryBtn = document.getElementById('clear-group-chat-history-btn');
    if (clearGroupHistoryBtn) {
        clearGroupHistoryBtn.addEventListener('click', async () => {
            const group = db.groups.find(g => g.id === currentChatId);
            if (!group) return;
            if (confirm(`你确定要清空群聊“${group.name}”的所有聊天记录吗？这个操作是不可恢复的！`)) {
                group.history = [];
                await saveGroup(group.id);
                renderMessages(false, true);
                renderChatList();
                showToast('聊天记录已清空');
            }
        });
    }

    if (groupMembersListContainer) {
        groupMembersListContainer.addEventListener('click', e => {
            const memberDiv = e.target.closest('.group-member');
            const addBtn = e.target.closest('.add-member-btn');
            if (memberDiv) {
                openGroupMemberEditModal(memberDiv.dataset.id);
            } else if (addBtn) {
                addMemberActionSheet.classList.add('visible');
            }
        });
    }

    const editMemberAvatarPreview = document.getElementById('edit-member-avatar-preview');
    if (editMemberAvatarPreview) {
        editMemberAvatarPreview.addEventListener('click', () => {
            document.getElementById('edit-member-avatar-upload').click();
        });
    }
    
    const editMemberAvatarUpload = document.getElementById('edit-member-avatar-upload');
    if (editMemberAvatarUpload) {
        editMemberAvatarUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const compressedUrl = await compressImage(file, {quality: 0.8, maxWidth: 400, maxHeight: 400});
                    document.getElementById('edit-member-avatar-preview').src = compressedUrl;
                } catch (error) {
                    showToast('成员头像压缩失败，请重试');
                }
            }
        });
    }

    if (editGroupMemberForm) {
        editGroupMemberForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const memberId = document.getElementById('editing-member-id').value;
            const group = db.groups.find(g => g.id === currentChatId);
            const member = group.members.find(m => m.id === memberId);
            if (member) {
                member.avatar = document.getElementById('edit-member-avatar-preview').src;
                member.groupNickname = document.getElementById('edit-member-group-nickname').value;
                member.realName = document.getElementById('edit-member-real-name').value;
                member.persona = document.getElementById('edit-member-persona').value;
                const pokeSuffixInput = document.getElementById('edit-member-poke-suffix');
                const pokeSuffix = window.PokeSystem ? window.PokeSystem.cleanSuffix(pokeSuffixInput && pokeSuffixInput.value) : ((pokeSuffixInput && pokeSuffixInput.value) || '').trim();
                if (pokeSuffix) member.pokeSuffix = pokeSuffix;
                else delete member.pokeSuffix;
                await saveGroup(group.id);
                renderGroupMembersInSettings(group);
                document.querySelectorAll(`.message-wrapper[data-sender-id="${member.id}"] .group-nickname`).forEach(el => {
                    el.textContent = member.groupNickname;
                });
                showToast('成员信息已更新');
            }
            editGroupMemberModal.classList.remove('visible');
        });
    }

    const removeGroupMemberBtn = document.getElementById('remove-group-member-btn');
    if (removeGroupMemberBtn) {
        removeGroupMemberBtn.addEventListener('click', async () => {
            const memberId = document.getElementById('editing-member-id').value;
            const group = db.groups.find(g => g.id === currentChatId);
            if (!group) return;
            const memberIndex = group.members.findIndex(m => m.id === memberId);
            if (memberIndex !== -1) {
                const member = group.members[memberIndex];
                if (confirm(`确定要将“${member.groupNickname}”移出群聊吗？`)) {
                    group.members.splice(memberIndex, 1);
                    
                    // 添加移出群聊的系统消息
                    const myName = group.me.nickname || '我';
                    const messageContent = `[${myName}已将${member.realName}移出群聊]`;
                    const message = {
                        id: `msg_${Date.now()}`,
                        role: 'user',
                        content: messageContent,
                        parts: [{type: 'text', text: messageContent}],
                        timestamp: Date.now(),
                        senderId: 'user_me'
                    };
                    group.history.push(message);

                    await saveGroup(group.id);
                    renderGroupMembersInSettings(group);
                    renderMessages(false, true);
                    showToast(`已将 ${member.groupNickname} 移出群聊`);
                    editGroupMemberModal.classList.remove('visible');
                }
            }
        });
    }

    if (inviteExistingMemberBtn) {
        inviteExistingMemberBtn.addEventListener('click', () => {
            renderInviteSelectionList();
            inviteMemberModal.classList.add('visible');
            addMemberActionSheet.classList.remove('visible');
        });
    }
    if (createNewMemberBtn) {
        createNewMemberBtn.addEventListener('click', () => {
            createMemberForGroupForm.reset();
            document.getElementById('create-group-member-avatar-preview').src = 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg';
            createMemberForGroupModal.classList.add('visible');
            addMemberActionSheet.classList.remove('visible');
        });
    }
    
    const createGroupMemberAvatarPreview = document.getElementById('create-group-member-avatar-preview');
    if (createGroupMemberAvatarPreview) {
        createGroupMemberAvatarPreview.addEventListener('click', () => {
            document.getElementById('create-group-member-avatar-upload').click();
        });
    }
    
    const createGroupMemberAvatarUpload = document.getElementById('create-group-member-avatar-upload');
    if (createGroupMemberAvatarUpload) {
        createGroupMemberAvatarUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const compressedUrl = await compressImage(file, {quality: 0.8, maxWidth: 400, maxHeight: 400});
                    document.getElementById('create-group-member-avatar-preview').src = compressedUrl;
                } catch (error) {
                    showToast('新成员头像压缩失败，请重试');
                }
            }
        });
    }

    if (confirmInviteBtn) {
        confirmInviteBtn.addEventListener('click', async () => {
            const group = db.groups.find(g => g.id === currentChatId);
            if (!group) return;
            const selectedCharIds = Array.from(inviteMemberSelectionList.querySelectorAll('input:checked')).map(input => input.value);
            selectedCharIds.forEach(charId => {
                const char = db.characters.find(c => c.id === charId);
                if (char) {
                    const newMember = {
                        id: `member_${char.id}`,
                        originalCharId: char.id,
                        realName: char.realName,
                        groupNickname: char.remarkName,
                        persona: char.persona,
                        avatar: char.avatar
                    };
                    group.members.push(newMember);
                    sendInviteNotification(group, newMember.realName);
                }
            });
            if (selectedCharIds.length > 0) {
                if (typeof saveGroup === 'function') await saveGroup(group.id);
                else await saveData();
                renderGroupMembersInSettings(group);
                renderMessages(false, true);
                showToast('已邀请新成员');
            }
            inviteMemberModal.classList.remove('visible');
        });
    }

    if (createMemberForGroupForm) {
        createMemberForGroupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const group = db.groups.find(g => g.id === currentChatId);
            if (!group) return;
            const newMember = {
                id: `member_group_only_${Date.now()}`,
                originalCharId: null,
                realName: document.getElementById('create-group-member-realname').value,
                groupNickname: document.getElementById('create-group-member-nickname').value,
                persona: document.getElementById('create-group-member-persona').value,
                avatar: document.getElementById('create-group-member-avatar-preview').src,
            };
            group.members.push(newMember);
            sendInviteNotification(group, newMember.realName);
            await saveGroup(group.id);
            renderGroupMembersInSettings(group);
            renderMessages(false, true);
            showToast(`新成员 ${newMember.groupNickname} 已加入`);
            createMemberForGroupModal.classList.remove('visible');
        });
    }

    const settingGroupMyAvatarUpload = document.getElementById('setting-group-my-avatar-upload');
    if (settingGroupMyAvatarUpload) {
        settingGroupMyAvatarUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const compressedUrl = await compressImage(file, {quality: 0.8, maxWidth: 400, maxHeight: 400});
                    document.getElementById('setting-group-my-avatar-preview').src = compressedUrl;
                    saveGroupSettingsFromSidebar(false);
                } catch (error) {
                    showToast('头像压缩失败')
                }
            }
        });
    }

    if (confirmGroupRecipientBtn) {
        confirmGroupRecipientBtn.addEventListener('click', () => {
            const selectedRecipientIds = Array.from(groupRecipientSelectionList.querySelectorAll('input:checked')).map(input => input.value);
            if (selectedRecipientIds.length === 0) {
                return showToast('请至少选择一个收件人。');
            }
            currentGroupAction.recipients = selectedRecipientIds;
            groupRecipientSelectionModal.classList.remove('visible');

            if (currentGroupAction.type === 'transfer') {
                document.getElementById('send-transfer-form').reset();
                document.getElementById('send-transfer-modal').classList.add('visible');
            } else if (currentGroupAction.type === 'gift') {
                document.getElementById('send-gift-form').reset();
                document.getElementById('send-gift-modal').classList.add('visible');
            }
        });
    }

    if (linkGroupWorldBookBtn) {
        linkGroupWorldBookBtn.addEventListener('click', () => {
            const group = db.groups.find(g => g.id === currentChatId);
            if (!group) return;
            const globalIds = (db.worldBooks || []).filter(wb => wb.isGlobal && !wb.disabled).map(wb => wb.id);
            const displayIds = [...new Set([...(group.worldBookIds || []), ...globalIds])];
            renderCategorizedWorldBookList(worldBookSelectionList, db.worldBooks, displayIds, 'wb-select-group');
            worldBookSelectionModal.classList.add('visible');
        });
    }

    setupGossipUI();
    setupPrivateChatEditModal();
    setupGossipInput();
}

// --- Gossip Mode UI Logic ---
let activePrivateSessionId = null; // Now stores "NameA_NameB"

// 迁移旧的 privateSessions 数据到 history
window.migratePrivateSessionsToHistory = function(group) {
    if (!group.privateSessions) return;
    
    let hasChanges = false;
    Object.values(group.privateSessions).forEach(session => {
        if (session.history && session.history.length > 0) {
            session.history.forEach(msg => {
                // 检查是否已存在（通过 id）
                const exists = group.history.some(hMsg => hMsg.id === msg.id);
                if (!exists) {
                    // 转换格式
                    let newMsg = { ...msg };
                    if (msg.isEndCommand) {
                        // 已经是 [Private-End: ...] 格式，保持原样
                    } else {
                        // 需要包装成 [Private: ...]
                        const receiver = session.memberNames.find(n => n !== msg.sender);
                        if (receiver) {
                            newMsg.content = `[Private: ${msg.sender} -> ${receiver}: ${msg.content}]`;
                            newMsg.parts = [{type: 'text', text: newMsg.content}];
                        }
                    }
                    // 确保 role 正确
                    if (!newMsg.role) newMsg.role = 'assistant'; 
                    
                    group.history.push(newMsg);
                    hasChanges = true;
                }
            });
        }
    });
    
    if (hasChanges) {
        group.history.sort((a, b) => a.timestamp - b.timestamp);
    }
    
    // 迁移完成后删除旧字段
    delete group.privateSessions;
    // 注意：调用此函数后，调用者应负责执行 saveData()
};

function setupGossipUI() {
    const titleEl = document.getElementById('chat-room-title');
    const overlay = document.getElementById('private-chat-overlay');
    const closeBtn = document.getElementById('private-window-close');
    const maxBtn = document.getElementById('private-window-maximize');
    const minBtn = document.getElementById('private-window-minimize');
    const browserWindow = document.querySelector('.browser-window');

    if (titleEl) {
        titleEl.addEventListener('dblclick', () => {
            if (currentChatType !== 'group') return;
            const group = db.groups.find(g => g.id === currentChatId);
            if (!group || !group.allowGossip) return;
            
            overlay.classList.toggle('visible');
            if (overlay.classList.contains('visible')) {
                renderPrivateChatMonitor();
            }
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            overlay.classList.remove('visible');
        });
    }

    if (maxBtn) {
        maxBtn.addEventListener('click', () => {
            browserWindow.classList.toggle('fullscreen');
        });
    }
    
    if (minBtn) {
        minBtn.addEventListener('click', () => {
            overlay.classList.remove('visible');
        });
    }

    // Tab switching delegation
    const tabsContainer = document.getElementById('private-chat-tabs');
    if (tabsContainer) {
        tabsContainer.addEventListener('click', (e) => {
            const tab = e.target.closest('.tab-open');
            const closeIcon = e.target.closest('.close-tab');
            
            if (closeIcon && tab) {
                e.stopPropagation();
                const sessionId = tab.dataset.id;
                closePrivateSession(sessionId);
            } else if (tab) {
                activePrivateSessionId = tab.dataset.id;
                renderPrivateChatMonitor();
            }
        });
    }
}

function renderPrivateChatMonitor() {
    const group = db.groups.find(g => g.id === currentChatId);
    if (!group) return;

    // 动态解析私聊会话
    const sessions = {}; // key: "NameA_NameB" (sorted)
    
    const privateRegex = /^\[Private: (.*?) -> (.*?): ([\s\S]+?)\]$/;
    const privateEndRegex = /^\[Private-End: (.*?) -> (.*?)\]$/;

    group.history.forEach(msg => {
        let sender, receiver, content, isEnd = false;
        
        const match = msg.content.match(privateRegex);
        const endMatch = msg.content.match(privateEndRegex);
        
        if (match) {
            sender = match[1];
            receiver = match[2];
            content = match[3];
        } else if (endMatch) {
            sender = endMatch[1];
            receiver = endMatch[2];
            isEnd = true;
        } else {
            return;
        }
        
        const members = [sender, receiver].sort();
        const key = members.join('_');
        
        if (!sessions[key]) {
            sessions[key] = {
                id: key,
                memberNames: members,
                history: [],
                status: 'active',
                lastTime: 0
            };
        }
        
        sessions[key].history.push({
            ...msg,
            displayContent: content, // 提取纯内容用于显示
            isEnd: isEnd
        });
        sessions[key].lastTime = msg.timestamp;
        
        if (isEnd) {
            sessions[key].status = 'ended';
        } else {
            sessions[key].status = 'active'; // 如果有新消息，重新激活
        }
    });

    const sessionList = Object.values(sessions).sort((a, b) => b.lastTime - a.lastTime);

    const tabsContainer = document.getElementById('private-chat-tabs');
    const contentContainer = document.getElementById('private-chat-content');
    const addressBar = document.getElementById('private-chat-title');
    const inputArea = document.getElementById('private-chat-input-area');

    // Auto-select first if none selected or selected is closed
    if (!activePrivateSessionId && sessionList.length > 0) {
        activePrivateSessionId = sessionList[0].id;
    } else if (activePrivateSessionId && !sessions[activePrivateSessionId]) {
        activePrivateSessionId = sessionList.length > 0 ? sessionList[0].id : null;
    }

    // Render Tabs
    tabsContainer.innerHTML = sessionList.map(s => {
        const isEnded = s.status === 'ended';
        return `
        <div class="tab-open ${s.id === activePrivateSessionId ? 'active' : ''}" data-id="${s.id}" style="${isEnded ? 'opacity: 0.7;' : ''}">
            <div class="rounded-l"><div class="mask-round"></div></div>
            <span>${isEnded ? '🔒 ' : ''}${s.memberNames.join(' & ')}</span>
            <div class="close-tab">✕</div>
            <div class="rounded-r"><div class="mask-round"></div></div>
        </div>
    `}).join('');

    // Render Content
    if (activePrivateSessionId && sessions[activePrivateSessionId]) {
        const session = sessions[activePrivateSessionId];
        addressBar.textContent = `Private Chat: ${session.memberNames.join(' & ')} ${session.status === 'ended' ? '(已结束)' : ''}`;
        
        // 检查是否包含“我”
        const myName = group.me.nickname;
        const isMyChat = session.memberNames.includes(myName);
        
        if (isMyChat && session.status !== 'ended') {
            if (inputArea) inputArea.classList.add('visible');
        } else {
            if (inputArea) inputArea.classList.remove('visible');
        }

        contentContainer.innerHTML = session.history.map((msg, index) => {
            if (msg.isEnd) {
                return `<div class="private-msg system"><div class="private-msg-bubble system">-- 会话结束 --</div></div>`;
            }

            // 解析发送者
            const privateMatch = msg.content.match(privateRegex);
            const sender = privateMatch ? privateMatch[1] : 'Unknown';
            
            // 如果是“我”发送的，显示在右侧；否则显示在左侧
            // 注意：对于 AI 之间的私聊，仍然保持原来的左右分布逻辑（基于 memberNames[0]）
            let alignClass = 'left';
            if (sender === myName) {
                alignClass = 'right';
            } else if (!isMyChat) {
                // AI 之间的私聊，第一个成员在左，第二个在右
                alignClass = (sender === session.memberNames[0]) ? 'left' : 'right';
            } else {
                // 与我私聊的 AI，显示在左侧
                alignClass = 'left';
            }
            
            return `
                <div class="private-msg ${alignClass}" ondblclick="window.openPrivateMsgEdit('${msg.id}')">
                    <div class="private-msg-sender">${sender}</div>
                    <div class="private-msg-bubble">${msg.displayContent}</div>
                </div>
            `;
        }).join('');
        
        // Scroll to bottom
        contentContainer.scrollTop = contentContainer.scrollHeight;
    } else {
        addressBar.textContent = 'Private Chat Monitor';
        contentContainer.innerHTML = '<div class="empty-state">暂无活跃的私聊会话</div>';
        if (inputArea) inputArea.classList.remove('visible');
    }
}

function closePrivateSession(sessionId) {
    if (!confirm('确定要结束这个私聊话题吗？')) return;

    const group = db.groups.find(g => g.id === currentChatId);
    if (!group) return;
    
    // sessionId is "NameA_NameB"
    const members = sessionId.split('_');
    if (members.length !== 2) return;
    
    const [sender, receiver] = members;
    
    // 添加结束消息
    const endContent = `[Private-End: ${sender} -> ${receiver}]`;
    const endMsg = {
        id: `msg_${Date.now()}`,
        role: 'assistant',
        content: endContent,
        parts: [{type: 'text', text: endContent}],
        timestamp: Date.now()
    };
    
    group.history.push(endMsg);
    saveGroup(group.id);
    renderPrivateChatMonitor();
}

function setupGossipInput() {
    const input = document.getElementById('private-chat-input');
    if (!input) return;

    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const content = input.value.trim();
            if (content) {
                sendGossipMessage(content);
                input.value = '';
            }
        }
    });
}

function sendGossipMessage(content) {
    const group = db.groups.find(g => g.id === currentChatId);
    if (!group || !activePrivateSessionId) return;

    const sessionMembers = activePrivateSessionId.split('_');
    const myName = group.me.nickname;
    
    // 确定接收者
    const targetName = sessionMembers.find(n => n !== myName);
    if (!targetName) return; // 异常情况

    const fullContent = `[Private: ${myName} -> ${targetName}: ${content}]`;
    
    const message = {
        id: `msg_${Date.now()}`,
        role: 'user', // 标记为用户发送
        content: fullContent,
        parts: [{type: 'text', text: fullContent}],
        timestamp: Date.now()
    };

    group.history.push(message);
    saveGroup(group.id);
    renderPrivateChatMonitor();
    
    // 注意：此处不自动触发 getAiReply，等待用户在主界面操作
}

// --- Private Chat Editing Logic ---
let editingPrivateMsgId = null;

function setupPrivateChatEditModal() {
    if (document.getElementById('private-msg-edit-modal')) return;

    const modalHTML = `
    <div id="private-msg-edit-modal" class="modal-overlay">
        <div class="modal-window">
            <h3>编辑私聊消息</h3>
            <form id="private-msg-edit-form">
                <div class="form-group">
                    <textarea id="private-msg-edit-textarea" rows="6" style="width:100%; resize:vertical; padding:10px; border-radius:8px; border:1px solid #ddd;"></textarea>
                </div>
                <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:15px;">
                    <button type="button" class="btn btn-neutral btn-small" id="private-msg-cancel-btn">取消</button>
                    <button type="button" class="btn btn-danger btn-small" id="private-msg-delete-btn">删除</button>
                    <button type="submit" class="btn btn-primary btn-small">保存</button>
                </div>
            </form>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    document.getElementById('private-msg-edit-form').addEventListener('submit', (e) => {
        e.preventDefault();
        savePrivateMsgEdit();
    });

    document.getElementById('private-msg-cancel-btn').addEventListener('click', () => {
        document.getElementById('private-msg-edit-modal').classList.remove('visible');
        editingPrivateMsgId = null;
    });

    document.getElementById('private-msg-delete-btn').addEventListener('click', () => {
        if (confirm('确定要删除这条私聊消息吗？')) {
            deletePrivateMsg();
        }
    });
}

window.openPrivateMsgEdit = function(msgId) {
    const group = db.groups.find(g => g.id === currentChatId);
    if (!group) return;
    
    const msg = group.history.find(m => m.id === msgId);
    if (!msg) return;

    editingPrivateMsgId = msgId;

    // 提取纯内容用于编辑
    const privateRegex = /^\[Private: (.*?) -> (.*?): ([\s\S]+?)\]$/;
    const match = msg.content.match(privateRegex);
    const displayContent = match ? match[3] : msg.content;

    document.getElementById('private-msg-edit-textarea').value = displayContent;
    document.getElementById('private-msg-edit-modal').classList.add('visible');
    document.getElementById('private-msg-edit-textarea').focus();
};

window.savePrivateMsgEdit = function() {
    if (!editingPrivateMsgId) return;
    
    const newContent = document.getElementById('private-msg-edit-textarea').value;
    const group = db.groups.find(g => g.id === currentChatId);
    
    if (group) {
        const msg = group.history.find(m => m.id === editingPrivateMsgId);
        if (msg) {
            // 重新包装
            const privateRegex = /^\[Private: (.*?) -> (.*?): ([\s\S]+?)\]$/;
            const match = msg.content.match(privateRegex);
            if (match) {
                const sender = match[1];
                const receiver = match[2];
                msg.content = `[Private: ${sender} -> ${receiver}: ${newContent}]`;
                msg.parts = [{type: 'text', text: msg.content}];
                
                saveGroup(group.id);
                renderPrivateChatMonitor();
                document.getElementById('private-msg-edit-modal').classList.remove('visible');
                showToast('私聊消息已更新');
            }
        }
    }
    
    editingPrivateMsgId = null;
};

window.deletePrivateMsg = function() {
    if (!editingPrivateMsgId) return;
    
    const group = db.groups.find(g => g.id === currentChatId);
    
    if (group) {
        group.history = group.history.filter(m => m.id !== editingPrivateMsgId);
        saveGroup(group.id);
        renderPrivateChatMonitor();
        document.getElementById('private-msg-edit-modal').classList.remove('visible');
        showToast('私聊消息已删除');
    }
    
    editingPrivateMsgId = null;
};

// 处理来自 AI 的私聊消息
function handleGossipMessage(group, content) {
    const privateRegex = /^\[Private: (.*?) -> (.*?): ([\s\S]+?)\]$/;
    const privateEndRegex = /^\[Private-End: (.*?) -> (.*?)\]$/;

    const privateMatch = content.match(privateRegex);
    const endMatch = content.match(privateEndRegex);

    if (privateMatch) {
        const sender = privateMatch[1];
        const receiver = privateMatch[2];
        const members = [sender, receiver].sort();
        const sessionId = members.join('_');
        
        const overlay = document.getElementById('private-chat-overlay');
        const isOverlayVisible = overlay.classList.contains('visible');

        // 如果窗口未打开，或者打开了但不是当前会话 -> 增加未读
        if (!isOverlayVisible || activePrivateSessionId !== sessionId) {
            gossipUnreadMap[sessionId] = (gossipUnreadMap[sessionId] || 0) + 1;
            
            // 更新全局入口按钮状态
            const btn = document.getElementById('peek-btn');
            const badge = document.getElementById('gossip-badge');
            if (btn && badge) {
                btn.classList.add('has-unread');
                badge.style.display = 'block';
            }
        }

        // UI Update if monitor is open
        if (isOverlayVisible) {
            renderPrivateChatMonitor();
        }
        return false; // 不拦截，让它进入 history
    }
    
    if (endMatch) {
        if (document.getElementById('private-chat-overlay').classList.contains('visible')) {
            renderPrivateChatMonitor();
        }
        return false; // 不拦截
    }

    return false;
}

function renderMemberSelectionList() {
    const memberSelectionList = document.getElementById('member-selection-list');
    if (!memberSelectionList) return;
    memberSelectionList.innerHTML = '';
    if (db.characters.length === 0) {
        memberSelectionList.innerHTML = '<li style="color:#aaa; text-align:center; padding: 10px 0;">没有可选择的人设。</li>';
        return;
    }
    db.characters.forEach(char => {
        const li = document.createElement('li');
        li.className = 'member-selection-item';
        li.innerHTML = `<input type="checkbox" id="select-${char.id}" value="${char.id}"><img src="${char.avatar}" alt="${char.remarkName}"><label for="select-${char.id}">${char.remarkName}</label>`;
        memberSelectionList.appendChild(li);
    });
}


function forumGetDMUserList() {
    forumEnsureData();
    const accountId = forumCurrentAccountId();
    const users = new Map();
    (db.forumMessages || []).filter(function(m) { return forumMessageBelongsToAccount(m, accountId); }).forEach(m => {
        const other = m.fromUserId === 'user' ? m.toUserId : m.fromUserId;
        if (other && other !== 'user') {
            var profile = getForumStrangerProfile(other);
            var displayName = (profile && profile.name) ? profile.name : other.replace(/^npc_/, '');
            users.set(other, { id: other, name: displayName });
        }
    });
    return Array.from(users.values());
}

function forumToggleDMListDeleteMode() {
    if (forumDMListDeleteMode) return;
    forumDMListDeleteMode = true;
    forumDMSelectedUserIds.clear();
    var toolbar = document.getElementById('forum-dm-delete-toolbar');
    if (toolbar) toolbar.style.display = 'flex';
    var deleteBtn = document.getElementById('forum-dm-list-delete-btn');
    if (deleteBtn) deleteBtn.style.display = 'none';
    forumRenderDMList();
}

function forumDMSelectAll() {
    var users = forumGetDMUserList();
    forumDMSelectedUserIds.clear();
    users.forEach(function(u) { forumDMSelectedUserIds.add(u.id); });
    forumRenderDMList();
}

function forumDMDeleteSelected() {
    if (forumDMSelectedUserIds.size === 0) { showToast('请先选择要删除的对话'); return; }
    if (!confirm('确定要删除选中的 ' + forumDMSelectedUserIds.size + ' 个对话吗？该对话下的所有私信将被删除。')) return;
    if (!db.forumMessages) db.forumMessages = [];
    var accountId = forumCurrentAccountId();
    db.forumMessages = db.forumMessages.filter(function(m) {
        if (!forumMessageBelongsToAccount(m, accountId)) return true;
        var other = m.fromUserId === 'user' ? m.toUserId : m.fromUserId;
        return !forumDMSelectedUserIds.has(other);
    });
    saveData();
    forumDMSelectedUserIds.clear();
    forumDMListDeleteMode = false;
    var toolbar = document.getElementById('forum-dm-delete-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    var deleteBtn = document.getElementById('forum-dm-list-delete-btn');
    if (deleteBtn) deleteBtn.style.display = '';
    forumRenderDMList();
    showToast('已删除选中对话');
}

function forumDMCancelDeleteMode() {
    forumDMListDeleteMode = false;
    forumDMSelectedUserIds.clear();
    var toolbar = document.getElementById('forum-dm-delete-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    var deleteBtn = document.getElementById('forum-dm-list-delete-btn');
    if (deleteBtn) deleteBtn.style.display = '';
    forumRenderDMList();
}

function forumRenderDMList() {
    forumEnsureData();
    const accountId = forumCurrentAccountId();
    const list = document.getElementById('forum-dm-list-container');
    if (!list) return;
    const users = forumGetDMUserList();
    list.innerHTML = '';
    if (users.length === 0) { list.innerHTML = '<li class="placeholder-text" style="padding:20px;">暂无私信对话</li>'; return; }
    
    const defaultAvatarUrl = 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg';
    const npcColors = ["#FFB6C1", "#87CEFA", "#98FB98", "#F0E68C", "#DDA0DD", "#FFDAB9", "#B0E0E6"];
    const getStableColor = id => { let h = 0; for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0; return npcColors[h % npcColors.length]; };
    
    users.forEach(u => {
        const conv = (db.forumMessages || []).filter(m => forumMessageBelongsToAccount(m, accountId) && ((m.fromUserId === 'user' && m.toUserId === u.id) || (m.fromUserId === u.id && m.toUserId === 'user')));
        const last = conv[conv.length - 1];
        const unread = (db.forumMessages || []).filter(m => forumMessageBelongsToAccount(m, accountId) && m.toUserId === 'user' && m.fromUserId === u.id && !m.isRead).length;
        
        const firstChar = (u.name || '').charAt(0).toUpperCase() || '?';
        const avatarColor = getStableColor(u.id);
        
        const li = document.createElement('li');
        li.className = 'forum-dm-item';
        if (forumDMListDeleteMode) {
            li.classList.add('dm-delete-mode');
            if (forumDMSelectedUserIds.has(u.id)) li.classList.add('dm-selected');
        }
        li.dataset.userId = u.id;
        li.dataset.userName = u.name;
        
        const checkboxHtml = forumDMListDeleteMode ? '<div class="dm-select-checkbox"></div>' : '';
        li.innerHTML = checkboxHtml + `
            <div class="dm-avatar" style="width:48px;height:48px;border-radius:50%;background:${avatarColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;flex-shrink:0;">${forumEscapeHtml(firstChar)}</div>
            <div class="dm-info">
                <div class="dm-name">${forumEscapeHtml(u.name || u.id)}</div>
                <div class="dm-last-message">${forumEscapeHtml(last ? (last.fromUserId === 'user' ? '我: ' : '') + (last.content || '').substring(0, 30) : '暂无消息')}</div>
            </div>
            ${unread > 0 ? `<span class="dm-unread-badge">${unread}</span>` : ''}
        `;
        
        list.appendChild(li);
    });
}

var forumCurrentDMUserId = null;
var forumDMLongPressTimer = null;
var forumCommentLongPressTimer = null;
var forumReplyTarget = null; // { commentId, username, content } 当前回复目标
var editingForumDMId = null;
var forumDMListDeleteMode = false;
var forumDMSelectedUserIds = new Set();
var forumPendingFriendRequest = null;
var forumPostDeleteMode = false;
var forumSelectedPostIds = new Set();

var FORUM_DEFAULT_AVATAR = 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg';

function forumHasPendingFriendRequestFromUser(npcUserId) {
    if (!db.forumPendingRequestFromUser || typeof db.forumPendingRequestFromUser !== 'object') return false;
    return !!db.forumPendingRequestFromUser[forumCurrentAccountId() + '::' + npcUserId];
}
function forumSetPendingFriendRequestFromUser(npcUserId, value) {
    if (!db.forumPendingRequestFromUser || typeof db.forumPendingRequestFromUser !== 'object') db.forumPendingRequestFromUser = {};
    var key = forumCurrentAccountId() + '::' + npcUserId;
    if (value) db.forumPendingRequestFromUser[key] = true; else delete db.forumPendingRequestFromUser[key];
    saveData();
}

function getForumStrangerProfile(userId) {
    if (!db.forumStrangerProfiles) return null;
    return db.forumStrangerProfiles[userId] || null;
}

function forumIsFriend(userId) {
    var accountId = forumCurrentAccountId();
    return (db.characters || []).some(function(c) { return c.source === 'forum' && c.forumUserId === userId && (c.forumAccountId || 'main') === accountId; });
}

function forumOpenDMConversation(userId, userName, commentContext) {
    forumCurrentDMUserId = userId;
    forumMarkDMRead(userId);
    forumUpdateDMUnreadBadge();
    document.getElementById('forum-dm-conversation-title').textContent = userName || userId || '私信';
    
    // 如果从评论进入且没有历史消息，注入评论上下文作为第一条系统消息
    if (commentContext && commentContext.commentContent) {
        const accountId = forumCurrentAccountId();
        const existingMsgs = (db.forumMessages || []).filter(m => forumMessageBelongsToAccount(m, accountId) && ((m.fromUserId === 'user' && m.toUserId === userId) || (m.fromUserId === userId && m.toUserId === 'user')));
        if (existingMsgs.length === 0) {
            if (!db.forumMessages) db.forumMessages = [];
            db.forumMessages.push({
                id: 'dm_ctx_' + Date.now(),
                fromUserId: 'user',
                toUserId: userId,
                content: '（来自帖子「' + (commentContext.postTitle || '') + '」你的评论：' + commentContext.commentContent + '）',
                timestamp: Date.now(),
                isRead: true,
                isCommentContext: true,
                accountId: accountId
            });
            saveData();
        }
    }
    
    forumRenderDMConversation(userId);
    var addFriendBtn = document.getElementById('forum-dm-add-friend-btn');
    if (addFriendBtn) {
        var profile = getForumStrangerProfile(userId);
        var isFriend = forumIsFriend(userId);
        addFriendBtn.style.display = (profile && !isFriend) ? '' : 'none';
    }
    switchScreen('forum-dm-conversation-screen');
}

function forumOpenDMSettingsModal() {
    if (!db.forumSettings) db.forumSettings = {};
    var cb = document.getElementById('forum-dm-generate-detailed-stranger');
    if (cb) cb.checked = !!db.forumSettings.generateDetailedStranger;
    var modal = document.getElementById('forum-dm-settings-modal');
    if (modal) modal.classList.add('visible');
}

function forumCloseDMSettingsModal() {
    var cb = document.getElementById('forum-dm-generate-detailed-stranger');
    if (cb && db.forumSettings) {
        db.forumSettings.generateDetailedStranger = !!cb.checked;
        saveData();
    }
    var modal = document.getElementById('forum-dm-settings-modal');
    if (modal) modal.classList.remove('visible');
}

function forumAddForumNPCAsCharacter(profile, userId) {
    if (!db.characters) db.characters = [];
    var fp = forumGetActiveAccount();
    var name = profile.name || userId.replace(/^npc_/, '');
    var charId = 'forum_friend_' + userId + '_' + Date.now();
    var newChar = {
        id: charId,
        realName: name,
        remarkName: name,
        avatar: (profile.avatar && profile.avatar.trim()) ? profile.avatar : FORUM_DEFAULT_AVATAR,
        persona: profile.basicPersona || '',
        source: 'forum',
        forumUserId: userId,
        forumAccountId: forumCurrentAccountId(),
        history: [],
        supplementPersonaEnabled: false,
        supplementPersonaAiEnabled: false,
        supplementPersonaText: '',
        myName: fp.username || fp.myName || '用户',
        myAvatar: (fp.avatar && fp.avatar.trim()) ? fp.avatar : FORUM_DEFAULT_AVATAR,
        myPersona: fp.bio || fp.myPersona || ''
    };
    if (profile.linkedCharId) newChar.linkedCharId = profile.linkedCharId;
    db.characters.push(newChar);
    saveData();
    if (typeof renderChatList === 'function') renderChatList();
    if (typeof renderContactList === 'function') renderContactList();
    return newChar;
}

function forumShowFriendRequestModal(request) {
    forumPendingFriendRequest = request;
    if (!Array.isArray(db.forumFriendRequests)) db.forumFriendRequests = [];
    var accountId = forumCurrentAccountId();
    var duplicate = db.forumFriendRequests.some(function(r) { return r.accountId === accountId && r.npcId === request.fromUserId && r.direction === 'incoming' && r.status === 'pending'; });
    if (!duplicate) db.forumFriendRequests.push({ id: forumNewId('friend_request'), accountId: accountId, npcId: request.fromUserId, direction: 'incoming', status: 'pending', createdAt: Date.now() });
    saveData();
    document.getElementById('forum-friend-request-avatar').src = (request.fromAvatar && request.fromAvatar.trim()) ? request.fromAvatar : FORUM_DEFAULT_AVATAR;
    document.getElementById('forum-friend-request-name').textContent = request.fromName || request.fromUserId.replace(/^npc_/, '');
    document.getElementById('forum-friend-request-modal').classList.add('visible');
}

function forumAcceptFriendRequest() {
    if (!forumPendingFriendRequest) return;
    var profile = getForumStrangerProfile(forumPendingFriendRequest.fromUserId);
    if (!profile) profile = { name: forumPendingFriendRequest.fromName || forumPendingFriendRequest.fromUserId.replace(/^npc_/, ''), avatar: forumPendingFriendRequest.fromAvatar, basicPersona: '' };
    if (!forumIsFriend(forumPendingFriendRequest.fromUserId)) forumAddForumNPCAsCharacter(profile, forumPendingFriendRequest.fromUserId);
    var acceptedNpcId = forumPendingFriendRequest.fromUserId;
    (db.forumFriendRequests || []).filter(r => r.accountId === forumCurrentAccountId() && r.npcId === acceptedNpcId && r.status === 'pending').forEach(r => { r.status = 'accepted'; r.resolvedAt = Date.now(); });
    var acceptedRel = forumGetRelationship(acceptedNpcId); acceptedRel.status = 'friend'; forumAdjustRelationship(acceptedNpcId, { trust: 8, familiarity: 8 }, '双方成为论坛好友');
    saveData();
    document.getElementById('forum-friend-request-modal').classList.remove('visible');
    forumPendingFriendRequest = null;
    showToast('已添加为好友');
}

function forumRejectFriendRequest() {
    if (forumPendingFriendRequest) (db.forumFriendRequests || []).filter(r => r.accountId === forumCurrentAccountId() && r.npcId === forumPendingFriendRequest.fromUserId && r.status === 'pending').forEach(r => { r.status = 'rejected'; r.resolvedAt = Date.now(); });
    document.getElementById('forum-friend-request-modal').classList.remove('visible');
    forumPendingFriendRequest = null;
    saveData();
}

function forumDMRequestAddFriend() {
    if (!forumCurrentDMUserId) return;
    var profile = getForumStrangerProfile(forumCurrentDMUserId);
    if (!profile) { showToast('该陌生人暂无详细人设'); return; }
    if (forumIsFriend(forumCurrentDMUserId)) { showToast('已经是好友了'); return; }
    if (forumHasPendingFriendRequestFromUser(forumCurrentDMUserId)) { showToast('已发送过好友申请，等待对方回复'); return; }
    forumSetPendingFriendRequestFromUser(forumCurrentDMUserId, true);
    if (!Array.isArray(db.forumFriendRequests)) db.forumFriendRequests = [];
    db.forumFriendRequests.push({ id: forumNewId('friend_request'), accountId: forumCurrentAccountId(), npcId: forumCurrentDMUserId, direction: 'outgoing', status: 'pending', createdAt: Date.now() });
    saveData();
    showToast('已发送好友申请，等待对方回复');
}

function forumMarkDMRead(userId) {
    if (!db.forumMessages) return;
    var accountId = forumCurrentAccountId();
    db.forumMessages.forEach(m => { if (forumMessageBelongsToAccount(m, accountId) && m.toUserId === 'user' && m.fromUserId === userId) m.isRead = true; });
    saveData();
}

function forumRenderDMConversation(userId) {
    const area = document.getElementById('forum-dm-message-area');
    if (!area) return;
    
    const accountId = forumCurrentAccountId();
    const messages = (db.forumMessages || []).filter(m => forumMessageBelongsToAccount(m, accountId) && ((m.fromUserId === 'user' && m.toUserId === userId) || (m.fromUserId === userId && m.toUserId === 'user'))).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    
    area.innerHTML = '';
    
    forumInitUserProfile();
    const activeAccount = forumGetActiveAccount();
    const userAvatar = (activeAccount.avatar && activeAccount.avatar.trim()) ? activeAccount.avatar : FORUM_DEFAULT_AVATAR;
    
    const npcColors = ["#FFB6C1", "#87CEFA", "#98FB98", "#F0E68C", "#DDA0DD", "#FFDAB9", "#B0E0E6"];
    const getStableColor = (id) => {
        var h = 0;
        for (var i = 0; i < (id || '').length; i++) h = (h * 31 + (id.charCodeAt(i) || 0)) >>> 0;
        return npcColors[h % npcColors.length];
    };
    const npcName = userId.replace(/^npc_/, '');
    const npcProfile = getForumStrangerProfile(userId);
    const npcDisplayName = (npcProfile && npcProfile.name) ? npcProfile.name : npcName;
    const npcFirstChar = (npcDisplayName || '').charAt(0).toUpperCase() || '?';
    const npcColor = getStableColor(userId);
    
    messages.forEach(m => {
        if (m.isCommentContext) return; // 系统上下文消息不显示
        const isUser = m.fromUserId === 'user';
        const div = document.createElement('div');
        div.className = isUser ? 'dm-message dm-message-user' : 'dm-message dm-message-npc';
        div.dataset.id = m.id || '';
        
        const avatarHtml = isUser 
            ? `<img src="${forumEscapeHtml(forumSafeImageUrl(userAvatar))}" class="dm-message-avatar" alt="我" />`
            : (npcProfile && npcProfile.avatar ? `<img src="${forumEscapeHtml(forumSafeImageUrl(npcProfile.avatar))}" class="dm-message-avatar" alt="" />` : `<div class="dm-message-avatar" style="width:40px;height:40px;min-width:40px;border-radius:50%;background:${npcColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:600;">${forumEscapeHtml(npcFirstChar)}</div>`);
        
        const bubble = document.createElement('div');
        bubble.className = 'dm-message-bubble';
        bubble.textContent = m.content || '';
        
        const messageBody = document.createElement('div');
        messageBody.className = 'dm-message-body';
        const time = document.createElement('small');
        time.className = 'dm-message-time';
        time.textContent = forumFormatTime(m.timestamp);
        messageBody.appendChild(bubble);
        messageBody.appendChild(time);
        div.innerHTML = avatarHtml;
        div.appendChild(messageBody);
        
        area.appendChild(div);
    });
    
    area.scrollTop = area.scrollHeight;
}

function forumSetDMPresence(text) {
    var el = document.getElementById('forum-dm-presence');
    if (el) el.textContent = text || '';
}

function setupForumDMMessageAreaLongPress() {
    const area = document.getElementById('forum-dm-message-area');
    if (!area) return;
    area.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        const msgEl = e.target.closest('.dm-message');
        if (!msgEl || !msgEl.dataset.id) return;
        forumDMHandleLongPress(msgEl, e.clientX, e.clientY);
    });
    area.addEventListener('touchstart', function(e) {
        const msgEl = e.target.closest('.dm-message');
        if (!msgEl || !msgEl.dataset.id) return;
        forumDMLongPressTimer = setTimeout(function() {
            const t = e.touches[0];
            forumDMHandleLongPress(msgEl, t.clientX, t.clientY);
        }, 400);
    });
    area.addEventListener('touchend', function() { clearTimeout(forumDMLongPressTimer); });
    area.addEventListener('touchmove', function() { clearTimeout(forumDMLongPressTimer); });
}

function forumDMHandleLongPress(domMessage, x, y) {
    const msgId = domMessage.dataset.id;
    const menuItems = [
        { label: '编辑', action: function() { openForumDMEditModal(msgId); } },
        { label: '删除', action: function() { deleteForumDMMessage(msgId); }, danger: true }
    ];
    if (typeof triggerHapticFeedback === 'function') triggerHapticFeedback('medium');
    createContextMenu(menuItems, x, y);
}

function openForumDMEditModal(msgId) {
    if (!db.forumMessages) return;
    const msg = db.forumMessages.find(function(m) { return m.id === msgId; });
    if (!msg) return;
    editingForumDMId = msgId;
    const ta = document.getElementById('forum-dm-edit-textarea');
    const modal = document.getElementById('forum-dm-edit-modal');
    if (ta) ta.value = msg.content || '';
    if (modal) modal.classList.add('visible');
    if (ta) ta.focus();
}

function setupForumDMEditModal() {
    var form = document.getElementById('forum-dm-edit-form');
    var cancelBtn = document.getElementById('forum-dm-edit-cancel-btn');
    var deleteBtn = document.getElementById('forum-dm-edit-delete-btn');
    if (form) form.addEventListener('submit', function(e) { e.preventDefault(); saveForumDMEdit(); });
    if (cancelBtn) cancelBtn.addEventListener('click', function() {
        document.getElementById('forum-dm-edit-modal').classList.remove('visible');
        editingForumDMId = null;
    });
    if (deleteBtn) deleteBtn.addEventListener('click', function() {
        if (confirm('确定要删除这条私信吗？')) deleteForumDMMessage(editingForumDMId);
    });
}

function saveForumDMEdit() {
    if (!editingForumDMId) return;
    var content = (document.getElementById('forum-dm-edit-textarea') && document.getElementById('forum-dm-edit-textarea').value || '').trim();
    var msg = db.forumMessages && db.forumMessages.find(function(m) { return m.id === editingForumDMId; });
    if (msg) {
        msg.content = content;
        saveData();
        if (forumCurrentDMUserId) forumRenderDMConversation(forumCurrentDMUserId);
        document.getElementById('forum-dm-edit-modal').classList.remove('visible');
        showToast('私信已更新');
    }
    editingForumDMId = null;
}

function deleteForumDMMessage(msgId) {
    if (!msgId || !db.forumMessages) return;
    db.forumMessages = db.forumMessages.filter(function(m) { return m.id !== msgId; });
    saveData();
    if (forumCurrentDMUserId) forumRenderDMConversation(forumCurrentDMUserId);
    var modal = document.getElementById('forum-dm-edit-modal');
    if (modal) modal.classList.remove('visible');
    editingForumDMId = null;
    showToast('私信已删除');
}

function forumSendDM() {
    if (!forumCurrentDMUserId) return;
    const input = document.getElementById('forum-dm-input');
    const content = (input && input.value || '').trim();
    if (!content) return;
    if (!db.forumMessages) db.forumMessages = [];
    db.forumMessages.push({ id: forumNewId('dm'), fromUserId: 'user', toUserId: forumCurrentDMUserId, content: content, timestamp: Date.now(), isRead: false, accountId: forumCurrentAccountId() });
    forumRecordEvent('dm_sent', { npcId: forumCurrentDMUserId, messageId: db.forumMessages[db.forumMessages.length - 1].id });
    forumAdjustRelationship(forumCurrentDMUserId, { familiarity: 1, privateCloseness: 1 }, '用户发送论坛私信');
    saveData();
    if (input) input.value = '';
    forumRenderDMConversation(forumCurrentDMUserId);
}

function forumUpdateMoreNoticeBadge() {
    const accountId = forumCurrentAccountId();
    const noticeCount = typeof forumGetUnreadNotificationCount === 'function' ? forumGetUnreadNotificationCount(accountId) : 0;
    
    // 更新更多按钮上的小圆点
    const moreBtn = document.getElementById('forum-more-btn');
    if (moreBtn) {
        let moreBadge = moreBtn.querySelector('.forum-more-badge');
        if (noticeCount > 0) {
            if (!moreBadge) {
                moreBadge = document.createElement('span');
                moreBadge.className = 'forum-more-badge';
                moreBtn.style.position = 'relative';
                moreBtn.appendChild(moreBadge);
            }
        } else if (moreBadge) {
            moreBadge.remove();
        }
    }

    // 更新弹窗内“与我相关”项的未读徽标
    const modalNoticeBadge = document.getElementById('forum-more-notice-badge');
    if (modalNoticeBadge) {
        if (noticeCount > 0) {
            modalNoticeBadge.style.display = 'inline-flex';
            modalNoticeBadge.textContent = noticeCount > 99 ? '99+' : noticeCount;
        } else {
            modalNoticeBadge.style.display = 'none';
        }
    }
}

function forumUpdateDMUnreadBadge() {
    const btn = document.getElementById('forum-dm-btn');
    const accountId = forumCurrentAccountId();
    if (btn) {
        const n = (db.forumMessages || []).filter(m => forumMessageBelongsToAccount(m, accountId) && m.toUserId === 'user' && !m.isRead).length;
        let badge = btn.querySelector('.forum-dm-badge');
        if (n > 0) {
            if (!badge) { badge = document.createElement('span'); badge.className = 'forum-dm-badge'; badge.style.cssText = 'position:absolute;top:-4px;right:-4px;background:#ff4757;color:#fff;font-size:10px;padding:2px 5px;border-radius:10px;line-height:1;'; btn.style.position = 'relative'; btn.appendChild(badge); }
            badge.textContent = n > 99 ? '99+' : n;
        } else if (badge) badge.remove();
    }

    const noticeBtn = document.getElementById('forum-notifications-btn');
    if (noticeBtn) {
        const noticeCount = forumGetUnreadNotificationCount(accountId);
        let noticeBadge = noticeBtn.querySelector('.forum-dm-badge');
        if (noticeCount > 0) {
            if (!noticeBadge) { noticeBadge = document.createElement('span'); noticeBadge.className = 'forum-dm-badge'; noticeBtn.appendChild(noticeBadge); }
            noticeBadge.textContent = noticeCount > 99 ? '99+' : noticeCount;
        } else if (noticeBadge) noticeBadge.remove();
    }

    forumUpdateMoreNoticeBadge();
}

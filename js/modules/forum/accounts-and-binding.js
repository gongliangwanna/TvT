// --- 论坛功能 (js/modules/forum.js) ---

// ===== 小号管理系统 =====
var forumEditingAltId = null; // 当前正在编辑的小号ID，null表示新建

function forumGetActiveAccount() {
    var activeId = db.forumActiveAccountId || 'main';
    if (activeId === 'main') {
        forumInitUserProfile();
        return { id: 'main', username: db.forumUserProfile.username, avatar: db.forumUserProfile.avatar, bio: db.forumUserProfile.bio, isAlt: false };
    }
    var alts = db.forumAltAccounts || [];
    var alt = alts.find(function(a) { return a.id === activeId; });
    if (!alt) {
        db.forumActiveAccountId = 'main';
        saveData();
        forumInitUserProfile();
        return { id: 'main', username: db.forumUserProfile.username, avatar: db.forumUserProfile.avatar, bio: db.forumUserProfile.bio, isAlt: false };
    }
    return { id: alt.id, username: alt.username, avatar: alt.avatar, bio: alt.bio, isAlt: true };
}

function forumSwitchAccount(accountId) {
    db.forumActiveAccountId = accountId;
    saveData();
    forumRenderAltAccountsList();
    var acc = forumGetActiveAccount();
    showToast('已切换为: ' + acc.username);
    if (typeof renderForumPosts === 'function') renderForumPosts(db.forumPosts || [], typeof forumGetActiveFilter === 'function' ? forumGetActiveFilter() : 'all');
    if (typeof forumRenderDMList === 'function') forumRenderDMList();
    if (typeof forumUpdateDMUnreadBadge === 'function') forumUpdateDMUnreadBadge();
    if (typeof forumUpdateIdentityChip === 'function') forumUpdateIdentityChip();
}

function forumCreateAltAccount(data) {
    if (!db.forumAltAccounts) db.forumAltAccounts = [];
    var newAlt = {
        id: 'alt_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
        username: data.username || '小号' + Math.floor(1000 + Math.random() * 9000),
        avatar: data.avatar || 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg',
        bio: data.bio || '',
        createdAt: Date.now()
    };
    db.forumAltAccounts.push(newAlt);
    saveData();
    return newAlt;
}

function forumUpdateAltAccount(altId, data) {
    var alts = db.forumAltAccounts || [];
    var alt = alts.find(function(a) { return a.id === altId; });
    if (!alt) return;
    if (data.username) alt.username = data.username;
    if (data.avatar) alt.avatar = data.avatar;
    if (data.bio !== undefined) alt.bio = data.bio;
    saveData();
}

function forumDeleteAltAccount(altId) {
    if (!db.forumAltAccounts) return;
    db.forumAltAccounts = db.forumAltAccounts.filter(function(a) { return a.id !== altId; });
    if (db.forumActiveAccountId === altId) {
        db.forumActiveAccountId = 'main';
    }
    // Posts, messages and relationship history intentionally remain addressable.
    // Existing data is never silently deleted when an identity is removed.
    saveData();
}

function forumRenderAltAccountsList() {
    var listEl = document.getElementById('forum-alt-accounts-list');
    var displayEl = document.getElementById('forum-active-identity-display');
    if (!listEl) return;

    // 渲染当前身份
    var active = forumGetActiveAccount();
    if (displayEl) {
        displayEl.innerHTML = '<img class="forum-alt-identity-avatar" src="' + forumEscapeHtml(forumSafeImageUrl(active.avatar)) + '">'
            + '<div class="forum-alt-identity-info"><div class="forum-alt-identity-name">' + forumEscapeHtml(active.username || '未设置') + (active.isAlt ? ' <span style="font-size:11px;color:#999;">(小号)</span>' : ' <span style="font-size:11px;color:#999;">(大号)</span>') + '</div>'
            + '<div class="forum-alt-identity-bio">' + forumEscapeHtml(active.bio || '暂无简介') + '</div></div>'
            + '<span class="forum-alt-identity-badge">使用中</span>';
    }

    // 渲染小号列表
    var alts = db.forumAltAccounts || [];
    if (alts.length === 0) {
        listEl.innerHTML = '<div class="forum-alt-empty-hint">还没有小号，点击右上角「新建小号」创建一个吧</div>';
        // 渲染大号切换卡片（如果当前不是大号）
        if (active.isAlt) {
            forumInitUserProfile();
            var mainP = db.forumUserProfile;
            listEl.innerHTML = '<div class="forum-alt-identity-card" data-alt-id="main">'
                + '<img class="forum-alt-identity-avatar" src="' + forumEscapeHtml(forumSafeImageUrl(mainP.avatar)) + '">'
                + '<div class="forum-alt-identity-info"><div class="forum-alt-identity-name">' + forumEscapeHtml(mainP.username || '大号') + ' <span style="font-size:11px;color:#999;">(大号)</span></div>'
                + '<div class="forum-alt-identity-bio">' + forumEscapeHtml(mainP.bio || '暂无简介') + '</div></div>'
                + '<button class="btn btn-small btn-primary" style="padding:4px 12px;font-size:12px;" onclick="forumSwitchAccount(\'main\')">切换</button></div>'
                + '<div class="forum-alt-empty-hint">还没有小号，点击右上角「新建小号」创建一个吧</div>';
        }
        return;
    }

    var html = '';
    // 如果当前是小号，显示大号切换入口
    if (active.isAlt) {
        forumInitUserProfile();
        var mainProfile = db.forumUserProfile;
        html += '<div class="forum-alt-identity-card" data-alt-id="main">'
            + '<img class="forum-alt-identity-avatar" src="' + forumEscapeHtml(forumSafeImageUrl(mainProfile.avatar)) + '">'
            + '<div class="forum-alt-identity-info"><div class="forum-alt-identity-name">' + forumEscapeHtml(mainProfile.username || '大号') + ' <span style="font-size:11px;color:#999;">(大号)</span></div>'
            + '<div class="forum-alt-identity-bio">' + forumEscapeHtml(mainProfile.bio || '暂无简介') + '</div></div>'
            + '<button class="btn btn-small btn-primary" style="padding:4px 12px;font-size:12px;" onclick="forumSwitchAccount(\'main\')">切换</button></div>';
    }

    alts.forEach(function(alt) {
        var isActive = (db.forumActiveAccountId === alt.id);
        html += '<div class="forum-alt-identity-card' + (isActive ? ' forum-alt-identity-active' : '') + '" data-alt-id="' + alt.id + '">'
            + '<img class="forum-alt-identity-avatar" src="' + forumEscapeHtml(forumSafeImageUrl(alt.avatar)) + '">'
            + '<div class="forum-alt-identity-info"><div class="forum-alt-identity-name">' + forumEscapeHtml(alt.username || '小号') + '</div>'
            + '<div class="forum-alt-identity-bio">' + forumEscapeHtml(alt.bio || '暂无简介') + '</div></div>'
            + '<div class="forum-alt-identity-actions">'
            + (isActive ? '<span class="forum-alt-identity-badge">使用中</span>' : '<button onclick="forumSwitchAccount(\'' + forumEscapeHtml(alt.id) + '\')">切换</button>')
            + '<button onclick="forumOpenAltEditModal(\'' + forumEscapeHtml(alt.id) + '\')">编辑</button>'
            + '<button class="alt-delete-btn" onclick="event.stopPropagation();forumConfirmDeleteAlt(\'' + forumEscapeHtml(alt.id) + '\')">删除</button>'
            + '</div></div>';
    });
    listEl.innerHTML = html;
}

function forumOpenAltEditModal(altId) {
    var modal = document.getElementById('forum-alt-edit-modal');
    var titleEl = document.getElementById('forum-alt-edit-modal-title');
    var avatarEl = document.getElementById('forum-alt-edit-avatar');
    var usernameEl = document.getElementById('forum-alt-edit-username');
    var bioEl = document.getElementById('forum-alt-edit-bio');
    if (!modal) return;

    if (altId) {
        forumEditingAltId = altId;
        var alt = (db.forumAltAccounts || []).find(function(a) { return a.id === altId; });
        if (!alt) return;
        titleEl.textContent = '编辑小号';
        avatarEl.src = alt.avatar || 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg';
        usernameEl.value = alt.username || '';
        bioEl.value = alt.bio || '';
    } else {
        forumEditingAltId = null;
        titleEl.textContent = '新建小号';
        avatarEl.src = 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg';
        usernameEl.value = '';
        bioEl.value = '';
    }
    modal.classList.add('visible');
}

function forumCloseAltEditModal() {
    var modal = document.getElementById('forum-alt-edit-modal');
    if (modal) modal.classList.remove('visible');
    forumEditingAltId = null;
}

function forumSaveAltFromModal() {
    var usernameEl = document.getElementById('forum-alt-edit-username');
    var bioEl = document.getElementById('forum-alt-edit-bio');
    var avatarEl = document.getElementById('forum-alt-edit-avatar');
    var username = (usernameEl && usernameEl.value || '').trim();
    if (!username) { showToast('昵称不能为空'); return; }
    var avatar = avatarEl ? avatarEl.src : '';
    var bio = (bioEl && bioEl.value || '').trim();

    if (forumEditingAltId) {
        forumUpdateAltAccount(forumEditingAltId, { username: username, avatar: avatar, bio: bio });
        showToast('小号已更新');
    } else {
        forumCreateAltAccount({ username: username, avatar: avatar, bio: bio });
        showToast('小号创建成功');
    }
    forumCloseAltEditModal();
    forumRenderAltAccountsList();
    forumUpdateIdentityChip();
}

function forumConfirmDeleteAlt(altId) {
    var alt = (db.forumAltAccounts || []).find(function(a) { return a.id === altId; });
    if (!alt) return;
    if (confirm('确定删除小号「' + alt.username + '」吗？')) {
        forumDeleteAltAccount(altId);
        forumRenderAltAccountsList();
        forumUpdateIdentityChip();
        showToast('小号已删除');
    }
}

function forumSetupAltAccountEvents() {
    var createBtn = document.getElementById('forum-create-alt-btn');
    if (createBtn) createBtn.addEventListener('click', function() { forumOpenAltEditModal(null); });

    var saveBtn = document.getElementById('forum-alt-edit-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', forumSaveAltFromModal);

    var cancelBtn = document.getElementById('forum-alt-edit-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', forumCloseAltEditModal);

    var modal = document.getElementById('forum-alt-edit-modal');
    if (modal) modal.addEventListener('click', function(e) { if (e.target === modal) forumCloseAltEditModal(); });

    var avatarImg = document.getElementById('forum-alt-edit-avatar');
    var avatarUpload = document.getElementById('forum-alt-avatar-upload');
    if (avatarImg) avatarImg.addEventListener('click', function() { if (avatarUpload) avatarUpload.click(); });
    if (avatarUpload) avatarUpload.addEventListener('change', function(e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function() { if (avatarImg) avatarImg.src = reader.result; };
        reader.readAsDataURL(f);
        e.target.value = '';
    });

    var gotoBtn = document.getElementById('forum-goto-alt-accounts-btn');
    if (gotoBtn) gotoBtn.addEventListener('click', function() { switchScreen('forum-alt-accounts-screen'); forumRenderAltAccountsList(); });
}
// ===== 小号管理系统 END =====

function setupForumBindingFeature() {
    const forumLinkBtn = document.getElementById('forum-link-btn');
    const modal = document.getElementById('forum-binding-modal');
    const tabs = modal.querySelectorAll('.tab-btn');
    const contentPanes = modal.querySelectorAll('.forum-binding-content');
    const confirmBtn = document.getElementById('confirm-forum-binding-btn');

    forumLinkBtn.addEventListener('click', () => {
        openForumBindingModal();
    });

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contentPanes.forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            const targetId = tab.dataset.target;
            document.getElementById(targetId).classList.add('active');
        });
    });

    confirmBtn.addEventListener('click', async () => {
        const worldBookList = document.getElementById('forum-worldbook-list');
        const charList = document.getElementById('forum-char-list');
        const userList = document.getElementById('forum-user-list');

        const selectedWorldBookIds = Array.from(worldBookList.querySelectorAll('.item-checkbox:checked')).map(input => input.value);
        const selectedCharIds = Array.from(charList.querySelectorAll('input:checked')).map(input => input.value);
        const selectedUserPersonaIds = Array.from(userList.querySelectorAll('input:checked')).map(input => input.value);

        db.forumBindings = {
            worldBookIds: selectedWorldBookIds,
            charIds: selectedCharIds,
            userPersonaIds: selectedUserPersonaIds,
        };

        await saveData();
        showToast('论坛绑定已更新');
        modal.classList.remove('visible');
    });

    function openForumBindingModal() {
        const worldBookList = document.getElementById('forum-worldbook-list');
        const charList = document.getElementById('forum-char-list');
        const userList = document.getElementById('forum-user-list');

        worldBookList.innerHTML = '';
        charList.innerHTML = '';
        userList.innerHTML = '';

        const currentBindings = db.forumBindings || { worldBookIds: [], charIds: [], userPersonaIds: [] };

        renderCategorizedWorldBookList(worldBookList, db.worldBooks, currentBindings.worldBookIds, 'wb-bind');

        if (db.characters.length > 0) {
            db.characters.forEach(char => {
                const isChecked = currentBindings.charIds.includes(char.id);
                const li = document.createElement('li');
                li.className = 'binding-list-item';
                li.innerHTML = `
                    <input type="checkbox" id="char-bind-${forumEscapeHtml(char.id)}" value="${forumEscapeHtml(char.id)}" ${isChecked ? 'checked' : ''}>
                    <label for="char-bind-${forumEscapeHtml(char.id)}">${forumEscapeHtml(char.remarkName)}</label>
                `;
                charList.appendChild(li);
            });
        } else {
            charList.innerHTML = '<li>暂无Char设定</li>';
        }

        if (db.myPersonaPresets.length > 0) {
            db.myPersonaPresets.forEach(preset => {
                const isChecked = currentBindings.userPersonaIds.includes(preset.name);
                const li = document.createElement('li');
                li.className = 'binding-list-item';
                li.innerHTML = `
                    <input type="checkbox" id="user-bind-${forumEscapeHtml(preset.name.replace(/\s/g, '_'))}" value="${forumEscapeHtml(preset.name)}" ${isChecked ? 'checked' : ''}>
                    <label for="user-bind-${forumEscapeHtml(preset.name.replace(/\s/g, '_'))}">${forumEscapeHtml(preset.name)}</label>
                `;
                userList.appendChild(li);
            });
        } else {
            userList.innerHTML = '<li>暂无User人设</li>';
        }
        
        modal.classList.add('visible');
    }
}

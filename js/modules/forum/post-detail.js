function getPostDisplayTime(post) {
    if (post.timestamp) return forumFormatTime(post.timestamp);
    const parts = post.id.split('_');
    if (parts[1]) return new Date(parts[1] * 1).toLocaleString();
    return '';
}

function renderPostDetail(post) {
    const detailScreen = document.getElementById('forum-post-detail-screen');
    if (!detailScreen || !post) return;
    forumRememberPostVisit(post.id);

    const defaultAvatarUrl = 'https://i.postimg.cc/GtbTnxhP/o-o-1.jpg';
    const npcColors = ["#FFB6C1", "#87CEFA", "#98FB98", "#F0E68C", "#DDA0DD", "#FFDAB9", "#B0E0E6"];
    const getStableColor = id => { let h = 0; for (let i = 0; i < String(id || '').length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0; return npcColors[h % npcColors.length]; };

    let commentsHtml = '';
    if (post.comments && post.comments.length > 0) {
        post.comments.forEach((comment, index) => {
            const firstChar = (comment.username || '').charAt(0).toUpperCase() || '?';
            const isUserComment = comment.authorId === 'user' || comment.authorId === 'main' || (comment.authorId && comment.authorId.startsWith('alt_'));
            // 只有用户发的帖子里，用户在自己帖子下的回复才显示楼主
            const isAuthor = (post.authorId === 'user' || (post.authorId && post.authorId.startsWith('alt_'))) && (comment.authorId === post.authorId);
            const commentAccount = forumGetAccountById(comment.authorId);
            const userAvatarUrl = comment.avatar || (commentAccount && commentAccount.avatar) || defaultAvatarUrl;
            const avatarHtml = isUserComment
                ? `<img src="${forumEscapeHtml(forumSafeImageUrl(userAvatarUrl))}" class="comment-author-avatar" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
                : `<div class="comment-author-avatar" style="background-color: ${getStableColor(comment.authorId)}">${forumEscapeHtml(firstChar)}</div>`;
            
            const authorBadge = isAuthor ? '<span class="author-badge">楼主</span>' : '';
            const isNpcComment = comment.authorId && String(comment.authorId).indexOf('npc') === 0;
            const dmBtnHtml = isNpcComment ? `<button type="button" class="btn btn-primary btn-small comment-dm-btn" data-comment-index="${index}" style="padding:3px 10px;font-size:12px;border-radius:16px;flex-shrink:0;">发私信</button>` : '';
            const moreBtnHtml = forumAccountOwnsAuthor(comment.authorId) ? `<button type="button" class="comment-inline-btn comment-more-btn" data-comment-index="${index}">编辑</button>` : '';
            
            const replyToHtml = comment.replyTo ? `<div class="comment-reply-ref">回复 <span class="comment-reply-ref-name">@${forumEscapeHtml(comment.replyTo.username || '')}</span></div>` : '';
            
            commentsHtml += `
            <li class="comment-item" data-comment-index="${index}">
                ${avatarHtml}
                <div class="comment-body">
                    <div class="comment-author-name">${forumEscapeHtml(comment.username || '')}${authorBadge}${dmBtnHtml}</div>
                    ${replyToHtml}
                    <div class="comment-content">${forumEscapeHtml(comment.content || '').replace(/\n/g, '<br>')}</div>
                    <div class="comment-timestamp">${forumEscapeHtml(forumFormatTime(comment.timestampMs || comment.timestamp || ''))}</div>
                    ${comment.editedAt ? '<div class="comment-edited-mark">已编辑</div>' : ''}
                    <div class="comment-inline-actions"><button type="button" class="comment-inline-btn comment-reply-btn" data-comment-index="${index}">回复</button>${moreBtnHtml}</div>
                </div>
            </li>
            `;
        });
    }

    const likeCount = post.likeCount != null ? post.likeCount : 0;
    const isLiked = forumGetReaction(post, 'like');
    const isFavorited = forumGetReaction(post, 'favorite');
    const commentCount = post.comments ? post.comments.length : 0;
    const isOwnPost = forumAccountOwnsAuthor(post.authorId);
    const postAccount = forumGetAccountById(post.authorId) || forumGetActiveAccount();
    const tagHtml = (post.tags || []).length ? '<div class="forum-post-tags">' + post.tags.map(tag => '<span>#' + forumEscapeHtml(tag) + '</span>').join('') + '</div>' : '';
    const pollVote = post.poll && post.poll.votesByAccount && post.poll.votesByAccount[forumCurrentAccountId()];
    const pollTotal = post.poll ? post.poll.options.reduce((sum, option) => sum + (option.votes || 0), 0) : 0;
    const pollHtml = post.poll ? '<div class="forum-poll">' + post.poll.options.map(option => '<button type="button" class="forum-poll-option' + (pollVote === option.id ? ' selected' : '') + '" data-option-id="' + forumEscapeHtml(option.id) + '"><span>' + forumEscapeHtml(option.text) + '</span><small>' + (option.votes || 0) + '票' + (pollTotal ? ' · ' + Math.round((option.votes || 0) * 100 / pollTotal) + '%' : '') + '</small></button>').join('') + '</div>' : '';

    const authorAvatarHtml = isOwnPost
        ? `<img src="${forumEscapeHtml(forumSafeImageUrl(postAccount.avatar || defaultAvatarUrl))}" class="author-avatar author-avatar-img" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
        : (() => { const authorFirstChar = (post.username || '').charAt(0).toUpperCase() || '?'; return `<div class="author-avatar" style="background-color:${getStableColor(post.isAnonymous ? post.id : post.authorId)};color:#fff;">${forumEscapeHtml(authorFirstChar)}</div>`; })();

    detailScreen.innerHTML = `
    <header class="app-header">
        <button class="back-btn" data-target="forum-screen">&#8249;</button>
        <div class="title-container">
            <h1 class="title">帖子详情</h1>
        </div>
        <button class="action-btn" id="header-share-btn" title="分享">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L16.04,7.15C16.56,7.62 17.24,7.92 18,7.92C19.66,7.92 21,6.58 21,5C21,3.42 19.66,2 18,2C16.34,2 15,3.42 15,5C15,5.24 15.04,5.47 15.09,5.7L7.96,9.85C7.44,9.38 6.76,9.08 6,9.08C4.34,9.08 3,10.42 3,12C3,13.58 4.34,14.92 6,14.92C6.76,14.92 7.44,14.62 7.96,14.15L15.09,18.3C15.04,18.53 15,18.76 15,19C15,20.58 16.34,22 18,22C19.66,22 21,20.58 21,19C21,17.42 19.66,16.08 18,16.08Z"></path></svg>
        </button>
    </header>
    <main class="content">
        <div class="post-detail-container">
            <div class="post-detail-main">
                <div class="post-author-info">
                    ${authorAvatarHtml}
                    <div class="author-details" style="display:flex;flex-direction:column;gap:2px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                            <span class="author-name">${forumEscapeHtml(post.username || '')}</span>
                            ${!isOwnPost && !post.isAnonymous && post.username ? '<div class="forum-author-actions"><button type="button" class="btn btn-neutral btn-small" id="forum-profile-author-btn">资料</button><button type="button" class="btn btn-neutral btn-small" id="forum-follow-author-btn">' + (forumIsFollowing(post.authorId) ? '已关注' : '关注') + '</button><button type="button" class="btn btn-primary btn-small" id="forum-dm-author-btn">私信</button></div>' : ''}
                        </div>
                        <span class="post-meta-data">${getPostDisplayTime(post)}${post.editedAt ? ' · 已编辑' : ''}</span>
                    </div>
                </div>
                <h2 class="post-detail-title">${forumEscapeHtml(post.title || '')}</h2>
                <div class="post-detail-content-body">${forumEscapeHtml(post.content || '').replace(/\n/g, '<br>')}</div>
                ${tagHtml}
                ${pollHtml}
                <div class="post-detail-actions">
                    <div class="action-item" id="like-post-btn" data-post-id="${forumEscapeHtml(post.id)}" data-liked="${isLiked}" role="button" tabindex="0" style="cursor:pointer;border:none;background:none;padding:0;display:inline-flex;align-items:center;gap:4px;">
                        <svg viewBox="0 0 24 24" fill="${isLiked ? '#ff4757' : 'none'}" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                        <span id="like-count">${likeCount}</span>
                    </div>
                    <div class="action-item">
                        <svg viewBox="0 0 24 24"><path d="M20,8H4V6H20V8M18,10H6V12H18V10M16,14H8V16H16V14M22,4V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V4A2,2 0 0,1 4,2H20A2,2 0 0,1 22,4Z" /></svg>
                        <span id="comment-count">${commentCount}</span>
                    </div>
                    <div class="action-item" id="favorite-post-btn" data-post-id="${forumEscapeHtml(post.id)}" data-favorited="${isFavorited}" role="button" tabindex="0" style="cursor:pointer;">
                        <svg viewBox="0 0 24 24" fill="${isFavorited ? '#ffd700' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>
                        <span>收藏</span>
                    </div>
                    ${isOwnPost ? `<button type="button" class="action-item" id="edit-post-btn" data-post-id="${forumEscapeHtml(post.id)}" style="border:none;background:none;"><span>编辑</span></button><button type="button" class="action-item" id="delete-post-btn" data-post-id="${forumEscapeHtml(post.id)}" style="color:#ff4757;border:none;background:none;"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg><span>删除</span></button>` : ''}
                </div>
            </div>
        </div>

        <div class="comments-section">
            <div class="comments-header">全部评论 (${commentCount})</div>
            <ul class="comment-list">
                ${commentsHtml}
            </ul>
        </div>

        <div class="comment-input-wrapper" style="position:sticky;bottom:0;background:var(--panel-bg,#fff);border-top:1px solid #e0e0e0;padding:0;display:flex;flex-direction:column;">
            <div id="forum-reply-bar" class="forum-reply-bar" style="display:none;">
                <span class="forum-reply-bar-text">回复 <span id="forum-reply-bar-name"></span></span>
                <button type="button" id="forum-reply-bar-close" class="forum-reply-bar-close">&times;</button>
            </div>
            <div style="display:flex;gap:10px;align-items:center;padding:10px 15px;">
            <input type="text" id="forum-comment-input" placeholder="写下你的评论..." autocomplete="off" style="flex:1;padding:10px 15px;border:1px solid #e0e0e0;border-radius:20px;outline:none;">
            <button type="button" id="ai-reply-comment-btn" class="icon-btn ai-reply-btn" title="AI回复" style="width:40px;height:40px;">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    <path d="M8 10h.01M12 10h.01M16 10h.01"></path>
                </svg>
            </button>
            <button type="button" id="send-forum-comment-btn" class="icon-btn" style="background:var(--primary-color);color:#fff;border:none;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;box-shadow:none;">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            </button>
            </div>
        </div>
    </main>`;

    const shareBtn = detailScreen.querySelector('#header-share-btn');
    if (shareBtn) shareBtn.addEventListener('click', () => openSharePostModal(post.id));
    detailScreen.querySelectorAll('.forum-poll-option').forEach(function(button) { button.addEventListener('click', function() { if (forumVotePoll(post.id, button.dataset.optionId)) { showToast('投票成功'); renderPostDetail(post); } else { showToast('你已经选择了这个选项'); } }); });

    const likeBtn = detailScreen.querySelector('#like-post-btn');
    if (likeBtn) {
        likeBtn.addEventListener('click', () => forumTogglePostLike(post.id));
        likeBtn.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); forumTogglePostLike(post.id); } });
    }
    
    const favoriteBtn = detailScreen.querySelector('#favorite-post-btn');
    if (favoriteBtn) {
        favoriteBtn.addEventListener('click', () => forumTogglePostFavorite(post.id));
        favoriteBtn.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); forumTogglePostFavorite(post.id); } });
    }

    const deleteBtn = detailScreen.querySelector('#delete-post-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', () => forumDeletePost(post.id));
    const editBtn = detailScreen.querySelector('#edit-post-btn');
    if (editBtn) editBtn.addEventListener('click', () => forumOpenPostEditModal(post.id));

    const sendCommentBtn = detailScreen.querySelector('#send-forum-comment-btn');
    const commentInput = detailScreen.querySelector('#forum-comment-input');
    const aiReplyCommentBtn = detailScreen.querySelector('#ai-reply-comment-btn');
    
    if (sendCommentBtn && commentInput) {
        const sendComment = () => {
            const content = commentInput.value.trim();
            if (content) forumPublishComment(post.id, content);
        };
        sendCommentBtn.addEventListener('click', sendComment);
        commentInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendComment(); });
    }
    
    if (aiReplyCommentBtn) {
        aiReplyCommentBtn.addEventListener('click', () => forumGenerateAICommentReplies(post.id));
    }

    const dmAuthorBtn = detailScreen.querySelector('#forum-dm-author-btn');
    if (dmAuthorBtn && post.username && post.authorId !== 'user') {
        dmAuthorBtn.addEventListener('click', () => {
            const userId = post.authorId || post.npcId || forumStableNpcId(post.username, 'post-author');
            forumOpenDMConversation(userId, post.username);
        });
    }
    const followAuthorBtn = detailScreen.querySelector('#forum-follow-author-btn');
    if (followAuthorBtn) followAuthorBtn.addEventListener('click', function() {
        const followed = forumToggleFollow(post.authorId || post.npcId);
        followAuthorBtn.textContent = followed ? '已关注' : '关注';
        showToast(followed ? '已关注' : '已取消关注');
    });
    const profileAuthorBtn = detailScreen.querySelector('#forum-profile-author-btn');
    if (profileAuthorBtn) profileAuthorBtn.addEventListener('click', function() { forumRenderNpcProfile(post.authorId || post.npcId); });

    // 评论者私信按钮
    detailScreen.querySelectorAll('.comment-dm-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.commentIndex, 10);
            const comment = post.comments && post.comments[idx];
            if (!comment || !comment.username) return;
            const userId = comment.authorId || comment.npcId || forumStableNpcId(comment.username, 'comment-author');
            forumOpenDMConversation(userId, comment.username, { postTitle: post.title, commentContent: comment.content });
        });
    });
    detailScreen.querySelectorAll('.comment-reply-btn').forEach(function(btn) { btn.addEventListener('click', function() { var comment = post.comments[parseInt(btn.dataset.commentIndex, 10)]; if (!comment) return; forumReplyTarget = { commentId: comment.id, username: comment.username, content: comment.content }; renderPostDetail(post); var input = document.getElementById('forum-comment-input'); if (input) input.focus(); }); });
    detailScreen.querySelectorAll('.comment-more-btn').forEach(function(btn) { btn.addEventListener('click', function() { var comment = post.comments[parseInt(btn.dataset.commentIndex, 10)]; if (comment) forumOpenCommentEditModal(post.id, comment.id); }); });

    // 回复栏关闭按钮
    const replyBarClose = detailScreen.querySelector('#forum-reply-bar-close');
    if (replyBarClose) {
        replyBarClose.addEventListener('click', () => {
            forumReplyTarget = null;
            const bar = detailScreen.querySelector('#forum-reply-bar');
            if (bar) bar.style.display = 'none';
            const input = detailScreen.querySelector('#forum-comment-input');
            if (input) input.placeholder = '写下你的评论...';
        });
    }

    // 恢复回复状态
    if (forumReplyTarget) {
        const bar = detailScreen.querySelector('#forum-reply-bar');
        const nameSpan = detailScreen.querySelector('#forum-reply-bar-name');
        if (bar && nameSpan) {
            bar.style.display = 'flex';
            nameSpan.textContent = '@' + forumReplyTarget.username;
            const input = detailScreen.querySelector('#forum-comment-input');
            if (input) input.placeholder = '回复 @' + forumReplyTarget.username + '...';
        }
    }

    const commentList = detailScreen.querySelector('.comment-list');
    if (commentList) {
        commentList.addEventListener('contextmenu', function(e) {
            const li = e.target.closest('.comment-item');
            if (!li || li.dataset.commentIndex === undefined) return;
            e.preventDefault();
            forumHandleCommentLongPress(post.id, parseInt(li.dataset.commentIndex, 10), e.clientX, e.clientY);
        });
        commentList.addEventListener('touchstart', function(e) {
            const li = e.target.closest('.comment-item');
            if (!li || li.dataset.commentIndex === undefined) return;
            forumCommentLongPressTimer = setTimeout(function() {
                const t = e.touches[0];
                forumHandleCommentLongPress(post.id, parseInt(li.dataset.commentIndex, 10), t.clientX, t.clientY);
            }, 400);
        });
        commentList.addEventListener('touchend', function() { clearTimeout(forumCommentLongPressTimer); });
        commentList.addEventListener('touchmove', function() { clearTimeout(forumCommentLongPressTimer); });
    }
}

function forumHandleCommentLongPress(postId, commentIndex, x, y) {
    const post = db.forumPosts.find(p => p.id === postId);
    const comment = post && post.comments && post.comments[commentIndex];
    const menuItems = [
        { label: '回复', action: function() {
            if (!comment) return;
            forumReplyTarget = { commentId: comment.id, username: comment.username, content: comment.content };
            const bar = document.getElementById('forum-reply-bar');
            const nameSpan = document.getElementById('forum-reply-bar-name');
            if (bar && nameSpan) {
                bar.style.display = 'flex';
                nameSpan.textContent = '@' + comment.username;
            }
            const input = document.getElementById('forum-comment-input');
            if (input) { input.placeholder = '回复 @' + comment.username + '...'; input.focus(); }
        }},
        { label: '分享评论', action: function() { openShareCommentModal(postId, commentIndex); } }
    ];
    if (comment && forumAccountOwnsAuthor(comment.authorId)) menuItems.push({ label: '编辑评论', action: function() { forumOpenCommentEditModal(postId, comment.id); } });
    if (typeof triggerHapticFeedback === 'function') triggerHapticFeedback('medium');
    createContextMenu(menuItems, x, y);
}

function setupForumFeature() {
    forumEnsureData();
    forumInitUserProfile();
    forumAddHeaderButtonsAndFAB();
    forumUpdateIdentityChip();
    forumBindNewEvents();
    forumSetupAltAccountEvents();

    const refreshBtn = document.getElementById('forum-refresh-btn');
    const postsContainer = document.getElementById('forum-posts-container');
    const forumScreen = document.getElementById('forum-screen');
    const detailScreen = document.getElementById('forum-post-detail-screen');

    refreshBtn.addEventListener('click', () => {
        handleForumRefresh();
    });

    if (postsContainer) {
        postsContainer.addEventListener('click', (e) => {
            const card = e.target.closest('.forum-post-card[data-id]');
            if (card) {
                if (forumPostDeleteMode) {
                    var id = card.dataset.id;
                    if (forumSelectedPostIds.has(id)) forumSelectedPostIds.delete(id);
                    else forumSelectedPostIds.add(id);
                    renderForumPosts(db.forumPosts, forumGetActiveFilter());
                    return;
                }
                const postId = card.dataset.id;
                const post = db.forumPosts.find(p => p.id === postId);
                if (post) {
                    renderPostDetail(post);
                    switchScreen('forum-post-detail-screen');
                }
            }
        });
    }

    if (detailScreen) {
        detailScreen.addEventListener('click', e => {
            if (e.target.closest('#header-share-btn')) {
                // share logic is bound inside renderPostDetail
            }
        });
    }

    const observer = new MutationObserver((mutations) => {
        for (let mutation of mutations) {
            if (mutation.attributeName === 'class') {
                const isActive = forumScreen.classList.contains('active');
                if (isActive) {
                    if (db.forumPosts && db.forumPosts.length > 0) {
                        renderForumPosts(db.forumPosts);
                    } else {
                        postsContainer.innerHTML = '<p class="placeholder-text" style="margin-top: 50px;">这里空空也...<br>点击右上角刷新按钮加载帖子吧！</p>';
                    }
                    forumUpdateDMUnreadBadge();
                    forumUpdateIdentityChip();
                    forumMaybeAutoAdvance();
                }
            }
        }
    });

    if (forumScreen) {
        observer.observe(forumScreen, { attributes: true });
    }
}

function setupShareModal() {
    const modal = document.getElementById('share-post-modal');
    const confirmBtn = document.getElementById('confirm-share-btn');
    const charList = document.getElementById('share-char-list');

    confirmBtn.addEventListener('click', async () => {
        const checkedInputs = Array.from(charList.querySelectorAll('input:checked'));

        if (checkedInputs.length === 0) {
            showToast('请至少选择一个分享对象。');
            return;
        }

        const selectedChars = checkedInputs.filter(input => input.dataset.shareTarget === 'character').map(input => input.value);
        const selectedGroups = checkedInputs.filter(input => input.dataset.shareTarget === 'group').map(input => input.value);

        const shareType = modal.dataset.shareType || 'post';
        let messageContent = '';

        if (shareType === 'comment') {
            const postId = modal.dataset.postId;
            const commentIndex = parseInt(modal.dataset.commentIndex, 10);
            if (postId === undefined || isNaN(commentIndex)) {
                showToast('无法获取评论信息，分享失败。');
                return;
            }
            const post = db.forumPosts.find(p => p.id === postId);
            if (!post || !post.comments || !post.comments[commentIndex]) {
                showToast('找不到该评论，分享失败。');
                return;
            }
            const comment = post.comments[commentIndex];
            const postContent = (post.content || post.summary || '').replace(/\n/g, ' ');
            messageContent = `[论坛分享-评论]\n帖子标题：${post.title || ''}\n帖子内容：${postContent}\n评论（来自 ${comment.username || '匿名'}）：${comment.content || ''}`;
        } else {
            const postTitle = modal.dataset.postTitle;
            const postSummary = modal.dataset.postSummary;

            if (!postTitle || !postSummary) {
                showToast('无法获取帖子信息，分享失败。');
                return;
            }
            messageContent = `[论坛分享]标题：${postTitle}\n摘要：${postSummary}`;
        }

        // 分享给单人角色
        selectedChars.forEach(charId => {
            const character = db.characters.find(c => c.id === charId);
            if (character) {
                const message = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'user',
                    content: messageContent,
                    parts: [{ type: 'text', text: messageContent }],
                    timestamp: Date.now()
                };
                character.history.push(message);
            }
        });

        // 分享给群聊
        selectedGroups.forEach(groupId => {
            const group = db.groups.find(g => g.id === groupId);
            if (group) {
                const message = {
                    id: `msg_${Date.now()}_${Math.random()}`,
                    role: 'user',
                    content: messageContent,
                    parts: [{ type: 'text', text: messageContent }],
                    timestamp: Date.now()
                };
                group.history.push(message);
            }
        });

        await saveData();
        renderChatList();
        modal.classList.remove('visible');
        const totalCount = selectedChars.length + selectedGroups.length;
        showToast(`成功分享给 ${totalCount} 位联系人！`);
    });
}

function openSharePostModal(postId) {
    const post = db.forumPosts.find(p => p.id === postId);
    if (!post) {
        showToast('找不到该帖子信息。');
        return;
    }

    const modal = document.getElementById('share-post-modal');
    const charList = document.getElementById('share-char-list');
    const detailsElement = modal.querySelector('details');
    const titleEl = document.getElementById('share-modal-title');

    modal.dataset.shareType = 'post';
    modal.dataset.postTitle = post.title;
    modal.dataset.postSummary = post.summary;
    delete modal.dataset.postId;
    delete modal.dataset.commentIndex;
    if (titleEl) titleEl.textContent = '是否将帖子分享给他人？';

    charList.innerHTML = '';

    // 渲染单人角色
    if (db.characters.length > 0) {
        db.characters.forEach(char => {
            const li = document.createElement('li');
            li.className = 'binding-list-item';
            li.innerHTML = `
                <input type="checkbox" id="share-to-${forumEscapeHtml(char.id)}" value="${forumEscapeHtml(char.id)}" data-share-target="character">
                <label for="share-to-${forumEscapeHtml(char.id)}" style="display: flex; align-items: center; gap: 10px;">
                    <img src="${forumEscapeHtml(forumSafeImageUrl(char.avatar))}" alt="${forumEscapeHtml(char.remarkName)}" style="width: 32px; height: 32px; border-radius: 50%;">
                    ${forumEscapeHtml(char.remarkName)}
                </label>
            `;
            charList.appendChild(li);
        });
    }

    // 渲染群聊
    if (db.groups && db.groups.length > 0) {
        db.groups.forEach(group => {
            const li = document.createElement('li');
            li.className = 'binding-list-item';
            li.innerHTML = `
                <input type="checkbox" id="share-to-${forumEscapeHtml(group.id)}" value="${forumEscapeHtml(group.id)}" data-share-target="group">
                <label for="share-to-${forumEscapeHtml(group.id)}" style="display: flex; align-items: center; gap: 10px;">
                    <img src="${forumEscapeHtml(forumSafeImageUrl(group.avatar))}" alt="${forumEscapeHtml(group.name)}" style="width: 32px; height: 32px; border-radius: 50%;">
                    ${forumEscapeHtml(group.name)}
                    <span style="font-size: 12px; color: #999;">[群聊]</span>
                </label>
            `;
            charList.appendChild(li);
        });
    }

    if (db.characters.length === 0 && (!db.groups || db.groups.length === 0)) {
        charList.innerHTML = '<li style="color: #888;">暂无可以分享的对象。</li>';
    }

    if (detailsElement) detailsElement.open = false;

    modal.classList.add('visible');
}

function openShareCommentModal(postId, commentIndex) {
    const post = db.forumPosts.find(p => p.id === postId);
    if (!post || !post.comments || !post.comments[commentIndex]) {
        showToast('找不到该评论信息。');
        return;
    }

    const modal = document.getElementById('share-post-modal');
    const charList = document.getElementById('share-char-list');
    const detailsElement = modal.querySelector('details');
    const titleEl = document.getElementById('share-modal-title');

    modal.dataset.shareType = 'comment';
    modal.dataset.postId = postId;
    modal.dataset.commentIndex = String(commentIndex);
    delete modal.dataset.postTitle;
    delete modal.dataset.postSummary;
    if (titleEl) titleEl.textContent = '是否将这条评论分享给他人？';

    charList.innerHTML = '';

    // 渲染单人角色
    if (db.characters.length > 0) {
        db.characters.forEach(char => {
            const li = document.createElement('li');
            li.className = 'binding-list-item';
            li.innerHTML = `
                <input type="checkbox" id="share-to-${forumEscapeHtml(char.id)}" value="${forumEscapeHtml(char.id)}" data-share-target="character">
                <label for="share-to-${forumEscapeHtml(char.id)}" style="display: flex; align-items: center; gap: 10px;">
                    <img src="${forumEscapeHtml(forumSafeImageUrl(char.avatar))}" alt="${forumEscapeHtml(char.remarkName)}" style="width: 32px; height: 32px; border-radius: 50%;">
                    ${forumEscapeHtml(char.remarkName)}
                </label>
            `;
            charList.appendChild(li);
        });
    }

    // 渲染群聊
    if (db.groups && db.groups.length > 0) {
        db.groups.forEach(group => {
            const li = document.createElement('li');
            li.className = 'binding-list-item';
            li.innerHTML = `
                <input type="checkbox" id="share-to-${forumEscapeHtml(group.id)}" value="${forumEscapeHtml(group.id)}" data-share-target="group">
                <label for="share-to-${forumEscapeHtml(group.id)}" style="display: flex; align-items: center; gap: 10px;">
                    <img src="${forumEscapeHtml(forumSafeImageUrl(group.avatar))}" alt="${forumEscapeHtml(group.name)}" style="width: 32px; height: 32px; border-radius: 50%;">
                    ${forumEscapeHtml(group.name)}
                    <span style="font-size: 12px; color: #999;">[群聊]</span>
                </label>
            `;
            charList.appendChild(li);
        });
    }

    if (db.characters.length === 0 && (!db.groups || db.groups.length === 0)) {
        charList.innerHTML = '<li style="color: #888;">暂无可以分享的对象。</li>';
    }

    if (detailsElement) detailsElement.open = false;

    modal.classList.add('visible');
}

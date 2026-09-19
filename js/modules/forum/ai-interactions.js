async function forumGenerateStrangerDMs() {
    forumEnsureData();
    var generationJob = forumStartJob('stranger-dm');
    const forumApiSettings = db.forumApiSettings || {};
    var apiSettings = forumApiSettings.useForumApi ? forumApiSettings : db.apiSettings;
    apiSettings = typeof getApiConfigForFeature === 'function' ? getApiConfigForFeature('forum', apiSettings) : apiSettings;
    if (typeof isApiConfigReady === 'function' ? !isApiConfigReady(apiSettings) : (!apiSettings.url || !apiSettings.key || !apiSettings.model)) {
        forumFinishJob(generationJob);
        showToast('请先配置API设置');
        return;
    }
    var refreshBtn = document.getElementById('forum-dm-list-refresh-btn');
    if (refreshBtn) refreshBtn.disabled = true;
    showToast('正在生成陌生人私信...');
    try {
        forumInitUserProfile();
        var activeAccount = forumGetActiveAccount();
        var worldContext = getForumGenerationContext();
        var activeAuthorId = forumLegacyAuthorId(generationJob.accountId);
        var userPosts = (db.forumPosts || []).filter(function(p) { return p.authorId === activeAuthorId || p.authorId === generationJob.accountId; });
        var userPostsText = '';
        if (userPosts.length === 0) {
            userPostsText = '用户暂无发帖记录。';
        } else {
            userPosts.slice(0, 5).forEach(function(p, i) {
                userPostsText += '【帖子' + (i + 1) + '】\n标题: ' + (p.title || '') + '\n内容: ' + (p.content || '') + '\n\n';
            });
        }
        // 收集用户在其他帖子下的评论/回复（被这些发言吸引的人也可能来私信）
        var userCommentsList = [];
        (db.forumPosts || []).forEach(function(p) {
            if (!p.comments) return;
            p.comments.forEach(function(c) {
            if ((c.authorId === activeAuthorId || c.authorId === generationJob.accountId) && (c.content || '').trim()) {
                    userCommentsList.push({ postTitle: p.title || '(无标题)', postContent: (p.content || '').slice(0, 80), comment: (c.content || '').trim() });
                }
            });
        });
        var userCommentsText = '';
        if (userCommentsList.length === 0) {
            userCommentsText = '用户暂无在其他帖子下的评论或回复。';
        } else {
            userCommentsList.slice(0, 10).forEach(function(item, i) {
                userCommentsText += '【评论' + (i + 1) + '】在帖子《' + item.postTitle + '》下的回复：' + item.comment + '\n\n';
            });
        }
        var strangerCount = (db.forumSettings && db.forumSettings.dmPerGeneration != null) ? Math.max(1, Math.min(20, parseInt(db.forumSettings.dmPerGeneration, 10))) : 4;
        var generateDetailed = !!(db.forumSettings && db.forumSettings.generateDetailedStranger);
        var enableCharAlt = !!(db.forumSettings && db.forumSettings.enableCharAltDm);
        var charAltIds = (db.forumSettings && db.forumSettings.charAltCharIds) || [];
        var charAltNames = (db.forumSettings && db.forumSettings.charAltNames) || {};
        var charAltProb = (db.forumSettings && db.forumSettings.charAltProbability) != null ? Math.max(0, Math.min(100, db.forumSettings.charAltProbability)) : 25;
        var altCount = 0;
        if (enableCharAlt && charAltIds.length > 0) {
            altCount = Math.min(charAltIds.length, Math.max(0, Math.floor(strangerCount * charAltProb / 100)));
        }
        var normalCount = strangerCount - altCount;

        var jsonData = { dms: [] };
        if (normalCount > 0) {
            var systemPrompt;
            if (generateDetailed) {
                systemPrompt = '你是一位论坛私信模拟专家。根据以下背景信息，模拟「若干陌生人向用户发送私信」的场景，并为每个陌生人生成一份可聊天的基础人设。\n\n===== 世界观与设定 =====\n' + worldContext + '\n\n===== 用户（收件人）信息 =====\n昵称: ' + (activeAccount.username || '用户') + '\n简介: ' + (activeAccount.bio || '无') + '\n\n===== 用户发过的帖子 =====\n' + userPostsText + '\n===== 用户在其他帖子下的评论/回复 =====\n' + userCommentsText + '\n请生成 ' + normalCount + ' 条陌生人私信，且为每个陌生人生成基础人设。要求：\n1. 每条私信来自不同的NPC，senderName 为符合世界观的论坛昵称。\n2. 私信内容自然口语化，1～2 句话即可。\n3. 每个 NPC 的 basicPersona 必须包含：性别、性格（如开朗/冷淡/傲娇等）、大致家世或身份（如学生/上班族/家境等）、年龄或年龄段、与世界观的关系等，便于日后加好友聊天，不要纯人机感。用一两段话描述即可。\n4. 不要以用户视角创作，不要出现 char 的备注名等仅用户可见信息。\n\n请严格按以下 XML 标签格式返回，不要包含其它说明或 markdown：\n<dms>\n  <dm>\n    <senderName>NPC昵称</senderName>\n    <content>该陌生人发给用户的一条私信内容</content>\n    <basicPersona>性别、性格、家世/身份、年龄等基础人设描述，一两段话</basicPersona>\n  </dm>\n</dms>';
            } else {
                systemPrompt = '你是一位论坛私信模拟专家。根据以下背景信息，模拟「若干陌生人向用户发送私信」的场景。\n\n===== 世界观与设定 =====\n' + worldContext + '\n\n===== 用户（收件人）信息 =====\n昵称: ' + (activeAccount.username || '用户') + '\n简介: ' + (activeAccount.bio || '无') + '\n\n===== 用户发过的帖子 =====\n' + userPostsText + '\n===== 用户在其他帖子下的评论/回复 =====\n' + userCommentsText + '\n请生成 ' + normalCount + ' 条陌生人私信。要求：\n1. 每条私信来自不同的NPC（陌生人），senderName 为符合世界观的论坛昵称。\n2. 若用户发过帖或发过评论：私信内容可以是看到用户某篇帖子后的搭讪、提问、共鸣，也可以是看到用户在某条帖子下的回复/评论后被吸引来打招呼，语气自然、口语化。\n3. 若用户从未发帖也从未评论：私信可以是简单打招呼、自我介绍、或与世界观/社区氛围相关的一句闲聊。\n4. 每条私信 1～2 句话即可，像真实论坛私信。\n5. 不要以用户视角创作，不要出现 char 的备注名等仅用户可见信息。\n\n请严格按以下 XML 标签格式返回，不要包含其它说明或 markdown：\n<dms>\n  <dm>\n    <senderName>NPC昵称</senderName>\n    <content>该陌生人发给用户的一条私信内容</content>\n  </dm>\n</dms>';
            }
            var url = apiSettings.url;
            if (url.endsWith('/')) url = url.slice(0, -1);
            var temperature = apiSettings.temperature !== undefined ? apiSettings.temperature : 0.9;
            var requestBody = { model: apiSettings.model, messages: [{ role: 'user', content: systemPrompt }], temperature: temperature };
            var endpoint = url + '/v1/chat/completions';
            var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiSettings.key };
            var contentStr = await fetchAiResponse(apiSettings, requestBody, headers, endpoint);
            
            var dmRegex = /<dm>([\s\S]*?)<\/dm>/g;
            var dmMatch;
            while ((dmMatch = dmRegex.exec(contentStr)) !== null) {
                var dmContent = dmMatch[1];
                var idMatch = dmContent.match(/<senderId>([\s\S]*?)<\/senderId>/);
                var sMatch = dmContent.match(/<senderName>([\s\S]*?)<\/senderName>/);
                var cMatch = dmContent.match(/<content>([\s\S]*?)<\/content>/);
                var pMatch = dmContent.match(/<basicPersona>([\s\S]*?)<\/basicPersona>/);
                if (sMatch && cMatch) {
                    jsonData.dms.push({
                        senderId: idMatch ? idMatch[1].trim() : '',
                        senderName: sMatch[1].trim(),
                        content: cMatch[1].trim(),
                        basicPersona: pMatch ? pMatch[1].trim() : ''
                    });
                }
            }
            if (jsonData.dms.length === 0) throw new Error('AI返回的数据格式不正确');
        }

        if (jsonData.dms.length > 0 || altCount > 0) {
            if (!forumJobIsCurrent(generationJob)) throw new Error('本次生成已因切换身份或新请求而取消');
            if (!db.forumMessages) db.forumMessages = [];
            if (!db.forumStrangerProfiles) db.forumStrangerProfiles = {};
            var baseTime = Date.now();
            var offset = 0;
            jsonData.dms.forEach(function(dm, i) {
                var senderName = (dm.senderName || ('路人' + (i + 1))).trim().replace(/\s+/g, '_');
                if (!senderName) senderName = '路人' + (i + 1);
                var fromUserId = forumResolveNpcId(dm.senderId, senderName, 'generated-stranger');
                db.forumMessages.push({
                    id: 'dm_' + baseTime + '_' + i + '_' + Math.random(),
                    fromUserId: fromUserId,
                    toUserId: 'user',
                    content: (dm.content || '').trim() || '你好',
                    timestamp: baseTime + i,
                    isRead: false,
                    accountId: generationJob.accountId
                });
                var previousProfile = db.forumStrangerProfiles[fromUserId] || {};
                db.forumStrangerProfiles[fromUserId] = forumNormalizeNpcProfile(Object.assign({}, previousProfile, {
                    name: senderName,
                    basicPersona: (dm.basicPersona || previousProfile.basicPersona || '').trim() || ('论坛用户，昵称：' + senderName + '。更多信息会在交流中逐渐了解。'),
                    publicPersona: (dm.basicPersona || previousProfile.publicPersona || '').trim(),
                    avatar: (dm.avatar && dm.avatar.trim()) ? dm.avatar : (previousProfile.avatar || FORUM_DEFAULT_AVATAR),
                    lastActiveAt: baseTime + i
                }), fromUserId);
                forumAdjustRelationship(fromUserId, { curiosity: 2 }, '陌生人因公开发言主动私信', generationJob.accountId);
                offset = i + 1;
            });
            var altTemplates = ['你好呀，看到你的动态了～', '嗨，来打个招呼', '你好～', '看到你发的了，忍不住来聊两句'];
            var altNicknames = [];
            if (altCount > 0) {
                var fallbackAltNames = ['清风明月', '夜雨声烦', '星河', '柠檬不萌', '夏日微风', '云深不知处', '落叶知秋', '晨曦', '暗香', '浮生若梦', '陌上花开', '北城以念', '南巷清风', '西楼月', '东篱把酒'];
                try {
                    var url = apiSettings.url;
                    if (url.endsWith('/')) url = url.slice(0, -1);
                    var altPrompt = '你是一位论坛/社区模拟专家。根据以下世界观，生成 ' + altCount + ' 个「看起来像真实论坛用户」的论坛昵称。要求：\n1. 每个昵称 2～8 个字符，像普通人会起的网名（可文艺、可随意、可带符号感），符合该世界观的氛围。\n2. 不要出现「小号」「马甲」等字样，不要像内部 ID。\n3. ' + altCount + ' 个昵称彼此不重复。\n\n===== 世界观与设定 =====\n' + worldContext + '\n\n请严格按以下 XML 标签格式返回，不要包含其它说明或 markdown：\n<nicknames>\n  <nickname>昵称1</nickname>\n  <nickname>昵称2</nickname>\n</nicknames>';
                    var altRequestBody = { model: apiSettings.model, messages: [{ role: 'user', content: altPrompt }], temperature: 0.8 };
                    var altEndpoint = url + '/v1/chat/completions';
                    var altHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiSettings.key };
                    var altContentStr = await fetchAiResponse(apiSettings, altRequestBody, altHeaders, altEndpoint);
                    
                    var nickRegex = /<nickname>([\s\S]*?)<\/nickname>/g;
                    var nickMatch;
                    while ((nickMatch = nickRegex.exec(altContentStr)) !== null) {
                        var n = nickMatch[1].trim();
                        if (n) altNicknames.push(n.replace(/\s+/g, '_').slice(0, 20));
                    }
                    altNicknames = altNicknames.slice(0, altCount);
                } catch (e) { console.warn('生成角色小号昵称失败，使用备用昵称', e); }
                while (altNicknames.length < altCount) {
                    altNicknames.push(fallbackAltNames[(altNicknames.length + altCount) % fallbackAltNames.length] + (altNicknames.length > 0 ? '_' + altNicknames.length : ''));
                }
            }
            for (var a = 0; a < altCount; a++) {
                var charId = charAltIds[a % charAltIds.length];
                var mainChar = db.characters && db.characters.find(function(c) { return c.id === charId; });
                if (!mainChar) continue;
                var customName = (charAltNames[charId] || '').trim();
                var altDisplayName = customName ? customName.replace(/\s+/g, '_').slice(0, 20) : ((altNicknames[a] || fallbackAltNames[a % fallbackAltNames.length]).trim().replace(/\s+/g, '_') || ('路人' + (offset + a + 1)));
                var fromUserId = 'npc_alt_' + charId + '_' + baseTime + '_' + a;
                db.forumMessages.push({
                    id: 'dm_' + baseTime + '_alt_' + a + '_' + Math.random(),
                    fromUserId: fromUserId,
                    toUserId: 'user',
                    content: altTemplates[a % altTemplates.length],
                    timestamp: baseTime + offset + a,
                    isRead: false,
                    accountId: generationJob.accountId
                });
                db.forumStrangerProfiles[fromUserId] = {
                    name: altDisplayName,
                    basicPersona: '普通论坛用户，网名：' + altDisplayName + '。真实信息尚未公开。',
                    publicPersona: '普通论坛用户，网名：' + altDisplayName + '。',
                    privatePersona: (mainChar.persona || '').trim(),
                    disguisePersona: '以陌生网友身份接近用户；未被识破前不得直接透露真实身份。',
                    avatar: FORUM_DEFAULT_AVATAR,
                    linkedCharId: charId
                };
            }
            await saveData();
            forumRenderDMList();
            forumUpdateDMUnreadBadge();
            var total = jsonData.dms.length + altCount;
            showToast('已生成 ' + total + ' 条陌生人私信' + (altCount > 0 ? '（含 ' + altCount + ' 条角色小号）' : ''));
        } else {
            throw new Error('AI返回的数据格式不正确');
        }
    } catch (error) {
        console.error('生成陌生人私信失败:', error);
        showApiError(error);
    } finally {
        forumFinishJob(generationJob);
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

async function forumGenerateAIDMReply() {
    if (!forumCurrentDMUserId) {
        showToast('请先选择私信对象');
        return;
    }
    const targetUserId = forumCurrentDMUserId;
    const generationJob = forumStartJob('dm-reply', targetUserId);
    
    const forumApiSettings = db.forumApiSettings || {};
    let apiSettings = forumApiSettings.useForumApi ? forumApiSettings : db.apiSettings;
    apiSettings = typeof getApiConfigForFeature === 'function' ? getApiConfigForFeature('forum', apiSettings) : apiSettings;
    
    if (typeof isApiConfigReady === 'function' ? !isApiConfigReady(apiSettings) : (!apiSettings.url || !apiSettings.key || !apiSettings.model)) {
        forumFinishJob(generationJob);
        showToast('请先配置API设置');
        return;
    }
    
    const aiReplyBtn = document.getElementById('ai-reply-dm-btn');
    
    if (aiReplyBtn) aiReplyBtn.disabled = true;
    if (typeof forumSetDMPresence === 'function') forumSetDMPresence('正在输入…');
    showToast('AI正在生成回复...');
    
    try {
        const npcProfile = getForumStrangerProfile(targetUserId);
        const npcName = (npcProfile && npcProfile.name) || targetUserId.replace(/^npc_/, '');
        const npcPosts = (db.forumPosts || []).filter(p => p.authorId === targetUserId || p.npcId === targetUserId);
        
        const worldContext = getForumGenerationContext();
        
        let npcContext = `这是一个名叫"${npcName}"的论坛用户。`;
        if (npcProfile && npcProfile.basicPersona) {
            npcContext += `\n\n基础人设:\n${npcProfile.basicPersona}`;
        }
        if (npcProfile && npcProfile.linkedCharId) {
            const linkedChar = (db.characters || []).find(c => c.id === npcProfile.linkedCharId);
            npcContext += `\n\n【双重身份，仅供扮演决策】\n真实身份：${linkedChar ? linkedChar.realName : '已绑定角色'}\n真实人格：${npcProfile.privatePersona || (linkedChar && linkedChar.persona) || ''}\n公开伪装：${npcProfile.publicPersona || npcProfile.basicPersona || ''}\n伪装规则：${npcProfile.disguisePersona || '未被可靠识破前维持陌生网友身份，只允许细微习惯形成破绽，不得无故自曝。'}`;
        }
        if (npcPosts.length > 0) {
            npcContext += `\n\n以下是Ta发过的帖子:\n`;
            npcPosts.slice(0, 3).forEach(post => {
                npcContext += `标题: ${post.title}\n内容: ${post.content}\n\n`;
            });
        }
        
        // 注入该NPC在论坛中的评论上下文
        const npcComments = [];
        (db.forumPosts || []).forEach(p => {
            if (p.comments) {
                p.comments.forEach(c => {
                    if (c.authorId === targetUserId || c.npcId === targetUserId) {
                        npcComments.push({ postTitle: p.title, content: c.content });
                    }
                });
            }
        });
        if (npcComments.length > 0) {
            npcContext += `\n\n以下是Ta在论坛中发过的评论:\n`;
            npcComments.slice(0, 5).forEach(c => {
                npcContext += `在帖子「${c.postTitle}」下评论: ${c.content}\n`;
            });
        }
        
        forumInitUserProfile();
        const activeAccount = forumGetActiveAccount();
        const userContext = activeAccount.isAlt
            ? `用户资料:\n昵称: ${activeAccount.username}\n简介: ${activeAccount.bio || '无'}\n（注意：这是一个你不认识的用户，你对Ta一无所知）`
            : `用户资料:\n昵称: ${activeAccount.username}\n简介: ${activeAccount.bio || '无'}`;
        
        const conversation = (db.forumMessages || [])
            .filter(m => forumMessageBelongsToAccount(m, generationJob.accountId) && ((m.fromUserId === 'user' && m.toUserId === targetUserId) ||
                         (m.fromUserId === targetUserId && m.toUserId === 'user')))
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
            .slice(-10);
        
        let conversationText = '对话历史:\n';
        if (conversation.length > 0) {
            conversation.forEach(m => {
                const sender = m.fromUserId === 'user' ? activeAccount.username : npcName;
                conversationText += `${sender}: ${m.content}\n`;
            });
        } else {
            conversationText += '(这是第一次对话)\n';
        }
        
        const replyCount = (db.forumSettings && db.forumSettings.detailReplyCount) || 2;
        const relationship = forumGetRelationship(targetUserId, generationJob.accountId);
        const relationshipContext = Object.assign({}, relationship);
        delete relationshipContext.events;
        const knownFacts = db.forumSettings.enableKnowledgeBoundaries === false ? [] : (db.forumKnowledge || []).filter(k => k.ownerId === targetUserId && k.accountId === generationJob.accountId && !k.denied).slice(-12);
        
        const systemPrompt = `你正在扮演论坛用户"${npcName}"，根据以下信息生成${replyCount}条连续的私信回复。

===== 世界观背景 =====
${worldContext}

===== 角色信息 =====
${npcContext}

===== 用户信息 =====
${userContext}

===== 对话历史 =====
${conversationText}

===== 关系与认知边界 =====
当前关系状态：${JSON.stringify(relationshipContext)}
你有来源、允许知道的事实：${knownFacts.length ? knownFacts.map(k => '[' + k.source + '] ' + k.fact).join('\n') : '暂无额外事实。只能使用公开资料和本次对话，不得读取其他账号或私密资料。'}
互动偏好：主动程度 ${db.forumSettings.proactiveIntensity}/100；恋爱剧情倾向 ${db.forumSettings.romanceIntensity}/100；冲突剧情强度 ${db.forumSettings.conflictIntensity}/100。数值只调节出现概率与表达力度，不能覆盖人格、关系基础、知情范围与用户边界。

===== 好友状态（重要） =====
当前是否已是好友：${forumIsFriend(targetUserId) ? '是' : '否'}。
用户是否已点击「添加好友」并发送了好友申请（等待你同意）：${forumHasPendingFriendRequestFromUser(targetUserId) ? '是' : '否'}。
- 若用户**已发送**好友申请：请在本轮回复中表示同意加好友（如「好呀」「通过啦」等），系统会在本轮后自动加为好友。
- 若用户**尚未发送**好友申请（只是聊天里说想加好友）：请勿说「通过了」「已同意」等，应说「好呀，你点一下右上角添加好友吧」或「好呀，你加我还是我加你？」引导用户去点按钮发送申请。

请以"${npcName}"的口吻和风格，根据世界观设定、Ta发过的帖子内容和人设，生成${replyCount}条自然、符合角色性格的私信回复。回复应该简短自然，就像真实的私信对话一样，可以分多条发送，每条独立表达一个想法或情绪。

【关于加好友的极度慎重规则】
是否提出加好友，必须**极其慎重地根据你的人设性格以及当前聊天的深度来决定**：
1. 若你的性格偏内向、谨慎、高冷、防备心重，或者目前只是初次搭讪、聊得还不深（低于10个回合），**绝对不要**轻易提出加好友。
2. 若你是伪装身份的“角色小号”，更应注重伪装和试探，把加好友当作一个比较重大的决定，不要因过于主动而暴露破绽。
3. 只有当你的性格极度开朗自来熟，或者双方已经聊得非常投机、有明确继续深入交往的必要时，才能在回复中自然地表达加好友意愿（例如："我们要不要加个好友？"），并在JSON中设置 "suggestFriend": true；否则，请务必设置 "suggestFriend": false。

返回XML标签格式:
<result>
  <replies>
    <reply>第一条回复内容</reply>
    <reply>第二条回复内容</reply>
  </replies>
  <suggestFriend>false</suggestFriend>
  <friendDecision>none</friendDecision>
  <relationshipReason>本轮关系变化的简短原因</relationshipReason>
</result>
friendDecision 只能是 none、accept、reject、defer。仅当用户确实已发送好友申请时才决定 accept/reject/defer；必须服从角色人格、边界、信任和聊天深度，不得一律同意。
`;
        
        let url = apiSettings.url;
        if (url.endsWith('/')) url = url.slice(0, -1);
        
        const temperature = apiSettings.temperature !== undefined ? apiSettings.temperature : 0.9;
        
        const requestBody = {
            model: apiSettings.model,
            messages: [{ role: "user", content: systemPrompt }],
            temperature: temperature
        };
        
        const endpoint = `${url}/v1/chat/completions`;
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiSettings.key}` };
        
        const contentStr = await fetchAiResponse(apiSettings, requestBody, headers, endpoint);
        
        const replies = [];
        const replyRegex = /<reply>([\s\S]*?)<\/reply>/g;
        let replyMatch;
        while ((replyMatch = replyRegex.exec(contentStr)) !== null) {
            if (replyMatch[1].trim()) replies.push(replyMatch[1].trim());
        }
        
        const suggestFriendMatch = contentStr.match(/<suggestFriend>([\s\S]*?)<\/suggestFriend>/i);
        const suggestFriend = suggestFriendMatch ? suggestFriendMatch[1].trim().toLowerCase() === 'true' : false;
        const friendDecisionMatch = contentStr.match(/<friendDecision>([\s\S]*?)<\/friendDecision>/i);
        const friendDecision = friendDecisionMatch ? friendDecisionMatch[1].trim().toLowerCase() : 'defer';
        const relationshipReasonMatch = contentStr.match(/<relationshipReason>([\s\S]*?)<\/relationshipReason>/i);
        
        if (replies.length > 0) {
            if (!forumJobIsCurrent(generationJob) || forumCurrentDMUserId !== targetUserId) throw new Error('本次回复已因切换身份、会话或新请求而取消');
            if (!db.forumMessages) db.forumMessages = [];
            
            replies.forEach((replyContent, index) => {
                const newMessage = {
                    id: 'dm_' + Date.now() + '_' + Math.random(),
                    fromUserId: targetUserId,
                    toUserId: 'user',
                    content: (replyContent && replyContent.trim) ? replyContent.trim() : String(replyContent),
                    timestamp: Date.now() + index,
                    isRead: true,
                    accountId: generationJob.accountId
                };
                db.forumMessages.push(newMessage);
            });
            
            await saveData();
            if (forumCurrentDMUserId === targetUserId) forumRenderDMConversation(targetUserId);
            showToast(`${npcName}发来了${replies.length}条消息`);
            
            forumAdjustRelationship(targetUserId, { familiarity: 2, privateCloseness: 1, curiosity: 1 }, relationshipReasonMatch ? relationshipReasonMatch[1].trim() : '继续私信交流', generationJob.accountId);
            if (forumHasPendingFriendRequestFromUser(targetUserId) && friendDecision === 'accept') {
                const profile = getForumStrangerProfile(targetUserId) || { name: npcName, avatar: '', basicPersona: '' };
                if (!forumIsFriend(targetUserId)) forumAddForumNPCAsCharacter(profile, targetUserId);
                forumSetPendingFriendRequestFromUser(targetUserId, false);
                (db.forumFriendRequests || []).filter(r => r.accountId === generationJob.accountId && r.npcId === targetUserId && r.status === 'pending').forEach(r => { r.status = 'accepted'; r.resolvedAt = Date.now(); });
                relationship.status = 'friend';
                saveData();
                showToast('已加为好友');
                var addFriendBtn = document.getElementById('forum-dm-add-friend-btn');
                if (addFriendBtn) { addFriendBtn.style.display = 'none'; }
            } else if (forumHasPendingFriendRequestFromUser(targetUserId) && friendDecision === 'reject') {
                forumSetPendingFriendRequestFromUser(targetUserId, false);
                (db.forumFriendRequests || []).filter(r => r.accountId === generationJob.accountId && r.npcId === targetUserId && r.status === 'pending').forEach(r => { r.status = 'rejected'; r.resolvedAt = Date.now(); });
                saveData();
                forumAdjustRelationship(targetUserId, { guard: 8, grievance: 2 }, '角色拒绝好友申请', generationJob.accountId);
                showToast(npcName + '拒绝了好友申请');
            } else if (forumHasPendingFriendRequestFromUser(targetUserId) && friendDecision === 'defer') {
                showToast(npcName + '暂时没有处理好友申请');
            } else if (suggestFriend && !forumIsFriend(targetUserId)) {
                const profile = getForumStrangerProfile(targetUserId) || {};
                forumShowFriendRequestModal({
                    fromUserId: targetUserId,
                    fromName: profile.name || npcName,
                    fromAvatar: (profile.avatar && profile.avatar.trim()) ? profile.avatar : FORUM_DEFAULT_AVATAR
                });
            }
        } else {
            throw new Error('AI返回的数据格式不正确');
        }
        
    } catch (error) {
        console.error('AI回复生成失败:', error);
        showApiError(error);
    } finally {
        forumFinishJob(generationJob);
        if (typeof forumSetDMPresence === 'function') forumSetDMPresence('');
        if (aiReplyBtn) aiReplyBtn.disabled = false;
    }
}

async function forumGenerateAICommentReplies(postId) {
    const post = db.forumPosts.find(p => p.id === postId);
    if (!post) return;
    const generationJob = forumStartJob('detail-comment:' + postId, postId);
    
    const forumApiSettings = db.forumApiSettings || {};
    let apiSettings = forumApiSettings.useForumApi ? forumApiSettings : db.apiSettings;
    apiSettings = typeof getApiConfigForFeature === 'function' ? getApiConfigForFeature('forum', apiSettings) : apiSettings;
    
    if (typeof isApiConfigReady === 'function' ? !isApiConfigReady(apiSettings) : (!apiSettings.url || !apiSettings.key || !apiSettings.model)) {
        forumFinishJob(generationJob);
        showToast('请先配置API设置');
        return;
    }
    
    const aiReplyBtn = document.getElementById('ai-reply-comment-btn');
    if (aiReplyBtn) aiReplyBtn.disabled = true;
    showToast('AI正在生成评论...');
    
    try {
        const replyCount = (db.forumSettings && db.forumSettings.detailReplyCount) || 2;
        const context = getForumGenerationContext();
        
        let existingComments = '';
        let repliedNpcNames = [];
        if (post.comments && post.comments.length > 0) {
            existingComments = '现有评论（括号内是评论ID，回复时必须引用该ID）:\n';
            post.comments.forEach(c => {
                const replyPrefix = c.replyTo ? `（回复 @${c.replyTo.username}）` : '';
                existingComments += `[评论ID:${c.id}][账号ID:${c.authorId || ''}] ${c.username}${replyPrefix}: ${c.content}\n`;
                // 收集被用户回复过的NPC
                if (c.replyTo && (c.authorId === 'user' || (c.authorId && c.authorId.startsWith('alt_')))) {
                    if (!repliedNpcNames.includes(c.replyTo.username)) {
                        repliedNpcNames.push(c.replyTo.username);
                    }
                }
            });
        }
        
        let repliedNpcHint = '';
        if (repliedNpcNames.length > 0) {
            repliedNpcHint = `\n重要提示：用户回复了以下NPC的评论，这些NPC大概率会继续参与讨论，请确保至少有${Math.min(repliedNpcNames.length, replyCount)}个出现在新评论中：${repliedNpcNames.join('、')}。他们可以回应用户的回复，继续互动。\n`;
        }
        
        const systemPrompt = `你是一位论坛内容生成专家。
背景信息：
${context}

帖子信息：
标题: ${post.title}
内容: ${post.content}
作者: ${post.username}

${existingComments}
${repliedNpcHint}
请生成${replyCount}条不同视角的评论。每条评论要有独特的观点，可以互相回复或讨论。评论者都是NPC，要根据背景设定来回复。

返回XML标签格式:
<comments>
  <comment>
    <commenterId>若继续回复现有评论者，填写该评论者的账号ID；新评论者留空</commenterId>
    <username>评论者昵称</username>
    <content>评论内容</content>
    <timestamp>刚刚</timestamp>
    <replyToId>若回复现有评论则填写评论ID，否则留空</replyToId>
  </comment>
</comments>
`;
        
        let url = apiSettings.url;
        if (url.endsWith('/')) url = url.slice(0, -1);
        
        const temperature = apiSettings.temperature !== undefined ? apiSettings.temperature : 0.9;
        
        const requestBody = {
            model: apiSettings.model,
            messages: [{ role: "user", content: systemPrompt }],
            temperature: temperature
        };
        
        const endpoint = `${url}/v1/chat/completions`;
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiSettings.key}` };
        
        const contentStr = await fetchAiResponse(apiSettings, requestBody, headers, endpoint);
        
        const comments = [];
        const commentRegex = /<comment>([\s\S]*?)<\/comment>/g;
        let commentMatch;
        while ((commentMatch = commentRegex.exec(contentStr)) !== null) {
            const cContent = commentMatch[1];
            const commenterIdMatch = cContent.match(/<commenterId>([\s\S]*?)<\/commenterId>/);
            const uMatch = cContent.match(/<username>([\s\S]*?)<\/username>/);
            const textMatch = cContent.match(/<content>([\s\S]*?)<\/content>/);
            const timeMatch = cContent.match(/<timestamp>([\s\S]*?)<\/timestamp>/);
            const replyToMatch = cContent.match(/<replyToId>([\s\S]*?)<\/replyToId>/);
            if (uMatch && textMatch) {
                comments.push({
                    candidateNpcId: commenterIdMatch ? commenterIdMatch[1].trim() : '',
                    username: uMatch[1].trim(),
                    content: textMatch[1].trim(),
                    timestamp: timeMatch ? timeMatch[1].trim() : '刚刚',
                    replyToId: replyToMatch ? replyToMatch[1].trim() : ''
                });
            }
        }
        
        if (comments.length > 0) {
            if (!forumJobIsCurrent(generationJob) || !db.forumPosts.some(p => p.id === postId)) throw new Error('帖子已变化，本次评论未写入');
            if (!post.comments) post.comments = [];
            
            comments.forEach(comment => {
                const npcId = forumResolveNpcId(comment.candidateNpcId, comment.username || '路人', 'detail-comment');
                const replyTarget = comment.replyToId && post.comments.find(function(c) { return c.id === comment.replyToId; });
                const newComment = {
                    id: forumNewId('comment'),
                    authorId: npcId,
                    npcId: npcId,
                    username: comment.username || '路人' + Math.floor(100 + Math.random() * 900),
                    content: comment.content || '',
                    timestamp: comment.timestamp || '刚刚',
                    timestampMs: Date.now(),
                    replyTo: replyTarget ? { commentId: replyTarget.id, username: replyTarget.username } : undefined
                };
                post.comments.push(newComment);
                if (replyTarget && String(replyTarget.authorId || '').indexOf('npc') === 0) forumRecordSocialInteraction(npcId, replyTarget.authorId, 'reply');
                if (forumAccountOwnsAuthor(post.authorId, generationJob.accountId) || (replyTarget && forumAccountOwnsAuthor(replyTarget.authorId, generationJob.accountId))) {
                    forumAddNotification(generationJob.accountId, 'comment_reply', (comment.username || '有人') + ' 回复了你的内容', { postId: postId, commentId: newComment.id, npcId: npcId });
                }
            });
            
            await saveData();
            renderPostDetail(post);
            showToast(`成功生成${comments.length}条AI评论`);
        }
        
    } catch (error) {
        console.error('AI评论生成失败:', error);
        showApiError(error);
    } finally {
        forumFinishJob(generationJob);
        if (aiReplyBtn) aiReplyBtn.disabled = false;
    }
}

async function forumSupplementPersonaFromChat(chatId, character) {
    if (!character || (character.source !== 'forum' && character.source !== 'peek') || !character.supplementPersonaAiEnabled) return;
    var apiSettings = (db.supplementPersonaApiSettings && db.supplementPersonaApiSettings.url && db.supplementPersonaApiSettings.key && db.supplementPersonaApiSettings.model)
        ? db.supplementPersonaApiSettings
        : db.apiSettings;
    if (!apiSettings || !apiSettings.url || !apiSettings.key || !apiSettings.model) return;
    var history = character.history || [];
    var recent = history.slice(-8);
    if (recent.length === 0) return;
    var convText = recent.map(function(m) {
        var who = m.role === 'user' ? (character.myName || '用户') : character.realName;
        var content = (m.content || '').trim();
        if (m.parts && m.parts.length) content = m.parts.map(function(p) { return p.text || ''; }).join('').trim() || content;
        return who + ': ' + content;
    }).join('\n');
    var basePersona = (character.persona || '').slice(0, 500);
    var existingSupplement = (character.supplementPersonaText || '').slice(0, 800);
    var systemPrompt = '你是一个人设补充助手。请根据「最近对话」**只提取【该角色（NPC）在对话中向用户透露的、关于自己的信息】**，整理成简短的人设条目，用于补充该角色的人设档案。\n\n要求：\n- 只输出「关于这个角色我们新知道了什么」，例如：角色在对话里告诉用户「我叫小明」→ 补充「姓名：小明」；若提到喜好、经历、习惯、身份等，也按「条目：内容」格式补充。\n- 不要总结对话过程，不要写「用户说了…角色回答了…」，只写该角色的人设信息。\n- 若本轮对话中角色没有透露任何关于自己的新信息，则返回空。\n\n只返回 XML 标签格式：<supplement>姓名：xxx\n喜好：xxx\n...</supplement> 或 <supplement></supplement>。\n\n已有基础人设（节选）:\n' + basePersona + '\n\n已补齐人设（节选）:\n' + existingSupplement + '\n\n最近对话:\n' + convText;
    try {
        var url = apiSettings.url;
        if (url.endsWith('/')) url = url.slice(0, -1);
        var requestBody = { model: apiSettings.model, messages: [{ role: 'user', content: systemPrompt }], temperature: 0.3 };
        var contentStr = await fetchAiResponse(apiSettings, requestBody, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiSettings.key }, url + '/v1/chat/completions');
        
        var suppMatch = contentStr.match(/<supplement>([\s\S]*?)<\/supplement>/);
        var supplement = suppMatch ? suppMatch[1].trim() : '';
        if (supplement) {
            character.supplementPersonaText = ((character.supplementPersonaText || '').trim() ? (character.supplementPersonaText || '').trim() + '\n\n' : '') + supplement;
            saveData();
        }
    } catch (e) { console.error('AI补齐人设提取失败', e); }
}
if (typeof window !== 'undefined') window.forumSupplementPersonaFromChat = forumSupplementPersonaFromChat;

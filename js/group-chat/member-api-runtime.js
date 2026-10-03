(function () {
    const runs = new Map();
    const clone = value => window.RoleApiBindings.clone(value);
    const lastUser = group => [...(group.history || [])].reverse().find(message => message.role === 'user' && !message.excludeFromContext)?.id || '';
    const name = member => member.groupNickname || member.realName || '成员';
    function isIndependent(group) {
        if (!group) return false;
        if (group.memberApiSettings?.mode) return group.memberApiSettings.mode === 'members';
        return (group.members || []).some(member => !!window.RoleApiBindings.selection({ chat: { ...group, apiBinding: null }, member }, 'groupChat')?.nodeId);
    }
    function eligible(group) {
        return (group.members || []).filter(member => member.apiBinding?.participationEnabled !== false && member.apiParticipationEnabled !== false && !member.isMuted);
    }
    function chooseMembers(group, settings, options = {}) {
        const members = eligible(group);
        if (options.memberIds) return members.filter(member => options.memberIds.includes(member.id));
        if (settings.participants === 'selected') return members.filter(member => (settings.selectedMemberIds || []).includes(member.id)).slice(0, settings.maxParticipants);
        if (settings.participants === 'all') return members.slice(0, settings.maxParticipants);
        const text = [...(group.history || [])].reverse().find(message => message.role === 'user')?.content || '';
        const mentioned = members.filter(member => [member.realName, member.groupNickname].filter(Boolean).some(value => text.includes(`@${value}`)));
        const recent = (group.history || []).filter(message => message.senderId && !message.isThinking).slice(-12);
        const ranked = members.filter(member => !mentioned.includes(member)).map(member => {
            const index = recent.findLastIndex(message => message.senderId === member.id);
            const count = recent.filter(message => message.senderId === member.id).length;
            return { member, score: (index >= 0 ? index / 12 : .5) + Math.random() * .8 - count * .35 };
        }).sort((a, b) => b.score - a.score);
        return [...mentioned, ...ranked.map(item => item.member)].slice(0, settings.maxParticipants);
    }
    function visibleHistory(group, member, history) {
        return history.filter(message => {
            const privateMessage = String(message.content || '').match(/^\[Private(?:-End)?:\s*(.*?)\s*->\s*(.*?)(?::|\])/);
            return !privateMessage || [member.realName, member.groupNickname].some(value => privateMessage[1] === value || privateMessage[2] === value);
        });
    }
    function allowedItem(item, member, group) {
        const own = [member.realName, member.groupNickname];
        if (item.char && !own.includes(item.char)) return false;
        const content = String(item.content || '');
        const actor = content.match(/^\[(?:Private(?:-End)?:\s*)?(.+?)(?:\s*->|的消息[：:]|发送的|撤回|接收|退回|\s*向\s*)/);
        if (actor && actor[1].trim() !== 'unknown' && !own.includes(actor[1].trim())) return false;
        const known = (group.members || []).filter(other => other.id !== member.id).flatMap(other => [other.realName, other.groupNickname]).filter(Boolean);
        return !known.some(other => !own.includes(other) && content.startsWith(`[${other}的`));
    }
    function guardCommands(text, member) {
        const own = [member.realName, member.groupNickname, member.id, 'self', '自己'];
        return String(text || '').replace(/\[poke:actor=([^|\]]+)\|target=([^\]]+)\]/gi, (raw, actor) => own.includes(actor.trim()) ? raw : '');
    }
    function panel() {
        let box = document.getElementById('member-api-progress');
        if (!box) {
            box = document.createElement('div'); box.id = 'member-api-progress'; box.className = 'member-api-progress';
            document.getElementById('typing-indicator')?.parentNode.insertBefore(box, document.getElementById('typing-indicator'));
        }
        return box;
    }
    function draw(group) {
        if (currentChatId !== group.id || currentChatType !== 'group') return;
        const box = panel(); box.replaceChildren();
        const run = group.memberApiRun;
        if (!run || run.userMessageId !== lastUser(group)) { box.hidden = true; return; }
        box.hidden = false;
        const labels = { waiting: '等待', generating: '生成中', ready: '等待写入', completed: '完成', failed: '失败', stopped: '已停止' };
        for (const task of run.tasks) {
            const row = document.createElement('div'); row.className = 'member-api-progress-row';
            const text = document.createElement('span'); text.textContent = `${task.name}：${labels[task.state] || task.state}${task.error ? ` · ${task.error}` : ''}`;
            row.appendChild(text);
            const action = (label, handler) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small'; button.textContent = label; button.addEventListener('click', handler); row.appendChild(button); };
            if (task.state === 'generating' || task.state === 'waiting' || task.state === 'ready') action('停止', () => stop(group.id, task.memberId));
            if (!runs.has(group.id) && ['failed', 'stopped'].includes(task.state)) action('重试', () => reply(group, false, { memberIds: [task.memberId], retry: true }));
            if (!runs.has(group.id) && task.state === 'completed') action('重生成', () => regenerate(group, task.memberId));
            if (!runs.has(group.id) && group.history.find(message => message.id === run.userMessageId)?._memberRegenVersions?.some(version => version.memberId === task.memberId)) action('历史', () => restoreVersion(group, task.memberId));
            if (task.apiUsage) { text.title = `${task.apiUsage.name} · ${task.apiUsage.model}${task.apiUsage.fallback ? '（备用）' : ''}${task.tokenUsage ? ` · 输入 ${task.tokenUsage.input} / 输出 ${task.tokenUsage.output} Tokens` : ''}`; }
            if (task.apiUsage) action('API', () => customAlert(text.title, `${task.name} · 调用详情`));
            box.appendChild(row);
        }
        if (run.schedulerError) {
            const warning = document.createElement('span'); warning.textContent = `调度未完成：${run.schedulerError}`; box.appendChild(warning);
        }
        if (runs.has(group.id)) {
            const stopButton = document.createElement('button'); stopButton.type = 'button'; stopButton.className = 'btn btn-small'; stopButton.textContent = '停止本轮'; stopButton.addEventListener('click', () => stop(group.id)); box.appendChild(stopButton);
        }
    }
    function stop(groupId, memberId) {
        const active = runs.get(groupId); if (!active) return;
        if (memberId) { active.stopped.add(memberId); active.controllers.get(memberId)?.abort(); }
        else { active.controller.abort(); active.controllers.forEach(controller => controller.abort()); }
        const group = db.groups.find(item => item.id === groupId); if (group) draw(group);
    }
    async function schedule(group, settings, selected, controller) {
        if (!settings.schedulerNodeId || settings.participants !== 'natural') return selected;
        const node = (db.apiNodes || []).find(item => item.id === settings.schedulerNodeId && item.enabled !== false);
        if (!node) throw new Error('调度 API 不存在或已暂停');
        const config = { ...apiNodeToConfig(node), streamEnabled: false };
        const candidates = eligible(group);
        const prompt = `根据群聊最近公开记录选择接下来发言的成员并排序，最多 ${settings.maxParticipants} 人。只返回 JSON 数组，元素必须是给定成员 ID。成员：${JSON.stringify(candidates.map(member => ({ id: member.id, name: name(member) })))}。记录：${JSON.stringify(group.history.filter(message => !String(message.content || '').startsWith('[Private')).slice(-8).map(message => message.content))}`;
        const prepared = prepareAiProviderRequest(config, { model: config.model, messages: [{ role: 'user', content: prompt }], stream: false }, getApiConfigHeaders(config), getApiConfigEndpoint(config));
        const response = await fetch(prepared.endpoint, { method: 'POST', headers: prepared.headers, body: JSON.stringify(prepared.body), signal: controller.signal });
        if (!response.ok) throw new Error(`调度 API 返回 ${response.status}`);
        const content = extractAiProviderResponse(await response.json(), prepared.provider).content;
        const ids = JSON.parse(content.slice(content.indexOf('['), content.lastIndexOf(']') + 1));
        if (!Array.isArray(ids) || ids.some(id => !candidates.some(member => member.id === id))) throw new Error('调度返回了无效成员');
        return [...new Set(ids)].slice(0, settings.maxParticipants).map(id => candidates.find(member => member.id === id));
    }
    async function commit(group, member, result, task, active, background) {
        if (!result || active.controller.signal.aborted || active.stopped.has(member.id)) return false;
        if (!group.members.some(item => item.id === member.id)) throw new Error('成员已退出群聊');
        if (result.replyTask && group.history.some(message => message.replyRequestId === result.replyTask.id)) return true;
        const before = new Set(group.history.map(message => message.id));
        const responseChat = { ...group, _cotTagStart: result.runtimeChat._cotTagStart, _cotTagEnd: result.runtimeChat._cotTagEnd, _cotDisplayMode: result.runtimeChat._cotDisplayMode, history: group.history };
        await handleAiReplyContent(result.fullResponse, responseChat, group.id, 'group', background, false, { memberId: member.id, suppressAutoTasks: true, shouldStop: () => active.controller.signal.aborted || active.stopped.has(member.id) });
        group.history = responseChat.history;
        const messages = group.history.filter(message => !before.has(message.id));
        if (!messages.length) throw new Error('成员未返回可用发言，请重试');
        messages.forEach(message => {
            message.senderId = member.id; message.memberApiRoundId = active.id;
            message.apiUsage = result.apiUsage;
            if (result.replyTask) message.replyRequestId = result.replyTask.id;
        });
        task.apiUsage = result.apiUsage; task.tokenUsage = result.runtimeChat._lastTokenUsage;
        if (await saveGroup(group.id) === false) throw new Error('群消息保存失败，已显示的消息不会重新生成');
        if (result.replyTask) await window.ReplyResilience.complete(result.replyTask);
        return true;
    }
    async function reply(group, background = false, options = {}) {
        if (runs.has(group.id) || (!background && isGenerating)) return false;
        if (background && typeof isInQuietHours === 'function' && isInQuietHours(group.id)) return false;
        const settings = { participants: 'natural', execution: 'sequential', maxParticipants: 3, followUpRounds: 0, onError: 'continue', ...clone(group.memberApiSettings || {}) };
        settings.maxParticipants = Math.max(1, Math.min(50, Number(settings.maxParticipants) || 3));
        const active = { id: `member_round_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, controller: new AbortController(), controllers: new Map(), stopped: new Set() };
        runs.set(group.id, active);
        if (!background) { isGenerating = true; getReplyBtn.disabled = true; regenerateBtn.disabled = true; currentReplyAbortController = active.controller; typingIndicator.textContent = '群成员正在回复…'; typingIndicator.style.display = 'block'; }
        const previous = options.retry ? group.memberApiRun : null;
        const userMessageId = lastUser(group);
        group.memberApiRun = { id: active.id, userMessageId, tasks: previous?.userMessageId === userMessageId ? previous.tasks.filter(task => !options.memberIds?.includes(task.memberId)) : [] };
        draw(group);
        try {
            let members = chooseMembers(group, settings, options);
            if (!options.memberIds) {
                try { members = await schedule(group, settings, members, active.controller); }
                catch (error) { group.memberApiRun.schedulerError = error.message; throw error; }
            }
            if (!members.length) { showToast('没有可发言成员，请检查群聊 API 与发言设置'); return false; }
            const snapshots = new Map(members.map(member => {
                const context = { chat: group, member };
                return [member.id, {
                    main: getApiConfigForFeature(background ? 'background' : 'groupChat', background && isApiConfigReady(db.backgroundApiSettings) ? db.backgroundApiSettings : db.apiSettings, context),
                    image: getApiConfigForFeature('imageChat', isApiConfigReady(db.imageRecognitionApiSettings) ? db.imageRecognitionApiSettings : db.apiSettings, context),
                    sticker: getApiConfigForFeature('stickerVision', isApiConfigReady(db.stickerRecognitionApiSettings) ? db.stickerRecognitionApiSettings : db.apiSettings, context),
                    stickerBound: !!window.RoleApiBindings.selection(context, 'stickerVision')
                }];
            }));
            const baseHistory = clone(group.history);
            const rounds = options.retry ? 1 : 1 + Math.max(0, Math.min(3, Number(settings.followUpRounds) || 0));
            for (let round = 0; round < rounds && !active.controller.signal.aborted; round++) {
                const tasks = members.map(member => ({ memberId: member.id, name: name(member), state: 'waiting', round }));
                group.memberApiRun.tasks.push(...tasks); draw(group);
                const generate = async (member, task, history) => {
                    if (active.controller.signal.aborted || active.stopped.has(member.id)) { task.state = 'stopped'; return null; }
                    const controller = new AbortController(); active.controllers.set(member.id, controller);
                    const relay = () => controller.abort(); active.controller.signal.addEventListener('abort', relay, { once: true });
                    let result = null; task.state = 'generating'; draw(group);
                    const work = { ...group, _lastTokenUsage: null, history: visibleHistory(group, member, clone(history)), members: clone(group.members) };
                    try {
                        await getAiReply(group.id, 'group', background, false, false, false, {
                            memberTask: true, member, workingChat: work, apiConfigSnapshot: snapshots.get(member.id).main, featureConfigSnapshots: snapshots.get(member.id), signal: controller.signal,
                            recoveryTaskId: options.recoveryTaskId || '',
                            onResult: value => { result = value; }, onError: error => { task.error = error.message; }
                        });
                        task.state = controller.signal.aborted ? 'stopped' : result ? 'ready' : 'failed';
                        if (!result && !task.error && task.state !== 'stopped') task.error = '成员请求未完成';
                    } finally { active.controller.signal.removeEventListener('abort', relay); active.controllers.delete(member.id); draw(group); }
                    return result;
                };
                const finish = async (member, task, result) => {
                    try {
                        if (await commit(group, member, result, task, active, background)) task.state = 'completed';
                        else if (task.state === 'ready' || task.state === 'waiting') {
                            task.state = 'stopped';
                            if (result?.replyTask) await window.ReplyResilience.fail(result.replyTask, new DOMException('已停止', 'AbortError'), true);
                        }
                    } catch (error) {
                        task.state = 'failed'; task.error = error.message;
                        if (result?.replyTask) await window.ReplyResilience.fail(result.replyTask, error, false);
                    }
                    if (task.state === 'failed' && settings.onError === 'stop') active.controller.abort();
                    draw(group);
                };
                if (settings.execution === 'parallel') {
                    const history = round === 0 ? baseHistory : clone(group.history);
                    for (let index = 0; index < members.length; index += 2) {
                        const batch = members.slice(index, index + 2);
                        const results = await Promise.all(batch.map((member, offset) => generate(member, tasks[index + offset], history)));
                        for (let offset = 0; offset < batch.length; offset++) await finish(batch[offset], tasks[index + offset], results[offset]);
                    }
                } else {
                    for (let index = 0; index < members.length; index++) await finish(members[index], tasks[index], await generate(members[index], tasks[index], group.history));
                }
            }
            if (typeof checkAndTriggerAutoJournal === 'function') checkAndTriggerAutoJournal(group);
            if (typeof checkAndTriggerAutoTableUpdate === 'function') checkAndTriggerAutoTableUpdate(group);
            if (typeof checkAndTriggerVectorMemory === 'function') checkAndTriggerVectorMemory(group);
            return group.memberApiRun.tasks.some(task => task.state === 'completed' && (!options.memberIds || options.memberIds.includes(task.memberId)));
        } catch (error) { if (error.name !== 'AbortError') showToast(error.message); return false; }
        finally {
            group.memberApiRun.tasks.forEach(task => { if (['waiting', 'generating', 'ready'].includes(task.state)) task.state = 'stopped'; });
            runs.delete(group.id); await saveGroup(group.id);
            if (!background && currentReplyAbortController === active.controller) { currentReplyAbortController = null; isGenerating = false; getReplyBtn.disabled = false; regenerateBtn.disabled = false; typingIndicator.style.display = 'none'; }
            draw(group);
        }
    }
    async function regenerate(group, memberId) {
        if (runs.has(group.id) || isGenerating) return;
        const candidates = eligible(group);
        if (!memberId) {
            const chosen = await customPrompt(candidates.map((member, index) => `${index + 1}. ${name(member)}`).join('\n'), '1', '输入要重生成的成员序号');
            memberId = candidates[Number(chosen) - 1]?.id;
            if (!memberId) return;
        }
        const latestUserIndex = group.history.findLastIndex(message => message.role === 'user');
        const existing = group.history.slice(latestUserIndex + 1).filter(message => message.senderId === memberId && !message.isThinking);
        const beforeIds = new Set(group.history.map(message => message.id));
        const snapshot = group.history;
        group.history = group.history.filter(message => !existing.some(item => item.id === message.id));
        const successful = await reply(group, false, { memberIds: [memberId], retry: true });
        const replacements = group.history.filter(message => !beforeIds.has(message.id));
        if (!successful || !replacements.length) { group.history = snapshot; await saveGroup(group.id); }
        else {
            const user = group.history.find(message => message.id === lastUser(group));
            if (user && existing.length) { user._memberRegenVersions ||= []; user._memberRegenVersions.push({ memberId, at: Date.now(), messages: clone(existing) }); }
            await saveGroup(group.id);
        }
        renderMessages(false, true); draw(group);
    }
    async function restoreVersion(group, memberId) {
        if (runs.has(group.id) || isGenerating) return;
        const anchor = group.history.find(message => message.id === lastUser(group));
        const versions = (anchor?._memberRegenVersions || []).filter(version => version.memberId === memberId);
        if (!versions.length) return;
        const index = await customPrompt(versions.map((version, number) => `${number + 1}. ${new Date(version.at).toLocaleString()}\n${version.messages.map(message => message.content).join('\n').slice(0, 180)}`).join('\n\n'), '', '查看历史并输入序号恢复');
        const selected = versions[Number(index) - 1]; if (!selected) return;
        const start = group.history.findIndex(message => message.id === anchor.id);
        const current = group.history.slice(start + 1).filter(message => message.senderId === memberId);
        const snapshot = clone(group.history);
        anchor._memberRegenVersions.push({ memberId, at: Date.now(), messages: clone(current) });
        group.history = group.history.filter((message, position) => position <= start || message.senderId !== memberId);
        group.history.push(...clone(selected.messages));
        if (await saveGroup(group.id) === false) { group.history = snapshot; return showToast('历史恢复保存失败，已保留当前回复'); }
        renderMessages(false, true); draw(group); showToast('已恢复此成员的历史回复');
    }
    document.addEventListener('click', () => {
        if (typeof currentChatType !== 'undefined' && currentChatType === 'group') {
            const group = db.groups?.find(item => item.id === currentChatId); if (group) draw(group);
        } else document.getElementById('member-api-progress')?.setAttribute('hidden', '');
    });
    window.MemberApiRuntime = { reply, stop, draw, chooseMembers, visibleHistory, allowedItem, guardCommands, regenerate, isIndependent };
})();

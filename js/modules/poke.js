// --- 拍一拍：独立轻互动事件（非普通文本消息） ---
(function () {
    const DOUBLE_TAP_MS = 360;
    const PAIR_COOLDOWN_MS = 1500;
    const MAX_AI_POKES_PER_REPLY = 2;
    const WITHDRAW_MS = 2 * 60 * 1000;
    let lastTap = null;
    const recentPairs = new Map();

    function getChat(chatId, chatType) {
        if (typeof db === 'undefined') return null;
        return chatType === 'group'
            ? db.groups.find(group => group.id === chatId)
            : db.characters.find(character => character.id === chatId);
    }

    function ensureSettings(chat) {
        if (!chat) return null;
        if (chat.pokeEnabled === undefined) chat.pokeEnabled = false;
        if (chat.pokeAllowCharacterInitiated === undefined) chat.pokeAllowCharacterInitiated = true;
        if (chat.pokeTriggerReply === undefined) chat.pokeTriggerReply = true;
        if (chat.pokeAllowSelf === undefined) chat.pokeAllowSelf = true;
        if (chat.pokeAllowMemberToMember === undefined) chat.pokeAllowMemberToMember = true;
        if (chat.pokeContextEnabled === undefined) chat.pokeContextEnabled = true;
        if (chat.pokeVibrationEnabled === undefined) chat.pokeVibrationEnabled = true;
        if (!chat.pokeEffectMode) chat.pokeEffectMode = 'full';
        if (!chat.pokeNotificationMode) chat.pokeNotificationMode = 'in_chat';
        if (typeof chat.pokeUserSuffix !== 'string') chat.pokeUserSuffix = '';
        if (typeof chat.pokeCharacterSuffix !== 'string') chat.pokeCharacterSuffix = '';
        return chat;
    }

    function cleanSuffix(value) {
        return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 20);
    }

    function getParticipant(chat, chatType, id) {
        if (!chat) return null;
        if (id === 'user_me') {
            return {
                id,
                type: 'user',
                name: chatType === 'group' ? (chat.me?.nickname || '你') : (chat.myName || '你'),
                suffix: cleanSuffix(chat.pokeUserSuffix)
            };
        }
        if (chatType === 'private') {
            if (id !== chat.id && id !== 'character') return null;
            return {
                id: chat.id,
                type: 'character',
                name: chat.remarkName || chat.realName || chat.name || '角色',
                suffix: cleanSuffix(chat.pokeCharacterSuffix)
            };
        }
        const member = (chat.members || []).find(item => item.id === id);
        if (!member) return null;
        const original = (typeof db !== 'undefined' && db.characters)
            ? db.characters.find(character => character.id === member.originalCharId)
            : null;
        return {
            id: member.id,
            type: 'character',
            name: member.groupNickname || member.realName || '群成员',
            suffix: cleanSuffix(member.pokeSuffix !== undefined ? member.pokeSuffix : original?.pokeCharacterSuffix)
        };
    }

    function getEffect(suffix) {
        const effects = [
            ['💣', 'bomb'], ['🎆', 'fireworks'], ['🎇', 'fireworks'], ['🎉', 'confetti'],
            ['❤️', 'heart'], ['❤', 'heart'], ['✨', 'sparkle'], ['🌸', 'petal'], ['❄️', 'snow'],
            ['⚡', 'flash'], ['🫧', 'bubble']
        ];
        const found = effects.find(([emoji]) => suffix.includes(emoji));
        return found ? found[1] : '';
    }

    function buildDisplayText(actor, target, suffix) {
        const actorText = actor.id === 'user_me' ? '你' : actor.name;
        const targetText = target.id === 'user_me'
            ? (actor.id === 'user_me' ? '自己' : '你')
            : target.name;
        return `${actorText}拍了拍${targetText}${suffix || ''}`;
    }

    function canCreate(chat, chatType, actor, target, source) {
        ensureSettings(chat);
        if (!chat?.pokeEnabled || !actor || !target) return false;
        if (actor.id === target.id && chat.pokeAllowSelf === false) return false;
        if (source === 'ai') {
            if (chat.pokeAllowCharacterInitiated === false || actor.id === 'user_me') return false;
            if (chatType === 'group' && target.id !== 'user_me' && actor.id !== target.id && chat.pokeAllowMemberToMember === false) return false;
        }
        const pairKey = `${chat.id}:${actor.id}:${target.id}`;
        const now = Date.now();
        if (now - (recentPairs.get(pairKey) || 0) < PAIR_COOLDOWN_MS) return false;
        recentPairs.set(pairKey, now);
        return true;
    }

    function createEvent(chat, chatType, actorId, targetId, source) {
        const actor = getParticipant(chat, chatType, actorId);
        const target = getParticipant(chat, chatType, targetId);
        if (!canCreate(chat, chatType, actor, target, source)) return null;
        const suffix = target.suffix;
        const displayText = buildDisplayText(actor, target, suffix);
        const message = {
            id: `poke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'poke',
            role: actor.id === 'user_me' ? 'user' : 'assistant',
            senderId: actor.id,
            actorId: actor.id,
            actorType: actor.type,
            actorName: actor.name,
            targetId: target.id,
            targetType: target.type,
            targetName: target.name,
            suffixSnapshot: suffix,
            displayText,
            effect: getEffect(suffix),
            source,
            timestamp: Date.now(),
            content: `[拍一拍事件：${displayText}]`,
            parts: [{ type: 'text', text: `[拍一拍事件：${displayText}]` }],
            isContextDisabled: chat.pokeContextEnabled === false
        };
        chat.history = chat.history || [];
        chat.history.push(message);
        return message;
    }

    function saveChat(chatId, chatType) {
        if (chatType === 'group' && typeof saveGroup === 'function') return saveGroup(chatId);
        if (chatType === 'private' && typeof saveCharacter === 'function') return saveCharacter(chatId);
        if (typeof saveData === 'function') return saveData();
    }

    function renderMessage(message) {
        const wrapper = document.createElement('div');
        wrapper.className = 'message-wrapper system-notification poke-message-wrapper';
        wrapper.dataset.id = message.id || '';
        const row = document.createElement('div');
        row.className = 'poke-notification-row';
        const text = document.createElement('span');
        text.className = 'system-notification-bubble poke-notification-text';
        text.textContent = message.displayText || String(message.content || '').replace(/^\[拍一拍事件：|\]$/g, '');
        row.appendChild(text);
        if (message.role === 'user' && Date.now() - Number(message.timestamp || 0) < WITHDRAW_MS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'poke-withdraw-btn';
            button.textContent = '撤回';
            button.setAttribute('aria-label', '撤回这次拍一拍');
            button.addEventListener('click', event => {
                event.stopPropagation();
                withdraw(message.id);
            });
            row.appendChild(button);
            const remaining = WITHDRAW_MS - (Date.now() - Number(message.timestamp || 0));
            setTimeout(() => button.remove(), Math.max(0, remaining));
        }
        wrapper.appendChild(row);
        return wrapper;
    }

    function findVisibleAvatar(targetId) {
        if (typeof messageArea === 'undefined' || !messageArea) return null;
        const avatars = Array.from(messageArea.querySelectorAll(`.message-avatar[data-poke-target-id="${CSS.escape(targetId)}"]`));
        return avatars.reverse().find(avatar => avatar.offsetParent !== null) || avatars[0] || null;
    }

    function playEffect(effect) {
        if (!effect) return;
        const screen = document.getElementById('chat-room-screen');
        if (!screen) return;
        const overlay = document.createElement('div');
        overlay.className = `poke-effect poke-effect-${effect}`;
        const icons = { bomb: '💥', fireworks: '🎆', confetti: '🎉', heart: '❤️', sparkle: '✨', petal: '🌸', snow: '❄️', flash: '⚡', bubble: '🫧' };
        overlay.textContent = icons[effect] || '✨';
        overlay.setAttribute('aria-hidden', 'true');
        screen.appendChild(overlay);
        setTimeout(() => overlay.remove(), 1400);
    }

    function playFeedback(message, chat) {
        if (!message || !chat || currentChatId !== chat.id) return;
        requestAnimationFrame(() => {
            if (chat.pokeEffectMode !== 'off') {
                const avatar = findVisibleAvatar(message.targetId);
                if (avatar) {
                    avatar.classList.remove('poke-avatar-shake');
                    void avatar.offsetWidth;
                    avatar.classList.add('poke-avatar-shake');
                    setTimeout(() => avatar.classList.remove('poke-avatar-shake'), 650);
                }
            }
            if (chat.pokeVibrationEnabled !== false && typeof triggerHapticFeedback === 'function') {
                triggerHapticFeedback('light');
            }
            if (chat.pokeEffectMode === 'full') playEffect(message.effect);
        });
    }

    async function withdraw(messageId) {
        const chat = getChat(currentChatId, currentChatType);
        if (!chat?.history) return;
        const index = chat.history.findIndex(message => message.id === messageId && message.type === 'poke');
        if (index < 0) return;
        const message = chat.history[index];
        if (message.role !== 'user' || Date.now() - Number(message.timestamp || 0) >= WITHDRAW_MS) {
            if (typeof showToast === 'function') showToast('这次拍一拍已无法撤回');
            return;
        }
        chat.history.splice(index, 1);
        await saveChat(chat.id, currentChatType);
        if (typeof renderMessages === 'function') renderMessages(false, false);
        if (typeof renderChatList === 'function') renderChatList();
        if (typeof showToast === 'function') showToast('已撤回拍一拍');
    }

    function resolveAiParticipant(chat, chatType, name, fallbackActor) {
        const normalized = String(name || '').trim();
        if (/^(我|用户|user|你)$/i.test(normalized)) return 'user_me';
        if (chatType === 'private') {
            const charNames = [chat.id, chat.realName, chat.remarkName, chat.name, '角色', 'character'].filter(Boolean);
            return charNames.includes(normalized) || !normalized ? chat.id : null;
        }
        const member = (chat.members || []).find(item => item.id === normalized || item.realName === normalized || item.groupNickname === normalized);
        return member ? member.id : (fallbackActor || null);
    }

    function consumeAiCommands(text, chat, chatType) {
        ensureSettings(chat);
        const messages = [];
        const regex = /\[POKE:actor=([^\]|]+)\|target=([^\]]+)\]/gi;
        if (!chat?.pokeEnabled) {
            return { cleaned: String(text || '').replace(regex, '').replace(/\n{3,}/g, '\n\n').trim(), messages };
        }
        const cleaned = String(text || '').replace(regex, (raw, actorName, targetName) => {
            if (messages.length >= MAX_AI_POKES_PER_REPLY) return '';
            const actorId = resolveAiParticipant(chat, chatType, actorName);
            const targetId = resolveAiParticipant(chat, chatType, targetName, actorId);
            const message = createEvent(chat, chatType, actorId, targetId, 'ai');
            if (message) messages.push(message);
            return '';
        }).replace(/\n{3,}/g, '\n\n').trim();
        return { cleaned, messages };
    }

    async function handleUserPoke(targetId) {
        const chat = getChat(currentChatId, currentChatType);
        ensureSettings(chat);
        if (!chat?.pokeEnabled) return;
        const message = createEvent(chat, currentChatType, 'user_me', targetId, 'double_tap');
        if (!message) {
            if (typeof showToast === 'function') showToast('拍得太快啦');
            return;
        }
        if (typeof addMessageBubble === 'function') addMessageBubble(message, chat.id, currentChatType);
        playFeedback(message, chat);
        await saveChat(chat.id, currentChatType);
        if (typeof renderChatList === 'function') renderChatList();
        if (chat.pokeTriggerReply !== false && typeof getAiReply === 'function' && typeof isGenerating !== 'undefined' && !isGenerating) {
            getAiReply(chat.id, currentChatType);
        }
    }

    function onAvatarClick(event) {
        const avatar = event.target.closest('.message-avatar[data-poke-target-id]');
        if (!avatar || !document.getElementById('chat-room-screen')?.classList.contains('active')) return;
        if ((typeof isInMultiSelectMode !== 'undefined' && isInMultiSelectMode) || (typeof isDebugMode !== 'undefined' && isDebugMode)) return;
        const chat = getChat(currentChatId, currentChatType);
        if (!chat?.pokeEnabled) return;
        const now = Date.now();
        if (lastTap && lastTap.avatar === avatar && now - lastTap.time <= DOUBLE_TAP_MS) {
            event.preventDefault();
            event.stopPropagation();
            lastTap = null;
            handleUserPoke(avatar.dataset.pokeTargetId);
            return;
        }
        lastTap = { avatar, time: now };
    }

    function onAvatarContextMenu(event) {
        const avatar = event.target.closest('.message-avatar[data-poke-target-id]');
        if (!avatar) return;
        const chat = getChat(currentChatId, currentChatType);
        if (!chat?.pokeEnabled || typeof createContextMenu !== 'function') return;
        event.preventDefault();
        event.stopPropagation();
        createContextMenu([
            { label: '拍一拍', action: () => handleUserPoke(avatar.dataset.pokeTargetId) }
        ], event.clientX, event.clientY);
    }

    function showGroupPicker() {
        const chat = getChat(currentChatId, currentChatType);
        if (!chat || currentChatType !== 'group' || !chat.pokeEnabled) return;
        document.getElementById('poke-member-picker')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'poke-member-picker';
        overlay.className = 'action-sheet-overlay visible';
        const sheet = document.createElement('div');
        sheet.className = 'action-sheet poke-member-sheet';
        const title = document.createElement('div');
        title.className = 'poke-member-sheet-title';
        title.textContent = '拍一拍谁';
        sheet.appendChild(title);
        const participants = chat.pokeAllowSelf === false
            ? (chat.members || [])
            : [{ id: 'user_me', groupNickname: '我自己' }, ...(chat.members || [])];
        participants.forEach(member => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'action-sheet-button';
            button.textContent = member.groupNickname || member.realName || '群成员';
            button.addEventListener('click', () => {
                overlay.remove();
                if (typeof switchScreen === 'function') switchScreen('chat-room-screen');
                setTimeout(() => handleUserPoke(member.id), 80);
            });
            sheet.appendChild(button);
        });
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'action-sheet-button cancel';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => overlay.remove());
        sheet.appendChild(cancel);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) overlay.remove();
        });
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);
    }

    function init() {
        document.addEventListener('click', onAvatarClick, true);
        document.addEventListener('contextmenu', onAvatarContextMenu, true);
        document.getElementById('setting-group-poke-member-btn')?.addEventListener('click', showGroupPicker);
        const groupToggle = document.getElementById('setting-group-poke-enabled');
        const groupOptions = document.getElementById('setting-group-poke-options');
        if (groupToggle && groupOptions) {
            groupToggle.addEventListener('change', () => {
                groupOptions.style.display = groupToggle.checked ? 'block' : 'none';
            });
        }
    }

    window.PokeSystem = {
        WITHDRAW_MS,
        ensureSettings,
        cleanSuffix,
        createEvent,
        consumeAiCommands,
        renderMessage,
        playFeedback,
        withdraw,
        init
    };
})();

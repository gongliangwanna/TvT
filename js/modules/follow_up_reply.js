/**
 * 角色回复后追发消息。
 * 任务写入角色数据，避免刷新、休眠或短暂离线后丢失；每个角色同时只保留一个任务。
 */
(function () {
    const MIN_DELAY_MINUTES = 5;
    const MAX_DELAY_MINUTES = 7 * 24 * 60;
    const MAX_OVERDUE_MS = 24 * 60 * 60 * 1000;
    const RETRY_DELAYS_MS = [60 * 1000, 3 * 60 * 1000, 15 * 60 * 1000];
    let checkRunning = false;

    function clampNumber(value, min, max, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
    }

    function defaultSettings() {
        return {
            enabled: false,
            delayMode: 'random',
            fixedDelayMinutes: 120,
            minDelayMinutes: 60,
            maxDelayMinutes: 180,
            probability: 35,
            maxFollowUps: 1,
            pending: null,
            lastSuccessAt: 0,
            lastDecision: null
        };
    }

    function ensureSettings(character) {
        if (!character.followUpReply || typeof character.followUpReply !== 'object') {
            character.followUpReply = defaultSettings();
        }
        const settings = character.followUpReply;
        settings.enabled = settings.enabled === true;
        settings.delayMode = settings.delayMode === 'fixed' ? 'fixed' : 'random';
        settings.fixedDelayMinutes = Math.round(clampNumber(settings.fixedDelayMinutes, MIN_DELAY_MINUTES, MAX_DELAY_MINUTES, 120));
        settings.minDelayMinutes = Math.round(clampNumber(settings.minDelayMinutes, MIN_DELAY_MINUTES, MAX_DELAY_MINUTES, 60));
        settings.maxDelayMinutes = Math.round(clampNumber(settings.maxDelayMinutes, MIN_DELAY_MINUTES, MAX_DELAY_MINUTES, 180));
        if (settings.minDelayMinutes > settings.maxDelayMinutes) {
            const oldMin = settings.minDelayMinutes;
            settings.minDelayMinutes = settings.maxDelayMinutes;
            settings.maxDelayMinutes = oldMin;
        }
        settings.probability = Math.round(clampNumber(settings.probability, 0, 100, 35));
        settings.maxFollowUps = Math.round(clampNumber(settings.maxFollowUps, 1, 3, 1));
        settings.lastSuccessAt = Number(settings.lastSuccessAt) || 0;
        if (settings.pending && typeof settings.pending !== 'object') settings.pending = null;
        return settings;
    }

    function randomInteger(min, max) {
        const safeMin = Math.ceil(Math.min(min, max));
        const safeMax = Math.floor(Math.max(min, max));
        return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
    }

    function chooseDelayMinutes(settings) {
        return settings.delayMode === 'fixed'
            ? settings.fixedDelayMinutes
            : randomInteger(settings.minDelayMinutes, settings.maxDelayMinutes);
    }

    function findAnchor(messages) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message && message.role === 'assistant' && !message.isThinking && !message.isNodeSummaryMsg && String(message.content || '').trim()) {
                return message;
            }
        }
        return null;
    }

    function createPending(character, anchor, followUpIndex, probability) {
        const settings = ensureSettings(character);
        const roll = Math.random() * 100;
        const effectiveProbability = clampNumber(probability, 0, 100, settings.probability);
        settings.lastDecision = {
            at: Date.now(),
            anchorMessageId: anchor.id,
            roll,
            probability: effectiveProbability,
            result: roll < effectiveProbability ? 'scheduled' : 'missed'
        };
        if (roll >= effectiveProbability) {
            settings.pending = null;
            return null;
        }

        const now = Date.now();
        const delayMinutes = chooseDelayMinutes(settings);
        settings.pending = {
            id: `followup_${now}_${Math.random().toString(36).slice(2, 9)}`,
            anchorMessageId: anchor.id,
            anchorReplyRequestId: anchor.replyRequestId || '',
            createdAt: now,
            originalDueAt: now + delayMinutes * 60 * 1000,
            dueAt: now + delayMinutes * 60 * 1000,
            probabilityRoll: roll,
            effectiveProbability,
            followUpIndex,
            state: 'pending',
            retryAt: 0,
            failureCount: 0,
            quietDeferred: false
        };
        return settings.pending;
    }

    async function persist(character) {
        if (typeof saveCharacter === 'function') await saveCharacter(character.id);
        else if (typeof saveData === 'function') await saveData();
    }

    async function scheduleAfterReply(characterId, newMessages) {
        const character = db.characters.find(item => item.id === characterId);
        if (!character) return false;
        const settings = ensureSettings(character);
        if (!settings.enabled || character.isBlocked) {
            if (settings.pending) {
                settings.pending = null;
                await persist(character);
            }
            return false;
        }

        const anchor = findAnchor(Array.isArray(newMessages) ? newMessages : []);
        if (!anchor) return false;
        createPending(character, anchor, 1, settings.probability);
        await persist(character);
        return !!settings.pending;
    }

    function validationFailure(character, pending) {
        if (!pending || !pending.anchorMessageId) return 'missing_task';
        if (character.isBlocked) return 'character_blocked';
        const history = Array.isArray(character.history) ? character.history : [];
        const anchorIndex = history.findIndex(message => message && message.id === pending.anchorMessageId);
        if (anchorIndex < 0) return 'anchor_missing';
        const laterMessages = history.slice(anchorIndex + 1).filter(message => message && !message.isThinking && !message.isNodeSummaryMsg);
        if (laterMessages.some(message => message.role === 'user')) return 'user_replied';
        if (laterMessages.some(message => message.role === 'assistant')) return 'superseded_by_character_message';
        return '';
    }

    async function cancelPending(character, reason) {
        const settings = ensureSettings(character);
        if (!settings.pending) return false;
        settings.lastDecision = {
            ...(settings.lastDecision || {}),
            endedAt: Date.now(),
            result: 'cancelled',
            reason
        };
        settings.pending = null;
        await persist(character);
        return true;
    }

    function minutesFromTime(value) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (hours > 23 || minutes > 59) return null;
        return hours * 60 + minutes;
    }

    function nextQuietEnd(character, nowMs) {
        const quietHours = character.autoReply && character.autoReply.quietHours;
        if (!quietHours || !quietHours.enabled) return 0;
        const startMinutes = minutesFromTime(quietHours.start);
        const endMinutes = minutesFromTime(quietHours.end);
        if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return 0;
        const now = new Date(nowMs);
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const inQuietHours = startMinutes < endMinutes
            ? currentMinutes >= startMinutes && currentMinutes < endMinutes
            : currentMinutes >= startMinutes || currentMinutes < endMinutes;
        if (!inQuietHours) return 0;

        const end = new Date(nowMs);
        end.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
        if (startMinutes > endMinutes && currentMinutes >= startMinutes) end.setDate(end.getDate() + 1);
        return end.getTime();
    }

    async function confirmBeforeFinalize(characterId, taskId) {
        const character = db.characters.find(item => item.id === characterId);
        if (!character) return false;
        const settings = ensureSettings(character);
        const pending = settings.pending;
        if (!pending || pending.id !== taskId || pending.state !== 'generating') return false;
        const reason = validationFailure(character, pending);
        if (!reason) return true;
        await cancelPending(character, reason);
        return false;
    }

    function hasPending(character) {
        const settings = ensureSettings(character);
        return settings.enabled && !!settings.pending;
    }

    function markOtherBackgroundSuccess(character, at) {
        character.lastBackgroundMessageAt = at || Date.now();
        const settings = ensureSettings(character);
        if (settings.pending) {
            settings.lastDecision = {
                ...(settings.lastDecision || {}),
                endedAt: Date.now(),
                result: 'cancelled',
                reason: 'other_background_message'
            };
            settings.pending = null;
        }
    }

    async function processCharacter(character, now) {
        const settings = ensureSettings(character);
        const pending = settings.pending;
        if (!settings.enabled) {
            if (pending) await cancelPending(character, 'feature_disabled');
            return;
        }
        if (!pending || !['pending', 'retry_wait'].includes(pending.state)) return;

        const readyAt = Math.max(Number(pending.dueAt) || 0, Number(pending.retryAt) || 0);
        if (now < readyAt) return;
        if (now - (Number(pending.originalDueAt) || readyAt) > MAX_OVERDUE_MS) {
            await cancelPending(character, 'overdue');
            return;
        }

        const invalidReason = validationFailure(character, pending);
        if (invalidReason) {
            await cancelPending(character, invalidReason);
            return;
        }

        const quietEnd = nextQuietEnd(character, now);
        if (quietEnd) {
            if (pending.quietDeferred) {
                await cancelPending(character, 'quiet_hours_still_active');
                return;
            }
            pending.quietDeferred = true;
            pending.dueAt = quietEnd + randomInteger(5, 20) * 60 * 1000;
            pending.retryAt = 0;
            pending.state = 'pending';
            await persist(character);
            return;
        }

        if (typeof isGenerating !== 'undefined' && isGenerating) {
            pending.retryAt = now + 60 * 1000;
            pending.state = 'retry_wait';
            await persist(character);
            return;
        }

        const taskId = pending.id;
        const historyLengthBefore = Array.isArray(character.history) ? character.history.length : 0;
        pending.state = 'generating';
        pending.retryAt = 0;
        await persist(character);

        const succeeded = await getAiReply(character.id, 'private', true, false, false, false, {
            backgroundReason: 'followUp',
            followUpTaskId: taskId
        });
        const liveSettings = ensureSettings(character);
        const livePending = liveSettings.pending;
        if (!livePending || livePending.id !== taskId) return;

        if (succeeded) {
            const completedAt = Date.now();
            const completedIndex = livePending.followUpIndex || 1;
            liveSettings.lastSuccessAt = completedAt;
            character.lastBackgroundMessageAt = completedAt;
            liveSettings.lastDecision = {
                ...(liveSettings.lastDecision || {}),
                endedAt: completedAt,
                result: 'sent'
            };
            const newAnchor = findAnchor((character.history || []).slice(historyLengthBefore));
            liveSettings.pending = null;
            if (newAnchor && completedIndex < liveSettings.maxFollowUps) {
                const nextProbability = liveSettings.probability * Math.pow(0.5, completedIndex);
                createPending(character, newAnchor, completedIndex + 1, nextProbability);
            }
            await persist(character);
            return;
        }

        livePending.failureCount = Number(livePending.failureCount || 0) + 1;
        if (livePending.failureCount > RETRY_DELAYS_MS.length) {
            await cancelPending(character, 'generation_failed');
            return;
        }
        livePending.state = 'retry_wait';
        livePending.retryAt = Date.now() + RETRY_DELAYS_MS[livePending.failureCount - 1];
        await persist(character);
    }

    async function checkDue() {
        if (checkRunning || typeof db === 'undefined' || !Array.isArray(db.characters)) return;
        checkRunning = true;
        try {
            const now = Date.now();
            for (const character of db.characters) await processCharacter(character, now);
        } finally {
            checkRunning = false;
        }
    }

    window.FollowUpReply = {
        defaultSettings,
        ensureSettings,
        scheduleAfterReply,
        confirmBeforeFinalize,
        cancelPending,
        hasPending,
        markOtherBackgroundSuccess,
        checkDue,
        _test: { chooseDelayMinutes, createPending, validationFailure, nextQuietEnd, processCharacter }
    };
})();

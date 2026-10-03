// Role bindings are opt-in. A request without an explicit owner keeps legacy routing.
(function () {
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const extraFeatures = { followUp: '追加回复' };
    const features = () => ({ ...API_NODE_FEATURES, ...extraFeatures });
    const groups = () => [
        ['聊天', ['chat', 'groupChat']],
        ['对话扩展', ['background', 'followUp', 'call']],
        ['记忆', ['summary', 'memorySummary', 'journal']],
        ['内容与互动', ['moments', 'forum', 'theater', 'peek', 'shop', 'pomodoro', 'battery']],
        ['理解与搜索', ['imageChat', 'stickerVision', 'avatarVision', 'callVision', 'webSearch']]
    ];
    function owners(context) {
        if (!context) return {};
        if (context.chat || context.character || context.member) {
            const chat = context.chat || context.character;
            const member = context.member;
            return { chat, member, character: context.character || (member
                ? (db.characters || []).find(item => item.id === member.originalCharId)
                : chat && !Array.isArray(chat.members) ? chat : null) };
        }
        return { chat: context, character: Array.isArray(context.members) ? null : context };
    }
    function selected(binding, feature) {
        if (!binding || !Array.isArray(binding.features) || !binding.features.includes(feature)) return null;
        const override = binding.overrides?.[feature];
        const nodeId = typeof override === 'string' ? override : override?.nodeId;
        if (nodeId === 'system') return { system: true };
        const id = nodeId || binding.defaultNodeId;
        return id ? { nodeId: id, binding, override: typeof override === 'object' ? override : null } : null;
    }
    function selection(context, feature) {
        const { chat, member, character } = owners(context);
        const memberChoice = selected(member?.apiBinding, feature);
        if (memberChoice) return { ...memberChoice, source: '本群成员指定', ownerId: member.id };
        if (!member || member.apiBinding?.inheritRole !== false) {
            const roleChoice = selected(character?.apiBinding, feature);
            if (roleChoice) return { ...roleChoice, source: '角色绑定', ownerId: character.id };
        }
        const groupChoice = Array.isArray(chat?.members) && selected(chat.apiBinding, feature);
        return groupChoice ? { ...groupChoice, source: '群级绑定', ownerId: chat.id } : null;
    }
    function requiredCapability(feature) {
        if (['imageChat', 'stickerVision', 'avatarVision', 'callVision'].includes(feature)) return 'vision';
        if (feature === 'webSearch') return 'tools';
        return 'text';
    }
    function nodeConfig(nodeId, feature, binding, override, ownerCharacterId) {
        const node = (db.apiNodes || []).find(item => item.id === nodeId);
        let error = !node ? '绑定的 API 已被删除，请重新选择' : node.enabled === false ? '绑定的 API 已暂停' : '';
        if (!error && node.ownerCharacterId && node.ownerCharacterId !== ownerCharacterId) error = '绑定的 API 仅供其他角色使用，请重新选择';
        const capability = requiredCapability(feature);
        if (!error && Array.isArray(node.capabilities) && node.capabilities.length && !node.capabilities.includes(capability)) {
            error = `绑定的 API 未启用${capability === 'vision' ? '图片理解' : capability === 'tools' ? '工具／联网' : '文本生成'}能力`;
        }
        if (error) return { url: '', key: '', model: '', _bindingError: error, _nodeId: nodeId };
        const config = apiNodeToConfig(node);
        const policy = override || binding;
        const mode = policy.parameterMode || binding.parameterMode || 'node';
        if (mode === 'global' || mode === 'provider') applyApiNodeRouteParameterMode(config, { parameterMode: mode });
        if (mode === 'custom') config.generationParams = resolveApiGenerationParams(
            db.apiSettings?.generationParams,
            { generationParamMode: 'custom', generationParams: policy.generationParams || binding.generationParams },
            db.apiSettings?.temperature
        );
        if (typeof policy.streamEnabled === 'boolean') config.streamEnabled = policy.streamEnabled;
        else if (typeof binding.streamEnabled === 'boolean') config.streamEnabled = binding.streamEnabled;
        if (config.streamEnabled === undefined) config.streamEnabled = !!db.apiSettings?.streamEnabled;
        if (!isApiConfigReady(config)) config._bindingError = '绑定的 API 配置不完整，请检查地址、鉴权和模型';
        return config;
    }
    function resolve(feature, legacyConfig, context) {
        const choice = selection(context, feature) || (feature === 'webSearch' ? selection(context, 'chat') : null);
        if (!choice || choice.system) return null;
        const baseline = getApiConfigForFeature(feature === 'followUp' ? 'background' : feature, legacyConfig);
        const ownerCharacterId = owners(context).character?.id;
        const config = nodeConfig(choice.nodeId, feature, choice.binding, choice.override, ownerCharacterId);
        const policy = choice.override || choice.binding;
        const backups = policy.backupNodeIds || choice.binding.backupNodeIds || [];
        const failureMode = policy.failureMode || choice.binding.failureMode || 'error';
        const fallbackConfigs = failureMode === 'backup'
            ? [...new Set(backups)].filter(id => id !== choice.nodeId).map(id => nodeConfig(id, feature, choice.binding, choice.override, ownerCharacterId)).filter(item => !item._bindingError)
            : failureMode === 'system' && isApiConfigReady(baseline) ? [clone(baseline)] : [];
        const route = { feature, ownerId: choice.ownerId, source: choice.source, failureMode, fallbackConfigs };
        fallbackConfigs.forEach(item => { item._roleBinding = { ...route, fallbackConfigs: [] }; });
        if (config._bindingError && fallbackConfigs.length) {
            const fallback = fallbackConfigs.shift();
            fallback._roleBinding = { ...route, fallbackConfigs, usedFallback: true };
            return clone(fallback);
        }
        config._roleBinding = route;
        return clone(config);
    }
    function fallbackConfigs(feature, config) {
        return config?._roleBinding ? clone(config._roleBinding.fallbackConfigs || []) : null;
    }
    function describe(config) {
        return {
            nodeId: config?._nodeId || '', name: config?.sourceApiNodeName || '系统配置', model: config?.model || '',
            feature: config?._roleBinding?.feature || '', source: config?._roleBinding?.source || '系统配置',
            fallback: !!config?._roleBinding?.usedFallback, at: Date.now()
        };
    }
    function bindTargets(targets, nodeId, featureKeys, replace = false) {
        let changed = 0;
        for (const target of targets) {
            const next = clone(target.apiBinding || { features: [], overrides: {} });
            next.features ||= []; next.overrides ||= {};
            for (const feature of featureKeys) {
                if (!replace && selected(next, feature)) continue;
                if (!next.features.includes(feature)) next.features.push(feature);
                next.overrides[feature] = { nodeId };
                changed++;
            }
            target.apiBinding = next;
        }
        return changed;
    }
    function references(nodeId) {
        const result = [];
        const check = (target, label) => {
            const binding = target.apiBinding;
            if (!binding) return;
            const keys = (binding.features || []).filter(feature => selected(binding, feature)?.nodeId === nodeId);
            if (keys.length || binding.backupNodeIds?.includes(nodeId)) result.push({ target, label, features: keys });
        };
        (db.characters || []).forEach(char => check(char, char.remarkName || char.realName));
        (db.groups || []).forEach(group => {
            check(group, group.name || '群聊');
            (group.members || []).forEach(member => check(member, `${group.name || '群聊'} · ${member.groupNickname || member.realName}`));
        });
        return result;
    }
    window.RoleApiBindings = { features, groups, owners, selection, resolve, fallbackConfigs, describe, bindTargets, references, clone };
})();

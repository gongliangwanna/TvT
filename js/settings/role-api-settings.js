(function () {
    let session = null;
    const $ = id => document.getElementById(id);
    const copy = value => window.RoleApiBindings.clone(value);
    const labelFor = target => target.remarkName || target.groupNickname || target.realName || target.name || '角色';
    const element = (tag, className, text) => {
        const result = document.createElement(tag);
        if (className) result.className = className;
        if (text !== undefined) result.textContent = text;
        return result;
    };
    const button = (text, action) => {
        const result = element('button', 'btn btn-small', text); result.type = 'button';
        result.addEventListener('click', action); return result;
    };
    function availableNodes() {
        return (db.apiNodes || []).filter(node => !node.ownerCharacterId || node.ownerCharacterId === session?.target?.id
            || session?.member?.originalCharId === node.ownerCharacterId);
    }
    function nodeSelect(value, emptyLabel = '沿用系统配置', systemOption = false) {
        const select = element('select');
        const option = (id, text) => { const item = element('option', '', text); item.value = id; select.appendChild(item); };
        option('', emptyLabel);
        if (systemOption) option('system', '此功能沿用系统配置');
        availableNodes().forEach(node => option(node.id, `${node.name}${node.enabled === false ? '（暂停）' : ''}`));
        if (value && !Array.from(select.options).some(item => item.value === value)) option(value, '原绑定不可用，请重新选择');
        select.value = value || '';
        return select;
    }
    function selectOptions(items, value) {
        const select = element('select');
        items.forEach(([id, text]) => { const option = element('option', '', text); option.value = id; select.appendChild(option); });
        select.value = value; return select;
    }
    function row(text, control) {
        const item = element('div', 'role-api-row'); item.append(element('span', 'role-api-label', text), control); return item;
    }
    function checkbox(text, checked, onChange) {
        const label = element('label', 'role-api-check');
        const input = element('input'); input.type = 'checkbox'; input.checked = checked;
        input.addEventListener('change', () => onChange(input.checked));
        label.append(input, element('span', '', text)); return label;
    }
    function status(text, error = false) {
        $('role-api-status').textContent = text;
        $('role-api-status').classList.toggle('error', error);
    }
    function dirty() { if (session) session.dirty = true; }
    function setChatNode(nodeId) {
        const draft = session.draft;
        const keys = session.kind === 'group' || session.kind === 'member' ? ['groupChat'] : ['chat', 'groupChat'];
        draft.defaultNodeId = nodeId;
        for (const key of keys) {
            if (!nodeId) {
                draft.features = draft.features.filter(feature => feature !== key);
                delete draft.overrides[key];
                continue;
            }
            draft.features = [...new Set([...draft.features, key])];
            const policy = typeof draft.overrides[key] === 'object' ? draft.overrides[key] : {};
            draft.overrides[key] = { ...policy, nodeId: nodeId || 'system' };
        }
        dirty();
    }
    function renderFeatures(box, draft, bulk = false) {
        const toolbar = element('div', 'role-api-toolbar');
        const setAll = checked => { draft.features = checked ? Object.keys(RoleApiBindings.features()) : []; dirty(); render(); };
        toolbar.append(button('全选', () => setAll(true)), button('取消全选', () => setAll(false)));
        box.appendChild(toolbar);
        for (const [name, keys] of RoleApiBindings.groups()) {
            const group = element('div', 'role-api-feature-group');
            const heading = element('div', 'role-api-toolbar');
            heading.append(checkbox(name, keys.every(key => draft.features.includes(key)), checked => {
                draft.features = [...new Set([...draft.features.filter(key => !keys.includes(key)), ...(checked ? keys : [])])]; dirty(); render();
            }));
            group.appendChild(heading);
            for (const key of keys) {
                const line = element('div', 'role-api-feature');
                line.appendChild(checkbox(RoleApiBindings.features()[key], draft.features.includes(key), checked => {
                    draft.features = checked ? [...new Set([...draft.features, key])] : draft.features.filter(item => item !== key);
                    dirty(); render();
                }));
                if (!bulk) {
                    const override = draft.overrides?.[key];
                    const select = nodeSelect(typeof override === 'string' ? override : override?.nodeId, '跟随默认绑定', true);
                    select.disabled = !draft.features.includes(key);
                    select.addEventListener('change', () => { draft.overrides[key] = { ...(typeof override === 'object' ? override : {}), nodeId: select.value }; dirty(); render(); });
                    line.appendChild(select);
                    line.appendChild(button('参数', () => { session.expandedFeature = session.expandedFeature === key ? null : key; render(); }));
                }
                group.appendChild(line);
                if (!bulk && session.expandedFeature === key) {
                    const policy = draft.overrides[key] = typeof draft.overrides[key] === 'object' ? draft.overrides[key] : { nodeId: draft.overrides[key] || '' };
                    const options = element('div', 'role-api-feature-options');
                    const parameterMode = selectOptions([['inherit', '跟随角色参数策略'], ['node', '跟随节点'], ['global', '跟随主 API'], ['provider', '交给渠道'], ['custom', '此功能逐项覆盖']], policy.parameterMode || 'inherit');
                    parameterMode.addEventListener('change', () => { if (parameterMode.value === 'inherit') delete policy.parameterMode; else policy.parameterMode = parameterMode.value; dirty(); render(); });
                    options.appendChild(row('此功能参数', parameterMode));
                    if (policy.parameterMode === 'custom') {
                        const editor = element('div'); options.appendChild(editor);
                        createApiGenerationParameterEditor(editor, policy.generationParams, { nodeMode: true, protocol: db.apiNodes?.find(node => node.id === (policy.nodeId || draft.defaultNodeId))?.protocol || 'openai_chat', onChange: value => { policy.generationParams = value; dirty(); } });
                    }
                    const stream = selectOptions([['inherit', '跟随角色／节点'], ['on', '开启'], ['off', '关闭']], policy.streamEnabled === true ? 'on' : policy.streamEnabled === false ? 'off' : 'inherit');
                    stream.addEventListener('change', () => { if (stream.value === 'inherit') delete policy.streamEnabled; else policy.streamEnabled = stream.value === 'on'; dirty(); });
                    options.appendChild(row('此功能流式', stream)); group.appendChild(options);
                }
            }
            box.appendChild(group);
        }
    }
    function renderGroupControls(box) {
        const settings = session.groupDraft;
        const mode = selectOptions([['legacy', '统一生成（原有方式）'], ['members', '成员独立回复']], settings.mode);
        mode.addEventListener('change', () => { settings.mode = mode.value; dirty(); render(); });
        box.appendChild(row('群聊回复方式', mode));
        if (settings.mode !== 'members') return;
        const choices = [
            ['participants', '发言成员', [['natural', '自然发言'], ['all', '全员回复'], ['selected', '指定成员']]],
            ['execution', '生成顺序', [['sequential', '依次回复，可接上文'], ['parallel', '并行回复，同轮上下文']]],
            ['onError', '成员失败时', [['continue', '继续其他成员'], ['stop', '停止本轮']]]
        ];
        for (const [key, text, options] of choices) {
            const select = selectOptions(options, settings[key]);
            select.addEventListener('change', () => { settings[key] = select.value; dirty(); render(); });
            box.appendChild(row(text, select));
        }
        for (const [key, text, max] of [['maxParticipants', '每轮最多人数', 50], ['followUpRounds', '额外接话轮数', 3]]) {
            const input = element('input'); input.type = 'number'; input.min = key === 'followUpRounds' ? '0' : '1'; input.max = String(max); input.value = settings[key];
            input.addEventListener('input', () => { settings[key] = input.value; dirty(); }); box.appendChild(row(text, input));
        }
        const scheduler = nodeSelect(settings.schedulerNodeId, '本地规则，不额外调用 API');
        scheduler.addEventListener('change', () => { settings.schedulerNodeId = scheduler.value; dirty(); });
        box.appendChild(row('发言调度', scheduler));
        const members = element('div', 'role-api-targets');
        members.appendChild(element('p', 'role-api-hint', '指定成员模式使用勾选名单；自然发言会优先处理 @。成员 API 可单独设置。'));
        (session.group.members || []).forEach(member => {
            const line = element('div', 'role-api-row');
            line.append(checkbox(labelFor(member), settings.selectedMemberIds.includes(member.id), checked => {
                settings.selectedMemberIds = checked ? [...new Set([...settings.selectedMemberIds, member.id])] : settings.selectedMemberIds.filter(id => id !== member.id); dirty();
            }), button('API 设置', async () => {
                if (!(await close())) return;
                open('member', { group: session?.group || db.groups.find(group => group.id === currentChatId), member });
            }));
            members.appendChild(line);
        });
        box.appendChild(members);
    }
    function render() {
        if (!session) return;
        const box = $('role-api-body'); box.replaceChildren(); status('');
        const draft = session.draft;
        if (session.kind === 'member') {
            box.appendChild(checkbox('参与独立群聊发言', draft.participationEnabled !== false, checked => { draft.participationEnabled = checked; dirty(); }));
            const inheritance = selectOptions([['inherit', '跟随原角色，再按本群指定覆盖'], ['local', '仅使用本群指定／群级配置']], draft.inheritRole === false ? 'local' : 'inherit');
            inheritance.addEventListener('change', () => { draft.inheritRole = inheritance.value === 'inherit'; dirty(); render(); });
            box.appendChild(row('角色配置来源', inheritance));
        }
        const select = nodeSelect(draft.defaultNodeId, session.kind === 'member' ? '默认继承角色／全局 API' : '默认使用全局 API');
        select.addEventListener('change', () => { setChatNode(select.value); render(); });
        box.appendChild(row(session.kind === 'bulk' ? '分配聊天 API' : '聊天 API', select));
        box.appendChild(element('p', 'role-api-hint', '聊天优先：选择后用于私聊和本角色的群聊发言；未单独配置的角色使用全局 API。其他功能仅在下方勾选后使用绑定。'));
        if (session.kind === 'group') renderGroupControls(box);
        if (session.kind !== 'bulk') box.appendChild(button('清空此处绑定', () => { draft.defaultNodeId = ''; draft.features = []; draft.overrides = {}; draft.backupNodeIds = []; dirty(); render(); }));
        const creation = element('div', 'role-api-toolbar');
        creation.append(button('新建配置', () => {
            if (typeof window.openApiNodeEditor !== 'function') return status('API 节点编辑器尚未就绪', true);
            $('role-api-modal').classList.remove('visible');
            const returnScreen = session.returnScreen;
            window.openApiNodeEditor(null, {
                returnScreen,
                ownerCharacterId: session.kind === 'role' && session.privateNode ? session.target.id : null,
                onClose: node => { if (node) setChatNode(node.id); $('role-api-modal').classList.add('visible'); render(); }
            });
        }));
        const presets = selectOptions([['', '从主 API 预设创建配置'], ...(db.apiPresets || []).map((preset, index) => [String(index), preset.name])], '');
        presets.addEventListener('change', async () => {
            if (presets.value === '') return;
            const preset = db.apiPresets[Number(presets.value)];
            try {
                const data = preset.data || {};
                const params = normalizeApiGenerationParams(data.generationParams, false, data.temperature);
                const node = {
                    id: `api_node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: preset.name,
                    protocol: apiProviderToGenerationProtocol(data.provider), url: data.apiUrl || '', key: data.apiKey || '', model: data.model || '',
                    enabled: true, features: [], generationParamMode: 'custom',
                    generationParams: Object.fromEntries(Object.entries(params).map(([key, entry]) => [key, { mode: entry.enabled ? 'on' : 'off', value: entry.value }])),
                    streamEnabled: data.behavior?.streamEnabled,
                    ownerCharacterId: session.kind === 'role' && session.privateNode ? session.target.id : null
                };
                db.apiNodes ||= []; db.apiNodes.push(node);
                if (await saveGlobalSettings(['apiNodes']) === false) { db.apiNodes.pop(); throw new Error('配置保存失败'); }
                setChatNode(node.id); render(); refreshNodes(); status('已创建聊天配置，请保存绑定；其他功能可按需勾选');
            } catch (error) { status(error.message, true); }
        });
        creation.appendChild(presets); box.appendChild(creation);
        if (session.kind === 'role') box.appendChild(checkbox('新建／导入的配置仅此角色使用', session.privateNode, checked => { session.privateNode = checked; }));
        box.appendChild(element('p', 'role-api-hint', '勾选功能后才生效；未勾选的功能沿用原有配置。群聊绑定需开启成员独立回复。生图、TTS 与向量检索仍使用各自设置。'));
        if (session.kind === 'bulk') {
            const scope = selectOptions([['all', '全部角色'], ['unbound', '未绑定角色'], ['current', '使用所选 API'], ['invalid', '绑定失效']], session.filter || 'all');
            scope.addEventListener('change', () => { session.filter = scope.value; renderTargets(); }); box.appendChild(row('筛选角色', scope));
            const filter = element('input'); filter.type = 'search'; filter.placeholder = '搜索角色'; filter.value = session.search || '';
            filter.addEventListener('input', () => { session.search = filter.value; renderTargets(); }); box.appendChild(filter);
            const tools = element('div', 'role-api-toolbar');
            tools.append(button('全选角色', () => { session.targetIds = (db.characters || []).map(char => char.id); renderTargets(); dirty(); }),
                button('取消选择', () => { session.targetIds = []; renderTargets(); dirty(); })); box.appendChild(tools);
            box.appendChild(element('div', 'role-api-targets')); box.lastChild.id = 'role-api-targets'; renderTargets();
            const replace = selectOptions([['fill', '只补充未配置功能'], ['replace', '替换所选功能绑定']], session.replace ? 'replace' : 'fill');
            replace.addEventListener('change', () => { session.replace = replace.value === 'replace'; dirty(); renderPreview(); }); box.appendChild(row('已有绑定', replace));
        }
        renderFeatures(box, draft, session.kind === 'bulk');
        if (session.kind !== 'bulk') {
            const failure = selectOptions([['error', '报错，保持绑定'], ['backup', '使用指定备用 API'], ['system', '失败后沿用系统配置']], draft.failureMode || 'error');
            failure.addEventListener('change', () => { draft.failureMode = failure.value; dirty(); render(); }); box.appendChild(row('失败处理', failure));
            if (draft.failureMode === 'backup') {
                const backups = element('div', 'role-api-targets'); backups.appendChild(element('p', 'role-api-hint', '按列表从上到下尝试；每个备用 API 最多调用一次。'));
                (draft.backupNodeIds || []).forEach((id, index) => {
                    const source = nodeSelect(id, '请选择备用 API');
                    source.addEventListener('change', () => { draft.backupNodeIds[index] = source.value; dirty(); });
                    const line = row(`备用 ${index + 1}`, source);
                    line.append(button('移除', () => { draft.backupNodeIds.splice(index, 1); dirty(); render(); })); backups.appendChild(line);
                });
                backups.append(button('添加备用', () => { draft.backupNodeIds ||= []; draft.backupNodeIds.push(''); dirty(); render(); })); box.appendChild(backups);
            }
            const params = selectOptions([['node', '跟随 API 节点'], ['global', '跟随主 API'], ['provider', '交给渠道'], ['custom', '角色逐项覆盖']], draft.parameterMode || 'node');
            params.addEventListener('change', () => { draft.parameterMode = params.value; dirty(); render(); }); box.appendChild(row('生成参数', params));
            if (draft.parameterMode === 'custom') {
                const editor = element('div'); box.appendChild(editor);
                createApiGenerationParameterEditor(editor, draft.generationParams, { nodeMode: true, protocol: db.apiNodes?.find(node => node.id === draft.defaultNodeId)?.protocol || 'openai_chat', onChange: value => { draft.generationParams = value; dirty(); } });
            }
            const stream = selectOptions([['inherit', '跟随节点／主 API'], ['on', '开启'], ['off', '关闭']], draft.streamEnabled === true ? 'on' : draft.streamEnabled === false ? 'off' : 'inherit');
            stream.addEventListener('change', () => { if (stream.value === 'inherit') delete draft.streamEnabled; else draft.streamEnabled = stream.value === 'on'; dirty(); }); box.appendChild(row('流式回复', stream));
        }
        box.appendChild(element('div', 'role-api-preview')); box.lastChild.id = 'role-api-preview'; renderPreview();
    }
    function renderTargets() {
        const box = $('role-api-targets'); if (!box) return; box.replaceChildren();
        const query = (session.search || '').toLowerCase();
        (db.characters || []).filter(char => labelFor(char).toLowerCase().includes(query)).filter(char => {
            const bindings = Object.keys(RoleApiBindings.features()).map(key => RoleApiBindings.selection(char, key)).filter(choice => choice && !choice.system);
            if (session.filter === 'unbound') return !bindings.length;
            if (session.filter === 'current') return bindings.some(choice => choice.nodeId === session.draft.defaultNodeId);
            if (session.filter === 'invalid') return bindings.some(choice => !db.apiNodes?.some(node => node.id === choice.nodeId && node.enabled !== false));
            return true;
        }).forEach(char => {
            box.appendChild(checkbox(labelFor(char), session.targetIds.includes(char.id), checked => {
                session.targetIds = checked ? [...new Set([...session.targetIds, char.id])] : session.targetIds.filter(id => id !== char.id); dirty(); renderPreview();
            }));
        });
        if (!box.childElementCount) box.appendChild(element('p', 'role-api-hint', '没有匹配的角色'));
    }
    function renderPreview() {
        const box = $('role-api-preview'); if (!box || !session) return; box.replaceChildren();
        if (session.kind === 'bulk') {
            const targets = db.characters.filter(char => session.targetIds.includes(char.id));
            const occupied = targets.filter(char => session.draft.features.some(key => RoleApiBindings.selection(char, key))).length;
            box.textContent = `已选 ${targets.length} 个角色、${session.draft.features.length} 项功能；${occupied} 个角色存在相关绑定。${session.replace ? '保存会替换所选功能。' : '已有绑定会保留。'}`; return;
        }
        const context = session.kind === 'member' ? { chat: session.group, member: { ...session.member, apiBinding: session.draft } }
            : { ...session.target, apiBinding: session.draft };
        Object.keys(RoleApiBindings.features()).forEach(key => {
            const choice = RoleApiBindings.selection(context, key);
            if (!session.draft.features.includes(key) && !choice) return;
            const node = db.apiNodes?.find(item => item.id === choice?.nodeId);
            box.appendChild(element('p', 'role-api-hint', `${RoleApiBindings.features()[key]}：${choice && !choice.system ? `${node?.name || '绑定失效'} · ${choice.source}` : '原有系统配置'}`));
        });
    }
    function refreshNodes() { if (typeof window.refreshApiNodeList === 'function') window.refreshApiNodeList(); }
    async function close(force = false) {
        if (session?.dirty && !force && !(await customConfirm('绑定设置尚未保存，放弃修改吗？', '放弃修改'))) return false;
        $('role-api-modal').classList.remove('visible'); return true;
    }
    function open(kind, args = {}) {
        const group = args.group || (kind === 'group' ? db.groups.find(item => item.id === currentChatId) : null);
        const target = args.member || group || args.target || (kind === 'role' ? db.characters.find(item => item.id === currentChatId) : null);
        if (kind !== 'bulk' && !target) return showToast('当前角色或群聊不存在');
        session = {
            kind, target, group, member: args.member, dirty: false, privateNode: false, targetIds: [], replace: false,
            draft: copy(target?.apiBinding || { defaultNodeId: args.nodeId || '', features: [], overrides: {}, failureMode: 'error' }),
            returnScreen: document.querySelector('.screen.active')?.id || 'api-settings-screen',
            base: JSON.stringify(target?.apiBinding || null),
            groupBase: JSON.stringify(group?.memberApiSettings || null)
        };
        session.draft.features ||= []; session.draft.overrides ||= {};
        if (kind === 'bulk' && args.nodeId) setChatNode(args.nodeId);
        session.groupDraft = { mode: window.MemberApiRuntime?.isIndependent(group) ? 'members' : 'legacy', participants: 'natural', execution: 'sequential', onError: 'continue', maxParticipants: 3, followUpRounds: 0, selectedMemberIds: [], ...copy(group?.memberApiSettings || {}) };
        $('role-api-title').textContent = kind === 'bulk' ? '按角色分配 API' : kind === 'group' ? '群聊 API 与发言' : `${labelFor(target)} · API 绑定`;
        render(); $('role-api-modal').classList.add('visible');
    }
    async function save() {
        if (!session) return;
        const control = $('role-api-save'); control.disabled = true;
        try {
            const draft = session.draft;
            if (session.kind === 'member' && !session.group.members.includes(session.member)) throw new Error('该成员已退出群聊，请重新打开设置');
            if (session.kind === 'role' && !db.characters.includes(session.target)) throw new Error('该角色已不存在，请重新打开设置');
            if (session.kind === 'group' && !db.groups.includes(session.group)) throw new Error('该群聊已不存在，请重新打开设置');
            if (session.kind !== 'bulk' && JSON.stringify(session.target.apiBinding || null) !== session.base) throw new Error('绑定已在其他入口修改，请关闭后重新打开');
            if (session.kind === 'group' && JSON.stringify(session.group.memberApiSettings || null) !== session.groupBase) throw new Error('群聊设置已改变，请重新打开');
            if (session.kind === 'bulk' && (!session.targetIds.length || !draft.features.length || !draft.defaultNodeId)) throw new Error('请选择 API、角色和适用功能');
            for (const key of draft.features) {
                const override = draft.overrides[key]; const id = typeof override === 'string' ? override : override?.nodeId;
                const nodeId = id || draft.defaultNodeId;
                if (!nodeId || nodeId === 'system') continue;
                const node = availableNodes().find(item => item.id === nodeId);
                if (!node) throw new Error('所选 API 已不存在或仅供其他角色使用');
                if (node.enabled === false) throw new Error('所选 API 已暂停，请启用或重新选择');
                if (!isApiConfigReady(apiNodeToConfig(node))) throw new Error('所选 API 配置不完整');
                if (node.capabilities?.length) {
                    const required = ['imageChat', 'stickerVision', 'avatarVision', 'callVision'].includes(key) ? 'vision' : key === 'webSearch' ? 'tools' : 'text';
                    if (!node.capabilities.includes(required)) throw new Error(`${RoleApiBindings.features()[key]}所需能力未在该节点启用，请检查节点能力声明`);
                }
            }
            if (session.kind === 'group') {
                const settings = session.groupDraft;
                for (const [key, min, max] of [['maxParticipants', 1, 50], ['followUpRounds', 0, 3]]) {
                    const number = Number(settings[key]);
                    if (!Number.isInteger(number) || number < min || number > max) throw new Error(key === 'maxParticipants' ? '每轮人数必须为 1–50 的整数' : '接话轮数必须为 0–3 的整数');
                    settings[key] = number;
                }
                if (settings.mode === 'members' && settings.participants === 'selected' && !settings.selectedMemberIds.length) throw new Error('请勾选要发言的成员');
            }
            if (session.kind === 'bulk') {
                const targets = db.characters.filter(char => session.targetIds.includes(char.id));
                const snapshots = targets.map(target => copy(target.apiBinding));
                const count = RoleApiBindings.bindTargets(targets, draft.defaultNodeId, draft.features, session.replace);
                try { for (const target of targets) if (await saveCharacter(target.id) === false) throw new Error('角色绑定保存失败'); }
                catch (error) {
                    targets.forEach((target, index) => { if (snapshots[index]) target.apiBinding = snapshots[index]; else delete target.apiBinding; });
                    for (const target of targets) await saveCharacter(target.id); throw error;
                }
                showToast(`已更新 ${count} 项功能绑定`);
            } else {
                const previous = copy(session.target.apiBinding); const previousGroup = copy(session.group?.memberApiSettings);
                draft.backupNodeIds = [...new Set((draft.backupNodeIds || []).filter(Boolean))];
                session.target.apiBinding = copy(draft);
                if (session.kind === 'group') session.group.memberApiSettings = copy(session.groupDraft);
                try {
                    const result = session.group ? await saveGroup(session.group.id) : await saveCharacter(session.target.id);
                    if (result === false) throw new Error('保存失败，请检查存储空间');
                } catch (error) {
                    if (previous) session.target.apiBinding = previous; else delete session.target.apiBinding;
                    if (session.group) { if (previousGroup) session.group.memberApiSettings = previousGroup; else delete session.group.memberApiSettings; }
                    throw error;
                }
                showToast('API 绑定已保存，新请求将使用此配置');
            }
            session.dirty = false; await close(true); refreshNodes();
        } catch (error) { status(error.message, true); }
        finally { control.disabled = false; }
    }
    document.addEventListener('click', event => {
        const entry = event.target.closest('[data-role-api-open]');
        if (entry) {
            if (entry.dataset.roleApiOpen === 'member') {
                const group = db.groups.find(item => item.id === currentChatId);
                const member = group?.members.find(item => item.id === $('editing-member-id')?.value);
                if (member) open('member', { group, member });
            } else open(entry.dataset.roleApiOpen);
        }
        if (event.target.closest('#role-api-close')) void close();
        if (event.target.closest('#role-api-save')) void save();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('role-api-modal')?.classList.contains('visible')) { event.stopPropagation(); void close(); } });
    $('role-api-modal')?.addEventListener('click', event => {
        if (event.target === $('role-api-modal')) { event.stopPropagation(); void close(); }
    });
    window.RoleApiSettings = { open, refreshNodes };
})();

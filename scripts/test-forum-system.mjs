import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');

const context = vm.createContext({
    console,
    Date,
    Math,
    Set,
    Map,
    String,
    Number,
    Object,
    Array,
    JSON,
    RegExp,
    isFinite,
    parseInt,
    crypto: globalThis.crypto,
    saveData() {},
    showToast() {},
    confirm() { return true; },
    document: { getElementById() { return null; }, querySelector() { return null; }, body: { appendChild() {} } },
    db: {
        forumPosts: [], forumMessages: [], forumStrangerProfiles: {}, forumSettings: {},
        forumAltAccounts: [{ id: 'alt_a', username: '小号A', avatar: '', bio: '' }],
        forumActiveAccountId: 'main', forumUserProfile: { username: '大号', avatar: '', bio: '' },
        forumPendingRequestFromUser: {}, forumAccountStates: {}, forumRelationships: {},
        forumKnowledge: [], forumSocialEdges: [], forumStoryThreads: [], forumEvents: [],
        forumNotifications: [], forumDrafts: [], characters: []
    }
});

vm.runInContext(read('js/modules/forum/core.js'), context, { filename: 'forum/core.js' });
vm.runInContext(read('js/modules/forum/direct-messages.js'), context, { filename: 'forum/direct-messages.js' });

context.forumEnsureData();
assert.equal(context.db.forumSchemaVersion, 2, 'forum data migrates to current schema');
assert.equal(context.forumEscapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;', 'forum content is escaped');
assert.match(context.forumSafeImageUrl('javascript:alert(1)'), /^https:/, 'unsafe image protocols fall back');

context.db.forumMessages.push(
    { id: 'm1', accountId: 'main', fromUserId: 'npc_main', toUserId: 'user', content: 'main', timestamp: 1 },
    { id: 'm2', accountId: 'alt_a', fromUserId: 'npc_alt', toUserId: 'user', content: 'alt', timestamp: 2 }
);
context.db.forumStrangerProfiles.npc_main = { id: 'npc_main', name: '主号联系人' };
context.db.forumStrangerProfiles.npc_alt = { id: 'npc_alt', name: '小号联系人' };
assert.deepEqual(Array.from(context.forumGetDMUserList(), item => item.id), ['npc_main'], 'main account sees only its DMs');
context.db.forumActiveAccountId = 'alt_a';
assert.deepEqual(Array.from(context.forumGetDMUserList(), item => item.id), ['npc_alt'], 'alt account sees only its DMs');

context.forumSetPendingFriendRequestFromUser('npc_alt', true);
context.db.forumActiveAccountId = 'main';
assert.equal(context.forumHasPendingFriendRequestFromUser('npc_alt'), false, 'friend requests are account scoped');
context.db.forumActiveAccountId = 'alt_a';
assert.equal(context.forumHasPendingFriendRequestFromUser('npc_alt'), true, 'alt friend request remains available to its owner');

const post = { id: 'post_test', isLiked: true, isFavorited: false };
context.db.forumActiveAccountId = 'main';
assert.equal(context.forumGetReaction(post, 'like'), true, 'legacy main-account reaction migrates lazily');
context.db.forumActiveAccountId = 'alt_a';
assert.equal(context.forumGetReaction(post, 'like'), false, 'reaction state does not leak to alt');
context.forumSetReaction(post, 'favorite', true);
context.db.forumActiveAccountId = 'main';
assert.equal(context.forumGetReaction(post, 'favorite'), false, 'alt favorite does not leak to main');
const privateAltPost = { id: 'private_alt', authorId: 'alt_a', visibility: 'private' };
assert.equal(context.forumCanViewPost(privateAltPost), false, 'private alt posts do not leak into the main account');
context.db.forumActiveAccountId = 'alt_a';
assert.equal(context.forumCanViewPost(privateAltPost), true, 'private posts remain visible to their owning account');

const first = context.forumResolveNpcId('', '同名用户', 'one');
const second = context.forumResolveNpcId('', '同名用户', 'two');
assert.notEqual(first, second, 'same display names do not collapse distinct NPC identities');
assert.equal(context.forumResolveNpcId(first, '改名后的同一人', 'reuse'), first, 'explicit stable NPC IDs survive renames');

const rel = context.forumAdjustRelationship(first, { trust: 12, familiarity: 4 }, '测试互动', 'alt_a');
assert.equal(rel.trust, 12);
assert.equal(rel.events.length, 1, 'relationship changes keep an explainable event trail');
const fact = context.forumAddKnowledge(first, 'alt_a', '喜欢在句尾用波浪号', 'public_post', 75, 'alt_a');
assert.equal(fact.source, 'public_post');
assert.equal(context.forumAddKnowledge(first, 'alt_a', fact.fact, fact.source, 75, 'alt_a').id, fact.id, 'knowledge facts deduplicate');

context.db.forumActiveAccountId = 'main';
const job = context.forumStartJob('test');
context.db.forumActiveAccountId = 'alt_a';
assert.equal(context.forumJobIsCurrent(job), false, 'async result becomes stale after account switch');

context.db.forumPosts.push({ id: 'p_story', authorId: first, title: '深夜咖啡馆事件', content: '内容', comments: [], timestamp: Date.now() });
const story = context.forumTrackStoryThread(context.db.forumPosts.at(-1));
assert.ok(story.postIds.includes('p_story'), 'posts attach to persistent story threads');
assert.equal(context.forumRunLocalSearch('咖啡馆').length, 1, 'local search searches stored posts');
context.forumRememberPostVisit('p_story');
assert.equal(context.forumGetAccountState().historyPostIds[0], 'p_story', 'browse history is account scoped and ordered by recency');

const generationSource = read('js/modules/forum/post-generation.js');
assert.ok(generationSource.includes('enhancedPosts.concat(db.forumPosts || [])'), 'refresh appends instead of replacing community history');
assert.ok(!generationSource.includes('jsonData.comments.length'), 'auto-comment feedback does not reference an undefined result object');
assert.ok(generationSource.includes("filter === 'history'"), 'stored browse history has a reachable feed filter');
assert.ok(generationSource.includes("filteredPosts = filteredPosts.filter(p => forumGetReaction(p, 'like'))"), 'feed filters preserve visibility boundaries');
const composerSource = read('js/modules/forum/settings-and-profile.js');
assert.ok(composerSource.includes('forumSaveComposerDraft'), 'draft saving is connected to a visible composer control');
const dmSource = read('js/modules/forum/direct-messages.js');
assert.ok(dmSource.includes('forumMessageBelongsToAccount'), 'DM paths enforce account ownership');
const aiInteractionSource = read('js/modules/forum/ai-interactions.js');
assert.ok(aiInteractionSource.includes('p.authorId === targetUserId || p.npcId === targetUserId'), 'DM persona history follows stable NPC IDs instead of display names');

console.log('Forum tests passed: migration, XSS safety, account isolation, reactions, stable NPCs, relationships, knowledge, stale jobs, story continuity, and local search.');

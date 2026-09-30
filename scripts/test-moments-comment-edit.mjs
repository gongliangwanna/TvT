import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/modules/moments.js', import.meta.url), 'utf8');
const injected = source.replace(/\}\)\(\);\s*$/, 'window.__commentTest = { state, renderDetail, openCommentEditor, saveCommentEdit, deleteComment, regenerateCommentReplies, generateReplies }; })();');
assert.notEqual(injected, source);

const post = {
    id: 'post_1', kind: 'post', authorId: 'user', authorPersonaId: 'persona_1',
    text: '今天的动态', audienceIds: ['user', 'char:a'], likes: [], seenBy: { 'char:a': Date.now() }, createdAt: Date.now(),
    comments: [
        { id: 'comment_1', authorId: 'user', authorPersonaId: 'persona_1', text: '原来的错字', replyTo: '', mentions: [], createdAt: Date.now() - 3000 },
        { id: 'reply_1', authorId: 'char:a', text: '按错字回答', replyTo: 'comment_1', mentions: [], createdAt: Date.now() - 2000 },
        { id: 'follow_1', authorId: 'user', authorPersonaId: 'persona_1', text: '接着聊', replyTo: 'reply_1', mentions: [], createdAt: Date.now() - 1000 }
    ]
};
const db = {
    myPersonaPresets: [{ id: 'persona_1', name: '我', avatar: '' }], activePersonaId: 'persona_1',
    characters: [{ id: 'a', realName: '阿岚', persona: '经营花店', momentsSettings: { interactEnabled: true }, history: [] }],
    apiSettings: { url: 'https://example.invalid', model: 'test', key: 'test' },
    moments: { posts: [post], contacts: [], groups: [], notifications: [], friendRequests: [], activityEvents: [] }
};
const elements = new Map();
function element(id) {
    if (!elements.has(id)) elements.set(id, {
        innerHTML: '', hidden: true, disabled: false, textContent: '', value: '', placeholder: '', dataset: {}, style: {},
        classList: { contains: name => id === 'moments-detail-screen' && name === 'active' },
        focus() {}, setAttribute() {}, querySelector() { return null; }
    });
    return elements.get(id);
}
let saveSucceeds = true;
let confirmation = 'confirm';
let aiResponse = async () => JSON.stringify({ replies: [{ replyId: 'reply_1', actorId: 'char:a', text: '按正确内容回答', stickerId: '' }] });
const toasts = [];
const sandbox = {
    db, console, document: { getElementById: element }, window: null,
    saveGlobalSettings: async () => saveSucceeds, saveCharacter: async () => true,
    showAppConfirmDialog: async () => confirmation,
    showToast: message => toasts.push(message), switchScreen() {},
    isApiConfigReady: config => Boolean(config?.url && config?.model && config?.key), fetchAiResponse: (...args) => aiResponse(...args)
};
sandbox.window = sandbox;
vm.runInNewContext(injected, sandbox, { filename: 'moments.js' });
const { renderDetail, openCommentEditor, saveCommentEdit, deleteComment, regenerateCommentReplies, generateReplies } = sandbox.__commentTest;
const saveEdit = async text => {
    openCommentEditor(post.id, 'comment_1');
    element('moments-comment-edit-text').value = text;
    await saveCommentEdit({ preventDefault() {} });
};

renderDetail(post.id);
assert.match(element('moments-detail-content').innerHTML, /data-action="edit-comment"/);
assert.doesNotMatch(element('moments-detail-content').innerHTML, /data-action="regenerate-comment-replies"/);
await saveEdit('正确的评论');
assert.match(element('moments-detail-content').innerHTML, /data-action="regenerate-comment-replies"/);
assert.equal(post.comments[0].text, '正确的评论');
assert.equal(post.comments[0].replyBasisText, '原来的错字');
assert.equal(post.comments[1].text, '按错字回答', 'editing alone keeps the old reply');
await regenerateCommentReplies(post.id, 'comment_1');
assert.deepEqual(Array.from(post.comments, item => item.id), ['comment_1', post.comments[1].id]);
assert.equal(post.comments[1].text, '按正确内容回答');
assert.equal(post.archivedCommentReplies[0].previousText, '原来的错字');
assert.deepEqual(Array.from(post.archivedCommentReplies[0].comments, item => item.id), ['reply_1', 'follow_1']);
assert.match(element('moments-detail-content').innerHTML, /查看修改前的回复/);
assert.match(element('moments-detail-content').innerHTML, /按错字回答/);

const currentReply = post.comments[1];
saveSucceeds = false;
await saveEdit('保存会失败');
assert.equal(post.comments[0].text, '正确的评论', 'failed edit rolls back');
aiResponse = async () => JSON.stringify({ replies: [{ replyId: currentReply.id, actorId: 'char:a', text: '保存会失败的新回复' }] });
await regenerateCommentReplies(post.id, 'comment_1');
assert.equal(post.comments[1], currentReply, 'failed regeneration keeps the current reply');
assert.equal(post.archivedCommentReplies.length, 1);
saveSucceeds = true;

let resolveAi;
aiResponse = () => new Promise(resolve => { resolveAi = resolve; });
const pending = regenerateCommentReplies(post.id, 'comment_1');
await Promise.resolve();
await saveEdit('再次改正');
resolveAi(JSON.stringify({ replies: [{ replyId: currentReply.id, actorId: 'char:a', text: '过期的回复' }] }));
await pending;
assert.equal(post.comments[0].text, '再次改正');
assert.equal(post.comments[1], currentReply, 'a stale generation cannot replace replies after another edit');

let resolveAutomatic;
aiResponse = () => new Promise(resolve => { resolveAutomatic = resolve; });
const automatic = generateReplies(post.id, 'comment_1');
await Promise.resolve();
await saveEdit('最终改正');
resolveAutomatic(JSON.stringify({ replies: [{ actorId: 'char:a', text: '旧请求的回复' }] }));
await automatic;
assert.equal(post.comments.length, 2, 'the original automatic request also ignores an edited comment');
post.comments.push({ id: 'reply_2', authorId: 'char:a', text: '第二句旧回复', replyTo: 'comment_1', mentions: [], createdAt: Date.now() });
aiResponse = async () => JSON.stringify({ replies: [
    { replyId: currentReply.id, actorId: 'char:a', text: '新的第一句' },
    { replyId: 'reply_2', actorId: 'char:a', text: '新的第二句' }
] });
await regenerateCommentReplies(post.id, 'comment_1');
assert.deepEqual(Array.from(post.comments.filter(item => item.replyTo === 'comment_1'), item => item.text), ['新的第一句', '新的第二句'], 'each old reply gets its own replacement');
assert.equal(post.archivedCommentReplies.length, 2);
const activeReply = post.comments.find(item => item.replyTo === 'comment_1');
assert.match(element('moments-detail-content').innerHTML, /data-action="delete-comment"/);
confirmation = 'cancel';
await deleteComment(post.id, activeReply.id);
assert.ok(post.comments.includes(activeReply), 'cancelling leaves the comment alone');
confirmation = 'confirm';
saveSucceeds = false;
await deleteComment(post.id, activeReply.id);
assert.ok(post.comments.includes(activeReply), 'failed deletion restores the comment');
saveSucceeds = true;
await deleteComment(post.id, activeReply.id);
assert.ok(!post.comments.includes(activeReply), 'a reply without children is removed');
assert.ok(!db.moments.notifications.some(item => item.commentId === activeReply.id), 'linked notifications are removed');

post.comments.push({ id: 'reply_with_child', authorId: 'char:a', text: '需要保留回复链', replyTo: 'comment_1', mentions: [], createdAt: Date.now() });
post.comments.push({ id: 'child_of_reply', authorId: 'user', authorPersonaId: 'persona_1', text: '接在角色回复下面', replyTo: 'reply_with_child', mentions: [], createdAt: Date.now() });
await deleteComment(post.id, 'reply_with_child');
assert.equal(post.comments.find(item => item.id === 'reply_with_child').text, '');
assert.ok(post.comments.find(item => item.id === 'reply_with_child').deletedAt);
assert.ok(post.comments.some(item => item.id === 'child_of_reply'), 'deleting a replied-to comment keeps its children');
assert.match(element('moments-detail-content').innerHTML, /该评论已删除/);

let resolveDeletedAi;
aiResponse = () => new Promise(resolve => { resolveDeletedAi = resolve; });
const pendingDeletion = generateReplies(post.id, 'comment_1');
await Promise.resolve();
await deleteComment(post.id, 'comment_1');
resolveDeletedAi(JSON.stringify({ replies: [{ actorId: 'char:a', text: '不能回到已删除评论下' }] }));
await pendingDeletion;
const deletedRoot = post.comments.find(item => item.id === 'comment_1');
assert.ok(deletedRoot?.deletedAt, 'comment with replies becomes a tombstone');
assert.equal(deletedRoot.text, '');
assert.equal(post.archivedCommentReplies[0].previousText, '', 'archived parent text is redacted');
assert.ok(!post.comments.some(item => item.text === '不能回到已删除评论下'));
assert.ok(!db.moments.notifications.some(item => item.commentId === 'comment_1'));
assert.doesNotMatch(element('moments-detail-content').innerHTML, /data-comment-id="comment_1"[^>]*>编辑/);

post.comments.push({ id: 'lonely_comment', authorId: 'user', authorPersonaId: 'persona_1', text: '可以直接删除', replyTo: '', mentions: [], createdAt: Date.now() });
await deleteComment(post.id, 'lonely_comment');
assert.ok(!post.comments.some(item => item.id === 'lonely_comment'));
assert.ok(toasts.includes('新回复保存失败，原回复已保留'));
console.log('Moments comment editing, deletion, reply replacement, rollback, history and stale-request checks passed.');

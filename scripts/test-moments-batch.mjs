import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/modules/moments.js', import.meta.url), 'utf8');
const injected = source.replace(/\}\)\(\);\s*$/, 'window.__batchTest = { state, worldCategoryPath, booksForBatch, batchWorldBinding, batchPeople, batchPerson, batchPrompt, batchProgress, normalizeBatchCandidate, saveBatchContacts }; })();');
assert.notEqual(injected, source, 'batch helpers remain inside the moments module');

const db = {
    characters: [{ id: 'a', realName: '阿岚', persona: '经营花店，母亲已离世', worldBookIds: ['setting'] }],
    worldBooks: [
        { id: 'setting', name: '世界设定', category: '背景', content: '城市临海' },
        { id: 'family', name: '家族', category: '人物/家人', content: '阿岚的母亲已离世' },
        { id: 'branch', name: '旁支', category: '人物/家人/旁支', content: '亲属迁居外地' },
        { id: 'friend', name: '朋友', category: '人物/朋友', content: '朋友经营书店' }
    ],
    moments: { contacts: [], posts: [], groups: [], notifications: [], friendRequests: [], activityEvents: [] }
};
const elements = new Map();
function element(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', hidden: true, disabled: false, textContent: '', inert: false, style: {}, setAttribute(name, value) { this[name] = value; }, querySelector: () => ({ hidden: false }) });
    return elements.get(id);
}
let saveSucceeds = true;
const sandbox = { db, console, currentChatId: 'a', document: { getElementById: element }, saveGlobalSettings: async () => saveSucceeds, showToast: () => {}, window: null };
sandbox.window = sandbox;
vm.runInNewContext(injected, sandbox, { filename: 'moments.js' });
const { state, worldCategoryPath, booksForBatch, batchWorldBinding, batchPeople, batchPerson, batchPrompt, batchProgress, normalizeBatchCandidate, saveBatchContacts } = sandbox.__batchTest;

assert.equal(worldCategoryPath('人物\\家人\\旁支'), '人物/家人/旁支');
const follow = { mode: 'follow', categoryPaths: ['人物/家人'], itemIds: [], excludedItemIds: ['branch'], inheritOwner: false };
assert.deepEqual(Array.from(booksForBatch('a', follow), book => book.id), ['family'], 'a category includes descendants and supports per-item exclusion');
const snapshot = batchWorldBinding('a', { mode: 'snapshot', categoryPaths: [], itemIds: ['family'], excludedItemIds: [], inheritOwner: false });
db.worldBooks.push({ id: 'new', name: '新条目', category: '人物/家人', content: '新的家族设定' });
assert.deepEqual(Array.from(booksForBatch('a', follow), book => book.id), ['family', 'new'], 'follow mode includes newly added entries');
assert.deepEqual(Array.from(booksForBatch('a', snapshot), book => book.id), ['family'], 'snapshot mode keeps the original selection');

const group = { ownerCharId: 'a', count: 1, gender: '女', relationship: '母亲', note: '温柔' };
const mixedGroup = { ownerCharId: 'a', count: 3, people: [{ gender: '', relationship: '母亲' }, { gender: '男', relationship: '' }, { gender: '女', relationship: '朋友' }], note: '' };
assert.equal(batchPeople(mixedGroup).length, 3);
assert.equal(batchPerson(mixedGroup, 0).gender, '女', 'mother defaults to female for that person');
assert.equal(batchPerson(mixedGroup, 0).relationship, '母亲');
assert.equal(batchPerson(mixedGroup, 1).gender, '男');
assert.equal(batchPerson(mixedGroup, 1).relationship, '', 'mother is not copied to the rest of the group');
assert.deepEqual(Array.from(batchPerson(mixedGroup, 1).reservedRelations), ['母亲']);
assert.equal(batchPerson(mixedGroup, 2).relationship, '朋友');
const batch = { options: {}, world: follow, candidates: [] };
const prompt = batchPrompt(group, 1, batch);
assert.match(prompt, /指定关系：母亲；指定性别：女/);
assert.doesNotMatch(prompt, /共同经历：仅在/);
assert.doesNotMatch(prompt, /家族设定：/);
assert.equal(normalizeBatchCandidate({ name: '林女士', gender: '男', relationship: '母亲', persona: '经营一家店' }, group, 0, batch), null, 'specified gender is required');
assert.equal(normalizeBatchCandidate({ name: '林女士', gender: '女', relationship: '朋友', persona: '经营一家店' }, group, 0, batch), null, 'specified relationship is required');
const contact = normalizeBatchCandidate({ name: '林女士', gender: '女', relationship: '母亲', persona: '经营一家店', experience: '共同旅行' }, group, 0, batch);
assert.ok(contact);
assert.equal(normalizeBatchCandidate({ name: '林女士', gender: '男', relationship: '母亲', persona: '经营一家店' }, batchPerson(mixedGroup, 0), 0, batch, 0), null, 'the mother slot enforces its inferred gender');
assert.equal(normalizeBatchCandidate({ name: '王先生', gender: '男', relationship: '妈妈', persona: '经营一家店' }, batchPerson(mixedGroup, 1), 0, batch, 1), null, 'an unspecified slot cannot take the reserved mother role');
assert.equal(Object.hasOwn(contact.extras, 'experience'), false, 'disabled extras are not stored');
batch.candidates.push(contact);
assert.equal(normalizeBatchCandidate({ name: '林女士', gender: '女', relationship: '母亲', persona: '另一个人' }, group, 0, batch), null, 'draft names stay unique');
batch.options = { experience: true, worldReference: true, worldBinding: true };
const enriched = batchPrompt(group, 1, batch);
assert.match(enriched, /共同经历：仅在 experience 中/);
assert.match(enriched, /阿岚的母亲已离世/);
assert.doesNotMatch(enriched, /亲属迁居外地/, 'excluded entries do not enter the prompt');
const withExtra = normalizeBatchCandidate({ name: '陈女士', gender: '女', relationship: '母亲', persona: '在外地生活', experience: '曾一起看海' }, group, 0, batch);
assert.equal(withExtra.extras.experience, '曾一起看海');
assert.deepEqual(Array.from(withExtra.worldBookBinding.categoryPaths), ['人物/家人']);
state.batch = { groups: [mixedGroup], candidates: [contact], options: { avatar: true }, imageDone: 1 };
batchProgress(state.batch, '正在生成头像', '等待图片接口');
assert.equal(element('moments-batch-progress').hidden, false);
assert.equal(element('moments-batch-progress-fill').style.width, '33%');
assert.match(element('moments-batch-progress-detail').textContent, /1 \/ 3 人已生成 · 1 \/ 3 张图片已处理/);
state.batch = { groups: [group], candidates: [withExtra], options: {}, busy: false };
saveSucceeds = false;
await saveBatchContacts();
assert.equal(db.moments.contacts.length, 0, 'failed persistence rolls back the entire batch');
assert.equal(state.batch.candidates.length, 1, 'failed persistence keeps the draft');
saveSucceeds = true;
await saveBatchContacts();
assert.equal(db.moments.contacts.length, 1);
assert.deepEqual(Object.keys(db.moments.contacts[0].preferences), [], 'new NPCs inherit global participation instead of freezing individual defaults');
assert.equal(db.moments.contacts[0].batchExtras.experience, '曾一起看海');
assert.equal(state.batch, null, 'successful save closes the draft');
console.log('Moments batch constraints, opt-in extras and category binding checks passed.');

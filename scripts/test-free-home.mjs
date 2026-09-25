import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({
    document: { addEventListener() {} },
    defaultWidgetSettings: {
        centralCircleImage: 'default-circle',
        topLeft: { emoji: 'A', text: 'top-left' }, topRight: { emoji: 'B', text: 'top-right' },
        bottomLeft: { emoji: 'C', text: 'bottom-left' }, bottomRight: { emoji: 'D', text: 'bottom-right' }
    },
    db: {
        homeWidgetSettings: { centralCircleImage: 'classic-circle', polaroidImage: 'classic-photo', topLeft: { emoji: '♥', text: 'classic label' } },
        homeSignature: 'classic signature',
        insWidgetSettings: { avatar1: 'classic-avatar-1', avatar2: 'classic-avatar-2', bubble1: 'hello', bubble2: 'world' }
    },
    Date,
    Math,
    Set,
    JSON,
    saveGlobalSettings() { return true; },
    showToast() {},
});
vm.runInContext(fs.readFileSync(new URL('../js/modules/free-home.js', import.meta.url), 'utf8'), context);

function evaluate(expression) { return vm.runInContext(expression, context); }

assert.equal(evaluate('freeHomeData().pages.length'), 2);
assert.equal(evaluate('freeHomeData().pages.flatMap(p => p.items).length'), 13);
assert.equal(evaluate('freeHomeValidLayout(freeHomeData())'), true);
evaluate(`{
    const original = db.freeHomeLayout;
    db.freeHomeLayout = { pages: [{ id: 'legacy', items: [
        { id: 'old-app', type: 'app', appId: 'xiaowu-app' },
        { id: 'old-folder', type: 'folder', name: '旧文件夹', apps: ['xiaowu-app', 'biekan-app'] }
    ] }], dock: [] };
    const cleaned = freeHomeData();
    if (cleaned.pages[0].items.length !== 1 || cleaned.pages[0].items[0].appId !== 'biekan-app') throw new Error('旧小屋图标未清除');
    db.freeHomeLayout = original;
}`);
assert.equal(evaluate('FREE_WIDGETS.clock.legacy && FREE_WIDGETS.note.legacy'), true);
assert.equal(evaluate('FREE_WIDGETS.memory.legacy === undefined && FREE_WIDGETS.ins.legacy === undefined && FREE_WIDGETS.photo.legacy === undefined'), true);
const memorySettings = evaluate('freeHomeWidgetSnapshot("memory")');
const insSettings = evaluate('freeHomeWidgetSnapshot("ins")');
assert.equal(memorySettings.topLeft.text, 'classic label');
assert.equal(insSettings.avatar1, 'classic-avatar-1');
evaluate('db.homeWidgetSettings.topLeft.text = "changed classic"; db.insWidgetSettings.avatar1 = "changed avatar"');
assert.equal(memorySettings.topLeft.text, 'classic label');
assert.equal(insSettings.avatar1, 'classic-avatar-1');
assert.equal(evaluate('freeHomeWidgetSnapshot("photo").image'), 'classic-photo');

const movingPreview = { parentElement: null };
const targetGrid = { querySelector() { return null; }, append(node) { node.parentElement = this; } };
context.homeScreen = { querySelector() { return movingPreview; } };
context.targetGrid = targetGrid;
assert.equal(evaluate('freeHomeMovePreviewToGrid(targetGrid).parentElement === targetGrid'), true);
evaluate('freeHomeData().pages[0].items.push({id:"independent-widget",type:"widget",widget:"ins",settings:{bubble1:"my message"}})');
assert.equal(evaluate('freeHomeData().pages[0].items.at(-1).settings.avatar1'), 'changed avatar');
assert.equal(evaluate('freeHomeData().pages[0].items.at(-1).settings.bubble1'), 'my message');
evaluate('db.insWidgetSettings.avatar1 = "another classic avatar"');
assert.equal(evaluate('freeHomeData().pages[0].items.at(-1).settings.avatar1'), 'changed avatar');
assert.equal(evaluate('freeHomeData().pages[0].items.every(item => Number.isInteger(item.row) && Number.isInteger(item.col))'), true);
assert.equal(evaluate('freeHomePositionsValid(freeHomeData().pages[0].items)'), true);
assert.equal(evaluate('freeHomeCanFit([{type:"widget",widget:"clock"},{type:"widget",widget:"memory"}])'), true);
assert.equal(evaluate('freeHomeCanFit([{type:"widget",widget:"clock"},{type:"widget",widget:"memory"},{type:"app"}])'), false);
assert.equal(evaluate('freeHomeClassifyDrop({type:"app"},{type:"app"},.5,.5).intent'), 'swap');
assert.equal(evaluate('freeHomeClassifyDrop({type:"app"},{type:"app"},.5,.5,true).intent'), 'folder');
assert.equal(evaluate('freeHomeClassifyDrop({type:"app"},{type:"app"},.08,.5).intent'), 'insert');
assert.equal(evaluate('freeHomeClassifyDrop({type:"app"},{type:"app"},.92,.5).after'), true);

const first = evaluate('freeHomeData().pages[0].items[0].id');
const second = evaluate('freeHomeData().pages[0].items[1].id');
context.sourceId = first;
context.targetId = second;
assert.equal(evaluate('freeHomeCommitMove(sourceId, targetId, 0, "swap")'), true);
assert.equal(evaluate('freeHomeData().pages[0].items[0].id'), second);
assert.equal(evaluate('freeHomeData().pages[0].items[1].id'), first);

evaluate('db.freeHomeLayout = freeHomeInitialLayout(); freeHomeLastSaved = JSON.stringify(db.freeHomeLayout)');
context.sourceId = evaluate('freeHomeData().pages[0].items[0].id');
context.targetId = evaluate('freeHomeData().pages[0].items[1].id');
assert.equal(evaluate('freeHomeCommitMove(sourceId, targetId, 0, "folder")'), true);
assert.equal(evaluate('freeHomeData().pages[0].items[0].type'), 'folder');
assert.equal(evaluate('freeHomeData().pages[0].items[0].apps.length'), 2);
assert.equal(evaluate('freeHomeValidLayout(freeHomeData())'), true);

evaluate('db.freeHomeLayout = freeHomeInitialLayout(); freeHomeLastSaved = JSON.stringify(db.freeHomeLayout)');
context.sourceId = evaluate('freeHomeData().pages[0].items[0].id');
assert.equal(evaluate('freeHomeMoveToCell(sourceId, 0, 2, 1)'), true);
assert.equal(evaluate('freeHomeFind(sourceId).item.row'), 2);
assert.equal(evaluate('freeHomeFind(sourceId).item.col'), 1);
assert.equal(evaluate('freeHomePositionsValid(freeHomeData().pages[0].items)'), true);
assert.equal(evaluate('freeHomePlace(freeHomeData().pages[0].items, {id:"new",type:"widget",widget:"clock"}, 3, 0)'), null);
assert.equal(evaluate('freeHomePlace(freeHomeData().pages[0].items, {id:"new",type:"widget",widget:"clock"}, 2, 0) !== null'), true);

const legacy = evaluate('JSON.parse(JSON.stringify(freeHomeData()))');
for (const page of legacy.pages) for (const item of page.items) { delete item.row; delete item.col; }
context.legacy = legacy;
assert.equal(evaluate('freeHomeValidLayout(legacy)'), true);
evaluate('db.freeHomeLayout = legacy');
assert.equal(evaluate('freeHomePositionsValid(freeHomeData().pages[0].items)'), true);

context.sourceId = evaluate('freeHomeData().pages[0].items[1].id');
assert.equal(evaluate('freeHomeCommitMove(sourceId, null, 1, "append")'), true);
assert.equal(evaluate('freeHomeValidLayout(freeHomeData())'), true);
assert.equal(evaluate('freeHomeData().pages[1].items.at(-1).id'), context.sourceId);

evaluate('db.freeHomeLayout = freeHomeInitialLayout(); freeHomeLastSaved = JSON.stringify(db.freeHomeLayout)');
context.sourceId = evaluate('freeHomeData().pages[0].items[0].id');
context.targetId = evaluate('freeHomeData().pages[0].items[2].id');
assert.equal(evaluate('freeHomeCommitMove(sourceId, targetId, 0, "insert", true)'), true);
assert.equal(evaluate('freeHomeData().pages[0].items[2].id'), context.sourceId);
assert.equal(evaluate('freeHomeValidLayout(freeHomeData())'), true);

evaluate('db.freeHomeLayout = freeHomeInitialLayout(); freeHomeLastSaved = JSON.stringify(db.freeHomeLayout)');
context.selectedIds = evaluate('freeHomeData().pages[0].items.slice(0,2).map(item => item.id)');
assert.equal(evaluate('freeHomeCreateFolderFromSelection(freeHomeData().pages[0], selectedIds)'), true);
assert.equal(evaluate('freeHomeData().pages[0].items[0].type'), 'folder');
assert.equal(evaluate('freeHomeValidLayout(freeHomeData())'), true);

console.log('Free home layout tests passed.');

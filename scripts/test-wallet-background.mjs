import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const requestSource = fs.readFileSync(new URL('../js/modules/chat-ai/request-and-stream.js', import.meta.url), 'utf8');
const shopSource = fs.readFileSync(new URL('../js/modules/shop.js', import.meta.url), 'utf8');
const chatFeaturesSource = fs.readFileSync(new URL('../js/modules/chat_features.js', import.meta.url), 'utf8');
assert.match(mainSource, /lastSuccessTime/);
assert.match(mainSource, /retryAt/);
assert.match(mainSource, /visibilitychange[\s\S]*checkAutoReply/);
assert.match(requestSource, /const resilienceEnabled = !isSummary && window\.ReplyResilience/);
assert.doesNotMatch(shopSource, /getAiReply\([^\n]*true/, '用户商城消费不应触发后台 AI 回复');
assert.doesNotMatch(chatFeaturesSource, /getAiReply\([^\n]*true/, '用户转账消费不应触发后台 AI 回复');

const character = {
    id: 'char-1',
    realName: '林深',
    remarkName: '林深',
    myName: '我',
    history: [],
    autonomousShoppingEnabled: true,
    characterSelfShoppingEnabled: true,
    characterGiftShoppingEnabled: true,
    characterOwnWalletShoppingEnabled: true,
    characterFamilyCardSpendingEnabled: true,
    characterShoppingSingleLimit: 200,
    characterShoppingPeriodBudget: 1000,
    characterShoppingFrequency: 'active',
    characterShoppingAllowedCategories: '',
    walletLedger: { balance: 500, transactions: [] }
};
const receivedCard = {
    id: 'received-1',
    fromCharId: character.id,
    fromCharName: character.realName,
    limit: 100,
    usedAmount: 0,
    refreshPeriod: 'monthly',
    nextRefreshTime: Date.now() + 86400000,
    status: 'active',
    transactions: []
};
const issuedCard = {
    id: 'issued-1',
    targetCharId: character.id,
    targetCharName: character.realName,
    limit: 120,
    usedAmount: 0,
    refreshPeriod: 'monthly',
    nextRefreshTime: Date.now() + 86400000,
    status: 'active',
    transactions: []
};
const db = {
    characters: [character],
    piggyBank: {
        balance: 300,
        transactions: [],
        familyCards: [issuedCard],
        receivedFamilyCards: [receivedCard],
        orders: [],
        events: [],
        familyCardNarrationMode: 'detailed'
    }
};
let globalSaves = 0;
let characterSaves = 0;
let aiReplyCalls = 0;
const context = vm.createContext({
    console,
    Date,
    Math,
    db,
    window: {},
    saveGlobalSettings: async () => { globalSaves += 1; },
    saveCharacter: async () => { characterSaves += 1; },
    getAiReply: async () => { aiReplyCalls += 1; },
    showToast() {}
});
context.window.window = context.window;
vm.runInContext(fs.readFileSync(new URL('../js/modules/piggy_bank.js', import.meta.url), 'utf8'), context);

const wallet = context.window.WalletSystem;
assert.ok(wallet, 'wallet system should be exported');

const charge = await wallet.chargeReceivedFamilyCard(receivedCard.id, {
    amount: 20,
    scene: '商城',
    detail: '购买牛奶'
});
assert.equal(charge.ok, true);
assert.equal(receivedCard.usedAmount, 20);
assert.equal(character.walletLedger.balance, 480, '用户使用角色亲属卡应记入角色真实支出');
assert.equal(character.history.filter(item => item.isFamilyCardEvent).length, 1, '消费应留下下次正常聊天可知的隐藏事件');
assert.equal(character.history.filter(item => item.isFamilyCardNarration).length, 1, '详细旁白模式应记录一条聊天旁白');
assert.equal(aiReplyCalls, 0, '亲属卡消费不得额外触发 AI 后台回复');

db.piggyBank.familyCardNarrationMode = 'none';
await wallet.chargeReceivedFamilyCard(receivedCard.id, { amount: 10, scene: '转账', detail: '转账测试' });
assert.equal(character.history.filter(item => item.isFamilyCardEvent).length, 2);
assert.equal(character.history.filter(item => item.isFamilyCardNarration).length, 1, '关闭旁白后仍应保留隐藏事件，但不新增可见旁白');

const roleOrder = {
    id: 'order-message-1',
    content: '[林深为自己下单了：即时送达|50|生活用品 x1；支付方式：用户亲属卡]'
};
const purchase = await wallet.executeCharacterPurchase(character, roleOrder);
assert.equal(purchase.ok, true);
assert.equal(purchase.paymentSource, 'user_family_card');
assert.equal(issuedCard.usedAmount, 50);
assert.equal(db.piggyBank.balance, 250, '角色使用用户亲属卡应扣用户钱包');
assert.equal(roleOrder.shopPaymentStatus, 'paid');

character.characterFamilyCardSpendingEnabled = false;
const blockedBalance = db.piggyBank.balance;
const blocked = await wallet.executeCharacterPurchase(character, {
    id: 'order-message-2',
    content: '[林深为自己下单了：即时送达|10|零食 x1；支付方式：用户亲属卡]'
});
assert.equal(blocked.ok, false, '独立开关关闭时必须拦截角色使用用户亲属卡');
assert.match(blocked.reason, /权限未开启/);
assert.equal(db.piggyBank.balance, blockedBalance);

receivedCard.status = 'pending';
const pendingCharge = await wallet.chargeReceivedFamilyCard(receivedCard.id, { amount: 1 });
assert.equal(pendingCharge.ok, false, '用户未接收的角色亲属卡不可使用');
assert.ok(globalSaves > 0 && characterSaves > 0, '钱包和角色数据应一起持久化');

console.log('Wallet/background tests passed: no extra AI reply, narration modes, real ledgers, active-card gating, and role family-card switch.');

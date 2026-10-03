import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'parse5';

const source = fs.readFileSync(new URL('../js/modules/pomodoro.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, console, Date, Math });
vm.runInContext(source, context);
const clock = context.window.PomodoroClock;
const task = { id: 'reading', name: '读第三章', mode: 'countdown', duration: 25, settings: { boundCharId: 'reader' } };

// A delayed callback or a serialized/reloaded page must reflect wall time.
let session = clock.create(task, 1000);
assert.equal(clock.elapsed(session, 91000), 90000);
session = JSON.parse(JSON.stringify(session));
assert.equal(clock.valid(session), true);
assert.equal(clock.elapsed(session, 181000), 180000);
clock.pause(session, 181250);
assert.equal(clock.elapsed(session, 999999), 180250);
clock.resume(session, 1000000);
assert.equal(clock.elapsed(session, 1060000), 240250);
assert.equal(clock.due(session, 3000000), true);
const completed = clock.finish(session, 3000000, true);
assert.equal(completed.seconds, 1500);
assert.equal(completed.endedAt, 2319750);
assert.equal(completed.status, 'completed');
assert.equal(clock.finish(session, 3000001, true), null, 'completion is idempotent');
assert.equal(task.settings.boundCharId, 'reader', 'session owns its task snapshot');
session.task.settings.boundCharId = 'other';
assert.equal(task.settings.boundCharId, 'reader');

session = clock.create(task, 0);
assert.equal(clock.finish(session, 45000).status, 'early');
assert.equal(session.round, 1);
const fresh = clock.create(task, 0);
assert.equal(clock.finish(fresh, 999), null, 'no empty record');

session = clock.create({ ...task, mode: 'stopwatch', duration: 0 }, 500);
assert.equal(clock.due(session, 10000000), false);
clock.pause(session, 65900);
const counted = clock.finish(session, 200000);
assert.equal(counted.seconds, 65);
assert.equal(counted.status, 'completed');
clock.rest(session, 5, 200000);
assert.equal(clock.elapsed(session, 230000), 30000);
assert.equal(clock.due(session, 600000), true);
clock.pause(session, 600000);
assert.equal(session.elapsedMs, 300000);
assert.equal(clock.finish(session, 600000), null, 'rest never creates a focus record');
assert.equal(clock.valid({ ...session, breakMinutes: -1 }), false);
assert.equal(clock.valid({ ...session, status: 'running', startedAt: null }), false);
assert.equal(clock.valid({ task }), false);
assert.equal(clock.valid(null), false);
assert.equal(clock.elapsed(clock.create(task, 10000), 9000), 0, 'clock rollback cannot produce negative time');
assert.equal(vm.runInContext('pomodoroStyle({})', context), 'legacy', 'existing tasks retain original companionship');
assert.equal(vm.runInContext('pomodoroStyle({companionStyle:"quiet"})', context), 'quiet');

// Every new handler is attached to a real, unique UI element.
const html = fs.readFileSync(new URL('../src/html/screens/lifestyle.html', import.meta.url), 'utf8');
const ids = new Map();
function walk(node) {
    const id = node.attrs?.find(a => a.name === 'id')?.value;
    if (id) ids.set(id, (ids.get(id) || 0) + 1);
    for (const child of node.childNodes || []) walk(child);
}
walk(parse(html));
for (const match of source.matchAll(/byId\('([^']+)'\)/g)) assert.equal(ids.get(match[1]), 1, `UI hook ${match[1]}`);
for (const id of ['pomodoro-encouragement-minutes', 'pomodoro-poke-limit', 'pomodoro-user-persona-select', 'pomodoro-focus-bg-upload', 'pomodoro-task-card-bg-upload', 'link-global-pomodoro-world-book-btn']) assert.equal(ids.get(id), 1, `preserved ${id}`);
const state = fs.readFileSync(new URL('../js/data/defaults-and-state.js', import.meta.url), 'utf8');
const storage = fs.readFileSync(new URL('../js/data/indexed-db.js', import.meta.url), 'utf8');
const backup = fs.readFileSync(new URL('../js/modules/tutorial/backup-and-restore.js', import.meta.url), 'utf8');
for (const key of ['pomodoroRecords', 'pomodoroActiveSession']) {
    assert.ok(state.includes(`'${key}'`) && state.includes(`${key}:`), `registered setting ${key}`);
    assert.ok(storage.includes(`${key}:`), `storage default ${key}`);
    assert.ok(backup.includes(`restoredData.${key}`), `old backup default ${key}`);
}
console.log('Pomodoro: timestamp recovery, pause/resume, count-up settlement, rest exclusion, idempotency, legacy settings, UI hooks and storage/backup checks passed.');

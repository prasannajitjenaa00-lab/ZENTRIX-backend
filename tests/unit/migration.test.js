'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformLegacy } = require('../../src/migration/transform');
const { encryptJSON, decryptJSON, parseKey, hashPassword, verifyPassword } = require('../../src/utils/crypto');

const real = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/pulse-db.redacted.json'), 'utf8'));
const key = parseKey('c'.repeat(64));
let n = 0;
const opts = (extra = {}) => ({ batchId: 'b1', hashPassword: async (p) => `H(${p})`, encryptBank: (b) => encryptJSON(b, key), genId: () => (++n).toString(16).padStart(24, '0'), ...extra });

test('REAL pulse-db.json: all 7 users and 15 tasks migrate with zero errors', async () => {
  const { docs, report } = await transformLegacy(real, opts());
  assert.deepEqual(report.errors, []);
  assert.equal(docs.users.length, 7);
  assert.equal(docs.tasks.length, 15);
  assert.equal(docs.packages.length, 4);                       // defaults recreated: key was absent in the file
  assert.equal(docs.activity.length, 3);
  assert.ok(report.repairs.some((r) => r.includes('no "packages"')));
  assert.equal(report.counts.source.users, 7);
});

test('REAL data: relationships resolve to the new ids and floors derive from leaders', async () => {
  const { docs } = await transformLegacy(real, opts());
  const byLegacy = Object.fromEntries(docs.users.map((u) => [u.legacyId, u]));
  assert.equal(byLegacy.u_priya.leader, byLegacy.u_ananya._id);
  assert.equal(byLegacy.u_priya.floor, byLegacy.u_vikram._id);
  assert.equal(byLegacy.u_ananya.floor, byLegacy.u_vikram._id);
  assert.equal(byLegacy.u_vikram.leader, undefined);
  assert.equal(byLegacy.u_neha.status, 'Suspended');
  const task = docs.tasks.find((t) => t.legacyId === 'task_brand');
  assert.equal(task.assignee, byLegacy.u_priya._id);
  assert.equal(task.assignedBy, byLegacy.u_admin._id);
  assert.equal(task.due, '2026-09-16');
  assert.equal(task.progress, 81);
  assert.equal(task.updatedAt.toISOString(), '2026-09-12T20:21:20.095Z');   // preserved: drives inactivity rule
  const premium = docs.packages.find((p) => p.key === 'premium')._id;
  assert.equal(byLegacy.u_rohan.package, premium);
  assert.equal(byLegacy.u_admin.package, undefined);
});

test('REAL data: passwords hashed (never copied), force-change set, MFA defaults, demo-password warning', async () => {
  const { docs, report } = await transformLegacy({ ...real, db: { ...real.db, users: real.db.users.map((u) => ({ ...u, password: u.id === 'u_admin' ? 'Admin@123' : u.password })) } }, opts());
  for (const u of docs.users) { assert.ok(u.passwordHash.startsWith('H(')); assert.equal(u.mustChangePassword, true); assert.equal('password' in u, false); assert.equal(u.mfa.enabled, true); assert.deepEqual(u.mfa.recovery, []); }
  assert.ok(report.warnings.some((w) => w.includes('default/demo password')));
  const off = await transformLegacy(real, opts({ forceChange: false }));
  assert.equal(off.docs.users[0].mustChangePassword, false);
});

test('bank details are encrypted, lock state preserved, nothing plaintext in output', async () => {
  const legacy = { db: { ...real.db, users: real.db.users.map((u) => u.id === 'u_priya' ? { ...u, bankHolder: 'Priya Sharma', bankName: 'SBI', bankAccount: '123456789012', bankIfsc: 'SBIN0001234', bankLocked: true, bankUpdatedAt: '2026-09-10T10:00:00.000Z' } : u) } };
  const { docs } = await transformLegacy(legacy, opts());
  const u = docs.users.find((x) => x.legacyId === 'u_priya');
  assert.equal(u.bank.locked, true); assert.equal(u.bank.hasDetails, true);
  assert.ok(!JSON.stringify(docs).includes('123456789012'));
  assert.deepEqual(decryptJSON(u.bank.enc, key), { holder: 'Priya Sharma', name: 'SBI', account: '123456789012', ifsc: 'SBIN0001234' });
  assert.equal(docs.users.find((x) => x.legacyId === 'u_rohan').bank.hasDetails, false);
});

test('legacy plaintext recovery codes and trusted-device tokens are dropped and counted', async () => {
  const legacy = { db: { ...real.db, users: real.db.users.map((u) => u.id === 'u_priya' ? { ...u, mfaRecovery: ['PULSE-AAAA', 'PULSE-BBBB'], trustedDevices: [{ token: 't', exp: 1 }] } : u) } };
  const { docs, report } = await transformLegacy(legacy, opts());
  assert.deepEqual(report.dropped, { recoveryCodes: 2, trustedDevices: 1 });
  assert.ok(!JSON.stringify(docs).includes('PULSE-AAAA'));
});

test('messy data: duplicates, dangling refs, bad enums are repaired or rejected WITH a report', async () => {
  const messy = { db: {
    users: [
      { id: 'a', name: 'Admin', email: 'A@x.io', password: 'pw1234', role: 'admin' },
      { id: 'tl', name: 'TL', email: 'tl@x.io', password: 'pw1234', role: 'team_leader' },
      { id: 'fm', name: 'FM', email: 'fm@x.io', password: 'pw1234', role: 'floor_manager' },
      { id: 'e1', name: 'E1', email: 'e1@x.io', password: 'pw1234', role: 'employee', leaderId: 'ghost', packageId: 'nope' },
      { id: 'dup', name: 'Dup', email: 'E1@X.IO', password: 'pw1234', role: 'employee' },
      { id: 'weird', name: 'W', email: 'w@x.io', role: 'wizard', status: 'Banned' },
    ],
    tasks: [
      { id: 't1', title: 'ok', assigneeId: 'e1', due: '2026-09-01', status: 'Weird', priority: 'Urgent', progress: 250 },
      { id: 't2', title: 'orphan', assigneeId: 'nobody', due: '2026-09-01' },
      { id: 't3', title: 'baddate', assigneeId: 'e1', due: '2026-02-31' },
      { id: 't4', title: 'dup-owner', assigneeId: 'dup', due: '2026-09-01' },
    ],
  } };
  const { docs, report } = await transformLegacy(messy, opts());
  assert.equal(docs.users.length, 5);                         // duplicate email dropped
  assert.ok(report.errors.some((e) => e.includes('duplicate email')));
  const e1 = docs.users.find((u) => u.legacyId === 'e1');
  assert.equal(e1.leader, docs.users.find((u) => u.legacyId === 'tl')._id);     // normalizeRoster default leader
  assert.equal(e1.floor, docs.users.find((u) => u.legacyId === 'fm')._id);   // leader has no floor -> default floor manager
  assert.equal(e1.package, docs.packages.find((p) => p.key === 'standard')._id);
  const w = docs.users.find((u) => u.legacyId === 'weird');
  assert.equal(w.role, 'employee'); assert.equal(w.status, 'Suspended');
  assert.equal(docs.tasks.length, 1);                         // t2,t3,t4 rejected
  const t1 = docs.tasks[0];
  assert.equal(t1.status, 'Pending'); assert.equal(t1.priority, 'Medium'); assert.equal(t1.progress, 100);
  assert.equal(report.errors.filter((e) => e.startsWith('task')).length, 3);
  assert.ok(report.repairs.length >= 5);
  assert.ok(docs.users.find((u) => u.legacyId === 'weird').passwordHash.startsWith('H('));   // unguessable replacement
});

test('audio chain: tracks, assignments (deduped), notebooks (deduped), dangling refs rejected', async () => {
  const legacy = { db: { ...real.db,
    projects: [{ id: 'p1', name: 'Set', createdBy: 'u_admin', createdAt: '2026-09-01T00:00:00Z' }],
    tracks: [{ id: 'tr1', projectId: 'p1', originalName: 'a.mp3', fileName: 'trk_1.mp3', size: 10, uploadedAt: '2026-09-02T00:00:00Z' }, { id: 'tr2', projectId: 'missing', fileName: 'x.mp3' }],
    assignments: [{ id: 'as1', trackId: 'tr1', projectId: 'p1', assigneeId: 'u_priya', assignedBy: 'u_ananya', status: 'Written' }, { id: 'as2', trackId: 'tr1', projectId: 'p1', assigneeId: 'u_priya' }, { id: 'as3', trackId: 'tr9', projectId: 'p1', assigneeId: 'u_priya' }],
    notebooks: [{ id: 'n1', userId: 'u_priya', trackId: 'tr1', text: 'hello' }, { id: 'n2', userId: 'u_priya', trackId: 'tr1', text: 'dupe' }, { id: 'n3', userId: 'ghost', trackId: 'tr1' }],
    chat: [{ id: 'c1', userId: 'u_admin', name: 'Aryan', text: 'hi', at: '2026-09-01T00:00:00Z' }, { id: 'c2', userId: 'ghost', text: 'x', at: '2026-09-01T00:00:00Z' }] } };
  const { docs, report } = await transformLegacy(legacy, opts());
  assert.equal(docs.tracks.length, 1); assert.equal(docs.tracks[0].legacyFile, 'trk_1.mp3');
  assert.equal(docs.tracks[0].uploadedBy, docs.users.find((u) => u.legacyId === 'u_admin')._id);
  assert.equal(docs.assignments.length, 1); assert.equal(docs.assignments[0].status, 'Written');
  assert.equal(docs.notebooks.length, 1); assert.equal(docs.notebooks[0].text, 'hello');
  assert.equal(docs.chat.length, 1);
  assert.ok(report.errors.length >= 4);
});

test('idempotent: already-migrated legacy ids are skipped (insert-only), ids reused for relations', async () => {
  const first = await transformLegacy(real, opts());
  const existing = { users: new Map(first.docs.users.map((u) => [u.legacyId, u._id])), tasks: new Map(first.docs.tasks.map((t) => [t.legacyId, t._id])), packages: new Map(first.docs.packages.map((p) => [p.key, p._id])), activity: new Map(first.docs.activity.map((a) => [a.legacyId, a._id])) };
  const second = await transformLegacy(real, opts({ existing }));
  assert.equal(second.docs.users.length, 0); assert.equal(second.docs.tasks.length, 0); assert.equal(second.docs.activity.length, 0);
  assert.ok(second.report.warnings.some((w) => w.includes('already migrated')));
  const plus = { db: { ...real.db, tasks: [...real.db.tasks, { id: 'task_new', title: 'New', assigneeId: 'u_priya', due: '2026-10-01' }] } };
  const third = await transformLegacy(plus, opts({ existing }));
  assert.equal(third.docs.tasks.length, 1);
  assert.equal(third.docs.tasks[0].assignee, existing.users.get('u_priya'));      // links to the already-migrated user
});

test('migration does not mutate the source object', async () => {
  const copy = JSON.parse(JSON.stringify(real));
  await transformLegacy(copy, opts());
  assert.deepEqual(copy, real);
});

test('real scrypt hashing round-trips through the migration hash function', async () => {
  const fast = { N: 1 << 10, r: 8, p: 1 };
  const { docs } = await transformLegacy({ db: { users: [{ id: 'a', name: 'A', email: 'a@x.io', password: 'Secret#1', role: 'admin' }], tasks: [] } }, opts({ hashPassword: (p) => hashPassword(p, fast) }));
  assert.equal(await verifyPassword('Secret#1', docs.users[0].passwordHash), true);
  assert.equal(await verifyPassword('wrong', docs.users[0].passwordHash), false);
});

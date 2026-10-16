'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let org; let M; let A; let FM; let TLA; let TLB; let E_A1; let E_A2; let E_B1;
test.before(async () => {
  ({ M } = await H.boot()); org = await H.seedOrg();
  [A, FM, TLA, TLB, E_A1, E_A2, E_B1] = await Promise.all(['admin', 'fm', 'tla', 'tlb', 'a1', 'a2', 'b1'].map((n) => H.login(`${n}@t.io`)));
});
test.after(() => H.shutdown());

const newTask = (assignee, extra = {}) => ({ title: 'Task', assigneeId: String(assignee._id), due: H.futureDate(), ...extra });

/* ---------- role matrix ---------- */
test('admin-only endpoints reject every other role', async () => {
  for (const agent of [FM, TLA, E_A1]) {
    for (const [m, u, b] of [['get', '/api/users'], ['post', '/api/users', {}], ['get', '/api/packages'], ['post', '/api/projects', { name: 'x' }], ['post', '/api/chat', { text: 'hi' }]]) {
      assert.equal((await H.call(agent, m, u, b)).status, 403, `${m} ${u}`);
    }
  }
});
test('employees cannot create tasks or use leader-only endpoints', async () => {
  assert.equal((await H.call(E_A1, 'post', '/api/tasks', newTask(org.a2))).status, 403);
  assert.equal((await H.call(E_A1, 'get', '/api/dashboard')).status, 403);
  assert.equal((await H.call(E_A1, 'get', '/api/users/crew')).status, 403);
  assert.equal((await H.call(E_A1, 'post', '/api/audio/assign', { trackIds: ['a'.repeat(24)], assigneeIds: [String(org.a2._id)] })).status, 403);
});
test('unauthenticated requests are 401 everywhere', async () => {
  for (const u of ['/api/tasks', '/api/users', '/api/dashboard/me', '/api/chat', '/api/projects']) assert.equal((await H.call(H.request(H.app), 'get', u)).status, 401, u);
});
test('the studio chat: everyone reads, only admin writes (original rule)', async () => {
  assert.equal((await H.call(A, 'post', '/api/chat', { text: 'Hello team' })).status, 201);
  for (const agent of [FM, TLA, E_A1]) { const r = await H.call(agent, 'get', '/api/chat'); assert.equal(r.status, 200); assert.equal(r.body.data.at(-1).text, 'Hello team'); }
  assert.equal((await H.call(A, 'post', '/api/chat', { text: 'x'.repeat(501) })).status, 400);
});

/* ---------- task scope / IDOR ---------- */
test('visibility: admin all; FM floor; TL own team; employee only own', async () => {
  await M.Task.deleteMany({});
  await H.call(A, 'post', '/api/tasks', newTask(org.a1, { title: 'for-a1' }));
  await H.call(A, 'post', '/api/tasks', newTask(org.a2, { title: 'for-a2' }));
  await H.call(A, 'post', '/api/tasks', newTask(org.b1, { title: 'for-b1' }));
  const titles = async (agent) => (await H.call(agent, 'get', '/api/tasks')).body.data.map((t) => t.title).sort();
  assert.deepEqual(await titles(A), ['for-a1', 'for-a2', 'for-b1']);
  assert.deepEqual(await titles(FM), ['for-a1', 'for-a2', 'for-b1']);
  assert.deepEqual(await titles(TLA), ['for-a1', 'for-a2']);
  assert.deepEqual(await titles(TLB), ['for-b1']);
  assert.deepEqual(await titles(E_A1), ['for-a1']);
});
test('IDOR: employee cannot read, update or delete a colleague\'s task (404, no existence leak)', async () => {
  const t = await M.Task.findOne({ title: 'for-a2' });
  for (const [m, u, b] of [['get', `/api/tasks/${t._id}`], ['patch', `/api/tasks/${t._id}/status`, { status: 'Completed' }]]) assert.equal((await H.call(E_A1, m, u, b)).status, 404);
  assert.equal((await H.call(E_A1, 'delete', `/api/tasks/${t._id}`)).status, 403);
  assert.equal((await M.Task.findById(t._id)).status, 'Pending');
});
test('IDOR: team leader B cannot see or touch team A tasks', async () => {
  const t = await M.Task.findOne({ title: 'for-a1' });
  assert.equal((await H.call(TLB, 'get', `/api/tasks/${t._id}`)).status, 404);
  assert.equal((await H.call(TLB, 'patch', `/api/tasks/${t._id}/status`, { status: 'Completed' })).status, 404);
});
test('team leader sees a teammate\'s task but cannot edit it ("lives on another desk"); only admin edits metadata', async () => {
  const t = await M.Task.findOne({ title: 'for-a1' });
  assert.equal((await H.call(TLA, 'get', `/api/tasks/${t._id}`)).status, 200);
  assert.equal((await H.call(TLA, 'patch', `/api/tasks/${t._id}/status`, { status: 'Completed' })).status, 403);
  assert.equal((await H.call(TLA, 'patch', `/api/tasks/${t._id}`, { title: 'hijack' })).status, 403);
  assert.equal((await H.call(E_A1, 'patch', `/api/tasks/${t._id}`, { title: 'hijack' })).status, 403);
});
test('assignee updates status/progress/notes; Completed forces 100%; assignee cannot change metadata via status route', async () => {
  const t = await M.Task.findOne({ title: 'for-a1' });
  const r = await H.call(E_A1, 'patch', `/api/tasks/${t._id}/status`, { status: 'In Progress', progress: 70, notes: 'going', title: 'ignored', assigneeId: String(org.a2._id) });
  assert.equal(r.status, 200); assert.equal(r.body.data.progress, 70); assert.equal(r.body.data.title, 'for-a1'); assert.equal(r.body.data.assigneeId, String(org.a1._id));
  const done = await H.call(E_A1, 'patch', `/api/tasks/${t._id}/status`, { status: 'Completed', progress: 10 });
  assert.equal(done.body.data.progress, 100);
  assert.equal((await H.call(E_A1, 'patch', `/api/tasks/${t._id}/status`, { progress: 999 })).body.data.progress, 100);
});
test('assignment scope: TL can assign own team only; FM within floor; suspended and leaders rejected', async () => {
  assert.equal((await H.call(TLA, 'post', '/api/tasks', newTask(org.a2))).status, 201);
  assert.equal((await H.call(TLA, 'post', '/api/tasks', newTask(org.b1))).status, 403);
  assert.equal((await H.call(FM, 'post', '/api/tasks', newTask(org.b1))).status, 201);
  assert.equal((await H.call(A, 'post', '/api/tasks', newTask(org.sus))).status, 403);
  assert.equal((await H.call(A, 'post', '/api/tasks', newTask(org.tlA))).status, 403);
});
test('validation: bad dates/status/ids are 400, not 500; operator injection is neutralised', async () => {
  assert.equal((await H.call(A, 'post', '/api/tasks', newTask(org.a1, { due: '2026-02-31' }))).status, 400);
  assert.equal((await H.call(A, 'post', '/api/tasks', newTask(org.a1, { status: 'Nope' }))).status, 400);
  assert.equal((await H.call(A, 'post', '/api/tasks', { ...newTask(org.a1), assigneeId: { $ne: null } })).status, 400);
  assert.equal((await H.call(A, 'get', '/api/tasks/not-an-id')).status, 404);
  const inj = await H.call(A, 'get', '/api/tasks').query({ status: { $ne: 'x' } });
  assert.ok([200, 400].includes(inj.status));
});
test('admin edits metadata, reassigns; reassigned task leaves the old owner\'s view', async () => {
  const t = await M.Task.findOne({ title: 'for-a2' });
  const r = await H.call(A, 'patch', `/api/tasks/${t._id}`, { title: 'moved', assigneeId: String(org.a1._id), status: 'Completed' });
  assert.equal(r.status, 200); assert.equal(r.body.data.progress, 100);
  assert.equal((await H.call(E_A2, 'get', `/api/tasks/${t._id}`)).status, 404);
  assert.equal((await H.call(E_A1, 'get', `/api/tasks/${t._id}`)).status, 200);
});
test('calendar: admin sees all (filterable); others only their own tasks (original behaviour)', async () => {
  const m = H.futureDate(10).slice(0, 7);
  const adminAll = (await H.call(A, 'get', '/api/tasks/calendar').query({ month: m })).body.data.length;
  const tl = (await H.call(TLA, 'get', '/api/tasks/calendar').query({ month: m })).body.data.length;
  assert.ok(adminAll > 0); assert.equal(tl, 0);
  assert.equal((await H.call(A, 'get', '/api/tasks/calendar').query({ month: '2026-13' })).status, 400);
});
test('search matches owner name, min 2 chars', async () => {
  const r = await H.call(A, 'get', '/api/tasks').query({ q: 'Emp A1' });
  assert.ok(r.body.data.length > 0);
  assert.ok((await H.call(A, 'get', '/api/tasks').query({ q: 'x' })).body.data.length >= r.body.data.length);   // 1 char ignored => unfiltered
});
test('dashboard scope: admin gets security panel w/o passwords; FM/TL are scoped and get none', async () => {
  const a = (await H.call(A, 'get', '/api/dashboard')).body.data;
  assert.ok(Array.isArray(a.security)); assert.ok(!JSON.stringify(a).match(/password"|passwordHash|scrypt/i));
  const tl = (await H.call(TLB, 'get', '/api/dashboard')).body.data;
  assert.equal(tl.security, undefined);
  assert.ok(tl.activeMembers.concat(tl.inactiveMembers).every((m) => [String(org.b1._id)].includes(m.id)));
});

/* ---------- accounts ---------- */
test('create account rules: employee needs a valid active team leader; email unique (case-insens.); FM cannot be created/demoted', async () => {
  assert.equal((await H.call(A, 'post', '/api/users', { name: 'X', email: 'x1@t.io', role: 'employee' })).status, 400);
  assert.equal((await H.call(A, 'post', '/api/users', { name: 'X', email: 'x1@t.io', role: 'employee', leaderId: String(org.fm._id) })).status, 400);
  assert.equal((await H.call(A, 'post', '/api/users', { name: 'X', email: 'A1@T.IO', role: 'employee', leaderId: String(org.tlA._id) })).status, 409);
  assert.equal((await H.call(A, 'post', '/api/users', { name: 'X', email: 'x2@t.io', role: 'floor_manager' })).status, 400);
  assert.equal((await H.call(A, 'patch', `/api/users/${org.fm._id}`, { role: 'employee', leaderId: String(org.tlA._id) })).status, 400);   // original bug demoted FMs
  assert.equal((await H.call(A, 'patch', `/api/users/${org.admin._id}`, { role: 'employee', leaderId: String(org.tlA._id) })).status, 403);   // no self-demotion
});
test('admin cannot suspend an admin; users cannot escalate their own role through PATCH /users/me', async () => {
  assert.equal((await H.call(A, 'post', `/api/users/${org.admin._id}/status`, { status: 'Suspended' })).status, 403);
  await H.call(E_A1, 'patch', '/api/users/me', { name: 'Renamed', role: 'admin', status: 'Active' });
  const u = await M.User.findById(org.a1._id); assert.equal(u.role, 'employee'); assert.equal(u.name, 'Renamed');
});

/* ---------- bank ---------- */
const bank = { holder: 'Emp A1', name: 'SBI', account: '123456789012', ifsc: 'SBIN0001234' };
test('bank: first save locks; employee cannot edit; only admin can unlock; validation enforced', async () => {
  assert.equal((await H.call(E_A1, 'put', '/api/users/me/bank', { ...bank, account: '12' })).status, 400);
  assert.equal((await H.call(E_A1, 'put', '/api/users/me/bank', bank)).status, 200);
  assert.equal((await H.call(E_A1, 'put', '/api/users/me/bank', { ...bank, name: 'HDFC' })).body.error.code, 'BANK_LOCKED');
  assert.equal((await H.call(E_A1, 'patch', `/api/users/${org.a1._id}/bank`, { unlock: true })).status, 403);
  assert.equal((await H.call(A, 'patch', `/api/users/${org.a1._id}/bank`, { unlock: true })).status, 200);
  assert.equal((await H.call(E_A1, 'put', '/api/users/me/bank', { ...bank, name: 'HDFC' })).status, 200);       // unlocked -> editable once, relocks
  assert.equal((await H.call(E_A1, 'put', '/api/users/me/bank', bank)).status, 403);
});
test('bank IDOR: nobody but the owner or an admin can read bank details; stored encrypted; never in logs/lists', async () => {
  assert.equal((await H.call(E_A2, 'get', `/api/users/${org.a1._id}/bank`)).status, 403);
  assert.equal((await H.call(TLA, 'get', `/api/users/${org.a1._id}/bank`)).status, 403);
  assert.equal((await H.call(E_A1, 'get', '/api/users/me/bank')).body.data.details.account, '123456789012');
  assert.equal((await H.call(A, 'get', `/api/users/${org.a1._id}/bank`)).body.data.details.account, '123456789012');
  const raw = await M.User.collection.findOne({ _id: org.a1._id });
  assert.ok(!JSON.stringify(raw).includes('123456789012')); assert.match(raw.bank.enc, /^v1\./);
  const list = JSON.stringify((await H.call(A, 'get', '/api/users')).body);
  assert.ok(!list.includes('123456789012'));                                      // not in the default list
  assert.ok(JSON.stringify((await H.call(A, 'get', '/api/users').query({ includeBank: '1' })).body).includes('123456789012'));   // original Accounts page shows it to admin
  assert.ok(!JSON.stringify(await H.call(E_A2, 'get', '/api/users/crew')).includes('SBIN'));
});

/* ---------- packages / wallet ---------- */
test('wallet shows own package; deleting a package moves employees to Standard', async () => {
  const mine = (await H.call(E_A1, 'get', '/api/wallet/me')).body.data.package; assert.equal(mine.name, 'Standard');
  const prem = (await H.call(A, 'post', '/api/packages', { name: 'Gold', amount: 30000 })).body.data;
  await H.call(A, 'patch', `/api/users/${org.a1._id}`, { packageId: prem.id });
  assert.equal((await H.call(E_A1, 'get', '/api/wallet/me')).body.data.package.name, 'Gold');
  assert.equal((await H.call(A, 'delete', `/api/packages/${prem.id}`)).status, 200);
  assert.equal((await H.call(E_A1, 'get', '/api/wallet/me')).body.data.package.name, 'Standard');
  assert.equal((await H.call(A, 'post', '/api/packages', { name: 'Neg', amount: -5 })).status, 400);
});

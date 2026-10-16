'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: connect } = require('socket.io-client');
const H = require('./helpers');

let org; let M; let server; let url; let A; let TLA; let E_A1; let E_A2; let E_B1;
const cookieOf = (agent) => agent.cookieHeader;   // captured from Set-Cookie at login
const sockets = [];
const open = (cookie, origin = H.ORIGIN) => new Promise((resolve) => {
  const s = connect(url, { transports: ['websocket'], extraHeaders: { cookie: cookie || '', origin }, reconnection: false, forceNew: true });
  sockets.push(s); s.on('connect', () => resolve({ s, ok: true })); s.on('connect_error', (e) => resolve({ s, ok: false, e }));
});
const collect = (s, events) => { const got = []; for (const ev of events) s.on(ev, (p) => got.push({ ev, p })); return got; };
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const EVENTS = ['task:created', 'task:updated', 'task:deleted', 'activity:new', 'chat:message', 'track:assigned'];

test.before(async () => {
  ({ M } = await H.boot()); org = await H.seedOrg();
  server = http.createServer(H.app); require('../../src/socket').attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${server.address().port}`;
  // supertest agents need a base URL on the same server so cookies share a domain
  const mkAgent = async (email) => { const a = H.request.agent(server); const res = await a.post('/api/auth/login').set('X-Pulse-Client', '1').set('Origin', H.ORIGIN).send({ email, password: H.PASSWORD }); a.cookieHeader = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '); return a; };
  [A, TLA, E_A1, E_A2, E_B1] = await Promise.all(['admin', 'tla', 'a1', 'a2', 'b1'].map(mkAgent));
});
test.after(async () => { sockets.forEach((s) => s.close()); server.close(); await H.shutdown(); });

test('handshake: no cookie rejected; forged/garbage cookie rejected; foreign Origin rejected', async () => {
  assert.equal((await open('')).ok, false);
  assert.equal((await open(`${H.cfg.session.cookieName}=deadbeef`)).ok, false);
  assert.equal((await open(cookieOf(E_A1), 'https://evil.example')).ok, false);
});
test('rooms: task events reach admin, the assignee, their team leader; NOT other employees or other teams', async () => {
  const [sa, stl, se1, se2, sb1] = await Promise.all([A, TLA, E_A1, E_A2, E_B1].map((a) => open(cookieOf(a))));
  for (const x of [sa, stl, se1, se2, sb1]) assert.ok(x.ok, String(x.e));
  const g = { admin: collect(sa.s, EVENTS), tl: collect(stl.s, EVENTS), a1: collect(se1.s, EVENTS), a2: collect(se2.s, EVENTS), b1: collect(sb1.s, EVENTS) };
  const created = await H.call(A, 'post', '/api/tasks', { title: 'Realtime', assigneeId: String(org.a1._id), due: H.futureDate() });
  assert.equal(created.status, 201);
  await wait();
  const seen = (arr) => arr.filter((e) => e.ev === 'task:created').length;
  assert.equal(seen(g.admin), 1); assert.equal(seen(g.a1), 1); assert.equal(seen(g.tl), 1);
  assert.equal(seen(g.a2), 0); assert.equal(seen(g.b1), 0);                      // no cross-employee / cross-team leakage
  assert.ok(g.admin[0].p.eventId && g.admin[0].p.task.id);                      // dedupe id + persisted record
  assert.ok(await M.Task.findById(g.admin[0].p.task.id));                       // persisted BEFORE broadcast
});
test('clients cannot join rooms or forge events: arbitrary emits are ignored', async () => {
  const { s } = await open(cookieOf(E_B1)); const got = collect(s, EVENTS);
  s.emit('join', 'admin'); s.emit('join', `user:${org.a1._id}`); s.emit('task:created', { task: { id: 'x' } });
  await wait(); await H.call(E_A1, 'patch', `/api/tasks/${(await M.Task.findOne())._id}/status`, { notes: 'private' });
  await wait(); assert.equal(got.filter((e) => e.ev.startsWith('task')).length, 0);
});
test('chat broadcasts to everyone authenticated; presence lists who is online', async () => {
  const { s } = await open(cookieOf(E_A2)); const got = collect(s, ['chat:message', 'presence:update']);
  await H.call(A, 'post', '/api/chat', { text: 'live!' }); await wait();
  assert.ok(got.some((e) => e.ev === 'chat:message' && e.p.message.text === 'live!'));
  const pres = await new Promise((r) => s.emit('presence:request', r)); assert.ok(pres.online.length >= 1);
});
test('suspending a user disconnects their sockets immediately', async () => {
  const { s, ok } = await open(cookieOf(E_B1)); assert.ok(ok);
  const closed = new Promise((r) => s.on('disconnect', r));
  await H.call(A, 'post', `/api/users/${org.b1._id}/status`, { status: 'Suspended' });
  await Promise.race([closed, wait(2000).then(() => { throw new Error('socket stayed connected'); })]);
});

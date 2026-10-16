'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let org; let M;
test.before(async () => { ({ M } = await H.boot()); org = await H.seedOrg(); });
test.after(() => H.shutdown());

test('login: wrong password and unknown email give the SAME generic 401', async () => {
  const a = await H.call(H.request(H.app), 'post', '/api/auth/login', { email: 'a1@t.io', password: 'nope-nope' });
  const b = await H.call(H.request(H.app), 'post', '/api/auth/login', { email: 'ghost@t.io', password: 'nope-nope' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body.error, b.body.error);
});
test('login sets httpOnly cookie; /me works; response never contains password material', async () => {
  const res = await H.call(H.request(H.app), 'post', '/api/auth/login', { email: 'a1@t.io', password: H.PASSWORD });
  assert.equal(res.status, 200);
  const cookie = res.headers['set-cookie'].join(';'); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
  assert.ok(!JSON.stringify(res.body).match(/passwordHash|scrypt\$|recovery"?:\s*\[\{/));
});
test('CSRF: state-changing request without the client header is refused; foreign Origin refused', async () => {
  const noHeader = await H.request(H.app).post('/api/auth/login').send({ email: 'a1@t.io', password: H.PASSWORD });
  assert.equal(noHeader.status, 403);
  const evil = await H.request(H.app).post('/api/auth/login').set('X-Pulse-Client', '1').set('Origin', 'https://evil.example').send({ email: 'a1@t.io', password: H.PASSWORD });
  assert.equal(evil.status, 403);
});
test('suspended account cannot sign in even with the right password (decision Q2)', async () => {
  const res = await H.call(H.request(H.app), 'post', '/api/auth/login', { email: 'sus@t.io', password: H.PASSWORD });
  assert.equal(res.status, 403); assert.equal(res.body.error.code, 'ACCOUNT_SUSPENDED');
  assert.equal((await M.User.findById(org.sus._id)).status, 'Suspended');     // original silently re-activated
});
test('logout revokes the session server-side', async () => {
  const agent = await H.login('a1@t.io');
  assert.equal((await H.call(agent, 'get', '/api/auth/me')).status, 200);
  await H.call(agent, 'post', '/api/auth/logout');
  assert.equal((await H.call(agent, 'get', '/api/auth/me')).status, 401);
});
test('expired idle session is rejected', async () => {
  const agent = await H.login('a2@t.io');
  await M.Session.updateMany({ user: org.a2._id }, { idleExpiresAt: new Date(Date.now() - 1000) });
  assert.equal((await H.call(agent, 'get', '/api/auth/me')).status, 401);
});
test('suspending a user kills their live sessions', async () => {
  const victim = await H.login('b1@t.io'); const admin = await H.login('admin@t.io');
  assert.equal((await H.call(admin, 'post', `/api/users/${org.b1._id}/status`, { status: 'Suspended' })).status, 200);
  assert.equal((await H.call(victim, 'get', '/api/auth/me')).status, 401);
  await H.call(admin, 'post', `/api/users/${org.b1._id}/status`, { status: 'Active' });
});
test('account lockout after repeated failures, even with the right password afterwards', async () => {
  await M.User.updateOne({ _id: org.a2._id }, { $set: { failedLogins: 0 }, $unset: { lockedUntil: 1 } });
  for (let i = 0; i < H.cfg.auth.loginMaxFailures; i++) await H.call(H.request(H.app), 'post', '/api/auth/login', { email: 'a2@t.io', password: 'wrong-wrong' });
  const res = await H.call(H.request(H.app), 'post', '/api/auth/login', { email: 'a2@t.io', password: H.PASSWORD });
  assert.equal(res.status, 429); assert.equal(res.body.error.code, 'ACCOUNT_LOCKED');
  await M.User.updateOne({ _id: org.a2._id }, { $unset: { lockedUntil: 1 } });
});

/* ---------------- MFA ---------------- */
async function enableMfa(user) { await M.User.updateOne({ _id: user._id }, { 'mfa.enabled': true }); }
const startLogin = (email) => H.call(H.request(H.app), 'post', '/api/auth/login', { email, password: H.PASSWORD });

test('MFA: password alone does not create a session; correct 6-digit code does', async () => {
  await enableMfa(org.a1);
  const agent = H.request.agent(H.app);
  const r1 = await H.call(agent, 'post', '/api/auth/login', { email: 'a1@t.io', password: H.PASSWORD });
  assert.equal(r1.body.data.mfaRequired, true);
  assert.equal((await H.call(agent, 'get', '/api/auth/me')).status, 401);
  const code = r1.body.data.devPreview.code; assert.match(code, /^\d{6}$/);
  const r2 = await H.call(agent, 'post', '/api/auth/mfa/verify', { challengeId: r1.body.data.challengeId, code });
  assert.equal(r2.status, 200);
  assert.equal((await H.call(agent, 'get', '/api/auth/me')).status, 200);
  assert.ok((await M.User.findById(org.a1._id)).lastLoginAt);
  const replay = await H.call(H.request.agent(H.app), 'post', '/api/auth/mfa/verify', { challengeId: r1.body.data.challengeId, code });
  assert.equal(replay.status, 400);                                      // code is single-use
});
test('MFA: 5 wrong tries burn the challenge; the right code afterwards fails', async () => {
  const r1 = (await startLogin('a1@t.io')).body.data;
  for (let i = 0; i < H.cfg.auth.mfaMaxAttempts; i++) await H.call(H.request(H.app), 'post', '/api/auth/mfa/verify', { challengeId: r1.challengeId, code: '000000' });
  const res = await H.call(H.request(H.app), 'post', '/api/auth/mfa/verify', { challengeId: r1.challengeId, code: r1.devPreview.code });
  assert.equal(res.status, 400);
});
test('MFA: expired code rejected', async () => {
  const r1 = (await startLogin('a1@t.io')).body.data;
  await M.MfaChallenge.updateOne({ _id: r1.challengeId }, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await H.call(H.request(H.app), 'post', '/api/auth/mfa/verify', { challengeId: r1.challengeId, code: r1.devPreview.code })).status, 400);
});
test('MFA: code requests are throttled', async () => {
  await M.MfaChallenge.deleteMany({});
  let last; for (let i = 0; i < H.cfg.auth.mfaSendsPer15Min + 1; i++) last = await startLogin('a1@t.io');
  assert.equal(last.status, 429);
  await M.MfaChallenge.deleteMany({});
});
test('recovery codes: stored hashed, work once, canonicalised input', async () => {
  const agent = await (async () => { await M.MfaChallenge.deleteMany({}); const s = H.request.agent(H.app); const r = (await H.call(s, 'post', '/api/auth/login', { email: 'a1@t.io', password: H.PASSWORD })).body.data; await H.call(s, 'post', '/api/auth/mfa/verify', { challengeId: r.challengeId, code: r.devPreview.code }); return s; })();
  const gen = await H.call(agent, 'post', '/api/mfa/recovery-codes');
  assert.equal(gen.status, 200); const codes = gen.body.data.recoveryCodes; assert.equal(codes.length, 6);
  const stored = JSON.stringify((await M.User.findById(org.a1._id).select('+mfa.recovery')).mfa.recovery);
  for (const c of codes) assert.ok(!stored.includes(c));
  const ch1 = (await startLogin('a1@t.io')).body.data;
  const typed = codes[0].toLowerCase().replace(/-/g, ' ');
  assert.equal((await H.call(H.request.agent(H.app), 'post', '/api/auth/mfa/verify', { challengeId: ch1.challengeId, code: typed })).status, 200);
  await M.MfaChallenge.deleteMany({});
  const ch2 = (await startLogin('a1@t.io')).body.data;
  assert.equal((await H.call(H.request.agent(H.app), 'post', '/api/auth/mfa/verify', { challengeId: ch2.challengeId, code: codes[0] })).status, 400);   // used
});
test('trusted device: skips MFA next time; forgetting devices brings MFA back', async () => {
  await M.MfaChallenge.deleteMany({});
  const s = H.request.agent(H.app);
  const r = (await H.call(s, 'post', '/api/auth/login', { email: 'a1@t.io', password: H.PASSWORD })).body.data;
  await H.call(s, 'post', '/api/auth/mfa/verify', { challengeId: r.challengeId, code: r.devPreview.code, trust: true });
  await H.call(s, 'post', '/api/auth/logout');
  const again = await H.call(s, 'post', '/api/auth/login', { email: 'a1@t.io', password: H.PASSWORD });
  assert.equal(again.body.data.mfaRequired, false);
  await H.call(s, 'delete', '/api/devices');
  await H.call(s, 'post', '/api/auth/logout');
  assert.equal((await H.call(s, 'post', '/api/auth/login', { email: 'a1@t.io', password: H.PASSWORD })).body.data.mfaRequired, true);
  await M.MfaChallenge.deleteMany({}); await M.User.updateOne({ _id: org.a1._id }, { 'mfa.enabled': false });
});

/* ---------------- password reset ---------------- */
test('forgot: identical response for known and unknown email; link is single-use and expires', async () => {
  const known = await H.call(H.request(H.app), 'post', '/api/auth/forgot', { email: 'a2@t.io' });
  const unknown = await H.call(H.request(H.app), 'post', '/api/auth/forgot', { email: 'nobody@t.io' });
  assert.equal(known.body.data.message, unknown.body.data.message);
  const token = known.body.data.devPreview.link.split('#reset=')[1];
  assert.equal((await H.call(H.request(H.app), 'post', '/api/auth/reset', { token, password: '123' })).status, 400);  // too short does NOT burn the link
  const ok = await H.call(H.request(H.app), 'post', '/api/auth/reset', { token, password: 'NewPass#99' });
  assert.equal(ok.status, 200);
  assert.equal((await H.call(H.request(H.app), 'post', '/api/auth/reset', { token, password: 'Another#99' })).status, 400);   // single use
  assert.equal((await H.call(H.request(H.app), 'post', '/api/auth/login', { email: 'a2@t.io', password: 'NewPass#99' })).status, 200);
  const k2 = await H.call(H.request(H.app), 'post', '/api/auth/forgot', { email: 'a2@t.io' });
  await M.PasswordResetToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await H.call(H.request(H.app), 'post', '/api/auth/reset/verify', { token: k2.body.data.devPreview.link.split('#reset=')[1] })).status, 400);
});
test('admin-issued password forces a change before anything else is usable', async () => {
  const admin = await H.login('admin@t.io');
  const created = await H.call(admin, 'post', '/api/users', { name: 'New Hire', email: 'new@t.io', role: 'employee', leaderId: String(org.tlA._id) });
  assert.equal(created.status, 201); const temp = created.body.data.temporaryPassword; assert.ok(temp && temp.length >= 12);
  const s = await H.login('new@t.io', temp);
  assert.equal((await H.call(s, 'get', '/api/tasks')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await H.call(s, 'post', '/api/auth/password', { currentPassword: temp, newPassword: 'Mine#12345' })).status, 200);
  assert.equal((await H.call(s, 'get', '/api/tasks')).status, 200);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

let org; let M; let A; let FM; let TLA; let TLB; let E_A1; let E_A2; let E_B1; let project; let tracks;
test.before(async () => {
  ({ M } = await H.boot()); org = await H.seedOrg();
  [A, FM, TLA, TLB, E_A1, E_A2, E_B1] = await Promise.all(['admin', 'fm', 'tla', 'tlb', 'a1', 'a2', 'b1'].map((n) => H.login(`${n}@t.io`)));
  project = (await H.call(A, 'post', '/api/projects', { name: 'September set', description: 'Transcribe' })).body.data;
});
test.after(() => H.shutdown());

const upload = (agent, files, id = project.id) => {
  let r = agent.post(`/api/projects/${id}/tracks`).set('X-Pulse-Client', '1').set('Origin', H.ORIGIN);
  for (const f of files) r = r.attach('files', f.buf, f.name);
  return r;
};

test('only admin creates projects / uploads; FM+TL can list; employee cannot list projects', async () => {
  assert.equal((await upload(TLA, [{ buf: H.mp3Buffer(), name: 'a.mp3' }])).status, 403);
  assert.equal((await H.call(FM, 'get', '/api/projects')).status, 200);
  assert.equal((await H.call(E_A1, 'get', '/api/projects')).status, 403);
});
test('upload: real MP3 accepted; disguised non-MP3 rejected by CONTENT even with .mp3 name and audio/mpeg type', async () => {
  const ok = await upload(A, [{ buf: H.mp3Buffer(), name: 'good.mp3' }, { buf: Buffer.from('<?php echo 1; ?>'), name: 'evil.mp3' }, { buf: Buffer.from('MZ\x90\x00'), name: '../../x.mp3' }]);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.tracks.length, 1); assert.equal(ok.body.data.rejected.length, 2);
  const onlyBad = await upload(A, [{ buf: Buffer.from('hello world'), name: 'a.mp3' }]);
  assert.equal(onlyBad.status, 400); assert.equal(onlyBad.body.error.code, 'NO_VALID_FILES');
  const stored = await M.AudioTrack.findOne();
  assert.match(stored.storageKey, /^[a-f0-9]{32}\.mp3$/);                       // server-generated key, never the client name
  assert.ok(fs.existsSync(path.join(H.cfg.storage.dir, 'audio', stored.storageKey)));
  assert.equal(fs.readdirSync(path.join(H.cfg.storage.dir, 'tmp')).length, 0);  // temp files cleaned
});
test('batch of 100 MP3s is accepted; 101 is refused (original limit preserved)', async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ buf: H.mp3Buffer(64), name: `t${i}.mp3` }));
  const r100 = await upload(A, hundred); assert.equal(r100.status, 201); assert.equal(r100.body.data.tracks.length, 100);
  const r101 = await upload(A, [...hundred, { buf: H.mp3Buffer(64), name: 'extra.mp3' }]);
  assert.ok([400].includes(r101.status));
  assert.equal(fs.readdirSync(path.join(H.cfg.storage.dir, 'tmp')).length, 0);
  tracks = (await H.call(A, 'get', `/api/projects/${project.id}/tracks`)).body.data;
  assert.ok(tracks.length >= 101);
});
test('streaming: full 200, ranged 206, suffix range, 416 on bad range; private headers', async () => {
  const t = tracks[0];
  const full = await H.call(A, 'get', t.streamUrl).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert.equal(full.status, 200); assert.equal(full.headers['accept-ranges'], 'bytes'); assert.match(full.headers['cache-control'], /private/);
  assert.equal(full.headers['content-type'], 'audio/mpeg'); assert.equal(full.headers['x-content-type-options'], 'nosniff');
  const part = await H.call(A, 'get', t.streamUrl).set('Range', 'bytes=0-9').buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert.equal(part.status, 206); assert.equal(part.body.length, 10); assert.match(part.headers['content-range'], new RegExp(`^bytes 0-9/${full.body.length}$`));
  assert.equal((await H.call(A, 'get', t.streamUrl).set('Range', 'bytes=-5').buffer(true).parse((r, cb) => { r.on('data', () => {}); r.on('end', () => cb(null, null)); })).status, 206);
  assert.equal((await H.call(A, 'get', t.streamUrl).set('Range', `bytes=${full.body.length + 100}-`)).status, 416);
});
test('authorization: unauthenticated 401; unassigned employee 404; FM/TL can play; assigned employee can play', async () => {
  const t = tracks[1];
  assert.equal((await H.call(H.request(H.app), 'get', t.streamUrl)).status, 401);
  assert.equal((await H.call(E_A1, 'get', t.streamUrl)).status, 404);
  assert.equal((await H.call(TLB, 'get', t.streamUrl)).status, 200);
  assert.equal((await H.call(FM, 'get', t.streamUrl)).status, 200);
  assert.equal((await H.call(TLA, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id)] })).status, 200);
  assert.equal((await H.call(E_A1, 'get', t.streamUrl)).status, 200);
  assert.equal((await H.call(E_A2, 'get', t.streamUrl)).status, 404);          // other employee still blocked
});
test('assignment rules: scope enforced, no duplicates (idempotent), suspended rejected', async () => {
  const t = tracks[2];
  assert.equal((await H.call(TLA, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.b1._id)] })).status, 403);   // other team
  assert.equal((await H.call(TLA, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.sus._id)] })).status, 403);
  const first = await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id), String(org.a2._id)] });
  const second = await H.call(A, 'post', '/api/audio/assign', { trackIds: [t.id], assigneeIds: [String(org.a1._id), String(org.a2._id)] });
  assert.equal(first.body.data.added, 2); assert.equal(second.body.data.added, 0);
  assert.equal(await M.TrackAssignment.countDocuments({ track: t.id }), 2);
  assert.equal((await H.call(A, 'post', '/api/audio/assign', { trackIds: ['f'.repeat(24)], assigneeIds: [String(org.a1._id)] })).status, 404);
});
test('notebook (draft translation): owner-only; requires assignment; first save moves assigned -> in_progress; listing is private', async () => {
  const t = tracks[1];
  const saved = await H.call(E_A1, 'put', `/api/notebooks/${t.id}`, { text: '  I heard hello  ' });
  assert.equal(saved.status, 200); assert.equal(saved.body.data.status, 'in_progress'); assert.equal(saved.body.data.text, 'I heard hello');
  assert.equal((await H.call(E_A2, 'put', `/api/notebooks/${t.id}`, { text: 'x' })).status, 404);     // not assigned to A2 for this track
  assert.equal((await H.call(E_A2, 'get', `/api/notebooks/${t.id}`)).status, 404);
  assert.equal((await H.call(A, 'get', `/api/notebooks/${t.id}`)).status, 404);                         // not even admin: owner-only
  const mine = (await H.call(E_A1, 'get', '/api/audio/assigned')).body.data; assert.ok(mine.some((x) => x.track.id === t.id && x.status === 'in_progress'));
  await H.call(E_A1, 'put', `/api/notebooks/${t.id}`, { text: '   ' });                                  // clearing the draft does not revert status (one-way until submit)
  assert.equal((await H.call(E_A1, 'get', '/api/audio/assigned')).body.data.find((x) => x.track.id === t.id).status, 'in_progress');
  assert.ok(!(await H.call(E_B1, 'get', '/api/audio/assigned')).body.data.some((x) => x.track.id === t.id));
});
test('files persist on disk and metadata in the DB across an app restart (new app instance, same storage/DB)', async () => {
  const t = tracks[0]; const fresh = require('../../src/app').createApp();
  const agent = H.request.agent(fresh);
  await agent.post('/api/auth/login').set('X-Pulse-Client', '1').set('Origin', H.ORIGIN).send({ email: 'admin@t.io', password: H.PASSWORD });
  assert.equal((await agent.get(t.streamUrl).set('X-Pulse-Client', '1')).status, 200);
});

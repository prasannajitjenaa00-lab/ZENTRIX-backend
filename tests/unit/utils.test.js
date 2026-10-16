'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../../src/utils/crypto');
const { parseRange } = require('../../src/utils/range');
const { looksLikeMp3, safeMp3Name } = require('../../src/utils/mp3');
const d = require('../../src/utils/dates');
const { clean } = require('../../src/utils/sanitize');
const { escapeRegex, parsePage } = require('../../src/utils/pagination');

const FAST = { N: 1 << 10, r: 8, p: 1 }; // test-speed scrypt

test('password hash: verifies correct, rejects wrong, salts differ, never plaintext', async () => {
  const a = await c.hashPassword('Emp@123', FAST);
  const b = await c.hashPassword('Emp@123', FAST);
  assert.notEqual(a, b);
  assert.ok(!a.includes('Emp@123'));
  assert.equal(await c.verifyPassword('Emp@123', a), true);
  assert.equal(await c.verifyPassword('emp@123', a), false);
  assert.equal(await c.verifyPassword('x', 'garbage'), false);
  assert.equal(await c.verifyPassword('x', undefined), false);
});

test('production scrypt params round-trip', async () => {
  const h = await c.hashPassword('Admin@123');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await c.verifyPassword('Admin@123', h), true);
});

test('AES-GCM: round-trip, tamper and wrong key fail, random IV', () => {
  const key = c.parseKey('a'.repeat(64));
  const obj = { holder: 'Priya', account: '123456789012', ifsc: 'SBIN0001234' };
  const e1 = c.encryptJSON(obj, key); const e2 = c.encryptJSON(obj, key);
  assert.notEqual(e1, e2);
  assert.ok(!e1.includes('123456789012'));
  assert.deepEqual(c.decryptJSON(e1, key), obj);
  const parts = e1.split('.'); parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => c.decryptJSON(parts.join('.'), key));
  assert.throws(() => c.decryptJSON(e1, c.parseKey('b'.repeat(64))));
});

test('parseKey rejects short keys', () => {
  assert.throws(() => c.parseKey('abc'));
  assert.throws(() => c.parseKey(''));
  assert.equal(c.parseKey('0'.repeat(64)).length, 32);
});

test('OTP is 6 digits; recovery codes canonicalise (case, dashes, spaces)', () => {
  for (let i = 0; i < 200; i++) assert.match(c.otpCode(), /^\d{6}$/);
  const rc = c.recoveryCode();
  assert.match(rc, /^PULSE-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(c.normalizeCode(rc.toLowerCase()), c.normalizeCode(` ${rc} `));
  assert.equal(c.looksLikeRecovery(rc), true);
  assert.equal(c.looksLikeRecovery('123456'), false);
  assert.equal(new Set(Array.from({ length: 300 }, c.recoveryCode)).size, 300);
});

test('hmacHex is deterministic and pepper-dependent', () => {
  assert.equal(c.hmacHex('x', 'p1'), c.hmacHex('x', 'p1'));
  assert.notEqual(c.hmacHex('x', 'p1'), c.hmacHex('x', 'p2'));
});

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'invalid');
  assert.equal(parseRange('bytes=-0', 1000), 'invalid');
  assert.equal(parseRange('bytes=5-2', 1000), 'invalid');
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
});

test('looksLikeMp3 uses content, not extension', () => {
  assert.equal(looksLikeMp3(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00')), true);
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])), true); // MPEG1 L3 128k 44.1k
  assert.equal(looksLikeMp3(Buffer.from('<?php system($_GET[0]); ?>')), false);
  assert.equal(looksLikeMp3(Buffer.from('RIFF....WAVEfmt ')), false);
  assert.equal(looksLikeMp3(Buffer.from('MZ\x90\x00\x03\x00')), false);
  assert.equal(looksLikeMp3(Buffer.alloc(2)), false);
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0xf0, 0x64])), false); // bitrate 15 invalid
});

test('safeMp3Name strips paths and odd chars, keeps .mp3', () => {
  assert.equal(safeMp3Name('../../etc/passwd'), 'passwd.mp3');
  assert.equal(safeMp3Name('My Song (1).mp3'), 'My Song (1).mp3');
  assert.equal(safeMp3Name('a<b>c.MP3'), 'a_b_c.MP3');
  assert.equal(safeMp3Name(''), 'audio.mp3');
});

test('dates', () => {
  assert.equal(d.isISODate('2026-02-30'), false);
  assert.equal(d.isISODate('2026-09-15'), true);
  assert.equal(d.isISODate('15-09-2026'), false);
  assert.equal(d.addDays('2026-09-28', 7), '2026-10-05');
  assert.equal(d.addDays('2026-01-01', -1), '2025-12-31');
  // 2026-10-15 20:00 UTC is already 16 Oct in Kolkata
  assert.equal(d.todayISO('Asia/Kolkata', new Date('2026-10-15T20:00:00Z')), '2026-10-16');
  assert.equal(d.todayISO('UTC', new Date('2026-10-15T20:00:00Z')), '2026-10-15');
  assert.equal(d.isOverdue({ status: 'Pending', due: '2026-09-01' }, '2026-09-02'), true);
  assert.equal(d.isOverdue({ status: 'Completed', due: '2026-09-01' }, '2026-09-02'), false);
  assert.equal(d.isOverdue({ status: 'Pending', due: '2026-09-02' }, '2026-09-02'), false);
  assert.deepEqual(d.monthBounds('2026-09'), { from: '2026-09-01', to: '2026-09-31' });
  assert.equal(d.monthBounds('2026-13'), null);
});

test('sanitize drops operator and dotted keys, nested', () => {
  assert.deepEqual(clean({ a: 1, $ne: 1, 'x.y': 2, n: { $gt: 1, ok: [{ $where: 'x', z: 1 }] } }), { a: 1, n: { ok: [{ z: 1 }] } });
});

test('escapeRegex + parsePage', () => {
  assert.equal(new RegExp(escapeRegex('a.b*c(d)')).test('a.b*c(d)'), true);
  assert.equal(new RegExp(escapeRegex('a.b')).test('axb'), false);
  assert.deepEqual(parsePage({ page: '3', limit: '10' }), { page: 3, limit: 10, skip: 20 });
  assert.equal(parsePage({ limit: '99999' }).limit, 200);
  assert.equal(parsePage({ page: '-4' }).page, 1);
});

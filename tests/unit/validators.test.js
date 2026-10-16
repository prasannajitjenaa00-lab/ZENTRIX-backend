'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, rules: r, validateBank } = require('../../src/validators');

test('validate whitelists fields and coerces', () => {
  const out = validate({ title: '  Ship it ', progress: '150', evil: 'x', status: 'Pending' }, {
    title: r.string({ min: 1, max: 200 }),
    progress: r.int({ min: 0, max: 100, clamp: true }),
    status: r.oneOf(['Pending', 'Completed']),
  });
  assert.deepEqual(out, { title: 'Ship it', progress: 100, status: 'Pending' });
});

test('validate collects per-field errors', () => {
  try { validate({ status: 'Nope', due: '2026-02-31' }, { title: r.string({ min: 1 }), status: r.oneOf(['A']), due: r.isoDate() }); assert.fail(); }
  catch (e) { assert.equal(e.status, 400); assert.deepEqual(Object.keys(e.details).sort(), ['due', 'status', 'title']); }
});

test('rejects non-string input for strings (object injection)', () => {
  assert.throws(() => validate({ email: { $ne: '' } }, { email: r.string({ min: 1 }) }));
  assert.throws(() => validate({ id: { $gt: '' } }, { id: r.objectId() }));
});

test('email normalises', () => {
  assert.equal(validate({ e: ' Tina.R@Example.NET ' }, { e: r.email() }).e, 'tina.r@example.net');
  assert.throws(() => validate({ e: 'nope' }, { e: r.email() }));
});

test('idList dedupes and validates', () => {
  const id = 'a'.repeat(24);
  assert.deepEqual(validate({ ids: [id, id] }, { ids: r.idList() }).ids, [id]);
  assert.throws(() => validate({ ids: [] }, { ids: r.idList() }));
  assert.throws(() => validate({ ids: ['zzz'] }, { ids: r.idList() }));
});

test('bank rules match the original Profile form', () => {
  assert.deepEqual(validateBank({ holder: 'A', name: 'SBI', account: '123456', ifsc: 'sbin0001234' }),
    { holder: 'A', name: 'SBI', account: '123456', ifsc: 'SBIN0001234' });
  assert.throws(() => validateBank({ holder: 'A', name: 'SBI', account: '12345', ifsc: 'SBIN0001234' }));   // <6
  assert.throws(() => validateBank({ holder: 'A', name: 'SBI', account: '1234567890123456789012', ifsc: 'SBIN0001234' })); // >20
  assert.throws(() => validateBank({ holder: 'A', name: 'SBI', account: '12345a', ifsc: 'SBIN0001234' }));
  assert.throws(() => validateBank({ holder: 'A', name: 'SBI', account: '123456', ifsc: 'SBIN1001234' })); // 5th char must be 0
  assert.throws(() => validateBank({ holder: '', name: 'SBI', account: '123456', ifsc: 'SBIN0001234' }));
});

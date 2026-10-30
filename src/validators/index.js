'use strict';
/* Tiny schema validator: whitelists fields, coerces types, collects errors. */
const { AppError } = require('../utils/errors');
const { isISODate } = require('../utils/dates');

const OPTIONAL = Symbol('optional');
const wrap = (fn, optional) => { const f = (v, ctx) => fn(v, ctx); f[OPTIONAL] = optional; return f; };

const rules = {
  string: ({ min = 0, max = 500, optional = false, trim = true, lower = false, allowEmpty = false } = {}) => wrap((v) => {
    if (v === undefined || v === null) { if (optional) return undefined; throw new Error('Required.'); }
    if (typeof v !== 'string') throw new Error('Must be text.');
    let s = trim ? v.trim() : v;
    if (lower) s = s.toLowerCase();
    if (!s && !allowEmpty && !optional && min > 0) throw new Error('Required.');
    if (s.length < min) throw new Error(`Use at least ${min} characters.`);
    if (s.length > max) throw new Error(`Use at most ${max} characters.`);
    return s;
  }, optional),
  email: ({ optional = false } = {}) => wrap((v) => {
    if (v === undefined || v === null) { if (optional) return undefined; throw new Error('Required.'); }
    const s = String(v).trim().toLowerCase();
    if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('Enter a valid email address.');
    return s;
  }, optional),
  oneOf: (values, { optional = false } = {}) => wrap((v) => {
    if (v === undefined || v === null || v === '') { if (optional) return undefined; throw new Error('Required.'); }
    if (!values.includes(v)) throw new Error(`Must be one of: ${values.join(', ')}.`);
    return v;
  }, optional),
  enum: (values, opts) => rules.oneOf(values, opts),
  int: ({ min = -Infinity, max = Infinity, optional = false, clamp = false } = {}) => wrap((v) => {
    if (v === undefined || v === null || v === '') { if (optional) return undefined; throw new Error('Required.'); }
    let n = Number(v);
    if (!Number.isFinite(n)) throw new Error('Must be a number.');
    n = Math.trunc(n);
    if (clamp) return Math.max(min, Math.min(max, n));
    if (n < min || n > max) throw new Error(`Must be between ${min} and ${max}.`);
    return n;
  }, optional),
  number: ({ min = -Infinity, max = Infinity, optional = false } = {}) => wrap((v) => {
    if (v === undefined || v === null || v === '') { if (optional) return undefined; throw new Error('Required.'); }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Must be a number between ${min} and ${max}.`);
    return n;
  }, optional),
  bool: ({ optional = false } = {}) => wrap((v) => {
    if (v === undefined || v === null) { if (optional) return undefined; throw new Error('Required.'); }
    if (typeof v !== 'boolean') throw new Error('Must be true or false.');
    return v;
  }, optional),
  isoDate: ({ optional = false } = {}) => wrap((v) => {
    if (v === undefined || v === null || v === '') { if (optional) return undefined; throw new Error('Required.'); }
    if (!isISODate(v)) throw new Error('Use a real date as YYYY-MM-DD.');
    return String(v);
  }, optional),
  dateTime: ({ optional = false } = {}) => wrap((v) => {
    if (v === undefined || v === null || v === '') { if (optional) return undefined; throw new Error('Required.'); }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error('Use a valid date/time.');
    return d;
  }, optional),
  objectId: ({ optional = false, allowEmpty = false } = {}) => wrap((v) => {
    if (v === undefined || v === null) { if (optional) return undefined; throw new Error('Required.'); }
    if (v === '' && allowEmpty) return '';
    if (typeof v !== 'string' || !/^[a-f0-9]{24}$/i.test(v)) throw new Error('Invalid id.');
    return v;
  }, optional),
  idList: ({ min = 1, max = 500 } = {}) => wrap((v) => {
    if (!Array.isArray(v)) throw new Error('Must be a list.');
    const out = [...new Set(v.map(String))];
    if (out.length < min) throw new Error(`Select at least ${min}.`);
    if (out.length > max) throw new Error(`Select at most ${max}.`);
    if (!out.every((x) => /^[a-f0-9]{24}$/i.test(x))) throw new Error('Contains an invalid id.');
    return out;
  }, false),
};

/** validate(input, {field: rule}) -> cleaned object (only schema fields). Throws AppError 400 with per-field details. */
function validate(input, schema) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {}; const details = {};
  for (const [key, rule] of Object.entries(schema)) {
    try {
      const val = rule(src[key]);
      if (val !== undefined) out[key] = val;
    } catch (e) { details[key] = e.message; }
  }
  if (Object.keys(details).length) throw new AppError(400, 'VALIDATION_ERROR', 'Some fields need attention.', details);
  return out;
}

const ENUMS = {
  roles: ['admin', 'floor_manager', 'team_leader', 'employee'],
  statuses: ['Pending', 'In Progress', 'On Hold', 'Completed', 'Approved'],
  priorities: ['Low', 'Medium', 'High'],
  userStatus: ['Active', 'Suspended'],
};

/** Bank & KYC rules. Supports flexible fields for complete or partial KYC records. */
function validateBank(input) {
  const holder = String(input.holder || '').trim();
  const name = String(input.name || '').trim();
  const account = String(input.account || '').trim();
  const ifsc = String(input.ifsc || '').trim().toUpperCase();
  const upi = String(input.upi || '').trim();
  const aadharPan = String(input.aadharPan || '').trim();
  const details = {};

  if (account && (account.length < 6 || account.length > 30 || !/^\d+$/.test(account))) {
    details.account = 'Account number looks invalid.';
  }
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    details.ifsc = 'IFSC must be 11 characters (e.g. SBIN0001234).';
  }
  if (Object.keys(details).length) throw new AppError(400, 'VALIDATION_ERROR', 'Check the bank/KYC details.', details);
  return { holder, name, account, ifsc, upi, aadharPan };
}

module.exports = { validate, rules: rules, ENUMS, validateBank };

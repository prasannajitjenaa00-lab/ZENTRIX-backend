'use strict';
/* Password hashing (scrypt), keyed token hashing, AES-256-GCM field encryption. Node built-ins only. */
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const KEYLEN = 64;
const maxmem = (N, r) => 128 * N * r * 2;

async function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params.N, params.r) });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: maxmem(Number(N), Number(r)),
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const hmacHex = (value, pepper) => crypto.createHmac('sha256', pepper).update(String(value)).digest('hex');

function parseKey(value, label = 'key') {
  const v = String(value || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  const b = Buffer.from(v, 'base64');
  if (b.length === 32 && /^[A-Za-z0-9+/=]+$/.test(v)) return b;
  throw new Error(`${label} must be 32 bytes (64 hex chars or base64).`);
}

function encryptJSON(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
function decryptJSON(payload, key) {
  const [ver, iv, tag, ct] = String(payload).split('.');
  if (ver !== 'v1') throw new Error('Unsupported ciphertext version.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}

const otpCode = () => String(crypto.randomInt(100000, 1000000));
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function recoveryCode() {
  const pick = (n) => Array.from({ length: n }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `PULSE-${pick(4)}-${pick(4)}`;
}
/** Users may type dashes/spaces/lowercase. Compare on a canonical form. */
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const looksLikeRecovery = (raw) => /^PULSE[A-Z0-9]{8}$/.test(normalizeCode(raw));
function temporaryPassword() {
  const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => a[crypto.randomInt(a.length)]).join('') + '!7';
}

module.exports = {
  hashPassword, verifyPassword, randomToken, hmacHex, parseKey, encryptJSON, decryptJSON,
  otpCode, recoveryCode, normalizeCode, looksLikeRecovery, temporaryPassword, SCRYPT,
};

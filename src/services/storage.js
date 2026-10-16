'use strict';
/* Local-disk storage driver. Interface (put/stat/stream/remove) is small so an S3 driver can replace it later. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig } = require('../config/env');

const KEY_RE = /^[a-f0-9]{32}\.mp3$/;
const root = () => getConfig().storage.dir;
const audioDir = () => path.join(root(), 'audio');
const tmpDir = () => path.join(root(), 'tmp');

async function init() { await fsp.mkdir(audioDir(), { recursive: true }); await fsp.mkdir(tmpDir(), { recursive: true }); }
const newKey = () => `${crypto.randomBytes(16).toString('hex')}.mp3`;
function pathFor(key) {
  if (!KEY_RE.test(String(key))) throw new Error('Invalid storage key.');     // blocks traversal: keys are server-generated only
  return path.join(audioDir(), key);
}
async function readHead(file, n = 4096) {
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(n); const { bytesRead } = await fh.read(buf, 0, n, 0); return buf.subarray(0, bytesRead); } finally { await fh.close(); }
}
/** Move a validated temp upload into permanent storage and hash it. */
async function put(tmpPath) {
  const key = newKey();
  const hash = crypto.createHash('sha256');
  await new Promise((res, rej) => fs.createReadStream(tmpPath).on('data', (c) => hash.update(c)).on('end', res).on('error', rej));
  await fsp.rename(tmpPath, pathFor(key)).catch(async (e) => { if (e.code !== 'EXDEV') throw e; await fsp.copyFile(tmpPath, pathFor(key)); await fsp.unlink(tmpPath); });
  return { key, sha256: hash.digest('hex') };
}
const stat = (key) => fsp.stat(pathFor(key));
const stream = (key, opts) => fs.createReadStream(pathFor(key), opts);
const remove = (key) => fsp.unlink(pathFor(key)).catch(() => {});
const discard = (p) => fsp.unlink(p).catch(() => {});
module.exports = { init, tmpDir, audioDir, put, stat, stream, remove, discard, readHead, pathFor, KEY_RE };

#!/usr/bin/env node
'use strict';
/*
 * Zentrix Pulse: JSON -> MongoDB migration.
 *
 *   node scripts/migrate-from-json.js --source <dir>                 DRY RUN (default; touches nothing, needs no env)
 *   node scripts/migrate-from-json.js --source <dir> --apply         import (insert-only, never overwrites)
 *   node scripts/migrate-from-json.js --rollback <batchId> --yes     delete everything a batch inserted
 *
 * <dir> is the original app's `data/` folder (pulse-db.json, uploads/projects/*.mp3).
 * Original files are only ever READ. A checksummed backup copy is made before --apply.
 * Options: --batch <id>  --backup-dir <dir>  --no-force-change  (keep users' passwords usable without forcing a change)
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformLegacy } = require('../src/migration/transform');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const sha256File = (p) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const line = (s = '') => process.stdout.write(s + '\n');
const COLLECTIONS = ['User', 'Package', 'Task', 'ActivityLog', 'ChatMessage', 'Project', 'AudioTrack', 'TrackAssignment', 'NotebookEntry'];

function printReport(report) {
  line('\n== Source records -> to insert'); for (const k of Object.keys(report.counts.source)) line(`  ${k.padEnd(12)} ${String(report.counts.source[k]).padStart(5)}  ->  ${String(report.counts.toInsert[k]).padStart(5)}`);
  if (Object.keys(report.dropped).length) line(`\n== Deliberately NOT migrated (insecure/ephemeral)\n  ${JSON.stringify(report.dropped)}  (users re-issue recovery codes; devices re-verify MFA)`);
  if (report.repairs.length) { line(`\n== Repairs applied (${report.repairs.length})`); report.repairs.forEach((r) => line('  ~ ' + r)); }
  if (report.warnings.length) { line(`\n== Warnings (${report.warnings.length})`); report.warnings.forEach((r) => line('  ! ' + r)); }
  if (report.errors.length) { line(`\n== ERRORS: records that cannot be migrated (${report.errors.length})`); report.errors.forEach((r) => line('  x ' + r)); }
}

async function rollback(batchId) {
  if (!flag('yes')) { line(`Refusing to delete batch ${batchId} without --yes.`); process.exit(2); }
  const { getConfig } = require('../src/config/env'); const cfg = getConfig();
  const { connectDb, disconnectDb } = require('../src/config/db'); await connectDb(cfg.mongoUri);
  const M = require('../src/models'); const storage = require('../src/services/storage');
  const tracks = await M.AudioTrack.find({ migrationBatch: batchId }).select('storageKey').lean();
  for (const t of tracks) await storage.remove(t.storageKey);
  for (const name of [...COLLECTIONS].reverse()) { const r = await M[name].deleteMany({ migrationBatch: batchId }); line(`  ${name.padEnd(16)} deleted ${r.deletedCount}`); }
  await disconnectDb(); line('Rollback complete. Original JSON files were never modified.');
}

async function main() {
  if (opt('rollback')) return rollback(opt('rollback'));
  const source = path.resolve(opt('source') || '');
  const dbFile = path.join(source, 'pulse-db.json');
  if (!opt('source') || !fs.existsSync(dbFile)) { line('Usage: --source <dir containing pulse-db.json>'); process.exit(2); }
  const apply = flag('apply');
  const batchId = opt('batch') || `mig_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const legacy = JSON.parse(await fsp.readFile(dbFile, 'utf8'));
  line(`Zentrix Pulse migration — ${apply ? 'APPLY' : 'DRY RUN'} — batch ${batchId}\nsource: ${source}`);

  if (!apply) {   // pure: no DB, no env, no hashing cost
    const { docs, report } = await transformLegacy(legacy, { batchId, hashPassword: async () => 'DRY-RUN', encryptBank: () => 'DRY-RUN', forceChange: !flag('no-force-change') });
    printReport(report);
    const missing = docs.tracks.filter((t) => !fs.existsSync(path.join(source, 'uploads', 'projects', t.legacyFile)));
    if (missing.length) line(`\n  x ${missing.length} track file(s) missing on disk: ${missing.map((t) => t.legacyFile).join(', ')}`);
    line(`\nDry run finished. Nothing was written. ${report.errors.length || missing.length ? 'Fix the errors above (or accept the skips) before --apply.' : 'Re-run with --apply to import.'}`);
    return;
  }

  /* ---- APPLY ---- */
  const { getConfig } = require('../src/config/env'); const cfg = getConfig();
  const C = require('../src/utils/crypto');
  const { looksLikeMp3 } = require('../src/utils/mp3');
  const { connectDb, disconnectDb } = require('../src/config/db');
  const M = require('../src/models'); const storage = require('../src/services/storage');

  // 1) verified backup of the source (originals stay untouched)
  const backupDir = path.resolve(opt('backup-dir') || path.join('backups', batchId));
  await fsp.mkdir(backupDir, { recursive: true });
  const manifest = {};
  const walk = async (d, rel = '') => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); const r = path.join(rel, e.name); if (e.isDirectory()) await walk(p, r); else { const dest = path.join(backupDir, r); await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.copyFile(p, dest); manifest[r] = { sha256: await sha256File(p), bytes: (await fsp.stat(p)).size }; if ((await sha256File(dest)) !== manifest[r].sha256) throw new Error(`Backup verification failed for ${r}`); } } };
  await walk(source);
  await fsp.writeFile(path.join(backupDir, 'MANIFEST.json'), JSON.stringify({ batchId, source, files: manifest }, null, 2));
  line(`Backup verified: ${Object.keys(manifest).length} file(s) -> ${backupDir}`);

  await connectDb(cfg.mongoUri);
  await Promise.all(COLLECTIONS.map((n) => M[n].init()));
  await storage.init();

  // 2) existing legacy ids (insert-only: never overwrite)
  const existing = {};
  const maps = { users: ['User', 'legacyId'], tasks: ['Task', 'legacyId'], packages: ['Package', 'key'], activity: ['ActivityLog', 'legacyId'], chat: ['ChatMessage', 'legacyId'], projects: ['Project', 'legacyId'], tracks: ['AudioTrack', 'legacyId'], assignments: ['TrackAssignment', 'legacyId'], notebooks: ['NotebookEntry', 'legacyId'] };
  for (const [k, [model, field]] of Object.entries(maps)) existing[k] = new Map((await M[model].find({ [field]: { $exists: true, $ne: null } }).select(field).lean()).map((d) => [d[field], String(d._id)]));
  const emailClash = new Set((await M.User.find({ legacyId: { $exists: false } }).select('email').lean()).map((u) => u.email));

  const { docs, report } = await transformLegacy(legacy, { batchId, existing, forceChange: !flag('no-force-change'), hashPassword: (p) => C.hashPassword(p), encryptBank: (b) => C.encryptJSON(b, cfg.encKey) });
  docs.users = docs.users.filter((u) => { if (emailClash.has(u.email)) { report.errors.push(`user ${u.legacyId} <${u.email}>: email already used by a non-migrated account — skipped`); return false; } return true; });
  printReport(report);

  // 3) copy audio files (read-only on source), verify MP3 content, assign storage keys
  const tracksOk = [];
  for (const t of docs.tracks) {
    const file = path.join(source, 'uploads', 'projects', path.basename(t.legacyFile));
    if (!fs.existsSync(file)) { report.errors.push(`track ${t.legacyId}: file ${t.legacyFile} missing — skipped`); continue; }
    if (!looksLikeMp3(await storage.readHead(file))) { report.errors.push(`track ${t.legacyId}: ${t.legacyFile} is not a valid MP3 — skipped`); continue; }
    const tmp = path.join(storage.tmpDir(), `${crypto.randomUUID()}.part`);
    await fsp.copyFile(file, tmp);
    const { key, sha256 } = await storage.put(tmp);
    const { legacyFile, ...rest } = t; tracksOk.push({ ...rest, storageKey: key, sha256, size: (await fsp.stat(storage.pathFor(key))).size });
  }
  docs.tracks = tracksOk;
  const okTrackIds = new Set(tracksOk.map((t) => String(t._id)));
  docs.assignments = docs.assignments.filter((a) => okTrackIds.has(String(a.track)) || existing.tracks.size);
  docs.notebooks = docs.notebooks.filter((n) => okTrackIds.has(String(n.track)) || existing.tracks.size);

  // 4) insert in dependency order (no multi-doc transaction: standalone mongod has none; --rollback covers failures)
  const order = [['users', 'User'], ['packages', 'Package'], ['tasks', 'Task'], ['activity', 'ActivityLog'], ['chat', 'ChatMessage'], ['projects', 'Project'], ['tracks', 'AudioTrack'], ['assignments', 'TrackAssignment'], ['notebooks', 'NotebookEntry']];
  const inserted = {};
  try {
    // packages first: users reference them
    for (const [k, model] of [order[1], order[0], ...order.slice(2)]) { if (!docs[k].length) { inserted[k] = 0; continue; } const res = await M[model].insertMany(docs[k], { ordered: true }); inserted[k] = res.length; }
  } catch (e) {
    line(`\nINSERT FAILED: ${e.message}\nRun:  node scripts/migrate-from-json.js --rollback ${batchId} --yes   then fix the cause and retry.`);
    await disconnectDb(); process.exit(1);
  }

  // 5) validate: counts + relationships
  line('\n== Validation');
  let bad = 0;
  const check = (label, ok, detail = '') => { line(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!ok) bad++; };
  for (const [k, model] of order) check(`${model} count for batch = ${inserted[k]}`, (await M[model].countDocuments({ migrationBatch: batchId })) === (docs[k].length));
  const batchUsers = await M.User.find({ migrationBatch: batchId }).select('role leader floor package passwordHash').lean();
  const allUserIds = new Set((await M.User.find().select('_id').lean()).map((u) => String(u._id)));
  check('every migrated employee has a team leader', batchUsers.filter((u) => u.role === 'employee').every((u) => u.leader && allUserIds.has(String(u.leader))));
  check('no migrated user lacks a password hash', (await M.User.countDocuments({ migrationBatch: batchId, passwordHash: { $not: /^scrypt\$/ } })) === 0);
  const tasks = await M.Task.find({ migrationBatch: batchId }).select('assignee').lean();
  check('every migrated task points at an existing user', tasks.every((t) => allUserIds.has(String(t.assignee))));
  check('no plaintext "password" field persisted', (await M.User.collection.countDocuments({ password: { $exists: true } })) === 0);
  const unexpected = report.errors.length;
  line(`\n${bad ? 'VALIDATION FAILED' : 'Validation passed'}. ${unexpected} source record(s) were skipped (see ERRORS above).`);
  line(`Original JSON files are untouched. Keep them (and ${backupDir}) until you have verified the app on MongoDB.`);
  line(`Rollback if needed:  node scripts/migrate-from-json.js --rollback ${batchId} --yes`);
  await disconnectDb(); process.exit(bad ? 1 : 0);
}
main().catch((e) => { process.stderr.write(`Migration failed: ${e.stack || e.message}\n`); process.exit(1); });

#!/usr/bin/env node
'use strict';
/*
 * Backfill missing `joined` date and `package` on employee accounts — the two fields
 * the Projects Contract page falls back on when they're absent (migrated/legacy accounts
 * can be missing either). Does not touch project/track assignment: having no audio
 * assigned yet is a normal state, not missing data, so it is left alone.
 *
 *   node scripts/backfill-employee-data.js                 DRY RUN (default; prints what would change)
 *   node scripts/backfill-employee-data.js --apply         actually writes the changes
 *
 * `joined` is set from the account's own createdAt (its real signup date) — never today's
 * date — so it stays truthful for every employee, no matter when this script runs.
 */
const { getConfig } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { User, Package } = require('../src/models');
const { todayISO, isISODate } = require('../src/utils/dates');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const line = (s = '') => process.stdout.write(s + '\n');

async function defaultPackageId() {
  const p = (await Package.findOne({ key: 'standard' }).select('_id')) || (await Package.findOne().sort({ createdAt: 1 }).select('_id'));
  return p?._id || null;
}

async function main() {
  const cfg = getConfig();
  await connectDb(cfg.mongoUri);
  line(`Backfill employee data — ${apply ? 'APPLY' : 'DRY RUN'}`);

  const employees = await User.find({ role: 'employee' });
  const fallbackPkgId = await defaultPackageId();

  let joinedFixed = 0;
  let packageFixed = 0;

  for (const u of employees) {
    let changed = false;

    if (!isISODate(u.joined)) {
      const fromCreated = u.createdAt ? todayISO(cfg.timezone, u.createdAt) : todayISO(cfg.timezone);
      line(`  ~ ${u.name} (${u.email}): joined -> ${fromCreated}`);
      if (apply) { u.joined = fromCreated; changed = true; }
      joinedFixed++;
    }

    if (!u.package && fallbackPkgId) {
      line(`  ~ ${u.name} (${u.email}): package -> standard`);
      if (apply) { u.package = fallbackPkgId; changed = true; }
      packageFixed++;
    }

    if (apply && changed) await u.save();
  }

  line(`\n== Summary (${apply ? 'applied' : 'dry run — nothing written'})`);
  line(`  joined backfilled:  ${joinedFixed} / ${employees.length} employees`);
  line(`  package backfilled: ${packageFixed} / ${employees.length} employees`);
  if (!apply && (joinedFixed || packageFixed)) line('\nRun again with --apply to write these changes.');

  await disconnectDb();
}

main().catch((err) => {
  console.error('Backfill error:', err);
  process.exit(1);
});

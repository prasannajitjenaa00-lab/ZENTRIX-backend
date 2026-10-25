#!/usr/bin/env node
'use strict';
/**
 * Developer seed script for Zentrix Pulse.
 * Safe, idempotent, and non-destructive:
 *  - Explicitly refuses to run in production environments
 *  - Adds default wallet packages only if they are genuinely missing without duplicating
 *  - Creates Dummy Admin (dummy.admin@local.test) only if it does not already exist
 *  - Creates Dummy Employee (dummy.employee@local.test) only if it does not already exist
 *  - Preserves all existing records, users, passwords, roles, status, and MFA settings
 *  - NEVER deletes or clears any tasks, projects, chat messages, activity logs, or user accounts
 */
const { getConfig } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { User, Package } = require('../src/models');
const { DEFAULTS } = require('../src/services/packages');
const C = require('../src/utils/crypto');
const { todayISO } = require('../src/utils/dates');

const DEV_PASSWORD = '7790052789';

async function seed() {
  const cfg = getConfig();

  // Explicit safety check: never run against production
  if (process.env.NODE_ENV === 'production' || cfg.isProd) {
    console.error('ERROR: Refusing to run seed-dev.js in a production environment.');
    process.exit(1);
  }

  await connectDb(cfg.mongoUri);
  console.log('Connected to MongoDB. Starting safe development seed...');

  // 1. Packages: Add default wallet packages only if genuinely missing
  let packagesCreated = 0;
  for (const defPkg of DEFAULTS) {
    const exists = await Package.findOne({
      $or: [
        { key: defPkg.key },
        { name: defPkg.name },
      ],
    });
    if (!exists) {
      await Package.create({ ...defPkg, currency: '₹' });
      packagesCreated++;
      console.log(`+ Created default package: ${defPkg.name} (${defPkg.key})`);
    }
  }
  if (packagesCreated === 0) {
    console.log('= Default packages already present — no new packages added.');
  }

  const standardPkg = (await Package.findOne({ key: 'standard' })) || (await Package.findOne());

  const passwordHash = await C.hashPassword(DEV_PASSWORD);
  const today = todayISO(cfg.timezone);

  // 2. Helper to safely ensure user exists without modifying existing records
  async function ensureUser(spec) {
    const email = spec.email.toLowerCase();
    const existing = await User.findOne({ email });
    if (existing) {
      console.log(`= User ${existing.name} (${existing.email}) already exists. Preserved without changes.`);
      return { user: existing, created: false };
    }

    const created = await User.create({
      ...spec,
      email,
      passwordHash,
      visiblePasswordEnc: C.encryptJSON({ password: DEV_PASSWORD }, cfg.encKey),
      passwordChangedAt: new Date(),
      passwordChangedBy: 'seed-dev',
      mustChangePassword: false,
      status: 'Active',
      joined: today,
      mfa: { enabled: false },
    });
    console.log(`+ Created ${created.name} (${created.email}) [${created.role}]`);
    return { user: created, created: true };
  }

  // 3. Ensure Admin and Employee exist (skips if already present)
  const adminResult = await ensureUser({
    name: 'Dummy Admin',
    email: 'dummy.admin@local.test',
    role: 'admin',
    department: 'Management',
    title: 'Workspace Admin',
  });

  const employeeResult = await ensureUser({
    name: 'Dummy Employee',
    email: 'dummy.employee@local.test',
    role: 'employee',
    department: 'Operations',
    title: 'Employee',
    package: standardPkg?._id,
  });

  console.log('\n--- Seed Complete (Safe & Non-Destructive) ---');
  console.log(`  Admin:    ${adminResult.user.email} | ${adminResult.created ? `Created (Password: ${DEV_PASSWORD})` : 'Preserved (Existing account unchanged)'}`);
  console.log(`  Employee: ${employeeResult.user.email} | ${employeeResult.created ? `Created (Password: ${DEV_PASSWORD})` : 'Preserved (Existing account unchanged)'}`);
  console.log('-----------------------------------------------\n');

  await disconnectDb();
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});

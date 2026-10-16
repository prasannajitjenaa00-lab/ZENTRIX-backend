#!/usr/bin/env node
'use strict';
/**
 * Developer seed script for Zentrix Pulse.
 * Seeds ONLY:
 *  - 4 default wallet packages
 *  - Dummy Admin (dummy.admin@local.test)
 *  - Dummy Employee (dummy.employee@local.test)
 *
 * Password for both: 7790052789 (MFA disabled, no forced change).
 * Does NOT add tasks, projects, chat, or extra roles.
 */
const { getConfig } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { User, Package, Task, Project, ChatMessage, ActivityLog } = require('../src/models');
const { DEFAULTS } = require('../src/services/packages');
const C = require('../src/utils/crypto');
const { todayISO } = require('../src/utils/dates');

const DEV_PASSWORD = '7790052789';

async function seed() {
  const cfg = getConfig();
  await connectDb(cfg.mongoUri);
  console.log('Connected to MongoDB. Starting minimal seed (Admin + Employee only)...');

  // 1. Packages
  let packages = await Package.find();
  if (packages.length === 0) {
    packages = await Package.insertMany(DEFAULTS.map((p) => ({ ...p, currency: '₹' })));
    console.log(`Created ${packages.length} default packages.`);
  }
  const standardPkg = packages.find((p) => p.key === 'standard') || packages[0];

  const passwordHash = await C.hashPassword(DEV_PASSWORD);
  const today = todayISO(cfg.timezone);

  // Helper to upsert user
  async function upsertUser(spec) {
    let u = await User.findOne({ email: spec.email.toLowerCase() });
    if (!u) {
      u = await User.create({
        ...spec,
        email: spec.email.toLowerCase(),
        passwordHash,
        passwordChangedAt: new Date(),
        passwordChangedBy: 'seed-dev',
        mustChangePassword: false,
        status: 'Active',
        joined: today,
        mfa: { enabled: false },
      });
      console.log(`+ Created ${spec.name} (${spec.email}) [${spec.role}]`);
    } else {
      u.passwordHash = passwordHash;
      u.mustChangePassword = false;
      u.status = 'Active';
      if (spec.role) u.role = spec.role;
      if (spec.package) u.package = spec.package;
      u.leader = undefined;
      u.floor = undefined;
      u.mfa = { enabled: false };
      await u.save();
      console.log(`* Updated ${u.name} (${u.email}) [${u.role}]`);
    }
    return u;
  }

  // 2. Clean up any extra users or sample items added previously
  const extraEmails = ['floor.manager@local.test', 'dummy.leader@local.test', 'priya.sharma@local.test'];
  const delUsers = await User.deleteMany({ email: { $in: extraEmails } });
  if (delUsers.deletedCount > 0) {
    console.log(`- Removed ${delUsers.deletedCount} extra dev account(s).`);
  }

  // Remove any sample tasks, projects, chat, activity logs
  await Task.deleteMany({});
  await Project.deleteMany({});
  await ChatMessage.deleteMany({});
  await ActivityLog.deleteMany({});
  console.log('- Cleared sample tasks, projects, chat messages, and activity logs.');

  // 3. Upsert ONLY Admin and Employee
  const admin = await upsertUser({
    name: 'Dummy Admin',
    email: 'dummy.admin@local.test',
    role: 'admin',
    department: 'Management',
    title: 'Workspace Admin',
  });

  const employee = await upsertUser({
    name: 'Dummy Employee',
    email: 'dummy.employee@local.test',
    role: 'employee',
    department: 'Operations',
    title: 'Employee',
    package: standardPkg._id,
  });

  console.log('\n--- Seed Complete (Admin and Employee only) ---');
  console.log(`  Admin:    ${admin.email}    | Password: ${DEV_PASSWORD}`);
  console.log(`  Employee: ${employee.email} | Password: ${DEV_PASSWORD}`);
  console.log('-----------------------------------------------\n');

  await disconnectDb();
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});

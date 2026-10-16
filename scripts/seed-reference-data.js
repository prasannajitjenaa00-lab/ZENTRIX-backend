#!/usr/bin/env node
'use strict';
/* Creates the 4 default wallet packages (none/starter/standard/premium) if — and only if — no packages exist. NO users are created. */
const { getConfig } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { Package } = require('../src/models');
const { DEFAULTS } = require('../src/services/packages');
(async () => {
  await connectDb(getConfig().mongoUri);
  if (await Package.countDocuments()) console.log('Packages already exist — nothing to do.');
  else { await Package.insertMany(DEFAULTS.map((p) => ({ ...p, currency: '₹' }))); console.log(`Created ${DEFAULTS.length} default packages.`); }
  await disconnectDb();
})().catch((e) => { console.error(e.message); process.exit(1); });

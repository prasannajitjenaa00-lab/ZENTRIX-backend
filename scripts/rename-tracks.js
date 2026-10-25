'use strict';
const { connectDb, disconnectDb } = require('../src/config/db');
const { getConfig } = require('../src/config/env');
const { AudioTrack } = require('../src/models');

(async () => {
  const cfg = getConfig();
  await connectDb(cfg.mongoUri);
  const tracks = await AudioTrack.find().sort({ createdAt: 1 });
  console.log('Found tracks:', tracks.length);
  for (let i = 0; i < tracks.length; i++) {
    const newName = `${i + 1} MP3`;
    console.log(`${tracks[i].originalName} -> ${newName}`);
    await AudioTrack.updateOne({ _id: tracks[i]._id }, { $set: { originalName: newName } });
  }
  await disconnectDb();
  console.log('Done renaming existing tracks.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

'use strict';
const mongoose = require('mongoose');
const { logger } = require('./logger');

async function tryConnect(uri, timeoutMs = 8000) {
  return await mongoose.connect(uri, {
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
    maxPoolSize: 20,
  });
}

async function connectDb(uri) {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.warn('mongo.disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo.reconnected'));

  let attempts = 0;
  while (true) {
    attempts++;
    try {
      // 1. Try configured Atlas URI
      await tryConnect(uri, 8000);
      logger.info('mongo.connected', { uri: uri.replace(/:([^:@]+)@/, ':****@') });
      return mongoose.connection;
    } catch (err) {
      logger.warn('mongo.connection_attempt_failed', { attempt: attempts, msg: err.message });

      // 2. Try local fallback if Atlas failed
      try {
        const localUri = 'mongodb://127.0.0.1:27017/zentrix_pulse';
        await tryConnect(localUri, 2500);
        logger.info('mongo.connected_local_fallback', { localUri });
        return mongoose.connection;
      } catch (localErr) {
        // Local not running
      }

      logger.error('mongo.waiting_for_atlas_whitelist', {
        reason: 'Atlas server selection timed out. Your current public IP is not whitelisted in MongoDB Atlas.',
        fix: 'Go to MongoDB Atlas -> Network Access -> Add IP Address -> Allow Access from Anywhere (0.0.0.0/0).',
        retryingInSeconds: 5,
      });

      // Wait 5 seconds and retry automatically instead of crashing
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

const disconnectDb = () => mongoose.disconnect();
const dbReady = () => mongoose.connection.readyState === 1;

module.exports = { connectDb, disconnectDb, dbReady };

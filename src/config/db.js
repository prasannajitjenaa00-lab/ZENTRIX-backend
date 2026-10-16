'use strict';
const mongoose = require('mongoose');
const { logger } = require('./logger');

async function connectDb(uri) {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.warn('mongo.disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo.reconnected'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  logger.info('mongo.connected');
  return mongoose.connection;
}
const disconnectDb = () => mongoose.disconnect();
const dbReady = () => mongoose.connection.readyState === 1;
module.exports = { connectDb, disconnectDb, dbReady };

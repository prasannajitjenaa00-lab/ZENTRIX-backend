'use strict';
const { logger } = require('../config/logger');
const { getConfig } = require('../config/env');

const notFoundHandler = (req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = err.status || 500; let code = err.code; let message = err.message; let details = err.details;
  if (err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR';
    message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the allowed size.' : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Too many files in one upload.' : 'Upload failed.';
  } else if (err.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large.'; }
  else if (err.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; message = 'Malformed JSON.'; }
  else if (err.name === 'ValidationError' && err.errors) { status = 400; code = 'VALIDATION_ERROR'; message = 'Some fields need attention.'; details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message])); }
  else if (err.name === 'CastError') { status = 404; code = 'NOT_FOUND'; message = 'Not found.'; }
  else if (err.code === 11000) { status = 409; code = 'DUPLICATE'; message = 'That record already exists.'; }

  if (status >= 500) {
    logger.error('request.failed', { method: req.method, path: req.path, err });   // logger redacts sensitive keys; stack never sent to client
    code = 'INTERNAL'; message = 'Something went wrong on our side.'; details = undefined;
  } else if (status === 429 || status === 401 || status === 403) logger.warn('request.denied', { method: req.method, path: req.path, status, code });
  const body = { ok: false, error: { code: code || 'ERROR', message } };
  if (details) body.error.details = details;
  if (!getConfig().isProd && status >= 500 && err.stack) body.error.debug = String(err.stack).split('\n').slice(0, 3);
  res.status(status).json(body);
}
module.exports = { errorHandler, notFoundHandler };

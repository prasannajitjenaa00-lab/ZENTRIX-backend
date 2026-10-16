'use strict';
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}
const bad = (message, details) => new AppError(400, 'VALIDATION_ERROR', message || 'Invalid request.', details);
const unauthorized = (message = 'Sign in required.') => new AppError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'You do not have access to that.') => new AppError(403, 'FORBIDDEN', message);
const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);
const conflict = (message, code = 'CONFLICT') => new AppError(409, code, message);
module.exports = { AppError, bad, unauthorized, forbidden, notFound, conflict };

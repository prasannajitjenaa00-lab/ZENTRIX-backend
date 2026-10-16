'use strict';
const ok = (res, data, meta, status = 200) => res.status(status).json({ ok: true, data, ...(meta ? { meta } : {}) });
module.exports = { ok };

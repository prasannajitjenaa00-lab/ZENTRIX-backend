'use strict';
/** Strip Mongo operator keys ($…) and dotted keys from untrusted objects (defence in depth; validators also whitelist). */
function clean(v, depth = 0) {
  if (depth > 8) return undefined;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      out[k] = clean(val, depth + 1);
    }
    return out;
  }
  return v;
}
module.exports = { clean };

'use strict';
/** Parse one HTTP Range header. Returns {start,end} | null (absent/ignored) | 'invalid' (answer 416). */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // multi-range / malformed: ignore, serve full body
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start; let end;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
module.exports = { parseRange };

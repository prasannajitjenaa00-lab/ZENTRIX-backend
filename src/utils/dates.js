'use strict';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isISODate(s) {
  if (!ISO.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** Calendar date in a timezone as YYYY-MM-DD. */
function todayISO(tz = 'Asia/Kolkata', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isOverdue = (task, today) => task.status !== 'Completed' && !!task.due && task.due < today;
/** 'YYYY-MM' -> bounds usable with string comparison on ISO dates. */
function monthBounds(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym))) return null;
  return { from: `${ym}-01`, to: `${ym}-31` };
}
module.exports = { isISODate, todayISO, addDays, isOverdue, monthBounds };

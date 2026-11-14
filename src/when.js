'use strict';
// "10m", "1h30m", "5pm", "17:30", "tomorrow 9am" -> a time. For /remind, /later and /dnd.

const UNIT = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
const UNIT_RE = /^(\d+(?:\.\d+)?)(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i;
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

/**
 * Read a time from the start of some words. Returns { at, rest } - `rest` being
 * the words after the time - or null if they don't start with one.
 */
function parse(words, now = Date.now()) {
  const list = String(words || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  if (/^in$/i.test(list[0]) && list.length > 1) i++; // "in 10 minutes"
  // durations: 10m, 1h30m, "1 h 30 m", "10 minutes", "an hour"
  let ms = 0;
  let took = i;
  while (took < list.length) {
    let word = list[took].toLowerCase();
    let used = 1;
    if (/^(a|an)$/.test(word) && list[took + 1] && /^(hour|minute|day)s?$/i.test(list[took + 1])) { word = '1' + list[took + 1]; used = 2; }
    else if (/^\d+(\.\d+)?$/.test(word) && list[took + 1] && UNIT_RE.test('1' + list[took + 1])) { word += list[took + 1]; used = 2; }
    const parts = word.match(/\d+(?:\.\d+)?[a-z]+/g);
    if (!parts || parts.join('') !== word || !parts.every((p) => UNIT_RE.test(p))) break;
    for (const p of parts) {
      const m = UNIT_RE.exec(p);
      ms += Number(m[1]) * UNIT[m[2][0].toLowerCase()];
    }
    took += used;
  }
  if (took > i && ms > 0) return { at: now + Math.round(ms), rest: list.slice(took).join(' ') };

  // clock times: 5pm, 5:30pm, 17:30, "tomorrow", "tomorrow 9am", "at 5pm"
  i = 0;
  let tomorrow = false;
  if (/^at$/i.test(list[i])) i++;
  if (/^(tomorrow|tmrw|tmr)$/i.test(list[i])) { tomorrow = true; i++; }
  if (/^at$/i.test(list[i])) i++;
  let clock = list[i] && CLOCK_RE.exec(list[i]);
  let used = 1;
  if (list[i] && list[i + 1] && /^(am|pm)$/i.test(list[i + 1]) && /^\d{1,2}(:\d{2})?$/.test(list[i])) { clock = CLOCK_RE.exec(list[i] + list[i + 1]); used = 2; }
  if (clock && (clock[2] || clock[3])) {
    let h = Number(clock[1]);
    const min = Number(clock[2] || 0);
    const ampm = (clock[3] || '').toLowerCase();
    if (ampm && (h < 1 || h > 12)) return null;
    if (h > 23 || min > 59) return null;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (tomorrow) d.setDate(d.getDate() + 1);
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1); // 9am when it's 10am: tomorrow
    return { at: d.getTime(), rest: list.slice(i + used).join(' ') };
  }
  if (tomorrow) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return { at: d.getTime(), rest: list.slice(i).join(' ') };
  }
  return null;
}

/** "in 10m (3:45 PM)" / "tomorrow at 9:00 AM" */
function describe(at, now = Date.now()) {
  const d = new Date(at);
  const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const ms = at - now;
  if (ms < 0) return `${span(-ms)} ago`;
  const today = new Date(now).toDateString() === d.toDateString();
  const tmrw = new Date(now + 86400000).toDateString() === d.toDateString();
  if (ms < 6 * 3600000) return `in ${span(ms)} (${clock})`;
  if (today) return `at ${clock}`;
  if (tmrw) return `tomorrow at ${clock}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${clock}`;
}

/** 90061000 -> "1d 1h" ; 125000 -> "2m 5s" */
function span(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `${h}h${m ? ` ${m}m` : ''}`;
  if (m) return `${m}m${s % 60 && m < 10 ? ` ${s % 60}s` : ''}`;
  return `${s}s`;
}

module.exports = { parse, describe, span };

'use strict';
// Text helpers that don't depend on the terminal.

/**
 * Make text from the network safe to show in a terminal: no escape sequences,
 * no control characters, no direction-override tricks, no towering "zalgo".
 */
const EMOJI = {
  smile: '😄', grin: '😁', joy: '😂', lol: '😂', wink: '😉', cool: '😎', thinking: '🤔', cry: '😢', sob: '😭', angry: '😠',
  heart: '❤️', fire: '🔥', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', wave: '👋', clap: '👏', pray: '🙏', ok: '👌',
  party: '🎉', tada: '🎉', eyes: '👀', skull: '💀', 100: '💯', star: '⭐', check: '✅', x: '❌', rocket: '🚀', penguin: '🐧',
  pizza: '🍕', coffee: '☕', sleep: '😴', shrug: '🤷', facepalm: '🤦', sweat: '😅', hug: '🤗', sunglasses: '😎', sad: '🙁', happy: '🙂',
};

/** ":fire:" -> 🔥 for the words in the list above; anything else is left exactly as typed. */
function emojify(s) {
  return String(s).replace(/:([a-z0-9+-]{1,12}):/g, (all, name) => (Object.prototype.hasOwnProperty.call(EMOJI, name) ? EMOJI[name] : all));
}

function cleanText(s) {
  if (typeof s !== 'string') return '';
  let t = s.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(/\t/g, '  ');
  t = t.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
  t = t.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  t = t.replace(/(\p{M}{3})\p{M}+/gu, '$1');
  t = t.replace(/[ ]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  return t.replace(/^\n+/, '').replace(/\s+$/, '');
}

/** '2:05 PM' (mode '12h') or '14:05' (mode '24h'). */
function clock(ts, mode = '12h') {
  const d = new Date(ts);
  const m = String(d.getMinutes()).padStart(2, '0');
  if (mode === '24h') return `${String(d.getHours()).padStart(2, '0')}:${m}`;
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = dayKey(now);
  const yesterday = dayKey(now - 24 * 60 * 60 * 1000);
  const k = dayKey(ts);
  if (k === today) return 'Today';
  if (k === yesterday) return 'Yesterday';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Small edit distance, for "did you mean /join?".
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

module.exports = { emojify, EMOJI, cleanText, clock, dayKey, dayLabel, plural, listNames, distance };

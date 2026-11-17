'use strict';
// How gossip looks: the welcome panel, and the format of every line it prints.
// Nothing here reads the keyboard or touches the network - it only turns things
// into lines of text, using the current theme and preferences.

const A = require('./ansi');
const T = require('./text');
const Th = require('./theme');
const prefs = require('./prefs');
const M = require('./mascot');
const pkg = require('../package.json');

const user = (name) => A.paint(name, Th.nameStyle(name));
const server = (name) => Th.paint('server', '#' + name);

/** '@maya' or '#gamedev', coloured. */
function label(key) {
  return key[0] === '#' ? server(key.slice(1)) : A.paint('@' + key.slice(1), Th.nameStyle(key.slice(1)));
}

function fit(str, w) {
  const [text, used] = A.clipW(str, w);
  return used < w ? text + ' '.repeat(w - used) : text;
}

function center(str, w) {
  const vw = A.vwidth(str);
  if (vw >= w) return A.clip(str, w);
  const left = Math.floor((w - vw) / 2);
  return ' '.repeat(left) + str + ' '.repeat(w - vw - left);
}

// ── welcome panel ───────────────────────────────────────────────────────────

/** How the penguin's little extras (notes, dots) are coloured. */
function markStyle() {
  return Th.style('accent2', { bold: true });
}

/**
 * The panel shown when gossip opens.
 *   info: { me, host, firstRun, status: [lines], sprite: [lines] | null }
 * Returns lines. Falls back to smaller layouts in narrow windows.
 */
function welcome(info, cols) {
  const mode = prefs.val('welcome');
  const title = Th.accent('gossip', { bold: true }) + ' ' + Th.dim('v' + pkg.version);
  const hello = (info.firstRun ? 'Welcome, ' : 'Welcome back, ') + info.me;
  const tips = [
    ['@name hello', 'message someone'],
    ['/servers', 'find a group to join'],
    ['/config', 'make gossip yours'],
    ['/help', 'everything else'],
  ];

  const max = Math.max(20, cols - 1);
  if (mode === 'off' || cols < 44) {
    return ['', A.clip(` ${title}  ${Th.dim('·')}  ${user(info.me)}  ${Th.dim('·  ' + info.host)}`, max), ''];
  }

  const sprite = info.sprite;
  if (mode === 'compact' || cols < 66) {
    const side = [title, A.paint(hello, { bold: true }), Th.dim(info.host), ...info.status];
    const out = [''];
    const n = sprite ? M.HEIGHT : side.length;
    const top = sprite ? Math.max(0, Math.floor((n - side.length) / 2)) : 0;
    for (let i = 0; i < n; i++) out.push(A.clip((sprite ? sprite[i] + '  ' : ' ') + (side[i - top] || ''), max));
    out.push('');
    return out;
  }

  // full: a two-column box
  const W = Math.min(cols - 1, 78);
  const inner = W - 2;
  const leftW = sprite ? M.WIDTH + 6 : 0;
  const rightW = sprite ? inner - leftW - 1 : inner;

  const left = [];
  if (sprite) {
    left.push('', center(A.paint(hello, { bold: true }), leftW), '');
    for (const l of sprite) left.push(center(l, leftW));
    left.push(center(Th.dim(A.ellipsis(info.host, leftW - 2)), leftW), '');
  }
  const right = [''];
  if (!sprite) right.push('  ' + A.paint(hello, { bold: true }) + Th.dim('  ·  ' + info.host), '');
  right.push('  ' + Th.accent2('Getting started', { bold: true }));
  for (const [cmd, what] of tips) right.push('  ' + Th.accent(cmd.padEnd(14)) + Th.dim(what));
  right.push('  ' + Th.border('─'.repeat(Math.max(4, rightW - 4))));
  right.push('  ' + Th.accent2('Right now', { bold: true }));
  for (const l of info.status) right.push('  ' + l);
  right.push('');

  const rows = Math.max(left.length, right.length);
  const bar = Th.border('│');
  const head = `─ gossip v${pkg.version} `;
  const out = ['', ' ' + Th.border('╭─') + ` ${title} ` + Th.border('─'.repeat(Math.max(0, inner - A.width(head))) + '╮')];
  for (let i = 0; i < rows; i++) {
    const r = fit(right[i] || '', rightW);
    out.push(' ' + bar + (sprite ? fit(left[i] || '', leftW) + bar : '') + r + bar);
  }
  out.push(' ' + Th.border('╰' + '─'.repeat(inner) + '╯'), '');
  return out;
}

/** A plain line for places that only want the name and version. */
function titleLine() {
  return Th.accent('gossip', { bold: true }) + ' ' + Th.dim('v' + pkg.version);
}

// ── messages ────────────────────────────────────────────────────────────────

const TOKEN_RE = /(https?:\/\/[^\s<>"']+)|(?<![a-z0-9._-])(@[a-z0-9][a-z0-9_-]{2,19})(?![a-z0-9_-])/gi;

// Underline links; colour @mentions (yours stands out).
function decorate(me, line) {
  if (line.indexOf('@') < 0 && line.indexOf('http') < 0) return line;
  let out = '';
  let last = 0;
  for (const m of line.matchAll(TOKEN_RE)) {
    out += line.slice(last, m.index);
    if (m[1]) out += Th.paint('link', m[1], prefs.val('links') === 'underline' ? { underline: true } : null);
    else if (m[2].slice(1).toLowerCase() === me) out += Th.accent2(m[2], { bold: true, inverse: true });
    else out += A.paint(m[2], { ...Th.nameStyle(m[2].slice(1).toLowerCase()), bold: false });
    last = m.index + m[0].length;
  }
  return out + line.slice(last);
}

function who(me, key, msg, bare) {
  const mine = msg.from === me;
  const from = mine ? A.paint(prefs.val('you'), { bold: true }) : user(msg.from);
  if (bare) return from; // inside one chat's own pane there's no need to say where it went
  if (key[0] === '@') return mine ? from + Th.dim(' → ') + user(key.slice(1)) : from;
  return from + Th.dim(' in ') + server(key.slice(1));
}

function clockText(ts) {
  const mode = prefs.val('time');
  return mode === 'off' ? '' : T.clock(ts, mode);
}

/**
 * One message, one line (wrapping under the text):
 *    2:23 PM  maya: yep, pushing now
 *    2:23 PM  you → maya: nice
 *    2:26 PM  sam in #gamedev: anyone around?
 */
/** "/me waves" is shown as an action:  * maya waves */
const isAction = (msg) => typeof msg.text === 'string' && /^\/me\s+\S/.test(msg.text);

/** A file in the chat: name, size, how it's going - and for pictures, the picture. */
function fileText(me, msg) {
  const F = require('./files');
  const f = msg.file;
  const pct = (x) => `${Math.floor((Number(x) || 0) * 100)}%`;
  let state = '';
  if (f.state === 'sending') state = Th.dim(`sending ${pct(f.done)}`);
  else if (f.state === 'receiving') state = Th.dim(`receiving ${pct(f.done)}`);
  else if (f.state === 'failed') state = Th.err('✗ failed');
  else if (f.state === 'saved') state = Th.ok('saved') + Th.dim(' · /open');
  else if (msg.from === me) state = Th.dim(msg.status === 'delivered' ? 'delivered' : 'sent');
  return Th.accent2('📎 ') + A.paint(f.name, { bold: true, underline: true }) + Th.dim('  ' + F.sizeText(f.size)) + (state ? '  ' + state : '');
}

function fileLines(msg, indent, max) {
  return require('./files').previewLines(msg.file.preview, Math.max(8, Math.min(40, max - indent))).map((l) => ' '.repeat(indent) + l);
}

function messageLines(me, key, msg, cols, bare = false) {
  const clock = clockText(msg.ts);
  const timeW = clock ? (prefs.val('time') === '24h' ? 5 : 8) + 2 : 1;
  const time = clock ? Th.dim(clock.padStart(timeW - 2)) + '  ' : ' ';
  if (isAction(msg)) {
    const place = bare || key[0] === '@' ? '' : ` (${key})`;
    return A.wrap(`${msg.from} ${msg.text.replace(/^\/me\s+/, '')}${place}`, Math.max(20, cols - 1 - timeW - 2))
      .map((l, i) => (i === 0 ? time + Th.accent2('* ') : ' '.repeat(timeW + 2)) + A.paint(l, { italic: true }));
  }
  const head = who(me, key, msg, bare) + Th.dim(':');

  const max = Math.max(24, cols - 1);
  const indent = max >= 50 ? timeW : 2;
  const headW = timeW + A.vwidth(head) + 1;
  const out = [];
  if (msg.file) {
    out.push(time + head + ' ' + A.clip(fileText(me, msg), Math.max(8, max - headW)));
    return out.concat(fileLines(msg, indent, max));
  }
  if (max - headW < 16) {
    // very narrow window or very long names: text starts on its own line
    out.push(time + head);
    for (const l of A.wrap(msg.text, max - indent)) out.push(' '.repeat(indent) + decorate(me, l));
  } else {
    A.wrap(msg.text, (i) => (i === 0 ? max - headW : max - indent)).forEach((l, i) => {
      out.push((i === 0 ? time + head + ' ' : ' '.repeat(indent)) + decorate(me, l));
    });
  }
  if (msg.from === me && msg.status === 'failed') out[out.length - 1] += '  ' + Th.err('✗ not sent');
  return out.concat(videoLines(msg, indent, max));
}

/** Under a message with a YouTube link: how to play it here. */
function videoLines(msg, indent, max) {
  if (typeof msg.text !== 'string' || msg.text.indexOf('http') < 0) return [];
  const n = require('./youtube').findAll(msg.text).length;
  if (!n) return [];
  const text = n === 1 ? 'YouTube video · /yt plays it · /watch to watch together' : `${n} YouTube videos · /videos`;
  return [' '.repeat(indent) + Th.accent2('▶ ') + Th.dim(A.clip(text, Math.max(8, max - indent - 2)))];
}

/** The "cozy" layout: who and when on one line, the text underneath. */
function cozyLines(me, key, msg, cols, withHeader, bare = false) {
  if (isAction(msg)) return messageLines(me, key, msg, cols, bare);
  const max = Math.max(24, cols - 1);
  const out = [];
  if (withHeader) {
    const clock = clockText(msg.ts);
    out.push('', ' ' + who(me, key, msg, bare) + (clock ? Th.dim('  ·  ' + clock) : ''));
  }
  if (msg.file) return out.concat('   ' + A.clip(fileText(me, msg), max - 3), fileLines(msg, 3, max));
  for (const l of A.wrap(msg.text, max - 3)) out.push('   ' + decorate(me, l));
  if (msg.from === me && msg.status === 'failed') out[out.length - 1] += '  ' + Th.err('✗ not sent');
  return out.concat(videoLines(msg, 3, max));
}

const MARKS = { ok: ['✓', 'ok'], warn: ['!', 'warn'], err: ['✗', 'err'], sys: ['·', 'dim'], event: ['→', 'dim'] };

/** A short notice from gossip itself (never sent to anyone). */
function noteLines(kind, text, cols) {
  const [mark, part] = MARKS[kind] || MARKS.sys;
  const quiet = kind === 'sys' || kind === 'event';
  const m = Th.paint(part, mark, quiet ? null : { bold: true });
  return A.wrap(text, Math.max(20, cols - 5)).map((l, i) => '  ' + (i === 0 ? m : ' ') + ' ' + (quiet ? Th.dim(l) : l));
}

function rowStyle(style, text) {
  if (!style) return null;
  if (style === 'bold') return { bold: true };
  if (style === 'name') return Th.nameStyle(text.trim());
  if (style.startsWith('name:')) return Th.nameStyle(style.slice(5));
  if (style.startsWith('fg:')) return { fg: style.slice(3) }; // a literal colour (theme previews)
  if (style === 'room') return Th.style('server');
  if (style === 'head') return Th.style('accent2', { bold: true });
  return Th.style(style);
}

/** rows: [[ [text, style], ... ], ...] - small tables like /help or /contacts. */
function rowsLines(rows, cols) {
  const out = [];
  for (const row of rows) {
    let line = '  ';
    for (const [text, style] of row) line += A.paint(text, rowStyle(style, text));
    if (A.vwidth(line) <= cols - 1) out.push(line);
    else for (const l of A.wrap(row.map((seg) => seg[0]).join(''), Math.max(20, cols - 3))) out.push('  ' + l);
  }
  return out;
}

function dayLine(ts) {
  return Th.dim(`  ── ${T.dayLabel(ts)} ──`);
}

/**
 * Turns the things the app wants shown into lines, remembering just enough
 * (the last day, the last speaker) to add date lines and group messages.
 */
class Printer {
  constructor(me, { bare = false } = {}) {
    this.me = me;
    this.bare = bare;
    this.lastDay = null;
    this.last = null; // { key, from, ts } of the message printed last
  }

  lines(item, cols) {
    if (item.t === 'day') {
      this.lastDay = T.dayKey(item.ts);
      this.last = null;
      return [dayLine(item.ts)];
    }
    if (item.t === 'rows') {
      this.last = null;
      return rowsLines(item.rows, cols);
    }
    if (item.t !== 'msg') {
      this.last = null;
      return noteLines(item.kind, item.text, cols);
    }
    const out = [];
    const { key, msg } = item;
    const day = T.dayKey(msg.ts);
    // a date line when the day changes (not for the very first message if it's from today)
    if (day !== this.lastDay && (this.lastDay !== null || day !== T.dayKey(Date.now()))) {
      out.push(dayLine(msg.ts));
      this.last = null;
    }
    this.lastDay = day;
    if (prefs.val('layout') === 'cozy') {
      const l = this.last;
      const grouped = l && l.key === key && l.from === msg.from && Math.abs(msg.ts - l.ts) < 5 * 60 * 1000;
      for (const line of cozyLines(this.me, key, msg, cols, !grouped, this.bare)) out.push(line);
    } else {
      for (const line of messageLines(this.me, key, msg, cols, this.bare)) out.push(line);
    }
    this.last = { key, from: msg.from, ts: msg.ts };
    return out;
  }
}

module.exports = {
  user, server, label, fit, center, markStyle, welcome, titleLine,
  messageLines, cozyLines, noteLines, rowsLines, dayLine, Printer,
};

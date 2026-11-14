'use strict';
// Colour schemes. A theme gives each *part* of the interface a style; the rest
// of the code only ever asks for a part ("accent", "dim", "server"...), so a
// new theme - or a single `color.accent` override - restyles everything.

const A = require('./ansi');
const prefs = require('./prefs');

const fg = (hex, extra) => ({ fg: hex, ...extra });

const THEMES = {
  arctic: {
    about: 'Icy blues with a warm beak-orange accent',
    paper: { bg: '#0f131c', fg: '#e8edf5' },
    accent: fg('#7cc7ff'), accent2: fg('#ffb86b'), border: fg('#4a566e'), dim: fg('#8a94a8'),
    ok: fg('#7ddba3'), warn: fg('#f6c177'), err: fg('#ff7b8a'), server: fg('#7fe3d4'), link: fg('#9db8ff'),
    names: ['#7cc7ff', '#ffb86b', '#7ddba3', '#c6a0f6', '#f5a3c7', '#7fe3d4', '#f6c177', '#9db8ff'],
  },
  ember: {
    about: 'Warm terracotta and sand',
    paper: { bg: '#1a1411', fg: '#efe4da' },
    accent: fg('#e0825a'), accent2: fg('#e8c07d'), border: fg('#5c4d45'), dim: fg('#9c9189'),
    ok: fg('#9ccf8a'), warn: fg('#e8c07d'), err: fg('#f07178'), server: fg('#8fd0c0'), link: fg('#82b7d9'),
    names: ['#e0825a', '#e8c07d', '#9ccf8a', '#82b7d9', '#d7a1e0', '#f2a0a0', '#c9d17a', '#8fd0c0'],
  },
  aurora: {
    about: 'Teal and violet, like northern lights',
    paper: { bg: '#0c1016', fg: '#e2e8f0' },
    accent: fg('#5eead4'), accent2: fg('#c084fc'), border: fg('#3f4a5e'), dim: fg('#8b93a7'),
    ok: fg('#86efac'), warn: fg('#fcd34d'), err: fg('#fb7185'), server: fg('#67e8f9'), link: fg('#93c5fd'),
    names: ['#5eead4', '#c084fc', '#fcd34d', '#fb7185', '#93c5fd', '#86efac', '#f0abfc', '#fdba74'],
  },
  daylight: {
    about: 'Light: turns gossip bright, even in a dark terminal',
    paper: { bg: '#f7f5f0', fg: '#1c2230', always: true }, // (always: paints by default)
    accent: fg('#0b6bcb'), accent2: fg('#c2410c'), border: fg('#aeb7c4'), dim: fg('#5f6b7a'),
    ok: fg('#15803d'), warn: fg('#a16207'), err: fg('#b91c1c'), server: fg('#0f766e'), link: fg('#1d4ed8'),
    names: ['#0b6bcb', '#c2410c', '#15803d', '#7e22ce', '#be185d', '#0f766e', '#a16207', '#4338ca'],
  },
  terminal: {
    about: "Only your terminal's own 16 colours",
    ansi: true,
    accent: fg('cyan'), accent2: fg('yellow'), border: { dim: true }, dim: { dim: true },
    ok: fg('green'), warn: fg('yellow'), err: fg('red'), server: fg('cyan'), link: {},
    names: ['cyan', 'green', 'yellow', 'magenta', 'brightBlue', 'brightCyan', 'brightGreen', 'brightMagenta'],
  },
  mono: {
    about: 'No colours at all, just bold and dim',
    mono: true,
    accent: { bold: true }, accent2: { bold: true }, border: { dim: true }, dim: { dim: true },
    ok: {}, warn: { bold: true }, err: { bold: true }, server: {}, link: {},
    names: [],
  },
};

function active() {
  return THEMES[prefs.val('theme')] || THEMES.arctic;
}

/** How to draw the penguin under the current theme: 'rgb', 'ansi' or 'mono'. */
function spriteMode() {
  const t = active();
  if (A.getLevel() === 0 || t.mono) return 'mono';
  return t.ansi ? 'ansi' : 'rgb';
}

/** The style for one part of the interface (with any personal colour override). */
function style(part, extra) {
  const t = active();
  let s = t[part] || {};
  const mine = prefs.val('color.' + part);
  if (mine && !t.mono) s = { ...s, fg: mine, dim: false };
  return extra ? { ...s, ...extra } : s;
}

const paint = (part, text, extra) => A.paint(text, style(part, extra));

function nameStyle(name) {
  const t = active();
  if (prefs.val('names') === 'plain' || !t.names.length) return { bold: true };
  // a small mixing hash, so short and similar names still land on different colours
  let h = 0x9747b28c;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x5bd1e995) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
  }
  const i = h % t.names.length;
  return { fg: prefs.val(`color.name${i + 1}`) || t.names[i], bold: true };
}

module.exports = {
  THEMES, active, spriteMode, style, paint, nameStyle,
  accent: (s, extra) => paint('accent', s, extra),
  accent2: (s, extra) => paint('accent2', s, extra),
  border: (s) => paint('border', s),
  dim: (s) => paint('dim', s),
  ok: (s, extra) => paint('ok', s, extra),
  warn: (s, extra) => paint('warn', s, extra),
  err: (s, extra) => paint('err', s, extra),
  bold: (s) => A.paint(s, { bold: true }),
};

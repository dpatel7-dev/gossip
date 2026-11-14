'use strict';
// Painting the terminal in the theme's own colours - so the daylight theme
// turns gossip light even when the terminal is set to dark.
//
// Two ways at once, because terminals differ:
//   1. Ask the terminal to change its default background and text colour
//      (OSC 10 / 11: iTerm2, Windows Terminal, GNOME, kitty, WezTerm, xterm…).
//      That colours everything, right to the window's edges. On the way out
//      gossip puts back exactly what the terminal had.
//   2. Colour every cell gossip draws itself (see ansi.paperize), for terminals
//      that ignore (1) - macOS Terminal among them.
//
//   gossip config background auto       daylight paints, the dark themes don't (default)
//   gossip config background theme      every theme paints its own background
//   gossip config background terminal   never: keep the terminal's own colours

const A = require('./ansi');
const Th = require('./theme');
const M = require('./mascot');
const prefs = require('./prefs');

/** Asks the terminal for its text and background colours (the answers come back as input). */
const QUERY = '\x1b]10;?\x07\x1b]11;?\x07';
const REPLY_RE = /\x1b\](1[01]);rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/gi;

const original = { 10: null, 11: null }; // what the terminal had, as it told us: '#rrggbb'
let painted = null; // the paper we're showing, or null

const hex2 = (h) => parseInt((h + h).slice(0, 2), 16); // "f" "ff" "ffff" -> 255
const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

/** The paper the current theme and settings want, or null. */
function wanted() {
  if (A.getLevel() === 0) return null;
  const mode = prefs.val('background');
  const t = Th.active();
  if (!t.paper || mode === 'terminal') return null;
  if (mode !== 'theme' && !t.paper.always) return null;
  return t.paper;
}

const same = (a, b) => (a ? a.bg + a.fg : '') === (b ? b.bg + b.fg : '');

/**
 * Bring the terminal in line with the theme. Returns the escape codes to write
 * ('' when nothing changed). Screens call this before every redraw, so a theme
 * change anywhere (the menu, /theme, the dashboard) shows straight away.
 */
function sync() {
  const want = wanted();
  if (same(want, painted)) return '';
  if (!want) return restore();
  painted = want;
  A.setPaper(want);
  M.setBackdrop(A.parseHex(want.bg));
  return `\x1b]10;${want.fg}\x07\x1b]11;${want.bg}\x07`;
}

/** Stop painting and hand the terminal back its own colours. */
function restore() {
  if (!painted) return '';
  painted = null;
  A.setPaper(null);
  M.setBackdrop(original[11] ? A.parseHex(original[11]) : null);
  // 110/111 = "back to your own default"; then the exact colours, for terminals
  // that only understand being told a colour
  let out = '\x1b[0m\x1b]110\x07\x1b]111\x07';
  if (original[10]) out += `\x1b]10;${original[10]}\x07`;
  if (original[11]) out += `\x1b]11;${original[11]}\x07`;
  return out;
}

/**
 * Take the terminal's colour answers out of a chunk of input. Returns the rest
 * of the input, and calls changed() if an answer arrived.
 */
function absorb(text, changed) {
  if (text.indexOf('\x1b]1') < 0) return text;
  return text.replace(REPLY_RE, (all, which, r, g, b) => {
    const rgb = [r, g, b].map(hex2);
    const hex = toHex(rgb);
    // our own paper colour coming back (say, after gossip was killed mid-paint) isn't the terminal's
    const ours = painted && hex === String(which === '11' ? painted.bg : painted.fg).toLowerCase();
    if (!ours) original[which] = hex;
    if (which === '11' && !painted) M.setBackdrop(rgb);
    if (changed) changed();
    return '';
  });
}

// However gossip ends, never leave the terminal painted.
process.on('exit', () => {
  if (!painted) return;
  try { require('fs').writeSync(1, restore()); } catch { /* terminal gone */ }
});

/** Escape codes that make the rest of a cleared area paper-coloured (clearing uses the current colours). */
const ink = () => (A.getPaper() ? A.getPaper().on : '');

module.exports = { QUERY, sync, restore, absorb, ink, wanted, get painted() { return painted; }, original };

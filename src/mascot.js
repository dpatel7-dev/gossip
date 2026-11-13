'use strict';
// Pebble, gossip's penguin.
//
// Pebble is drawn as pixel art: every letter below is one pixel, and two rows of
// pixels share one line of text (using the half-block characters ▀ ▄ █), so a
// 16x16 picture takes 16 columns by 8 lines. Frames are built from a few base
// drawings plus small moves (lean, bob, mirror), then played as scenes.

const A = require('./ansi');

//            exact colour        closest terminal colour
const INK = {
  B: { rgb: [86, 122, 176], ansi: 'blue' }, //            body
  D: { rgb: [58, 84, 128], ansi: 'blue' }, //             body, in shadow
  W: { rgb: [244, 247, 252], ansi: 'brightWhite' }, //    belly and face
  w: { rgb: [214, 222, 235], ansi: 'white' }, //          belly, in shadow
  O: { rgb: [255, 176, 72], ansi: 'yellow' }, //          beak and feet
  o: { rgb: [228, 138, 52], ansi: 'yellow' },
  E: { rgb: [26, 30, 42], ansi: 'black' }, //             eyes
  R: { rgb: [255, 112, 122], ansi: 'red' }, //            scarf
  r: { rgb: [212, 82, 98], ansi: 'red' },
  K: { rgb: [84, 92, 116], ansi: 'gray' }, //              phone, laptop base
  G: { rgb: [152, 160, 176], ansi: 'white' }, //          laptop lid
  g: { rgb: [198, 205, 217], ansi: 'brightWhite' },
  S: { rgb: [124, 222, 255], ansi: 'cyan' }, //           glow
};
const LIGHT = new Set(['W', 'w', 'g', 'G', 'S']);

const FRONT = [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB...',
  '..BBWWWBBWWWBB..',
  '..BWWEWWWWEWWB..',
  '..BWWWWOOWWWWB..',
  '..BBWWWooWWWBB..',
  '...RRRRRRRRRR...',
  '..BBrRWWWWWWBB..',
  '.BBBRRWWWWWWBBB.',
  'BBB.RWWWWWWW.BBB',
  'BB..WWWWWWWW..BB',
  '....BWWWWWWB....',
  '....BBwwwwBB....',
  '...OOOBBBBOOO...',
  '..OOOO....OOOO..',
];

const UP = [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB...',
  '..BBWWWBBWWWBB..',
  'B.BWWEWWWWEWWB.B',
  'BBBWWWWOOWWWWBBB',
  '.BBBWWWooWWWBBB.',
  '..BRRRRRRRRRRB..',
  '...BrRWWWWWWB...',
  '...BRRWWWWWWB...',
  '...BRWWWWWWWB...',
  '...BWWWWWWWWB...',
  '....BWWWWWWB....',
  '....BBwwwwBB....',
  '...OOOBBBBOOO...',
  '..OOOO....OOOO..',
];

const SIDE = [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB...',
  '..BWWWBBBBBBB...',
  '..WWEWWBBBBBB...',
  'OOOWWWWBBBBBB...',
  '.ooWWWBBBBBBB...',
  '...RRRRRRRRRR...',
  '...WWWBBBBBBRR..',
  '..WWWWBBDBBBrR..',
  '..WWWWBDDDBBB...',
  '..WWWWBDDDBB....',
  '...WWWBBDBBB....',
  '...BwwBBBBB.....',
  '..OOOOOBBB......',
  '.OOOOOO.........',
];

const BACK = [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB...',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  '..BBBBBBBBBBBB..',
  '...RRRRRRRRRR...',
  '..BBBBBBBBRRBB..',
  '.BBBBBBBBBrRBBB.',
  'BBBDBBBBBBrRDBBB',
  'BB.DBBBBBBBBD.BB',
  '....BBBBBBBB....',
  '....BBBDDBBB....',
  '...OOBBBBBBOO...',
  '..OOO......OOO..',
];

const PHONE = [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB.KK',
  '..BBWWWBBWWWBBKK',
  '..BWWEWWWWEWWBKK',
  '..BWWWWOOWWWWBKK',
  '..BBWWWooWWWBBBB',
  '...RRRRRRRRRRBB.',
  '..BBrRWWWWWWBB..',
  '.BBBRRWWWWWWB...',
  'BBB.RWWWWWWWB...',
  'BB..WWWWWWWWB...',
  '....BWWWWWWB....',
  '....BBwwwwBB....',
  '...OOOBBBBOOO...',
  '..OOOO....OOOO..',
];

const LAPTOP = [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB...',
  '..BBWWWBBWWWBB..',
  '..BWWWWWWWWWWB..',
  '..BWWEWOOWEWWB..',
  '..BBWWWooWWWBB..',
  '...RRRRRRRRRR...',
  '.BBBrRWWWWWWBBB.',
  'BBGGGGGGGGGGGGBB',
  'BBGggggggggggGBB',
  'B.GggggSSggggG.B',
  'BBGggggggggggG.B',
  'BBGGGGGGGGGGGG.B',
  'KKKKKKKKKKKKKKKK',
  '.KKKKKKKKKKKKKK.',
];

// ── small moves ─────────────────────────────────────────────────────────────

const mirror = (grid) => grid.map((row) => row.split('').reverse().join(''));

/** Shift the top of the body sideways: a lean. */
function lean(grid, dx) {
  return grid.map((row, y) => {
    if (y > 8) return row;
    return dx < 0 ? row.slice(-dx) + '.'.repeat(-dx) : '.'.repeat(dx) + row.slice(0, row.length - dx);
  });
}

/** Squash down one pixel, feet planted: a bounce. */
function bob(grid) {
  return ['.'.repeat(16), ...grid.slice(0, 13), grid[14], grid[15]];
}

function edit(grid, changes) {
  const out = grid.slice();
  for (const [y, row] of Object.entries(changes)) out[Number(y)] = row;
  return out;
}

const PHONE_TALK = edit(PHONE, { 6: '..BBWWWEEWWWBBBB' });
const BLINK = (grid) => grid.map((row, y) => (y === 4 || y === 5 ? row.replace(/E/g, 'w') : row));
const LAPTOP_R = edit(LAPTOP, { 12: 'B.GggggggggggGBB', 13: 'B.GGGGGGGGGGGGBB' });

// ── scenes ──────────────────────────────────────────────────────────────────
// A frame is { grid, marks?, ms? }. marks are little text extras drawn beside
// Pebble: [line, column, text] in the 22-column canvas (Pebble sits at column 3).

const NOTE_L = [[1, 0, '♪']];
const NOTE_R = [[0, 20, '♫']];

const SCENES = {
  dance: {
    about: 'a little dance, with a spin',
    rest: { grid: UP, marks: [...NOTE_L, ...NOTE_R] },
    frames: [
      { grid: FRONT },
      { grid: bob(FRONT) },
      { grid: UP, marks: NOTE_L },
      { grid: lean(UP, -1), marks: NOTE_L },
      { grid: UP, marks: NOTE_R },
      { grid: lean(UP, 1), marks: NOTE_R },
      { grid: bob(FRONT) },
      { grid: SIDE },
      { grid: BACK },
      { grid: mirror(SIDE) },
      { grid: UP, marks: [...NOTE_L, ...NOTE_R] },
      { grid: bob(UP), marks: [...NOTE_L, ...NOTE_R] },
    ],
  },
  phone: {
    about: 'on a call',
    rest: { grid: PHONE, marks: [[1, 19, ')))']] },
    frames: [
      { grid: PHONE, marks: [[1, 19, ')']], ms: 260 },
      { grid: PHONE_TALK, marks: [[1, 19, '))']], ms: 260 },
      { grid: PHONE, marks: [[1, 19, ')))']], ms: 260 },
      { grid: PHONE_TALK, marks: [[1, 19, '))']], ms: 260 },
      { grid: BLINK(PHONE), marks: [[1, 19, ')']], ms: 180 },
      { grid: PHONE_TALK, marks: [[1, 19, ')))']], ms: 260 },
    ],
  },
  laptop: {
    about: 'typing a message',
    rest: { grid: LAPTOP, marks: [[0, 18, '✓']] },
    frames: [
      { grid: LAPTOP, marks: [[0, 18, '•']] },
      { grid: LAPTOP_R, marks: [[0, 18, '•']] },
      { grid: LAPTOP, marks: [[0, 18, '••']] },
      { grid: LAPTOP_R, marks: [[0, 18, '••']] },
      { grid: LAPTOP, marks: [[0, 18, '•••']] },
      { grid: LAPTOP_R, marks: [[0, 18, '•••']] },
      { grid: BLINK(LAPTOP), marks: [[0, 18, '•••']] },
      { grid: LAPTOP, marks: [[0, 18, '✓']], ms: 420 },
    ],
  },
};

const SCENE_NAMES = Object.keys(SCENES);
const WIDTH = 22; // columns
const HEIGHT = 8; // lines
const SPEED = { slow: 240, normal: 150, fast: 90 };

function pickScene(want) {
  if (SCENES[want]) return want;
  return SCENE_NAMES[Math.floor(Math.random() * SCENE_NAMES.length)];
}

// ── drawing ─────────────────────────────────────────────────────────────────

function cell(top, bottom, mode) {
  const t = top === '.' ? null : top;
  const b = bottom === '.' ? null : bottom;
  if (!t && !b) return ' ';
  if (mode === 'mono') {
    const light = (t && LIGHT.has(t)) || (b && LIGHT.has(b));
    const dark = (t && !LIGHT.has(t)) || (b && !LIGHT.has(b));
    if (light && dark) return '▒';
    if (light) return '░';
    return t && b ? '█' : t ? '▀' : '▄';
  }
  const ink = (ch) => (mode === 'ansi' ? INK[ch].ansi : INK[ch].rgb);
  if (t && b) return t === b ? A.paint('█', { fg: ink(t) }) : A.paint('▀', { fg: ink(t), bg: ink(b) });
  return t ? A.paint('▀', { fg: ink(t) }) : A.paint('▄', { fg: ink(b) });
}

/**
 * Draw one frame as HEIGHT lines, each exactly WIDTH columns wide.
 * mode: 'rgb' (exact colours), 'ansi' (terminal palette) or 'mono' (no colour).
 * markStyle: how the little extras (notes, dots) are coloured.
 */
function draw(frame, mode = 'rgb', markStyle = null) {
  const lines = [];
  for (let y = 0; y < HEIGHT; y++) {
    // lay the line out as cells so marks can be placed beside the sprite
    const cells = new Array(WIDTH).fill(' ');
    for (let x = 0; x < 16; x++) cells[3 + x] = cell(frame.grid[y * 2][x], frame.grid[y * 2 + 1][x], mode);
    for (const [line, col, text] of frame.marks || []) {
      if (line !== y) continue;
      Array.from(text).forEach((ch, i) => {
        if (col + i < WIDTH && cells[col + i] === ' ') cells[col + i] = markStyle ? A.paint(ch, markStyle) : ch;
      });
    }
    lines.push(cells.join(''));
  }
  return lines;
}

/** The frames of a scene with their timings: [{ lines, ms }]. */
function play(name, { mode = 'rgb', speed = 'normal', loops = 2, markStyle = null } = {}) {
  const scene = SCENES[name] || SCENES.dance;
  const base = SPEED[speed] || SPEED.normal;
  const out = [];
  for (let i = 0; i < loops; i++) {
    for (const f of scene.frames) out.push({ lines: draw(f, mode, markStyle), ms: Math.round((f.ms || 150) * (base / 150)) });
  }
  return out;
}

/** The still picture a scene settles on. */
function still(name, { mode = 'rgb', markStyle = null } = {}) {
  return draw((SCENES[name] || SCENES.dance).rest, mode, markStyle);
}

module.exports = { SCENES, SCENE_NAMES, WIDTH, HEIGHT, pickScene, draw, play, still };

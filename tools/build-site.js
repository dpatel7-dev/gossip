#!/usr/bin/env node
'use strict';
// Rebuilds site/index.html from site/index.src.html by dropping in the penguin's
// animation frames straight from src/mascot.js - so the website's Pebble is
// always the same Pebble the app draws. Run it after changing either file:
//
//   node tools/build-site.js
const fs = require('fs');
const path = require('path');
const M = require('../src/mascot');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'mascot.js'), 'utf8');
const ink = {};
for (const m of source.matchAll(/^ {2}(\w): \{ rgb: \[(\d+), (\d+), (\d+)\]/gm)) {
  ink[m[1]] = '#' + [m[2], m[3], m[4]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}
const grids = [];
const seen = new Map();
const scenes = {};
for (const name of M.SCENE_NAMES) {
  scenes[name] = M.SCENES[name].frames.map((f) => {
    const flat = f.grid.join('');
    if (!seen.has(flat)) { seen.set(flat, grids.length); grids.push(flat); }
    return [seen.get(flat), f.ms || 150];
  });
}
const page = fs.readFileSync(path.join(root, 'site', 'index.src.html'), 'utf8')
  .replace('__PENGUIN__', JSON.stringify({ ink, grids, scenes }));
fs.writeFileSync(path.join(root, 'site', 'index.html'), page);
console.log(`site/index.html written (${Math.round(page.length / 1024)} KB, ${grids.length} penguin frames)`);

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
const { ink, grids, scenes } = M.pixels();

// the colour themes, for the "try a theme" buttons
const Th = require('../src/theme');
const themes = {};
for (const [name, t] of Object.entries(Th.THEMES)) {
  if (t.ansi || t.mono) continue; // those two borrow the terminal's own colours
  const light = name === 'daylight';
  themes[name] = {
    bg: light ? '#f4f1ea' : 'rgba(8, 13, 36, .78)', fg: light ? '#1c2230' : '#f4f7fc',
    dim: t.dim.fg, a: t.accent.fg, b: t.accent2.fg, ok: t.ok.fg, sv: t.server.fg,
  };
}

// the newest entries of CHANGELOG.md
const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const news = [];
for (const line of fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/)) {
  const head = /^##\s+v?(\d+\.\d+\.\d+)/.exec(line);
  if (head) news.push({ version: head[1], lines: [] });
  else if (news.length && /^\s*-\s+/.test(line)) news[news.length - 1].lines.push(line.replace(/^\s*-\s+/, ''));
}
// the page is for newcomers: leave out bug-fix lines, and versions that were only fixes
for (const v of news) v.lines = v.lines.filter((l) => !/^Fixed\b/.test(l));
const newsHtml = news.filter((v) => v.lines.length).slice(0, 3).map((v) => `<div><h3>Version ${v.version}</h3><ul>${
  v.lines.slice(0, 5).map((l) => `<li>${esc(l).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ul></div>`).join('');

const page = fs.readFileSync(path.join(root, 'site', 'index.src.html'), 'utf8')
  .replace('__PENGUIN__', () => JSON.stringify({ ink, grids, scenes }))
  .replace('__THEMES__', () => JSON.stringify(themes))
  .replace('__NEWS__', () => newsHtml);
fs.writeFileSync(path.join(root, 'site', 'index.html'), page);
console.log(`site/index.html written (${Math.round(page.length / 1024)} KB, ${grids.length} penguin frames)`);

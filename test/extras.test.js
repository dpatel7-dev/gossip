'use strict';
// Daylight painting, reading times, reminders, messages for later, do not disturb.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.GOSSIP_NO_BROWSER = '1';
const { Relay } = require('../server/relay');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');
const { runCommand } = require('../src/commands');
const A = require('../src/ansi');
const prefs = require('../src/prefs');
const P = require('../src/paper');
const W = require('../src/when');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-extra-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('daylight paints every line in its own colours, and gives the terminal back', () => {
  const level = A.getLevel();
  A.setLevel(3);
  try {
    prefs.use({ prefs: { theme: 'daylight' } });
    const on = P.sync();
    assert.match(on, /\x1b\]11;#f7f5f0\x07/, 'asks the terminal for a light background');
    assert.match(on, /\x1b\]10;#1c2230\x07/, 'and dark text');
    const paper = '\x1b[38;2;28;34;48;48;2;247;245;240m';
    const line = A.paperize(A.paint('hi', { fg: '#ff0000' }) + ' there');
    assert.ok(line.startsWith(paper), 'each line starts on the paper colours');
    assert.ok(line.includes('\x1b[0m' + paper + ' there'), 'and goes back to them after every reset');
    assert.equal(P.sync(), '', 'nothing to do when nothing changed');

    // the terminal says what it had; our own colour coming back is not mistaken for it
    assert.equal(P.absorb('a\x1b]11;rgb:1010/1414/1c1c\x07b'), 'ab');
    assert.equal(P.original[11], '#10141c');
    P.absorb('\x1b]11;rgb:f7f7/f5f5/f0f0\x1b\\');
    assert.equal(P.original[11], '#10141c');

    prefs.use({ prefs: { theme: 'arctic' } });
    const off = P.sync();
    assert.match(off, /\x1b\]111\x07/, 'back to the terminal default');
    assert.match(off, /\x1b\]11;#10141c\x07/, 'and exactly what it had');
    assert.equal(A.paperize('x'), 'x', 'dark themes leave the background alone');

    prefs.use({ prefs: { theme: 'daylight', background: 'terminal' } });
    assert.equal(P.sync(), '', 'background terminal: never paint');
    prefs.use({ prefs: { theme: 'ember', background: 'theme' } });
    assert.match(P.sync(), /#1a1411/, 'background theme: every theme paints');
    P.restore();
  } finally {
    prefs.use({});
    A.setLevel(level);
  }
});

test('when: reading times people type', () => {
  const now = new Date(2026, 10, 14, 15, 0, 0).getTime(); // 3 PM
  const at = (s) => { const r = W.parse(s, now); return r && [new Date(r.at).getHours() + ':' + String(new Date(r.at).getMinutes()).padStart(2, '0'), r.rest, Math.round((r.at - now) / 60000)]; };
  assert.deepEqual(at('10m stretch'), ['15:10', 'stretch', 10]);
  assert.deepEqual(at('1h30m call mom'), ['16:30', 'call mom', 90]);
  assert.deepEqual(at('in 10 minutes eat'), ['15:10', 'eat', 10]);
  assert.deepEqual(at('an hour y'), ['16:00', 'y', 60]);
  assert.deepEqual(at('5pm dinner'), ['17:00', 'dinner', 120]);
  assert.deepEqual(at('17:30 x'), ['17:30', 'x', 150]);
  assert.deepEqual(at('9 am gym'), ['9:00', 'gym', 18 * 60], '9am has passed today: tomorrow');
  assert.deepEqual(at('tomorrow 8am hi')[0], '8:00');
  assert.equal(W.parse('hello there', now), null);
  assert.equal(W.parse('5 apples', now), null, 'a bare number is not a time');
  assert.equal(W.describe(now + 10 * 60000, now).startsWith('in 10m'), true);
});

async function person(relay, name) {
  const dir = tmp();
  const url = `ws://127.0.0.1:${relay.port}`;
  await new App({ vault: new Vault(dir), server: url }).register(name);
  const app = new App({ vault: new Vault(dir), server: url, shell: true });
  app.notes = [];
  app.on('line', (i) => { if (i.t === 'note') app.notes.push(i.text); });
  app.ctx = { app, shell: true, quit() {} };
  await app.connect();
  return app;
}

test('later, reminders and do not disturb', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    ann.setTarget('@ben');

    // a message for later goes when it's due - not before
    await runCommand(ann.ctx, 'later 1h see you soon');
    assert.equal(ann.scheduled('later').length, 1);
    assert.equal(ann.scheduled('later')[0].key, '@ben');
    ann._due(Date.now());
    assert.equal(ann.scheduled('later').length, 1, 'not yet');
    ann._due(Date.now() + 3601000);
    assert.equal(ann.scheduled('later').length, 0);
    await until(() => ben.vault.loadHistory('@ann', 5).some((r) => r.text === 'see you soon'), 'the scheduled message');
    await assert.rejects(runCommand(ann.ctx, 'later sometime soon'), /When\?/);

    // reminders ring (even during do not disturb - you asked for them)
    let bells = 0;
    ann.on('bell', () => bells++);
    await runCommand(ann.ctx, 'dnd 1h');
    assert.ok(ann.dndActive());
    ann.emit('bell');
    assert.equal(bells, 0, 'no sounds during do not disturb');
    await runCommand(ann.ctx, 'remind 10m stretch');
    ann._due(Date.now() + 11 * 60000);
    assert.ok(ann.notes.some((t) => /Reminder: stretch/.test(t)));
    assert.equal(bells, 1);
    await runCommand(ann.ctx, 'dnd off');
    assert.equal(ann.dndActive(), false);
    ann.emit('bell');
    assert.equal(bells, 2);

    // cancelling
    await runCommand(ann.ctx, 'remind 5pm call mom');
    await runCommand(ann.ctx, 'remind tomorrow 9am gym');
    assert.equal(ann.scheduled('reminders').length, 2);
    await runCommand(ann.ctx, 'remind cancel 1');
    assert.equal(ann.scheduled('reminders').length, 1);
    await assert.rejects(runCommand(ann.ctx, 'remind cancel 9'), /no reminder 9/);
  } finally {
    for (const a of [ann, ben]) await a.closeGracefully();
    await relay.stop();
  }
});

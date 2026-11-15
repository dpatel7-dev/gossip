'use strict';
// The full chat screen, driven with a pretend terminal: suggestions, drafts, next unread.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough, Writable } = require('stream');
process.env.GOSSIP_NO_BROWSER = '1';
const { Relay } = require('../server/relay');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');
const { runCommand } = require('../src/commands');
const prefs = require('../src/prefs');
const screen = require('../src/screen');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-screen-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function terminal(columns = 100, rows = 28) {
  const input = new PassThrough();
  input.setRawMode = () => {};
  input.isTTY = true;
  let drawn = '';
  const output = new Writable({ write(chunk, enc, cb) { drawn += chunk.toString(); cb(); } });
  output.columns = columns;
  output.rows = rows;
  return { input, output, drawn: () => drawn, forget() { drawn = ''; } };
}

async function person(relay, name) {
  const dir = tmp();
  const url = `ws://127.0.0.1:${relay.port}`;
  await new App({ vault: new Vault(dir), server: url }).register(name);
  const app = new App({ vault: new Vault(dir), server: url, shell: true });
  app.ctx = { app, shell: true, quit() {} };
  await app.connect();
  return app;
}

const said = (app, key, text) => app.vault.loadHistory(key, 50).some((r) => r.text === text);
const DOWN = '\x1b[B';
const UP = '\x1b[A';

test('the chat screen: suggestions, a draft for each chat, ctrl+n for the next unread', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  const term = terminal();
  let done = null;
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    await runCommand(ann.ctx, 'create den');
    ann.settings = prefs.set(ann.vault, 'mascot', 'off').settings; // no hello animation to wait for
    ann.setTarget('@ben');
    done = screen.run(ann, { input: term.input, output: term.output });
    await sleep(100);

    // a whole command typed in one quick burst runs as typed (not whatever was suggested for "/")
    term.input.write('/dnd 30m\r');
    await until(() => ann.dndActive(), 'do not disturb');
    term.input.write('/dnd off\r');
    await until(() => !ann.dndActive(), 'do not disturb off');

    // typing "/rem" shows suggestions; tab completes the highlighted one
    term.forget();
    term.input.write('/rem');
    await sleep(60);
    assert.match(term.drawn(), /\/remind/);
    assert.match(term.drawn(), /tab complete/);
    term.input.write('\t');
    await sleep(60);
    term.input.write('10m stretch\r');
    await until(() => ann.scheduled('reminders').length === 1, 'the reminder');

    // a half-typed message stays with its chat when you look at another one
    term.input.write('half typed');
    await sleep(40);
    term.input.write(DOWN + DOWN); // past "+ Add a person" to #den
    await until(() => ann.target === '#den', 'the server to open');
    term.input.write('\r'); // nothing typed here: nothing sent
    await sleep(100);
    assert.equal(ann.vault.loadHistory('#den', 10).length, 0);
    term.input.write(UP + UP);
    await until(() => ann.target === '@ben', 'back to ben');
    term.input.write(' - and finished\r');
    await until(() => said(ben, '@ann', 'half typed - and finished'), 'the finished draft to reach ben');

    // "@be" + enter picks ben from the suggestions
    term.input.write(DOWN + DOWN);
    await until(() => ann.target === '#den', 'the server to open');
    term.input.write('@be\r');
    await until(() => ann.target === '@ben', '@be to open ben');

    // ctrl+n jumps to the chat with something unread
    term.input.write(DOWN + DOWN);
    await until(() => ann.target === '#den', 'the server again');
    await ben.send('@ann', 'are you there?');
    await until(() => said(ann, '@ben', 'are you there?'), 'ben\'s message');
    await sleep(50);
    term.input.write('\x0e'); // ctrl+n
    await until(() => ann.target === '@ben', 'ctrl+n to open ben');

    term.input.write('\x04'); // ctrl+d on an empty line: leave
    await done;
    done = null;
  } finally {
    if (done) { term.input.write('\x04'); await Promise.race([done, sleep(500)]); }
    prefs.use({});
    for (const a of [ann, ben]) await a.closeGracefully();
    await relay.stop();
  }
});

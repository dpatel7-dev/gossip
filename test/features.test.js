'use strict';
// The 0.3 additions, driven through real clients against a real relay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Relay } = require('../server/relay');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');
const { runCommand, people } = require('../src/commands');
const U = require('../src/update');
const M = require('../src/mascot');

const REPO = path.join(__dirname, '..');
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-feat-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function person(relay, name) {
  const dir = tmp();
  const url = `ws://127.0.0.1:${relay.port}`;
  await new App({ vault: new Vault(dir), server: url }).register(name);
  const app = new App({ vault: new Vault(dir), server: url, shell: true });
  app.shown = [];
  app.on('line', (i) => app.shown.push(i));
  app.ctx = { app, shell: true, quit() {} };
  app.dir = dir;
  await app.connect();
  return app;
}
const notes = (app) => app.shown.filter((i) => i.t === 'note').map((i) => i.text);
const table = (app) => app.shown.filter((i) => i.t === 'rows').map((i) => i.rows.map((r) => r.map((c) => c[0]).join('')).join('\n')).join('\n');

test('servers: remove people who are offline or not in yet, and hand a server over', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  const cat = await person(relay, 'cat');
  try {
    await runCommand(ann.ctx, 'create den');
    await runCommand(ben.ctx, 'join den');
    await until(() => ann.chat('#den').members.has('ben'), 'ben to join');

    // ben goes offline, then gets removed
    await ben.closeGracefully();
    await runCommand(ann.ctx, 'kick ben den');
    assert.match(notes(ann).join('\n'), /Removed ben from #den/);
    const back = new App({ vault: new Vault(ben.dir), server: ann.serverUrl, shell: true });
    back.shown = [];
    back.on('line', (i) => back.shown.push(i));
    back.ctx = { app: back, shell: true, quit() {} };
    await back.connect();
    await until(() => notes(back).some((t) => /removed from #den/i.test(t)), 'ben to be told when he returns');
    await assert.rejects(runCommand(back.ctx, 'join den'), /removed/);

    // cat was never in: she can be kept out ahead of time, and an invite is cancelled
    await runCommand(ann.ctx, 'invite cat den');
    await until(() => cat.invites.has('den'), "cat's invite");
    await runCommand(ann.ctx, 'kick cat den');
    assert.match(notes(ann).join('\n'), /cat wasn't in #den\. They're now kept out/);
    await assert.rejects(runCommand(cat.ctx, 'join den'), /removed/);
    await assert.rejects(runCommand(ann.ctx, 'kick nobody-here den'), /no user called/);

    // handing over: only the owner can, and the new owner gets the powers
    await runCommand(ann.ctx, 'invite cat den'); // the owner's invite lets her back in
    await runCommand(cat.ctx, 'join den');
    await until(() => ann.chat('#den').members.has('cat'), 'cat to join');
    await assert.rejects(runCommand(cat.ctx, 'give ann den'), /Only the owner/);
    await runCommand(ann.ctx, 'give cat den');
    await until(() => cat.chat('#den').owner === 'cat', 'cat to learn she owns it');
    assert.equal(ann.chat('#den').owner, 'cat');
    await assert.rejects(runCommand(ann.ctx, 'kick cat den'), /Only the owner/);
    await back.closeGracefully();
  } finally {
    for (const a of [ann, cat]) await a.closeGracefully();
    await relay.stop();
  }
});

test('chats: your People list is only who you added; mute, find and export', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  try {
    await ben.send('@ann', 'pizza on friday?');
    await until(() => ann.shown.some((i) => i.t === 'msg'), 'the message');
    assert.deepEqual(people(ann), [], 'being messaged does not put someone on your list');
    await runCommand(ann.ctx, 'add ben');
    assert.deepEqual(people(ann).map((p) => p.name), ['ben']);

    let bells = 0;
    ann.on('bell', () => { bells++; });
    await runCommand(ann.ctx, 'mute ben');
    assert.equal(ann.muted('@ben'), true);
    await ben.send('@ann', 'hello? pizza?');
    await until(() => ann.shown.filter((i) => i.t === 'msg').length === 2, 'the second message');
    assert.equal(bells, 0, 'a muted chat stays quiet');
    await runCommand(ann.ctx, 'mute ben');
    assert.equal(ann.muted('@ben'), false);

    ann.shown.length = 0;
    await runCommand(ann.ctx, 'find PIZZA');
    assert.match(table(ann), /2 messages mentioning "PIZZA"/);
    assert.match(table(ann), /ben: pizza on friday\?/);
    await runCommand(ann.ctx, 'find unicorns');
    assert.match(notes(ann).join('\n'), /Nothing saved/);

    const file = path.join(tmp(), 'out.txt');
    await runCommand(ann.ctx, `export ben ${file}`);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^gossip chat with ben, saved /);
    assert.match(text, /\] ben: pizza on friday\?\n/);
  } finally {
    await ann.closeGracefully();
    await ben.closeGracefully();
    await relay.stop();
  }
});

test('update notes: the changelog is readable and covers this version', () => {
  const log = U.changelog();
  assert.equal(log[0].version, U.currentVersion(), 'CHANGELOG.md starts with the version in package.json');
  assert.ok(log[0].lines.length > 0);
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'gossip.js'), 'changelog'], { encoding: 'utf8', env: { ...process.env, GOSSIP_HOME: tmp(), NO_COLOR: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`gossip ${U.currentVersion().replace(/\./g, '\\.')}\\s+\\(this one\\)`));
});

test('uninstall: removes the app and the command, keeps the account unless told otherwise', () => {
  const setup = () => {
    const root = tmp();
    fs.cpSync(REPO, path.join(root, 'app'), { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|docs)([\\/]|$)/.test(src) });
    const bin = path.join(root, 'elsewhere', 'gossip');
    fs.mkdirSync(path.dirname(bin));
    fs.writeFileSync(bin, '#!/bin/sh\n# gossip launcher - written by install.sh.\n');
    fs.writeFileSync(path.join(root, 'launcher'), bin + '\n');
    fs.writeFileSync(path.join(root, 'identity.json'), '{}');
    return { root, bin };
  };
  const run = (root, args) => spawnSync(process.execPath, [path.join(root, 'app', 'bin', 'gossip.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, GOSSIP_HOME: root, HOME: root, USERPROFILE: root, NO_COLOR: '1', GOSSIP_NO_UPDATE: '1' },
  });

  const a = setup();
  assert.match(run(a.root, ['uninstall']).stderr, /Add --yes/, 'never removes anything without a yes');
  assert.ok(fs.existsSync(path.join(a.root, 'app')));
  const r = run(a.root, ['delete', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gossip is removed\. Your account and messages are still in/);
  assert.equal(fs.existsSync(path.join(a.root, 'app')), false);
  assert.equal(fs.existsSync(a.bin), false);
  assert.ok(fs.existsSync(path.join(a.root, 'identity.json')), 'the account stays');

  const b = setup();
  assert.equal(run(b.root, ['uninstall', '--yes', '--everything']).status, 0);
  assert.equal(fs.existsSync(b.root), false);
});

test('penguin: solid areas are painted as backgrounds, so line spacing leaves no gaps', () => {
  const lines = M.still('dance', { mode: 'rgb' });
  assert.equal(lines.length, M.HEIGHT);
  assert.ok(!lines.join('').includes('█'), 'no full-block characters');
});

test('small things: emoji words, actions, notification commands', () => {
  const { emojify } = require('../src/text');
  assert.equal(emojify('nice :fire: at 12:30:45 :notaword:'), 'nice 🔥 at 12:30:45 :notaword:');

  const R = require('../src/render');
  const A = require('../src/ansi');
  const line = R.messageLines('ann', '@ben', { from: 'ben', ts: Date.now(), text: '/me waves' }, 80, true).map(A.strip).join('|');
  assert.match(line, /\* ben waves$/);
  assert.doesNotMatch(line, /\/me/);

  const notify = require('../src/notify');
  const mac = notify.command('gossip', 'say "hi" \\ there', 'darwin');
  assert.equal(mac[0], 'osascript');
  assert.equal(mac[1][1], 'display notification "say \\"hi\\" \\\\ there" with title "gossip"');
  assert.deepEqual(notify.command('t', 'b', 'linux'), ['notify-send', ['--app-name=gossip', '--', 't', 'b']]);
  assert.equal(notify.command('t', 'b', 'win32'), null);
  assert.equal(notify.message('off', '@ben', { from: 'ben', text: 'x' }), false);
});

test('penguin: the blocky style uses nothing but whole coloured cells', () => {
  const A = require('../src/ansi');
  const before = A.getLevel();
  A.setLevel(3);
  try {
    for (const scene of M.SCENE_NAMES) {
      const frames = [{ lines: M.still(scene, { style: 'blocky' }) }, ...M.play(scene, { style: 'blocky', loops: 1 })];
      for (const f of frames) {
        assert.equal(f.lines.length, M.HEIGHT);
        for (const line of f.lines) {
          assert.equal(A.vwidth(line), M.WIDTH);
          assert.doesNotMatch(A.strip(line), /[▀▄█]/, 'no half or full block characters');
          assert.doesNotMatch(line, /\x1b\[[0-9;]*\b7m/, 'no inverse video');
        }
      }
    }
  } finally {
    A.setLevel(before);
  }
});

test('accounts: change your username; friends follow; a second sign-in is noticed', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    await runCommand(ann.ctx, 'create den');
    await runCommand(ben.ctx, 'join den');
    await ben.send('@ann', 'before the change');
    await until(() => ann.shown.some((i) => i.t === 'msg'), 'the first message');
    await sleep(150); // let the "got it" reach the relay

    await assert.rejects(runCommand(ann.ctx, 'rename ben'), /taken/);
    await runCommand(ann.ctx, 'rename annie');
    assert.equal(ann.me, 'annie');
    assert.equal(new Vault(ann.dir).loadIdentity().name, 'annie');
    await until(() => notes(ben).some((t) => /ann is now called annie/.test(t)), 'ben to hear about it');
    assert.equal(ben.peers.get('ann'), undefined);
    assert.equal(ben.peers.get('annie').contact, true, 'still a contact, under the new name');
    assert.deepEqual(new Vault(ben.dir).conversations().filter((k) => k[0] === '@'), ['@annie'], 'the saved chat moved too');
    assert.equal(ben.chat('#den').owner, 'annie');

    await ben.send('@annie', 'after the change');
    await until(() => ann.shown.filter((i) => i.t === 'msg').length === 2, 'a message to the new name');
    await ann.send('@ben', 'still me');
    await until(() => ben.shown.some((i) => i.t === 'msg' && i.key === '@annie' && i.msg.text === 'still me'), 'a message from the new name');

    // the old name can't be taken by anyone else, and still leads to the same person
    await assert.rejects(new App({ vault: new Vault(tmp()), server: ann.serverUrl }).register('ann'), /taken/);
    const cat = await person(relay, 'cat');
    try {
      await runCommand(cat.ctx, 'add ann');
      assert.deepEqual(cat.peers.values().map((x) => `${x.name}:${x.contact}`), ['annie:true'], 'adding the old name finds them under the new one');
    } finally {
      await cat.closeGracefully();
    }

    // the same account opened somewhere else
    const second = new App({ vault: new Vault(ann.dir), server: ann.serverUrl, shell: true });
    second.shown = [];
    second.on('line', (i) => second.shown.push(i));
    await second.connect();
    try {
      assert.equal(second.me, 'annie');
      await until(() => notes(ann).some((t) => /just opened in 2 places/.test(t)), 'the first window to be warned');
      assert.ok(notes(second).some((t) => /open in 2 places/.test(t)));
      ann.shown.length = 0;
      await runCommand(ann.ctx, 'security');
      assert.match(table(ann), /Your account is open in 2 places/);
      await runCommand(ann.ctx, 'signout');
      await until(() => notes(second).some((t) => /signed out/.test(t)), 'the other window to be closed');
      await until(() => second.conn.state !== 'online', 'it to go offline');
    } finally {
      await second.closeGracefully();
    }
  } finally {
    await ann.closeGracefully();
    await ben.closeGracefully();
    await relay.stop();
  }
});

test('security: "strict" refuses a connection that is not encrypted', async () => {
  const dir = tmp();
  const app = new App({ vault: new Vault(dir), server: 'ws://203.0.113.9:8787', shell: true });
  app.createLocalIdentity('zed');
  const prefs = require('../src/prefs');
  prefs.set(app.vault, 'security', 'strict');
  app.settings = app.vault.loadSettings();
  try {
    await assert.rejects(app.connect({ retry: false }), /isn't an encrypted connection/);
  } finally {
    prefs.reset(app.vault, 'security');
    prefs.use(new Vault(tmp()).loadSettings());
    app.close();
  }
});

test('penguin: on "auto", macOS Terminal keeps the blocky penguin even after it reports its colours', () => {
  const M = require('../src/mascot');
  const was = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = 'Apple_Terminal';
  try {
    // a fresh copy, so the choice is made under macOS Terminal
    delete require.cache[require.resolve('../src/mascot')];
    const fresh = require('../src/mascot');
    assert.strictEqual(fresh.styleNow(), 'blocky');
    fresh.setBackdrop([20, 20, 20]); // the colour reply arrives (often when you start typing)
    assert.strictEqual(fresh.styleNow(), 'blocky', 'it does not switch to the detailed penguin');
  } finally {
    if (was === undefined) delete process.env.TERM_PROGRAM; else process.env.TERM_PROGRAM = was;
    delete require.cache[require.resolve('../src/mascot')];
    require('../src/mascot');
    void M;
  }
});

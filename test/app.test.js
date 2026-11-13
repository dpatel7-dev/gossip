'use strict';
// Drives whole clients (everything except the keyboard) against a real relay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Relay } = require('../server/relay');
const { App, normalizeServer } = require('../src/app');
const { Vault } = require('../src/vault');
const { runCommand, suggest, resolveTarget } = require('../src/commands');
const R = require('../src/render');
const A = require('../src/ansi');
const M = require('../src/mascot');
const Th = require('../src/theme');
const prefs = require('../src/prefs');
const e2e = require('../src/e2e');
const P = require('../src/proto');
const { Link } = require('../src/net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-app-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function startRelay() {
  const relay = new Relay({ port: 0, host: '127.0.0.1', quiet: true });
  await relay.start();
  relay.url = `ws://127.0.0.1:${relay.port}`;
  return relay;
}

// An app that records everything it would show.
function open(relay, dir, mode = 'live', shell = true) {
  const app = new App({ vault: new Vault(dir), server: relay.url, mode, shell });
  app.dir = dir;
  app.shown = [];
  app.on('line', (item) => app.shown.push(item));
  app.ctx = { app, shell, quit() {} };
  return app;
}

async function signUp(relay, name, mode = 'live') {
  const dir = tmp();
  const first = open(relay, dir);
  await first.register(name);
  const app = open(relay, dir, mode);
  await app.connect();
  return app;
}

const msgs = (app, key) => app.shown.filter((i) => i.t === 'msg' && (!key || i.key === key)).map((i) => `${i.key} ${i.msg.from}: ${i.msg.text}`);
const notes = (app) => app.shown.filter((i) => i.t === 'note').map((i) => i.text);

test('server addresses are normalised', () => {
  assert.equal(normalizeServer('chat.example.com'), 'wss://chat.example.com');
  assert.equal(normalizeServer('https://chat.example.com/'), 'https://chat.example.com', 'a website stays a website');
  assert.equal(normalizeServer('wss://chat.example.com/'), 'wss://chat.example.com');
  assert.equal(normalizeServer('localhost:8787'), 'ws://localhost:8787');
  assert.equal(normalizeServer('34.1.2.3:8787'), 'ws://34.1.2.3:8787');
  assert.throws(() => normalizeServer(''));
  assert.throws(() => normalizeServer('not a url'));
});

test('sign up, talk both ways, history survives a restart', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');

  // names are first come, first served
  const dupe = open(relay, tmp());
  await assert.rejects(dupe.register('alice'), /taken/);

  await runCommand(alice.ctx, 'squawk bob hello bob');
  assert.equal(alice.target, '@bob');
  await until(() => msgs(bob).length === 1, 'bob to receive');
  assert.deepEqual(msgs(bob), ['@alice alice: hello bob']);

  await bob.send('@alice', 'hi alice');
  await until(() => msgs(alice, '@bob').length === 2, 'alice to receive');
  assert.deepEqual(msgs(alice, '@bob'), ['@bob alice: hello bob', '@bob bob: hi alice']);

  // nothing readable on the relay, and nothing left there once delivered
  await sleep(120);
  assert.equal(relay.db.bodies.size, 0);

  // delivery receipt lands in history; a fresh process sees the whole conversation
  await until(() => alice.vault.loadHistory('@bob')[0].st === 'delivered', 'delivery receipt');
  alice.close();
  const again = open(relay, alice.dir);
  assert.equal(again.me, 'alice');
  assert.deepEqual(again.vault.loadHistory('@bob').map((r) => `${r.from}: ${r.text}`), ['alice: hello bob', 'bob: hi alice']);
  await runCommand(again.ctx, 'recap bob');
  assert.deepEqual(msgs(again), ['@bob alice: hello bob', '@bob bob: hi alice']);

  bob.close();
  await relay.stop();
});

test('gossip check: messages wait on the relay and are collected once', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  bob.close();
  await sleep(40);
  await alice.send('@bob', 'one');
  await alice.send('@bob', 'two');

  const check = open(relay, bob.dir, 'peek', false);
  await check.connect({ retry: false });
  await check.caughtUp();
  assert.deepEqual(msgs(check), ['@alice alice: one', '@alice alice: two']);
  await check.closeGracefully();
  await sleep(60);
  assert.equal(relay.db.queues.has('bob'), false);

  const again = open(relay, bob.dir, 'peek', false);
  await again.connect({ retry: false });
  await again.caughtUp();
  assert.deepEqual(msgs(again), [], 'nothing is shown twice');
  await again.closeGracefully();
  alice.close();
  await relay.stop();
});

test('gossip listen <who>: other conversations stay waiting for later', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const carol = await signUp(relay, 'carol');
  const bob = await signUp(relay, 'bob');
  bob.close();

  const listen = open(relay, bob.dir, 'live', false);
  listen.beforeMessages = async () => { listen.filter = await resolveTarget(listen, 'alice'); };
  await listen.connect();
  assert.equal(listen.filter, '@alice');
  await alice.send('@bob', 'from alice');
  await carol.send('@bob', 'from carol');
  await until(() => msgs(listen).length === 1, 'filtered message');
  await sleep(80);
  assert.deepEqual(msgs(listen), ['@alice alice: from alice']);
  await listen.closeGracefully();

  const check = open(relay, bob.dir, 'peek', false);
  await check.connect({ retry: false });
  await check.caughtUp();
  assert.deepEqual(msgs(check), ['@carol carol: from carol']);
  await check.closeGracefully();
  alice.close(); carol.close();
  await relay.stop();
});

test('typing while disconnected: messages wait and go out on reconnect', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  await alice.peerFor('bob');
  alice.link.conn.terminate();
  await until(() => alice.conn.state !== 'online', 'alice to notice');
  const sent = alice.send('@bob', 'written offline');
  assert.ok(notes(alice).some((t) => /offline/.test(t)));
  await sent;
  await until(() => msgs(bob).length === 1, 'delivery after reconnect', 6000);
  assert.deepEqual(msgs(bob), ['@alice alice: written offline']);
  alice.close(); bob.close();
  await relay.stop();
});

test('one-off commands fail fast instead of retrying forever', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  alice.close();
  await relay.stop();
  const app = open(relay, alice.dir, 'post', false);
  const t0 = Date.now();
  await assert.rejects(app.connect({ retry: false }), /can't reach/);
  assert.ok(Date.now() - t0 < 3000);
  app.close();
});

test('rooms: create, invite, join, talk; late joiners get what comes next', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  const carol = await signUp(relay, 'carol');

  await runCommand(alice.ctx, 'create club private');
  assert.equal(alice.target, '#club');
  await assert.rejects(runCommand(bob.ctx, 'join club'), /invite-only/);
  await runCommand(alice.ctx, 'invite bob');
  await until(() => bob.invites.has('club'), 'invite');
  await runCommand(bob.ctx, 'join club');
  await until(() => alice.chat('#club').members.has('bob'), 'alice to see bob join');

  await alice.send('#club', 'welcome bob');
  await until(() => msgs(bob, '#club').length === 1, 'room message');

  await runCommand(bob.ctx, 'invite carol club');
  await until(() => carol.invites.has('club'), 'invite 2');
  await runCommand(carol.ctx, 'join club');
  await until(() => alice.chat('#club').members.has('carol') && bob.chat('#club').members.has('carol'), 'everyone to see carol');
  await bob.send('#club', 'hi @carol');
  await until(() => msgs(carol, '#club').length === 1 && msgs(alice, '#club').length === 2, 'fan-out');
  assert.deepEqual(msgs(carol, '#club'), ['#club bob: hi @carol'], 'carol only sees messages from after she joined');

  // bare names resolve to the room, and "#" is never required
  assert.equal(await resolveTarget(alice, 'club'), '#club');
  assert.equal(await resolveTarget(alice, 'server:club'), '#club');
  assert.equal(await resolveTarget(alice, 'bob'), '@bob');
  await assert.rejects(resolveTarget(alice, '#nowhere'), /not in #nowhere/);
  await assert.rejects(resolveTarget(alice, 'nobody-at-all'), /no user/);

  await runCommand(carol.ctx, 'leave club');
  await until(() => !alice.chat('#club').members.has('carol'), 'leave event');
  await assert.rejects(carol.send('#club', 'still here?'), /not in #club/);

  await runCommand(alice.ctx, 'create lobby');
  await runCommand(bob.ctx, 'servers');
  assert.deepEqual(bob.knownRooms.map((r) => r.name), ['lobby'], 'private servers are not listed');

  for (const a of [alice, bob, carol]) a.close();
  await relay.stop();
});

test('a room joined from another terminal is picked up by the live one', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  await runCommand(alice.ctx, 'create den');

  // bob joins with a one-off command while his live prompt is open
  const oneOff = open(relay, bob.dir, 'post', false);
  await oneOff.connect({ retry: false });
  await runCommand(oneOff.ctx, 'join den');
  await oneOff.closeGracefully();
  await until(() => bob.rooms().includes('den'), 'live session to learn about the room');
  await until(() => alice.chat('#den').members.has('bob'), 'alice to see bob');

  await alice.send('#den', 'did you get this?');
  await until(() => msgs(bob, '#den').length === 1, 'room message in the live session');
  alice.close(); bob.close();
  await relay.stop();
});

test('server owners can kick; everyone sees it and the kicked person is locked out', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  const carol = await signUp(relay, 'carol');
  await runCommand(alice.ctx, 'create den');
  await runCommand(bob.ctx, 'join den');
  await runCommand(carol.ctx, 'join den');
  assert.equal(bob.chat('#den').owner, 'alice');
  await until(() => alice.chat('#den').members.size === 3, 'all three in');

  await assert.rejects(runCommand(bob.ctx, 'kick carol'), /Only the owner/);
  await runCommand(alice.ctx, 'kick carol den');
  await until(() => notes(carol).some((t) => /You were removed from #den/.test(t)), 'carol to be told');
  await until(() => notes(bob).some((t) => /carol was removed from #den by alice/.test(t)), 'bob to see it');
  assert.equal(carol.rooms().includes('den'), false);
  assert.equal(bob.chat('#den').members.has('carol'), false);

  // after the kick, new messages are not encrypted for carol at all
  await alice.send('#den', 'just us now');
  await until(() => msgs(bob, '#den').length === 1, 'bob to receive');
  await sleep(80);
  assert.deepEqual(msgs(carol, '#den'), []);
  await assert.rejects(runCommand(carol.ctx, 'join den'), /removed/);
  await assert.rejects(carol.send('#den', 'hello?'), /not in #den/);

  for (const a of [alice, bob, carol]) a.close();
  await relay.stop();
});

test('settings: validation, themes, colour overrides and your own shortcuts', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  A.setLevel(3);

  // defaults, then a change that sticks across processes
  assert.equal(prefs.val('theme'), 'arctic');
  await runCommand(alice.ctx, 'config theme ember');
  assert.equal(new Vault(alice.dir).loadSettings().prefs.theme, 'ember');
  assert.deepEqual(Th.style('accent'), { fg: '#e0825a' });
  await runCommand(alice.ctx, 'config color.accent FF8800');
  assert.deepEqual(Th.style('accent'), { fg: '#ff8800', dim: false });
  await runCommand(alice.ctx, 'theme aurora');
  await runCommand(alice.ctx, 'config reset color.accent');
  assert.deepEqual(Th.style('accent'), { fg: '#5eead4' });

  // bad input is refused with a useful message, and nothing is saved
  await assert.rejects(runCommand(alice.ctx, 'config theme neon'), /theme can be: arctic/);
  await assert.rejects(runCommand(alice.ctx, 'config recap 500'), /whole number from 0 to 50/);
  await assert.rejects(runCommand(alice.ctx, 'config nonsense on'), /no setting called "nonsense"/);
  await assert.rejects(runCommand(alice.ctx, 'config color.sky #fff'), /no colour called "sky"/);
  await assert.rejects(runCommand(alice.ctx, 'config color.accent bluish'), /isn't a colour/);
  await assert.rejects(runCommand(alice.ctx, 'config prompt.symbol toolong'), /at most 3/);
  assert.equal(prefs.val('theme'), 'aurora');

  // what you set shows up in what gets printed
  await runCommand(alice.ctx, 'config time 24h');
  await runCommand(alice.ctx, 'config you me');
  A.setLevel(0);
  const line = R.messageLines('alice', '@bob', { from: 'alice', ts: new Date(2026, 0, 5, 14, 3).getTime(), text: 'hi' }, 80)[0];
  assert.equal(line, '14:03  me → bob: hi');
  await runCommand(alice.ctx, 'config time off');
  assert.equal(R.messageLines('alice', '@bob', { from: 'bob', ts: Date.now(), text: 'hi' }, 80)[0], ' bob: hi');

  // your own shortcut
  await runCommand(alice.ctx, 'config alias.b squawk bob');
  await runCommand(alice.ctx, 'b made with a shortcut');
  await until(() => msgs(bob).length === 1, 'aliased message');
  assert.deepEqual(msgs(bob), ['@alice alice: made with a shortcut']);
  assert.ok(suggest(alice, '/b').items.some((i) => i.label === '/b' && /shortcut/.test(i.desc)));

  // privacy switches really switch things off
  await runCommand(alice.ctx, 'config typing off');
  alice.setTarget('@bob');
  alice.typingPing();
  await sleep(80);
  assert.equal(bob.chat('@alice').typing.size, 0);

  await runCommand(alice.ctx, 'config reset all');
  assert.deepEqual(new Vault(alice.dir).loadSettings().prefs, {});
  assert.equal(prefs.val('theme'), 'arctic');

  // the one hidden quirk stays hidden
  const help = JSON.stringify(require('../src/commands').helpRows(true)) + JSON.stringify(require('../src/commands').helpRows(false));
  assert.equal(/shitty/i.test(help), false);
  assert.equal(suggest(alice, '/sh'), null);
  await runCommand(alice.ctx, 'shitty');
  assert.ok(notes(alice).some((t) => /ShiTTY/.test(t)));

  alice.close(); bob.close();
  await relay.stop();
});

test('the penguin: every frame is the right size in every colour mode', () => {
  for (const level of [3, 2, 0]) {
    A.setLevel(level);
    for (const mode of ['rgb', 'ansi', 'mono']) {
      for (const name of M.SCENE_NAMES) {
        const frames = M.play(name, { mode, loops: 1 }).map((f) => f.lines).concat([M.still(name, { mode })]);
        assert.ok(frames.length > 4);
        for (const lines of frames) {
          assert.equal(lines.length, M.HEIGHT);
          for (const l of lines) assert.equal(A.vwidth(l), M.WIDTH, `${name}/${mode}: "${A.strip(l)}"`);
        }
      }
    }
  }
  assert.ok(M.SCENE_NAMES.includes(M.pickScene('random')));
  assert.equal(M.pickScene('laptop'), 'laptop');
  // slower setting = longer frames
  assert.ok(M.play('dance', { speed: 'slow' })[0].ms > M.play('dance', { speed: 'fast' })[0].ms);
});

test('the welcome panel fits any window, in every theme and layout', () => {
  A.setLevel(3);
  const sprite = M.still('dance', { mode: 'rgb' });
  for (const theme of prefs.THEME_NAMES) {
    for (const welcome of ['full', 'compact', 'off']) {
      prefs.use({ prefs: { theme, welcome } });
      for (let cols = 20; cols <= 200; cols += 3) {
        for (const s of [sprite, null]) {
          const lines = R.welcome({ me: 'someone-with-a-long-n', host: 'a-really-long-relay-name.example.com:8787', firstRun: false, status: ['● connected · end-to-end encrypted', '12 contacts (3 online) · 4 servers'], sprite: s }, cols);
          for (const l of lines) assert.ok(A.vwidth(l) <= Math.max(cols, 44), `${theme}/${welcome} at ${cols}: ${A.vwidth(l)} wide`);
        }
      }
    }
  }
  // the full box is square: every row the same width
  prefs.use({ prefs: {} });
  const box = R.welcome({ me: 'dhruv', host: 'chat.example.com', firstRun: true, status: ['a', 'b'], sprite }, 100).filter((l) => l.trim());
  assert.equal(new Set(box.map((l) => A.vwidth(l))).size, 1, 'box rows line up');
  assert.match(A.strip(box.join('\n')), /Welcome, dhruv/);
  A.setLevel(0);
});

test('contacts are shared between terminals; presence is mutual; blocking is silent', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');

  // alice adds bob from a second process: the first one notices via the shared file
  const second = open(relay, alice.dir, 'post', false);
  await second.connect({ retry: false });
  await runCommand(second.ctx, 'add bob');
  await second.closeGracefully();
  assert.equal(alice.peers.get('bob').contact, true);
  alice._lastFileCheck = 0;
  alice.tick();
  await until(() => alice.presence.has('bob'), 'contact list to refresh');
  assert.equal(alice.presence.get('bob'), false, 'not mutual yet');
  await runCommand(bob.ctx, 'add alice');
  await until(() => alice.presence.get('bob') === true, 'mutual presence');

  await assert.rejects(runCommand(alice.ctx, 'add nobody-here'), /no user/i);
  await assert.rejects(runCommand(alice.ctx, 'add alice'), /you/i);
  await assert.rejects(runCommand(alice.ctx, 'frobnicate'), /no "frobnicate"/);
  await assert.rejects(runCommand(alice.ctx, 'jion x'), /Did you mean \/join/);
  await assert.rejects(runCommand(second.ctx, 'quit'), /no "quit"/, 'prompt-only commands are not offered in the shell');

  await runCommand(bob.ctx, 'hush alice');
  await alice.send('@bob', 'can you see this?');
  await sleep(120);
  assert.deepEqual(msgs(bob), [], 'blocked message never arrives');

  alice.close(); bob.close();
  await relay.stop();
});

test('a swapped key is caught, and sending pauses until you trust it', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  await alice.send('@bob', 'first');
  const original = alice.peers.get('bob').signPub;

  // The relay now claims "bob" has a different key (a reinstall... or an impostor).
  bob.close();
  await sleep(30);
  relay.db.users.delete('bob');
  relay.db.queues.delete('bob');
  const impostor = await signUp(relay, 'bob');
  alice.link.conn.terminate(); // new connection -> keys are re-checked
  await until(() => alice.conn.state === 'online' && !alice.syncing, 'alice back online', 6000);

  await assert.rejects(alice.send('@bob', 'second'), { code: 'key_changed' });
  assert.equal(alice.peers.get('bob').signPub, original, 'the pinned key is not silently replaced');
  assert.ok(alice.peers.get('bob').changed);
  assert.ok(notes(alice).some((t) => /security key has changed/.test(t)));
  await sleep(80);
  assert.deepEqual(msgs(impostor), [], 'nothing was encrypted to the new key');

  await runCommand(alice.ctx, 'trust bob');
  await alice.send('@bob', 'third');
  await until(() => msgs(impostor).length === 1, 'delivery after trust');
  assert.deepEqual(msgs(impostor), ['@alice alice: third']);

  alice.close(); impostor.close();
  await relay.stop();
});

test('hostile message text cannot inject terminal escape codes', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  // a hand-rolled client that skips the app's own cleaning
  const identity = e2e.createIdentity();
  const link = new Link({ url: relay.url, identity, name: 'mallory' });
  await new Promise((resolve) => { link.once('ready', resolve); link.start(); });
  const { user } = await link.request('lookup', { name: 'alice' });
  const evil = 'hi\x1b[2J\x1b]0;pwned\x07\x1b[31m there‮\r\nnext\x00line';
  await link.request('send', {
    env: e2e.seal({ identity, from: 'mallory', conv: P.dmConv('mallory', 'alice'), recipients: [user], payload: { text: evil } }),
  });
  await until(() => msgs(alice).length === 1, 'message');
  const got = alice.shown.find((i) => i.t === 'msg').msg.text;
  assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f‮]/.test(got), false);
  assert.equal(got, 'hi[2J]0;pwned[31m there\nnextline');
  assert.equal(fs.readFileSync(path.join(alice.dir, 'history', 'dm-mallory.jsonl'), 'utf8').includes('\\u001b'), false);
  // and what gets printed has no escape codes beyond gossip's own colours
  A.setLevel(0);
  for (const line of R.messageLines('alice', '@mallory', alice.shown.find((i) => i.t === 'msg').msg, 80)) {
    assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(line), false);
  }
  link.stop(); alice.close();
  await relay.stop();
});

test('suggestions in the live prompt', async () => {
  const relay = await startRelay();
  const alice = await signUp(relay, 'alice');
  const bob = await signUp(relay, 'bob');
  await runCommand(alice.ctx, 'add bob');
  await runCommand(alice.ctx, 'create den');
  assert.equal(suggest(alice, 'hello'), null);
  assert.equal(suggest(alice, ''), null);
  assert.equal(suggest(alice, '//not a command'), null);
  const all = suggest(alice, '/');
  assert.equal(all.stage, 'cmd');
  assert.ok(all.items.length >= 15);
  assert.deepEqual(suggest(alice, '/sq').items.map((i) => i.label), ['/squawk']);
  assert.equal(suggest(alice, '/flock').items[0].label, '/contacts', 'aliases resolve');
  assert.deepEqual(suggest(alice, '@').items.map((i) => i.value), ['@bob']);
  assert.deepEqual(suggest(alice, '#d').items.map((i) => i.value), ['#den']);
  assert.deepEqual(suggest(alice, '/squawk ').items.map((i) => i.value), ['/squawk @bob', '/squawk #den']);
  assert.equal(suggest(alice, '/squawk bob hello'), null);
  assert.equal(suggest(alice, '/zzz'), null);
  alice.close(); bob.close();
  await relay.stop();
});

test('printed lines fit the window at any width', () => {
  prefs.use({ prefs: {} });
  A.setLevel(3);
  const msg = (text, from = 'alice') => ({ id: 'x', from, ts: Date.now(), text });
  const samples = [
    ['@bob', msg('short')],
    ['@bob', msg('long '.repeat(60) + 'https://example.com/' + 'x'.repeat(200), 'bob')],
    ['#a-room-with-quite-a-name', msg('emoji 👨‍👩‍👧 wide 日本語のテキスト and a\nsecond line\n\n  indented', 'someone-with-a-long-n')],
    ['#den', msg('@alice ' + 'word '.repeat(40))],
  ];
  for (let cols = 20; cols <= 200; cols += 7) {
    for (const [key, m] of samples) {
      R.messageLines('alice', key, m, cols).forEach((line, i) => {
        // (in a very narrow window the "who said it" header may wrap; the text itself never should)
        if (i === 0 && cols < 64) return;
        assert.ok(A.vwidth(line) <= Math.max(24, cols - 1), `cols ${cols}: ${A.vwidth(line)} wide: ${JSON.stringify(A.strip(line))}`);
      });
    }
    for (const line of R.noteLines('warn', 'something fairly long happened and needs a couple of lines to explain properly '.repeat(2), cols)) {
      assert.ok(A.vwidth(line) <= Math.max(25, cols), `note at ${cols}`);
    }
  }
  A.setLevel(0);
  assert.deepEqual(R.messageLines('alice', '@bob', { from: 'bob', ts: new Date(2026, 0, 5, 14, 3).getTime(), text: 'hello\nthere' }, 80).map((l, i) => (i === 0 ? l.replace(/^\s*\S+( [AP]M)?/, 'TIME') : l)), [
    'TIME  bob: hello',
    '          there',
  ]);
});

test('the contact book is shared safely between processes', () => {
  const dir = tmp();
  const a = new Vault(dir);
  const b = new Vault(dir);
  a.peers.update('maya', () => ({ name: 'maya', signPub: 'k', contact: true }));
  assert.equal(b.peers.get('maya').contact, true, 'the other process sees the change');
  b.peers.update('sam', () => ({ name: 'sam', signPub: 'k2', contact: false }));
  a.peers.update('maya', (cur) => ({ ...cur, verified: true }));
  assert.deepEqual(b.peers.values().map((p) => p.name).sort(), ['maya', 'sam'], 'neither write clobbered the other');
  assert.equal(b.peers.get('maya').verified, true);
  a.updateSettings((s) => { s.bell = false; });
  b.updateSettings((s) => { s.server = 'ws://x'; });
  assert.deepEqual([a.loadSettings().bell, a.loadSettings().server], [false, 'ws://x']);
});

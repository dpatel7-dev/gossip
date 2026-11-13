'use strict';
// Drives real clients against the gossip website (hub/gossip_hub.py), the same
// way app.test.js drives them against the relay. Skipped when there's no python3.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { App, resolveServer, probeServer } = require('../src/app');
const { Vault } = require('../src/vault');
const { runCommand } = require('../src/commands');
const e2e = require('../src/e2e');

const HUB = path.join(__dirname, '..', 'hub', 'gossip_hub.py');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const opts = { skip: PY ? false : 'python3 is not installed' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what = 'condition', ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const dirs = [];
const procs = [];
const apps = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-hub-'));
  dirs.push(d);
  return d;
}
test.after(async () => {
  for (const a of apps) a.close();
  await sleep(100);
  for (const p of procs) p.kill();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function startHub(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [HUB, '--port', '0', '--host', '127.0.0.1', '--data', tmp(), '--quiet'], {
      env: { ...process.env, GOSSIP_PURE_CRYPTO: '1', PYTHONUNBUFFERED: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    let out = '';
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ url: `http://127.0.0.1:${m[1]}`, child, errors: () => err });
    });
    child.on('exit', (code) => reject(new Error(`hub exited (${code}): ${err}`)));
  });
}

function open(hub, dir, mode = 'live') {
  const app = new App({ vault: new Vault(dir), server: hub.url, mode, shell: true });
  app.shown = [];
  app.flashes = [];
  app.on('line', (item) => app.shown.push(item));
  app.on('flash', (t) => app.flashes.push(t));
  app.ctx = { app, shell: true, quit() {} };
  apps.push(app);
  return app;
}

async function signUp(hub, name, mode = 'live') {
  const dir = tmp();
  await open(hub, dir).register(name);
  const app = open(hub, dir, mode);
  app.dir = dir;
  await app.connect();
  return app;
}

const msgs = (app, key) => app.shown.filter((i) => i.t === 'msg' && (!key || i.key === key)).map((i) => `${i.key} ${i.msg.from}: ${i.msg.text}`);
const notes = (app) => app.shown.filter((i) => i.t === 'note').map((i) => i.text);

test('the pure-Python signature check agrees with Node', opts, () => {
  const id = e2e.createIdentity();
  const proof = e2e.authProof(id, 'nonce-123', 'alice');
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.dirname(HUB))})
import gossip_hub as g
a = json.loads(sys.argv[1])
text = 'gossip/v1/auth\\nnonce-123\\nalice'
pure = lambda sig, t=text: g._verify_pure(g._unb64(a['pub']), t.encode(), g._unb64(sig))
print(json.dumps([pure(a['sig']), pure(a['sig'], text + '!'), pure(a['other']), g.valid_bundle(a['bundle']), g.verify_text(a['pub'], text, a['sig'])]))
`;
  const other = e2e.authProof(e2e.createIdentity(), 'nonce-123', 'alice');
  const r = spawnSync(PY, ['-c', script, JSON.stringify({ pub: id.signPub, sig: proof, other, bundle: e2e.bundleOf(id) })], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [true, false, false, true, true]);
});

test('website: sign up, direct messages, delivery receipts, waiting messages', opts, async () => {
  const hub = await startHub();
  assert.equal((await probeServer(hub.url)).gossip, true);
  assert.equal(await resolveServer(hub.url.replace('http://', '')), hub.url, 'a bare address is recognised as a website');

  const alice = await signUp(hub, 'alice');
  const bob = await signUp(hub, 'bob');

  await alice.send('@bob', 'hello over the web');
  await until(() => msgs(bob).length === 1, 'bob to get the message');
  assert.deepEqual(msgs(bob), ['@alice alice: hello over the web']);
  await until(() => alice.flashes.includes('delivered to bob'), 'the delivery receipt');

  await bob.send('@alice', 'got it');
  await until(() => msgs(alice, '@bob').length === 2, 'the reply');

  // the same name with different keys is refused
  await assert.rejects(open(hub, tmp()).register('alice'), /taken/);

  // messages wait on the website while someone is away, and `check` collects them
  await bob.closeGracefully();
  await alice.send('@bob', 'one');
  await alice.send('@bob', 'two');
  const peek = open(hub, bob.dir, 'peek');
  await peek.connect({ retry: false });
  await peek.caughtUp();
  assert.deepEqual(msgs(peek), ['@alice alice: one', '@alice alice: two']);
  await peek.closeGracefully();
  const again = open(hub, bob.dir, 'peek');
  await again.connect({ retry: false });
  await again.caughtUp();
  assert.deepEqual(msgs(again), [], 'confirmed messages are deleted from the website');
  await again.closeGracefully();
  await alice.closeGracefully();
  assert.equal(hub.errors(), '');
});

test('website: servers, invites, kicking, presence, typing and blocking', opts, async () => {
  const hub = await startHub();
  const ann = await signUp(hub, 'ann');
  const ben = await signUp(hub, 'ben');
  const cat = await signUp(hub, 'cat');

  await runCommand(ann.ctx, 'create club private');
  await assert.rejects(runCommand(ben.ctx, 'join club'), /invite-only/);
  await runCommand(ann.ctx, 'invite ben club');
  await until(() => ben.invites.has('club'), 'the invite');
  await runCommand(ben.ctx, 'join club');
  await until(() => notes(ann).some((t) => /ben joined #club/.test(t)), 'the join notice');
  await runCommand(ann.ctx, 'invite cat club');
  await until(() => cat.invites.has('club'), "cat's invite");
  await runCommand(cat.ctx, 'join club');
  await until(() => ann.chat('#club').members.size === 3, 'three members');

  await ann.send('#club', 'welcome both');
  await until(() => msgs(ben, '#club').length === 1 && msgs(cat, '#club').length === 1, 'the server message');

  // only the owner can remove someone; afterwards they get nothing and can't rejoin
  await assert.rejects(runCommand(ben.ctx, 'kick cat club'), /Only the owner/);
  await runCommand(ann.ctx, 'kick cat club');
  await until(() => notes(cat).some((t) => /You were removed from #club/.test(t)), 'the kicked notice');
  await until(() => !ben.chat('#club').members.has('cat'), 'ben to see the removal');
  await ann.send('#club', 'just us now');
  await until(() => msgs(ben, '#club').length === 2, "ben's copy");
  await sleep(1300);
  assert.equal(msgs(cat, '#club').length, 1, 'nothing reaches someone who was removed');
  await assert.rejects(runCommand(cat.ctx, 'join club'), /removed/);

  // presence is mutual and arrives without asking
  await runCommand(ann.ctx, 'add ben');
  await runCommand(ben.ctx, 'add ann');
  await until(() => ann.presence.get('ben') === true && ben.presence.get('ann') === true, 'both to look online');
  ben.target = '@ann';
  ben.typingPing();
  await until(() => ann.typingText() === 'ben is typing…', 'the typing note');
  await ben.closeGracefully();
  await until(() => ann.presence.get('ben') === false, 'ben to look offline');

  // a blocked person's messages never arrive
  await runCommand(ann.ctx, 'block cat');
  await cat.send('@ann', 'hello?');
  await sleep(1300);
  assert.equal(msgs(ann, '@cat').length, 0);
  await ann.closeGracefully();
  await cat.closeGracefully();
  assert.equal(hub.errors(), '');
});

test('website: serves the page and an installer that points back at itself', opts, async () => {
  const hub = await startHub();
  const get = async (p) => {
    const res = await fetch(hub.url + p);
    return { status: res.status, text: await res.text() };
  };
  const sh = await get('/install.sh');
  assert.equal(sh.status, 200);
  assert.match(sh.text, new RegExp(`^#!/bin/sh\\nGOSSIP_HUB="\\$\\{GOSSIP_HUB:-${hub.url}\\}"\\n`));
  const ps = await get('/install.ps1');
  assert.match(ps.text, new RegExp(`^if \\(-not \\$env:GOSSIP_HUB\\) \\{ \\$env:GOSSIP_HUB = '${hub.url}' \\}\\n`));
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /gossip/);
  if (fs.existsSync(path.join(__dirname, '..', 'site', 'index.html'))) assert.ok(page.text.includes(`"sh":"${hub.url}/install.sh"`) || page.text.includes(`"sh": "${hub.url}/install.sh"`));
  assert.equal((await get('/nope')).status, 404);
  assert.match((await get('/healthz')).text, /^gossip v/);
  // a Host header can't smuggle anything into the script
  const evil = await new Promise((resolve, reject) => {
    const req = require('http').get(hub.url + '/install.sh', { headers: { host: 'x";touch /tmp/pwned;"' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
  });
  assert.match(evil, /^#!\/bin\/sh\n# gossip installer/, 'a strange Host header gets the plain installer');
  assert.doesNotMatch(evil, /pwned/);
});

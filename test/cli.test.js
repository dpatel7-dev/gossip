'use strict';
// Runs the real `gossip` command the way a shell would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Relay } = require('../server/relay');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');

const BIN = path.join(__dirname, '..', 'bin', 'gossip.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function gossip(home, args, { input, wait = true } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, GOSSIP_HOME: home, NO_COLOR: '1', TZ: 'UTC' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  if (wait) return done;
  return { child, done, read: () => out, readErr: () => err };
}

async function account(relay, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-cli-'));
  dirs.push(dir);
  const app = new App({ vault: new Vault(dir), server: relay.url });
  await app.register(name);
  return dir;
}

test('gossip squawk / check / recap / listen from a shell', async () => {
  const relay = new Relay({ port: 0, host: '127.0.0.1', quiet: true });
  await relay.start();
  relay.url = `ws://127.0.0.1:${relay.port}`;
  const alice = await account(relay, 'alice');
  const bob = await account(relay, 'bob');

  let r = await gossip(alice, ['squawk', 'bob', 'hello', 'from', 'the', 'shell']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /✓ sent to bob/);
  assert.doesNotMatch(r.out, /hello from the shell/, 'your own message is not echoed back');

  // piped input becomes the message
  r = await gossip(alice, ['squawk', 'bob'], { input: 'build finished: 42 passed\n' });
  assert.equal(r.code, 0, r.err);

  r = await gossip(bob, ['check']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2 new messages/);
  assert.match(r.out, /alice: hello from the shell/);
  assert.match(r.out, /alice: build finished: 42 passed/);

  r = await gossip(bob, ['check']);
  assert.match(r.out, /Nothing new\./);

  r = await gossip(bob, ['recap', 'alice', '1']);
  assert.match(r.out, /alice: build finished: 42 passed/);
  assert.doesNotMatch(r.out, /hello from the shell/);

  // rooms from the shell, with bare names (no # needed)
  r = await gossip(alice, ['create', 'den']);
  assert.match(r.out, /Created #den/);
  r = await gossip(bob, ['join', 'den']);
  assert.match(r.out, /Joined #den - 2 members/);
  r = await gossip(bob, ['who', 'den']);
  assert.match(r.out, /alice/);
  assert.match(r.out, /bob \(you\)/);

  // listen: stays up, prints as messages arrive, stops cleanly on Ctrl+C
  const l = gossip(bob, ['listen'], { wait: false });
  for (let i = 0; i < 100 && !/listening as bob/.test(l.readErr()); i++) await sleep(30);
  assert.match(l.readErr(), /listening as bob/);
  r = await gossip(alice, ['squawk', 'den', 'anyone', 'home?']);
  assert.match(r.out, /sent to #den/);
  for (let i = 0; i < 100 && !/anyone home/.test(l.read()); i++) await sleep(30);
  assert.match(l.read(), /alice in #den: anyone home\?/);
  l.child.kill('SIGINT');
  assert.equal((await l.done).code, 0);

  // the owner removes someone, from the shell
  r = await gossip(bob, ['kick', 'alice', 'den']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Only the owner of #den \(alice\)/);
  r = await gossip(alice, ['kick', 'bob', 'den']);
  assert.match(r.out, /Removed bob from #den/);
  r = await gossip(bob, ['check']);
  assert.match(r.out + r.err, /You were removed from #den by its owner, alice/);
  r = await gossip(bob, ['join', 'den']);
  assert.equal(r.code, 1);
  assert.match(r.err, /removed from #den by its owner/);

  // settings from the shell
  r = await gossip(alice, ['config', 'theme', 'ember']);
  assert.match(r.out, /theme is now ember/);
  r = await gossip(alice, ['config']);
  assert.match(r.out, /theme\s+ember/);
  assert.match(r.out, /prompt\.style\s+box/);
  r = await gossip(alice, ['config', 'theme', 'neon']);
  assert.equal(r.code, 1);
  r = await gossip(alice, ['theme']);
  assert.match(r.out, /arctic[\s\S]*ember[\s\S]*aurora[\s\S]*daylight[\s\S]*terminal[\s\S]*mono/);
  r = await gossip(alice, ['config', 'alias.yo', 'squawk bob']);
  assert.equal(r.code, 0, r.err);
  r = await gossip(alice, ['yo', 'via', 'my', 'alias']);
  assert.match(r.out, /sent to bob/);
  r = await gossip(alice, ['dance', 'laptop']); // not a terminal here: prints one still picture
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.split('\n').filter((l) => /[█▀▄░▒]/.test(l)).length === 8, 'eight lines of penguin');

  r = await gossip(alice, ['whoami']);
  assert.match(r.out, /username\s+alice/);
  assert.match(r.out, /fingerprint\s+([0-9A-F]{4} ){7}[0-9A-F]{4}/);

  await relay.stop();
});

test('mistakes get a clear message and a non-zero exit code', async () => {
  const relay = new Relay({ port: 0, host: '127.0.0.1', quiet: true });
  await relay.start();
  relay.url = `ws://127.0.0.1:${relay.port}`;
  const alice = await account(relay, 'alice');

  let r = await gossip(alice, ['squawk', 'nobody-here', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no user called nobody-here/i);

  r = await gossip(alice, ['squawk', 'alice', 'hi me']);
  assert.equal(r.code, 1);
  assert.match(r.err, /That's you/);

  r = await gossip(alice, ['squawk']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Usage: gossip squawk <who> <message>/);

  r = await gossip(alice, ['chekc']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Did you mean: gossip check\?/);

  r = await gossip(alice, ['quit']);
  assert.equal(r.code, 2, 'prompt-only commands are not shell commands');

  // no account yet, and no keyboard to set one up with
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-cli-'));
  dirs.push(empty);
  r = await gossip(empty, ['check']);
  assert.equal(r.code, 1);
  assert.match(r.err, /No gossip account/);

  // the relay is gone: fail quickly instead of hanging
  await relay.stop();
  const t0 = Date.now();
  r = await gossip(alice, ['squawk', 'bob', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Can't reach 127\.0\.0\.1/);
  assert.ok(Date.now() - t0 < 5000);

  r = await gossip(alice, ['--version']);
  assert.match(r.out, /^gossip \d+\.\d+\.\d+/);
  r = await gossip(alice, ['help']);
  assert.match(r.out, /gossip squawk <who> <message>/);
  assert.match(r.out, /gossip kick <user> \[server\]/);
  assert.doesNotMatch(r.out, /shitty/i);
});

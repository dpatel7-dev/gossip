'use strict';
// `gossip <something>` typed in your shell lands here.
//
//   gossip                    open the live chat prompt
//   gossip check              print what arrived while you were away
//   gossip listen [who]       stay connected and print messages as they arrive
//   gossip squawk <who> <msg> send a message
//   ...and the rest of commands.js

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const A = require('./ansi');
const R = require('./render');
const Th = require('./theme');
const M = require('./mascot');
const T = require('./text');
const P = require('./proto');
const prefs = require('./prefs');
const pkg = require('../package.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gossip.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function makeApp(mode, extra = {}) {
  const { Vault } = require('./vault');
  const { App } = require('./app');
  return new App({ vault: new Vault(), config: loadConfig(), mode, ...extra });
}

const cols = () => process.stdout.columns || 80;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errLine = (text) => console.error(R.noteLines('err', text, process.stderr.columns || 80).join('\n'));

function die(text, code = 1) {
  errLine(text);
  process.exit(code);
}

/** Print whatever the app wants shown. */
function printer(app) {
  const p = new R.Printer(app.me);
  return (item) => {
    p.me = app.me;
    console.log(p.lines(item, cols()).join('\n'));
  };
}

const spriteOpts = () => ({ mode: Th.spriteMode(), speed: prefs.val('mascot.speed'), markStyle: R.markStyle() });

/** `gossip dance`: play a scene right here in the terminal. */
async function playInline(scene) {
  const opts = spriteOpts();
  const still = M.still(scene, opts);
  const show = (lines) => process.stdout.write(lines.map((l) => ' ' + l + A.RESET).join('\n') + '\n');
  console.log('');
  if (!process.stdout.isTTY || !prefs.on('mascot.animate')) {
    show(still);
    console.log('');
    return;
  }
  const frames = M.play(scene, { ...opts, loops: 2 });
  process.stdout.write('\x1b[?25l');
  const restore = () => process.stdout.write('\x1b[?25h');
  process.once('exit', restore);
  try {
    show(frames[0].lines);
    for (let i = 0; i < frames.length; i++) {
      await sleep(frames[i].ms);
      process.stdout.write(`\x1b[${M.HEIGHT}A`);
      show(i + 1 < frames.length ? frames[i + 1].lines : still);
    }
  } finally {
    restore();
  }
  console.log('');
}

// ── first run ───────────────────────────────────────────────────────────────

async function setup(app) {
  const { normalizeServer, probeServer } = require('./app');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die('No gossip account on this computer yet. Run `gossip` in a terminal once to set it up.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, escapeCodeTimeout: 50 });
  let cancelled = false;
  let finished = false;
  rl.on('SIGINT', () => rl.close());
  rl.on('close', () => { if (!finished) cancelled = true; });
  const ask = (q) => new Promise((resolve, reject) => {
    if (cancelled) return reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    const onClose = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    rl.once('close', onClose);
    rl.question(q, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
  const say = (kind, text) => console.log(R.noteLines(kind, text, cols()).join('\n'));
  const mark = '  ' + Th.accent2(prefs.val('prompt.symbol'), { bold: true }) + ' ';

  const side = [
    R.titleLine(),
    A.paint("Welcome - let's get you set up.", { bold: true }),
    Th.dim(app.serverUrl ? 'One quick question.' : 'Two quick questions.'),
  ];
  console.log('');
  side.forEach((l) => console.log('  ' + l));
  console.log('');

  try {
    while (!app.serverUrl) {
      console.log('  ' + A.bold('Which relay?') + Th.dim('  The address a friend gave you, or your own (gossip serve).'));
      const answer = await ask(mark);
      try {
        const url = normalizeServer(answer);
        await probeServer(url);
        app.settings = app.vault.updateSettings((s) => { s.server = url; });
        say('ok', `Found a gossip relay at ${url}`);
        console.log('');
      } catch (e) {
        say('err', e.message.startsWith('Type') || e.message.startsWith('That') ? e.message : `Couldn't connect: ${e.message}`);
      }
    }
    for (;;) {
      console.log('  ' + A.bold('Pick a username.') + Th.dim('  3-20 characters: a-z, 0-9, _ and -'));
      const name = P.cleanName(await ask(mark));
      if (!P.validName(name)) {
        say('err', P.RESERVED.has(name) ? `"${name}" is reserved - pick another.` : P.NAME_HELP);
        continue;
      }
      try {
        await app.register(name);
        say('ok', `You're ${name}. Your keys were made on this computer and never leave it.`);
        break;
      } catch (e) {
        say('err', e.message.charAt(0).toUpperCase() + e.message.slice(1));
        if (e.code === 'network') console.log('  ' + Th.dim(`(relay: ${app.serverUrl} - change it with: gossip relay <address>)`));
      }
    }
  } catch (e) {
    rl.close();
    if (e.code === 'cancelled') {
      console.log('');
      process.exit(130);
    }
    throw e;
  }
  // (close() is also what makes readline let go of the keyboard - don't strip its listeners)
  finished = true;
  rl.close();
}

/** Returns true if the first-run setup just happened. */
async function ensureAccount(app) {
  if (app.identity) return false;
  await setup(app);
  return true;
}

// ── commands that are their own thing ───────────────────────────────────────

async function live() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die('The chat prompt is interactive - run `gossip` directly in a terminal. For scripts, use `gossip check` or `gossip squawk`.');
  }
  const app = makeApp('live', { shell: true });
  const firstRun = await ensureAccount(app);
  await require('./shitty').run(app, { firstRun });
  await app.closeGracefully();
}

async function check() {
  const app = makeApp('peek');
  await ensureAccount(app);
  const items = [];
  app.on('line', (item) => items.push(item));
  await app.connect({ retry: false });
  await app.caughtUp();
  await app.closeGracefully();

  const count = items.filter((i) => i.t === 'msg').length;
  if (!items.length) {
    console.log(R.noteLines('sys', 'Nothing new.', cols()).join('\n'));
    return;
  }
  if (count) console.log(Th.dim(`  ${T.plural(count, 'new message')}`));
  const print = printer(app);
  for (const item of items) print(item);
}

async function listen(args) {
  const { resolveTarget, pretty } = require('./commands');
  const app = makeApp('live');
  await ensureAccount(app);
  const status = (text) => console.error(Th.dim(`  ${text}`));
  app.on('line', printer(app));
  if (args[0]) {
    app.beforeMessages = async () => {
      if (!app.filter) app.filter = await resolveTarget(app, args[0]);
    };
  }
  let wasOnline = false;
  app.on('state', (state, detail) => {
    if (state === 'online' && wasOnline === null) status('● back online');
    if (state === 'offline' && wasOnline) {
      status(`○ offline (${detail.message || 'connection lost'}) - retrying`);
      wasOnline = null;
    }
    if (state === 'online') wasOnline = true;
  });
  const stop = () => {
    app.closeGracefully().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await app.connect({ retry: true });
  status(`listening as ${app.me}${app.filter ? ` to ${pretty(app.filter)} only` : ''} on ${app.link.host}  ·  Ctrl+C to stop`);
  await new Promise(() => {}); // until Ctrl+C
}

function update() {
  const { spawnSync } = require('child_process');
  const cfg = loadConfig();
  const repo = process.env.GOSSIP_REPO || cfg.repo || '';
  const branch = process.env.GOSSIP_BRANCH || cfg.branch || 'main';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(branch)) {
    die('No valid GitHub repo is set in gossip.config.json, so there is nowhere to update from.');
  }
  const base = `https://raw.githubusercontent.com/${repo}/${branch}`;
  console.log(`  Updating gossip from github.com/${repo} ...`);
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${base}/install.ps1 | iex`], { stdio: 'inherit' })
    : spawnSync('sh', ['-c', `curl -fsSL ${base}/install.sh | sh`], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// commands that make sense before you have an account
const NO_ACCOUNT = new Set(['help', 'config', 'theme', 'mascot', 'dance', 'relay', 'shitty']);

async function oneShot(cmd, args) {
  const app = makeApp('post');
  if (!NO_ACCOUNT.has(cmd.name)) await ensureAccount(app);
  const print = printer(app);
  // (your own message isn't echoed back at you - "sent to maya" says it all)
  app.on('line', (item) => { if (!(item.t === 'msg' && item.msg.status === 'pending')) print(item); });
  if (cmd.net) await app.connect({ retry: false });
  const ctx = { app, shell: false, quit() {}, stdin: process.stdin.isTTY ? null : readStdin, play: playInline };
  await cmd.run(ctx, args, args.length ? ' ' + args.join(' ') : '');
  await app.closeGracefully();
}

// ── entry ───────────────────────────────────────────────────────────────────

function help() {
  const { helpRows } = require('./commands');
  const { Vault } = require('./vault');
  prefs.use(new Vault().loadSettings());
  console.log('');
  console.log(' ' + R.titleLine() + Th.dim('  ·  end-to-end encrypted chat that lives in your terminal'));
  console.log('');
  console.log(R.rowsLines(helpRows(false), Math.max(cols(), 110)).join('\n'));
  console.log('');
}

async function main(argv) {
  const { find, didYouMean } = require('./commands');
  const args = argv.slice();

  // gossip --relay <addr> [command...]
  const flag = /^(--relay|--server|-r|-s)(=.*)?$/;
  const si = args.findIndex((a) => flag.test(a));
  if (si >= 0) {
    const inline = args[si].includes('=');
    const value = inline ? args[si].slice(args[si].indexOf('=') + 1) : args[si + 1];
    if (!value) die('--relay needs an address, for example: gossip --relay chat.example.com', 2);
    args.splice(si, inline ? 1 : 2);
    const { Vault } = require('./vault');
    const { normalizeServer } = require('./app');
    try {
      const url = normalizeServer(value);
      new Vault().updateSettings((s) => { s.server = url; });
    } catch (e) {
      die(e.message, 2);
    }
  }

  const word = (args[0] || '').toLowerCase();
  const rest = args.slice(1);
  if (!word) return live();
  if (word === 'serve') {
    await require('../server/relay').serve(rest);
    return 'stay'; // the relay keeps the process alive
  }
  if (word === 'update') return update();
  if (word === 'check') return check();
  if (word === 'listen') return listen(rest);
  if (word === '--version' || word === '-v' || word === 'version') return console.log(`gossip ${pkg.version}`);
  if (word === '--help' || word === '-h' || word === 'help') return help();

  // your own shortcuts (alias.<word>) work from the shell too
  const { Vault } = require('./vault');
  prefs.use(new Vault().loadSettings());
  const mine = prefs.family('alias.');
  if (!find(word) && Object.prototype.hasOwnProperty.call(mine, word)) {
    const expanded = mine[word].split(/\s+/).concat(rest);
    const target = find(expanded[0]);
    if (target && target.where !== 'shell') return oneShot(target, expanded.slice(1));
  }

  const cmd = find(word);
  if (!cmd || cmd.where === 'shell') {
    const close = didYouMean(word, ['check', 'listen', 'serve', 'update']);
    die(`There's no "gossip ${word}".${close ? ` Did you mean: gossip ${close}?` : ''} See them all: gossip help`, 2);
  }
  return oneShot(cmd, rest);
}

function start(argv) {
  main(argv).then(
    (result) => {
      if (result === 'stay') return;
      // the chat prompt and setup read from the keyboard, which would keep the process alive
      if (process.stdin.isTTY) process.stdin.pause();
      process.exitCode = process.exitCode || 0;
      setTimeout(() => process.exit(), 50).unref();
    },
    (e) => {
      die(e && e.message ? e.message.charAt(0).toUpperCase() + e.message.slice(1) : String(e));
    },
  );
}

module.exports = { start, main };

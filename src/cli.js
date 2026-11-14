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
  const { resolveServer } = require('./app');
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
      console.log('  ' + A.bold('Where do your friends chat?') + Th.dim('  The address someone gave you: a gossip website or a relay.'));
      console.log('  ' + Th.dim('(No internet? Leave this and run: gossip nearby)'));
      const answer = await ask(mark);
      try {
        const url = await resolveServer(answer);
        app.settings = app.vault.updateSettings((s) => { s.server = url; });
        say('ok', `Found gossip at ${url}`);
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

/**
 * Open the chat. There are two looks - the full chat screen and the classic
 * scrolling prompt - and you can hop between them from the menu.
 */
async function live({ view = '', app = null, notice = null, firstRun = null, startup = null } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die('The chat is interactive - run `gossip` directly in a terminal. For scripts, use `gossip check` or `gossip squawk`.');
  }
  app = app || makeApp('live', { shell: true });
  if (firstRun === null) firstRun = await ensureAccount(app);
  if (!app.calls) app.calls = new (require('./call').Calls)(app);
  view = view || prefs.val('view');
  checkForUpdates();
  notice = notice || require('./update').news(prefs.val('update'));
  let restart = false;
  let last = view === 'mini' ? null : view; // where Esc in the mini chat goes back to
  for (;;) {
    if (view === 'mini') {
      const r = await require('./mini').run(app, { back: last });
      if (r && r.restart) { restart = true; break; }
      if (!r || !r.switch) break;
      view = r.switch;
      continue;
    }
    last = view;
    const screen = require('./screen');
    const full = view === 'full' && screen.fits();
    if (view === 'full' && !full) notice = notice || 'This window is too small for the full chat screen - here is the classic look instead.';
    const result = await (full ? screen : require('./shitty')).run(app, { firstRun, notice, startup });
    startup = null;
    if (result && result.restart) { restart = true; break; }
    if (!result || !result.switch) break;
    view = result.switch;
    firstRun = false;
    notice = null;
  }
  if (app.calls) app.calls.close();
  if (app.web) app.web.close();
  await app.closeGracefully();
  if (restart) {
    // Start again in a fresh process (which switches to a newly downloaded version first).
    const { spawn } = require('child_process');
    process.on('SIGINT', () => {}); // Ctrl+C belongs to the new one now
    const child = spawn(process.execPath, [process.argv[1]], { stdio: 'inherit' });
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c || 0));
      child.on('error', () => resolve(1));
    });
    process.exit(code);
  }
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

/**
 * gossip uninstall (or: gossip delete): take gossip off this computer.
 *   --yes          don't ask
 *   --everything   also delete your account keys, contacts and saved messages
 */
async function uninstall(args) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const U = require('./update');
  const { homeDir } = require('./vault');
  const say = (kind, text) => console.log(R.noteLines(kind, text, cols()).join('\n'));
  const where = U.install();
  const home = homeDir();
  if (!where.managed) {
    die(`This copy of gossip wasn't set up by the installer (it looks like a git clone), so there is nothing for me to remove. Delete the folder yourself: ${where.app}`);
  }
  let everything = args.includes('--everything');
  if (!args.includes('--yes') && !args.includes('-y')) {
    if (!process.stdin.isTTY) die('Add --yes to remove gossip without being asked.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => {
      rl.once('close', () => resolve(''));
      rl.question('  ' + q + ' ', resolve);
    });
    console.log('');
    const go = /^y/i.test((await ask(A.bold('Remove gossip from this computer?') + Th.dim(' (y/n)'))).trim());
    if (!go) { rl.close(); return say('sys', 'Nothing was removed.'); }
    if (!everything) {
      console.log('  ' + Th.dim('Your account (secret keys), contacts and saved messages can stay, so reinstalling picks up where you left off.'));
      everything = /^y/i.test((await ask(A.bold('Delete those too?') + Th.dim(" This can't be undone. (y/N)"))).trim());
    }
    rl.close();
  }

  const failed = [];
  const rm = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      failed.push(p);
    }
  };
  // the `gossip` command itself (only files the installer wrote)
  const launchers = [path.join(os.homedir(), '.local', 'bin', 'gossip'), path.join(where.root, 'bin', 'gossip.cmd')];
  try { launchers.unshift(fs.readFileSync(path.join(where.root, 'launcher'), 'utf8').trim()); } catch { /* older install */ }
  for (const file of new Set(launchers)) {
    try {
      if (/gossip launcher|GOSSIP_ROOT/.test(fs.readFileSync(file, 'utf8'))) rm(file);
    } catch { /* not there */ }
  }
  // the line the installer added to your shell's startup file
  for (const rc of ['.zshrc', '.bashrc', '.bash_profile', '.profile', path.join('.config', 'fish', 'config.fish')]) {
    const file = path.join(process.env.ZDOTDIR && rc === '.zshrc' ? process.env.ZDOTDIR : os.homedir(), rc);
    try {
      const text = fs.readFileSync(file, 'utf8');
      const cleaned = text.replace(/\n?# Added by the gossip installer\n[^\n]*\n?/g, '\n');
      if (cleaned !== text) fs.writeFileSync(file, cleaned);
    } catch { /* no such file */ }
  }
  for (const name of ['app.next', 'app.old', 'update.json', 'launcher', 'hub', 'bin', 'node', 'app']) rm(path.join(where.root, name));
  if (everything) {
    rm(home);
    rm(where.root);
  }
  console.log('');
  say('ok', everything ? 'gossip and everything it kept on this computer are gone.' : `gossip is removed. Your account and messages are still in ${home} - reinstall any time to pick them back up.`);
  if (failed.length) say('warn', `Couldn't delete: ${failed.join(', ')}. Close any open gossip windows and delete ${failed.length > 1 ? 'those' : 'it'} by hand.`);
  if (everything) say('sys', 'Your username still exists on the website or relay you used; only this computer forgot it.');
  return undefined;
}

/** gossip update: check for a newer version and fetch it now. */
async function update() {
  const U = require('./update');
  const say = (kind, text) => console.log(R.noteLines(kind, text, cols()).join('\n'));
  const cfg = U.config();
  if (!cfg) die('No valid GitHub repo is set in gossip.config.json, so there is nowhere to update from.');
  const where = U.install();
  const have = U.currentVersion();
  console.log(Th.dim(`  Checking ${cfg.repo} ...`));
  let version;
  try {
    version = await U.latest(cfg);
  } catch (e) {
    die(`Couldn't check for updates: ${e.message}`);
  }
  if (!U.newer(version, have)) return say('ok', `You have the newest gossip (v${have}).`);
  if (!where.managed) {
    return say('warn', `gossip v${version} is out (this is v${have}). This copy wasn't set up by the installer, so update it the way you got it - for a git clone: git pull`);
  }
  console.log(Th.dim(`  Getting v${version} ...`));
  try {
    await U.stage(version, cfg, where);
  } catch (e) {
    die(`Couldn't update: ${e.message}. Nothing was changed - you still have v${have}.`);
  }
  return say('ok', `gossip v${version} is downloaded and checked. It takes over the next time you start gossip.`);
}

/**
 * gossip nearby [address]: chat with people on the same local network - no
 * internet needed. The first person in hosts; everyone else finds them.
 */
async function nearby(args, view) {
  const N = require('./nearby');
  const { runCommand } = require('./commands');
  const say = (kind, text) => console.log(R.noteLines(kind, text, cols()).join('\n'));
  if (!process.stdin.isTTY || !process.stdout.isTTY) die('Nearby mode is interactive - run `gossip nearby` directly in a terminal.');
  const app = makeApp('live', { shell: true });
  const firstRun = !app.identity;

  if (firstRun) { // never used gossip before: all nearby mode needs is a name
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('');
    console.log('  ' + A.bold('Pick a username.') + Th.dim('  ' + P.NAME_HELP));
    for (;;) {
      const answer = await new Promise((resolve) => {
        rl.once('close', () => resolve(null));
        rl.question('  ' + Th.accent2(prefs.val('prompt.symbol')) + ' ', resolve);
      });
      if (answer === null) process.exit(130);
      const name = P.cleanName(answer);
      if (P.validName(name)) { app.createLocalIdentity(name); break; }
      say('err', P.NAME_HELP);
    }
    rl.close();
  }

  let host = null;
  let notice;
  const becomeHost = async () => {
    host = new N.Host({ dataDir: app.vault.file('nearby-host'), name: `${app.me}'s computer` });
    await host.start();
    return host.url;
  };
  if (args[0]) {
    app.via = N.addressToUrl(args[0]);
    notice = `Nearby mode: joining ${args[0]}.`;
  } else {
    console.log(Th.dim('  Looking for people nearby ...'));
    const found = await N.find();
    if (found.length) {
      app.via = found[0].url;
      notice = `Nearby mode: joined the chat ${found[0].name ? `on ${found[0].name}` : `at ${found[0].address}`}. No internet needed.`;
    } else {
      app.via = await becomeHost();
      const addrs = N.localAddresses().map((i) => i.address);
      notice = "Nearby mode: nobody else yet, so this computer is hosting. People on the same Wi-Fi or cable join with: gossip nearby"
        + (addrs.length ? `  (if that can't find you: gossip nearby ${addrs[0]})` : '')
        + '  If your computer asks to let Node.js use the network, allow it.';
    }
  }

  // Everyone lands in one shared server, so you can see who is around.
  const ctx = { app, shell: true, quit() {} };
  const lobby = async () => {
    for (const line of [`join ${N.LOBBY}`, `create ${N.LOBBY}`, `join ${N.LOBBY}`]) {
      try {
        if (!app.rooms().includes(N.LOBBY)) await runCommand(ctx, line);
        if (!app.target) app.setTarget('#' + N.LOBBY);
        if (notice) app.say(notice, 'sys');
        notice = null;
        return;
      } catch (e) {
        if (!['no_such_room', 'room_exists'].includes(e.code)) return;
      }
    }
  };
  app.on('synced', () => { lobby().catch(() => {}); });

  // Keep the group together: if the host leaves, find the new one or take over;
  // if two computers both ended up hosting, the newer one joins the older.
  let offlineSince = 0;
  let busy = false;
  const keeper = setInterval(async () => {
    if (busy || args[0]) return;
    busy = true;
    try {
      if (host) {
        const rival = await host.rival();
        if (rival) {
          app.say(`Joining the nearby chat on ${rival.name || rival.address}.`, 'sys');
          app.switchServer(rival.url, { remember: false });
          const old = host;
          host = null;
          await old.stop();
        }
      } else if (app.conn.state === 'offline') {
        offlineSince = offlineSince || Date.now();
        if (Date.now() - offlineSince > 4000 + Math.random() * 3000) {
          const found = await N.find();
          const url = found.length ? found[0].url : await becomeHost();
          app.say(found.length ? 'The host left - joined the new one.' : 'The host left - this computer is hosting now.', 'sys');
          app.switchServer(url, { remember: false });
          offlineSince = 0;
        }
      } else offlineSince = 0;
    } catch { /* try again on the next round */ }
    busy = false;
  }, 3000);

  try {
    await live({ view, app, firstRun });
  } finally {
    clearInterval(keeper);
    if (host) await host.stop().catch(() => {});
  }
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
const NO_ACCOUNT = new Set(['help', 'config', 'theme', 'mascot', 'dance', 'relay', 'shitty', 'changelog']);

/** Start the quiet background check for a new version (at most every few hours). */
const checkForUpdates = () => require('./update').kick(prefs.val('update'));

async function oneShot(cmd, args) {
  const app = makeApp('post');
  checkForUpdates();
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
    const { resolveServer } = require('./app');
    try {
      const url = await resolveServer(value);
      new Vault().updateSettings((s) => { s.server = url; });
    } catch (e) {
      die(`Couldn't use ${value}: ${e.message}`, 2);
    }
  }

  // gossip --classic / gossip --full: pick the look for this run
  let view = '';
  for (const [flagName, v] of [['--classic', 'classic'], ['--full', 'full']]) {
    const i = args.indexOf(flagName);
    if (i >= 0) { args.splice(i, 1); view = v; }
  }

  const word = (args[0] || '').toLowerCase();
  const rest = args.slice(1);
  if (!word) return live({ view });
  if (word === 'serve') {
    await require('../server/relay').serve(rest);
    return 'stay'; // the relay keeps the process alive
  }
  if (word === 'update') return update();
  if (word === 'uninstall' || word === 'delete') return uninstall(rest);
  if (word === 'nearby') return nearby(rest, view);
  if (word === 'turn') return require('./turn').main(rest);
  if (word === 'mini' || word === 'corner') return live({ view: 'mini' });
  if (word === 'call' || word === 'video') return live({ view, startup: [word, ...rest].join(' ') });
  if (word === 'dashboard' || word === 'dash') return live({ view, startup: 'dashboard' });
  if (word === '__update') return require('./update').check(rest[0] === 'notify' ? 'notify' : 'auto').then(() => {}, () => {});
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
    const close = didYouMean(word, ['check', 'listen', 'nearby', 'serve', 'turn', 'update', 'uninstall']);
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

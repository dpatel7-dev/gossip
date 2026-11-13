'use strict';
// Keeping gossip up to date by itself.
//
// Only installs made by the installer are touched (a `git clone` is left alone).
// Every few hours, in the background, gossip asks GitHub for the project's
// current version number. If it's newer, the new copy is downloaded next to the
// running one (~/.gossip/app.next), checked, and swapped in the next time you
// start gossip - never underneath a running chat.
//
//   gossip config update auto     get new versions by itself (default)
//   gossip config update notify   only say when there is one
//   gossip config update off      never check
//   gossip update                 check and update right now

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const EVERY = 6 * 60 * 60 * 1000;

/** Where this copy lives, and whether the installer put it there. */
function install() {
  const root = path.dirname(APP_DIR);
  const managed = path.basename(APP_DIR) === 'app' && !fs.existsSync(path.join(APP_DIR, '.git'));
  return { root, app: APP_DIR, next: path.join(root, 'app.next'), state: path.join(root, 'update.json'), managed };
}

function config() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'gossip.config.json'), 'utf8'));
  } catch { /* defaults */ }
  const repo = process.env.GOSSIP_REPO || cfg.repo || '';
  const branch = process.env.GOSSIP_BRANCH || cfg.branch || 'main';
  if (process.env.GOSSIP_UPDATE_BASE) {
    const base = process.env.GOSSIP_UPDATE_BASE.replace(/\/+$/, '');
    return { repo: base, version: `${base}/package.json`, archive: `${base}/app.tar.gz` };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(branch)) return null;
  return {
    repo: `github.com/${repo}`,
    version: `https://raw.githubusercontent.com/${repo}/${branch}/package.json`,
    archive: `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`,
  };
}

function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/** Is version `a` newer than `b`? ("0.10.0" is newer than "0.9.3") */
function newer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function fetch(url, { timeout = 20000, max = 30 * 1024 * 1024, hops = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('bad address'));
    }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error('bad address'));
    const req = lib.get(u, { timeout, headers: { 'user-agent': 'gossip-updater' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        return resolve(fetch(new URL(res.headers.location, u).href, { timeout, max, hops: hops - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`the download site answered ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > max) req.destroy(new Error('the download was unexpectedly large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the download took too long')));
    req.on('error', reject);
  });
}

/**
 * Unpack a .tar (already un-gzipped) into `dest`, dropping the first folder of
 * every path the way `tar --strip-components=1` does. Only plain files and
 * folders are written, and nothing can land outside `dest`.
 */
function untar(buf, dest) {
  let off = 0;
  let longName = null;
  const text = (b) => {
    const end = b.indexOf(0);
    return b.toString('utf8', 0, end < 0 ? b.length : end);
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    off += 512;
    if (h.every((x) => x === 0)) break;
    const size = parseInt(text(h.subarray(124, 136)).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    let name = text(h.subarray(0, 100));
    const prefix = text(h.subarray(345, 500));
    if (text(h.subarray(257, 263)).startsWith('ustar') && prefix) name = `${prefix}/${name}`;
    if (type === 'L') { longName = text(data); continue; } // GNU: the next entry's real name
    if (type === 'x') { // pax: "LEN path=NAME\n"
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    const parts = name.split('/').filter((p) => p && p !== '.').slice(1);
    if (!parts.length || parts.includes('..')) continue;
    const target = path.join(dest, ...parts);
    if (!target.startsWith(dest + path.sep)) continue;
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (type === '0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const mode = parseInt(text(h.subarray(100, 108)).trim() || '644', 8) & 0o111 ? 0o755 : 0o644;
      fs.writeFileSync(target, data, { mode });
    }
  }
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    fs.writeFileSync(file, JSON.stringify(state));
  } catch { /* a read-only install just doesn't remember */ }
}

/** Ask what the newest version is. */
async function latest(cfg = config()) {
  if (!cfg) throw new Error('no download address is set in gossip.config.json');
  const pkg = JSON.parse((await fetch(cfg.version, { max: 256 * 1024 })).toString('utf8'));
  if (!/^\d+\.\d+\.\d+/.test(String(pkg.version))) throw new Error("the project's version number looks wrong");
  return String(pkg.version);
}

/** Download `version`, check it, and leave it ready in app.next. */
async function stage(version, cfg = config(), where = install()) {
  const tmp = `${where.next}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const tar = zlib.gunzipSync(await fetch(cfg.archive));
    fs.mkdirSync(tmp, { recursive: true });
    untar(tar, tmp);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    if (pkg.name !== 'gossip-chat' || pkg.version !== version) throw new Error("the download doesn't match the version that was announced");
    const bin = path.join(tmp, 'bin', 'gossip.js');
    const smoke = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, GOSSIP_NO_UPDATE: '1' } });
    if (smoke.status !== 0 || !String(smoke.stdout).includes(version)) throw new Error("the new version doesn't start on this computer");
    fs.writeFileSync(path.join(tmp, '.ready'), version);
    fs.rmSync(where.next, { recursive: true, force: true });
    fs.renameSync(tmp, where.next);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Called first thing when gossip starts: if a checked download is waiting,
 * switch to it. Returns the new version, or null. Never throws.
 */
function applyStaged(where = install()) {
  try {
    if (!where.managed) return null;
    const version = fs.readFileSync(path.join(where.next, '.ready'), 'utf8').trim();
    if (!newer(version, currentVersion())) {
      fs.rmSync(where.next, { recursive: true, force: true });
      return null;
    }
    const old = path.join(where.root, 'app.old');
    fs.rmSync(old, { recursive: true, force: true });
    fs.renameSync(where.app, old);
    try {
      fs.renameSync(where.next, where.app);
    } catch (e) {
      fs.renameSync(old, where.app); // put things back the way they were
      throw e;
    }
    try { fs.rmSync(path.join(where.app, '.ready'), { force: true }); } catch { /* harmless */ }
    try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* cleaned up next time */ }
    writeState(where.state, { ...readState(where.state), updatedTo: version, updatedAt: Date.now(), told: false });
    return version;
  } catch {
    return null;
  }
}

/** The background check (`gossip __update`). mode: 'auto' downloads, 'notify' only notes it. */
async function check(mode, { force = false } = {}) {
  const where = install();
  const cfg = config();
  if (!cfg || (!where.managed && !force)) return { skipped: true };
  const state = readState(where.state);
  if (!force && Date.now() - (state.checked || 0) < EVERY) return { skipped: true };
  writeState(where.state, { ...state, checked: Date.now() });
  const version = await latest(cfg);
  const have = currentVersion();
  if (!newer(version, have)) {
    writeState(where.state, { ...readState(where.state), available: null });
    return { version, have, current: true };
  }
  if (mode === 'auto' && where.managed) {
    await stage(version, cfg, where);
    writeState(where.state, { ...readState(where.state), available: version, staged: true });
    return { version, have, staged: true };
  }
  writeState(where.state, { ...readState(where.state), available: version, staged: false });
  return { version, have, staged: false };
}

/** Start the background check without making anyone wait for it. */
function kick(mode) {
  try {
    if (mode === 'off' || process.env.GOSSIP_NO_UPDATE === '1') return;
    const where = install();
    if (!where.managed || !config()) return;
    if (Date.now() - (readState(where.state).checked || 0) < EVERY) return;
    const child = spawn(process.execPath, [path.join(APP_DIR, 'bin', 'gossip.js'), '__update', mode], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, GOSSIP_NO_UPDATE: '1' },
    });
    child.unref();
  } catch { /* updating is a nicety */ }
}

/** One line worth showing when the chat opens (or null). */
function news(mode) {
  try {
    const where = install();
    if (!where.managed) return null;
    const state = readState(where.state);
    if (state.updatedTo && !state.told && state.updatedTo === currentVersion()) {
      writeState(where.state, { ...state, told: true });
      return `gossip updated itself to v${state.updatedTo}.`;
    }
    if (mode === 'notify' && state.available && newer(state.available, currentVersion())) {
      return `gossip v${state.available} is out - get it with: gossip update`;
    }
  } catch { /* nothing to say */ }
  return null;
}

module.exports = { install, config, currentVersion, newer, fetch, untar, latest, stage, applyStaged, check, kick, news };

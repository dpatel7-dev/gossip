'use strict';
// Everything gossip keeps on this computer lives in one folder (~/.gossip):
//
//   identity.json   your username and PRIVATE keys - this file *is* your account
//   settings.json   relay address and your preferences (see `gossip config`)
//   peers.json      public keys of people you've talked to (and your contacts)
//   history/        your message history, one file per conversation
//
// Files are created readable only by you (0600). Several gossip commands can
// run at once (a `gossip listen` in one tab, a `gossip squawk` in another), so
// shared files are re-read when they change and written with read-modify-write.

const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir() {
  return process.env.GOSSIP_HOME || path.join(os.homedir(), '.gossip');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    try { fs.copyFileSync(file, file + '.broken'); } catch { /* best effort */ }
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function stampOf(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/** The people you know: their pinned public keys, and whether they're a contact. */
class PeerBook {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.stamp = null;
    this.sync();
  }

  /** Re-read the file if another gossip process changed it. Returns true if it did. */
  sync() {
    const stamp = stampOf(this.file);
    if (stamp === this.stamp) return false;
    const list = readJson(this.file, []);
    this.map = new Map();
    for (const p of Array.isArray(list) ? list : []) if (p && p.name) this.map.set(p.name, p);
    this.stamp = stamp;
    return true;
  }

  get(name) {
    this.sync();
    return this.map.get(name);
  }

  values() {
    this.sync();
    return [...this.map.values()];
  }

  /**
   * Change one person's record. `fn` gets a copy of the current record (or
   * undefined) and returns the new one, or null to forget them.
   */
  /** Someone changed their username: keep everything we know about them under the new one. */
  rename(from, to) {
    this.sync();
    const old = this.map.get(from);
    if (!old) return null;
    const next = { ...(this.map.get(to) || {}), ...old, name: to };
    this.map.delete(from);
    this.map.set(to, next);
    writeJson(this.file, [...this.map.values()]);
    this.stamp = stampOf(this.file);
    return next;
  }

  update(name, fn) {
    this.sync();
    const cur = this.map.get(name);
    const next = fn(cur ? { ...cur } : undefined);
    if (next === null) this.map.delete(name);
    else if (next) this.map.set(name, next);
    writeJson(this.file, [...this.map.values()]);
    this.stamp = stampOf(this.file);
    return next || undefined;
  }
}

class Vault {
  constructor(dir = homeDir()) {
    this.dir = dir;
    this.historyDir = path.join(dir, 'history');
    fs.mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    this.peers = new PeerBook(this.file('peers.json'));
    this._settingsStamp = null;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  // identity ----------------------------------------------------------------
  loadIdentity() {
    const id = readJson(this.file('identity.json'), null);
    if (!id || !id.name || !id.signKey || !id.dhKey) return null;
    return id;
  }

  saveIdentity(identity) {
    writeJson(this.file('identity.json'), { v: 1, ...identity });
  }

  // settings ----------------------------------------------------------------
  loadSettings() {
    this._settingsStamp = stampOf(this.file('settings.json'));
    const s = { server: '', blocked: [], target: '', prefs: {}, ...readJson(this.file('settings.json'), {}) };
    if (!Array.isArray(s.blocked)) s.blocked = [];
    if (!s.prefs || typeof s.prefs !== 'object' || Array.isArray(s.prefs)) s.prefs = {};
    return s;
  }

  settingsChanged() {
    return stampOf(this.file('settings.json')) !== this._settingsStamp;
  }

  /** Read-modify-write, so two terminals don't overwrite each other's changes. */
  updateSettings(fn) {
    const s = this.loadSettings();
    fn(s);
    writeJson(this.file('settings.json'), s);
    this._settingsStamp = stampOf(this.file('settings.json'));
    return s;
  }

  // history -----------------------------------------------------------------
  _historyFile(key) {
    const kind = key[0] === '#' ? 'room' : 'dm';
    return path.join(this.historyDir, `${kind}-${key.slice(1)}.jsonl`);
  }

  /** Move a chat's saved messages to a new name (joining them on if that chat already exists). */
  renameHistory(from, to) {
    const a = this._historyFile(from);
    const b = this._historyFile(to);
    try {
      if (!fs.existsSync(a)) return;
      if (fs.existsSync(b)) {
        fs.appendFileSync(b, fs.readFileSync(a));
        fs.rmSync(a);
      } else fs.renameSync(a, b);
    } catch { /* the old file simply stays */ }
  }

  appendHistory(key, record) {
    try {
      fs.appendFileSync(this._historyFile(key), JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch { /* history is best effort */ }
  }

  /** Returns the most recent `limit` messages, with status updates folded in. */
  loadHistory(key, limit = 1000) {
    let raw;
    try {
      raw = fs.readFileSync(this._historyFile(key), 'utf8');
    } catch {
      return [];
    }
    const byId = new Map();
    const order = [];
    let records = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      records++;
      if (r.u) {
        const m = byId.get(r.u);
        if (m) m.st = r.st;
      } else if (r.id && !byId.has(r.id)) {
        byId.set(r.id, r);
        order.push(r);
      }
    }
    const recent = order.slice(-limit);
    // Keep files from growing forever: rewrite once they carry a lot of old lines.
    if (records > Math.max(limit, 1000) * 3) {
      try {
        const tmp = `${this._historyFile(key)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, order.slice(-1000).map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
        fs.renameSync(tmp, this._historyFile(key));
      } catch { /* best effort */ }
    }
    return recent;
  }

  /** Ids of messages already stored for a conversation (to drop duplicates). */
  historyIds(key) {
    const ids = new Set();
    for (const r of this.loadHistory(key, 5000)) ids.add(r.id);
    return ids;
  }

  /** Conversations that have any saved history: ['@maya', '#gamedev', ...]. */
  conversations() {
    let files;
    try {
      files = fs.readdirSync(this.historyDir);
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const m = /^(dm|room)-([a-z0-9][a-z0-9_-]+)\.jsonl$/.exec(f);
      if (m) out.push((m[1] === 'dm' ? '@' : '#') + m[2]);
    }
    return out;
  }

  clearHistory(key) {
    try {
      fs.unlinkSync(this._historyFile(key));
    } catch { /* nothing to clear */ }
  }
}

module.exports = { Vault, PeerBook, homeDir };

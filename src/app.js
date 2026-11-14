'use strict';
// The brain of the client: people, keys, sending and receiving.
// It never draws anything. Whatever should be shown is emitted as a 'line'
// event, and the live prompt (shitty.js) or a one-off command (cli.js) prints it.

const { EventEmitter } = require('events');
const e2e = require('./e2e');
const P = require('./proto');
const ws = require('./ws');
const fs = require('fs');
const { makeLink, probeHttp, friendlyNetError } = require('./net');
const { cleanText } = require('./text');
const prefs = require('./prefs');

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Turn what a person typed into an address gossip can connect to:
 *   ws:// or wss://      a relay (gossip serve)
 *   http:// or https://  a gossip website
 * A bare name is assumed to be a relay; resolveServer() tries both.
 */
function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Type the address of a gossip relay or website');
  if (!/^(wss?|https?):\/\//i.test(s)) {
    const plain = /^(localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s);
    s = (plain ? 'ws://' : 'wss://') + s;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("That doesn't look like a relay address (example: chat.example.com)");
  }
  if (!u.hostname || /\s/.test(s)) throw new Error("That doesn't look like a relay address (example: chat.example.com)");
  return s.replace(/\/+$/, '');
}

function mentions(text, name) {
  return new RegExp(`(^|[^a-z0-9_-])@${name}(?![a-z0-9_-])`, 'i').test(text);
}

const TRANSIENT = ['offline', 'disconnected', 'timeout'];

/** For a bare name like "dhruv.pythonanywhere.com": is it a website or a relay? Ask it. */
async function resolveServer(input) {
  const typed = String(input || '').trim();
  if (/^(wss?|https?):\/\//i.test(typed)) return normalizeServer(typed);
  const relay = normalizeServer(typed);
  const site = relay.replace(/^ws/i, 'http');
  const order = /\.(pythonanywhere\.com|netlify\.app)$/i.test(new URL(site).hostname) ? [site, relay] : [relay, site];
  let first = null;
  for (const url of order) {
    try {
      await probeServer(url);
      return url;
    } catch (e) {
      first = first || e;
    }
  }
  throw first;
}

class App extends EventEmitter {
  /**
   * mode:  'live' - the chat prompt and `gossip listen` (receive everything, show as online)
   *        'peek' - `gossip check` (collect what's waiting, stay invisible)
   *        'post' - `gossip squawk` and other one-off commands (send only)
   * shell: true inside the live prompt, so hints say "/join x" instead of "gossip join x"
   */
  constructor({ vault, config = {}, server = '', mode = 'live', shell = false, via = '' }) {
    super();
    this.vault = vault;
    this.config = config;
    this.mode = mode;
    this.shell = shell;
    this.via = via; // an address to use for this run only (nearby mode), never saved
    this._settings = null;
    this.settings = vault.loadSettings();
    if (server) {
      const url = normalizeServer(server);
      this.settings = vault.updateSettings((s) => { s.server = url; });
    }
    this.identity = vault.loadIdentity();
    this.me = this.identity ? this.identity.name : null;
    this.peers = vault.peers;

    this.presence = new Map(); // contact name -> online?
    this.renames = new Map(); // an old username -> the new one (people who renamed)
    this.otherSessions = 0; // other places this account is open right now
    this.activity = []; // what happened, for the dashboard
    this.counts = { sent: 0, received: 0 };
    this.onlineSince = 0;
    this.reconnects = 0;
    this.chats = new Map(); // '@name' | '#room' -> conversation state
    this.invites = new Map(); // room -> invited by
    this.knownRooms = [];
    this.link = null;
    this.conn = { state: 'idle', detail: {} };
    this.outbox = [];
    this.syncing = false;
    this.filter = null; // `gossip listen <who>`: only take this conversation
    this.beforeMessages = null; // optional async hook run after sign-in, before any message is handled
    this.target = /^[@#][a-z0-9][a-z0-9_-]+$/.test(this.settings.target || '') ? this.settings.target : null;

    this._rx = Promise.resolve();
    this._synced = Promise.resolve();
    this._release = null;
    this._fresh = new Set(); // peers whose keys were re-checked on this connection
    this._acks = [];
    this._lastTyping = 0;
    this._roomsFetched = 0;
    this._saidOffline = false;
  }

  // Whenever settings are (re)loaded, the theme and preferences follow.
  get settings() {
    return this._settings;
  }

  set settings(value) {
    this._settings = value;
    prefs.use(value);
  }

  /**
   * Where messages go through. In order: this run only (nearby mode), what you
   * chose with `gossip relay`, the website gossip was installed from, the
   * project's default.
   */
  get serverUrl() {
    return this.via || this.settings.server || this._installedFrom() || this.config.hub || this.config.defaultServer || '';
  }

  _installedFrom() {
    if (this._hubFile === undefined) {
      this._hubFile = '';
      try {
        const text = fs.readFileSync(this.vault.file('hub'), 'utf8').trim();
        if (/^(https?|wss?):\/\/[^\s]+$/i.test(text)) this._hubFile = text.replace(/\/+$/, '');
      } catch { /* installed some other way */ }
    }
    return this._hubFile;
  }

  /** How to write a command where the person is: "/join x" in the prompt, "gossip join x" in a shell. */
  hint(cmd) {
    return this.shell ? `/${cmd}` : `gossip ${cmd}`;
  }

  // ── things to show ────────────────────────────────────────────────────────

  /** Keep a short record of what happened (the dashboard's Activity list). */
  log(kind, text) {
    this.activity.push({ ts: Date.now(), kind, text: String(text).slice(0, 300) });
    if (this.activity.length > 150) this.activity.splice(0, 50);
  }

  /** How long a round trip to the relay takes, in milliseconds. */
  async ping() {
    const t = Date.now();
    await this.link.request('ping', {}, 8000);
    return Date.now() - t;
  }

  /** Send call details to someone (encrypted like a message, but not shown or saved as one). */
  async signal(name, data) {
    if (!this.link || !this.link.online) throw fail('offline', "You're offline");
    const peer = await this.peerFor(name);
    if (peer.changed) throw fail('key_changed', `${name}'s security key changed - check ${this.hint(`verify ${name}`)} first`);
    const env = e2e.seal({
      identity: this.identity, from: this.me, conv: P.dmConv(this.me, peer.name),
      recipients: [{ name: peer.name, dhPub: peer.dhPub }], payload: { call: data }, id: e2e.randomId(), ts: Date.now(),
    });
    await this.link.request('send', { env });
  }

  say(text, kind = 'sys') {
    if (kind !== 'sys') this.log(kind, text);
    this.emit('line', { t: 'note', kind, text });
  }

  rows(rows) {
    this.emit('line', { t: 'rows', rows });
  }

  flash(text) {
    this.emit('flash', text);
  }

  // ── account & connection ──────────────────────────────────────────────────

  /** Create keys on this computer without telling anyone yet (nearby mode signs up wherever it lands). */
  createLocalIdentity(name) {
    const identity = e2e.createIdentity();
    this.identity = { name, server: '', created: Date.now(), ...identity };
    this.vault.saveIdentity(this.identity);
    this.me = name;
  }

  /** Create keys on this computer and claim `name` on the server. */
  register(name) {
    return new Promise((resolve, reject) => {
      if (!this._newIdentity) this._newIdentity = e2e.createIdentity();
      const identity = this._newIdentity;
      const link = makeLink({ url: this.serverUrl, identity, name, mode: 'post', retry: false });
      const done = (err) => {
        link.removeAllListeners();
        link.stop();
        if (err) reject(err); else resolve();
      };
      link.on('authfail', (e) => done(e.code === 'name_taken' ? fail('name_taken', `"${name}" is taken - try another`) : e));
      link.on('fail', (e) => done(fail('network', `couldn't reach the relay: ${e.message}`)));
      link.on('ready', () => {
        this.identity = { name, server: this.serverUrl, created: Date.now(), ...identity };
        this.vault.saveIdentity(this.identity);
        this.me = name;
        this._newIdentity = null;
        done();
      });
      link.start();
    });
  }

  /**
   * Sign in. Resolves once rooms and contacts are in sync.
   * With retry=false (one-off commands) it rejects instead of reconnecting forever.
   */
  connect({ retry = true, timeout = 15000 } = {}) {
    if (!this.identity) return Promise.reject(fail('no_account', 'No account on this computer yet - run `gossip` to make one'));
    if (!this.serverUrl) return Promise.reject(fail('no_server', 'No relay is set - run: gossip relay <address>'));
    if (prefs.val('security') === 'strict' && /^(ws|http):\/\/(?!localhost|127\.|\[::1\])/i.test(this.serverUrl) && !this.via) {
      const e = fail('insecure', `${this.serverUrl} isn't an encrypted connection, and your security setting is "strict". Use an https:// or wss:// address, or: ${this.hint('config security normal')}`);
      this.say(e.message, 'err');
      return Promise.reject(e);
    }
    const link = makeLink({ url: this.serverUrl, identity: this.identity, name: this.me, mode: this.mode, retry });
    this._wire(link);
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (err) => {
        clearTimeout(timer);
        this.removeListener('synced', onSynced);
        link.removeListener('fail', onFail);
        link.removeListener('authfail', onAuthFail);
        if (err) reject(err); else resolve();
      };
      const onSynced = () => finish(this._syncError || null);
      const onFail = (e) => finish(fail('network', `can't reach ${link.host} - ${e.message}`));
      const onAuthFail = (e) => finish(e);
      this.once('synced', onSynced);
      link.once('fail', onFail);
      link.once('authfail', onAuthFail);
      if (!retry) timer = setTimeout(() => finish(fail('timeout', `can't reach ${link.host} - the server took too long to answer`)), timeout);
      link.start();
    });
  }

  close() {
    this.flushAcks();
    if (this.link) this.link.stop();
  }

  /** Close, but give the last few bytes (like "got it" receipts) time to leave. */
  async closeGracefully() {
    this.flushAcks();
    if (this.link) await this.link.shutdown();
  }

  /** remember=false: just for this run (nearby mode hopping to a new host). */
  switchServer(url, { remember = true } = {}) {
    if (remember) this.settings = this.vault.updateSettings((s) => { s.server = url; });
    else this.via = url;
    if (this.link) {
      this.link.removeAllListeners();
      this.link.stop();
    }
    this.presence.clear();
    return this.connect().catch((e) => this.say(e.message, 'err'));
  }

  _wire(link) {
    this.link = link;
    link.on('state', (state, detail) => {
      const was = this.conn && this.conn.state;
      this.conn = { state, detail };
      if (state === 'online' && was !== 'online') {
        if (this.onlineSince) this.reconnects++;
        this.onlineSince = Date.now();
        this.log('net', `Connected to ${link.host}`);
      } else if (state === 'offline' && was === 'online') {
        this.log('net', `Lost the connection to ${link.host}${detail && detail.message ? ` (${detail.message})` : ''}`);
      }
      if (state === 'connecting') {
        this._synced = new Promise((r) => { this._release = r; });
        this._caughtUp = false;
      }
      if (state !== 'online') {
        this.presence.clear();
        for (const c of this.chats.values()) c.typing.clear();
      }
      this.emit('state', state, detail);
      this.emit('change');
    });
    link.on('ready', (res) => this._onReady(res));
    link.on('push', (m) => this._onPush(m));
    link.on('authfail', (e) => {
      // renamed from another computer: pick up the new name and carry on
      const moved = e.code === 'renamed' && /now called "([a-z0-9_-]+)"/.exec(e.message);
      if (moved && P.validName(moved[1])) {
        this._iAm(moved[1]);
        this.say(`You're called ${moved[1]} now (you renamed on another computer).`, 'sys');
        link.fatal = false;
        setTimeout(() => link.retryNow(), 50);
        return;
      }
      const why = e.code === 'name_taken' ? `the name "${this.me}" belongs to someone else on this relay` : e.message;
      this.say(`Couldn't sign in to ${link.host}: ${why}.`, 'err');
    });
  }

  async _onReady(res) {
    this.otherSessions = Number(res.others) || 0;
    if (this.mode === 'live' && this.otherSessions) this._sessionWarning(this.otherSessions + 1, false);
    this.syncing = true;
    this._syncError = null;
    this._fresh.clear();
    this._saidOffline = false;
    try {
      const blocked = Array.isArray(res.blocked) ? res.blocked.filter(P.validName).sort() : [];
      if (JSON.stringify(blocked) !== JSON.stringify([...this.settings.blocked].sort())) {
        this.settings = this.vault.updateSettings((s) => { s.blocked = blocked; });
      }

      const mine = new Set();
      for (const r of res.rooms || []) {
        if (!P.validRoom(r.name)) continue;
        mine.add(r.name);
        const chat = this.chat('#' + r.name);
        chat.joined = true;
        chat.private = !!r.private;
      }
      for (const chat of this.chats.values()) {
        if (chat.kind === 'room' && !mine.has(chat.name)) {
          chat.joined = false;
          chat.members.clear();
        }
      }
      if (this.target && this.target[0] === '#' && !mine.has(this.target.slice(1))) this.target = null;
      if (this.mode !== 'post') for (const inv of res.invites || []) this._invited(inv.room, inv.by);
      for (const n of res.notices || []) {
        if (n && n.kind === 'kicked' && P.validRoom(n.room)) this._onRoomEvent({ room: n.room, event: 'kicked', by: n.by });
      }

      // the relay owner's welcome line (cleaned like any other text from the network)
      const motd = this.link && this.link.server && cleanText(String(this.link.server.motd || '')).slice(0, 300);
      if (motd && this.mode === 'live' && this.shell && !this._motdShown) {
        this._motdShown = true;
        this.say(motd, 'sys');
      }

      if (this.beforeMessages) await this.beforeMessages();
      if (this.mode === 'live') {
        const rooms = [...this.chats.values()].filter((c) => c.kind === 'room' && c.joined);
        await Promise.all(rooms.map((c) => this._refreshMembers(c).catch(() => {})));
        await this._watch().catch(() => {});
      }
    } catch (e) {
      this._syncError = e;
    } finally {
      this.syncing = false;
      if (this._release) this._release();
    }
    this.pump();
    this.emit('synced', res);
    this.emit('change');
  }

  // ── conversations ─────────────────────────────────────────────────────────

  chat(key) {
    let c = this.chats.get(key);
    if (!c) {
      const isRoom = key[0] === '#';
      c = {
        key, kind: isRoom ? 'room' : 'dm', name: key.slice(1),
        ids: null, // ids already in the history file, loaded on first use
        members: new Map(), joined: isRoom ? null : true, private: false, owner: null, typing: new Map(),
      };
      this.chats.set(key, c);
    }
    return c;
  }

  rooms() {
    return [...this.chats.values()].filter((c) => c.kind === 'room' && c.joined).map((c) => c.name).sort();
  }

  _has(chat, id) {
    if (!chat.ids) chat.ids = this.vault.historyIds(chat.key);
    return chat.ids.has(id);
  }

  setTarget(key) {
    if (this.target === key) return;
    this.target = key;
    try {
      this.settings = this.vault.updateSettings((s) => { s.target = key || ''; });
    } catch { /* remembering the target is a nicety */ }
    this.emit('change');
  }

  // ── people & keys ─────────────────────────────────────────────────────────

  /**
   * Remember someone's public keys the first time we see them ("trust on first
   * use"). If the relay later hands us a DIFFERENT identity key for the same
   * name, we keep the old one, flag it, and warn - that's how a swapped key
   * (or a lying server) gets caught.
   */
  pin(user) {
    if (!user || !P.validName(user.name) || !e2e.validBundle(user)) throw fail('bad_keys', 'The server sent invalid keys');
    const keys = { signPub: user.signPub, dhPub: user.dhPub, dhSig: user.dhSig };
    let p = this.peers.get(user.name);
    if (!p) {
      // The same key under a name we haven't seen: that's someone we know who renamed.
      const same = this.peers.values().find((x) => x.signPub === user.signPub && x.name !== user.name && x.name !== this.me);
      if (same) {
        this._renamed(same.name, user.name);
        p = this.peers.get(user.name);
      }
    }
    if (!p) {
      return this.peers.update(user.name, (cur) => cur || { name: user.name, ...keys, contact: false, verified: false, since: Date.now() });
    }
    if (p.signPub !== user.signPub) {
      if (p.changed && p.changed.signPub === user.signPub) return p;
      const next = this.peers.update(user.name, (cur) => ({ ...(cur || p), changed: keys }));
      this.say(`${p.name}'s security key has changed. That can mean they set gossip up again - or that someone is pretending to be them. Compare numbers with ${this.hint(`verify ${p.name}`)}, then ${this.hint(`trust ${p.name}`)} to accept the new key.`, 'warn');
      return next;
    }
    if (p.changed || p.dhPub !== user.dhPub) {
      return this.peers.update(user.name, (cur) => {
        const next = { ...(cur || p), dhPub: user.dhPub, dhSig: user.dhSig };
        delete next.changed;
        return next;
      });
    }
    return p;
  }

  /** This account is open somewhere else too. Fine if that's you; worth knowing if it isn't. */
  _sessionWarning(n, fresh) {
    this.say(`${fresh ? 'Your account was just opened' : 'Your account is open'} in ${n} places at once. If that isn't you in another window, someone has your keys: sign them out with ${this.hint('signout')} and see ${this.hint('security')}.`, 'warn');
    if (fresh && prefs.val('bell') !== 'off') this.emit('bell');
  }

  /** I changed my own username. */
  _iAm(name) {
    this.me = name;
    this.identity = { ...this.identity, name };
    this.vault.saveIdentity(this.identity);
    if (this.link) this.link.name = name;
  }

  /** Someone else changed theirs: move their contact entry, chat and saved messages along. */
  _renamed(from, to) {
    if (from === to || !P.validName(from) || !P.validName(to)) return;
    this.renames.set(from, to);
    const had = this.peers.get(from);
    if (had) this.peers.rename(from, to);
    this.vault.renameHistory('@' + from, '@' + to);
    const chat = this.chats.get('@' + from);
    if (chat) {
      this.chats.delete('@' + from);
      if (!this.chats.has('@' + to)) this.chats.set('@' + to, Object.assign(chat, { key: '@' + to, name: to }));
    }
    for (const c of this.chats.values()) {
      if (c.members && c.members.has(from)) { c.members.set(to, c.members.get(from)); c.members.delete(from); }
      if (c.owner === from) c.owner = to;
    }
    if (this.presence.has(from)) { this.presence.set(to, this.presence.get(from)); this.presence.delete(from); }
    const swap = (list) => (Array.isArray(list) ? list.map((x) => (x === from ? to : x === '@' + from ? '@' + to : x)) : list);
    this.settings = this.vault.updateSettings((s) => {
      s.blocked = swap(s.blocked);
      s.muted = swap(s.muted);
      if (s.target === '@' + from) s.target = '@' + to;
    });
    if (this.target === '@' + from) this.target = '@' + to;
    if (had) this.say(`${from} is now called ${to}.`, 'event');
  }

  async peerFor(name, { refresh = false } = {}) {
    if (this.renames.has(name)) name = this.renames.get(name);
    const known = this.peers.get(name);
    if (known && !refresh) return known;
    if (!this.link || !this.link.online) {
      if (known) return known;
      throw fail('offline', `You're offline, so ${name} can't be looked up right now`);
    }
    const res = await this.link.request('lookup', { name });
    // asked for an old username: the relay answers with who they are now
    if (res.user && res.user.name !== name && P.validName(res.user.name)) this._renamed(name, res.user.name);
    return this.pin(res.user);
  }

  /** Muted chats still collect messages; they just don't ring or show a count. */
  muted(key) {
    return Array.isArray(this.settings.muted) && this.settings.muted.includes(key);
  }

  contacts() {
    return this.peers.values().filter((p) => p.contact).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async _watch() {
    if (!this.link || !this.link.online) return;
    const names = this.contacts().map((p) => p.name);
    this._watched = names.join(',');
    const res = await this.link.request('watch', { names });
    this.presence = new Map(names.map((n) => [n, false]));
    for (const n of res.online || []) this.presence.set(n, true);
    this.emit('change');
  }

  async _refreshMembers(chat) {
    const res = await this.link.request('members', { room: chat.name });
    this._adopt(chat, res);
  }

  /** Take a room's member list (and their keys) from a server reply. */
  _adopt(chat, res) {
    const members = new Map();
    for (const m of res.members || []) {
      try {
        this.pin(m);
        members.set(m.name, { online: !!m.online });
      } catch { /* skip anyone with broken keys */ }
    }
    chat.members = members;
    chat.private = !!(res.room && res.room.private);
    chat.owner = (res.room && res.room.owner) || null;
    chat.joined = true;
    this.emit('change');
  }

  // ── sending ───────────────────────────────────────────────────────────────

  /** Encrypt and send. Resolves when the relay has it; rejects if it can't be sent. */
  send(key, raw) {
    const text = cleanText(raw);
    if (!text) return Promise.reject(fail('empty', 'There was nothing to send'));
    const length = Array.from(text).length;
    if (length > P.LIMITS.text) {
      return Promise.reject(fail('too_long', `that message is too long (${length} characters - the limit is ${P.LIMITS.text})`));
    }
    const chat = this.chat(key);
    if (chat.kind === 'room' && chat.joined === false) {
      return Promise.reject(fail('not_member', `you're not in #${chat.name} - ${this.hint(`join ${chat.name}`)}`));
    }
    const msg = { id: e2e.randomId(), from: this.me, ts: Date.now(), text, status: 'pending' };
    this.vault.appendHistory(key, { id: msg.id, from: msg.from, ts: msg.ts, text, st: 'pending' });
    if (chat.ids) chat.ids.add(msg.id);
    this._lastTyping = 0;
    this.emit('line', { t: 'msg', key, msg });
    if (this.shell && (!this.link || !this.link.online) && !this._saidOffline) {
      this._saidOffline = true;
      this.say("You're offline - this will send as soon as you're reconnected.", 'sys');
    }
    return new Promise((resolve, reject) => {
      this.outbox.push({ key, msg, resolve, reject });
      this.pump();
    });
  }

  async _seal(job) {
    return this._sealFor(job.key, { text: job.msg.text }, job.msg.id, job.msg.ts);
  }

  /** Encrypt anything for everyone in a chat. */
  async _sealFor(key, payload, id, ts) {
    const chat = this.chat(key);
    let recipients;
    let conv;
    if (chat.kind === 'dm') {
      // Once per connection, re-check their key with the relay so a changed key is noticed.
      const stale = !this._fresh.has(chat.name);
      const peer = await this.peerFor(chat.name, { refresh: stale });
      this._fresh.add(chat.name);
      if (peer.changed) {
        throw fail('key_changed', `${chat.name}'s security key changed - check ${this.hint(`verify ${chat.name}`)}, then ${this.hint(`trust ${chat.name}`)}`);
      }
      recipients = [{ name: peer.name, dhPub: peer.dhPub }];
      conv = P.dmConv(this.me, chat.name);
    } else {
      if (!chat.members.size) await this._refreshMembers(chat);
      recipients = [];
      for (const name of chat.members.keys()) {
        const p = this.peers.get(name);
        if (name !== this.me && p && !p.changed) recipients.push({ name, dhPub: p.dhPub });
      }
      conv = P.roomConv(chat.name);
    }
    return e2e.seal({ identity: this.identity, from: this.me, conv, recipients, payload, id, ts });
  }

  /**
   * Send a file: one "here comes a file" message, then the file in pieces.
   * Resolves when the last piece has left this computer.
   */
  async sendFile(key, file) {
    const F = require('./files');
    const info = F.prepare(file);
    if (!this.link || !this.link.online) throw fail('offline', "You're offline - files can only be sent while connected");
    const chat = this.chat(key);
    if (chat.kind === 'room' && chat.joined === false) throw fail('not_member', `you're not in #${chat.name}`);
    const meta = { name: info.name, size: info.size, sha: info.sha, chunks: info.chunks, preview: info.preview };
    const msg = { id: e2e.randomId(), from: this.me, ts: Date.now(), text: '', file: { ...meta, path: info.path, state: 'sending', done: 0 }, status: 'pending' };
    this.vault.appendHistory(key, { id: msg.id, from: msg.from, ts: msg.ts, text: '', file: msg.file, st: 'pending' });
    if (chat.ids) chat.ids.add(msg.id);
    this.emit('line', { t: 'msg', key, msg });
    const send = async (env) => {
      for (let tries = 0; ; tries++) {
        try {
          return await this.link.request('send', { env }, 60000);
        } catch (e) {
          if (e.code === 'slow_down' && tries < 60) { await new Promise((r) => setTimeout(r, 1000)); continue; }
          throw e;
        }
      }
    };
    const update = (fields, st) => {
      Object.assign(msg.file, fields);
      if (st) msg.status = st;
      this.vault.appendHistory(key, { u: msg.id, file: msg.file, ...(st ? { st } : {}) });
      this.emit('file', { key, id: msg.id, file: msg.file, status: msg.status });
      this.emit('change');
    };
    try {
      await send(await this._sealFor(key, { file: meta }, msg.id, msg.ts));
      for (let i = 0; i < info.chunks; i++) {
        const piece = info.data.subarray(i * F.CHUNK, (i + 1) * F.CHUNK);
        await send(await this._sealFor(key, { chunk: { of: msg.id, i, d: piece.toString('base64') } }, e2e.randomId(), Date.now()));
        msg.file.done = (i + 1) / info.chunks;
        this.emit('file', { key, id: msg.id, file: msg.file, status: msg.status });
        this.emit('change');
      }
      this.counts.sent++;
      update({ state: 'sent', done: 1 }, msg.status === 'delivered' ? 'delivered' : 'sent');
      return msg;
    } catch (e) {
      update({ state: 'failed' }, 'failed');
      throw e;
    }
  }

  /** Someone is sending a file: note it, and get ready for the pieces. */
  _fileStart(key, chat, env, from, ts, meta) {
    const F = require('./files');
    if (!F.validMeta(meta)) return;
    const file = { name: F.safeName(meta.name), size: meta.size, sha: meta.sha, chunks: meta.chunks, preview: meta.preview || null, state: 'receiving', done: 0 };
    F.Incoming.start(this.vault.file('incoming'), from, env.id, file, key);
    const msg = { id: env.id, from, ts, text: '', file };
    this.vault.appendHistory(key, { id: msg.id, from, ts, text: '', file });
    chat.ids.add(env.id);
    this._incomingMsgs = this._incomingMsgs || new Map();
    this._incomingMsgs.set(`${from}/${env.id}`, msg);
    this.emit('line', { t: 'msg', key, msg });
    const bell = prefs.val('bell');
    if (bell !== 'off' && !this.muted(key) && bell === 'all' && chat.kind === 'dm') this.emit('bell');
  }

  /** A piece of a file arrived. */
  _fileChunk(from, c) {
    const F = require('./files');
    if (!c || typeof c.of !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(c.of) || typeof c.d !== 'string') return;
    const inc = new F.Incoming(this.vault.file('incoming'), from, c.of);
    if (!inc.load()) return; // we never heard about this file
    const { key, meta } = inc.state;
    const msg = (this._incomingMsgs && this._incomingMsgs.get(`${from}/${c.of}`)) || { id: c.of, from, file: meta };
    const publish = () => {
      this.emit('file', { key, id: c.of, file: msg.file });
      this.emit('change');
    };
    try {
      if (!inc.add(c.i, Buffer.from(c.d, 'base64'))) {
        msg.file.done = inc.progress;
        publish();
        return;
      }
      const where = inc.finish(F.saveDir(this.vault.dir, prefs.val('files')));
      msg.file = { ...msg.file, state: 'saved', done: 1, path: where };
      this.vault.appendHistory(key, { u: c.of, file: msg.file });
      this.counts.received++;
      publish();
      const risky = F.RISKY.test(where) ? ` Careful: this kind of file can run programs - only open it if you trust ${from}.` : '';
      this.say(`${from} sent ${msg.file.name} (${F.sizeText(meta.size)}). Saved to ${where}  Open it: ${this.hint('open')}${risky}`, risky ? 'warn' : 'ok');
    } catch (e) {
      msg.file = { ...msg.file, state: 'failed' };
      this.vault.appendHistory(key, { u: c.of, file: msg.file });
      publish();
      this.say(`${msg.file.name} from ${from}: ${e.message}.`, 'err');
    }
  }

  /** Send everything waiting in the outbox, in order. Safe to call any time. */
  async pump() {
    if (this._pumping || this.syncing || !this.link || !this.link.online) return;
    this._pumping = true;
    try {
      while (this.outbox.length && this.link.online && !this.syncing) {
        const job = this.outbox[0];
        try {
          if (!job.env) job.env = await this._seal(job);
          await this.link.request('send', { env: job.env });
          this.outbox.shift();
          this.counts.sent++;
          this._status(job, 'sent');
          job.resolve(job.msg);
        } catch (e) {
          if (TRANSIENT.includes(e.code) && this.link.retry) break; // retried on reconnect
          if (e.code === 'slow_down') { await new Promise((r) => setTimeout(r, 1200)); continue; }
          this.outbox.shift();
          this._status(job, 'failed');
          job.reject(e);
        }
      }
    } finally {
      this._pumping = false;
    }
  }

  _status(job, status) {
    job.msg.status = status;
    this.vault.appendHistory(job.key, { u: job.msg.id, st: status });
  }

  typingPing() {
    if (!this.target || !this.link || !this.link.online || !prefs.on('typing')) return;
    const now = Date.now();
    if (now - this._lastTyping < 3000) return;
    this._lastTyping = now;
    const name = this.target.slice(1);
    this.link.notify('typing', { conv: this.target[0] === '@' ? P.dmConv(this.me, name) : P.roomConv(name) });
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  _ack(mid) {
    this._acks.push(mid);
    if (this._ackTimer) return;
    this._ackTimer = setTimeout(() => this.flushAcks(), 40);
  }

  /** Tell the relay which messages are safely stored here, so it can delete them. */
  flushAcks() {
    clearTimeout(this._ackTimer);
    this._ackTimer = null;
    if (!this._acks.length) return;
    const mids = this._acks.splice(0);
    if (this.link) this.link.notify('got', { mids });
  }

  _onPush(m) {
    switch (m.t) {
      case 'msg':
        // one at a time, in order, and only once sign-in has finished syncing
        this._rx = this._rx.then(() => this._synced).then(() => this._onMsg(m)).catch(() => {});
        break;
      case 'caught_up':
        this._rx = this._rx.then(() => this._synced).then(() => {
          this._caughtUp = true;
          this.emit('caughtup', m.n);
        }).catch(() => {});
        break;
      case 'receipt': {
        if (!P.validName(m.by) || typeof m.id !== 'string') return;
        if (!this._has(this.chat('@' + m.by), m.id)) return; // (the pieces of a file get receipts too)
        this.vault.appendHistory('@' + m.by, { u: m.id, st: 'delivered' });
        if (prefs.on('receipts')) this.flash(`delivered to ${m.by}`);
        break;
      }
      case 'presence':
        if (!P.validName(m.name) || !this.presence.has(m.name)) return;
        if (this.presence.get(m.name) !== !!m.online) {
          this.presence.set(m.name, !!m.online);
          if (prefs.on('presence')) this.flash(`${m.name} is ${m.online ? 'online' : 'offline'}`);
          this.emit('change');
        }
        break;
      case 'typing': {
        const c = P.parseConv(m.conv);
        if (!c || !P.validName(m.from) || this.settings.blocked.includes(m.from) || !prefs.on('typing')) return;
        const key = c.kind === 'dm' ? '@' + m.from : '#' + c.room;
        if (c.kind === 'room' && !this.chats.has(key)) return;
        this.chat(key).typing.set(m.from, Date.now() + 5000);
        this.emit('change');
        break;
      }
      case 'room':
        this._onRoomEvent(m);
        break;
      case 'renamed':
        if (P.validName(m.from) && P.validName(m.to)) {
          if (m.from === this.me) {
            this._iAm(m.to);
            this.say(`You're called ${m.to} now.`, 'sys');
          } else {
            try {
              this._renamed(m.from, m.to);
              if (m.user && m.user.name === m.to) this.pin(m.user);
            } catch { /* odd keys: leave things as they were */ }
          }
          this.emit('change');
        }
        break;
      case 'session':
        this.otherSessions = Math.max(1, (Number(m.n) || 2) - 1);
        this._sessionWarning(this.otherSessions + 1, true);
        break;
      case 'signed_out':
        this.say('This window was signed out from another one of yours.', 'warn');
        if (this.link) this.link.stop();
        this.emit('change');
        break;
      default:
    }
  }

  _onRoomEvent(m) {
    if (!P.validRoom(m.room)) return;
    const key = '#' + m.room;
    if (m.event === 'invite') {
      if (P.validName(m.by)) this._invited(m.room, m.by, true);
    } else if (m.event === 'self_join') {
      // joined from another terminal: start following the room here too
      const chat = this.chat(key);
      chat.joined = true;
      this._refreshMembers(chat).catch(() => {});
    } else if (m.event === 'self_leave') {
      if (this.chats.has(key)) this.chats.get(key).joined = false;
      if (this.target === key) this.setTarget(null);
    } else if (m.event === 'join' && m.user && this.chats.has(key)) {
      try {
        this.pin(m.user);
      } catch {
        return;
      }
      this.chats.get(key).members.set(m.user.name, { online: true });
      this.say(`${m.user.name} joined #${m.room}`, 'event');
    } else if (m.event === 'leave' && P.validName(m.name) && this.chats.has(key)) {
      const chat = this.chats.get(key);
      chat.members.delete(m.name);
      chat.typing.delete(m.name);
      if (m.owner) chat.owner = m.owner;
      this.say(`${m.name} left #${m.room}`, 'event');
    } else if (m.event === 'kick' && P.validName(m.name) && this.chats.has(key)) {
      // the owner removed someone: from now on messages are no longer encrypted for them
      const chat = this.chats.get(key);
      chat.members.delete(m.name);
      chat.typing.delete(m.name);
      this.say(`${m.name} was removed from #${m.room} by ${m.by}`, 'event');
    } else if (m.event === 'owner' && P.validName(m.name) && this.chats.has(key)) {
      this.chats.get(key).owner = m.name;
      this.say(m.name === this.me ? `${m.by} handed #${m.room} to you - you own it now.` : `${m.name} now owns #${m.room}`, 'event');
    } else if (m.event === 'kicked') {
      if (this.chats.has(key)) {
        const chat = this.chats.get(key);
        chat.joined = false;
        chat.members.clear();
      }
      if (this.target === key) this.setTarget(null);
      this.say(`You were removed from #${m.room} by its owner${P.validName(m.by) ? `, ${m.by}` : ''}.`, 'warn');
    }
    this.emit('change');
  }

  _invited(room, by, live = false) {
    if (!P.validRoom(room) || !P.validName(by) || this.settings.blocked.includes(by)) return;
    if (this.chats.has('#' + room) && this.chats.get('#' + room).joined) return;
    const fresh = !this.invites.has(room);
    this.invites.set(room, by);
    if (!fresh && !live) return;
    this.rows([[[by, 'name'], [' invited you to ', null], ['#' + room, 'room'], ['  -  ', 'dim'], [this.hint(`join ${room}`), 'accent']]]);
    if (live && prefs.val('bell') !== 'off') this.emit('bell');
  }

  async _onMsg(m) {
    const env = m.env;
    if (!P.validEnvelope(env) || typeof m.mid !== 'string') return;
    let ack = true;
    try {
      const c = P.parseConv(env.conv);
      const sender = env.from;
      if (sender === this.me) return;
      // Sent under a name we don't know? Ask who that is - it may be a contact who renamed.
      if (!this.peers.get(sender) && !this.renames.has(sender) && this.link && this.link.online) {
        try {
          await this.peerFor(sender);
        } catch { /* handled below */ }
      }
      const from = this.renames.get(sender) || sender;
      let key;
      if (c.kind === 'dm') {
        if (env.conv !== P.dmConv(sender, this.me)) return;
        key = '@' + from;
      } else {
        key = '#' + c.room;
      }
      // `gossip listen <who>`: leave everything else waiting on the relay for later
      if (this.filter && key !== this.filter) { ack = false; return; }
      if (this.settings.blocked.includes(from)) return;

      const chat = this.chat(key);
      if (chat.kind === 'room' && !chat.joined) {
        // maybe joined a moment ago from another terminal - ask before giving up
        try {
          await this._refreshMembers(chat);
        } catch (e) {
          if (TRANSIENT.includes(e.code)) ack = false;
          return;
        }
      }
      if (this._has(chat, env.id)) return; // already have it

      let peer;
      try {
        peer = await this.peerFor(from);
      } catch (e) {
        // Can't fetch their key right now: leave it on the relay and try next time.
        if (TRANSIENT.includes(e.code)) ack = false;
        return;
      }

      let payload;
      try {
        payload = e2e.open({ identity: this.identity, me: this.me, env, senderSignPub: peer.signPub });
      } catch (e) {
        if (e.code === 'not_for_me') return;
        if (e.code === 'bad_signature') {
          // Has their key changed on the relay? pin() raises the warning if so.
          try {
            const res = await this.link.request('lookup', { name: sender });
            this.pin(res.user);
          } catch { /* stay with what we know */ }
        }
        this.say(`A message from ${from} couldn't be verified, so it was hidden.`, 'warn');
        return;
      }

      // call details (ring, answer, hang up): handled by the call code, never shown or saved
      if (payload && payload.call && typeof payload.call === 'object' && chat.kind === 'dm') {
        this.emit('signal', { from, data: payload.call, ts: env.ts });
        return;
      }
      if (payload && payload.file && typeof payload.file === 'object') {
        const ts = Number.isSafeInteger(m.ts) ? m.ts : env.ts;
        this._fileStart(key, chat, env, from, ts, payload.file);
        return;
      }
      if (payload && payload.chunk && typeof payload.chunk === 'object') {
        this._fileChunk(from, payload.chunk);
        return;
      }
      const text = cleanText(payload && payload.text);
      if (!text) return;
      this.counts.received++;
      const ts = Number.isSafeInteger(m.ts) ? m.ts : env.ts;
      const msg = { id: env.id, from, ts, text };
      this.vault.appendHistory(key, msg);
      chat.ids.add(env.id);
      chat.typing.delete(from);
      this.emit('line', { t: 'msg', key, msg });
      const mentioned = mentions(text, this.me);
      const bell = prefs.val('bell');
      if (bell !== 'off' && !this.muted(key) && (mentioned || (bell === 'all' && chat.kind === 'dm'))) this.emit('bell');
    } finally {
      if (ack) this._ack(m.mid);
    }
  }

  /** Resolves once everything that was waiting on the relay has been handled. */
  caughtUp(timeout = 10000) {
    if (this._caughtUp) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('timeout', 'the server took too long to answer')), timeout);
      this.once('caughtup', (n) => {
        clearTimeout(timer);
        resolve(n);
      });
    });
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  /** Called a few times a second by the live prompt. Returns true if the screen should refresh. */
  tick(now = Date.now()) {
    let changed = false;
    for (const c of this.chats.values()) {
      for (const [name, until] of c.typing) {
        if (until <= now) {
          c.typing.delete(name);
          changed = true;
        }
      }
    }
    // another terminal may have added a contact or changed a setting
    if (now - (this._lastFileCheck || 0) > 2000) {
      this._lastFileCheck = now;
      if (this.mode === 'live' && this.link && this.link.online && !this.syncing) {
        const names = this.contacts().map((p) => p.name).join(',');
        if (names !== this._watched) this._watch().catch(() => {});
      }
      if (this.vault.settingsChanged()) {
        const target = this.target;
        this.settings = this.vault.loadSettings();
        this.target = target;
      }
    }
    return changed;
  }

  /** Who is typing right now, as a short sentence (or ''). */
  typingText() {
    for (const c of this.chats.values()) {
      const names = [...c.typing.keys()];
      if (!names.length) continue;
      const who = names.length > 2 ? 'several people are' : names.length === 2 ? `${names[0]} and ${names[1]} are` : `${names[0]} is`;
      return `${who} typing${c.kind === 'room' ? ` in #${c.name}` : ''}…`;
    }
    return '';
  }

  async refreshRooms(force = false) {
    if (!this.link || !this.link.online) return;
    const now = Date.now();
    if (!force && now - this._roomsFetched < 20000) return;
    this._roomsFetched = now;
    try {
      const res = await this.link.request('rooms');
      this.knownRooms = (res.rooms || []).filter((r) => P.validRoom(r.name));
      this.emit('change');
    } catch { /* suggestions are optional */ }
  }
}

/** Connect just long enough to see that a gossip relay (or website) answers. */
async function probeServer(url) {
  if (/^https?:\/\//i.test(url)) return probeHttp(url);
  let conn;
  try {
    conn = await ws.connect(url, { timeout: 8000 });
  } catch (e) {
    throw new Error(friendlyNetError(e));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.terminate();
      reject(new Error("that server didn't answer like a gossip relay"));
    }, 5000);
    conn.on('message', (text) => {
      clearTimeout(timer);
      conn.close();
      try {
        const m = JSON.parse(text);
        if (m.t === 'hello') return resolve(m);
      } catch { /* fall through */ }
      reject(new Error("that server isn't a gossip relay"));
    });
    conn.on('close', () => {
      clearTimeout(timer);
      reject(new Error('the server closed the connection'));
    });
  });
}

module.exports = { App, normalizeServer, resolveServer, probeServer, fail };

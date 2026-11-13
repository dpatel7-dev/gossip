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

  say(text, kind = 'sys') {
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
      this.conn = { state, detail };
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
      const why = e.code === 'name_taken' ? `the name "${this.me}" belongs to someone else on this relay` : e.message;
      this.say(`Couldn't sign in to ${link.host}: ${why}.`, 'err');
    });
  }

  async _onReady(res) {
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
    const p = this.peers.get(user.name);
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

  async peerFor(name, { refresh = false } = {}) {
    const known = this.peers.get(name);
    if (known && !refresh) return known;
    if (!this.link || !this.link.online) {
      if (known) return known;
      throw fail('offline', `You're offline, so ${name} can't be looked up right now`);
    }
    const res = await this.link.request('lookup', { name });
    return this.pin(res.user);
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
    const chat = this.chat(job.key);
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
    return e2e.seal({
      identity: this.identity, from: this.me, conv, recipients,
      payload: { text: job.msg.text }, id: job.msg.id, ts: job.msg.ts,
    });
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
      const from = env.from;
      if (from === this.me) return;
      let key;
      if (c.kind === 'dm') {
        if (env.conv !== P.dmConv(from, this.me)) return;
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
            const res = await this.link.request('lookup', { name: from });
            this.pin(res.user);
          } catch { /* stay with what we know */ }
        }
        this.say(`A message from ${from} couldn't be verified, so it was hidden.`, 'warn');
        return;
      }

      const text = cleanText(payload && payload.text);
      if (!text) return;
      const ts = Number.isSafeInteger(m.ts) ? m.ts : env.ts;
      const msg = { id: env.id, from, ts, text };
      this.vault.appendHistory(key, msg);
      chat.ids.add(env.id);
      chat.typing.delete(from);
      this.emit('line', { t: 'msg', key, msg });
      const mentioned = mentions(text, this.me);
      const bell = prefs.val('bell');
      if (bell !== 'off' && (mentioned || (bell === 'all' && chat.kind === 'dm'))) this.emit('bell');
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

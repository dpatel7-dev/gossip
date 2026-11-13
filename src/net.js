'use strict';
// The client's connection to a relay: sign-in, request/response, heartbeats,
// and automatic reconnection.

const { EventEmitter } = require('events');
const ws = require('./ws');
const e2e = require('./e2e');
const P = require('./proto');

const FATAL = new Set(['name_taken', 'bad_name', 'bad_keys', 'bad_proof', 'unknown_user', 'signup_limit', 'signups_closed']);

function friendlyNetError(err) {
  const code = err && err.code;
  switch (code) {
    case 'ENOTFOUND': case 'EAI_AGAIN': return "can't find that relay (check the address and your internet)";
    case 'ECONNREFUSED': return "the relay isn't answering";
    case 'ETIMEDOUT': case 'ESOCKETTIMEDOUT': return 'the relay took too long to answer';
    case 'ECONNRESET': case 'EPIPE': return 'the connection dropped';
    case 'ENETUNREACH': case 'EHOSTUNREACH': return "can't reach the network";
    case 'EBADURL': case 'EBADHANDSHAKE': return err.message;
    default:
      if (code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(code))) {
        return "the relay's security certificate isn't valid";
      }
      return (err && err.message) || 'connection failed';
  }
}

function err(code, message) {
  return Object.assign(new Error(message), { code });
}

class Link extends EventEmitter {
  /**
   * mode:  'live' (chat prompt / listen), 'peek' (check), 'post' (one-off commands)
   * retry: keep reconnecting forever (true) or give up after the first failure (false)
   */
  constructor({ url, identity, name, create = true, mode = 'live', retry = true }) {
    super();
    this.url = url;
    this.identity = identity;
    this.name = name;
    this.create = create;
    this.mode = mode;
    this.retry = retry;
    this.state = 'idle'; // idle | connecting | online | offline
    this.detail = {};
    this.conn = null;
    this.server = null;
    this.fatal = false;
    this.stopped = true;
    this._rid = 0;
    this._pending = new Map();
    this._backoff = 0;
    this._retryTimer = null;
    this._heartbeat = null;
  }

  get online() {
    return this.state === 'online';
  }

  /** True when the link is plain ws:// to something other than this machine. */
  get insecure() {
    try {
      const u = new URL(this.url);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      return u.protocol === 'ws:' && !local;
    } catch {
      return false;
    }
  }

  get host() {
    try {
      return new URL(this.url).host;
    } catch {
      return this.url;
    }
  }

  start() {
    this.stopped = false;
    this.fatal = false;
    this._backoff = 0;
    this._open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._heartbeat);
    this._failPending('offline', 'You are offline');
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      c.close(1000, 'bye');
    }
    this._set('idle');
  }

  retryNow() {
    if (this.stopped || this.conn || this.state === 'connecting') return;
    clearTimeout(this._retryTimer);
    this.fatal = false;
    this._backoff = 0;
    this._open();
  }

  _set(state, detail = {}) {
    this.state = state;
    this.detail = detail;
    this.emit('state', state, detail);
  }

  async _open() {
    clearTimeout(this._retryTimer);
    this._set('connecting');
    let conn;
    try {
      conn = await ws.connect(this.url, { timeout: 10000, maxPayload: P.LIMITS.frame * 2 });
    } catch (e) {
      if (this.stopped) return;
      return this._retry(friendlyNetError(e));
    }
    if (this.stopped) return conn.close();
    this.conn = conn;
    this._lastRx = Date.now();
    this._bye = null;

    conn.on('message', (text) => {
      this._lastRx = Date.now();
      this._incoming(conn, text);
    });
    conn.on('close', () => {
      clearInterval(this._heartbeat);
      if (this.conn !== conn) return;
      this.conn = null;
      this._failPending('disconnected', 'The connection dropped');
      if (this.stopped || this.fatal) return;
      this._retry('the connection dropped');
    });
    this._heartbeat = setInterval(() => {
      if (Date.now() - this._lastRx > 60000) return conn.terminate();
      if (this.state === 'online') this.request('ping', {}, 15000).catch(() => {});
    }, 25000);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  _incoming(conn, text) {
    if (this.conn !== conn) return;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        return void this._signIn(m);
      case 'ok':
      case 'err': {
        const p = this._pending.get(m.rid);
        if (!p) return;
        this._pending.delete(m.rid);
        clearTimeout(p.timer);
        if (m.t === 'ok') p.resolve(m);
        else p.reject(err(m.code || 'error', m.msg || 'Request failed'));
        return;
      }
      default:
        this.emit('push', m);
    }
  }

  async _signIn(hello) {
    if (hello.v !== P.PROTOCOL) {
      this.fatal = true;
      this._set('offline', { reason: 'version', message: 'this relay speaks a different gossip version - run: gossip update' });
      this.emit('fail', Object.assign(new Error('this relay speaks a different gossip version - run: gossip update'), { code: 'version' }));
      if (this.conn) this.conn.close();
      return;
    }
    this.server = { name: hello.server, motd: hello.motd, version: hello.version };
    try {
      const res = await this._send('auth', {
        name: this.name,
        ...e2e.bundleOf(this.identity),
        sig: e2e.authProof(this.identity, String(hello.nonce), this.name),
        create: this.create,
        mode: this.mode,
      });
      this._backoff = 0;
      this._set('online');
      this.emit('ready', res);
    } catch (e) {
      if (e.code === 'disconnected' || e.code === 'offline') return;
      if (FATAL.has(e.code)) {
        this.fatal = true;
        this._set('offline', { reason: e.code, message: e.message });
        this.emit('authfail', e);
        if (this.conn) this.conn.close();
      } else if (this.conn) {
        this.conn.terminate();
      }
    }
  }

  /** Ask the relay something. Rejects with an Error carrying a .code. */
  request(t, payload = {}, timeout = 12000) {
    if (!this.conn || this.state !== 'online') return Promise.reject(err('offline', "You're offline"));
    return this._send(t, payload, timeout);
  }

  /** Fire-and-forget. */
  notify(t, payload = {}) {
    if (this.conn && this.state === 'online') this.conn.send(JSON.stringify({ t, ...payload }));
  }

  _send(t, payload, timeout = 12000) {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(err('offline', "You're offline"));
      const rid = ++this._rid;
      const timer = setTimeout(() => {
        this._pending.delete(rid);
        reject(err('timeout', 'The server took too long to answer'));
      }, timeout);
      this._pending.set(rid, { resolve, reject, timer });
      this.conn.send(JSON.stringify({ t, rid, ...payload }));
    });
  }

  _failPending(code, message) {
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(err(code, message));
    }
    this._pending.clear();
  }

  _retry(reason) {
    if (this.stopped || this.fatal) return;
    if (!this.retry) {
      this.fatal = true;
      this._set('offline', { reason: 'network', message: reason });
      this.emit('fail', Object.assign(new Error(reason), { code: 'network' }));
      return;
    }
    this._backoff = Math.min(30000, this._backoff ? this._backoff * 2 : 1000);
    const wait = Math.round(this._backoff * (0.75 + Math.random() * 0.5));
    this._set('offline', { reason: 'network', message: reason, retryAt: Date.now() + wait });
    this._retryTimer = setTimeout(() => this._open(), wait);
  }
}

module.exports = { Link, friendlyNetError };

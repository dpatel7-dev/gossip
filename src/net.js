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

  /** Stop, but give the last few bytes (like "got it" receipts) time to leave. */
  async shutdown(ms = 700) {
    const conn = this.conn;
    this.stop();
    if (conn && !conn.closed) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        conn.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
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

// ── the same thing over plain web requests ──────────────────────────────────
// A gossip website (hub/gossip_hub.py) can't hold a connection open, so this
// link asks it for news every second or two instead. Everything above it (the
// app) can't tell the difference.

const http = require('http');
const https = require('https');

const POLL_BUSY = 1000; // someone is talking
const POLL_WARM = 2500; // talked in the last few minutes
const POLL_IDLE = 5000;

class HttpLink extends EventEmitter {
  constructor({ url, identity, name, create = true, mode = 'live', retry = true }) {
    super();
    this.url = String(url).replace(/\/+$/, '');
    this.identity = identity;
    this.name = name;
    this.create = create;
    this.mode = mode;
    this.retry = retry;
    this.state = 'idle';
    this.detail = {};
    this.conn = null; // (the relay link has one; nothing here does)
    this.server = null;
    this.token = null;
    this.fatal = false;
    this.stopped = true;
    this._gen = 0;
    this._backoff = 0;
    this._retryTimer = null;
    this._pollTimer = null;
    this._busyUntil = 0;
    this._warmUntil = 0;
    this._inflight = new Set();
    this._agent = null;
  }

  get online() {
    return this.state === 'online';
  }

  get insecure() {
    try {
      const u = new URL(this.url);
      return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
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
    const token = this.token;
    this.stopped = true;
    this._gen++;
    this.token = null;
    clearTimeout(this._retryTimer);
    clearTimeout(this._pollTimer);
    if (token) this._track(this._post({ t: 'bye', token }, 3000).catch(() => {}));
    this._set('idle');
  }

  async shutdown(ms = 1500) {
    this.stop();
    const all = Promise.all([...this._inflight]);
    await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
    if (this._agent) this._agent.destroy();
    this._agent = null;
  }

  retryNow() {
    if (this.stopped || this.state === 'online' || this.state === 'connecting') return;
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

  _track(promise) {
    this._inflight.add(promise);
    const done = () => this._inflight.delete(promise);
    promise.then(done, done);
    return promise;
  }

  /** One request to the website. Resolves with its reply, or rejects with an Error carrying .code. */
  _post(body, timeout = 12000) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(this.url + '/api');
      } catch {
        return reject(Object.assign(err('network', "that address doesn't look right"), { net: true }));
      }
      const lib = u.protocol === 'https:' ? https : http;
      if (!this._agent || this._agent.protocol !== u.protocol) {
        this._agent = new lib.Agent({ keepAlive: true, maxSockets: 4 });
      }
      const data = Buffer.from(JSON.stringify(body));
      const fail = (e) => reject(Object.assign(err('disconnected', typeof e === 'string' ? e : friendlyNetError(e)), { net: true }));
      const req = lib.request(u, {
        method: 'POST', agent: this._agent, timeout,
        headers: { 'content-type': 'application/json', 'content-length': data.length, 'user-agent': 'gossip' },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > P.LIMITS.frame * 8) req.destroy(new Error('the reply was too large'));
          else chunks.push(c);
        });
        res.on('error', fail);
        res.on('end', () => {
          let m = null;
          try {
            m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch { /* not ours */ }
          if (!m || typeof m !== 'object' || (m.t !== 'ok' && m.t !== 'err')) {
            return fail(res.statusCode >= 500 ? 'the website is having trouble' : "that website isn't answering like gossip");
          }
          if (m.t === 'ok') resolve(m);
          else reject(err(m.code || 'error', m.msg || 'Request failed'));
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', fail);
      req.end(data);
    });
  }

  async _open() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._pollTimer);
    const gen = ++this._gen;
    this.token = null;
    this._set('connecting');
    try {
      const hello = await this._post({ t: 'hello' }, 10000);
      if (gen !== this._gen) return;
      if (hello.v !== P.PROTOCOL) throw err('version', 'this relay speaks a different gossip version - run: gossip update');
      this.server = { name: hello.server, motd: hello.motd, version: hello.version };
      const res = await this._post({
        t: 'auth', nonce: hello.nonce, name: this.name, ...e2e.bundleOf(this.identity),
        sig: e2e.authProof(this.identity, String(hello.nonce), this.name),
        create: this.create, mode: this.mode,
      });
      if (gen !== this._gen) {
        this._post({ t: 'bye', token: res.token }, 3000).catch(() => {});
        return;
      }
      this.token = res.token;
      this._backoff = 0;
      this._set('online');
      this.emit('ready', res);
      this._deliver(res.events);
      if (this.mode !== 'post') this._pollSoon(POLL_BUSY);
    } catch (e) {
      if (gen !== this._gen) return;
      if (e.code === 'version') {
        this.fatal = true;
        this._set('offline', { reason: 'version', message: e.message });
        this.emit('fail', e);
      } else if (FATAL.has(e.code)) {
        this.fatal = true;
        this._set('offline', { reason: e.code, message: e.message });
        this.emit('authfail', e);
      } else {
        this._retry(e.message);
      }
    }
  }

  _deliver(events) {
    if (!Array.isArray(events) || !events.length) return;
    this._bump();
    for (const ev of events) if (ev && typeof ev === 'object') this.emit('push', ev);
  }

  _bump() {
    const now = Date.now();
    const was = this._busyUntil > now;
    this._busyUntil = now + 15000;
    this._warmUntil = now + 3 * 60 * 1000;
    // was waiting on the slow clock: look again soon
    if (!was && this.online && this.mode !== 'post' && !this._polling) this._pollSoon(POLL_BUSY);
  }

  _pollSoon(ms) {
    clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => this._poll(), ms);
    if (this._pollTimer.unref && this.mode !== 'live') this._pollTimer.unref();
  }

  async _poll() {
    if (!this.online || this._polling) return;
    const gen = this._gen;
    this._polling = true;
    try {
      const res = await this._call('poll', {}, 15000);
      if (gen !== this._gen) return;
      this._deliver(res.events);
    } catch {
      return; // _call already dealt with a lost connection
    } finally {
      this._polling = false;
    }
    if (gen !== this._gen || !this.online) return;
    const now = Date.now();
    this._pollSoon(now < this._busyUntil ? POLL_BUSY : now < this._warmUntil ? POLL_WARM : POLL_IDLE);
  }

  async _call(t, payload, timeout) {
    const gen = this._gen;
    try {
      return await this._post({ t, token: this.token, ...payload }, timeout);
    } catch (e) {
      if (gen === this._gen && (e.net || e.code === 'bad_session')) {
        // the website forgot us (laptop slept?) or can't be reached: sign in again
        this._lost(e.code === 'bad_session' ? null : e.message);
        throw err('disconnected', 'The connection dropped');
      }
      throw e;
    }
  }

  _lost(reason) {
    if (this.stopped || this.state !== 'online') return;
    this._gen++;
    this.token = null;
    clearTimeout(this._pollTimer);
    if (reason === null && this.retry) this._open();
    else this._retry(reason || 'the connection dropped');
  }

  request(t, payload = {}, timeout = 12000) {
    if (this.state !== 'online') return Promise.reject(err('offline', "You're offline"));
    if (t === 'send') this._bump();
    return this._call(t, payload, timeout);
  }

  notify(t, payload = {}) {
    if (this.state !== 'online') return;
    if (t === 'typing') this._bump();
    this._track(this._call(t, payload, 8000).catch(() => {}));
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

/** A relay address (ws://, wss://) or a gossip website (http://, https://)? */
function makeLink(opts) {
  return /^https?:\/\//i.test(opts.url) ? new HttpLink(opts) : new Link(opts);
}

/** GET <website>/api and check that gossip answers. */
function probeHttp(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(String(url).replace(/\/+$/, '') + '/api');
    } catch {
      return reject(new Error("that address doesn't look right"));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout, headers: { 'user-agent': 'gossip' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 4096) text += c; });
      res.on('end', () => {
        try {
          const m = JSON.parse(text);
          if (m && m.gossip === true) return resolve(m);
        } catch { /* fall through */ }
        reject(new Error("that website isn't running gossip"));
      });
      res.on('error', (e) => reject(new Error(friendlyNetError(e))));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(new Error(friendlyNetError(e))));
  });
}

module.exports = { Link, HttpLink, makeLink, probeHttp, friendlyNetError };

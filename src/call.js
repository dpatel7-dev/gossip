'use strict';
// Voice and video calls.
//
// The terminal does the talking-about-it: who's calling, answering, hanging up.
// The sound and pictures happen in your web browser, which is the only thing on
// a computer that can use the microphone and camera without installing anything.
//
//   1. You type /call maya. gossip sends maya a "ring" (end-to-end encrypted, the
//      same as any message) and opens a call window in your browser.
//   2. Your browser prepares the call and hands gossip its connection details,
//      which gossip sends to maya - again encrypted.
//   3. maya answers in her terminal; her browser opens and replies the same way.
//   4. The two browsers connect directly to each other. Sound and video go
//      straight between your computers, encrypted, and never through the relay.
//
// Because the connection details travel inside gossip's own encrypted, signed
// messages, nobody in the middle can slip themselves into the call.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const prefs = require('./prefs');
const notify = require('./notify');
const { Web, openBrowser } = require('./web');

const RING_MS = 45000;
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const ACTIVE = new Set(['calling', 'ringing', 'connecting', 'live']);

class Calls extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.list = new Map(); // id -> call
    this.web = null;
    this.stunUsed = 0;
    app.on('signal', (s) => this._signal(s).catch(() => {}));
  }

  /** The call that's happening (or ringing) right now, if any. */
  get current() {
    for (const c of this.list.values()) if (ACTIVE.has(c.state)) return c;
    return null;
  }

  get ringing() {
    const c = this.current;
    return c && c.dir === 'in' && c.state === 'ringing' ? c : null;
  }

  async _web() {
    if (!this.web) {
      this.web = this.app.web || new Web(this.app);
      this.app.web = this.web;
      this._routes();
    }
    await this.web.start();
    return this.web;
  }

  _routes() {
    const web = this.web;
    web.on('GET', 'call', async (req, res, [id], send) => {
      const c = this.list.get(id);
      if (!c) return send(404, 'This call is over.\n');
      const ice = await this._ice();
      return send(200, web.page('call.html', {
        ice,
        id: c.id, role: c.dir === 'out' ? 'caller' : 'callee', me: this.app.me, peer: c.peer, video: c.video, icon: 'phone',
        api: web.url(`callapi/${c.id}`), events: web.url(`callevents/${c.id}`), stun: STUN,
      }), 'text/html; charset=utf-8');
    });
    // The page listens here for news from gossip (the other side's details, hang-ups).
    web.on('GET', 'callevents', (req, res, [id], send) => {
      const c = this.list.get(id);
      if (!c) return send(404, 'gone\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      write({ t: 'hello', state: c.state });
      if (c.remoteSdp) write({ t: c.dir === 'out' ? 'answer' : 'offer', sdp: c.remoteSdp });
      if (!ACTIVE.has(c.state)) write({ t: 'end', reason: c.reason || 'ended' });
      c.pages.add(write);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        c.pages.delete(write);
      });
      return undefined;
    });
    // The page tells gossip what it needs sent, and how the call is going.
    web.on('POST', 'callapi', async (req, res, [id], send, m) => {
      const c = this.list.get(id);
      if (!c || !m || typeof m.t !== 'string') return send(404, '{}', 'application/json');
      await this._fromPage(c, m);
      return send(200, '{}', 'application/json');
    });
  }

  /**
   * The servers that help two browsers find each other: public STUN, plus any
   * TURN server your relay or website hands out, plus your own (call.turn).
   */
  async _ice() {
    const list = [{ urls: STUN }];
    const now = Date.now();
    if (!this._turn || now - this._turn.at > 10 * 60 * 1000) {
      let fromServer = [];
      try {
        if (this.app.link && this.app.link.online) fromServer = (await this.app.link.request('ice', {}, 5000)).ice || [];
      } catch { /* an older relay: nothing extra */ }
      this._turn = { at: now, list: Array.isArray(fromServer) ? fromServer.slice(0, 6) : [] };
    }
    for (const x of this._turn.list) {
      if (x && (typeof x.urls === 'string' || Array.isArray(x.urls))) list.push({ urls: x.urls, username: x.username || undefined, credential: x.credential || undefined });
    }
    const mine = String(prefs.val('call.turn') || '').trim().split(/\s+/);
    if (/^turns?:/.test(mine[0])) list.push({ urls: mine[0], username: mine[1], credential: mine[2] });
    return list;
  }

  _new(peer, dir, id, video) {
    const c = {
      id: id || crypto.randomBytes(9).toString('base64url'), peer, dir, video: !!video,
      state: dir === 'out' ? 'calling' : 'ringing', made: Date.now(), started: 0, ended: 0,
      reason: null, remoteSdp: null, pages: new Set(), route: null, timer: null,
    };
    this.list.set(c.id, c);
    c.timer = setTimeout(() => this._timeout(c), RING_MS);
    return c;
  }

  _tell(c, ev) {
    for (const write of c.pages) {
      try { write(ev); } catch { /* page gone */ }
    }
  }

  _set(c, state, reason = null) {
    c.state = state;
    if (reason) c.reason = reason;
    if (state === 'live' && !c.started) c.started = Date.now();
    if (ACTIVE.has(state) && !this._hot) {
      // a website-based link checks for news less often when things are quiet: not during a call
      this._hot = setInterval(() => {
        if (!this.current) { clearInterval(this._hot); this._hot = null; return; }
        if (this.app.link && typeof this.app.link._bump === 'function') this.app.link._bump();
      }, 4000);
    }
    if (state === 'live') clearTimeout(c.timer);
    if (!ACTIVE.has(state)) {
      c.ended = Date.now();
      clearTimeout(c.timer);
      this._tell(c, { t: 'end', reason: c.reason || 'ended' });
    }
    this.emit('change', c);
    this.app.emit('change');
  }

  async _send(c, data) {
    await this.app.signal(c.peer, { ...data, id: c.id });
  }

  /** /call maya  (video: start with the camera on) */
  async start(peer, { video = false } = {}) {
    if (this.current) throw new Error(`You're already in a call with ${this.current.peer}. Hang up first: ${this.app.hint('hangup')}`);
    const c = this._new(peer, 'out', null, video);
    try {
      await this._send(c, { t: 'ring', video: c.video });
    } catch (e) {
      this.list.delete(c.id);
      clearTimeout(c.timer);
      throw e;
    }
    const url = await this._open(c);
    this.app.say(`Calling ${peer}… Your browser has the call window${url ? ` (or open ${url})` : ''}. Hang up: ${this.app.hint('hangup')}`, 'event');
    this.emit('change', c);
    this.app.emit('change');
    return c;
  }

  async answer() {
    const c = this.ringing;
    if (!c) throw new Error("Nobody's calling right now.");
    this._set(c, 'connecting');
    const url = await this._open(c);
    this.app.say(`Answering ${c.peer}… The call is in your browser${url ? ` (or open ${url})` : ''}. Hang up: ${this.app.hint('hangup')}`, 'event');
    return c;
  }

  async decline() {
    const c = this.ringing;
    if (!c) throw new Error("Nobody's calling right now.");
    this._set(c, 'ended', 'declined');
    await this._send(c, { t: 'end', reason: 'declined' }).catch(() => {});
    this.app.say(`Declined ${c.peer}'s call.`, 'sys');
  }

  async hangup() {
    const c = this.current;
    if (!c) throw new Error("You're not in a call.");
    await this._end(c, 'hung up');
    this.app.say(`Call with ${c.peer} ended${c.started ? ` after ${duration(Date.now() - c.started)}` : ''}.`, 'sys');
  }

  async _end(c, reason) {
    if (!ACTIVE.has(c.state)) return;
    this._set(c, 'ended', reason);
    await this._send(c, { t: 'end', reason }).catch(() => {});
  }

  async _open(c) {
    const web = await this._web();
    const url = web.url(`call/${c.id}`);
    this.stunUsed = Date.now();
    return openBrowser(url) ? null : url;
  }

  _timeout(c) {
    if (c.state === 'calling') {
      this._end(c, 'no answer');
      this.app.say(`${c.peer} didn't answer.`, 'sys');
    } else if (c.state === 'ringing') {
      this._set(c, 'ended', 'missed');
      this.app.say(`Missed call from ${c.peer}.`, 'warn');
    }
  }

  async _fromPage(c, m) {
    if (m.t === 'offer' && c.dir === 'out' && typeof m.sdp === 'string' && m.sdp.length < 60000) {
      await this._send(c, { t: 'offer', sdp: m.sdp, video: c.video });
    } else if (m.t === 'answer' && c.dir === 'in' && typeof m.sdp === 'string' && m.sdp.length < 60000) {
      await this._send(c, { t: 'answer', sdp: m.sdp });
    } else if ((m.t === 'reoffer' || m.t === 'reanswer') && ACTIVE.has(c.state) && typeof m.sdp === 'string' && m.sdp.length < 60000) {
      await this._send(c, { t: m.t, sdp: m.sdp });
    } else if (m.t === 'restart' && ACTIVE.has(c.state)) {
      if (!c.lastRestart || Date.now() - c.lastRestart > 3000) {
        c.lastRestart = Date.now();
        await this._send(c, { t: 'restart' });
      }
    } else if (m.t === 'live' && ACTIVE.has(c.state)) {
      if (c.state !== 'live') {
        this._set(c, 'live');
        this.app.say(`On a call with ${c.peer}. Hang up: ${this.app.hint('hangup')}`, 'ok');
      }
    } else if (m.t === 'stats' && m.route && typeof m.route === 'object') {
      c.route = {
        kind: String(m.route.kind || '').slice(0, 20), remote: String(m.route.remote || '').slice(0, 60),
        proto: String(m.route.proto || '').slice(0, 8), rtt: Number(m.route.rtt) || null,
      };
    } else if (m.t === 'failed' && ACTIVE.has(c.state)) {
      await this._end(c, 'connection failed');
      this.app.say(`The call with ${c.peer} couldn't connect${m.why ? `: ${String(m.why).slice(0, 120)}` : ''}.`, 'err');
    } else if (m.t === 'end' && ACTIVE.has(c.state)) {
      await this._end(c, 'hung up');
      this.app.say(`Call with ${c.peer} ended${c.started ? ` after ${duration(Date.now() - c.started)}` : ''}.`, 'sys');
    }
  }

  /** Something call-related arrived from someone. */
  async _signal({ from, data, ts }) {
    if (!data || typeof data.t !== 'string' || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{6,32}$/.test(data.id)) return;
    const app = this.app;
    let c = this.list.get(data.id);
    if (c && c.peer !== from) return; // someone else's call id: ignore

    if (data.t === 'ring') {
      if (c) return;
      const old = Date.now() - (Number(ts) || 0) > RING_MS;
      const who = app.peers.get(from);
      const allowed = prefs.val('calls') === 'everyone' || (prefs.val('calls') === 'contacts' && who && who.contact);
      if (old) return app.say(`Missed call from ${from}.`, 'warn');
      if (!allowed || app.muted('@' + from)) {
        if (prefs.val('calls') !== 'off' && !(who && who.contact)) app.say(`${from} tried to call you. Only people in your contacts can call - add them to allow it: ${app.hint('add ' + from)}`, 'warn');
        await app.signal(from, { t: 'end', id: data.id, reason: 'unavailable' }).catch(() => {});
        return;
      }
      if (this.current) {
        app.say(`Missed call from ${from} - you were on another call.`, 'warn');
        await app.signal(from, { t: 'end', id: data.id, reason: 'busy' }).catch(() => {});
        return;
      }
      c = this._new(from, 'in', data.id, data.video);
      app.say(`${from} is calling${c.video ? ' (video)' : ''}. Answer: ${app.hint('answer')}   Decline: ${app.hint('decline')}`, 'event');
      app.emit('bell');
      notify.send('gossip', `${from} is calling - answer in your terminal`);
      this.emit('ring', c);
      this.emit('change', c);
      app.emit('change');
      return;
    }
    if (!c) return;
    if (data.t === 'offer' && c.dir === 'in' && typeof data.sdp === 'string') {
      c.remoteSdp = data.sdp;
      this._tell(c, { t: 'offer', sdp: data.sdp });
    } else if (data.t === 'answer' && c.dir === 'out' && typeof data.sdp === 'string' && ACTIVE.has(c.state)) {
      c.remoteSdp = data.sdp;
      if (c.state === 'calling') this._set(c, 'connecting');
      this._tell(c, { t: 'answer', sdp: data.sdp });
    } else if (['reoffer', 'reanswer'].includes(data.t) && typeof data.sdp === 'string' && ACTIVE.has(c.state)) {
      // the connection is being rebuilt (a network hiccup): hand the new details to the browser
      if (data.t === 'reoffer' && c.dir === 'in') this._tell(c, { t: 'reoffer', sdp: data.sdp });
      if (data.t === 'reanswer' && c.dir === 'out') this._tell(c, { t: 'reanswer', sdp: data.sdp });
    } else if (data.t === 'restart' && c.dir === 'out' && ACTIVE.has(c.state)) {
      this._tell(c, { t: 'restart' });
    } else if (data.t === 'end' && ACTIVE.has(c.state)) {
      const reason = { declined: 'declined', busy: 'busy', unavailable: 'unavailable' }[data.reason] || 'hung up';
      const was = c.state;
      this._set(c, 'ended', reason);
      if (reason === 'declined') app.say(`${from} declined the call.`, 'sys');
      else if (reason === 'busy') app.say(`${from} is on another call.`, 'sys');
      else if (reason === 'unavailable') app.say(`${from} can't take calls from you right now.`, 'sys');
      else if (was === 'ringing') app.say(`Missed call from ${from}.`, 'warn');
      else app.say(`${from} hung up${c.started ? ` after ${duration(Date.now() - c.started)}` : ''}.`, 'sys');
    }
  }

  /** For the dashboard. */
  summary() {
    return [...this.list.values()].slice(-10).map((c) => ({
      peer: c.peer, dir: c.dir, state: c.state, video: c.video, made: c.made, started: c.started, ended: c.ended, reason: c.reason, route: c.route,
    }));
  }

  close() {
    for (const c of this.list.values()) {
      if (ACTIVE.has(c.state)) {
        this._set(c, 'ended', 'hung up');
        this.app.signal(c.peer, { t: 'end', id: c.id, reason: 'hung up' }).catch(() => {});
      }
    }
  }
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

module.exports = { Calls, STUN, duration };

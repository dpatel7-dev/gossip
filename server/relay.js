'use strict';
// The gossip relay: a small server that introduces people to each other and
// passes sealed envelopes along. It can't read messages - it never has the keys.
//
// What it stores: usernames with their PUBLIC keys, room member lists, and
// still-undelivered ciphertext (deleted as soon as the recipient confirms it).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ws = require('../src/ws');
const e2e = require('../src/e2e');
const P = require('../src/proto');
const VERSION = require('../package.json').version;

const DAY = 24 * 60 * 60 * 1000;

// ── storage ─────────────────────────────────────────────────────────────────

class Db {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'relay-db.json') : null;
    this.users = new Map(); // name -> { name, signPub, dhPub, dhSig, created, seen, blocked:Set, invites:Map(room->by) }
    this.rooms = new Map(); // name -> { name, private, owner, created, members:Set, invited:Set, banned:Set }
    this.queues = new Map(); // name -> [{ b: bodyKey, k: wrappedKey }]
    this.bodies = new Map(); // bodyKey -> { env, ts, refs, dm }
    this.aliases = new Map(); // an old username -> what that account is called now
    this._dirty = false;
    this._timer = null;
    this._writing = false;
    if (this.file) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this._load();
    }
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    const data = JSON.parse(raw);
    for (const u of data.users || []) {
      this.users.set(u.name, { ...u, blocked: new Set(u.blocked || []), invites: new Map(u.invites || []), notices: u.notices || [] });
    }
    for (const r of data.rooms || []) {
      this.rooms.set(r.name, { ...r, members: new Set(r.members || []), invited: new Set(r.invited || []), banned: new Set(r.banned || []) });
    }
    for (const [k, v] of data.bodies || []) this.bodies.set(k, v);
    for (const [k, v] of data.queues || []) this.queues.set(k, v);
    for (const [k, v] of data.aliases || []) this.aliases.set(k, v);
  }

  _snapshot() {
    return JSON.stringify({
      v: 1,
      users: [...this.users.values()].map((u) => ({ ...u, blocked: [...u.blocked], invites: [...u.invites] })),
      rooms: [...this.rooms.values()].map((r) => ({ ...r, members: [...r.members], invited: [...r.invited], banned: [...r.banned] })),
      bodies: [...this.bodies],
      aliases: [...this.aliases],
      queues: [...this.queues].filter(([, q]) => q.length),
    });
  }

  touch() {
    if (!this.file) return;
    this._dirty = true;
    if (!this._timer) {
      this._timer = setTimeout(() => { this._timer = null; this._flush(); }, 1500);
      if (this._timer.unref) this._timer.unref();
    }
  }

  _flush() {
    if (!this.file || !this._dirty) return;
    if (this._writing) return this.touch();
    this._dirty = false;
    this._writing = true;
    const tmp = this.file + '.tmp';
    fs.writeFile(tmp, this._snapshot(), { mode: 0o600 }, (err) => {
      const finish = (e) => {
        this._writing = false;
        if (e) {
          this._dirty = true;
          console.error('[gossip] could not save data:', e.message);
        }
        if (this._dirty) this.touch();
      };
      if (err) return finish(err);
      fs.rename(tmp, this.file, finish);
    });
  }

  flushSync() {
    if (!this.file) return;
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, this._snapshot(), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }
}

// ── relay ───────────────────────────────────────────────────────────────────

class Relay {
  constructor(opts = {}) {
    this.opts = {
      port: 8787,
      host: '0.0.0.0',
      dataDir: null, // null = keep everything in memory (tests)
      name: 'gossip relay',
      motd: '',
      trustProxy: false,
      quiet: false,
      signups: true, // false = existing accounts only
      maxMembers: P.LIMITS.roomMembers, // people per server (group)
      maxConnsPerIp: 30,
      maxSignupsPerIpPerHour: 10,
      idleMs: 90 * 1000,
      ...opts,
    };
    this.db = new Db(this.opts.dataDir);
    this.sessions = new Set();
    // name -> Set of signed-in sessions. One person can be signed in from several
    // terminals at once (a `gossip listen` here, a `gossip squawk` there).
    this.online = new Map();
    this.ipConns = new Map();
    this.ipSignups = new Map();
    this.server = null;
  }

  log(...args) {
    if (!this.opts.quiet) console.log(new Date().toISOString(), ...args);
  }

  start() {
    this.server = http.createServer((req, res) => this._http(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      const conn = ws.accept(req, socket, head, { maxPayload: P.LIMITS.frame });
      if (conn) this._connection(conn, req);
    });
    this._sweeper = setInterval(() => this._sweep(), 30 * 1000);
    this._expirer = setInterval(() => this._expire(), 10 * 60 * 1000);
    this._sweeper.unref();
    this._expirer.unref();
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.port = this.server.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    clearInterval(this._sweeper);
    clearInterval(this._expirer);
    for (const s of this.sessions) s.conn.terminate();
    this.db.flushSync();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      if (this.server.closeAllConnections) this.server.closeAllConnections();
    });
  }

  _http(req, res) {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      let live = 0;
      for (const name of this.online.keys()) if (this._isLive(name)) live++;
      res.end(`gossip relay v${VERSION} (${this.opts.name}) - ${live} online\n`);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
    }
  }

  _ip(req) {
    if (this.opts.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  _connection(conn, req) {
    const ip = this._ip(req);
    const count = (this.ipConns.get(ip) || 0) + 1;
    if (count > this.opts.maxConnsPerIp) {
      conn.close(1013, 'too many connections');
      return;
    }
    this.ipConns.set(ip, count);

    const now = Date.now();
    const s = {
      conn, ip,
      name: null,
      mode: 'live',
      nonce: e2e.b64(crypto.randomBytes(24)),
      watch: new Set(),
      tokens: 40,
      refilled: now,
      alive: now,
      tries: 0,
      lastTyping: 0,
    };
    this.sessions.add(s);
    conn.on('message', (text) => this._message(s, text));
    conn.on('close', () => this._closed(s));
    this._push(s, { t: 'hello', v: P.PROTOCOL, nonce: s.nonce, server: this.opts.name, motd: this.opts.motd, version: VERSION });
  }

  _closed(s) {
    if (!this.sessions.delete(s)) return;
    const left = (this.ipConns.get(s.ip) || 1) - 1;
    if (left > 0) this.ipConns.set(s.ip, left); else this.ipConns.delete(s.ip);
    if (!s.name) return;
    const set = this.online.get(s.name);
    if (!set || !set.delete(s)) return;
    if (set.size === 0) this.online.delete(s.name);
    const user = this.db.users.get(s.name);
    if (user) user.seen = Date.now();
    // Their last live session just ended: they now look offline to mutual contacts.
    if (s.mode === 'live' && !this._isLive(s.name)) {
      for (const n of s.watch) {
        if (this._watches(n, s.name)) this._pushLive(n, { t: 'presence', name: s.name, online: false });
      }
    }
  }

  // Sessions come in three kinds (chosen at sign-in):
  //   live  the chat prompt or `gossip listen`: gets everything, shows as online
  //   peek  `gossip check`: gets waiting messages, never shows as online
  //   post  `gossip squawk` and other one-off commands: sends only
  _sessions(name) {
    return this.online.get(name) || [];
  }

  _isLive(name) {
    for (const s of this._sessions(name)) if (s.mode === 'live') return true;
    return false;
  }

  /** Does `name` (while live) have `target` in their contacts? */
  _watches(name, target) {
    for (const s of this._sessions(name)) if (s.mode === 'live' && s.watch.has(target)) return true;
    return false;
  }

  /** Send to every session of `name` that receives pushes (not one-off senders). */
  _pushTo(name, obj, except) {
    for (const s of this._sessions(name)) if (s.mode !== 'post' && s !== except) this._push(s, obj);
  }

  _pushLive(name, obj) {
    for (const s of this._sessions(name)) if (s.mode === 'live') this._push(s, obj);
  }

  _push(s, obj) {
    if (s.conn.closed) return;
    // A client that stopped reading shouldn't be able to fill the server's memory.
    if (s.conn.buffered > 8 * 1024 * 1024) return s.conn.terminate();
    s.conn.send(JSON.stringify(obj));
  }

  _ok(s, m, extra) {
    if (m.rid !== undefined) this._push(s, { t: 'ok', rid: m.rid, ...extra });
  }

  _err(s, m, code, msg) {
    this._push(s, { t: 'err', rid: m.rid, code, msg: msg || code });
  }

  _message(s, text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    if (m.rid !== undefined && !(Number.isSafeInteger(m.rid) || (typeof m.rid === 'string' && m.rid.length <= 32))) return;

    const now = Date.now();
    s.alive = now;
    const handler = HANDLERS[m.t];
    if (!handler) return this._err(s, m, 'unknown', 'Unknown request');
    if (!handler.free) {
      s.tokens = Math.min(40, s.tokens + (now - s.refilled) / 250);
      s.refilled = now;
      if (s.tokens < 1) return this._err(s, m, 'slow_down', "You're sending too fast - give it a second");
      s.tokens -= 1;
    }
    if (!s.name && !handler.open) return this._err(s, m, 'unauthenticated', 'Sign in first');
    try {
      handler.run.call(this, s, m, now);
    } catch (e) {
      console.error('[gossip] handler error in', m.t, e);
      this._err(s, m, 'server_error', 'The server hit a problem with that request');
    }
  }

  _sweep() {
    const now = Date.now();
    for (const s of this.sessions) {
      const limit = s.name ? this.opts.idleMs : 20 * 1000;
      if (now - s.alive > limit) s.conn.close(1001, 'idle');
    }
    for (const [ip, times] of this.ipSignups) {
      const fresh = times.filter((t) => now - t < 60 * 60 * 1000);
      if (fresh.length) this.ipSignups.set(ip, fresh); else this.ipSignups.delete(ip);
    }
  }

  _expire() {
    const cutoff = Date.now() - P.LIMITS.queueDays * DAY;
    let changed = false;
    for (const [name, q] of this.db.queues) {
      const keep = [];
      for (const item of q) {
        const body = this.db.bodies.get(item.b);
        if (body && body.ts >= cutoff) keep.push(item);
        else { this._unref(item.b); changed = true; }
      }
      if (keep.length) this.db.queues.set(name, keep); else this.db.queues.delete(name);
    }
    if (changed) this.db.touch();
  }

  _allowSignup(ip) {
    const now = Date.now();
    const times = (this.ipSignups.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (times.length >= this.opts.maxSignupsPerIpPerHour) return false;
    times.push(now);
    this.ipSignups.set(ip, times);
    return true;
  }

  _pub(u) {
    return { name: u.name, signPub: u.signPub, dhPub: u.dhPub, dhSig: u.dhSig };
  }

  _roomInfo(r) {
    return { name: r.name, private: !!r.private, owner: r.owner, members: r.members.size };
  }

  _roomCast(room, msg, except) {
    for (const n of room.members) if (n !== except) this._pushTo(n, msg);
  }

  _unref(bodyKey) {
    const body = this.db.bodies.get(bodyKey);
    if (body && --body.refs <= 0) this.db.bodies.delete(bodyKey);
  }

  _enqueue(name, item) {
    let q = this.db.queues.get(name);
    if (!q) this.db.queues.set(name, (q = []));
    q.push(item);
    const body = this.db.bodies.get(item.b);
    body.refs++;
    while (q.length > P.LIMITS.queue) this._unref(q.shift().b);
    for (const s of this._sessions(name)) if (s.mode !== 'post') this._deliver(s, item);
  }

  _deliver(s, item) {
    const body = this.db.bodies.get(item.b);
    if (!body) return;
    this._push(s, { t: 'msg', mid: item.b, ts: body.ts, env: { ...body.env, keys: { [s.name]: item.k } } });
  }
}

// ── request handlers ────────────────────────────────────────────────────────
// open: allowed before signing in.  free: not counted against the rate limit.

const HANDLERS = {
  auth: {
    open: true,
    run(s, m, now) {
      if (s.name) return this._err(s, m, 'already', 'Already signed in');
      if (++s.tries > 8) return s.conn.close(1008, 'too many attempts');
      const name = m.name;
      if (!P.validName(name)) return this._err(s, m, 'bad_name', P.NAME_HELP);
      const bundle = { signPub: m.signPub, dhPub: m.dhPub, dhSig: m.dhSig };
      if (!e2e.validBundle(bundle)) return this._err(s, m, 'bad_keys', 'Invalid keys');
      if (typeof m.sig !== 'string' || !e2e.checkAuthProof(bundle.signPub, s.nonce, name, m.sig)) {
        return this._err(s, m, 'bad_proof', 'Sign-in proof was not valid');
      }

      let user = this.db.users.get(name);
      let created = false;
      if (user) {
        if (user.signPub !== bundle.signPub) {
          return this._err(s, m, 'name_taken', `The username "${name}" is already taken`);
        }
        if (user.dhPub !== bundle.dhPub) {
          user.dhPub = bundle.dhPub;
          user.dhSig = bundle.dhSig;
        }
      } else {
        const moved = this.db.aliases.get(name); // a name someone used to have stays theirs
        if (moved) {
          const owner = this.db.users.get(moved);
          if (owner && owner.signPub === bundle.signPub) return this._err(s, m, 'renamed', `This account is now called "${moved}"`);
          return this._err(s, m, 'name_taken', `The username "${name}" is already taken`);
        }
        if (!m.create) return this._err(s, m, 'unknown_user', `There's no account called "${name}" on this relay`);
        if (!this.opts.signups) return this._err(s, m, 'signups_closed', "This relay isn't taking new accounts");
        if (!this._allowSignup(s.ip)) {
          return this._err(s, m, 'signup_limit', 'Too many new accounts from this network - try again in an hour');
        }
        user = { name, ...bundle, created: now, seen: now, blocked: new Set(), invites: new Map(), notices: [] };
        this.db.users.set(name, user);
        created = true;
        this.log(`new account: ${name}`);
      }
      user.seen = now;
      this.db.touch();

      s.name = name;
      s.mode = ['live', 'peek', 'post'].includes(m.mode) ? m.mode : 'live';
      let set = this.online.get(name);
      if (!set) this.online.set(name, (set = new Set()));
      set.add(s);
      if (set.size > 8) set.values().next().value.conn.close(4002, 'too many sessions');
      // Tell your open chats when the account is opened somewhere else as well.
      const others = [...set].filter((x) => x !== s && x.mode === 'live').length;
      if (s.mode === 'live' && others) {
        for (const x of set) if (x !== s && x.mode !== 'post') this._push(x, { t: 'session', event: 'new', n: others + 1 });
      }

      const rooms = [];
      for (const r of this.db.rooms.values()) if (r.members.has(name)) rooms.push(this._roomInfo(r));
      const waiting = this.db.queues.get(name) || [];
      this._ok(s, m, {
        name, created, rooms,
        invites: [...user.invites].map(([room, by]) => ({ room, by })),
        blocked: [...user.blocked],
        waiting: waiting.length,
        others,
        // things that happened while you were away (e.g. removed from a server)
        notices: s.mode === 'post' ? [] : user.notices.splice(0),
      });
      if (s.mode !== 'post') {
        for (const item of waiting.slice()) this._deliver(s, item);
        // lets `gossip check` know it has seen everything that was waiting
        this._push(s, { t: 'caught_up', n: waiting.length });
      }
    },
  },

  ping: { open: true, free: true, run(s, m) { this._ok(s, m, {}); } },

  lookup: {
    run(s, m) {
      // (someone who changed their username is still found under the old one)
      const u = P.validName(m.name) ? this.db.users.get(m.name) || this.db.users.get(this.db.aliases.get(m.name)) : null;
      if (!u) return this._err(s, m, 'no_such_user', `There's no user called "${String(m.name).slice(0, 24)}"`);
      this._ok(s, m, { user: this._pub(u) });
    },
  },

  send: {
    run(s, m, now) {
      const env = m.env;
      if (!P.validEnvelope(env) || env.from !== s.name) return this._err(s, m, 'bad_message', 'Malformed message');
      const c = P.parseConv(env.conv);
      const bodyKey = `${s.name}/${env.id}`;
      const dup = this.db.bodies.get(bodyKey);
      if (dup) return this._ok(s, m, { id: env.id, ts: dup.ts });

      let targets = [];
      if (c.kind === 'dm') {
        const other = c.a === s.name ? c.b : c.b === s.name ? c.a : null;
        if (!other) return this._err(s, m, 'bad_message', 'Malformed message');
        const u = this.db.users.get(other);
        if (!u) return this._err(s, m, 'no_such_user', `There's no user called "${other}"`);
        if (typeof env.keys[other] !== 'string') return this._err(s, m, 'bad_message', 'Malformed message');
        // A blocked sender gets a normal "sent" - the message just never arrives.
        if (!u.blocked.has(s.name)) targets = [other];
      } else {
        const room = this.db.rooms.get(c.room);
        if (!room || !room.members.has(s.name)) return this._err(s, m, 'not_member', `You're not in #${c.room}`);
        for (const n of room.members) if (n !== s.name && typeof env.keys[n] === 'string') targets.push(n);
      }

      if (targets.length) {
        const { keys, ...bare } = env;
        this.db.bodies.set(bodyKey, { env: bare, ts: now, refs: 0, dm: c.kind === 'dm' });
        for (const t of targets) this._enqueue(t, { b: bodyKey, k: keys[t] });
        this.db.touch();
      }
      s.lastTyping = 0;
      this._ok(s, m, { id: env.id, ts: now });
    },
  },

  // The recipient confirms it has stored these messages; only then are they deleted here.
  got: {
    free: true,
    run(s, m, now) {
      if (!Array.isArray(m.mids)) return;
      const q = this.db.queues.get(s.name);
      if (!q) return;
      const confirmed = new Set(m.mids.slice(0, 1000).filter((x) => typeof x === 'string'));
      const keep = [];
      for (const item of q) {
        if (!confirmed.has(item.b)) { keep.push(item); continue; }
        const body = this.db.bodies.get(item.b);
        if (body && body.dm) this._pushTo(body.env.from, { t: 'receipt', id: body.env.id, by: s.name, ts: now });
        this._unref(item.b);
      }
      if (keep.length) this.db.queues.set(s.name, keep); else this.db.queues.delete(s.name);
      this.db.touch();
    },
  },

  create: {
    run(s, m, now) {
      const name = m.room;
      if (!P.validRoom(name)) return this._err(s, m, 'bad_room', P.ROOM_HELP);
      if (this.db.rooms.has(name)) return this._err(s, m, 'room_exists', `#${name} already exists - try joining it`);
      const room = { name, private: !!m.private, owner: s.name, created: now, members: new Set([s.name]), invited: new Set(), banned: new Set() };
      this.db.rooms.set(name, room);
      this.db.touch();
      this._pushTo(s.name, { t: 'room', room: name, event: 'self_join' }, s);
      this._ok(s, m, { room: this._roomInfo(room), members: HANDLERS.members.list.call(this, room) });
    },
  },

  join: {
    run(s, m) {
      const name = m.room;
      if (!P.validRoom(name)) return this._err(s, m, 'bad_room', P.ROOM_HELP);
      const room = this.db.rooms.get(name);
      if (!room) return this._err(s, m, 'no_such_room', `There's no server called #${name}`);
      const user = this.db.users.get(s.name);
      if (!room.members.has(s.name)) {
        if (room.banned.has(s.name)) {
          return this._err(s, m, 'removed', `You were removed from #${name} by its owner - only they can invite you back`);
        }
        if (room.private && !room.invited.has(s.name)) {
          return this._err(s, m, 'invite_only', `#${name} is invite-only - ask a member to invite you`);
        }
        if (room.members.size >= Math.min(this.opts.maxMembers, P.LIMITS.roomMembers)) return this._err(s, m, 'room_full', `#${name} is full`);
        room.members.add(s.name);
        room.invited.delete(s.name);
        user.invites.delete(name);
        this._roomCast(room, { t: 'room', room: name, event: 'join', user: this._pub(user) }, s.name);
        this._pushTo(s.name, { t: 'room', room: name, event: 'self_join' }, s); // your other terminals
        this.db.touch();
      }
      this._ok(s, m, { room: this._roomInfo(room), members: HANDLERS.members.list.call(this, room) });
    },
  },

  leave: {
    run(s, m) {
      const room = this.db.rooms.get(m.room);
      if (!room || !room.members.has(s.name)) return this._ok(s, m, {});
      room.members.delete(s.name);
      if (room.members.size === 0) {
        this.db.rooms.delete(room.name);
      } else {
        if (room.owner === s.name) room.owner = room.members.values().next().value; // the longest-standing member takes over
        this._roomCast(room, { t: 'room', room: room.name, event: 'leave', name: s.name, owner: room.owner }, s.name);
      }
      this._pushTo(s.name, { t: 'room', room: room.name, event: 'self_leave' }, s);
      this.db.touch();
      this._ok(s, m, {});
    },
  },

  invite: {
    run(s, m) {
      const room = this.db.rooms.get(m.room);
      if (!room || !room.members.has(s.name)) return this._err(s, m, 'not_member', "You're not in that server");
      const target = P.validName(m.name) ? this.db.users.get(m.name) : null;
      if (!target) return this._err(s, m, 'no_such_user', `There's no user called "${String(m.name).slice(0, 24)}"`);
      if (room.members.has(target.name)) return this._err(s, m, 'already_member', `${target.name} is already in #${room.name}`);
      if (room.banned.has(target.name)) {
        if (room.owner !== s.name) return this._err(s, m, 'removed', `${target.name} was removed by the owner - only ${room.owner} can invite them back`);
        room.banned.delete(target.name);
      }
      if (target.blocked.has(s.name)) return this._ok(s, m, {});
      room.invited.add(target.name);
      target.invites.set(room.name, s.name);
      this.db.touch();
      this._pushTo(target.name, { t: 'room', room: room.name, event: 'invite', by: s.name });
      this._ok(s, m, {});
    },
  },

  // Only the owner can remove someone. They can't rejoin unless the owner invites them
  // back, and (because each message is encrypted per member) nothing sent after
  // this moment can be read by them.
  kick: {
    run(s, m) {
      const room = this.db.rooms.get(m.room);
      if (!room || !room.members.has(s.name)) return this._err(s, m, 'not_member', "You're not in that server");
      if (room.owner !== s.name) return this._err(s, m, 'not_owner', `Only the owner of #${room.name} (${room.owner}) can remove people`);
      if (!P.validName(m.name)) return this._err(s, m, 'bad_name', 'Who do you want to remove?');
      if (m.name === s.name) return this._err(s, m, 'bad_name', "You can't remove yourself - leave instead");
      if (!room.members.has(m.name)) {
        // Not in the server (maybe only invited, maybe never here): keep them out.
        const outsider = this.db.users.get(m.name);
        if (!outsider) return this._err(s, m, 'not_there', `There's no user called "${m.name}"`);
        room.invited.delete(m.name);
        outsider.invites.delete(room.name);
        room.banned.add(m.name);
        this.db.touch();
        return this._ok(s, m, { blocked: true });
      }
      room.members.delete(m.name);
      room.invited.delete(m.name);
      room.banned.add(m.name);
      const target = this.db.users.get(m.name);
      if (target) target.invites.delete(room.name);
      this.db.touch();
      const told = [...this._sessions(m.name)].some((x) => x.mode !== 'post');
      if (told) this._pushTo(m.name, { t: 'room', room: room.name, event: 'kicked', by: s.name });
      else if (target && target.notices.length < 20) target.notices.push({ kind: 'kicked', room: room.name, by: s.name });
      const note = { t: 'room', room: room.name, event: 'kick', name: m.name, by: s.name };
      this._roomCast(room, note, s.name);
      this._pushTo(s.name, note, s);
      this._ok(s, m, {});
    },
  },

  // Change your username. Everything you're part of moves with you, and the old
  // name stays yours so nobody can pick it up and pose as you.
  rename: {
    run(s, m) {
      const old = s.name;
      const name = m.name;
      if (!P.validName(name)) return this._err(s, m, 'bad_name', P.NAME_HELP);
      if (name === old) return this._err(s, m, 'bad_name', 'That is already your username');
      const holder = this.db.aliases.get(name);
      if (this.db.users.has(name) || (holder && holder !== old)) return this._err(s, m, 'name_taken', `The username "${name}" is already taken`);
      if ((this.db.queues.get(old) || []).length) return this._err(s, m, 'busy', 'Messages are still on their way to you - try again in a moment');
      const user = this.db.users.get(old);
      this.db.users.delete(old);
      user.name = name;
      this.db.users.set(name, user);
      const swap = (set) => {
        if (!set.has(old)) return;
        const list = [...set].map((n) => (n === old ? name : n)); // (keeps the order people joined in)
        set.clear();
        for (const n of list) set.add(n);
      };
      const audience = new Set();
      for (const r of this.db.rooms.values()) {
        if (r.members.has(old)) for (const n of r.members) audience.add(n);
        swap(r.members);
        swap(r.invited);
        swap(r.banned);
        if (r.owner === old) r.owner = name;
      }
      for (const u of this.db.users.values()) {
        swap(u.blocked);
        for (const [room, by] of u.invites) if (by === old) u.invites.set(room, name);
      }
      for (const [a, b] of this.db.aliases) if (b === old) this.db.aliases.set(a, name);
      this.db.aliases.delete(name);
      this.db.aliases.set(old, name);
      this.db.queues.delete(old);
      const mine = this.online.get(old);
      this.online.delete(old);
      if (mine) {
        this.online.set(name, mine);
        for (const x of mine) x.name = name;
      }
      for (const set of this.online.values()) {
        for (const x of set) {
          if (x.watch && x.watch.has(old)) { x.watch.delete(old); x.watch.add(name); audience.add(x.name); }
        }
      }
      this.db.touch();
      const note = { t: 'renamed', from: old, to: name, user: this._pub(user) };
      audience.delete(old);
      audience.delete(name);
      for (const n of audience) this._pushTo(n, note);
      this._pushTo(name, note, s); // your other terminals
      this.log(`${old} is now ${name}`);
      this._ok(s, m, { name });
    },
  },

  // Close every other place this account is open.
  signout: {
    run(s, m) {
      let closed = 0;
      for (const x of [...this._sessions(s.name)]) {
        if (x === s) continue;
        this._push(x, { t: 'signed_out' });
        x.conn.close(4003, 'signed out');
        closed++;
      }
      this._ok(s, m, { closed });
    },
  },

  // The owner hands the server to another member.
  owner: {
    run(s, m) {
      const room = this.db.rooms.get(m.room);
      if (!room || !room.members.has(s.name)) return this._err(s, m, 'not_member', "You're not in that server");
      if (room.owner !== s.name) return this._err(s, m, 'not_owner', `Only the owner of #${room.name} (${room.owner}) can hand it over`);
      if (m.name === s.name) return this._err(s, m, 'bad_name', 'You already own it');
      if (!P.validName(m.name) || !room.members.has(m.name)) return this._err(s, m, 'not_there', `${String(m.name).slice(0, 24)} isn't in #${room.name}`);
      room.owner = m.name;
      this.db.touch();
      const note = { t: 'room', room: room.name, event: 'owner', name: m.name, by: s.name };
      this._roomCast(room, note, s.name);
      this._pushTo(s.name, note, s);
      this._ok(s, m, {});
    },
  },

  rooms: {
    run(s, m) {
      const list = [];
      for (const r of this.db.rooms.values()) {
        if (!r.private) list.push({ name: r.name, members: r.members.size, joined: r.members.has(s.name) });
      }
      list.sort((a, b) => b.members - a.members || (a.name < b.name ? -1 : 1));
      this._ok(s, m, { rooms: list.slice(0, 200) });
    },
  },

  members: {
    list(room) {
      const out = [];
      for (const n of room.members) {
        const u = this.db.users.get(n);
        if (u) out.push({ ...this._pub(u), online: this._isLive(n) });
      }
      return out;
    },
    run(s, m) {
      const room = this.db.rooms.get(m.room);
      if (!room || !room.members.has(s.name)) return this._err(s, m, 'not_member', "You're not in that server");
      this._ok(s, m, { room: this._roomInfo(room), members: HANDLERS.members.list.call(this, room) });
    },
  },

  // Presence is mutual: you only appear online to people who are in your contacts
  // AND have you in theirs. Anyone can ask; only live sessions are ever shown.
  watch: {
    run(s, m) {
      const names = Array.isArray(m.names) ? m.names.filter(P.validName).slice(0, P.LIMITS.watch) : [];
      const online = names.filter((n) => this._watches(n, s.name));
      if (s.mode === 'live') {
        const before = s.watch;
        s.watch = new Set(names);
        for (const n of s.watch) {
          if (!before.has(n) && this._watches(n, s.name)) this._pushLive(n, { t: 'presence', name: s.name, online: true });
        }
        for (const n of before) {
          if (!s.watch.has(n) && !this._watches(s.name, n) && this._watches(n, s.name)) {
            this._pushLive(n, { t: 'presence', name: s.name, online: false });
          }
        }
      }
      this._ok(s, m, { online });
    },
  },

  typing: {
    free: true,
    run(s, m, now) {
      if (now - s.lastTyping < 1500) return;
      s.lastTyping = now;
      const c = P.parseConv(m.conv);
      if (!c) return;
      const note = { t: 'typing', from: s.name, conv: m.conv };
      if (c.kind === 'dm') {
        const other = c.a === s.name ? c.b : c.b === s.name ? c.a : null;
        const u = other && this.db.users.get(other);
        if (u && !u.blocked.has(s.name)) this._pushLive(other, note);
      } else {
        const room = this.db.rooms.get(c.room);
        if (room && room.members.has(s.name) && room.members.size <= 30) {
          for (const n of room.members) if (n !== s.name) this._pushLive(n, note);
        }
      }
    },
  },

  block: {
    run(s, m) {
      if (!P.validName(m.name) || m.name === s.name) return this._err(s, m, 'bad_name', 'Who do you want to block?');
      const user = this.db.users.get(s.name);
      if (user.blocked.size >= 1000) return this._err(s, m, 'limit', 'Your block list is full');
      user.blocked.add(m.name);
      this.db.touch();
      this._ok(s, m, { blocked: [...user.blocked] });
    },
  },

  unblock: {
    run(s, m) {
      const user = this.db.users.get(s.name);
      user.blocked.delete(m.name);
      this.db.touch();
      this._ok(s, m, { blocked: [...user.blocked] });
    },
  },
};

// ── command line: `gossip serve` ────────────────────────────────────────────

function parseServeArgs(argv) {
  const env = process.env;
  const opts = {
    port: Number(env.PORT || env.GOSSIP_PORT || 8787),
    host: env.GOSSIP_HOST || '0.0.0.0',
    dataDir: env.GOSSIP_DATA || path.join(require('os').homedir(), '.gossip-server'),
    name: env.GOSSIP_NAME || 'gossip relay',
    motd: env.GOSSIP_MOTD || '',
    trustProxy: env.GOSSIP_TRUST_PROXY === '1',
  };
  if (/^(off|0|no|false)$/i.test(env.GOSSIP_SIGNUPS || '')) opts.signups = false;
  if (env.GOSSIP_MAX_MEMBERS) opts.maxMembers = Number(env.GOSSIP_MAX_MEMBERS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--port' || a === '-p') opts.port = Number(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--data') opts.dataDir = path.resolve(next());
    else if (a === '--name') opts.name = next();
    else if (a === '--motd') opts.motd = next();
    else if (a === '--trust-proxy') opts.trustProxy = true;
    else if (a === '--no-signups') opts.signups = false;
    else if (a === '--max-members') opts.maxMembers = Number(next());
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be a number between 0 and 65535');
  if (opts.maxMembers !== undefined && (!Number.isInteger(opts.maxMembers) || opts.maxMembers < 2 || opts.maxMembers > P.LIMITS.roomMembers)) {
    throw new Error(`--max-members must be a number from 2 to ${P.LIMITS.roomMembers}`);
  }
  return opts;
}

const SERVE_HELP = `Run a gossip relay server.

  gossip serve [options]

Options
  --port, -p <n>     Port to listen on             (default 8787, or $PORT)
  --host <addr>      Address to bind               (default 0.0.0.0)
  --data <dir>       Where to keep the database    (default ~/.gossip-server)
  --name <text>      Name shown to people who connect
  --motd <text>      Short welcome line shown on connect
  --no-signups       Existing accounts only - nobody new can register
  --max-members <n>  Most people allowed in one server/group (default 256)
  --trust-proxy      Read the visitor's address from X-Forwarded-For
                     (turn on only behind Caddy/nginx/Cloudflare)

The same settings as environment variables: PORT, GOSSIP_HOST, GOSSIP_DATA,
GOSSIP_NAME, GOSSIP_MOTD, GOSSIP_SIGNUPS=off, GOSSIP_MAX_MEMBERS, GOSSIP_TRUST_PROXY=1
`;

async function serve(argv) {
  let opts;
  try {
    opts = parseServeArgs(argv);
  } catch (e) {
    console.error(e.message + '\n\n' + SERVE_HELP);
    process.exit(2);
  }
  if (opts.help) {
    console.log(SERVE_HELP);
    return;
  }
  const relay = new Relay(opts);
  try {
    await relay.start();
  } catch (e) {
    console.error(e.code === 'EADDRINUSE'
      ? `Port ${opts.port} is already in use. Pick another with --port.`
      : `Could not start the relay: ${e.message}`);
    process.exit(1);
  }
  console.log(`gossip relay v${VERSION} is running`);
  console.log(`  listening on   ${opts.host}:${relay.port}`);
  console.log(`  data folder    ${opts.dataDir}`);
  console.log(`  accounts       ${relay.db.users.size}`);
  console.log(`  new accounts   ${opts.signups === false ? 'closed' : 'open'}`);
  console.log(`  connect with   gossip relay ws://<this-machine's-address>:${relay.port}`);
  console.log('Press Ctrl+C to stop.');
  const shutdown = () => {
    console.log('\nSaving and shutting down...');
    relay.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { Relay, Db, serve, SERVE_HELP };

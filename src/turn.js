'use strict';
// gossip's own call relay - a TURN server (RFC 5766), with nothing to sign up for.
//
// Calls normally go straight from one computer to the other. Some networks
// (schools, offices, some phone hotspots) block that. A TURN server sits on the
// open internet and passes the call along for them. The call stays end-to-end
// encrypted the whole way: this server only ever sees scrambled packets.
//
//   gossip turn            run it (on an always-on machine with a public address)
//
// Logins: your gossip website (or relay) is given a secret, and hands each
// person a password that only works for a day ("TURN REST API" credentials).
// Nobody types a password, and an old one is useless.

const dgram = require('dgram');
const net = require('net');
const dns = require('dns');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = 0x2112a442;
const REALM = 'gossip';
const SOFTWARE = 'gossip turn';
const METHOD = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, PERMISSION: 0x008, CHANNEL: 0x009 };
const CLS = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 };
const ATTR = {
  MAPPED: 0x0001, USERNAME: 0x0006, INTEGRITY: 0x0008, ERROR: 0x0009, UNKNOWN: 0x000a, CHANNEL: 0x000c, LIFETIME: 0x000d,
  PEER: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, RELAYED: 0x0016, FAMILY: 0x0017, EVEN_PORT: 0x0018,
  TRANSPORT: 0x0019, DONT_FRAGMENT: 0x001a, XOR_MAPPED: 0x0020, TOKEN: 0x0022, SOFTWARE: 0x8022, FINGERPRINT: 0x8028,
};
const KNOWN = new Set(Object.values(ATTR));
const LIFETIME = { default: 600, max: 3600, permission: 300, channel: 600 };

// ── the message format (STUN) ───────────────────────────────────────────────

const pad4 = (n) => (n + 3) & ~3;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function typeOf(method, cls) {
  return (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
}

/** Read one STUN message, or null if it isn't one. */
function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0 || buf.readUInt32BE(4) !== MAGIC) return null;
  const len = buf.readUInt16BE(2);
  if (len % 4 || 20 + len > buf.length) return null;
  const t = buf.readUInt16BE(0);
  const msg = {
    method: (t & 0x000f) | ((t & 0x00e0) >> 1) | ((t & 0x3e00) >> 2),
    cls: ((t & 0x0010) >> 4) | ((t & 0x0100) >> 7),
    tid: Buffer.from(buf.subarray(8, 20)),
    attrs: [],
    raw: buf.subarray(0, 20 + len),
    integrityAt: -1,
  };
  let off = 20;
  while (off + 4 <= 20 + len) {
    const type = buf.readUInt16BE(off);
    const alen = buf.readUInt16BE(off + 2);
    if (off + 4 + alen > 20 + len) return null;
    if (type === ATTR.INTEGRITY) msg.integrityAt = off;
    if (msg.integrityAt < 0 || type === ATTR.INTEGRITY || type === ATTR.FINGERPRINT) msg.attrs.push({ type, value: buf.subarray(off + 4, off + 4 + alen) });
    off += 4 + pad4(alen);
  }
  msg.get = (type) => {
    const a = msg.attrs.find((x) => x.type === type);
    return a ? a.value : null;
  };
  msg.all = (type) => msg.attrs.filter((x) => x.type === type).map((x) => x.value);
  return msg;
}

function attr(type, value) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(pad4(value.length) - value.length)]);
}

/** Write a STUN message, signed with `key` if given, always with a FINGERPRINT. */
function build(method, cls, tid, attrs, key = null) {
  let body = Buffer.concat(attrs.map(([t, v]) => attr(t, v)));
  const head = Buffer.alloc(20);
  head.writeUInt16BE(typeOf(method, cls), 0);
  head.writeUInt32BE(MAGIC, 4);
  tid.copy(head, 8);
  if (key) {
    head.writeUInt16BE(body.length + 24, 2);
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([head, body])).digest();
    body = Buffer.concat([body, attr(ATTR.INTEGRITY, mac)]);
  }
  head.writeUInt16BE(body.length + 8, 2);
  const fp = Buffer.alloc(4);
  fp.writeUInt32BE((crc32(Buffer.concat([head, body])) ^ 0x5354554e) >>> 0);
  body = Buffer.concat([body, attr(ATTR.FINGERPRINT, fp)]);
  head.writeUInt16BE(body.length, 2);
  return Buffer.concat([head, body]);
}

/** Does a request's MESSAGE-INTEGRITY match `key`? */
function signedWith(msg, key) {
  if (msg.integrityAt < 0) return false;
  const given = msg.get(ATTR.INTEGRITY);
  const part = Buffer.from(msg.raw.subarray(0, msg.integrityAt));
  part.writeUInt16BE(msg.integrityAt - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(part).digest();
  return given && given.length === 20 && crypto.timingSafeEqual(mac, given);
}

function xorAddress(addr, port) {
  const v = Buffer.alloc(8);
  v[1] = 0x01;
  v.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const parts = addr.split('.').map(Number);
  for (let i = 0; i < 4; i++) v[4 + i] = parts[i] ^ ((MAGIC >>> (24 - 8 * i)) & 0xff);
  return v;
}

function readXorAddress(v) {
  if (!v || v.length < 8 || v[1] !== 0x01) return null;
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const addr = [0, 1, 2, 3].map((i) => v[4 + i] ^ ((MAGIC >>> (24 - 8 * i)) & 0xff)).join('.');
  return { addr, port };
}

function errorValue(code, reason) {
  const r = Buffer.from(reason, 'utf8');
  const v = Buffer.alloc(4 + r.length);
  v[2] = Math.floor(code / 100);
  v[3] = code % 100;
  r.copy(v, 4);
  return v;
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/** Day-long login details for someone, from the shared secret (what a gossip website hands out). */
function credentials(secret, name, seconds = 24 * 3600) {
  const username = `${Math.floor(Date.now() / 1000) + seconds}:${String(name).replace(/:/g, '')}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/** The ICE servers list a browser needs, for a server at "host:port". */
function iceFor(server, secret, name) {
  const { username, credential } = credentials(secret, name);
  return [
    { urls: `stun:${server}` },
    { urls: [`turn:${server}?transport=udp`, `turn:${server}?transport=tcp`], username, credential },
  ];
}

// Addresses a relay must never be pointed at: this machine's own network,
// cloud metadata services, and so on.
function isPrivate(addr) {
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && p[2] === 0) || (a === 198 && (b === 18 || b === 19));
}

// ── the server ──────────────────────────────────────────────────────────────

class TurnServer {
  constructor({ port = 3478, host = '0.0.0.0', externalIp = '', minPort = 49152, maxPort = 65535, secret = '', users = {}, allowPrivate = false, maxAllocations = 400, quiet = false } = {}) {
    this.opts = { port, host, minPort, maxPort, allowPrivate, maxAllocations, quiet };
    this.externalIp = externalIp;
    this.secret = secret;
    this.users = users; // fixed logins, name -> password (optional)
    this.allocs = new Map(); // client key -> allocation
    this.byRelayPort = new Map();
    this.pending = new Set();
    this.nonceKey = crypto.randomBytes(16);
    this.udp = null;
    this.tcp = null;
    this.timer = null;
    this.stats = { allocations: 0, bytes: 0 };
  }

  log(...a) {
    if (!this.opts.quiet) console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
  }

  async start() {
    if (!this.externalIp) this.externalIp = await publicAddress().catch(() => '') || firstAddress();
    await new Promise((resolve, reject) => {
      this.udp = dgram.createSocket('udp4');
      this.udp.once('error', reject);
      this.udp.on('message', (buf, r) => this._receive(buf, {
        key: `udp:${r.address}:${r.port}`, addr: r.address, port: r.port, tcp: false,
        send: (b) => this.udp.send(b, r.port, r.address),
      }));
      this.udp.bind(this.opts.port, this.opts.host, () => {
        this.udp.removeListener('error', reject);
        this.udp.on('error', () => {});
        resolve();
      });
    });
    this.port = this.udp.address().port;
    await new Promise((resolve, reject) => {
      this.tcp = net.createServer((sock) => this._stream(sock));
      this.tcp.once('error', reject);
      this.tcp.listen(this.port, this.opts.host, () => { this.tcp.removeListener('error', reject); resolve(); });
    });
    this.timer = setInterval(() => this._sweep(), 15000);
    this.timer.unref();
    return this;
  }

  async stop() {
    clearInterval(this.timer);
    for (const a of [...this.allocs.values()]) this._free(a);
    await Promise.all([
      new Promise((r) => (this.udp ? this.udp.close(r) : r())),
      new Promise((r) => (this.tcp ? this.tcp.close(() => r()) : r())),
    ]);
  }

  _stream(sock) {
    sock.setNoDelay(true);
    const client = {
      key: `tcp:${sock.remoteAddress}:${sock.remotePort}:${crypto.randomBytes(4).toString('hex')}`,
      addr: String(sock.remoteAddress || '').replace(/^::ffff:/, ''), port: sock.remotePort, tcp: true,
      send: (b) => { if (!sock.destroyed) sock.write(b); },
    };
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const stun = (buf[0] & 0xc0) === 0;
        const len = stun ? 20 + buf.readUInt16BE(2) : pad4(4 + buf.readUInt16BE(2));
        if (len > 65535 + 4) { sock.destroy(); return; }
        if (buf.length < len) break;
        this._receive(buf.subarray(0, len), client);
        buf = buf.subarray(len);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      const a = this.allocs.get(client.key);
      if (a) this._free(a);
    });
    sock.setTimeout(10 * 60 * 1000, () => sock.destroy());
  }

  _receive(buf, client) {
    try {
      if ((buf[0] & 0xc0) === 0x40) return this._channelData(buf, client);
      const msg = parse(buf);
      if (!msg) return undefined;
      if (msg.cls === CLS.INDICATION && msg.method === METHOD.SEND) return this._send(msg, client);
      if (msg.cls !== CLS.REQUEST) return undefined;
      switch (msg.method) {
        case METHOD.BINDING:
          return client.send(build(METHOD.BINDING, CLS.SUCCESS, msg.tid, [[ATTR.XOR_MAPPED, xorAddress(client.addr, client.port)], [ATTR.SOFTWARE, Buffer.from(SOFTWARE)]]));
        case METHOD.ALLOCATE: return this._allocate(msg, client);
        case METHOD.REFRESH: return this._refresh(msg, client);
        case METHOD.PERMISSION: return this._permission(msg, client);
        case METHOD.CHANNEL: return this._channel(msg, client);
        default: return this._error(msg, client, 400, 'Bad Request');
      }
    } catch {
      return undefined; // a malformed packet never takes the server down
    }
  }

  _error(msg, client, code, reason, key = null, extra = []) {
    client.send(build(msg.method, CLS.ERROR, msg.tid, [[ATTR.ERROR, errorValue(code, reason)], ...extra], key));
  }

  _nonce() {
    const ts = Buffer.alloc(6);
    ts.writeUIntBE(Date.now(), 0, 6);
    const mac = crypto.createHmac('sha256', this.nonceKey).update(ts).digest().subarray(0, 10);
    return Buffer.concat([ts, mac]).toString('hex');
  }

  _nonceOk(n) {
    if (!/^[0-9a-f]{32}$/.test(n)) return false;
    const b = Buffer.from(n, 'hex');
    const mac = crypto.createHmac('sha256', this.nonceKey).update(b.subarray(0, 6)).digest().subarray(0, 10);
    return crypto.timingSafeEqual(mac, b.subarray(6)) && Date.now() - b.readUIntBE(0, 6) < 60 * 60 * 1000;
  }

  _password(username) {
    const m = /^(\d{9,12}):(.{1,64})$/.exec(username);
    if (m && this.secret) {
      if (Number(m[1]) * 1000 < Date.now()) return null; // an old login
      return crypto.createHmac('sha1', this.secret).update(username).digest('base64');
    }
    return Object.prototype.hasOwnProperty.call(this.users, username) ? this.users[username] : null;
  }

  /** Check the login on a request. Returns the signing key, or null after answering with an error. */
  _auth(msg, client) {
    const challenge = [[ATTR.REALM, Buffer.from(REALM)], [ATTR.NONCE, Buffer.from(this._nonce())]];
    const user = msg.get(ATTR.USERNAME);
    const nonce = msg.get(ATTR.NONCE);
    if (msg.integrityAt < 0 || !user || !nonce || !msg.get(ATTR.REALM)) {
      this._error(msg, client, 401, 'Unauthorized', null, challenge);
      return null;
    }
    if (!this._nonceOk(nonce.toString())) {
      this._error(msg, client, 438, 'Stale Nonce', null, challenge);
      return null;
    }
    const name = user.toString('utf8');
    const pass = this._password(name);
    const key = pass === null ? null : crypto.createHash('md5').update(`${name}:${REALM}:${pass}`).digest();
    if (!key || !signedWith(msg, key)) {
      this._error(msg, client, 401, 'Unauthorized', null, challenge);
      return null;
    }
    const a = this.allocs.get(client.key);
    if (a && a.user !== name) {
      this._error(msg, client, 441, 'Wrong Credentials');
      return null;
    }
    msg.user = name;
    return key;
  }

  _allocate(msg, client) {
    const key = this._auth(msg, client);
    if (!key) return;
    const existing = this.allocs.get(client.key);
    if (existing) {
      if (existing.tid.equals(msg.tid)) return client.send(existing.reply); // a repeat of the same request
      return this._error(msg, client, 437, 'Allocation Mismatch', key);
    }
    const unknown = msg.attrs.filter((a) => a.type < 0x8000 && !KNOWN.has(a.type)).map((a) => a.type);
    if (unknown.length) {
      const v = Buffer.alloc(unknown.length * 2);
      unknown.forEach((t, i) => v.writeUInt16BE(t, i * 2));
      return this._error(msg, client, 420, 'Unknown Attribute', key, [[ATTR.UNKNOWN, v]]);
    }
    const transport = msg.get(ATTR.TRANSPORT);
    if (!transport || transport[0] !== 17) return this._error(msg, client, 442, 'Unsupported Transport Protocol', key);
    const fam = msg.get(ATTR.FAMILY);
    if (fam && fam[0] !== 0x01) return this._error(msg, client, 440, 'Address Family not Supported', key);
    if (msg.get(ATTR.TOKEN) || msg.get(ATTR.EVEN_PORT)) return this._error(msg, client, 508, 'Insufficient Capacity', key);
    const mine = [...this.allocs.values()].filter((a) => a.user === msg.user).length;
    if (this.allocs.size >= this.opts.maxAllocations || mine >= 12) return this._error(msg, client, 486, 'Allocation Quota Reached', key);

    if (this.pending.has(client.key)) return; // (the same request again while we're still setting up)
    this.pending.add(client.key);
    const bindRelay = (n) => new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      const p = this.opts.minPort + Math.floor(Math.random() * (this.opts.maxPort - this.opts.minPort + 1));
      const retry = () => {
        try { sock.close(); } catch { /* fine */ }
        resolve(n > 0 ? bindRelay(n - 1) : null);
      };
      sock.once('error', retry);
      sock.bind(p, this.opts.host === '0.0.0.0' ? undefined : this.opts.host, () => {
        sock.removeListener('error', retry);
        sock.on('error', () => {});
        resolve(sock);
      });
    });
    bindRelay(30).then((relay) => {
      this.pending.delete(client.key);
      if (!relay) return this._error(msg, client, 508, 'Insufficient Capacity', key);
      const port = relay.address().port;
      const life = this._lifetime(msg);
      const a = {
        client, key, user: msg.user, tid: msg.tid, relay, port, made: Date.now(), expires: Date.now() + life * 1000,
        perms: new Map(), channels: new Map(), peers: new Map(), bytes: 0, reply: null,
      };
      relay.on('message', (data, r) => this._fromPeer(a, r.address, r.port, data));
      a.reply = build(METHOD.ALLOCATE, CLS.SUCCESS, msg.tid, [
        [ATTR.RELAYED, xorAddress(this.externalIp, port)], [ATTR.LIFETIME, u32(life)],
        [ATTR.XOR_MAPPED, xorAddress(client.addr, client.port)], [ATTR.SOFTWARE, Buffer.from(SOFTWARE)],
      ], key);
      this.allocs.set(client.key, a);
      this.byRelayPort.set(port, a);
      this.stats.allocations++;
      client.send(a.reply);
      return undefined;
    });
  }

  _lifetime(msg) {
    const v = msg.get(ATTR.LIFETIME);
    const want = v && v.length >= 4 ? v.readUInt32BE(0) : LIFETIME.default;
    return Math.max(0, Math.min(LIFETIME.max, want));
  }

  _refresh(msg, client) {
    const key = this._auth(msg, client);
    if (!key) return;
    const a = this.allocs.get(client.key);
    if (!a) return this._error(msg, client, 437, 'Allocation Mismatch', key);
    const life = msg.get(ATTR.LIFETIME) ? this._lifetime(msg) : LIFETIME.default;
    if (life === 0) this._free(a);
    else a.expires = Date.now() + life * 1000;
    client.send(build(METHOD.REFRESH, CLS.SUCCESS, msg.tid, [[ATTR.LIFETIME, u32(life)]], key));
  }

  _permission(msg, client) {
    const key = this._auth(msg, client);
    if (!key) return;
    const a = this.allocs.get(client.key);
    if (!a) return this._error(msg, client, 437, 'Allocation Mismatch', key);
    const peers = msg.all(ATTR.PEER).map(readXorAddress);
    if (!peers.length || peers.some((p) => !p)) return this._error(msg, client, 400, 'Bad Request', key);
    if (peers.some((p) => !this._allowed(p.addr))) return this._error(msg, client, 403, 'Forbidden', key);
    for (const p of peers) a.perms.set(p.addr, Date.now() + LIFETIME.permission * 1000);
    client.send(build(METHOD.PERMISSION, CLS.SUCCESS, msg.tid, [], key));
  }

  _channel(msg, client) {
    const key = this._auth(msg, client);
    if (!key) return;
    const a = this.allocs.get(client.key);
    if (!a) return this._error(msg, client, 437, 'Allocation Mismatch', key);
    const ch = msg.get(ATTR.CHANNEL);
    const peer = readXorAddress(msg.get(ATTR.PEER));
    const num = ch && ch.length >= 2 ? ch.readUInt16BE(0) : 0;
    if (!peer || num < 0x4000 || num > 0x7ffe) return this._error(msg, client, 400, 'Bad Request', key);
    if (!this._allowed(peer.addr)) return this._error(msg, client, 403, 'Forbidden', key);
    const where = `${peer.addr}:${peer.port}`;
    const bound = a.channels.get(num);
    if ((bound && bound.where !== where) || (a.peers.has(where) && a.peers.get(where) !== num)) return this._error(msg, client, 400, 'Bad Request', key);
    a.channels.set(num, { where, addr: peer.addr, port: peer.port, expires: Date.now() + LIFETIME.channel * 1000 });
    a.peers.set(where, num);
    a.perms.set(peer.addr, Date.now() + LIFETIME.permission * 1000);
    client.send(build(METHOD.CHANNEL, CLS.SUCCESS, msg.tid, [], key));
  }

  _send(msg, client) {
    const a = this.allocs.get(client.key);
    const peer = readXorAddress(msg.get(ATTR.PEER));
    const data = msg.get(ATTR.DATA);
    if (!a || !peer || !data) return;
    const until = a.perms.get(peer.addr);
    if (!until || until < Date.now()) return;
    this._toPeer(a, peer.addr, peer.port, data);
  }

  _channelData(buf, client) {
    const a = this.allocs.get(client.key);
    if (!a || buf.length < 4) return;
    const ch = a.channels.get(buf.readUInt16BE(0));
    const len = buf.readUInt16BE(2);
    if (!ch || ch.expires < Date.now() || 4 + len > buf.length) return;
    const until = a.perms.get(ch.addr);
    if (!until || until < Date.now()) return;
    this._toPeer(a, ch.addr, ch.port, buf.subarray(4, 4 + len));
  }

  _toPeer(a, addr, port, data) {
    if (!this._allowed(addr)) return;
    a.bytes += data.length;
    this.stats.bytes += data.length;
    // Both people using this same server: hand it over inside, no round trip.
    const local = addr === this.externalIp ? this.byRelayPort.get(port) : null;
    if (local) return this._fromPeer(local, this.externalIp, a.port, Buffer.from(data));
    a.relay.send(data, port, addr);
    return undefined;
  }

  _fromPeer(a, addr, port, data) {
    const until = a.perms.get(addr);
    if (!until || until < Date.now() || !this.allocs.has(a.client.key)) return;
    a.bytes += data.length;
    const num = a.peers.get(`${addr}:${port}`);
    const ch = num && a.channels.get(num);
    if (ch && ch.expires > Date.now()) {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(num, 0);
      head.writeUInt16BE(data.length, 2);
      const padding = a.client.tcp ? Buffer.alloc(pad4(data.length) - data.length) : Buffer.alloc(0);
      a.client.send(Buffer.concat([head, data, padding]));
      return;
    }
    a.client.send(build(METHOD.DATA, CLS.INDICATION, crypto.randomBytes(12), [[ATTR.PEER, xorAddress(addr, port)], [ATTR.DATA, data]]));
  }

  _allowed(addr) {
    if (this.opts.allowPrivate) return true;
    if (addr === this.externalIp) return true; // (another allocation on this same server)
    return !isPrivate(addr);
  }

  _free(a) {
    this.allocs.delete(a.client.key);
    this.byRelayPort.delete(a.port);
    try { a.relay.close(); } catch { /* already closed */ }
  }

  _sweep() {
    const now = Date.now();
    for (const a of [...this.allocs.values()]) {
      if (a.expires < now) { this._free(a); continue; }
      for (const [ip, t] of a.perms) if (t < now) a.perms.delete(ip);
      for (const [n, ch] of a.channels) if (ch.expires < now) { a.channels.delete(n); a.peers.delete(ch.where); }
    }
  }
}

/** Ask a public STUN server what this machine's internet address is. */
function publicAddress(server = 'stun.l.google.com', port = 19302, timeout = 3000) {
  return new Promise((resolve, reject) => {
    dns.lookup(server, { family: 4 }, (err, ip) => {
      if (err) return reject(err);
      const sock = dgram.createSocket('udp4');
      const tid = crypto.randomBytes(12);
      const timer = setTimeout(() => { sock.close(); reject(new Error('no answer')); }, timeout);
      sock.on('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
      sock.on('message', (buf) => {
        const m = parse(buf);
        if (!m || !m.tid.equals(tid)) return;
        clearTimeout(timer);
        sock.close();
        const a = readXorAddress(m.get(ATTR.XOR_MAPPED));
        return a ? resolve(a.addr) : reject(new Error('no address'));
      });
      sock.send(build(METHOD.BINDING, CLS.REQUEST, tid, []), port, ip);
      return undefined;
    });
  });
}

function firstAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

// ── `gossip turn` ───────────────────────────────────────────────────────────

const HELP = `Run gossip's call relay (a TURN server), for calls on networks that block direct connections.

  gossip turn [options]

Options
  --port <n>          Port for calls to reach it, UDP and TCP   (default 3478)
  --external-ip <ip>  This machine's public address              (found automatically)
  --min-port <n>      Lowest port it relays calls through        (default 49152)
  --max-port <n>      Highest port                               (default 65535)
  --data <folder>     Where its secret is kept                   (default ~/.gossip-turn)
  --user <name:pass>  A fixed login as well (can repeat)
  --allow-private     Also relay to private addresses (only for a home network)

Open these in your firewall:  UDP and TCP on --port, and UDP from --min-port to --max-port.
On Google Cloud:
  gcloud compute firewall-rules create gossip-turn --allow tcp:3478,udp:3478,udp:49152-65535
`;

async function main(argv) {
  const opts = { port: 3478, data: path.join(os.homedir(), '.gossip-turn'), users: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--port') opts.port = Number(next());
    else if (a === '--external-ip') opts.externalIp = next();
    else if (a === '--min-port') opts.minPort = Number(next());
    else if (a === '--max-port') opts.maxPort = Number(next());
    else if (a === '--data') opts.data = path.resolve(next());
    else if (a === '--allow-private') opts.allowPrivate = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--user') {
      const [n, ...p] = next().split(':');
      if (!n || !p.length) throw new Error('--user needs name:password');
      opts.users[n] = p.join(':');
    } else if (a === '--help' || a === '-h') { console.log(HELP); return undefined; }
    else throw new Error(`Unknown option: ${a}\n\n${HELP}`);
  }
  if (opts.externalIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(opts.externalIp)) throw new Error('--external-ip must be an IPv4 address like 34.120.0.5');
  fs.mkdirSync(opts.data, { recursive: true, mode: 0o700 });
  const secretFile = path.join(opts.data, 'secret');
  let secret = '';
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* first run */ }
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600 });
  }
  const server = await new TurnServer({ ...opts, secret }).start();
  const where = `${server.externalIp}:${server.port}`;
  console.log(`gossip call relay is running at ${where}  (Ctrl+C to stop)`);
  console.log('');
  console.log('Give it to your gossip website: add these two lines to ~/gossip-data/config.json on PythonAnywhere,');
  console.log('then press Reload on the Web page:');
  console.log('');
  console.log(`  "turn_server": "${where}",`);
  console.log(`  "turn_secret": "${secret}"`);
  console.log('');
  console.log(`(or for a relay:  gossip serve --turn-server ${where} --turn-secret ${secret})`);
  if (isPrivate(server.externalIp)) console.log(`\nNote: ${server.externalIp} is a private address. If this machine has a public one, add --external-ip <it>.`);
  const bye = () => server.stop().then(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  setInterval(() => server.log(`${server.allocs.size} call${server.allocs.size === 1 ? '' : 's'} relayed right now, ${(server.stats.bytes / 1048576).toFixed(1)} MB passed along so far`), 30 * 60 * 1000).unref();
  return 'stay';
}

module.exports = { TurnServer, main, credentials, iceFor, publicAddress, parse, build, xorAddress, readXorAddress, isPrivate, METHOD, CLS, ATTR, REALM };

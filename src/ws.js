'use strict';
// A small WebSocket (RFC 6455) implementation for both the client and the
// relay, so gossip needs no npm packages. Text frames only, no extensions.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const utf8 = new TextDecoder('utf-8', { fatal: true });

class WSConn extends EventEmitter {
  constructor(socket, { isClient = false, maxPayload = 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.maxPayload = maxPayload;
    this.closed = false;
    this.closeSent = false;
    this._buf = null;
    this._frags = [];
    this._fragOp = 0;
    this._fragLen = 0;
    // Messages that arrive before anyone is listening are held, not dropped.
    this._backlog = [];
    this.on('newListener', (event) => {
      if (event === 'message' && this._backlog.length) process.nextTick(() => this._drain());
    });

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._finish(1006, 'connection error'));
    socket.on('close', () => this._finish(1006, 'connection lost'));
    socket.on('end', () => { if (!socket.destroyed) socket.end(); });
  }

  /** Bytes waiting to be written (lets a server spot clients that stopped reading). */
  get buffered() {
    return this.socket.writableLength || 0;
  }

  send(text) {
    return this._frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  ping() {
    return this._frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this.closeSent) {
      const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      this._frame(0x8, p);
      this.closeSent = true;
    }
    this._localClose = [code, reason];
    try { this.socket.end(); } catch { /* already gone */ }
    const t = setTimeout(() => this.terminate(), 1500);
    if (t.unref) t.unref();
  }

  terminate() {
    try { this.socket.destroy(); } catch { /* already gone */ }
    this._finish(1006, 'connection closed');
  }

  _drain() {
    while (this._backlog.length && this.listenerCount('message') > 0) {
      this.emit('message', this._backlog.shift());
    }
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    if (this._localClose) [code, reason] = this._localClose;
    this.emit('close', code, reason);
  }

  _fail(code, reason) {
    this.close(code, reason);
    this.terminate();
  }

  _frame(opcode, payload) {
    if (this.closed || this.closeSent || this.socket.destroyed || !this.socket.writable) return false;
    const len = payload.length;
    const maskBit = this.isClient ? 0x80 : 0;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = maskBit | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = maskBit | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = maskBit | 127;
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      if (this.isClient) {
        const mask = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
        this.socket.write(Buffer.concat([header, mask, masked]));
      } else {
        this.socket.write(Buffer.concat([header, payload]));
      }
      return true;
    } catch {
      return false;
    }
  }

  _onData(chunk) {
    if (this.closed) return;
    this._buf = this._buf && this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (b0 & 0x70) return this._fail(1002, 'unsupported extension');
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this._fail(1009, 'message too big');
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (len > this.maxPayload) return this._fail(1009, 'message too big');
      if (masked === this.isClient) return this._fail(1002, 'bad masking');
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;

      let payload = Buffer.from(buf.subarray(off, off + len)); // copy
      if (masked) {
        const m = buf.subarray(maskOff, maskOff + 4);
        for (let i = 0; i < len; i++) payload[i] ^= m[i & 3];
      }
      this._buf = buf.subarray(off + len);
      this._onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) return this._fail(1002, 'bad control frame');
      if (opcode === 0x8) {
        let code = 1005;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        if (!this.closeSent) {
          this._frame(0x8, payload.subarray(0, 2));
          this.closeSent = true;
        }
        try { this.socket.end(); } catch { /* already gone */ }
        this._localClose = null;
        this._finish(code, reason);
      } else if (opcode === 0x9) {
        this._frame(0xa, payload);
      } else if (opcode === 0xa) {
        this.emit('pong');
      } else {
        this._fail(1002, 'unknown control frame');
      }
      return;
    }

    if (opcode === 0x0) {
      if (!this._fragOp) return this._fail(1002, 'unexpected continuation');
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (this._fragOp) return this._fail(1002, 'expected continuation');
      this._fragOp = opcode;
    } else {
      return this._fail(1002, 'unknown frame');
    }
    this._frags.push(payload);
    this._fragLen += payload.length;
    if (this._fragLen > this.maxPayload) return this._fail(1009, 'message too big');
    if (!fin) return;

    const data = this._frags.length === 1 ? this._frags[0] : Buffer.concat(this._frags);
    const op = this._fragOp;
    this._frags = [];
    this._fragOp = 0;
    this._fragLen = 0;
    if (op !== 0x1) return this._fail(1003, 'text frames only');
    let text;
    try {
      text = utf8.decode(data);
    } catch {
      return this._fail(1007, 'invalid text');
    }
    if (this.listenerCount('message') === 0 || this._backlog.length) this._backlog.push(text);
    else this.emit('message', text);
  }
}

/** Server side: call from an http server's 'upgrade' event. Returns a WSConn or null. */
function accept(req, socket, head, opts = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const ok = req.method === 'GET' && upgrade === 'websocket' &&
    typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key) &&
    req.headers['sec-websocket-version'] === '13';
  if (!ok) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  );
  if (head && head.length) socket.unshift(head);
  return new WSConn(socket, { ...opts, isClient: false });
}

/** Client side: open ws:// or wss:// and resolve with a WSConn. */
function connect(url, { timeout = 10000, maxPayload, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(Object.assign(new Error(`"${url}" is not a valid server address`), { code: 'EBADURL' }));
    }
    const secure = u.protocol === 'wss:';
    if (!secure && u.protocol !== 'ws:') {
      return reject(Object.assign(new Error('Server address must start with wss:// or ws://'), { code: 'EBADURL' }));
    }
    const key = crypto.randomBytes(16).toString('base64');
    let settled = false;
    const done = (err, conn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(conn);
    };
    const req = (secure ? https : http).request({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (secure ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      agent: false,
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    }, timeout);
    req.on('upgrade', (res, socket, head) => {
      const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy();
        return done(Object.assign(new Error('not a gossip server'), { code: 'EBADHANDSHAKE' }));
      }
      if (head && head.length) socket.unshift(head);
      done(null, new WSConn(socket, { isClient: true, maxPayload }));
    });
    req.on('response', (res) => {
      res.resume();
      req.destroy();
      done(Object.assign(new Error(`server answered HTTP ${res.statusCode}`), { code: 'EBADHANDSHAKE' }));
    });
    req.on('error', (err) => done(err));
    req.end();
  });
}

module.exports = { WSConn, accept, connect };

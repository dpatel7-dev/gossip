'use strict';
// gossip's own call relay (TURN), spoken to the way a browser does.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const T = require('../src/turn');

const { METHOD, CLS, ATTR } = T;
const SECRET = crypto.randomBytes(32).toString('hex');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }

/** A tiny TURN client over UDP or TCP. */
async function client(server, { tcp = false } = {}) {
  const inbox = [];
  const waiters = [];
  const deliver = (buf) => {
    const w = waiters.findIndex((x) => x.match(buf));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(buf); else inbox.push(buf);
  };
  let send;
  let close;
  if (tcp) {
    const sock = net.connect(server.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 4) break;
        const stun = (buf[0] & 0xc0) === 0;
        const len = stun ? 20 + buf.readUInt16BE(2) : (4 + buf.readUInt16BE(2) + 3) & ~3;
        if (buf.length < len) break;
        deliver(buf.subarray(0, len));
        buf = buf.subarray(len);
      }
    });
    send = (b) => sock.write(b);
    close = () => sock.destroy();
  } else {
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, '127.0.0.1', r));
    sock.on('message', deliver);
    send = (b) => sock.send(b, server.port, '127.0.0.1');
    close = () => sock.close();
  }
  const next = (match, ms = 2000) => {
    const i = inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error('no answer')); } }, ms);
    });
  };
  const request = async (method, attrs, key) => {
    const tid = crypto.randomBytes(12);
    send(T.build(method, CLS.REQUEST, tid, attrs, key));
    const buf = await next((b) => (b[0] & 0xc0) === 0 && b.subarray(8, 20).equals(tid));
    return T.parse(buf);
  };
  return { send, next, request, close };
}

const errorCode = (m) => { const v = m.get(ATTR.ERROR); return v ? v[2] * 100 + v[3] : 0; };

async function login(c, creds) {
  const first = await c.request(METHOD.ALLOCATE, [[ATTR.TRANSPORT, Buffer.from([17, 0, 0, 0])]]);
  assert.equal(first.cls, CLS.ERROR);
  assert.equal(errorCode(first), 401, 'asks for a login first');
  const realm = first.get(ATTR.REALM);
  const nonce = first.get(ATTR.NONCE);
  const key = crypto.createHash('md5').update(`${creds.username}:${realm}:${creds.credential}`).digest();
  const res = await c.request(METHOD.ALLOCATE, [
    [ATTR.TRANSPORT, Buffer.from([17, 0, 0, 0])], [ATTR.USERNAME, Buffer.from(creds.username)], [ATTR.REALM, realm], [ATTR.NONCE, nonce],
  ], key);
  return { res, key, realm, nonce };
}

test('turn: logs in with a day-long password, relays both ways, over UDP and TCP', async () => {
  for (const tcp of [false, true]) {
    const server = await new T.TurnServer({ port: 0, externalIp: '127.0.0.1', allowPrivate: true, secret: SECRET, quiet: true }).start();
    const peer = dgram.createSocket('udp4');
    await new Promise((r) => peer.bind(0, '127.0.0.1', r));
    const heard = [];
    peer.on('message', (buf, r) => { heard.push(buf.toString()); peer.send(Buffer.concat([Buffer.from('echo:'), buf]), r.port, r.address); });
    const c = await client(server, { tcp });
    try {
      const creds = T.credentials(SECRET, 'ann');
      const { res, key, realm, nonce } = await login(c, creds);
      assert.equal(res.cls, CLS.SUCCESS, `allocate failed: ${errorCode(res)}`);
      assert.equal(T.readXorAddress(res.get(ATTR.RELAYED)).addr, '127.0.0.1');
      const auth = [[ATTR.USERNAME, Buffer.from(creds.username)], [ATTR.REALM, realm], [ATTR.NONCE, nonce]];
      const peerAddr = T.xorAddress('127.0.0.1', peer.address().port);

      c.send(T.build(METHOD.SEND, CLS.INDICATION, crypto.randomBytes(12), [[ATTR.PEER, peerAddr], [ATTR.DATA, Buffer.from('too soon')]]));
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(heard, [], 'nothing is passed on before permission');

      const perm = await c.request(METHOD.PERMISSION, [[ATTR.PEER, peerAddr], ...auth], key);
      assert.equal(perm.cls, CLS.SUCCESS);
      c.send(T.build(METHOD.SEND, CLS.INDICATION, crypto.randomBytes(12), [[ATTR.PEER, peerAddr], [ATTR.DATA, Buffer.from('hello')]]));
      const back = T.parse(await c.next((b) => (b[0] & 0xc0) === 0 && T.parse(b) && T.parse(b).method === METHOD.DATA));
      assert.equal(back.get(ATTR.DATA).toString(), 'echo:hello');
      assert.deepEqual(heard, ['hello']);

      const bind = await c.request(METHOD.CHANNEL, [[ATTR.CHANNEL, Buffer.from([0x40, 0x01, 0, 0])], [ATTR.PEER, peerAddr], ...auth], key);
      assert.equal(bind.cls, CLS.SUCCESS);
      const data = Buffer.from('via channel!');
      const frame = Buffer.alloc(4 + ((data.length + 3) & ~3));
      frame.writeUInt16BE(0x4001, 0);
      frame.writeUInt16BE(data.length, 2);
      data.copy(frame, 4);
      c.send(tcp ? frame : frame.subarray(0, 4 + data.length));
      const cd = await c.next((b) => (b[0] & 0xc0) === 0x40);
      assert.equal(cd.readUInt16BE(0), 0x4001);
      assert.equal(cd.subarray(4, 4 + cd.readUInt16BE(2)).toString(), 'echo:via channel!');

      const refresh = await c.request(METHOD.REFRESH, [[ATTR.LIFETIME, u32(0)], ...auth], key);
      assert.equal(refresh.cls, CLS.SUCCESS);
      assert.equal(server.allocs.size, 0, 'a lifetime of 0 frees it');
    } finally {
      c.close();
      peer.close();
      await server.stop();
    }
  }
});

test('turn: wrong or expired logins are refused, and it never relays into private networks', async () => {
  const server = await new T.TurnServer({ port: 0, externalIp: '203.0.113.10', secret: SECRET, quiet: true }).start();
  const c = await client(server);
  try {
    const expired = { username: `${Math.floor(Date.now() / 1000) - 10}:ann`, credential: '' };
    expired.credential = crypto.createHmac('sha1', SECRET).update(expired.username).digest('base64');
    assert.equal(errorCode((await login(c, expired)).res), 401, 'an old login');
    assert.equal(errorCode((await login(c, { username: T.credentials(SECRET, 'ann').username, credential: 'guess' })).res), 401, 'a wrong password');

    const creds = T.credentials(SECRET, 'ann');
    const { res, key, realm, nonce } = await login(c, creds);
    assert.equal(res.cls, CLS.SUCCESS);
    const auth = [[ATTR.USERNAME, Buffer.from(creds.username)], [ATTR.REALM, realm], [ATTR.NONCE, nonce]];
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.20.0.1']) {
      const r = await c.request(METHOD.PERMISSION, [[ATTR.PEER, T.xorAddress(ip, 5000)], ...auth], key);
      assert.equal(errorCode(r), 403, `${ip} is off limits`);
    }
    const ok = await c.request(METHOD.PERMISSION, [[ATTR.PEER, T.xorAddress('198.51.100.20', 5000)], ...auth], key);
    assert.equal(ok.cls, CLS.SUCCESS, 'a public address is fine');
    const other = T.credentials(SECRET, 'ben');
    const wrongUser = await c.request(METHOD.REFRESH, [[ATTR.USERNAME, Buffer.from(other.username)], [ATTR.REALM, realm], [ATTR.NONCE, nonce]],
      crypto.createHash('md5').update(`${other.username}:${realm}:${other.credential}`).digest());
    assert.equal(errorCode(wrongUser), 441, "someone else can't touch your allocation");
    // a plain "what's my address?" question works with no login
    const bind = await c.request(METHOD.BINDING, []);
    assert.equal(T.readXorAddress(bind.get(ATTR.XOR_MAPPED)).addr, '127.0.0.1');
  } finally {
    c.close();
    await server.stop();
  }
});

test('turn: the logins a website hands out', () => {
  const ice = T.iceFor('203.0.113.10:3478', SECRET, 'ann');
  assert.equal(ice[0].urls, 'stun:203.0.113.10:3478');
  assert.deepEqual(ice[1].urls, ['turn:203.0.113.10:3478?transport=udp', 'turn:203.0.113.10:3478?transport=tcp']);
  assert.match(ice[1].username, /^\d+:ann$/);
  assert.ok(Number(ice[1].username.split(':')[0]) > Date.now() / 1000 + 23 * 3600);
  assert.equal(ice[1].credential, crypto.createHmac('sha1', SECRET).update(ice[1].username).digest('base64'));
  assert.equal(T.isPrivate('8.8.8.8'), false);
  assert.equal(T.isPrivate('100.64.0.1'), true);
});

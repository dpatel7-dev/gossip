'use strict';
// Nearby mode: chat with people on the same local network, with no internet.
//
// "Same local network" means the same Wi-Fi router (it doesn't need to be
// online), a hotspot, or computers joined by a network cable. The first person
// to start `gossip nearby` quietly runs a relay on their own computer; everyone
// after that finds it by shouting "anyone there?" on the local network.
//
// Messages are end-to-end encrypted exactly as they are over the internet.

const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAGIC = 'gossip-nearby/1';
const UDP_PORT = Number(process.env.GOSSIP_NEARBY_PORT) || 47800; // where hosts listen for "anyone there?"
const TCP_PORT = 47801; // where a host's relay listens (falls back to any free port)
const LOBBY = 'nearby'; // the server everyone lands in, so you can see who's around

/** This computer's addresses on the local network. */
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i);
  }
  return out;
}

/** Everywhere a "who's there?" should be sent. */
function shoutAddresses() {
  if (process.env.GOSSIP_NEARBY_ADDRS) return process.env.GOSSIP_NEARBY_ADDRS.split(',').map((s) => s.trim()).filter(Boolean);
  const out = new Set(['255.255.255.255', '127.0.0.1']);
  for (const i of localAddresses()) {
    const a = i.address.split('.').map(Number);
    const m = String(i.netmask || '255.255.255.0').split('.').map(Number);
    if (a.length === 4 && m.length === 4) out.add(a.map((x, k) => (x | (~m[k] & 255))).join('.'));
  }
  return [...out];
}

/**
 * Look for nearby hosts. Resolves with [{ url, name, id, since }], longest-running first.
 */
function find({ timeout = 1200, port = UDP_PORT, skip = null } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve([...found.values()].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1)));
    };
    sock.on('error', finish);
    sock.on('message', (buf, from) => {
      let m;
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (!m || m.m !== MAGIC || m.t !== 'here' || typeof m.id !== 'string' || m.id === skip) return;
      if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535 || !Number.isFinite(m.since)) return;
      if (!found.has(m.id)) {
        found.set(m.id, { id: m.id.slice(0, 40), since: m.since, name: String(m.name || '').slice(0, 60), url: `ws://${from.address}:${m.port}`, address: from.address });
      }
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch { /* some systems refuse; unicast still works */ }
      const ask = Buffer.from(JSON.stringify({ m: MAGIC, t: 'who' }));
      const shout = () => {
        if (done) return;
        for (const addr of shoutAddresses()) sock.send(ask, port, addr, () => {});
      };
      shout();
      setTimeout(shout, Math.min(350, timeout / 3));
      setTimeout(finish, timeout);
    });
  });
}

/** Runs a relay on this computer and answers "anyone there?" from the neighbours. */
class Host extends EventEmitter {
  constructor({ dataDir = null, name = '', udpPort = UDP_PORT, tcpPort = TCP_PORT } = {}) {
    super();
    this.opts = { dataDir, name, udpPort, tcpPort };
    this.id = crypto.randomBytes(9).toString('base64url');
    this.since = Date.now();
    this.relay = null;
    this.sock = null;
  }

  get url() {
    return `ws://127.0.0.1:${this.relay.port}`;
  }

  async start() {
    const { Relay } = require('../server/relay');
    const make = (port) => new Relay({ port, host: '0.0.0.0', dataDir: this.opts.dataDir, name: this.opts.name || 'nearby', quiet: true });
    try {
      this.relay = await make(this.opts.tcpPort).start();
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      this.relay = await make(0).start();
    }
    await new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;
      sock.on('error', () => resolve()); // can't listen: people can still join by address
      sock.on('message', (buf, from) => {
        let m;
        try {
          m = JSON.parse(buf.toString('utf8'));
        } catch {
          return;
        }
        if (!m || m.m !== MAGIC || m.t !== 'who') return;
        const here = Buffer.from(JSON.stringify({ m: MAGIC, t: 'here', id: this.id, since: this.since, port: this.relay.port, name: this.opts.name }));
        sock.send(here, from.port, from.address, () => {});
      });
      sock.bind(this.opts.udpPort, () => resolve());
    });
    return this;
  }

  /** Someone else nearby who has been hosting for longer (two hosts should become one). */
  async rival(port = this.opts.udpPort) {
    const others = await find({ timeout: 900, port, skip: this.id });
    return others.find((o) => o.since < this.since || (o.since === this.since && o.id < this.id)) || null;
  }

  async stop() {
    try { if (this.sock) this.sock.close(); } catch { /* already closed */ }
    this.sock = null;
    if (this.relay) await this.relay.stop();
    this.relay = null;
  }
}

/** "192.168.1.5" or "192.168.1.5:47801" -> the relay address to connect to. */
function addressToUrl(text) {
  const s = String(text || '').trim().replace(/^wss?:\/\//i, '');
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(s)) throw new Error(`"${text}" doesn't look like an address. Example: gossip nearby 192.168.1.5`);
  return `ws://${/:\d+$/.test(s) ? s : `${s}:${TCP_PORT}`}`;
}

module.exports = { find, Host, localAddresses, addressToUrl, LOBBY, UDP_PORT, TCP_PORT };

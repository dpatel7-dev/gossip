'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../src/nearby');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');

process.env.GOSSIP_NEARBY_ADDRS = '127.0.0.1'; // these tests stay on this machine

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-nearby-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const port = () => 20000 + Math.floor(Math.random() * 20000);

test('nearby: nobody around means an empty answer, quickly', async () => {
  assert.deepEqual(await N.find({ timeout: 300, port: port() }), []);
});

test('nearby: a host is found, and two people chat through it with no account anywhere else', async () => {
  const udp = port();
  const host = await new N.Host({ dataDir: tmp(), name: "ann's computer", udpPort: udp, tcpPort: 0 }).start();
  try {
    const found = await N.find({ timeout: 500, port: udp });
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "ann's computer");
    assert.equal(found[0].url, `ws://127.0.0.1:${host.relay.port}`);

    const join = async (name, url) => {
      const app = new App({ vault: new Vault(tmp()), via: url, shell: true });
      app.createLocalIdentity(name); // keys only - the nearby host signs them up when they arrive
      app.shown = [];
      app.on('line', (i) => app.shown.push(i));
      await app.connect();
      return app;
    };
    const ann = await join('ann', host.url);
    const ben = await join('ben', found[0].url);
    assert.equal(ann.serverUrl, host.url);
    assert.equal(new Vault(ann.vault.dir).loadSettings().server, '', 'a nearby address is never saved as your relay');

    await ann.send('@ben', 'no internet, no problem');
    await until(() => ben.shown.some((i) => i.t === 'msg' && i.msg.text === 'no internet, no problem'), 'the message');
    await ann.closeGracefully();
    await ben.closeGracefully();
  } finally {
    await host.stop();
  }
});

test('nearby: when two computers both host, the newer one notices the older', async () => {
  const a = await new N.Host({ dataDir: tmp(), udpPort: port(), tcpPort: 0 }).start();
  await sleep(15);
  const b = await new N.Host({ dataDir: tmp(), udpPort: port(), tcpPort: 0 }).start();
  try {
    const rival = await b.rival(a.opts.udpPort);
    assert.ok(rival, 'the newer host sees the older one');
    assert.equal(rival.url, `ws://127.0.0.1:${a.relay.port}`);
    assert.equal(await a.rival(b.opts.udpPort), null, 'the older host stays put');
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('nearby: addresses', () => {
  assert.equal(N.addressToUrl('192.168.1.5'), 'ws://192.168.1.5:47801');
  assert.equal(N.addressToUrl('192.168.1.5:5000'), 'ws://192.168.1.5:5000');
  assert.throws(() => N.addressToUrl('not an address!'), /doesn't look like an address/);
});

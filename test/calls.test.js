'use strict';
// Calls and the dashboard, without a browser: the browser's side is played by
// plain web requests to gossip's little local server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
process.env.GOSSIP_NO_BROWSER = '1';
const { Relay } = require('../server/relay');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');
const { Calls } = require('../src/call');
const { runCommand, handleInput } = require('../src/commands');
const dashboard = require('../src/dashboard');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-call-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function person(relay, name) {
  const dir = tmp();
  const url = `ws://127.0.0.1:${relay.port}`;
  await new App({ vault: new Vault(dir), server: url }).register(name);
  const app = new App({ vault: new Vault(dir), server: url, shell: true });
  app.notes = [];
  app.on('line', (i) => { if (i.t === 'note') app.notes.push(i.text); });
  app.calls = new Calls(app);
  app.ctx = { app, shell: true, quit() {} };
  await app.connect();
  return app;
}

function request(url, { method = 'GET', body = null, host = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'content-type': 'application/json' };
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    const req = http.request(u, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Listen to a call page's event stream, like the browser does. */
function events(url) {
  const got = [];
  const req = http.get(url, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) got.push(JSON.parse(chunk.slice(6)));
      }
    });
  });
  got.close = () => req.destroy();
  return got;
}

test('calls: ring, answer, both browsers swap details through gossip, hang up', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  const streams = [];
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    await runCommand(ann.ctx, 'call ben');
    const out = ann.calls.current;
    assert.equal(out.state, 'calling');
    await until(() => ben.calls.ringing, 'the ring');
    assert.ok(ben.notes.some((t) => /ann is calling/.test(t)));

    // ann's "browser" hands over its details; gossip passes them to ben
    const annEvents = events(ann.web.url(`callevents/${out.id}`));
    streams.push(annEvents);
    const page = await request(ann.web.url(`call/${out.id}`));
    assert.equal(page.status, 200);
    assert.match(page.text, /call with/);
    await request(ann.web.url(`callapi/${out.id}`), { method: 'POST', body: { t: 'offer', sdp: 'v=0 offer-from-ann' } });

    await runCommand(ben.ctx, 'answer');
    const inc = ben.calls.current;
    assert.equal(inc.state, 'connecting');
    const benEvents = events(ben.web.url(`callevents/${inc.id}`));
    streams.push(benEvents);
    await until(() => benEvents.some((e) => e.t === 'offer' && e.sdp === 'v=0 offer-from-ann'), "ben's browser to get ann's details");
    await request(ben.web.url(`callapi/${inc.id}`), { method: 'POST', body: { t: 'answer', sdp: 'v=0 answer-from-ben' } });
    await until(() => annEvents.some((e) => e.t === 'answer' && e.sdp === 'v=0 answer-from-ben'), "ann's browser to get ben's answer");

    await request(ann.web.url(`callapi/${out.id}`), { method: 'POST', body: { t: 'live' } });
    await request(ann.web.url(`callapi/${out.id}`), { method: 'POST', body: { t: 'stats', route: { kind: 'direct', remote: '198.51.100.7:5000', proto: 'udp', rtt: 30 } } });
    assert.equal(out.state, 'live');

    // chat during the call: typed in ann's call window, it's an ordinary message to ben - and shows in his call window too
    await request(ann.web.url(`callapi/${out.id}`), { method: 'POST', body: { t: 'say', text: 'can you hear me?' } });
    await until(() => benEvents.some((e) => e.t === 'msg' && e.from === 'ann' && !e.mine && e.text === 'can you hear me?'), "ann's call-window message to reach ben's call window");
    await until(() => ben.vault.loadHistory('@ann', 5).some((r) => r.text === 'can you hear me?'), 'it to be saved like any message');
    await until(() => annEvents.some((e) => e.t === 'msg' && e.mine && e.text === 'can you hear me?'), 'it to show in her own call window');

    // a network hiccup: ben's browser asks for a fresh connection, ann's builds one, ben's answers
    await request(ben.web.url(`callapi/${inc.id}`), { method: 'POST', body: { t: 'restart' } });
    await until(() => annEvents.some((e) => e.t === 'restart'), "ann's browser to be asked to reconnect");
    await request(ann.web.url(`callapi/${out.id}`), { method: 'POST', body: { t: 'reoffer', sdp: 'v=0 fresh-offer' } });
    await until(() => benEvents.some((e) => e.t === 'reoffer' && e.sdp === 'v=0 fresh-offer'), 'the fresh details to reach ben');
    await request(ben.web.url(`callapi/${inc.id}`), { method: 'POST', body: { t: 'reanswer', sdp: 'v=0 fresh-answer' } });
    await until(() => annEvents.some((e) => e.t === 'reanswer' && e.sdp === 'v=0 fresh-answer'), "ben's fresh answer to reach ann");
    assert.equal(out.state, 'live', 'the call carries on');

    // the dashboard sees all of it
    await dashboard.open(ann);
    const snap = JSON.parse((await request(ann.web.url('dashapi'))).text);
    assert.equal(snap.me, 'ann');
    assert.equal(snap.connection.state, 'online');
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].you, true);
    assert.ok(snap.outbound.some((o) => o.what === 'Call with ben' && o.where === '198.51.100.7:5000'));
    assert.ok(snap.chats.some((c) => c.key === '@ben' && c.readers.map((r) => r.name).join() === 'ann,ben'));
    assert.ok(snap.activity.some((a) => /On a call with ben/.test(a.text)));
    assert.ok(snap.people.some((p) => p.name === 'ben' && p.last && /can you hear me/.test(p.last.text)));
    assert.equal(snap.callNow, 'ben');
    assert.ok(snap.settings.theme.choices.includes('daylight'));

    // things you can do from the dashboard
    const act = async (body) => JSON.parse((await request(ann.web.url('dashact'), { method: 'POST', body })).text);
    assert.equal((await act({ do: 'set', key: 'calls', value: 'everyone' })).ok, true);
    assert.equal(require('../src/prefs').val('calls'), 'everyone');
    assert.equal((await act({ do: 'set', key: 'files', value: '/etc' })).ok, false, 'only a few settings can be changed from the page');
    await act({ do: 'dnd', for: '1h' });
    assert.ok(ann.dndActive());
    await act({ do: 'dnd', for: 'off' });
    assert.equal(ann.dndActive(), false);
    await act({ do: 'send', to: 'ben', text: 'from the dashboard' });
    await until(() => ben.vault.loadHistory('@ann', 5).some((r) => r.text === 'from the dashboard'), 'the dashboard message to arrive');
    assert.equal((await act({ do: 'send', to: 'stranger', text: 'hi' })).ok, false, 'only to your contacts');
    ann.schedule('later', { at: Date.now() + 3600000, key: '@ben', text: 'later on' });
    const id = ann.scheduled('later')[0].id;
    assert.equal(JSON.parse((await request(ann.web.url('dashapi'))).text).scheduled.later[0].text, 'later on');
    assert.equal((await act({ do: 'unschedule', kind: 'later', id })).ok, true);
    assert.equal(ann.scheduled('later').length, 0);

    await runCommand(ann.ctx, 'hangup');
    await until(() => inc.state === 'ended', 'ben to hear the hang-up');
    await until(() => benEvents.some((e) => e.t === 'end'), "ben's browser to be told");
  } finally {
    for (const e of streams) e.close();
    for (const a of [ann, ben]) { a.web && a.web.close(); await a.closeGracefully(); }
    await relay.stop();
  }
});

test('calls: a TURN server set on the relay reaches the call page', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true, turn: [{ urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' }] }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    await runCommand(ann.ctx, 'call ben');
    const page = await request(ann.web.url(`call/${ann.calls.current.id}`));
    assert.match(page.text, /"urls":"turn:turn\.example\.org:3478","username":"u","credential":"p"/);
    assert.match(page.text, /stun:stun\.l\.google\.com:19302/);
    await runCommand(ann.ctx, 'hangup');
  } finally {
    for (const a of [ann, ben]) { a.web && a.web.close(); await a.closeGracefully(); }
    await relay.stop();
  }
});

test('calls: decline, busy, and nobody outside your contacts can ring you', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  const cat = await person(relay, 'cat');
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    await runCommand(ben.ctx, 'add cat');
    await runCommand(cat.ctx, 'add ben');

    await runCommand(ann.ctx, 'call ben');
    await until(() => ben.calls.ringing, 'the ring');
    await runCommand(ben.ctx, 'decline');
    await until(() => !ann.calls.current, 'ann to hear');
    assert.ok(ann.notes.some((t) => /ben declined/.test(t)));

    await runCommand(cat.ctx, 'call ann'); // cat isn't in ann's contacts
    await until(() => ann.notes.some((t) => /cat tried to call you/.test(t)), 'the refusal');
    assert.equal(ann.calls.current, null);
    await until(() => !cat.calls.current, 'cat to hear');

    await runCommand(ann.ctx, 'call ben');
    await until(() => ben.calls.ringing, 'the second ring');
    await runCommand(cat.ctx, 'call ben'); // ben is busy
    await until(() => cat.notes.some((t) => /ben is on another call/.test(t)), 'busy');
    await assert.rejects(runCommand(ann.ctx, 'call ben'), /already in a call/);
    await runCommand(ann.ctx, 'hangup');
    await assert.rejects(runCommand(ann.ctx, 'call gamedev-not-a-person'), /no user/);
  } finally {
    for (const a of [ann, ben, cat]) { a.web && a.web.close(); await a.closeGracefully(); }
    await relay.stop();
  }
});

test('the local web server only answers this computer, with the secret', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  try {
    const { url } = await dashboard.open(ann);
    assert.equal((await request(url)).status, 200);
    const port = new URL(url).port;
    assert.equal((await request(url.replace(ann.web.token, 'guess'))).status, 404, 'wrong secret');
    assert.equal((await request(url, { host: `evil.example:${port}` })).status, 403, 'another site pointing its name at us');
    assert.equal((await request(ann.web.url('dashact'), { method: 'POST', body: { do: 'signout' }, origin: 'https://evil.example' })).status, 403, 'another site posting');
    assert.equal(ann.web.server.address().address, '127.0.0.1');
  } finally {
    ann.web.close();
    await ann.closeGracefully();
    await relay.stop();
  }
});

test('typing a shell command into the chat runs it there', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  try {
    const shown = [];
    ann.on('line', (i) => shown.push(i));
    await handleInput(ann.ctx, 'gossip whoami');
    assert.ok(shown.some((i) => i.t === 'rows' || (i.t === 'note' && /ann/.test(i.text))), '"gossip whoami" ran as /whoami');
    await handleInput(ann.ctx, 'gossip uninstall');
    assert.ok(ann.notes.some((t) => /Leave first/.test(t)), 'things that only work outside say so');
    ann.target = '@nobody';
    await handleInput(ann.ctx, 'gossip is great'); // not a command: an ordinary message
    assert.deepEqual(shown.filter((i) => i.t === 'msg').map((i) => i.msg.text), ['gossip is great']);
  } finally {
    await ann.closeGracefully();
    await relay.stop();
  }
});

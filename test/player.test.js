'use strict';
// The YouTube player and watching together, without a browser: the page's side
// is played by plain web requests to gossip's little local server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
process.env.GOSSIP_NO_BROWSER = '1';
process.env.GOSSIP_OFFLINE_TITLES = '1';
const { Relay } = require('../server/relay');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');
const { Player } = require('../src/player');
const { runCommand } = require('../src/commands');
const YT = require('../src/youtube');
const R = require('../src/render');
const A = require('../src/ansi');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-player-'));
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
  app.player = new Player(app);
  app.ctx = { app, shell: true, quit() {} };
  await app.connect();
  return app;
}

function request(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(url), { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Listen to the player page's event stream, like the browser does. */
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

test('youtube: every kind of link, and nothing that only looks like one', () => {
  const id = 'dQw4w9WgXcQ';
  for (const [link, start] of [
    [`https://www.youtube.com/watch?v=${id}`, 0],
    [`https://youtube.com/watch?v=${id}&t=90`, 90],
    [`https://m.youtube.com/watch?v=${id}&t=1m30s`, 90],
    [`https://music.youtube.com/watch?v=${id}`, 0],
    [`https://youtu.be/${id}?t=42`, 42],
    [`https://youtu.be/${id}?si=abc123`, 0],
    [`https://www.youtube.com/shorts/${id}`, 0],
    [`https://www.youtube.com/live/${id}?feature=share`, 0],
    [`https://www.youtube-nocookie.com/embed/${id}?start=5`, 5],
    [`https://youtu.be/${id}).`, 0],
  ]) {
    assert.deepEqual(YT.parse(link), { id, start }, link);
  }
  for (const bad of [
    'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@somechannel', 'javascript:alert(1)',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ"><script>', 'not a link',
  ]) assert.equal(YT.parse(bad), null, bad);
  assert.equal(YT.seconds('1:02:03'), 3723);
  assert.equal(YT.seconds('2:05'), 125);
  const found = YT.findAll(`look https://youtu.be/${id} and again https://www.youtube.com/watch?v=${id} and https://youtu.be/9bZkp7q19f0`);
  assert.deepEqual(found.map((x) => x.id), [id, '9bZkp7q19f0']);
  assert.equal(YT.link(id, 90.7), `https://youtu.be/${id}?t=90`);
});

test('a message with a YouTube link says how to play it here', () => {
  const msg = { id: 'x', from: 'maya', ts: Date.now(), text: 'this is so good https://youtu.be/dQw4w9WgXcQ' };
  const lines = R.messageLines('ann', '@maya', msg, 80).map(A.strip);
  assert.ok(lines.some((l) => /▶ YouTube video · \/yt plays it · \/watch to watch together/.test(l)), lines.join('\n'));
  assert.ok(lines.every((l) => A.vwidth(l) <= 80));
  const plain = R.messageLines('ann', '@maya', { ...msg, text: 'no video here https://example.com' }, 80).map(A.strip);
  assert.ok(!plain.some((l) => /YouTube/.test(l)));
});

test('watching together: one puts a video on, the other joins, play and pause travel both ways', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  const streams = [];
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    await runCommand(ann.ctx, 'to ben');
    await runCommand(ben.ctx, 'to ann');

    // ann: /watch <link> sends the link as a normal message and puts it on for everyone
    await runCommand(ann.ctx, 'watch https://youtu.be/dQw4w9WgXcQ?t=30');
    assert.ok(ann.player.together && ann.player.together.key === '@ben');
    await until(() => ben.vault.loadHistory('@ann', 5).some((r) => /Watch with me: https:\/\/youtu\.be\/dQw4w9WgXcQ\?t=30/.test(r.text || '')), 'the link to arrive');
    await until(() => ben.notes.some((t) => /ann wants to watch a YouTube video together/.test(t)), 'ben to hear ann is watching');
    assert.equal(ben.player.invites.get('@ann').v, 'dQw4w9WgXcQ');

    // ann's player page opens: it gets the video, and the page is the strict kind
    const page = await request(ann.player.web.url('player'));
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /frame-src https:\/\/www\.youtube-nocookie\.com/);
    assert.match(page.text, /gossip · player/);
    const annPage = events(ann.player.web.url('playerevents'));
    streams.push(annPage);
    await until(() => annPage.length, 'ann\'s page hello');
    assert.equal(annPage[0].t, 'hello');
    assert.deepEqual(annPage[0].load, { v: 'dQw4w9WgXcQ', start: 30, play: true });
    assert.equal(annPage[0].together.key, '@ben');
    const api = (who, body) => request(who.player.web.url('playerapi'), { method: 'POST', body }).then((r) => JSON.parse(r.text));
    await api(ann, { t: 'state', v: 'dQw4w9WgXcQ', at: 31, playing: true, title: 'A song', dur: 213, act: true });
    assert.match(ann.player.statusText(), /▶ 0:3\d \/ 3:33 · A song · waiting for ben to join/);

    // ben types /watch: he joins and catches up with where ann is
    await runCommand(ben.ctx, 'watch');
    await until(() => ben.player.lastRemote, 'ben to catch up');
    assert.equal(ben.player.lastRemote.v, 'dQw4w9WgXcQ');
    assert.equal(ben.player.lastRemote.playing, true);
    assert.ok(ben.player.lastRemote.at >= 31);
    await until(() => ann.player.watchers.has('ben'), 'ann to see ben');
    await until(() => annPage.some((e) => e.t === 'note' && /ben is watching with you/.test(e.text)), 'ann\'s page to say so');
    const benPage = events(ben.player.web.url('playerevents'));
    streams.push(benPage);
    await until(() => benPage.length, 'ben\'s page hello');
    assert.equal(benPage[0].remote.v, 'dQw4w9WgXcQ');

    // ben pauses: ann's page is told
    await api(ben, { t: 'state', v: 'dQw4w9WgXcQ', at: 40, playing: false, act: true });
    await until(() => annPage.some((e) => e.t === 'state' && e.from === 'ben' && e.playing === false), 'the pause to reach ann');
    const pause = annPage.find((e) => e.t === 'state' && e.from === 'ben');
    assert.equal(pause.at, 40);
    assert.equal(pause.lead, true);
    assert.equal(ann.player.leader, 'ben');

    // ann puts on another video: ben's page switches
    await api(ann, { t: 'state', v: '9bZkp7q19f0', at: 0, playing: true, act: true });
    await until(() => benPage.some((e) => e.t === 'state' && e.v === '9bZkp7q19f0'), 'the new video to reach ben');

    // the terminal can pause the page
    assert.ok(ann.player.control('pause'));
    await until(() => annPage.some((e) => e.t === 'control' && e.do === 'pause'), 'the pause from the terminal');
    await runCommand(ann.ctx, 'yt +30');
    await until(() => annPage.some((e) => e.t === 'control' && e.do === 'jump' && e.by === 30), 'the jump from the terminal');

    // the videos list, and sending a link from the page
    const vids = await api(ann, { t: 'videos' });
    assert.equal(vids.videos[0].id, 'dQw4w9WgXcQ');
    assert.equal(vids.videos[0].label, 'ben');
    assert.equal((await api(ann, { t: 'resolve', text: 'https://youtu.be/9bZkp7q19f0?t=5' })).start, 5);
    assert.equal((await api(ann, { t: 'resolve', text: 'cats' })).ok, false);
    await api(ann, { t: 'share', key: '@ben', v: '9bZkp7q19f0', start: 12 });
    await until(() => ben.vault.loadHistory('@ann', 5).some((r) => r.text === '▶ https://youtu.be/9bZkp7q19f0?t=12'), 'the shared link');

    // ann stops: ben hears it
    await runCommand(ann.ctx, 'watch stop');
    assert.equal(ann.player.together, null);
    await until(() => !ben.player.watchers.has('ann'), 'ben to see ann leave');

    // play, pause and jumps were never saved as messages
    const saved = ben.vault.loadHistory('@ann', 50).filter((r) => typeof r.text === 'string');
    assert.equal(saved.length, 2);
  } finally {
    for (const s of streams) s.close();
    ann.close();
    ben.close();
    await relay.stop();
  }
});

test('watch news only goes to the people watching', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const ann = await person(relay, 'ann');
  const ben = await person(relay, 'ben');
  try {
    await runCommand(ann.ctx, 'add ben');
    await runCommand(ben.ctx, 'add ann');
    assert.equal(await ann.watchSignal('@ben', { t: 'tick', v: 'dQw4w9WgXcQ', at: 1, playing: true }, new Set(['someone-else'])), false);
    let heard = 0;
    ben.on('watch', () => { heard++; });
    assert.equal(await ann.watchSignal('@ben', { t: 'tick', v: 'dQw4w9WgXcQ', at: 1, playing: true }, new Set(['ben'])), true);
    await until(() => heard === 1, 'the tick');
    // and a stranger's videos can't be forced on anyone not watching
    await ann.watchSignal('@ben', { t: 'state', v: 'dQw4w9WgXcQ', at: 1, playing: true, act: 1 });
    await sleep(150);
    assert.equal(ben.player.lastRemote, null);
  } finally {
    ann.close();
    ben.close();
    await relay.stop();
  }
});

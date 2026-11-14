'use strict';
// Files and photos: reading pictures, thumbnails, and real transfers through a
// relay and through the gossip website.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const F = require('../src/files');
const A = require('../src/ansi');
const prefs = require('../src/prefs');
const { Relay } = require('../server/relay');
const { App } = require('../src/app');
const { Vault } = require('../src/vault');
const { runCommand, handleInput } = require('../src/commands');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const dirs = [];
const procs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-files-'));
  dirs.push(d);
  return d;
}
test.after(() => {
  for (const p of procs) p.kill();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A real PNG file: a red-to-blue gradient with a green square in the middle. */
function makePng(w, h, { alpha = false } = {}) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc(h * (w * ch + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = y % 5; // use every filter type
    for (let x = 0; x < w; x++) {
      const o = y * (w * ch + 1) + 1 + x * ch;
      const mid = Math.abs(x - w / 2) < w / 6 && Math.abs(y - h / 2) < h / 6;
      raw[o] = mid ? 0 : Math.round((255 * x) / w);
      raw[o + 1] = mid ? 255 : 0;
      raw[o + 2] = mid ? 0 : 255 - Math.round((255 * x) / w);
      if (alpha) raw[o + 3] = 255;
    }
  }
  // apply the filters the way an encoder would, so decoding has real work to do
  const stride = w * ch;
  const out = Buffer.alloc(raw.length);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    out[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= ch ? raw[y * (stride + 1) + 1 + x - ch] : 0;
      const b = y ? raw[(y - 1) * (stride + 1) + 1 + x] : 0;
      const c = x >= ch && y ? raw[(y - 1) * (stride + 1) + 1 + x - ch] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * (stride + 1) + 1 + x] = (cur - pred) & 255;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(Buffer.concat([Buffer.from(type), body])) >>> 0 : 0);
    return Buffer.concat([len, Buffer.from(type), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}

test('pictures: PNGs are read without help, and shrink into a thumbnail', () => {
  for (const alpha of [false, true]) {
    const img = F.decodePng(makePng(30, 20, { alpha }));
    assert.equal(img.w, 30);
    assert.equal(img.h, 20);
    const px = (x, y) => Array.from(img.rgba.subarray((y * 30 + x) * 4, (y * 30 + x) * 4 + 3));
    assert.deepEqual(px(15, 10), [0, 255, 0], 'the green square');
    assert.deepEqual(px(0, 0), [0, 0, 255], 'the blue edge');
  }
  const file = path.join(tmp(), 'big.png');
  fs.writeFileSync(file, makePng(400, 200));
  const t = F.thumbnail(file, fs.readFileSync(file));
  assert.equal(t.w, 40);
  assert.equal(t.h, 20);
  assert.ok(F.validPreview(t));
  const before = A.getLevel();
  A.setLevel(3);
  try {
    const lines = F.previewLines(t, 30);
    assert.equal(lines.length, 8, '30 columns wide -> 15 pixels tall -> 8 lines');
    assert.equal(A.vwidth(lines[0]), 30);
  } finally {
    A.setLevel(before);
  }
  assert.equal(F.decodePng(Buffer.from('not a picture')), null);
});

test('files: names are made safe, and dragged-in paths are recognised', () => {
  assert.equal(F.safeName('../../etc/passwd'), '.._.._etc_passwd'.replace(/^\.+/, ''));
  assert.equal(F.safeName('.hidden'), 'hidden');
  assert.equal(F.safeName('CON'), 'file-CON');
  assert.equal(F.safeName('a‮exe.txt'), 'a_exe.txt');
  const dir = tmp();
  const file = path.join(dir, 'my photo.png');
  fs.writeFileSync(file, 'x');
  assert.equal(F.asPath(file), file);
  if (process.platform !== 'win32') assert.equal(F.asPath(file.replace(/ /g, '\\ ') + ' '), file, 'Terminal-style escaped spaces');
  assert.equal(F.asPath(`'${file}'`), file, 'quoted');
  assert.equal(F.asPath('file://' + encodeURI(file)), file);
  assert.equal(F.asPath(dir), null, 'a folder is not a file');
  assert.equal(F.asPath('hello there'), null);
  assert.equal(F.asPath('/no/such/file.png'), null);
});

async function pair(serverUrl) {
  const received = path.join(tmp(), 'received'); // (both people share this test's process, and so its settings)
  const mk = async (name) => {
    const dir = tmp();
    await new App({ vault: new Vault(dir), server: serverUrl }).register(name);
    const app = new App({ vault: new Vault(dir), server: serverUrl, shell: true });
    prefs.set(app.vault, 'files', received);
    app.settings = app.vault.loadSettings();
    app.notes = [];
    app.shown = [];
    app.on('line', (i) => { app.shown.push(i); if (i.t === 'note') app.notes.push(i.text); });
    app.ctx = { app, shell: true, quit() {} };
    await app.connect();
    return app;
  };
  const ann = await mk('ann');
  const ben = await mk('ben');
  await runCommand(ann.ctx, 'add ben');
  await runCommand(ben.ctx, 'add ann');
  return { ann, ben };
}

async function transfer(ann, ben) {
  // a photo, dragged in
  const pic = path.join(tmp(), 'holiday photo.png');
  fs.writeFileSync(pic, makePng(64, 48));
  ann.target = '@ben';
  await handleInput(ann.ctx, pic.replace(/ /g, '\\ '));
  await until(() => ben.notes.some((t) => /ann sent holiday photo\.png/.test(t)), 'the photo');
  const got = ben.shown.find((i) => i.t === 'msg' && i.msg.file && i.msg.file.name === 'holiday photo.png');
  assert.ok(got.msg.file.preview, 'a thumbnail came with it');
  const saved = ben.vault.loadHistory('@ann').find((r) => r.file && r.file.name === 'holiday photo.png').file;
  assert.equal(saved.state, 'saved');
  assert.deepEqual(fs.readFileSync(saved.path), fs.readFileSync(pic), 'the very same bytes');

  // a bigger file, in many pieces
  const big = path.join(tmp(), 'notes.bin');
  fs.writeFileSync(big, crypto.randomBytes(F.CHUNK * 4 + 1234));
  await runCommand(ann.ctx, `file ${big}`);
  await until(() => ben.notes.some((t) => /ann sent notes\.bin/.test(t)), 'the big file', 30000);
  const rec = ben.vault.loadHistory('@ann').find((r) => r.file && r.file.name === 'notes.bin').file;
  assert.deepEqual(fs.readFileSync(rec.path), fs.readFileSync(big));
  assert.equal(ann.vault.loadHistory('@ben').find((r) => r.file && r.file.name === 'notes.bin').file.state, 'sent');

  // the same name again doesn't overwrite
  await runCommand(ann.ctx, `file ${big}`);
  await until(() => ben.notes.filter((t) => /ann sent notes\.bin/.test(t)).length === 2, 'the second copy', 30000);
  const names = fs.readdirSync(path.dirname(rec.path)).sort();
  assert.deepEqual(names, ['holiday photo.png', 'notes (2).bin', 'notes.bin']);

  // and too big is refused before anything is sent
  const huge = path.join(tmp(), 'huge.bin');
  fs.writeFileSync(huge, Buffer.alloc(F.MAX + 1));
  await assert.rejects(runCommand(ann.ctx, `file ${huge}`), /the limit is 10\.0 MB/);
  ben.shown.length = 0;
  await runCommand(ben.ctx, 'to ann').catch(() => { ben.target = '@ann'; });
  ben.target = '@ann';
  await runCommand(ben.ctx, 'files');
  assert.ok(ben.shown.some((i) => i.t === 'rows' && JSON.stringify(i.rows).includes('holiday photo.png')));
}

test('files: a photo and a big file arrive intact through a relay', async () => {
  const relay = await new Relay({ port: 0, dataDir: tmp(), quiet: true }).start();
  const { ann, ben } = await pair(`ws://127.0.0.1:${relay.port}`);
  try {
    await transfer(ann, ben);
  } finally {
    await ann.closeGracefully();
    await ben.closeGracefully();
    await relay.stop();
  }
});

const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
test('files: the same through the gossip website, including a backlog bigger than one reply', { skip: !PY && 'no python3' }, async () => {
  const hub = await new Promise((resolve, reject) => {
    const child = spawn(PY, [path.join(__dirname, '..', 'hub', 'gossip_hub.py'), '--port', '0', '--host', '127.0.0.1', '--data', tmp(), '--quiet'], {
      env: { ...process.env, GOSSIP_PURE_CRYPTO: '1', PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    child.on('exit', (code) => reject(new Error(`hub exited ${code}`)));
  });
  const { ann, ben } = await pair(hub);
  try {
    await transfer(ann, ben);
    // ben is away while a 2 MB file arrives; it all comes through when he's back
    await ben.closeGracefully();
    const big = path.join(tmp(), 'while-away.bin');
    fs.writeFileSync(big, crypto.randomBytes(2 * 1024 * 1024));
    ann.target = '@ben';
    await runCommand(ann.ctx, `file ${big}`);
    const back = new App({ vault: new Vault(ben.vault.dir), server: hub, shell: true });
    back.notes = [];
    back.on('line', (i) => { if (i.t === 'note') back.notes.push(i.text); });
    await back.connect();
    await until(() => back.notes.some((t) => /ann sent while-away\.bin/.test(t)), 'the file sent while away', 30000);
    const rec = back.vault.loadHistory('@ann').find((r) => r.file && r.file.name === 'while-away.bin').file;
    assert.deepEqual(fs.readFileSync(rec.path), fs.readFileSync(big));
    await back.closeGracefully();
  } finally {
    await ann.closeGracefully();
    await ben.closeGracefully();
  }
});

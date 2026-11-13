'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const U = require('../src/update');

const REPO = path.join(__dirname, '..');
const hasTar = spawnSync('tar', ['--version']).status === 0;
const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-update-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function copyApp(dest, version) {
  fs.cpSync(REPO, dest, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|docs)([\\/]|$)/.test(src) });
  if (version) {
    const file = path.join(dest, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  }
}

/** A pretend GitHub: serves the "latest" package.json and its tarball. */
async function release(version) {
  const stage = tmp();
  copyApp(path.join(stage, 'gossip-main'), version);
  const tarball = path.join(stage, 'app.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', stage, 'gossip-main']).status, 0);
  const server = http.createServer((req, res) => {
    if (req.url === '/package.json') return res.end(fs.readFileSync(path.join(stage, 'gossip-main', 'package.json')));
    if (req.url === '/app.tar.gz') return res.end(fs.readFileSync(tarball));
    res.statusCode = 404;
    return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// (async on purpose: the pretend GitHub lives in this process and must be free to answer)
function gossip(root, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'app', 'bin', 'gossip.js'), ...args], {
      env: { ...process.env, GOSSIP_HOME: path.join(root, 'home'), NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('update: version numbers compare the way people expect', () => {
  assert.equal(U.newer('0.2.0', '0.1.9'), true);
  assert.equal(U.newer('0.10.0', '0.9.3'), true);
  assert.equal(U.newer('1.0.0', '1.0.0'), false);
  assert.equal(U.newer('0.1.0', '0.2.0'), false);
});

test('update: unpacking never writes outside its folder', () => {
  const entry = (name, body) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0', 257);
    const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    data.write(body);
    return Buffer.concat([h, data]);
  };
  const dest = path.join(tmp(), 'out');
  fs.mkdirSync(dest);
  U.untar(Buffer.concat([entry('top/ok.txt', 'fine'), entry('top/../../evil.txt', 'nope'), entry('top/sub/deep.txt', 'deep'), Buffer.alloc(1024)]), dest);
  assert.equal(fs.readFileSync(path.join(dest, 'ok.txt'), 'utf8'), 'fine');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'deep.txt'), 'utf8'), 'deep');
  assert.equal(fs.existsSync(path.join(dest, '..', 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(dest, '..', '..', 'evil.txt')), false);
});

test('update: reads the kind of archive GitHub hands out', { skip: !fs.existsSync(path.join(REPO, '.git')) && 'not a git checkout' }, () => {
  const r = spawnSync('git', ['-C', REPO, 'archive', '--format=tar.gz', '--prefix=gossip-main/', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return;
  const dest = path.join(tmp(), 'out');
  fs.mkdirSync(dest);
  U.untar(zlib.gunzipSync(r.stdout), dest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).name, 'gossip-chat');
  assert.ok(fs.existsSync(path.join(dest, 'bin', 'gossip.js')));
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(dest, 'install.sh')).mode & 0o100, 'scripts stay runnable');
});

test('update: `gossip update` fetches a newer version and the next start uses it', { skip: !hasTar && 'no tar here' }, async () => {
  const root = tmp();
  copyApp(path.join(root, 'app'));
  const have = U.currentVersion();
  const site = await release('9.9.9');
  try {
    assert.match((await gossip(root, ['--version'])).stdout, new RegExp(`gossip ${have.replace(/\./g, '\\.')}`));
    const up = await gossip(root, ['update'], { GOSSIP_UPDATE_BASE: site.base });
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /v9\.9\.9 is downloaded and checked/);
    assert.equal(fs.readFileSync(path.join(root, 'app.next', '.ready'), 'utf8'), '9.9.9');

    assert.match((await gossip(root, ['--version'])).stdout, /gossip 9\.9\.9/, 'the next start runs the new version');
    assert.equal(fs.existsSync(path.join(root, 'app.next')), false);
    assert.equal(fs.existsSync(path.join(root, 'app.old')), false);
    assert.match((await gossip(root, ['update'], { GOSSIP_UPDATE_BASE: site.base })).stdout, /You have the newest gossip \(v9\.9\.9\)/);
  } finally {
    site.close();
  }
});

test('update: the quiet background check stages a new version, and "off" means off', { skip: !hasTar && 'no tar here' }, async () => {
  const root = tmp();
  copyApp(path.join(root, 'app'));
  const site = await release('9.9.9');
  try {
    const r = await gossip(root, ['__update', 'notify'], { GOSSIP_UPDATE_BASE: site.base });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(root, 'app.next')), false, '"notify" only takes note');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'update.json'), 'utf8')).available, '9.9.9');

    fs.rmSync(path.join(root, 'update.json'));
    assert.equal((await gossip(root, ['__update', 'auto'], { GOSSIP_UPDATE_BASE: site.base })).status, 0);
    assert.equal(fs.readFileSync(path.join(root, 'app.next', '.ready'), 'utf8'), '9.9.9');
    // checked a moment ago: doesn't ask again
    fs.rmSync(path.join(root, 'app.next'), { recursive: true });
    await gossip(root, ['__update', 'auto'], { GOSSIP_UPDATE_BASE: site.base });
    assert.equal(fs.existsSync(path.join(root, 'app.next')), false);
  } finally {
    site.close();
  }
});

test('update: a broken download changes nothing', { skip: !hasTar && 'no tar here' }, async () => {
  const root = tmp();
  copyApp(path.join(root, 'app'));
  const server = http.createServer((req, res) => {
    if (req.url === '/package.json') return res.end(JSON.stringify({ name: 'gossip-chat', version: '9.9.9' }));
    return res.end('this is not an archive');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await gossip(root, ['update'], { GOSSIP_UPDATE_BASE: `http://127.0.0.1:${server.address().port}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Couldn't update/);
    assert.equal(fs.existsSync(path.join(root, 'app.next')), false);
    assert.match((await gossip(root, ['--version'])).stdout, new RegExp(`gossip ${U.currentVersion().replace(/\./g, '\\.')}`));
  } finally {
    server.close();
  }
});

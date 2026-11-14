'use strict';
// Sending files, and showing photos right in the terminal.
//
// A file travels as one small "here comes a file" message (name, size, a
// fingerprint of the contents, and for pictures a tiny thumbnail), followed by
// the file itself in pieces. Every piece is end-to-end encrypted exactly like a
// message. The receiver checks the fingerprint before saving anything, so a
// file can't be swapped or damaged on the way.
//
// The thumbnail is made by the sender, so the receiver never has to open an
// image to show it - it's just a grid of colours, drawn the same way as Pebble.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const A = require('./ansi');

const MAX = 10 * 1024 * 1024; // biggest file: 10 MB
const CHUNK = 120 * 1024; // bytes per piece (fits in one relay frame once encrypted, even for a big server)
const THUMB = 40; // thumbnails are at most 40 x 40 pixels (40 columns x 20 lines in the terminal)
const RISKY = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|app|command|sh|bash|zsh|py|pkg|dmg|deb|rpm|apk|lnk|reg|workflow)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;

const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** A name that's safe to save under: no folders, no hidden files, nothing strange. */
function safeName(name) {
  let s = String(name || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*‎‏‪-‮⁦-⁩]/g, '_').trim();
  s = s.replace(/^\.+/, '').slice(-120);
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = 'file' + (s ? '-' + s : '');
  return s;
}

/**
 * What someone typed or dragged in, as a file path - or null if it isn't one.
 * Dragging a file into most terminals types its path, with spaces escaped
 * ("my\ photo.png") or the whole thing in quotes.
 */
function asPath(text) {
  let s = String(text || '').trim();
  if (!s || s.includes('\n') || s.length > 1024) return null;
  if (/^(['"]).*\1$/.test(s)) s = s.slice(1, -1);
  else if (process.platform !== 'win32') s = s.replace(/\\(.)/g, '$1');
  if (s.startsWith('file://')) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch { return null; }
  }
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  if (!path.isAbsolute(s)) return null;
  try {
    return fs.statSync(s).isFile() ? s : null;
  } catch {
    return null;
  }
}

/** Read a file to send. Throws a friendly Error if it can't be sent. */
function prepare(file) {
  const abs = path.resolve(String(file).replace(/^~(?=$|[\\/])/, os.homedir()));
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`There's no file at ${abs}`);
  }
  if (!st.isFile()) throw new Error(`${abs} is a folder, not a file`);
  if (st.size === 0) throw new Error(`${path.basename(abs)} is empty`);
  if (st.size > MAX) throw new Error(`${path.basename(abs)} is ${sizeText(st.size)} - the limit is ${sizeText(MAX)}`);
  const data = fs.readFileSync(abs);
  const name = safeName(path.basename(abs));
  return {
    path: abs, name, size: data.length, data,
    sha: crypto.createHash('sha256').update(data).digest('hex'),
    chunks: Math.ceil(data.length / CHUNK),
    preview: IMAGE.test(name) ? thumbnail(abs, data) : null,
  };
}

// ── pictures ────────────────────────────────────────────────────────────────

/** Decode a PNG (the format of every screenshot) without any extra software. */
function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
  }
  if (!w || !h || w * h > 40e6 || interlace || ![8, 16].includes(depth) && !(type === 3 && depth <= 8)) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) return null;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bitsPP = channels * depth;
  const bpp = Math.max(1, bitsPP >> 3); // bytes per pixel, for the filters
  const stride = Math.ceil((w * bitsPP) / 8);
  if (raw.length < h * (stride + 1)) return null;
  const rows = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0;
      const b = y ? rows[dst - stride + x] : 0;
      const c = x >= bpp && y ? rows[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[dst + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  const sample = (y, i) => { // the i-th sample of row y, as 0-255
    if (depth === 16) return rows[y * stride + i * 2];
    if (depth === 8) return rows[y * stride + i];
    const per = 8 / depth;
    const byte = rows[y * stride + Math.floor(i / per)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (type === 3) {
        const idx = sample(y, x);
        rgba[o] = palette ? palette[idx * 3] : 0;
        rgba[o + 1] = palette ? palette[idx * 3 + 1] : 0;
        rgba[o + 2] = palette ? palette[idx * 3 + 2] : 0;
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else {
        const s = (i) => sample(y, x * channels + i);
        const g = type === 0 || type === 4;
        rgba[o] = s(0);
        rgba[o + 1] = g ? s(0) : s(1);
        rgba[o + 2] = g ? s(0) : s(2);
        rgba[o + 3] = type === 4 ? s(1) : type === 6 ? s(3) : 255;
      }
    }
  }
  return { w, h, rgba };
}

/** Other formats (photos, iPhone HEIC...): ask a tool the computer already has to make a small PNG. */
function convertToPng(file) {
  const out = path.join(os.tmpdir(), `gossip-thumb-${process.pid}-${Date.now()}.png`);
  const tries = process.platform === 'darwin'
    ? [['sips', ['-s', 'format', 'png', '-Z', '160', file, '--out', out]]]
    : [['magick', [file + '[0]', '-thumbnail', '160x160', 'png:' + out]], ['convert', [file + '[0]', '-thumbnail', '160x160', 'png:' + out]],
      ['ffmpeg', ['-v', 'quiet', '-y', '-i', file, '-vf', 'scale=160:-1', '-frames:v', '1', out]]];
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile($args[0]); $s=[Math]::Min(1,160/[Math]::Max($i.Width,$i.Height)); $b=New-Object System.Drawing.Bitmap $i,([int]($i.Width*$s)),([int]($i.Height*$s)); $b.Save($args[1],[System.Drawing.Imaging.ImageFormat]::Png)`;
    tries.unshift(['powershell', ['-NoProfile', '-Command', ps, file, out]]);
  }
  for (const [cmd, args] of tries) {
    try {
      const r = spawnSync(cmd, args, { timeout: 15000, stdio: 'ignore', windowsHide: true });
      if (r.status === 0 && fs.existsSync(out)) {
        const png = fs.readFileSync(out);
        fs.rmSync(out, { force: true });
        return png;
      }
    } catch { /* that tool isn't here */ }
  }
  fs.rmSync(out, { force: true });
  return null;
}

/** A small picture to show in the chat: { w, h, px: base64 RGB }. Null if it can't be made. */
function thumbnail(file, data) {
  try {
    const img = decodePng(data) || decodePng(convertToPng(file) || Buffer.alloc(0));
    if (!img) return null;
    const scale = Math.min(1, THUMB / Math.max(img.w, img.h));
    const tw = Math.max(1, Math.round(img.w * scale));
    const th = Math.max(1, Math.round(img.h * scale));
    const px = Buffer.alloc(tw * th * 3);
    // average every source pixel that falls into each thumbnail pixel
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor((tx * img.w) / tw);
        const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.w) / tw));
        const y0 = Math.floor((ty * img.h) / th);
        const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.h) / th));
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        const step = Math.max(1, Math.floor((x1 - x0) / 6));
        for (let y = y0; y < y1; y += step) {
          for (let x = x0; x < x1; x += step) {
            const o = (y * img.w + x) * 4;
            const a = img.rgba[o + 3] / 255; // see-through parts show as dark grey
            r += img.rgba[o] * a + 24 * (1 - a);
            g += img.rgba[o + 1] * a + 26 * (1 - a);
            b += img.rgba[o + 2] * a + 32 * (1 - a);
            n++;
          }
        }
        const o = (ty * tw + tx) * 3;
        px[o] = r / n;
        px[o + 1] = g / n;
        px[o + 2] = b / n;
      }
    }
    return { w: tw, h: th, px: px.toString('base64') };
  } catch {
    return null;
  }
}

function validPreview(p) {
  if (!p || typeof p !== 'object' || !Number.isInteger(p.w) || !Number.isInteger(p.h)) return false;
  if (p.w < 1 || p.h < 1 || p.w > 64 || p.h > 64 || typeof p.px !== 'string') return false;
  return Buffer.from(p.px, 'base64').length === p.w * p.h * 3;
}

/** The thumbnail as lines of terminal text, at most `cols` wide. Two pixels per character, top and bottom. */
function previewLines(p, cols) {
  if (!validPreview(p) || A.getLevel() < 2) return [];
  const px = Buffer.from(p.px, 'base64');
  const scale = Math.min(1, cols / p.w);
  const w = Math.max(1, Math.floor(p.w * scale));
  const h = Math.max(2, Math.floor(p.h * scale));
  const at = (x, y) => {
    const sx = Math.min(p.w - 1, Math.floor(x / scale));
    const sy = Math.min(p.h - 1, Math.floor(y / scale));
    const o = (sy * p.w + sx) * 3;
    return [px[o], px[o + 1], px[o + 2]];
  };
  const lines = [];
  for (let y = 0; y < h; y += 2) {
    let line = '';
    for (let x = 0; x < w; x++) {
      const top = at(x, y);
      line += y + 1 < h ? A.paint('▀', { fg: top, bg: at(x, y + 1) }) : A.paint('▀', { fg: top });
    }
    lines.push(line);
  }
  return lines;
}

// ── receiving ───────────────────────────────────────────────────────────────

function validMeta(f) {
  return !!f && typeof f === 'object' && typeof f.name === 'string' && f.name.length <= 200 && Number.isSafeInteger(f.size) &&
    f.size > 0 && f.size <= MAX && f.chunks === Math.ceil(f.size / CHUNK) && /^[0-9a-f]{64}$/.test(f.sha) &&
    (f.preview == null || validPreview(f.preview));
}

/** Where received files go: the files setting, or ~/Downloads/gossip, or the gossip folder. */
function saveDir(home, setting) {
  if (setting) return path.resolve(setting.replace(/^~(?=$|[\\/])/, os.homedir()));
  const dl = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(dl) ? path.join(dl, 'gossip') : path.join(home, 'files');
}

/** Pieces arriving for one file. The state lives on disk, so a transfer survives closing gossip. */
class Incoming {
  constructor(dir, from, id) {
    this.base = path.join(dir, `${from}-${id}`.replace(/[^A-Za-z0-9_-]/g, '_'));
    this.state = null;
  }

  static start(dir, from, id, meta, key) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const inc = new Incoming(dir, from, id);
    inc.state = { from, id, key, meta, got: [] };
    fs.writeFileSync(inc.base + '.part', Buffer.alloc(0), { mode: 0o600 });
    inc._save();
    return inc;
  }

  load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.base + '.json', 'utf8'));
    } catch {
      this.state = null;
    }
    return this.state;
  }

  _save() {
    fs.writeFileSync(this.base + '.json', JSON.stringify(this.state), { mode: 0o600 });
  }

  /** Store piece i. Returns true once every piece is here. */
  add(i, data) {
    const { meta } = this.state;
    if (!Number.isInteger(i) || i < 0 || i >= meta.chunks || this.state.got.includes(i)) return this.done;
    const expect = i === meta.chunks - 1 ? meta.size - CHUNK * i : CHUNK;
    if (data.length !== expect) throw new Error('a piece of the file was the wrong size');
    const fd = fs.openSync(this.base + '.part', 'r+');
    try {
      fs.writeSync(fd, data, 0, data.length, i * CHUNK);
    } finally {
      fs.closeSync(fd);
    }
    this.state.got.push(i);
    this._save();
    return this.done;
  }

  get done() {
    return !!this.state && this.state.got.length === this.state.meta.chunks;
  }

  get progress() {
    return this.state ? this.state.got.length / this.state.meta.chunks : 0;
  }

  /** Check the fingerprint and move the file into the save folder. Returns where it went. */
  finish(dest) {
    const data = fs.readFileSync(this.base + '.part');
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    if (sha !== this.state.meta.sha) {
      this.discard();
      throw new Error("the file didn't arrive intact, so it wasn't saved");
    }
    fs.mkdirSync(dest, { recursive: true });
    const name = safeName(this.state.meta.name);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let target = path.join(dest, name);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dest, `${stem} (${n})${ext}`);
    fs.writeFileSync(target, data, { mode: 0o644 });
    this.discard();
    return target;
  }

  discard() {
    fs.rmSync(this.base + '.part', { force: true });
    fs.rmSync(this.base + '.json', { force: true });
  }
}

module.exports = { MAX, CHUNK, RISKY, sizeText, safeName, asPath, prepare, decodePng, thumbnail, validPreview, previewLines, validMeta, saveDir, Incoming };

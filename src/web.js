'use strict';
// gossip's little web server, for the things a terminal can't do: calls (your
// browser has the microphone and camera) and the dashboard.
//
// It only listens on this computer (127.0.0.1), every address carries a random
// secret, and requests from anywhere else are refused - so web pages you visit
// can't reach it, and nor can anyone on your network.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Th = require('./theme');
const M = require('./mascot');
const prefs = require('./prefs');

const PAGES = path.join(__dirname, 'web');

class Web {
  constructor(app) {
    this.app = app;
    this.token = crypto.randomBytes(18).toString('base64url');
    this.server = null;
    this.port = 0;
    this.routes = new Map(); // 'GET call' -> fn(req, res, rest)
    this._starting = null;
  }

  /** Start listening (once). Resolves with the port. */
  start() {
    if (this._starting) return this._starting;
    this._starting = (async () => {
      // The same port every time, when it's free: browsers remember "allow
      // microphone" per address, so you aren't asked again on every call.
      const remembered = Number(this.app.settings.webPort) || 0;
      for (const port of [remembered, 0]) {
        try {
          await this._listen(port);
          break;
        } catch (e) {
          if (port === 0) throw e;
        }
      }
      if (this.port !== remembered) {
        try {
          this.app.settings = this.app.vault.updateSettings((s) => { s.webPort = this.port; });
        } catch { /* fine */ }
      }
      return this.port;
    })();
    return this._starting;
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.unref(); // never keeps gossip running on its own
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    });
  }

  url(rest) {
    return `http://127.0.0.1:${this.port}/${this.token}/${rest}`;
  }

  on(method, name, fn) {
    this.routes.set(`${method} ${name}`, fn);
  }

  close() {
    if (this.server) this.server.close();
    this.server = null;
  }

  _handle(req, res) {
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; frame-ancestors 'none'",
      });
      res.end(body);
    };
    // Only this computer, only our own address (this blocks "DNS rebinding" tricks).
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(403, 'no\n');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(403, 'no\n');
    const parts = String(req.url || '').split('?')[0].split('/').filter(Boolean);
    if (parts[0] !== this.token) return send(404, 'not found\n');
    const fn = this.routes.get(`${req.method} ${parts[1]}`);
    if (!fn) return send(404, 'not found\n');
    if (req.method !== 'POST') return Promise.resolve(fn(req, res, parts.slice(2), send)).catch(() => send(500, 'error\n'));
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) req.destroy();
    });
    req.on('end', () => {
      let data = null;
      try {
        data = JSON.parse(body);
      } catch {
        return send(400, 'bad request\n');
      }
      return Promise.resolve(fn(req, res, parts.slice(2), send, data)).catch(() => send(500, 'error\n'));
    });
    return undefined;
  }

  /** A page from src/web, with the user's colours and Pebble dropped in. */
  page(name, config) {
    const html = fs.readFileSync(path.join(PAGES, name), 'utf8');
    return html
      .replace('/*__THEME__*/', () => themeCss())
      .replace('__CONFIG__', () => JSON.stringify({ ...config, pixels: M.pixels() }).replace(/</g, '\\u003c'));
  }
}

/** The chosen colour theme as CSS variables (the terminal-only themes borrow arctic's). */
function themeCss() {
  let t = Th.THEMES[prefs.val('theme')] || Th.THEMES.arctic;
  if (!t.accent || !/^#/.test(String(t.accent.fg))) t = Th.THEMES.arctic;
  const light = prefs.val('theme') === 'daylight';
  const v = {
    bg: light ? '#f7f5f0' : '#0f131c', panel: light ? '#ffffff' : '#141a26', fg: light ? '#1c2230' : '#e8edf5',
    accent: t.accent.fg, accent2: t.accent2.fg, border: t.border.fg, dim: t.dim.fg,
    ok: t.ok.fg, warn: t.warn.fg, err: t.err.fg, server: t.server.fg, link: (t.link || t.accent).fg,
  };
  for (const [part, value] of Object.entries(prefs.family('color.'))) {
    if (v[part] && /^#[0-9a-f]{6}$/i.test(value)) v[part] = value;
  }
  return ':root{' + Object.entries(v).map(([k, x]) => `--${k}:${x}`).join(';') + ';--names:' + (t.names || []).join(' ') + '}';
}

/** Open an address in the person's web browser. Returns false if we couldn't. */
function openBrowser(url) {
  if (process.env.GOSSIP_NO_BROWSER === '1') return false;
  let cmd;
  if (process.platform === 'darwin') cmd = ['open', [url]];
  else if (process.platform === 'win32') cmd = ['rundll32', ['url.dll,FileProtocolHandler', url]];
  else cmd = ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { Web, openBrowser, themeCss };

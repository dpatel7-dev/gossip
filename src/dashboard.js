'use strict';
// The dashboard: a page in your browser showing everything gossip is connected
// to, who can read what, and anything that looks wrong. `/dashboard` opens it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const e2e = require('./e2e');
const prefs = require('./prefs');
const U = require('./update');
const pkg = require('../package.json');
const { Web, openBrowser } = require('./web');
const { STUN } = require('./call');

const cache = new Map(); // key -> { at, value }
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const isLocal = (url) => /^(ws|http)s?:\/\/(localhost|127\.|\[::1\])/i.test(url || '');

/** The same checks as `gossip security`, as data. */
function checks(app) {
  const url = app.serverUrl || '';
  const encrypted = /^(wss|https):/i.test(url) || isLocal(url) || !!app.via;
  const changed = app.peers.values().filter((p) => p.name !== app.me && p.changed);
  const unverified = app.contacts().filter((p) => !p.verified && !p.changed);
  const out = [{ ok: true, text: 'Messages are end-to-end encrypted: only the people in a chat can read them.' }];
  if (!url) out.push({ ok: false, text: 'Not connected to anything yet.' });
  else if (app.via) out.push({ ok: true, text: 'Nearby mode: messages stay on your local network.' });
  else if (isLocal(url)) out.push({ ok: true, text: 'The relay is on this computer, so nothing travels over a network.' });
  else if (encrypted) out.push({ ok: true, text: `The connection to ${hostOf(url)} is encrypted too.` });
  else out.push({ ok: false, text: `The connection to ${hostOf(url)} is not encrypted. Nobody can read messages, but someone on your network could see who you talk to. Fix: /config security strict and use an https:// or wss:// address.` });
  out.push(changed.length
    ? { ok: false, text: `Security key changed for ${changed.map((p) => p.name).join(', ')}. Messages to them are on hold until you check: /verify ${changed[0].name}` }
    : { ok: true, text: "Nobody's security key has changed unexpectedly." });
  out.push(app.otherSessions
    ? { ok: false, text: `Your account is open in ${app.otherSessions + 1} places. If one isn't you: /signout` }
    : { ok: true, text: 'Your account is only open here.' });
  if (prefs.val('security') === 'strict') out.push({ ok: true, text: 'Strict mode: unencrypted connections are refused.' });
  if (unverified.length) out.push({ ok: null, text: `${unverified.length} contact${unverified.length === 1 ? '' : 's'} not verified yet (${unverified.slice(0, 4).map((p) => p.name).join(', ')}). Compare safety numbers on a call or in person: /verify ${unverified[0].name}` });
  return out;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function personOf(app, name) {
  const p = app.peers.get(name);
  return {
    name, you: name === app.me,
    fp: name === app.me ? e2e.fingerprint(app.identity.signPub) : p ? e2e.fingerprint(p.signPub) : null,
    verified: !!(p && p.verified), changed: !!(p && p.changed), contact: !!(p && p.contact),
    online: name === app.me ? app.conn.state === 'online' : app.presence.has(name) ? app.presence.get(name) : null,
  };
}

/** Message counts per day for the last two weeks, from what's saved on this computer. */
function history(app) {
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) days.push({ day: start.getTime() - i * 86400000, sent: 0, received: 0 });
  const per = [];
  let sent = 0;
  let received = 0;
  let files = 0;
  for (const key of app.vault.conversations()) {
    let n = 0;
    for (const r of app.vault.loadHistory(key, 20000)) {
      if (typeof r.text !== 'string') continue;
      n++;
      if (r.file) files++;
      const mine = r.from === app.me;
      if (mine) sent++; else received++;
      const d = days.find((x) => r.ts >= x.day && r.ts < x.day + 86400000);
      if (d) { if (mine) d.sent++; else d.received++; }
    }
    if (n) per.push({ key, n });
  }
  per.sort((a, b) => b.n - a.n);
  return { days, sent, received, files, top: per.slice(0, 5), chats: per.length };
}

/** Your contacts, with the last thing said in each chat. */
function people(app) {
  return app.contacts().map((p) => {
    const last = app.vault.loadHistory('@' + p.name, 1).filter((r) => typeof r.text === 'string').pop();
    return {
      name: p.name, verified: !!p.verified, changed: !!p.changed, muted: app.muted('@' + p.name),
      online: app.presence.has(p.name) ? app.presence.get(p.name) : null,
      last: last ? { ts: last.ts, mine: last.from === app.me, text: last.file ? `[file] ${last.file.name}` : last.text.replace(/\s+/g, ' ').slice(0, 80) } : null,
    };
  }).sort((a, b) => (b.online === true) - (a.online === true) || ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0));
}

/** Your servers, with how many are in each and the last thing said. */
function servers(app) {
  return app.rooms().map((name) => {
    const chat = app.chats.get('#' + name);
    const last = app.vault.loadHistory('#' + name, 1).filter((r) => typeof r.text === 'string').pop();
    return {
      name, members: chat && chat.members ? chat.members.size : 0, owner: chat ? chat.owner : null,
      mine: !!(chat && chat.owner === app.me), private: !!(chat && chat.private), muted: app.muted('#' + name),
      last: last ? { ts: last.ts, from: last.from, mine: last.from === app.me, text: last.file ? `[file] ${last.file.name}` : last.text.replace(/\s+/g, ' ').slice(0, 80) } : null,
    };
  });
}

/** A chat you may read and write from the page: one of your contacts, or a server you're in. */
function chatKey(app, key) {
  if (typeof key !== 'string') return null;
  if (key[0] === '@') { const p = app.peers.get(key.slice(1)); return p && p.contact ? key : null; }
  if (key[0] === '#') return app.rooms().includes(key.slice(1)) ? key : null;
  return null;
}

/** The last messages of one chat, for the conversation box. */
function thread(app, key) {
  const msgs = app.vault.loadHistory(key, 80).filter((r) => typeof r.from === 'string').map((r) => ({
    id: r.id, from: r.from, mine: r.from === app.me, ts: r.ts, st: r.st || null,
    text: r.file ? null : String(r.text || ''), file: r.file ? { name: String(r.file.name || 'a file'), size: r.file.size || 0 } : null,
  }));
  const out = { key, messages: msgs };
  if (key[0] === '@') {
    const name = key.slice(1);
    const p = app.peers.get(name);
    out.online = app.presence.has(name) ? app.presence.get(name) : null;
    out.verified = !!(p && p.verified);
    out.changed = !!(p && p.changed);
    out.typing = (app.chats.get(key) && app.chats.get(key).typing && app.chats.get(key).typing.size > 0) || false;
    if (p && p.signPub) out.safety = e2e.safetyNumber(app.identity.signPub, p.changed ? p.changed.signPub : p.signPub);
  } else {
    const chat = app.chats.get(key);
    out.members = chat && chat.members ? [...chat.members.keys()].sort() : [];
    out.owner = chat ? chat.owner : null;
  }
  return out;
}

/** Your saved messages that mention some words, newest first. */
function find(app, q) {
  const want = String(q || '').trim().toLowerCase().slice(0, 200);
  if (!want) return [];
  const hits = [];
  for (const key of app.vault.conversations()) {
    for (const r of app.vault.loadHistory(key, 5000)) {
      if (typeof r.text === 'string' && r.text.toLowerCase().includes(want)) hits.push({ key, from: r.from, mine: r.from === app.me, ts: r.ts, text: r.text.slice(0, 300) });
    }
  }
  return hits.sort((a, b) => b.ts - a.ts).slice(0, 50);
}

/** How much room gossip takes on this computer. */
function storage(app) {
  const size = (dir, deep) => {
    let n = 0;
    let count = 0;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isFile()) { n += fs.statSync(full).size; count++; } else if (deep && e.isDirectory()) { const x = size(full, false); n += x.bytes; count += x.count; }
      }
    } catch { /* not there yet */ }
    return { bytes: n, count };
  };
  const filesDir = require('./files').saveDir(app.vault.dir, prefs.val('files'));
  return { history: size(app.vault.historyDir, false), files: { ...size(filesDir, false), dir: filesDir }, home: app.vault.dir };
}

const SETTABLE = ['theme', 'calls', 'call.hideip', 'notify', 'bell', 'background'];

async function snapshot(app) {
  const link = app.link;
  const url = app.serverUrl || '';
  const online = !!(link && link.online);
  const ping = online ? await cached('ping', 4000, () => app.ping().catch(() => null)) : null;
  let sessions = null;
  let sessionsNote = null;
  if (online) {
    try {
      sessions = await cached('sessions', 4000, async () => (await link.request('sessions', {})).sessions);
    } catch (e) {
      sessionsNote = e.code === 'unknown' ? 'This relay is too old to list them. Update it to see where your account is open.' : null;
    }
  }
  const transport = link && link.transport ? link.transport() : null;
  const kind = app.via ? 'nearby host' : /^https?:/i.test(url) ? 'gossip website' : 'relay';

  // every connection gossip makes, and everything it's listening on
  const outbound = [];
  if (url) {
    outbound.push({
      what: `Messages (${kind})`, where: hostOf(url) + (transport && transport.remote && !/^[\d.:[\]]+$/.test(hostOf(url)) ? `  ${transport.remote}` : ''),
      how: transport && transport.tls ? `${transport.tls.protocol || 'TLS'} encrypted` : isLocal(url) ? 'this computer' : app.via ? 'local network' : 'NOT encrypted',
      secure: !!(transport && transport.tls) || isLocal(url) || !!app.via,
      state: app.conn.state,
    });
  }
  const where = U.install();
  if (where.managed && prefs.val('update') !== 'off') {
    let checked = 0;
    try { checked = JSON.parse(fs.readFileSync(where.state, 'utf8')).checked || 0; } catch { /* never */ }
    outbound.push({ what: 'Update check', where: 'raw.githubusercontent.com, codeload.github.com', how: 'TLS encrypted', secure: true, state: checked ? 'checked' : 'not yet', at: checked || null });
  }
  if (app.calls && app.calls.stunUsed) {
    outbound.push({ what: 'Call setup (finds your public address)', where: STUN.map((s) => s.replace(/^stun:/, '')).join(', '), how: 'STUN over UDP', secure: null, state: 'used', at: app.calls.stunUsed });
  }
  for (const c of app.calls ? app.calls.summary() : []) {
    if (!c.route || !c.route.remote) continue;
    outbound.push({ what: `Call with ${c.peer}`, where: c.route.remote, how: `${(c.route.proto || 'udp').toUpperCase()} · DTLS-SRTP encrypted · ${c.route.kind}`, secure: true, state: c.state, at: c.started || c.made });
  }
  if (app.nearby) outbound.push({ what: 'Finding people nearby', where: 'your local network', how: 'UDP broadcast, port 47800', secure: null, state: 'on' });

  const listening = [];
  if (app.web && app.web.port) listening.push({ what: 'This dashboard and calls', where: `127.0.0.1:${app.web.port}`, who: 'only this computer, with a secret address' });
  if (app.nearby && app.nearby.hosting) listening.push({ what: 'Nearby chat host', where: `port ${app.nearby.port || 47801}`, who: 'anyone on your local network (messages are still end-to-end encrypted)' });

  // who can read each conversation
  const chats = [];
  const seen = new Set();
  for (const p of app.contacts()) seen.add('@' + p.name);
  for (const k of app.vault.conversations()) if (k[0] === '@') seen.add(k);
  for (const k of seen) {
    if (k.slice(1) === app.me) continue;
    chats.push({ key: k, kind: 'dm', muted: app.muted(k), readers: [personOf(app, app.me), personOf(app, k.slice(1))] });
  }
  for (const r of app.rooms()) {
    const chat = app.chats.get('#' + r);
    const names = chat ? [...chat.members.keys()] : [];
    chats.push({
      key: '#' + r, kind: 'room', muted: app.muted('#' + r), owner: chat ? chat.owner : null, private: !!(chat && chat.private),
      readers: (names.length ? names : [app.me]).map((n) => personOf(app, n)),
    });
  }

  return {
    now: Date.now(), me: app.me, version: pkg.version, host: os.hostname(),
    fingerprint: app.identity ? e2e.fingerprint(app.identity.signPub) : null,
    connection: {
      url, host: hostOf(url), kind, state: app.conn.state, detail: app.conn.detail && app.conn.detail.message ? app.conn.detail.message : null,
      since: online ? app.onlineSince : null, reconnects: app.reconnects, ping, transport,
      server: link && link.server ? { name: link.server.name, version: link.server.version || null } : null,
    },
    sessions, sessionsNote, outbound, listening, chats, checks: checks(app),
    counts: app.counts, history: await cached('history', 15000, async () => history(app)),
    calls: app.calls ? app.calls.summary() : [],
    activity: app.activity.slice(-60).reverse(),
    theme: prefs.val('theme'),
    people: people(app),
    servers: servers(app),
    dnd: app.dndUntil(),
    scheduled: { later: app.scheduled('later'), reminders: app.scheduled('reminders') },
    settings: Object.fromEntries(SETTABLE.map((k) => [k, { value: prefs.val(k), choices: prefs.OPTIONS.find((o) => o.key === k).choices }])),
    storage: await cached('storage', 10000, async () => storage(app)),
    callNow: app.calls && app.calls.current ? app.calls.current.peer : null,
  };
}

function routes(app, web) {
  if (web._dashboard) return;
  web._dashboard = true;
  web.on('GET', 'dashboard', (req, res, rest, send) => send(200, web.page('dashboard.html', {
    api: web.url('dashapi'), act: web.url('dashact'),
  }), 'text/html; charset=utf-8'));
  web.on('GET', 'dashapi', async (req, res, rest, send) => send(200, JSON.stringify(await snapshot(app)), 'application/json'));
  web.on('POST', 'dashact', async (req, res, rest, send, m) => {
    let result = { ok: true };
    try {
      if (m.do === 'signout') {
        const r = await app.link.request('signout', {});
        app.otherSessions = 0;
        cache.delete('sessions');
        app.say(`Signed out ${r.closed} other place${r.closed === 1 ? '' : 's'} from the dashboard.`, 'warn');
        result = { ok: true, closed: r.closed };
      } else if (m.do === 'reconnect' && app.link) {
        app.link.retryNow();
      } else if (m.do === 'call' && app.calls && typeof m.peer === 'string' && app.peers.get(m.peer) && app.peers.get(m.peer).contact) {
        await app.calls.start(m.peer, { video: !!m.video });
      } else if (m.do === 'send' && typeof m.text === 'string' && m.text.trim() && chatKey(app, m.key || (typeof m.to === 'string' ? '@' + m.to : null))) {
        await app.send(chatKey(app, m.key || '@' + m.to), m.text.slice(0, 4000));
      } else if (m.do === 'thread' && chatKey(app, m.key)) {
        result = { ok: true, thread: thread(app, m.key) };
      } else if (m.do === 'find' && typeof m.q === 'string') {
        result = { ok: true, hits: find(app, m.q) };
      } else if (m.do === 'verify' && typeof m.peer === 'string' && chatKey(app, '@' + m.peer)) {
        const p = app.peers.get(m.peer);
        if (p.changed) throw new Error(`${m.peer}'s key changed - compare the new number first, then accept it in gossip with /trust ${m.peer}`);
        app.peers.update(m.peer, (cur) => ({ ...(cur || p), verified: true }));
        app.log('ok', `Marked ${m.peer} as verified from the dashboard.`);
      } else if (m.do === 'set' && SETTABLE.includes(m.key)) {
        const res = prefs.set(app.vault, m.key, m.value);
        app.settings = res.settings;
        app.emit('change');
        app.log('event', `Changed ${m.key} to ${res.value} from the dashboard.`);
      } else if (m.do === 'dnd') {
        const W = require('./when');
        const t = m.for === 'off' ? null : m.for ? W.parse(String(m.for)) : null;
        app.setDnd(m.for === 'off' ? 0 : t ? t.at : Date.now() + 100 * 365 * 86400000);
      } else if (m.do === 'unschedule' && ['later', 'reminders'].includes(m.kind) && typeof m.id === 'string') {
        result = { ok: !!app.unschedule(m.kind, m.id) };
      } else if (m.do === 'play' && typeof m.url === 'string') {
        const v = require('./youtube').parse(m.url);
        if (!v) throw new Error("That isn't a YouTube video");
        if (!app.player) app.player = new (require('./player').Player)(app);
        await app.player.show(v, { play: true });
      } else if (m.do === 'openfiles') {
        const dir = storage(app).files.dir;
        fs.mkdirSync(dir, { recursive: true });
        openBrowser(dir);
      } else result = { ok: false };
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    send(200, JSON.stringify(result), 'application/json');
  });
}

/** /dashboard: start the page and open it. Returns the address if no browser could be opened. */
async function open(app) {
  const web = app.web || new Web(app);
  app.web = web;
  routes(app, web);
  await web.start();
  const url = web.url('dashboard');
  return { url, opened: openBrowser(url) };
}

module.exports = { open, snapshot, checks };

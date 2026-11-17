'use strict';
// gossip's YouTube player: a page (its own window when it can be) that plays
// YouTube videos in YouTube's own player, and can keep everyone in a chat
// watching the same moment. Play, pause and jumps travel as encrypted gossip
// messages that are never shown or saved. Videos are never downloaded.

const EventEmitter = require('events');
const YT = require('./youtube');
const prefs = require('./prefs');

const TICK = 20000; // while watching together: a quiet "still here, at 1:32" this often
const GONE = 65000; // not heard from in this long: they've stopped watching
const KINDS = new Set(['hello', 'state', 'tick', 'bye']);

const clock = (s) => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s % 60).padStart(2, '0');
};
const label = (key) => (key[0] === '#' ? key : key.slice(1));

class Player extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.web = null;
    this.pages = new Set();
    this.now = null; // what the page last told us: { v, at, playing, title, dur, seen }
    this.together = null; // { key, since }
    this.watchers = new Map(); // name -> when we last heard from them
    this.leader = null; // whoever last pressed play, paused or jumped
    this.invites = new Map(); // key -> { from, v, at }: someone's watching in a chat you're not watching in
    this.pending = null; // what to play once the page opens
    this.lastRemote = null; // the last play/pause/jump from someone watching with you
    this._timer = null;
    this._bye = null;
    this._told = new Map(); // key -> when we last said "maya is watching"
    app.on('watch', (w) => this._onWatch(w).catch(() => {}));
  }

  /** Is the player page open right now? */
  get open() {
    return this.pages.size > 0;
  }

  /** Where the video is now (counting the seconds since the page last said). */
  position() {
    const n = this.now;
    if (!n || !n.v) return null;
    const at = n.at + (n.playing ? Math.min(30, (Date.now() - n.seen) / 1000) : 0);
    return { v: n.v, at: Math.round(at * 10) / 10, playing: !!n.playing };
  }

  /** The chats you can watch with: your contacts and the servers you're in. */
  chats() {
    const out = this.app.contacts().map((p) => ({ key: '@' + p.name, label: p.name }));
    for (const r of this.app.rooms()) out.push({ key: '#' + r, label: '#' + r });
    return out;
  }

  okKey(key) {
    if (typeof key !== 'string') return null;
    if (key[0] === '@') { const p = this.app.peers.get(key.slice(1)); return p && p.contact ? key : null; }
    if (key[0] === '#') return this.app.rooms().includes(key.slice(1)) ? key : null;
    return null;
  }

  // ── opening the page ────────────────────────────────────────────────

  async _web() {
    if (!this.web) {
      const { Web } = require('./web');
      this.web = this.app.web || new Web(this.app);
      this.app.web = this.web;
    }
    this._routes(this.web);
    await this.web.start();
    return this.web;
  }

  /**
   * Open the player (or use the one that's open). video: { id, start } or null.
   * Returns { url, opened, reused }.
   */
  async show(video = null, { play = true } = {}) {
    const web = await this._web();
    const url = web.url('player');
    const load = video && YT.ID.test(video.id) ? { v: video.id, start: Math.max(0, Math.floor(video.start || 0)), play } : null;
    if (this.open) {
      if (load) this._push({ t: 'load', ...load, by: 'you' });
      this._push({ t: 'focus' });
      return { url, opened: true, reused: true };
    }
    this.pending = load;
    const { openWindow, openBrowser } = require('./web');
    const opened = prefs.val('player') === 'tab' ? openBrowser(url) : openWindow(url);
    return { url, opened, reused: false };
  }

  /** Tell the page to play, pause or jump (from the terminal). */
  control(what, by = 0) {
    if (!this.open) return false;
    this._push({ t: 'control', do: what, by });
    return true;
  }

  // ── watching together ───────────────────────────────────────────────

  /**
   * Start watching together with a chat: say hello, and listen for theirs.
   * take: { v, at } to put this video on for everyone (otherwise you catch up with them).
   */
  async join(key, { take = null } = {}) {
    const k = this.okKey(key);
    if (!k) throw new Error('You can watch together with a contact or a server you are in.');
    if (this.together && this.together.key === k) {
      if (take && this.watchers.size) await this.app.watchSignal(k, { t: 'state', v: take.v, at: take.at || 0, playing: true, act: 1 }, new Set(this.watchers.keys())).catch(() => {});
      if (take) this.leader = this.app.me;
      return;
    }
    if (this.together) await this.leave({ quiet: true });
    clearTimeout(this._bye);
    this.together = { key: k, since: Date.now() };
    this.watchers.clear();
    this.leader = take ? this.app.me : null;
    this.lastRemote = null;
    this.invites.delete(k);
    const pos = this.position();
    const hello = take ? { t: 'hello', v: take.v, at: take.at || 0, take: 1 } : { t: 'hello', ...(pos ? { v: pos.v } : {}) };
    await this.app.watchSignal(k, hello).catch(() => {});
    clearInterval(this._timer);
    this._timer = setInterval(() => this._tickNow().catch(() => {}), TICK);
    this._timer.unref();
    this._pushWho();
    this.app.emit('change');
  }

  async leave({ quiet = false } = {}) {
    const t = this.together;
    if (!t) return false;
    clearInterval(this._timer);
    this._timer = null;
    if (this.watchers.size) await this.app.watchSignal(t.key, { t: 'bye' }, new Set(this.watchers.keys())).catch(() => {});
    this.together = null;
    this.watchers.clear();
    this.leader = null;
    this._pushWho();
    if (!quiet) this.app.emit('change');
    return true;
  }

  async _tickNow() {
    const t = this.together;
    if (!t) return;
    const now = Date.now();
    for (const [name, at] of this.watchers) {
      if (now - at > GONE) {
        this.watchers.delete(name);
        this._push({ t: 'note', text: `${name} stopped watching` });
      }
    }
    this._pushWho();
    const pos = this.position();
    if (this.watchers.size) {
      await this.app.watchSignal(t.key, { t: 'tick', ...(pos || {}), lead: this.leader === this.app.me ? 1 : 0 }, new Set(this.watchers.keys()));
    }
  }

  async _onWatch({ key, from, data }) {
    if (!data || !KINDS.has(data.t)) return;
    const v = typeof data.v === 'string' && YT.ID.test(data.v) ? data.v : null;
    const at = Number.isFinite(data.at) ? Math.max(0, Math.min(data.at, 7 * 86400)) : 0;
    const playing = data.playing === true;
    const t = this.together;
    if (!t || t.key !== key) {
      // someone is watching in a chat you aren't watching in
      if (data.t === 'hello' || (data.t === 'state' && v)) {
        this.invites.set(key, { from, v: v || (this.invites.get(key) || {}).v || null, at: Date.now() });
        const last = this._told.get(key) || 0;
        if (Date.now() - last > 10 * 60000) {
          this._told.set(key, Date.now());
          const where = key[0] === '#' ? ` in ${key}` : '';
          this.app.say(`${from} wants to watch a YouTube video together${where}. Open that chat and type /watch to join in.`, 'event');
        }
        this._push({ t: 'invite', key, label: label(key), from });
      } else if (data.t === 'bye') {
        const inv = this.invites.get(key);
        if (inv && inv.from === from) this.invites.delete(key);
      }
      return;
    }
    const fresh = !this.watchers.has(from);
    if (data.t === 'bye') {
      this.watchers.delete(from);
      if (this.leader === from) this.leader = null;
      this._push({ t: 'note', text: `${from} stopped watching` });
      this._pushWho();
      return;
    }
    this.watchers.set(from, Date.now());
    if (fresh) {
      this._push({ t: 'note', text: `${from} is watching with you` });
      this._pushWho();
      this.app.emit('change');
    }
    if (data.t === 'hello' && data.take && v) {
      // they've put a video on for everyone
      this.leader = from;
      this._remote({ t: 'state', from, v, at, playing: true, act: true, lead: true, sent: Date.now() });
      this._pushWho();
      return;
    }
    if (data.t === 'hello') {
      // catch them up with where we are
      const pos = this.position();
      if (pos) await this.app.watchSignal(key, { t: 'state', ...pos, lead: this.leader === this.app.me ? 1 : 0 }, new Set([from])).catch(() => {});
      return;
    }
    if (!v) return;
    if (data.t === 'state' && data.act) this.leader = from;
    if (data.t === 'tick' && data.lead && !this.leader) this.leader = from;
    this._remote({ t: data.t, from, v, at, playing, act: !!data.act, lead: from === this.leader, sent: Date.now() });
    this._pushWho();
  }

  /** Pass play/pause/jump news to the page (and keep it, in case the page is still opening). */
  _remote(ev) {
    if (ev.t === 'state' || ev.lead) this.lastRemote = ev;
    this._push(ev);
  }

  // ── the page ────────────────────────────────────────────────────────

  _push(ev) {
    for (const write of this.pages) write(ev);
  }

  _who() {
    const now = Date.now();
    return {
      t: 'who',
      together: this.together ? { key: this.together.key, label: label(this.together.key) } : null,
      people: [...this.watchers].map(([name, at]) => ({ name, on: now - at < GONE })),
      leader: this.leader,
    };
  }

  _pushWho() {
    this._push(this._who());
  }

  /** The page told us where it is. act: someone pressed something (not just a progress report). */
  async _fromPage(m) {
    const v = typeof m.v === 'string' && YT.ID.test(m.v) ? m.v : null;
    if (!v) { this.now = null; this.app.emit('change'); return; }
    const at = Number.isFinite(m.at) ? Math.max(0, m.at) : 0;
    this.now = {
      v, at, playing: m.playing === true, seen: Date.now(),
      title: typeof m.title === 'string' ? m.title.slice(0, 200) : (this.now && this.now.v === v ? this.now.title : ''),
      dur: Number.isFinite(m.dur) ? m.dur : 0,
    };
    if (m.act) {
      if (this.together) this.leader = this.app.me;
      if (this.together && this.watchers.size) {
        await this.app.watchSignal(this.together.key, { t: 'state', v, at, playing: m.playing === true, act: 1 }, new Set(this.watchers.keys())).catch(() => {});
      }
    }
    this.app.emit('change');
  }

  async _videos() {
    const list = YT.videosIn(this.app, null, 40);
    await Promise.all(list.slice(0, 24).map((x) => YT.title(x.id, 3500)));
    return list.map((x) => {
      const t = YT.titles.get(x.id);
      return { ...x, label: label(x.key), title: t ? t.title : '', channel: t ? t.channel : '' };
    });
  }

  _routes(web) {
    if (web._player) return;
    web._player = true;
    const CSP = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com",
      'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://i.ytimg.com",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    web.on('GET', 'player', (req, res, rest, send) => send(200, web.page('player.html', {
      api: web.url('playerapi'), events: web.url('playerevents'), me: this.app.me, icon: 'laptop',
    }), 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP }));

    web.on('GET', 'playerevents', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clearTimeout(this._bye);
      write({
        ...this._who(),
        t: 'hello', me: this.app.me, chats: this.chats(), load: this.pending, now: this.position(),
        remote: this.together && this.lastRemote && Date.now() - this.lastRemote.sent < 30000 ? this.lastRemote : null,
        invites: [...this.invites].map(([key, x]) => ({ key, label: label(key), from: x.from })),
      });
      this.pending = null;
      this.pages.add(write);
      this.app.emit('change');
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        this.pages.delete(write);
        if (!this.pages.size) {
          // closed (not just reloaded): stop watching together, and stop showing it in the terminal
          this._bye = setTimeout(() => {
            if (this.pages.size) return;
            this.now = null;
            this.leave().catch(() => {});
            this.app.emit('change');
          }, 6000);
          this._bye.unref();
        }
      });
    });

    web.on('POST', 'playerapi', async (req, res, rest, send, m) => {
      let out = { ok: true };
      try {
        if (m.t === 'state') await this._fromPage(m);
        else if (m.t === 'together') {
          if (m.key) await this.join(m.key); else await this.leave();
          out = { ok: true, ...this._who() };
        } else if (m.t === 'videos') out = { ok: true, videos: await this._videos() };
        else if (m.t === 'resolve') {
          const v = YT.parse(String(m.text || '').slice(0, 2000));
          out = v ? { ok: true, v: v.id, start: v.start } : { ok: false };
        } else if (m.t === 'share' && this.okKey(m.key) && typeof m.v === 'string' && YT.ID.test(m.v)) {
          await this.app.send(this.okKey(m.key), `▶ ${YT.link(m.v, m.start)}`);
        } else out = { ok: false };
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      send(200, JSON.stringify(out), 'application/json');
    });
  }

  /** One line for the terminal's status bar, or '' when nothing is playing. */
  statusText() {
    if (!this.open) return '';
    const pos = this.position();
    const with_ = this.together
      ? (this.watchers.size ? ` · with ${[...this.watchers.keys()].slice(0, 2).join(', ')}${this.watchers.size > 2 ? ` +${this.watchers.size - 2}` : ''}` : ` · waiting for ${label(this.together.key)} to join`)
      : '';
    if (!pos) return this.together ? `▶ watching together${with_}` : '';
    const dur = this.now.dur ? ` / ${clock(this.now.dur)}` : '';
    const name = this.now.title ? ` · ${this.now.title}` : '';
    return `${pos.playing ? '▶' : '‖'} ${clock(pos.at)}${dur}${name}${with_} · /yt ${pos.playing ? 'pause' : 'play'}`;
  }
}

module.exports = { Player, clock, TICK, GONE };

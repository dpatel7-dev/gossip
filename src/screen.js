'use strict';
// The full chat screen: your chats on the left, the conversation on the right,
// a box to type in at the bottom. Arrow keys, a menu (Tab) and the mouse do
// everything - no commands to remember (though /commands still work if typed).
//
// It borrows the terminal's whole window while it's open and gives it back,
// exactly as it was, when you leave.

const { EventEmitter } = require('events');
const readline = require('readline');
const A = require('./ansi');
const R = require('./render');
const Th = require('./theme');
const M = require('./mascot');
const prefs = require('./prefs');
const { Editor } = require('./editor');
const { Menu, pages } = require('./menu');
const { handleInput } = require('./commands');
const pkg = require('../package.json');

const notify = require('./notify');

const FOCUS_RE = /\x1b\[([IO])/g; // the terminal telling us its window gained / lost focus
const BG_RE = /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})(?:\x07|\x1b\\)/i; // "my background colour is…"
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Is this window big enough for the full screen? */
function fits(out = process.stdout) {
  return (out.columns || 80) >= 46 && (out.rows || 24) >= 12;
}

function run(app, { firstRun = false, notice = null, startup = null } = {}) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const inp = process.stdin;
    const ed = new Editor();
    const keys = new EventEmitter(); // keystrokes, after the mouse reports are taken out

    const items = new Map(); // chat key -> things shown in its pane
    const home = []; // what the welcome page shows under the penguin
    const unread = new Map();
    let sel = null; // the open chat ('@maya' / '#gamedev'), or null for the welcome page
    let cursor = sel; // the highlighted row on the left: a chat key or 'a:<action>'
    let scroll = 0; // lines scrolled up from the newest message
    let sideTop = 0;
    let stage = null; // the penguin, while it's performing
    let flash = null;
    let quitArmedUntil = 0;
    let lastKeyAt = Date.now();
    let pasting = false;
    let closed = false;
    let scheduled = false;
    let prev = []; // the lines on screen right now
    let cache = null; // wrapped lines of the open chat
    let hits = []; // which row of the left column is which
    let geo = null;
    let carry = '';
    let focused = true;
    let focusKnown = false; // some terminals never say
    let booting = false;
    let typedAt = 0;
    let typingNow = false;
    const pet = { scene: null, pose: null, frames: null, at: 0, total: 0, timer: null }; // Pebble, in the corner

    const host = () => {
      try { return new URL(app.serverUrl).host; } catch { return app.serverUrl || 'no relay set'; }
    };

    // ── what's in each pane ─────────────────────────────────────────────────

    function load(key) {
      let list = items.get(key);
      if (!list) {
        list = app.vault.loadHistory(key, 300).map((r) => ({ t: 'msg', key, msg: { id: r.id, from: r.from, ts: r.ts, text: r.text, status: r.st } }));
        items.set(key, list);
      }
      return list;
    }

    function open(key) {
      if (key === sel) return;
      sel = key;
      cursor = key || cursor;
      scroll = 0;
      cache = null;
      if (key) {
        const list = load(key);
        for (let i = list.length - 1; i >= 0; i--) if (list[i].t === 'new') list.splice(i, 1);
        const fresh = unread.get(key) || 0;
        if (fresh > 0 && fresh < list.length) list.splice(list.length - fresh, 0, { t: 'new' }); // "new messages" line
        unread.delete(key);
        if (app.target !== key) app.setTarget(key);
      }
      schedule();
    }

    function onLine(item) {
      if (item.t === 'msg') {
        const list = items.get(item.key);
        if (list) list.push(item);
        if (list && list.length > 600) list.splice(0, list.length - 500);
        const mine = item.msg.from === app.me;
        if (item.key !== sel && !mine) unread.set(item.key, (unread.get(item.key) || 0) + 1);
        if (item.key === sel && mine) scroll = 0;
        react(mine ? 'dance' : 'phone');
        const away = focusKnown ? !focused : Date.now() - lastKeyAt > 10000;
        if (!mine && away && !app.muted(item.key)) notify.message(prefs.val('notify'), item.key, item.msg);
      } else {
        (sel ? load(sel) : home).push(item); // notices and tables land in whatever you're looking at
        scroll = 0;
      }
      cache = null;
      schedule();
    }

    function paneLines(w) {
      if (cache && cache.key === sel && cache.w === w) return cache.lines;
      const printer = new R.Printer(app.me, { bare: true });
      const lines = [];
      for (const item of (sel ? load(sel) : home)) {
        if (item.t === 'new') {
          const label = ' new ';
          const side = Math.max(2, Math.floor((w - label.length) / 2));
          lines.push(Th.accent2('─'.repeat(side) + label + '─'.repeat(Math.max(2, w - 1 - side - label.length))));
          continue;
        }
        const block = printer.lines(item, w + 1);
        if (item.t === 'rows') lines.push('', ...block, ''); else lines.push(...block);
      }
      cache = { key: sel, w, lines };
      return lines;
    }

    const spriteOpts = () => ({ mode: Th.spriteMode(), speed: prefs.val('mascot.speed'), markStyle: R.markStyle() });

    const scene0 = M.pickScene(prefs.val('mascot') === 'off' ? 'random' : prefs.val('mascot'));
    let still = null;

    function welcomeLines(w, h) {
      const lines = [];
      const look = prefs.val('theme') + Th.spriteMode() + M.styleNow();
      if (!still || still.look !== look) still = { look, lines: M.still(scene0, spriteOpts()) };
      const sprite = stage ? stage.frames[stage.i].lines : (prefs.val('mascot') !== 'off' ? still.lines : null);
      if (sprite && h >= M.HEIGHT + 2) {
        lines.push('');
        for (const l of sprite) lines.push(R.center(l, w));
      }
      if (stage && stage.only) return lines;
      if (h < M.HEIGHT + 9) return lines.concat('', R.center(A.paint((firstRun ? 'Welcome, ' : 'Welcome back, ') + app.me, { bold: true }), w), '');
      lines.push('', R.center(A.paint((firstRun ? 'Welcome, ' : 'Welcome back, ') + app.me, { bold: true }), w), '');
      const tips = [
        ['↑ ↓', 'pick a chat on the left'],
        ['Tab', 'open the menu: add people, servers, settings'],
        ['Enter', 'send what you typed'],
        ['Click', 'works too'],
      ];
      for (const [k, d] of tips) lines.push(R.center(Th.accent(k.padStart(5)) + '  ' + Th.dim(d.padEnd(44)), w));
      lines.push('');
      return lines;
    }

    // ── the left column ─────────────────────────────────────────────────────

    function sideRows() {
      // People = the contacts you added. Anyone else only appears while they have
      // something unread for you (or you have their chat open), under "Others".
      const dms = app.contacts().map((p) => '@' + p.name);
      const others = [];
      for (const k of [...unread.keys(), sel]) if (k && k[0] === '@' && !dms.includes(k) && !others.includes(k)) others.push(k);
      const rows = [{ head: 'People' }];
      for (const key of dms) rows.push({ id: key, chat: key });
      rows.push({ id: 'a:add', label: '+ Add a person' }, { gap: true });
      if (others.length) {
        rows.push({ head: 'Others' });
        for (const key of others) rows.push({ id: key, chat: key });
        rows.push({ gap: true });
      }
      rows.push({ head: 'Servers' });
      for (const r of app.rooms()) rows.push({ id: '#' + r, chat: '#' + r });
      for (const [room, by] of app.invites) rows.push({ id: 'a:join:' + room, label: '#' + room, tag: `from ${by}` });
      rows.push({ id: 'a:servers', label: '+ Join or create' }, { gap: true }, { id: 'a:menu', label: '≡ Menu', tag: 'tab' });
      return rows;
    }

    function sideLine(row, w) {
      if (row.gap) return '';
      if (row.head) return ' ' + Th.accent2(row.head.toUpperCase(), { bold: true });
      const on = row.id === cursor;
      let left;
      let right = '';
      if (row.chat) {
        const name = row.chat.slice(1);
        const isOpen = row.chat === sel;
        const n = unread.get(row.chat) || 0;
        if (row.chat[0] === '@') {
          const online = app.presence.get(name);
          const dot = online ? Th.ok('●') : Th.dim(app.presence.has(name) ? '○' : '·');
          left = dot + ' ' + A.paint(name, { ...(n || isOpen ? { bold: true } : {}), ...(isOpen ? Th.style('accent') : {}) });
        } else {
          left = Th.paint('server', '#') + ' ' + A.paint(name, { ...(n || isOpen ? { bold: true } : {}), ...(isOpen ? Th.style('accent') : {}) });
        }
        if (app.muted(row.chat)) right = Th.dim('muted');
        else if (n) right = Th.accent2(String(n > 99 ? '99+' : n), { bold: true, inverse: true });
      } else {
        left = on ? Th.accent(row.label) : Th.dim(row.label);
        if (row.tag) right = Th.dim(row.tag);
      }
      const mark = on ? Th.accent2('›', { bold: true }) : ' ';
      const rw = A.vwidth(right);
      const body = A.clip(left, Math.max(4, w - 3 - (rw ? rw + 1 : 0)));
      return mark + ' ' + body + ' '.repeat(Math.max(1, w - 2 - A.vwidth(body) - rw)) + right;
    }

    function act(id) {
      if (id === 'a:add') menu.open(pages.addPerson);
      else if (id === 'a:servers') menu.open(pages.servers);
      else if (id === 'a:menu') menu.open();
      else if (id.startsWith('a:join:')) menu.run('join ' + id.slice(7)).catch((e) => app.say(e.message, 'err'));
    }

    function move(step) {
      const rows = sideRows().filter((r) => r.id);
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.id === cursor);
      i = i < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + step));
      cursor = rows[i].id;
      if (rows[i].chat) open(rows[i].chat);
    }

    // ── drawing ─────────────────────────────────────────────────────────────

    function statusText() {
      const st = app.conn.state;
      const d = app.conn.detail || {};
      if (st === 'online') return Th.ok('●') + ' ' + Th.dim(`${app.me} · ${host()}`);
      if (st === 'connecting') return Th.warn('◌') + ' ' + Th.dim('connecting…');
      if (st === 'offline') {
        const secs = d.retryAt ? Math.max(1, Math.ceil((d.retryAt - Date.now()) / 1000)) : 0;
        return Th.err('○') + ' ' + Th.dim(`offline${d.message ? ' · ' + d.message : ''}${secs ? ` · retrying in ${secs}s` : ''}`);
      }
      return Th.dim('not connected');
    }

    function paneTitle() {
      if (!sel) return Th.accent('gossip', { bold: true }) + Th.dim(' v' + pkg.version);
      const name = sel.slice(1);
      if (sel[0] === '@') {
        const p = app.peers.get(name);
        const on = app.presence.get(name);
        return R.label(sel) + (app.presence.has(name) ? ' ' + (on ? Th.ok('● online') : Th.dim('○ offline')) : '') + (p && p.verified ? Th.dim(' · verified') : '');
      }
      const chat = app.chats.get(sel);
      const n = chat ? chat.members.size : 0;
      return R.label(sel) + Th.dim(`${n ? ` · ${n} ${n === 1 ? 'person' : 'people'}` : ''}${chat && chat.private ? ' · invite-only' : ''}${chat && chat.owner === app.me ? ' · yours' : ''}`);
    }

    function callText(c) {
      if (c.dir === 'in' && c.state === 'ringing') return `${c.peer} is calling${c.video ? ' (video)' : ''} · enter answers · esc declines`;
      if (c.state === 'calling') return `calling ${c.peer}… · /hangup`;
      if (c.state === 'connecting') return `connecting to ${c.peer}… · /hangup`;
      const s = Math.floor((Date.now() - c.started) / 1000);
      return `● on a call with ${c.peer} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · /hangup`;
    }

    function hintLine(w) {
      const typing = app.typingText();
      const flashing = flash && flash.until > Date.now();
      const right = statusText();
      const rw = A.vwidth(right);
      const call = app.calls && app.calls.current;
      const options = flashing ? [flash.text] : call ? [callText(call)] : typing ? [typing]
        : menu.active ? ['']
          : scroll ? ['pgdn or esc for the newest messages']
            : ['↑↓ chats · tab menu · enter send · pgup/pgdn scroll', '↑↓ chats · tab menu · enter send', 'tab menu', ''];
      const text = options.find((t) => 2 + A.width(t) + 2 + rw <= w);
      const left = ' ' + Th.dim(text === undefined ? A.ellipsis(options[0], Math.max(0, w - rw - 4)) : text);
      const lw = A.vwidth(left);
      const r = lw + rw + 1 > w ? A.clip(right, Math.max(0, w - lw - 1)) : right;
      return left + ' '.repeat(Math.max(1, w - lw - A.vwidth(r))) + r;
    }

    function frame() {
      const W = Math.max(30, out.columns || 80);
      const H = Math.max(8, out.rows || 24);
      const side = W >= 64 ? Math.min(28, Math.max(24, Math.floor(W * 0.27))) : 0;
      const paneW = W - 2 - (side ? side + 1 : 0);
      const bar = Th.border('│');

      // the typing box
      const symbol = Th.accent2(prefs.val('prompt.symbol'), { bold: true }) + ' ';
      const pw = A.vwidth(symbol);
      const lay = ed.layout(Math.max(8, paneW - 2 - pw), Math.max(1, Math.min(4, H - 9)));
      const typed = lay.lines.map((l, i) => (i === 0 && lay.top === 0 ? symbol : ' '.repeat(pw)) + l);
      if (!ed.text) typed[0] = symbol + Th.dim(sel ? `Message ${sel[0] === '#' ? sel : sel.slice(1)}` : 'Pick a chat on the left, or press Tab');
      const bottom = H - 2; // the bottom border; the hint line is under it
      const sep = bottom - typed.length - 1;
      const msgH = sep - 1;

      // the right side
      let pane;
      if (menu.active) {
        pane = ['', ...menu.lines(paneW - 2, msgH - 2).map((l) => ' ' + l)];
      } else if (!sel || stage) {
        const top = welcomeLines(paneW, msgH);
        const rest = stage ? [] : paneLines(paneW - 1);
        pane = top.concat(rest);
        if (pane.length > msgH) pane = rest.length >= msgH ? rest.slice(-msgH) : top.slice(0, msgH - rest.length).concat(rest);
      } else {
        const all = paneLines(paneW - 1);
        const max = Math.max(0, all.length - msgH);
        if (scroll > max) scroll = max;
        const end = all.length - scroll;
        pane = all.slice(Math.max(0, end - msgH), end);
        if (!all.length) pane = ['', R.center(Th.dim('No messages yet. Say hello!'), paneW)];
        else if (pane.length < msgH) pane = Array(msgH - pane.length).fill('').concat(pane); // newest at the bottom
      }

      // the left side
      const rows = side ? sideRows() : [];
      const sideH = bottom - 1;
      const at = rows.findIndex((r) => r.id === cursor);
      if (at >= 0 && at < sideTop) sideTop = Math.max(0, at - 1);
      if (at >= sideTop + sideH) sideTop = at - sideH + 1;
      sideTop = Math.max(0, Math.min(sideTop, Math.max(0, rows.length - sideH)));
      hits = [];
      // Pebble lives at the bottom of the left column whenever there's room
      const petTop = sideH - M.HEIGHT;
      const petShown = side >= M.WIDTH && sel && !stage && prefs.val('mascot') !== 'off' && rows.length + 1 <= petTop;
      const petArt = petShown ? petLines() : null;

      const lines = [];
      const title = ' ' + paneTitle() + ' ';
      const brand = ' ' + Th.accent('gossip', { bold: true }) + ' ';
      let top = Th.border('╭─');
      if (side) top += brand + Th.border('─'.repeat(Math.max(0, side - 1 - A.vwidth(brand)) ) + '┬─');
      const tw = Math.min(A.vwidth(title), paneW - 2);
      top += A.clip(title, paneW - 2) + Th.border('─'.repeat(Math.max(0, paneW - 1 - tw)) + '╮');
      lines.push(top);
      for (let y = 1; y < bottom; y++) {
        let line = bar;
        if (side) {
          const row = rows[sideTop + y - 1];
          hits[y] = row && row.id ? row.id : null;
          const art = petArt && y - 1 >= petTop ? R.center(petArt[y - 1 - petTop], side) : null;
          line += R.fit(art || (row ? sideLine(row, side) : ''), side) + (y === sep ? Th.border('├') : bar);
        } else if (y === sep) line = Th.border('├');
        if (y === sep) line += Th.border('─'.repeat(paneW) + '┤');
        else if (y > sep) line += ' ' + R.fit(typed[y - sep - 1] || '', paneW - 2) + ' ' + bar;
        else line += R.fit(' ' + (pane[y - 1] || ''), paneW) + bar;
        lines.push(line);
      }
      lines.push(Th.border('╰' + (side ? '─'.repeat(side) + '┴' : '') + '─'.repeat(paneW) + '╯'));
      lines.push(hintLine(W));
      geo = { side, sep, bottom, msgH, W, H };
      return { lines, row: sep + 1 + lay.row, col: 1 + (side ? side + 1 : 0) + 1 + pw + lay.col };
    }

    function flush() {
      scheduled = false;
      if (closed) return;
      const f = frame();
      let buf = '\x1b[?2026h\x1b[?25l';
      for (let y = 0; y < f.lines.length; y++) {
        if (prev[y] !== f.lines[y]) buf += `\x1b[${y + 1};1H${f.lines[y]}${A.RESET}`;
      }
      if (prev.length > f.lines.length) buf += `\x1b[${f.lines.length + 1};1H\x1b[J`;
      prev = f.lines;
      buf += `\x1b[${f.row + 1};${f.col + 1}H` + (menu.active ? '' : '\x1b[?25h') + '\x1b[?2026l';
      out.write(buf);
    }

    function schedule() {
      if (scheduled || closed) return;
      scheduled = true;
      setImmediate(flush);
    }

    // ── the penguin ─────────────────────────────────────────────────────────

    function perform(scene, loops, only) {
      return new Promise((done) => {
        if (stage) stage.stop();
        const frames = M.play(scene, { ...spriteOpts(), loops });
        let timer = null;
        const me = {
          frames, i: 0, only,
          stop() {
            if (stage !== me) return;
            clearTimeout(timer);
            stage = null;
            schedule();
            done();
          },
        };
        const step = () => {
          if (stage !== me || closed) return;
          me.i++;
          if (me.i >= frames.length) return me.stop();
          schedule();
          timer = setTimeout(step, frames[me.i].ms);
        };
        stage = me;
        timer = setTimeout(step, frames[0].ms);
        schedule();
      });
    }

    // Pebble in the corner. He acts out what's happening - typing when you type,
    // on the phone when a message comes in, dancing when you send - and then stays
    // in that pose until something else happens. The frame to show is worked out
    // from the clock each time the screen is drawn, so nothing can get stuck.
    let petStill = null;
    function petLines() {
      if (pet.frames) {
        let t = Date.now() - pet.at;
        if (t >= pet.total && pet.loop && pet.loop()) { // keep going (still typing, still ringing)
          pet.at = Date.now() - (t % pet.total);
          t = Date.now() - pet.at;
        }
        for (const f of pet.frames) {
          if (t < f.ms) return f.lines;
          t -= f.ms;
        }
        petRest();
      }
      const pose = pet.pose || scene0;
      const look = pose + prefs.val('theme') + Th.spriteMode() + M.styleNow();
      if (!petStill || petStill.look !== look) petStill = { look, lines: M.still(pose, spriteOpts()) };
      return petStill.lines;
    }

    function petRest() {
      pet.frames = null;
      clearInterval(pet.timer);
      pet.timer = null;
    }

    function react(scene, loop = null) {
      if (closed || prefs.val('mascot') === 'off') return;
      pet.pose = scene;
      pet.loop = loop;
      if (!prefs.on('mascot.animate')) { schedule(); return; }
      const now = Date.now();
      if (pet.frames && pet.scene === scene && now - pet.at < pet.total - 200) return; // already at it
      pet.scene = scene;
      pet.frames = M.play(scene, { ...spriteOpts(), loops: 1 });
      pet.total = pet.frames.reduce((n, f) => n + f.ms, 0);
      pet.at = now;
      if (!pet.timer) pet.timer = setInterval(schedule, 70);
      schedule();
    }

    function play(scene) {
      if (geo && geo.msgH < M.HEIGHT + 2) return Promise.resolve();
      return perform(scene, 2, true);
    }

    // ── leaving ─────────────────────────────────────────────────────────────

    const hooks = [];
    const hook = (target, event, fn) => { target.on(event, fn); hooks.push([target, event, fn]); };

    function restore() {
      try {
        out.write('\x1b[?1004l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');
      } catch { /* terminal already gone */ }
      try { inp.setRawMode(false); } catch { /* not a tty any more */ }
      inp.pause();
    }

    function finish(result) {
      if (closed) return;
      closed = true;
      clearInterval(ticker);
      clearInterval(pet.timer);
      if (stage) stage.stop();
      for (const [target, event, fn] of hooks) target.removeListener(event, fn);
      restore();
      resolve(result);
    }

    const quit = () => finish({});

    function crash(err) {
      if (!closed) {
        closed = true;
        restore();
      }
      console.error('\ngossip hit an unexpected problem and had to stop:\n');
      console.error(err && err.stack ? err.stack : err);
      try { app.close(); } catch { /* exiting anyway */ }
      process.exit(1);
    }

    // ── keys and clicks ─────────────────────────────────────────────────────

    const ctx = {
      app, shell: true, quit, play, view: 'full',
      goMini() { finish({ switch: 'mini' }); },
      restart() { finish({ restart: true }); },
      noTarget: 'Pick someone on the left first (↑ ↓), or press Tab to add a person.',
      switchView(view) {
        prefs.set(app.vault, 'view', view);
        app.settings = app.vault.loadSettings();
        finish({ switch: view });
      },
    };
    const menu = new Menu(ctx, schedule);

    function submit() {
      const text = ed.text;
      if (!text.trim()) {
        if (app.calls && app.calls.ringing) { app.calls.answer().catch((e) => app.say(e.message, 'err')); return; }
        if (cursor && cursor.startsWith('a:')) act(cursor);
        return;
      }
      if (stage) stage.stop();
      typingNow = false; // (sending makes Pebble dance anyway)
      ed.clear();
      scroll = 0;
      handleInput(ctx, text).catch((e) => app.say(e.message || String(e), 'err'));
    }

    function ctrlC() {
      if (ed.text) { ed.clear(); return; }
      if (Date.now() < quitArmedUntil) { quit(); return; }
      quitArmedUntil = Date.now() + 2000;
      flash = { text: 'Press Ctrl+C again to leave', until: quitArmedUntil };
    }

    const printable = (s) => typeof s === 'string' && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s);
    const page = () => Math.max(1, (geo ? geo.msgH : 10) - 2);

    function onKey(str, key) {
      if (closed) return;
      key = key || {};
      const seq = key.sequence || '';
      const name = key.name;
      lastKeyAt = Date.now();
      if (seq === '\x1b[200~' || name === 'paste-start') { pasting = true; return; }
      if (seq === '\x1b[201~' || name === 'paste-end') { pasting = false; schedule(); return; }
      if (menu.active && !pasting) { menu.key(str, key); schedule(); return; }
      if (booting && stage) stage.stop(); // any key skips the hello and goes to your chat
      const before = ed.text;

      if (pasting) {
        if (name === 'return' || name === 'enter') ed.insert('\n');
        else if (name === 'tab') ed.insert('  ');
        else if (printable(str)) ed.insert(str);
      } else if (name === 'escape') {
        if (stage) stage.stop();
        else if (ed.text) ed.clear();
        else if (app.calls && app.calls.ringing) app.calls.decline().catch((e) => app.say(e.message, 'err'));
        else scroll = 0;
      } else if (key.ctrl) {
        switch (name) {
          case 'c': ctrlC(); break;
          case 'd': if (ed.text) ed.del(); else { quit(); return; } break;
          case 'a': ed.home(); break;
          case 'e': ed.end(); break;
          case 'u': ed.killToStart(); break;
          case 'k': ed.killToEnd(); break;
          case 'w': ed.deleteWord(); break;
          case 'left': ed.wordLeft(); break;
          case 'right': ed.wordRight(); break;
          case 'l': prev = []; out.write('\x1b[2J'); break;
          default:
        }
      } else if (key.meta) {
        if (name === 'return' || name === 'enter') ed.insert('\n');
        else if (name === 'backspace') ed.deleteWord();
        else if (name === 'b' || name === 'left') ed.wordLeft();
        else if (name === 'f' || name === 'right') ed.wordRight();
      } else {
        switch (name) {
          case 'return': submit(); break;
          case 'enter': ed.insert('\n'); break; // Ctrl+J
          case 'tab': menu.open(); break;
          case 'up': move(-1); break;
          case 'down': move(1); break;
          case 'pageup': scroll += page(); break;
          case 'pagedown': scroll = Math.max(0, scroll - page()); break;
          case 'backspace': ed.backspace(); break;
          case 'delete': ed.del(); break;
          case 'left': ed.left(); break;
          case 'right': ed.right(); break;
          case 'home': ed.home(); break;
          case 'end': ed.end(); break;
          default:
            if (printable(str)) ed.insert(str);
        }
      }
      if (closed) return;
      if (ed.text !== before && ed.text && sel && !'/@#'.includes(ed.text[0])) app.typingPing();
      if (ed.text !== before && ed.text) {
        // Pebble types along while you type, and dances when you stop
        typedAt = Date.now();
        typingNow = true;
        react('laptop', () => typingNow && Date.now() - typedAt < 1300);
      }
      schedule();
    }

    function onMouse(button, x, y, down) {
      if (!geo || !down) return;
      lastKeyAt = Date.now();
      if (button === 64) scroll += 3;
      else if (button === 65) scroll = Math.max(0, scroll - 3);
      else if (button === 0 && !menu.active && geo.side && x >= 2 && x <= geo.side + 1) {
        const id = hits[y - 1];
        if (!id) return;
        cursor = id;
        if (id.startsWith('a:')) act(id); else open(id);
      }
      schedule();
    }

    // Mouse reports arrive mixed in with keystrokes: pull them out, pass the rest on.
    function onData(chunk) {
      let text = carry + chunk.toString('utf8');
      carry = '';
      text = text.replace(BG_RE, (all, r, g, b) => {
        M.setBackdrop([r, g, b].map((h) => parseInt(h.slice(0, 2), 16)));
        still = null;
        petStill = null;
        prev = [];
        schedule();
        return '';
      });
      text = text.replace(FOCUS_RE, (all, kind) => {
        focusKnown = true;
        focused = kind === 'I';
        return '';
      });
      text = text.replace(MOUSE_RE, (all, b, x, y, kind) => {
        onMouse(Number(b) & ~28, Number(x), Number(y), kind === 'M'); // (bits 4-16 are shift/alt/ctrl)
        return '';
      });
      const cut = text.search(/\x1b\[<[\d;]*$/); // half a report: wait for the rest
      if (cut >= 0) {
        carry = text.slice(cut);
        text = text.slice(0, cut);
      }
      if (text) keys.emit('data', text);
    }

    // ── wiring ──────────────────────────────────────────────────────────────

    hook(app, 'line', onLine);
    if (app.calls) {
      hook(app.calls, 'ring', (c) => react('phone', () => app.calls.ringing === c));
      hook(app.calls, 'change', schedule);
    }
    if (startup) app.once('synced', () => handleInput(ctx, '/' + startup).catch((e) => app.say(e.message || String(e), 'err')));
    hook(app, 'change', () => {
      if (booting) { cache = null; schedule(); return; } // still saying hello
      if (app.target && app.target !== sel) open(app.target);
      else if (!app.target && sel) { sel = null; cache = null; }
      cache = null;
      schedule();
    });
    hook(app, 'flash', (text) => {
      flash = { text, until: Date.now() + 3000 };
      schedule();
    });
    hook(app, 'bell', () => {
      if (!closed && Date.now() - lastKeyAt > 10000) out.write('\x07');
    });
    hook(process, 'SIGTERM', quit);
    hook(process, 'SIGHUP', quit);
    hook(process, 'uncaughtException', crash);
    hook(process, 'unhandledRejection', (e) => {
      if (!closed) app.say(`Something went wrong: ${(e && e.message) || e}`, 'err');
    });

    readline.emitKeypressEvents(keys, { escapeCodeTimeout: 50 });
    keys.on('keypress', onKey);
    inp.setRawMode(true);
    inp.resume();
    hook(inp, 'data', onData);
    hook(out, 'resize', () => { prev = []; cache = null; out.write('\x1b[2J'); schedule(); });
    // (\x1b]11;? asks the terminal what its background colour is, for drawing Pebble cleanly)
    out.write('\x1b[?1049h\x1b[2J\x1b[?2004h\x1b[?1004h\x1b]11;?\x07' + (prefs.on('mouse') ? '\x1b[?1000h\x1b[?1006h' : ''));

    if (notice) {
      home.push({ t: 'note', kind: 'sys', text: notice });
      if (app.target) flash = { text: notice, until: Date.now() + 6000 };
    }
    if (!app.link) {
      app.connect().catch((e) => {
        if (e.code === 'no_server') app.say('No relay is set yet. Press Tab for the menu, or type /relay <address>.', 'warn');
      });
    }
    // Every start opens with Pebble saying hello, then goes to the chat you had open.
    const resume = () => {
      booting = false;
      if (!closed && !sel && app.target) open(app.target);
    };
    if (prefs.on('mascot.animate') && prefs.val('mascot') !== 'off') {
      booting = true;
      perform(scene0, 1, false).then(resume);
    } else resume();

    const ticker = setInterval(() => {
      app.tick();
      if (typingNow && Date.now() - typedAt > 1300) {
        typingNow = false;
        react('dance');
      }
      if (pet.frames && Date.now() - pet.at > pet.total && !(pet.loop && pet.loop())) petRest();
      if (flash && flash.until <= Date.now()) flash = null;
      schedule();
    }, 250);
    schedule();
  });
}

module.exports = { run, fits };

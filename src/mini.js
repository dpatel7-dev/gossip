'use strict';
// gossip mini: a tiny chat for the corner of your screen while you work.
//
// A few lines tall. The newest messages from all your chats scroll by, and
// whatever you type goes to the chat named in front of the cursor - which
// follows whoever wrote last, so replying is just: type, Enter.
//
//   Tab    reply to someone else        Enter  send
//   Esc    back to the full chat (or quit, if you started with `gossip mini`)

const readline = require('readline');
const A = require('./ansi');
const R = require('./render');
const Th = require('./theme');
const P = require('./paper');
const prefs = require('./prefs');
const notify = require('./notify');
const { Editor } = require('./editor');
const { handleInput } = require('./commands');
const { clock } = require('./text');

const ROWS = 9;
const COLS = 48;

function run(app, { back = null } = {}) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const inp = process.stdin;
    const ed = new Editor();
    const feed = []; // { text } already-styled one-liners, oldest first
    const was = { rows: out.rows || 24, cols: out.columns || 80 };
    const shrink = prefs.on('mini.shrink');
    let unread = 0;
    let closed = false;
    let scheduled = false;
    let lastKeyAt = Date.now();
    let flash = null;
    let result = {};

    const label = (key) => (key ? (key[0] === '#' ? key : key.slice(1)) : 'nobody yet');

    function add(text) {
      feed.push(text);
      if (feed.length > 200) feed.splice(0, feed.length - 150);
    }

    function onLine(item) {
      if (item.t === 'msg') {
        const mine = item.msg.from === app.me;
        const t = prefs.val('time') === 'off' ? '' : Th.dim(clock(item.msg.ts, '24h')) + ' ';
        const who = mine ? A.paint(`you → ${label(item.key)}`, { bold: true })
          : R.user(item.msg.from) + (item.key[0] === '#' ? Th.dim(' in ') + Th.paint('server', item.key) : '');
        add(t + who + Th.dim(': ') + (item.msg.file ? '📎 ' + item.msg.file.name : String(item.msg.text).replace(/\s+/g, ' ')));
        if (!mine) {
          unread++;
          if (!ed.text && app.target !== item.key) app.setTarget(item.key); // replies go to whoever wrote last
          if (Date.now() - lastKeyAt > 10000 && !app.muted(item.key)) notify.message(prefs.val('notify'), item.key, item.msg);
        }
      } else if (item.t === 'note') add(Th.dim('· ' + item.text.replace(/\s+/g, ' ')));
      else if (item.t === 'rows') for (const l of R.rowsLines(item.rows, 200).slice(0, 12)) add(l);
      schedule();
    }

    function cycle() {
      const keys = [];
      for (const p of app.contacts()) keys.push('@' + p.name);
      for (const r of app.rooms()) keys.push('#' + r);
      if (app.target && !keys.includes(app.target)) keys.unshift(app.target);
      if (!keys.length) { flash = { text: 'Nobody to talk to yet - add someone in the full chat first', until: Date.now() + 3000 }; return; }
      app.setTarget(keys[(keys.indexOf(app.target) + 1) % keys.length]);
    }

    function draw() {
      scheduled = false;
      if (closed) return;
      const W = Math.max(24, out.columns || 80);
      const H = Math.max(4, out.rows || 24);
      const st = app.conn.state;
      const dot = st === 'online' ? Th.ok('●') : st === 'connecting' ? Th.warn('◌') : Th.err('○');
      const head = ' ' + Th.accent('gossip', { bold: true }) + ' ' + dot + ' ' + Th.dim(app.me || '');
      const badge = unread ? Th.accent2(` ${unread} new `, { bold: true, inverse: true }) : '';
      const lines = [head + ' '.repeat(Math.max(1, W - A.vwidth(head) - A.vwidth(badge) - 1)) + badge];
      const room = H - 3;
      const shown = feed.slice(-room);
      for (let i = 0; i < room - shown.length; i++) lines.push('');
      for (const l of shown) lines.push(' ' + A.clip(l, W - 2));
      const to = Th.dim('→ ') + (app.target ? R.label(app.target) : Th.dim('nobody yet')) + ' ' + Th.accent2(prefs.val('prompt.symbol'), { bold: true }) + ' ';
      const pw = A.vwidth(to) + 1;
      const lay = ed.layout(Math.max(6, W - pw - 1), 1);
      lines.push(' ' + to + lay.lines[0]);
      const call = app.calls && app.calls.current;
      const callLine = call ? (call.state === 'ringing' ? `${call.peer} is calling · enter answers` : `${call.state === 'live' ? '● call with' : 'calling'} ${call.peer} · /hangup`) : null;
      const hint = flash && flash.until > Date.now() ? flash.text : (callLine || app.typingText() || `tab: switch · enter: send · esc: ${back ? 'full chat' : 'quit'}`);
      lines.push(' ' + Th.dim(A.ellipsis(hint, W - 2)));
      const paint = P.sync(); // (the daylight theme paints the window light)
      let buf = '\x1b[?2026h\x1b[?25l' + (paint ? paint + P.ink() + '\x1b[2J' : '') + '\x1b[H';
      for (let y = 0; y < lines.length; y++) buf += `\x1b[${y + 1};1H` + A.paperize(`\x1b[2K${lines[y]}${A.RESET}`);
      buf += `\x1b[${H - 1};${pw + lay.col + 1}H\x1b[?25h\x1b[?2026l`;
      out.write(buf);
    }

    function schedule() {
      if (scheduled || closed) return;
      scheduled = true;
      setImmediate(draw);
    }

    const hooks = [];
    const hook = (target, event, fn) => { target.on(event, fn); hooks.push([target, event, fn]); };

    function finish() {
      if (closed) return;
      closed = true;
      clearInterval(ticker);
      for (const [target, event, fn] of hooks) target.removeListener(event, fn);
      try {
        out.write(P.restore() + (shrink ? `\x1b[8;${was.rows};${was.cols}t` : '') + '\x1b[?2004l\x1b[?25h\x1b[?1049l');
      } catch { /* terminal gone */ }
      try { inp.setRawMode(false); } catch { /* not a tty any more */ }
      inp.pause();
      resolve(result);
    }

    const ctx = {
      app, shell: true, quit: finish, play: () => Promise.resolve(), view: 'mini', noTarget: 'Press Tab to pick who to write to.',
      restart() { result = { restart: true }; finish(); },
    };
    const printable = (s) => typeof s === 'string' && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s);

    function onKey(str, key) {
      if (closed) return;
      key = key || {};
      lastKeyAt = Date.now();
      unread = 0;
      const name = key.name;
      if (name === 'escape') {
        if (ed.text) ed.clear();
        else { if (back) result = { switch: back }; return finish(); }
      } else if (key.ctrl && (name === 'c' || name === 'd')) {
        if (ed.text && name === 'c') ed.clear(); else return finish();
      } else if (key.ctrl && name === 'u') ed.killToStart();
      else if (key.ctrl && name === 'w') ed.deleteWord();
      else if (name === 'return') {
        const text = ed.text;
        if (!text.trim() && app.calls && app.calls.ringing) app.calls.answer().catch((e) => app.say(e.message, 'err'));
        if (text.trim()) {
          ed.clear();
          handleInput(ctx, text).catch((e) => app.say(e.message || String(e), 'err'));
        }
      } else if (name === 'tab') cycle();
      else if (name === 'backspace') ed.backspace();
      else if (name === 'left') ed.left();
      else if (name === 'right') ed.right();
      else if (name === 'home') ed.home();
      else if (name === 'end') ed.end();
      else if (!key.ctrl && !key.meta && printable(str)) {
        ed.insert(str);
        if (app.target && !'/@#'.includes(ed.text[0])) app.typingPing();
      }
      return schedule();
    }

    hook(app, 'line', onLine);
    hook(app, 'change', schedule);
    hook(app, 'flash', (text) => { flash = { text, until: Date.now() + 3000 }; schedule(); });
    hook(app, 'bell', () => { if (!closed && Date.now() - lastKeyAt > 10000) out.write('\x07'); });
    hook(process, 'SIGTERM', finish);
    hook(process, 'SIGHUP', finish);
    hook(process, 'unhandledRejection', (e) => { if (!closed) app.say(`Something went wrong: ${(e && e.message) || e}`, 'err'); });

    readline.emitKeypressEvents(inp, { escapeCodeTimeout: 50 });
    inp.setRawMode(true);
    inp.resume();
    hook(inp, 'keypress', onKey);
    hook(out, 'resize', schedule);
    // Ask the terminal to make its window small (most do; the rest ignore this).
    out.write('\x1b[?1049h' + P.sync() + P.ink() + '\x1b[2J\x1b[?2004h' + (shrink ? `\x1b[8;${ROWS};${COLS}t` : ''));
    if (!app.link) app.connect().catch(() => {});
    add(Th.dim('· Messages from all your chats show up here.'));
    const ticker = setInterval(() => {
      app.tick();
      if (flash && flash.until <= Date.now()) flash = null;
      schedule();
    }, 500);
    schedule();
  });
}

module.exports = { run };

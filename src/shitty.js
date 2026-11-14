'use strict';
// The live chat prompt.
//
// It runs *inside* your terminal, in the normal scrollback: messages print as
// ordinary lines (so you can scroll, select and copy them like any other
// output), and only a few lines at the bottom - the prompt, and the penguin
// while it's moving - are redrawn. No full-screen takeover.
//
// (This file's name is the project's one hidden quirk: the Shell-in-TTY.)

const readline = require('readline');
const A = require('./ansi');
const R = require('./render');
const Th = require('./theme');
const M = require('./mascot');
const prefs = require('./prefs');
const { plural } = require('./text');
const { Editor } = require('./editor');
const { suggest, handleInput, replay, pretty } = require('./commands');
const { Menu } = require('./menu');

function run(app, { firstRun = false, notice = null } = {}) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const inp = process.stdin;
    const ed = new Editor();
    const printer = new R.Printer(app.me);

    let pending = []; // lines waiting to be printed above the prompt
    let held = []; // lines that arrived while the penguin had the stage
    let stage = null; // something animated sitting above the prompt
    let region = null; // what the redrawn area looked like last time
    let lastSig = '';
    let scheduled = false;
    let closed = false;
    let pasting = false;
    let pal = null; // suggestions under the prompt
    let hiddenFor = null;
    let flash = null;
    let quitArmedUntil = 0;
    let lastKeyAt = Date.now();
    let shownTarget;
    const hist = [];
    let histIndex = 0;
    let draft = '';

    const host = () => {
      try { return new URL(app.serverUrl).host; } catch { return app.serverUrl || 'no relay set'; }
    };

    // ── the prompt area ───────────────────────────────────────────────────

    function statusDot() {
      const st = app.conn.state;
      if (st === 'online') return Th.ok('●');
      if (st === 'connecting') return Th.warn('◌');
      return st === 'offline' ? Th.err('○') : Th.dim('○');
    }

    function footer(w) {
      const typing = app.typingText();
      const flashing = flash && flash.until > Date.now();
      const st = app.conn.state;
      const d = app.conn.detail || {};
      const quiet = prefs.val('footer') === 'off';
      if (quiet && !flashing && !typing && st === 'online') return null;

      let right;
      if (st === 'online') right = statusDot() + ' ' + Th.dim(`${app.me} · ${host()}`);
      else if (st === 'connecting') right = statusDot() + ' ' + Th.dim('connecting…');
      else if (st === 'offline') {
        const secs = d.retryAt ? Math.max(1, Math.ceil((d.retryAt - Date.now()) / 1000)) : 0;
        right = statusDot() + ' ' + Th.dim(`offline${d.message ? ' · ' + d.message : ''}${secs ? ` · retrying in ${secs}s` : ''}`);
      } else right = Th.dim('not connected');
      // the left side shrinks first, so who-you-are and the connection stay readable
      const rw = A.vwidth(right);
      const options = flashing ? [flash.text] : typing ? [typing] : menu.active || quiet ? [''] : ['tab opens the menu · /help for commands', 'tab opens the menu', 'tab: menu', ''];
      const text = options.find((t) => 2 + A.width(t) + 2 + rw <= w);
      const left = '  ' + Th.dim(text === undefined ? A.ellipsis(options[0], Math.max(0, w - rw - 4)) : text);
      const lw = A.vwidth(left);
      if (lw + rw + 1 > w) right = A.clip(right, Math.max(0, w - lw - 1));
      return left + ' '.repeat(Math.max(1, w - lw - A.vwidth(right))) + right;
    }

    function paletteLines(w, max) {
      const items = pal.items;
      const n = Math.max(1, Math.min(items.length, max));
      let top = pal.top || 0;
      if (pal.index >= 0) {
        if (pal.index < top) top = pal.index;
        if (pal.index >= top + n) top = pal.index - n + 1;
      }
      top = Math.max(0, Math.min(top, items.length - n));
      pal.top = top;
      let labelW = 0;
      for (const it of items) labelW = Math.max(labelW, A.width(it.label) + (it.hint ? A.width(it.hint) + 1 : 0));
      labelW = Math.min(labelW, Math.floor(w * 0.5));
      const lines = [];
      for (let i = top; i < top + n; i++) {
        const it = items[i];
        const used = A.width(it.label) + (it.hint ? A.width(it.hint) + 1 : 0);
        const gap = ' '.repeat(Math.max(2, labelW - used + 3));
        const head = i === pal.index ? '  ' + Th.accent2('›', { bold: true }) + ' ' + Th.accent(it.label, { bold: true }) : '    ' + it.label;
        lines.push(A.clip(head + (it.hint ? Th.dim(' ' + it.hint) : '') + gap + Th.dim(it.desc || ''), w));
      }
      if (items.length > n) lines.push(Th.dim(`    … ${items.length - n} more - keep typing to narrow it down`));
      return lines;
    }

    function refreshPalette() {
      if (hiddenFor === ed.text) { pal = null; return; }
      hiddenFor = null;
      const s = suggest(app, ed.text);
      if (!s) { pal = null; return; }
      const same = pal && pal.text === ed.text;
      let index = s.stage === 'cmd' ? 0 : -1;
      if (same) index = Math.min(pal.index, s.items.length - 1);
      pal = { ...s, index, top: same ? pal.top : 0, text: ed.text };
    }

    function buildRegion(cols, rows) {
      const w = Math.max(20, cols - 1); // never write into the last column
      const lines = [];
      if (stage) for (const l of stage.block(cols)) lines.push(A.clip(l, w));
      if (menu.active) for (const l of menu.lines(w - 1, Math.max(5, rows - lines.length - 8))) lines.push(' ' + l);
      const top = lines.length;

      const style = prefs.val('prompt.style');
      const symbol = Th.accent2(prefs.val('prompt.symbol'), { bold: true });
      const prompt = (app.target ? R.label(app.target) + ' ' : '') + symbol + ' ';
      const pw = A.vwidth(prompt);
      const boxed = style === 'box';
      const textW = Math.max(8, w - pw - (boxed ? 4 : 0));
      const lay = ed.layout(textW, Math.max(1, Math.min(5, rows - top - 8)));
      const typed = lay.lines.map((l, i) => (i === 0 && lay.top === 0 ? prompt : ' '.repeat(pw)) + l);

      let row;
      let col;
      if (boxed) {
        const inner = w - 2;
        lines.push(Th.border('╭' + '─'.repeat(inner) + '╮'));
        for (const l of typed) lines.push(Th.border('│') + ' ' + R.fit(l, inner - 2) + ' ' + Th.border('│'));
        lines.push(Th.border('╰' + '─'.repeat(inner) + '╯'));
        row = top + 1 + lay.row;
        col = 2 + pw + lay.col;
      } else {
        if (style === 'rules') lines.push(Th.border('─'.repeat(w)));
        for (const l of typed) lines.push(l);
        if (style === 'rules') lines.push(Th.border('─'.repeat(w)));
        row = top + (style === 'rules' ? 1 : 0) + lay.row;
        col = pw + lay.col;
      }

      if (menu.active) pal = null; else refreshPalette();
      if (pal) for (const l of paletteLines(w, Math.max(1, Math.min(6, rows - lines.length - 3)))) lines.push(l);
      else {
        const f = footer(w);
        if (f) lines.push(f);
      }
      return { lines, row, col };
    }

    // Escape codes that move from wherever the cursor is to the top-left of the
    // redrawn area (allowing for lines the terminal re-wrapped after a resize).
    function toRegionTop() {
      if (!region) return '\r';
      const cols = out.columns || 80;
      let up = 0;
      for (let i = 0; i < region.row; i++) up += Math.max(1, Math.ceil(region.widths[i] / cols));
      return (up ? `\x1b[${up}A` : '') + '\r';
    }

    function flush() {
      scheduled = false;
      if (closed) return;
      const cols = out.columns || 80;
      const rows = out.rows || 24;
      const r = buildRegion(cols, rows);
      const sig = `${cols}|${r.row},${r.col}|${r.lines.join('\n')}`;
      if (!pending.length && region && sig === lastSig) return;

      // 2026 = "synchronized output": terminals that support it show this all at once
      let buf = '\x1b[?2026h\x1b[?25l' + toRegionTop() + '\x1b[J';
      for (const l of pending) buf += l + A.RESET + '\r\n';
      pending = [];
      buf += r.lines.join(A.RESET + '\r\n');
      const up = r.lines.length - 1 - r.row;
      if (up > 0) buf += `\x1b[${up}A`;
      buf += '\r' + (r.col > 0 ? `\x1b[${r.col}C` : '') + '\x1b[?25h\x1b[?2026l';
      region = { widths: r.lines.map(A.vwidth), row: r.row };
      lastSig = sig;
      out.write(buf);
    }

    function schedule() {
      if (scheduled || closed) return;
      scheduled = true;
      setImmediate(flush);
    }

    /** Print lines into the scrollback, above the prompt. */
    function print(lines) {
      const into = stage ? held : pending; // nothing jumps ahead of the penguin
      for (const l of lines) into.push(l);
      schedule();
    }

    function show(item) {
      const lines = printer.lines(item, out.columns || 80);
      print(item.t === 'rows' ? ['', ...lines, ''] : lines);
    }

    // ── the penguin's stage ───────────────────────────────────────────────

    const spriteOpts = () => ({ mode: Th.spriteMode(), speed: prefs.val('mascot.speed'), markStyle: R.markStyle() });

    /**
     * Play frames above the prompt, then leave the last picture in the scrollback.
     * block(lines) wraps the penguin's lines into whatever should be shown.
     */
    function perform(frames, last, block) {
      return new Promise((done) => {
        let i = 0;
        let timer = null;
        const finish = () => {
          if (stage !== me) return;
          clearTimeout(timer);
          stage = null;
          pending.push(...block(last, out.columns || 80), ...held);
          held = [];
          schedule();
          done();
        };
        const me = { block: (cols) => block(frames[i].lines, cols), finish };
        const step = () => {
          if (stage !== me || closed) return;
          i++;
          if (i >= frames.length) return finish();
          schedule();
          timer = setTimeout(step, frames[i].ms);
        };
        stage = me;
        timer = setTimeout(step, frames[0].ms);
        schedule();
      });
    }

    /**
     * A welcome without animation: wait a moment for the connection, so the
     * panel that stays in the scrollback says "connected" rather than "connecting".
     */
    function holdUntilReady(lines) {
      let timer = null;
      const me = {
        block: () => [],
        finish: () => {
          if (stage !== me) return;
          clearTimeout(timer);
          app.removeListener('synced', me.finish);
          stage = null;
          pending.push(...lines(), ...held);
          held = [];
          schedule();
        },
      };
      stage = me;
      app.once('synced', me.finish);
      timer = setTimeout(me.finish, 1500);
    }

    function welcomeInfo(sprite) {
      const st = app.conn.state;
      const first = st === 'online' ? Th.ok('●') + ' connected' : st === 'connecting' ? Th.warn('◌') + ' connecting…' : Th.err('○') + ' offline, still trying';
      const contacts = app.contacts();
      const online = contacts.filter((p) => app.presence.get(p.name)).length;
      return {
        me: app.me, host: host(), firstRun, sprite,
        status: [
          first + Th.dim(' · end-to-end encrypted'),
          Th.dim(`${plural(contacts.length, 'contact')}${online ? ` (${online} online)` : ''} · ${plural(app.rooms().length, 'server')}`),
        ],
      };
    }

    function greet() {
      const cols = out.columns || 80;
      const rows = out.rows || 24;
      const want = prefs.val('mascot');
      if (want === 'off' || prefs.val('welcome') === 'off' || cols < 44) {
        holdUntilReady(() => R.welcome(welcomeInfo(null), out.columns || 80));
        return;
      }
      const scene = M.pickScene(want);
      const opts = spriteOpts();
      const last = M.still(scene, opts);
      const block = (sprite, c) => R.welcome(welcomeInfo(sprite), c);
      const tall = block(last, cols).length + 8;
      if (!prefs.on('mascot.animate') || rows < tall) {
        holdUntilReady(() => block(last, out.columns || 80));
        return;
      }
      perform(M.play(scene, { ...opts, loops: scene === 'dance' ? 1 : 2 }), last, block);
    }

    /** /dance: the penguin performs on request. */
    function play(scene) {
      if (stage) stage.finish();
      const opts = spriteOpts();
      const block = (sprite) => ['', ...sprite.map((l) => ' ' + l), ''];
      if ((out.rows || 24) < M.HEIGHT + 10) {
        print(block(M.still(scene, opts)));
        return Promise.resolve();
      }
      return perform(M.play(scene, { ...opts, loops: 2 }), M.still(scene, opts), block);
    }

    // ── leaving ───────────────────────────────────────────────────────────

    function restore() {
      try {
        out.write('\x1b[?2026h' + toRegionTop() + '\x1b[J\x1b[?2004l\x1b[?25h\x1b[?2026l');
      } catch { /* terminal already gone */ }
      try { inp.setRawMode(false); } catch { /* not a tty any more */ }
      inp.pause();
    }

    let result = {};
    const hooks = [];
    const hook = (target, event, fn) => { target.on(event, fn); hooks.push([target, event, fn]); };

    function quit() {
      if (closed) return;
      if (stage) {
        stage.finish();
        flush();
      }
      closed = true;
      clearInterval(ticker);
      for (const [target, event, fn] of hooks) target.removeListener(event, fn);
      restore();
      region = null;
      resolve(result);
    }

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

    // ── what you type ─────────────────────────────────────────────────────

    const ctx = {
      app, shell: true, quit, play, view: 'classic',
      noTarget: 'Who to? Press Tab to pick someone, or start with @username - for example: @maya hey',
      switchView(view) {
        prefs.set(app.vault, 'view', view);
        app.settings = app.vault.loadSettings();
        result = { switch: view };
        quit();
      },
    };
    const menu = new Menu(ctx, () => schedule());
    const handle = (raw) => handleInput(ctx, raw);

    function submit() {
      let text = ed.text;
      if (pal && pal.index >= 0 && pal.items[pal.index]) {
        const it = pal.items[pal.index];
        if (pal.stage === 'cmd') {
          if (it.needsArg) { ed.set(it.value + ' '); return; } // show what it needs instead of running it empty
          text = it.value;
        } else if (it.value[0] === '/') {
          text = it.value;
        } else {
          ed.set(it.value + ' '); // picked who to talk to: keep typing the message
          return;
        }
      }
      if (!text.trim()) return;
      if (stage) stage.finish(); // don't make anyone wait for the penguin
      ed.clear();
      hiddenFor = null;
      if (hist[hist.length - 1] !== text) hist.push(text);
      if (hist.length > 200) hist.shift();
      histIndex = hist.length;
      draft = '';
      handle(text).catch((e) => app.say(e.message || String(e), 'err'));
    }

    function recall(step) {
      if (!hist.length) return;
      if (histIndex === hist.length) draft = ed.text;
      histIndex = Math.max(0, Math.min(hist.length, histIndex + step));
      ed.set(histIndex === hist.length ? draft : hist[histIndex]);
    }

    function movePalette(step) {
      const n = pal.items.length;
      pal.index = pal.index < 0 ? (step > 0 ? 0 : n - 1) : (pal.index + step + n) % n;
    }

    function completeFromPalette() {
      const it = pal.items[pal.index >= 0 ? pal.index : 0];
      ed.set(it.value + (pal.stage === 'arg' || it.hint ? ' ' : ''));
    }

    // Tab on an empty line: hop between the people and servers you talk to.
    function cycleTarget(step) {
      const keys = [];
      for (const k of app.vault.conversations()) if (k[0] === '@') keys.push(k);
      for (const p of app.contacts()) if (!keys.includes('@' + p.name)) keys.push('@' + p.name);
      for (const r of app.rooms()) keys.push('#' + r);
      if (!keys.length) return;
      const i = keys.indexOf(app.target);
      app.setTarget(keys[i < 0 ? 0 : (i + step + keys.length) % keys.length]);
    }

    function ctrlC() {
      if (ed.text) { ed.clear(); return; }
      if (Date.now() < quitArmedUntil) { quit(); return; }
      quitArmedUntil = Date.now() + 2000;
      flash = { text: 'Press Ctrl+C again to leave', until: quitArmedUntil };
    }

    const printable = (s) => typeof s === 'string' && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s);

    function onKey(str, key) {
      if (closed) return;
      key = key || {};
      const seq = key.sequence || '';
      const name = key.name;
      lastKeyAt = Date.now();

      if (seq === '\x1b[200~' || name === 'paste-start') { pasting = true; return; }
      if (seq === '\x1b[201~' || name === 'paste-end') { pasting = false; schedule(); return; }
      if (menu.active && !pasting) { menu.key(str, key); schedule(); return; }
      const before = ed.text;

      if (pasting) {
        if (name === 'return' || name === 'enter') ed.insert('\n');
        else if (name === 'tab') ed.insert('  ');
        else if (printable(str)) ed.insert(str);
      } else if (name === 'escape') {
        // (Node reports a lone Esc with meta=true, so it's handled before the Alt shortcuts.)
        if (pal) hiddenFor = ed.text; else ed.clear();
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
          case 'l': out.write('\x1b[2J\x1b[H'); region = null; lastSig = ''; break;
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
          case 'backspace': ed.backspace(); break;
          case 'delete': ed.del(); break;
          case 'left': ed.left(); break;
          case 'right': ed.right(); break;
          case 'home': ed.home(); break;
          case 'end': ed.end(); break;
          case 'up': if (pal) movePalette(-1); else recall(-1); break;
          case 'down': if (pal) movePalette(1); else recall(1); break;
          case 'tab':
            if (pal) completeFromPalette();
            else if (!ed.text && key.shift) cycleTarget(1); // Shift+Tab: hop to the next chat
            else if (!ed.text) menu.open();
            break;
          default:
            if (printable(str)) ed.insert(str);
        }
      }

      if (closed) return;
      if (ed.text !== before && ed.text && !'/@#'.includes(ed.text[0])) app.typingPing();
      schedule();
    }

    function onResize() {
      lastSig = '';
      schedule();
    }

    // When you switch who you're talking to, optionally replay the last few lines.
    function onChange() {
      if (app.target !== shownTarget) {
        const first = shownTarget === undefined;
        shownTarget = app.target;
        const n = prefs.val('recap');
        if (n > 0 && app.target && !first && app.vault.loadHistory(app.target, 1).length) {
          print([Th.dim(`  ── earlier with ${pretty(app.target)} ──`)]);
          replay(app, app.target, n);
        }
      }
      schedule();
    }

    // ── wiring ────────────────────────────────────────────────────────────

    hook(app, 'line', show);
    hook(app, 'line', (item) => {
      if (item.t === 'msg' && item.msg.from !== app.me && !app.muted(item.key) && Date.now() - lastKeyAt > 10000) {
        require('./notify').message(prefs.val('notify'), item.key, item.msg);
      }
    });
    hook(app, 'change', onChange);
    hook(app, 'flash', (text) => {
      flash = { text, until: Date.now() + 3000 };
      schedule();
    });
    hook(app, 'bell', () => {
      // only make a sound if you don't seem to be looking (nothing typed for a bit)
      if (!closed && Date.now() - lastKeyAt > 10000) out.write('\x07');
    });

    hook(process, 'SIGTERM', quit);
    hook(process, 'SIGHUP', quit);
    hook(process, 'uncaughtException', crash);
    // a failed background task shouldn't take the whole chat down with it
    hook(process, 'unhandledRejection', (e) => {
      if (!closed) app.say(`Something went wrong: ${(e && e.message) || e}`, 'err');
    });

    readline.emitKeypressEvents(inp, { escapeCodeTimeout: 50 });
    inp.setRawMode(true);
    inp.resume();
    hook(inp, 'keypress', onKey);
    hook(out, 'resize', onResize);
    out.write('\x1b[?2004h'); // bracketed paste: pasted newlines don't send half a message

    shownTarget = app.target;
    if (!app.link) {
      app.connect().catch((e) => {
        if (e.code === 'no_server') app.say('No relay is set. Use /relay <address> to connect to one.', 'warn');
      });
    }
    greet();
    if (notice) app.say(notice, 'sys');

    const ticker = setInterval(() => {
      app.tick();
      if (flash && flash.until <= Date.now()) flash = null;
      schedule();
    }, 250);
    schedule();
  });
}

module.exports = { run };

'use strict';
// Menus: everything gossip can do, without typing a command.
//
// A menu is a stack of pages. A page is either a list you move through with the
// arrow keys, or a single question you type an answer to. Choosing something
// runs the very same code the commands do (commands.js), so the two can't drift.
//
// This file only keeps track of where you are and turns that into lines of
// text; the full chat screen and the classic prompt each decide where to draw it.

const A = require('./ansi');
const Th = require('./theme');
const M = require('./mascot');
const P = require('./proto');
const prefs = require('./prefs');
const { runCommand, people } = require('./commands');
const { plural } = require('./text');

// ── the pages ───────────────────────────────────────────────────────────────

const run = (m, line) => () => m.run(line);
const currentRoom = (app) => (app.target && app.target[0] === '#' ? app.target.slice(1) : null);

function ask(title, question, hint, submit) {
  return () => ({ title, ask: question, hint, submit });
}

function confirm(title, yes, action) {
  return () => ({ title, items: [{ label: yes, run: action }, { label: 'Never mind', run: () => 'back' }] });
}

function root(m) {
  return {
    title: 'Menu',
    items: [
      { label: 'Chat with…', desc: 'pick a person or a server', run: () => chats },
      { label: 'Add a person', desc: 'by their username', run: () => addPerson },
      { label: 'Servers', desc: 'group chats: join, create, invite, remove', run: () => servers },
      { label: 'People', desc: 'contacts, blocking, safety numbers', run: () => peoplePage },
      { label: 'Make it yours', desc: 'colours, penguin, layout, every setting', run: () => looks },
      { label: 'This chat', desc: 'mute, search, save to a file', run: () => thisChat },
      { label: "What's new", desc: 'update notes', run: run(m, 'changelog') },
      { label: 'Help', desc: 'keys and commands', run: run(m, 'help') },
      { label: 'Leave gossip', run: () => m.ctx.quit() },
    ],
  };
}

function chats(m) {
  const { app } = m;
  const items = [{
    label: 'Someone new…', desc: 'type their username',
    run: ask('Chat with…', 'Their username', P.NAME_HELP, (t) => m.run('to @' + P.cleanName(t))),
  }];
  for (const p of people(app)) {
    items.push({ label: '@' + p.name, desc: p.desc, name: p.name, run: () => app.setTarget('@' + p.name) });
  }
  for (const r of app.rooms()) items.push({ label: '#' + r, desc: 'server', room: true, run: () => app.setTarget('#' + r) });
  return { title: 'Chat with…', items, filter: true };
}

function thisChat(m) {
  const { app } = m;
  const key = app.target;
  const items = [];
  if (key) {
    items.push({ label: app.muted(key) ? 'Unmute this chat' : 'Mute this chat', desc: 'no sound, no unread count', run: run(m, 'mute') });
    items.push({ label: 'Save this chat to a file', desc: 'a plain text file in the current folder', run: run(m, 'export') });
    items.push({ label: 'Show older messages', run: run(m, 'recap 50') });
  }
  items.push({ label: 'Find a message…', desc: 'search everything saved on this computer', run: ask('Find a message', 'Words to look for', null, (t) => m.run('find ' + t)) });
  return { title: key ? `This chat (${key})` : 'Chats', items };
}

const addPerson = ask('Add a person', 'Their username', 'They get added to your contacts - you can see when they are online.', function add(t) {
  return this.run('add ' + P.cleanName(t));
});

function servers(m) {
  const { app } = m;
  const room = currentRoom(app);
  const chat = room && app.chats.get('#' + room);
  const items = [
    { label: 'Join a server', desc: 'find a group to chat in', run: () => joinPage },
    { label: 'Create a server', desc: 'start your own group', run: () => createPage },
  ];
  if (room) {
    items.push({ label: `Invite someone to #${room}`, run: () => invitePage });
    items.push({ label: `See who is in #${room}`, run: run(m, 'who ' + room) });
    if (chat && chat.owner === app.me) {
      items.push({ label: `Remove someone from #${room}`, desc: 'you own this server', run: () => kickPage });
      items.push({ label: `Hand #${room} to someone else`, desc: 'make another member the owner', run: () => givePage });
    }
    items.push({ label: `Leave #${room}`, run: confirm(`Leave #${room}?`, `Yes, leave #${room}`, run(m, 'leave ' + room)) });
  }
  items.push({ label: 'My servers', desc: plural(app.rooms().length, 'server'), run: run(m, 'servers') });
  return { title: 'Servers', items, note: room ? null : 'Open a server first to invite or remove people.' };
}

async function joinPage(m) {
  const { app } = m;
  await app.refreshRooms(true);
  const items = [];
  const seen = new Set();
  for (const [room, by] of app.invites) {
    seen.add(room);
    items.push({ label: '#' + room, desc: `invited by ${by}`, run: run(m, 'join ' + room) });
  }
  for (const r of app.knownRooms) {
    if (!seen.has(r.name) && !r.joined) items.push({ label: '#' + r.name, desc: plural(r.members, 'member'), run: run(m, 'join ' + r.name) });
  }
  items.push({ label: 'Type a name…', desc: 'for an invite-only server', run: ask('Join a server', 'Server name', P.ROOM_HELP, (t) => m.run('join ' + P.cleanName(t))) });
  return { title: 'Join a server', items, filter: true };
}

const createPage = ask('Create a server', 'Name for the new server', P.ROOM_HELP, function create(t) {
  const name = P.cleanName(t);
  if (!P.validRoom(name)) throw new Error(P.ROOM_HELP);
  return () => ({
    title: `Create #${name}`,
    items: [
      { label: 'Open to everyone', desc: 'anyone can find and join it', run: run(this, `create ${name}`) },
      { label: 'Invite-only', desc: 'people need an invite from a member', run: run(this, `create ${name} private`) },
    ],
  });
});

function invitePage(m) {
  const { app } = m;
  const room = currentRoom(app);
  const chat = app.chats.get('#' + room);
  const items = people(app).filter((p) => !(chat && chat.members.has(p.name)))
    .map((p) => ({ label: '@' + p.name, desc: p.desc, run: run(m, `invite ${p.name} ${room}`) }));
  items.push({ label: 'Someone else…', desc: 'type their username', run: ask(`Invite to #${room}`, 'Their username', P.NAME_HELP, (t) => m.run(`invite ${P.cleanName(t)} ${room}`)) });
  return { title: `Invite to #${room}`, items, filter: true };
}

function kickPage(m) {
  const { app } = m;
  const room = currentRoom(app);
  const chat = app.chats.get('#' + room);
  const names = chat ? [...chat.members.keys()].filter((n) => n !== app.me) : [];
  return {
    title: `Remove from #${room}`,
    note: 'They stop getting messages and need your invite to come back. It works even if they are offline.',
    items: names.map((n) => ({
      label: '@' + n,
      run: confirm(`Remove ${n} from #${room}?`, `Yes, remove ${n}`, run(m, `kick ${n} ${room}`)),
    })).concat({
      label: 'Someone not listed…', desc: 'invited but not joined yet, or to keep them out',
      run: ask(`Keep out of #${room}`, 'Their username', P.NAME_HELP, (t) => m.run(`kick ${P.cleanName(t)} ${room}`)),
    }),
    filter: true,
  };
}

function givePage(m) {
  const { app } = m;
  const room = currentRoom(app);
  const chat = app.chats.get('#' + room);
  const names = chat ? [...chat.members.keys()].filter((n) => n !== app.me) : [];
  return {
    title: `Hand over #${room}`, filter: true,
    note: names.length ? 'The new owner is the only one who can remove people.' : 'Nobody else is here yet.',
    items: names.map((n) => ({ label: '@' + n, run: confirm(`Make ${n} the owner of #${room}?`, `Yes, hand it to ${n}`, run(m, `give ${n} ${room}`)) })),
  };
}

function pick(m, title, list, line, empty, other = false) {
  return () => {
    const items = list.map((name) => ({ label: '@' + name, run: run(m, `${line} ${name}`) }));
    if (other) items.push({ label: 'Someone else…', desc: 'type their username', run: ask(title, 'Their username', P.NAME_HELP, (t) => m.run(`${line} ${P.cleanName(t)}`)) });
    return { title, filter: true, note: items.length ? null : empty, items };
  };
}

function peoplePage(m) {
  const { app } = m;
  const contacts = app.contacts().map((p) => p.name);
  const known = people(app).map((p) => p.name);
  return {
    title: 'People',
    items: [
      { label: 'My contacts', desc: plural(contacts.length, 'contact'), run: run(m, 'contacts') },
      { label: 'Add a person', run: () => addPerson },
      { label: 'Remove a contact', run: pick(m, 'Remove a contact', contacts, 'remove', 'You have no contacts yet.') },
      { label: 'Check a safety number', desc: "make sure it's really them", run: pick(m, 'Check a safety number', known, 'verify', 'Nobody to check yet.', true) },
      { label: 'Block someone', desc: 'their messages stop arriving', run: pick(m, 'Block someone', known, 'block', 'Nobody to block yet.', true) },
      { label: 'Unblock someone', run: pick(m, 'Unblock someone', app.settings.blocked.slice(), 'unblock', 'Nobody is blocked.') },
      { label: 'Who am I?', desc: app.me, run: run(m, 'whoami') },
    ],
  };
}

function choices(m, key, title, about) {
  return () => {
    const o = prefs.OPTIONS.find((x) => x.key === key);
    const now = prefs.val(key);
    return {
      title,
      items: o.choices.map((c) => ({
        label: (c === now ? '✓ ' : '  ') + c, desc: about && about[c], stay: true,
        run: () => m.run(`config ${key} ${c}`),
      })),
      index: Math.max(0, o.choices.indexOf(now)),
    };
  };
}

function setting(m, o) {
  if (o.choices) return choices(m, o.key, o.key);
  const hint = o.number ? `A whole number from ${o.number[0]} to ${o.number[1]}` : `Up to ${o.text} characters`;
  return ask(o.key, o.desc, `${hint}. Now: ${prefs.val(o.key)}`, (t) => m.run(`config ${o.key} ${t}`));
}

function looks(m) {
  const themes = {};
  for (const [name, t] of Object.entries(Th.THEMES)) themes[name] = t.about;
  const scenes = { random: 'a different one each time', off: 'no penguin' };
  for (const name of M.SCENE_NAMES) scenes[name] = M.SCENES[name].about;
  const other = m.ctx.view === 'full' ? 'classic' : 'full';
  return {
    title: 'Make it yours',
    items: [
      { label: 'Colour theme', desc: prefs.val('theme'), run: choices(m, 'theme', 'Colour theme', themes) },
      { label: 'Penguin', desc: prefs.val('mascot'), run: choices(m, 'mascot', 'Penguin', scenes) },
      {
        label: other === 'classic' ? 'Switch to the classic look' : 'Switch to the full chat screen',
        desc: other === 'classic' ? 'messages scroll like normal terminal output' : 'chats on the left, messages on the right',
        run: () => m.ctx.switchView(other),
      },
      { label: 'Every setting…', desc: plural(prefs.OPTIONS.length, 'setting'), run: () => everything },
      { label: 'Put everything back to normal', run: confirm('Reset every setting?', 'Yes, reset them all', run(m, 'config reset all')) },
    ],
  };
}

function everything(m) {
  return {
    title: 'Every setting', filter: true,
    items: prefs.OPTIONS.map((o) => ({ label: o.key, desc: `${prefs.val(o.key)}  ·  ${o.desc}`, run: setting(m, o) })),
  };
}

// ── the menu itself ─────────────────────────────────────────────────────────

class Menu {
  /** ctx: what commands get ({ app, shell, quit, play }) plus view and switchView. */
  constructor(ctx, onChange = () => {}) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.onChange = onChange;
    this.stack = [];
    this.busy = false;
  }

  get active() {
    return this.stack.length > 0;
  }

  get page() {
    return this.stack[this.stack.length - 1];
  }

  run(line) {
    return runCommand(this.ctx, line);
  }

  open(spec = root) {
    this.stack = [];
    return this._go(spec);
  }

  close() {
    this.stack = [];
    this.onChange();
  }

  back() {
    this.stack.pop();
    this.onChange();
  }

  /** Show a page. `spec` is a page, or a function (maybe async) that builds one. */
  async _go(spec, replace = false, builder = null) {
    this.busy = true;
    this.onChange();
    try {
      const made = typeof spec === 'function' ? await spec.call(this, this) : spec;
      // `spec` on the page is whatever can build it again (to redraw after a change)
      const page = { index: 0, top: 0, query: '', value: '', ...made, spec: builder || spec };
      if (replace) this.stack.pop();
      this.stack.push(page);
    } catch (e) {
      this.app.say(e.message || String(e), 'err');
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  /** Do what an item (or a typed answer) asks, then go wherever that leads. */
  async _do(action, stay) {
    if (this.busy) return;
    this.busy = true;
    this.onChange();
    let next;
    try {
      next = await action();
    } catch (e) {
      this.busy = false;
      this.close();
      this.app.say(e.message || String(e), 'err');
      return;
    }
    this.busy = false;
    if (next === 'back') return this.back();
    if (typeof next === 'function') return this._go(next);
    if (next && typeof next === 'object' && next.title) return this._go(next, false, action);
    if (stay && this.active) return this._go(this.page.spec, true).then(() => undefined); // redraw with the new ✓
    return this.close();
  }

  shown() {
    const p = this.page;
    if (!p || !p.items) return [];
    const q = p.query.toLowerCase();
    return q ? p.items.filter((it) => it.label.toLowerCase().includes(q)) : p.items;
  }

  /** Returns true if the key was used. */
  key(str, key = {}) {
    const p = this.page;
    if (!p || this.busy) return true;
    const name = key.name;
    const printable = typeof str === 'string' && str.length > 0 && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str);
    if (name === 'escape' || (key.ctrl && name === 'c')) {
      if (this.stack.length > 1 && name === 'escape') this.back(); else this.close();
      return true;
    }
    if (p.ask) {
      if (name === 'return') {
        const text = p.value.trim();
        if (text) this._do(() => p.submit.call(this, text));
      } else if (name === 'backspace') p.value = Array.from(p.value).slice(0, -1).join('');
      else if (name === 'left' && !p.value) return this.back(), true;
      else if (printable && A.width(p.value) < 60) p.value += str;
      this.onChange();
      return true;
    }
    const list = this.shown();
    const n = list.length;
    switch (name) {
      case 'up': p.index = n ? (p.index - 1 + n) % n : 0; break;
      case 'down': p.index = n ? (p.index + 1) % n : 0; break;
      case 'pageup': p.index = Math.max(0, p.index - 5); break;
      case 'pagedown': p.index = Math.max(0, Math.min(n - 1, p.index + 5)); break;
      case 'home': p.index = 0; break;
      case 'end': p.index = Math.max(0, n - 1); break;
      case 'left': if (this.stack.length > 1) return this.back(), true; break;
      case 'tab': this.close(); return true;
      case 'right':
      case 'return': {
        const it = list[Math.min(p.index, n - 1)];
        if (it) this._do(it.run, it.stay);
        return true;
      }
      case 'backspace':
        if (p.query) { p.query = p.query.slice(0, -1); p.index = 0; }
        else if (this.stack.length > 1) return this.back(), true;
        break;
      default:
        if (printable && p.filter && str !== ' ') { p.query += str.toLowerCase(); p.index = 0; }
    }
    this.onChange();
    return true;
  }

  /** The menu as lines of text, at most `w` wide and `maxRows` tall. */
  lines(w, maxRows = 14) {
    const p = this.page;
    if (!p) return [];
    const W = Math.max(24, Math.min(w, 62));
    const inner = W - 4;
    const body = [];
    const row = (text) => body.push(text);
    let keys;

    if (p.ask) {
      row(A.paint(p.ask, { bold: true }));
      const caret = A.paint(' ', { inverse: true });
      row(Th.accent2(prefs.val('prompt.symbol'), { bold: true }) + ' ' + A.clip(p.value, inner - 4) + caret);
      if (p.hint) for (const l of A.wrap(p.hint, inner).slice(0, 3)) row(Th.dim(l));
      keys = 'enter ok · esc back';
    } else {
      const list = this.shown();
      if (p.index >= list.length) p.index = Math.max(0, list.length - 1);
      if (p.query) row(Th.dim('find: ') + p.query);
      const room = Math.max(3, maxRows - 2 - (p.query ? 1 : 0) - (p.note ? 1 : 0));
      const n = Math.min(list.length, room);
      if (p.index < p.top) p.top = p.index;
      if (p.index >= p.top + n) p.top = p.index - n + 1;
      p.top = Math.max(0, Math.min(p.top, list.length - n));
      let labelW = 0;
      for (const it of list) labelW = Math.max(labelW, A.width(it.label));
      labelW = Math.min(labelW, Math.floor(inner * 0.55));
      for (let i = p.top; i < p.top + n; i++) {
        const it = list[i];
        const on = i === p.index;
        const label = A.ellipsis(it.label, labelW);
        const pad = ' '.repeat(Math.max(0, labelW - A.width(label)) + 2);
        const head = on ? Th.accent2('›', { bold: true }) + ' ' + Th.accent(label, { bold: true }) : '  ' + label;
        row(A.clip(head + pad + Th.dim(it.desc || ''), inner));
      }
      if (!list.length) row(Th.dim(p.query ? 'Nothing matches.' : 'Nothing here yet.'));
      if (list.length > n) row(Th.dim(`  … ${list.length - n} more${p.filter ? ' - type to find one' : ''}`));
      if (p.note) for (const l of A.wrap(p.note, inner).slice(0, 2)) row(Th.dim(l));
      keys = '↑↓ move · enter choose · esc ' + (this.stack.length > 1 ? 'back' : 'close');
    }

    const trail = this.stack.map((x) => x.title).slice(-2).join(' › ');
    const title = ' ' + A.ellipsis(this.busy ? trail + ' …' : trail, inner - 2) + ' ';
    const foot = ' ' + A.ellipsis(keys, inner - 2) + ' ';
    const fill = (text) => '─'.repeat(Math.max(0, W - 3 - A.width(text)));
    const out = [Th.border('╭─') + Th.accent(title, { bold: true }) + Th.border(fill(title) + '╮')];
    for (const l of body) out.push(Th.border('│') + ' ' + l + ' '.repeat(Math.max(0, inner - A.vwidth(l))) + ' ' + Th.border('│'));
    out.push(Th.border('╰─') + Th.dim(foot) + Th.border(fill(foot) + '╯'));
    return out;
  }
}

module.exports = { Menu, pages: { root, chats, addPerson, servers, peoplePage, looks } };

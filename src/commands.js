'use strict';
// The commands. Each one works in two places:
//
//   in your shell           gossip squawk maya hey there
//   inside the live prompt  /squawk maya hey there      (or just: @maya hey there)
//
// A command gets ctx = { app, shell, quit, stdin, play }. Whatever it wants to
// show goes through app.say() / app.rows(), which both places know how to print.

const P = require('./proto');
const e2e = require('./e2e');
const prefs = require('./prefs');
const Th = require('./theme');
const M = require('./mascot');
const { plural, distance, emojify } = require('./text');

function userArg(app, raw, { allowSelf = false } = {}) {
  const name = P.cleanName(raw);
  if (!name) return null;
  if (!allowSelf && name === app.me) throw new Error("That's you - pick someone else.");
  if (!P.validName(name)) throw new Error(`"${raw}" isn't a valid username. ${P.NAME_HELP}.`);
  return name;
}

function roomArg(raw) {
  const name = P.cleanName(String(raw || '').replace(/^(room|server):/i, ''));
  if (!name) return null;
  if (!P.validRoom(name)) throw new Error(`"${raw}" isn't a valid server name. ${P.ROOM_HELP}.`);
  return name;
}

/** The server a command is about: the one named, or the one you're talking in. */
function roomOrCurrent(app, raw, what) {
  const room = raw ? roomArg(raw) : app.target && app.target[0] === '#' ? app.target.slice(1) : null;
  if (!room) throw new Error(`Which server? ${app.hint(what)}`);
  return room;
}

function needOnline(app) {
  if (!app.link || !app.link.online) throw new Error("You're offline right now - try again once you're reconnected.");
}

/**
 * Work out who "maya", "@maya", "gamedev", "#gamedev", "server:gamedev" or
 * "user:maya" means. Returns '@name' or '#server'.
 * Bare names work so you never have to type # or @ in a shell (where # starts
 * a comment and PowerShell treats @ specially).
 */
async function resolveTarget(app, raw) {
  let s = String(raw || '').trim().toLowerCase();
  let kind = null;
  if (s.startsWith('@')) { kind = 'dm'; s = s.slice(1); }
  else if (s.startsWith('#')) { kind = 'room'; s = s.slice(1); }
  else if (s.startsWith('user:')) { kind = 'dm'; s = s.slice(5); }
  else if (s.startsWith('server:')) { kind = 'room'; s = s.slice(7); }
  else if (s.startsWith('room:')) { kind = 'room'; s = s.slice(5); }
  if (!s) throw new Error('Who to? Give a username or a server name.');

  const joined = app.rooms().includes(s);
  if (kind === 'room') {
    if (!P.validRoom(s)) throw new Error(`"${raw}" isn't a valid server name.`);
    if (!joined) throw new Error(`You're not in #${s}. Join it first: ${app.hint(`join ${s}`)}`);
    return '#' + s;
  }
  if (kind === null && joined) {
    if (app.peers.get(s)) throw new Error(`"${s}" is both a server you're in and a person. Say which: server:${s} or user:${s}`);
    return '#' + s;
  }
  if (s === app.me) throw new Error("That's you - pick someone else.");
  if (!P.validName(s)) throw new Error(`"${raw}" isn't a username or a server you're in.`);
  try {
    await app.peerFor(s);
  } catch (e) {
    if (e.code === 'no_such_user') {
      throw new Error(kind === 'dm' ? `There's no user called ${s}.` : `There's no user called ${s}, and you're not in a server by that name.`);
    }
    throw e;
  }
  return '@' + s;
}

/** Like resolveTarget, but only from what's saved on this computer (for recap). */
function resolveLocal(app, raw) {
  let s = String(raw || '').trim().toLowerCase();
  let kind = null;
  if (s.startsWith('@')) { kind = '@'; s = s.slice(1); }
  else if (s.startsWith('#')) { kind = '#'; s = s.slice(1); }
  else if (s.startsWith('user:')) { kind = '@'; s = s.slice(5); }
  else if (s.startsWith('server:')) { kind = '#'; s = s.slice(7); }
  else if (s.startsWith('room:')) { kind = '#'; s = s.slice(5); }
  const have = app.vault.conversations();
  if (kind) return kind + s;
  const dm = have.includes('@' + s);
  const room = have.includes('#' + s) || app.rooms().includes(s);
  if (dm && room) throw new Error(`"${s}" is both a server and a person. Say which: server:${s} or user:${s}`);
  return (room ? '#' : '@') + s;
}

const pretty = (key) => (key[0] === '#' ? key : key.slice(1));

/** Send from the live prompt: don't wait, just report if it fails. */
function sendFromShell(app, key, text) {
  if (prefs.on('emoji')) text = emojify(text);
  app.send(key, text).catch((e) => app.say(`Not sent to ${pretty(key)}: ${e.message}`, 'err'));
}

function adoptRoom(app, room, res) {
  const chat = app.chat('#' + room);
  app._adopt(chat, res);
  return chat;
}

/** Show the last few saved messages of a conversation. */
function replay(app, key, n) {
  const list = app.vault.loadHistory(key, n);
  let day = null;
  let shown = 0;
  for (const r of list) {
    if (typeof r.text !== 'string' || typeof r.from !== 'string') continue;
    const d = new Date(r.ts).toDateString();
    if (d !== day) { day = d; app.emit('line', { t: 'day', ts: r.ts }); }
    app.emit('line', { t: 'msg', key, msg: { id: r.id, from: r.from, ts: r.ts, text: r.text, status: r.st === 'pending' ? 'failed' : r.st } });
    shown++;
  }
  return shown;
}

// where: 'shell' = live prompt only.   net: needs a connection when run from your shell.
// hidden: works, but isn't listed anywhere.
const COMMANDS = [
  // ── Chat ────────────────────────────────────────────────────────────────
  {
    name: 'squawk', aliases: ['sq', 'say', 'msg', 'dm', 'send', 'tell'], args: '<who> <message>', need: 1, complete: 'target', group: 'Chat', net: true,
    desc: 'Send a message to a person or a server',
    async run(ctx, args, rest) {
      const { app } = ctx;
      if (!args[0]) throw usage(ctx, this);
      const key = await resolveTarget(app, args[0]);
      let message = rest.replace(/^\s*\S+\s?/, '');
      if (!message.trim() && ctx.stdin) message = await ctx.stdin();
      if (ctx.shell) {
        app.setTarget(key);
        if (message.trim()) sendFromShell(app, key, message);
        return;
      }
      if (!message.trim()) throw usage(ctx, this);
      await app.send(key, message);
      app.say(`sent to ${pretty(key)}`, 'ok');
    },
  },
  {
    name: 'to', aliases: ['t', 'open'], args: '<who>', need: 1, complete: 'target', group: 'Chat', where: 'shell',
    desc: 'Choose who your next messages go to',
    async run(ctx, args) {
      if (!args[0]) throw usage(ctx, this);
      ctx.app.setTarget(await resolveTarget(ctx.app, args[0]));
    },
  },
  {
    name: 'recap', aliases: ['history', 'log', 'replay'], args: '[who] [how many]', complete: 'target', group: 'Chat',
    desc: 'Replay recent messages with someone',
    async run(ctx, args) {
      const { app } = ctx;
      let who = args[0];
      let count = args[1];
      if (who && /^\d+$/.test(who) && !count) { count = who; who = null; }
      const key = who ? resolveLocal(app, who) : app.target;
      if (!key) throw usage(ctx, this);
      const n = Math.max(1, Math.min(500, Number(count) || 20));
      if (!replay(app, key, n)) app.say(`No saved messages with ${pretty(key)} yet.`, 'sys');
    },
  },
  {
    name: 'mute', aliases: ['unmute', 'quiet'], args: '[who]', complete: 'target', group: 'Chat',
    desc: 'Stop (or start again) the sound and unread count for a chat',
    async run(ctx, args) {
      const { app } = ctx;
      const key = args[0] ? resolveLocal(app, args[0]) : app.target;
      if (!key) throw usage(ctx, this);
      const was = app.muted(key);
      app.settings = app.vault.updateSettings((s) => {
        const list = Array.isArray(s.muted) ? s.muted.filter((k) => k !== key) : [];
        if (!was) list.push(key);
        s.muted = list;
      });
      app.emit('change');
      app.say(was ? `${pretty(key)} is unmuted.` : `${pretty(key)} is muted - messages still arrive, quietly. Same command to undo.`, 'ok');
    },
  },
  {
    name: 'find', aliases: ['search', 'grep'], args: '<words>', need: 1, group: 'Chat',
    desc: 'Search your saved messages',
    async run(ctx, args) {
      const { app } = ctx;
      const want = args.join(' ').toLowerCase();
      const hits = [];
      for (const key of app.vault.conversations()) {
        for (const r of app.vault.loadHistory(key, 5000)) {
          if (typeof r.text === 'string' && r.text.toLowerCase().includes(want)) hits.push({ key, r });
        }
      }
      hits.sort((a, b) => b.r.ts - a.r.ts);
      if (!hits.length) return app.say(`Nothing saved on this computer mentions "${args.join(' ')}".`, 'sys');
      const rows = [[[`${plural(hits.length, 'message')} mentioning "${args.join(' ')}"${hits.length > 20 ? ' (newest 20)' : ''}`, 'head']]];
      for (const { key, r } of hits.slice(0, 20).reverse()) {
        const d = new Date(r.ts);
        rows.push([
          [`  ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).padEnd(7)}`, 'dim'],
          [pretty(key).padEnd(14) + ' ', key[0] === '#' ? 'room' : 'accent'],
          [(r.from === app.me ? prefs.val('you') : r.from) + ': ', 'bold'],
          [r.text.replace(/\s+/g, ' ').slice(0, 160), null],
        ]);
      }
      return app.rows(rows);
    },
  },
  {
    name: 'export', aliases: ['save'], args: '[who] [file]', complete: 'target', group: 'Chat',
    desc: 'Save a chat to a text file',
    async run(ctx, args) {
      const { app } = ctx;
      const fs = require('fs');
      const path = require('path');
      const key = args[0] ? resolveLocal(app, args[0]) : app.target;
      if (!key) throw usage(ctx, this);
      const list = app.vault.loadHistory(key, 100000).filter((r) => typeof r.text === 'string' && typeof r.from === 'string');
      if (!list.length) return app.say(`No saved messages with ${pretty(key)} yet.`, 'sys');
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      const file = path.resolve(args[1] || `gossip-${key.slice(1)}-${stamp(Date.now()).slice(0, 10)}.txt`);
      const text = [`gossip chat with ${pretty(key)}, saved ${stamp(Date.now())}`, '']
        .concat(list.map((r) => `[${stamp(r.ts)}] ${r.from}: ${r.text}`)).join('\n') + '\n';
      fs.writeFileSync(file, text);
      return app.say(`Saved ${plural(list.length, 'message')} to ${file}`, 'ok');
    },
  },
  {
    name: 'changelog', aliases: ['news', 'whatsnew', 'updates'], args: '[all]', group: 'Setup',
    desc: "See what's new in each version",
    async run(ctx, args) {
      const U = require('./update');
      const log = U.changelog();
      if (!log.length) return ctx.app.say('No update notes came with this copy.', 'sys');
      const rows = [];
      for (const entry of (args[0] === 'all' ? log : log.slice(0, 3))) {
        rows.push([[`gossip ${entry.version}`, 'head'], [entry.version === U.currentVersion() ? '  (this one)' : '', 'dim']]);
        for (const line of entry.lines) rows.push([['  · ', 'dim'], [line, null]]);
      }
      const hist = U.history().slice(-3);
      if (hist.length) {
        rows.push([['On this computer', 'head']]);
        for (const h of hist) rows.push([['  · ', 'dim'], [`${new Date(h.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}: updated from ${h.from} to ${h.to}`, 'dim']]);
      }
      if (args[0] !== 'all' && log.length > 3) rows.push([[`  Older versions: ${ctx.app.hint('changelog all')}`, 'dim']]);
      return ctx.app.rows(rows);
    },
  },
  {
    name: 'check', group: 'Chat', net: true,
    desc: "See what's new",
    // From your shell this is handled in cli.js (it fetches what was waiting).
    async run(ctx) {
      const { app } = ctx;
      const online = app.contacts().filter((p) => app.presence.get(p.name)).map((p) => p.name);
      const rows = [
        [['You are live. ', 'bold'], ['New messages show up here the moment they arrive.', 'dim']],
        [['Talking to   ', 'dim'], [app.target || 'nobody yet', app.target ? null : 'dim']],
        [['Online now   ', 'dim'], [online.length ? online.join(', ') : 'none of your contacts', online.length ? null : 'dim']],
        [['Servers      ', 'dim'], [app.rooms().map((r) => '#' + r).join(' ') || 'none', app.rooms().length ? 'room' : 'dim']],
      ];
      for (const [room, by] of app.invites) rows.push([['Invite       ', 'dim'], [by, 'name'], [' → ', 'dim'], ['#' + room, 'room'], [`   ${app.hint(`join ${room}`)}`, 'dim']]);
      app.rows(rows);
    },
  },

  // ── People ──────────────────────────────────────────────────────────────
  {
    name: 'add', aliases: ['friend', 'befriend'], args: '<user>', need: 1, group: 'People', net: true,
    desc: 'Add someone to your contacts',
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      needOnline(app);
      let peer;
      try {
        peer = await app.peerFor(name, { refresh: true });
      } catch (e) {
        throw e.code === 'no_such_user' ? new Error(`There's no user called ${name}.`) : e;
      }
      if (peer.contact) return app.say(`${name} is already in your contacts.`, 'sys');
      app.peers.update(name, (cur) => ({ ...(cur || peer), contact: true }));
      await app._watch().catch(() => {});
      app.say(`Added ${name}. Say hi: ${ctx.shell ? `@${name} hello` : `gossip squawk ${name} hello`}`, 'ok');
    },
  },
  {
    name: 'remove', aliases: ['unfriend'], args: '<user>', need: 1, complete: 'contact', group: 'People',
    desc: 'Remove someone from your contacts',
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      const peer = app.peers.get(name);
      if (!peer || !peer.contact) throw new Error(`${name} isn't in your contacts.`);
      app.peers.update(name, (cur) => ({ ...(cur || peer), contact: false }));
      await app._watch().catch(() => {});
      app.say(`Removed ${name} from your contacts.`, 'ok');
    },
  },
  {
    name: 'contacts', aliases: ['flock', 'friends', 'people'], group: 'People', net: true,
    desc: 'List your contacts and who is online',
    async run(ctx) {
      const { app } = ctx;
      const list = app.contacts();
      if (!list.length) return app.say(`No contacts yet. Add someone with ${app.hint('add <username>')}`, 'sys');
      if (!ctx.shell) await app._watch().catch(() => {});
      const online = (p) => app.presence.get(p.name) === true;
      list.sort((a, b) => online(b) - online(a) || (a.name < b.name ? -1 : 1));
      const rows = [];
      for (const p of list) {
        rows.push([
          [online(p) ? '● ' : '○ ', online(p) ? 'ok' : 'dim'],
          [p.name.padEnd(21), 'name'],
          [online(p) ? 'online ' : 'offline', online(p) ? 'ok' : 'dim'],
          [p.changed ? '   key changed!' : p.verified ? '   verified' : '', p.changed ? 'warn' : 'dim'],
        ]);
      }
      app.rows(rows);
    },
  },

  // ── Servers (group chats) ───────────────────────────────────────────────
  {
    name: 'servers', aliases: ['rooms', 'groups', 'list'], group: 'Servers', net: true,
    desc: 'Browse public servers (group chats)',
    async run(ctx) {
      const { app } = ctx;
      needOnline(app);
      await app.refreshRooms(true);
      const list = app.knownRooms;
      if (!list.length) return app.say(`No public servers yet. Start one with ${app.hint('create <name>')}`, 'sys');
      const rows = [];
      for (const r of list.slice(0, 40)) {
        rows.push([['#' + r.name.padEnd(25), 'room'], [plural(r.members, 'member').padEnd(13), 'dim'], [r.joined ? 'joined' : '', 'ok']]);
      }
      if (list.length > 40) rows.push([[`...and ${list.length - 40} more`, 'dim']]);
      app.rows(rows);
    },
  },
  {
    name: 'create', aliases: ['new'], args: '<server> [private]', need: 1, group: 'Servers', net: true,
    desc: 'Start a server you own (add "private" for invite-only)',
    async run(ctx, args) {
      const { app } = ctx;
      const room = roomArg(args[0]);
      if (!room) throw usage(ctx, this);
      const flag = (args[1] || '').toLowerCase();
      if (flag && !['private', 'public'].includes(flag)) throw usage(ctx, this);
      needOnline(app);
      const res = await app.link.request('create', { room, private: flag === 'private' });
      const chat = adoptRoom(app, room, res);
      if (ctx.shell) app.setTarget(chat.key);
      app.say(
        flag === 'private'
          ? `Created #${room} - you own it, and it's invite-only. Bring people in with ${app.hint(`invite <username> ${room}`)}`
          : `Created #${room} - you own it. Anyone can join with: ${app.hint(`join ${room}`)}`,
        'ok',
      );
    },
  },
  {
    name: 'join', args: '<server>', need: 1, complete: 'room', group: 'Servers', net: true,
    desc: 'Join a server',
    async run(ctx, args) {
      const { app } = ctx;
      const room = roomArg(args[0]);
      if (!room) throw usage(ctx, this);
      needOnline(app);
      let res;
      try {
        res = await app.link.request('join', { room });
      } catch (e) {
        throw e.code === 'no_such_room' ? Object.assign(new Error(`There's no server called #${room}. Start it with ${app.hint(`create ${room}`)}`), { code: e.code }) : e;
      }
      app.invites.delete(room);
      const chat = adoptRoom(app, room, res);
      if (ctx.shell) app.setTarget(chat.key);
      app.say(`Joined #${room} - ${plural(chat.members.size, 'member')}, owned by ${chat.owner || 'nobody'}.`, 'ok');
    },
  },
  {
    name: 'invite', args: '<user> [server]', need: 1, complete: 'user', group: 'Servers', net: true,
    desc: 'Invite someone to a server',
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      const room = roomOrCurrent(app, args[1], 'invite <user> <server>');
      needOnline(app);
      await app.link.request('invite', { room, name });
      app.say(`Invited ${name} to #${room}.`, 'ok');
    },
  },
  {
    name: 'kick', aliases: ['boot'], args: '<user> [server]', need: 1, complete: 'member', group: 'Servers', net: true,
    desc: 'Remove someone from a server you own (works whether or not they are online or have joined yet)',
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      const room = roomOrCurrent(app, args[1], 'kick <user> <server>');
      needOnline(app);
      const res = await app.link.request('kick', { room, name });
      const chat = app.chats.get('#' + room);
      if (chat) chat.members.delete(name);
      if (res && res.blocked) {
        app.say(`${name} wasn't in #${room}. They're now kept out (any invite is cancelled) unless you invite them: ${app.hint(`invite ${name} ${room}`)}`, 'ok');
        return;
      }
      app.say(`Removed ${name} from #${room}. They can't come back unless you invite them: ${app.hint(`invite ${name} ${room}`)}`, 'ok');
    },
  },
  {
    name: 'give', aliases: ['handover', 'owner'], args: '<user> [server]', need: 1, complete: 'member', group: 'Servers', net: true,
    desc: 'Hand a server you own to another member',
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      const room = roomOrCurrent(app, args[1], 'give <user> <server>');
      needOnline(app);
      await app.link.request('owner', { room, name });
      const chat = app.chats.get('#' + room);
      if (chat) chat.owner = name;
      app.emit('change');
      app.say(`${name} owns #${room} now.`, 'ok');
    },
  },
  {
    name: 'leave', aliases: ['part'], args: '[server]', complete: 'joined', group: 'Servers', net: true,
    desc: 'Leave a server',
    async run(ctx, args) {
      const { app } = ctx;
      const room = roomOrCurrent(app, args[0], 'leave <server>');
      needOnline(app);
      await app.link.request('leave', { room });
      const chat = app.chats.get('#' + room);
      if (chat) chat.joined = false;
      if (app.target === '#' + room) app.setTarget(null);
      app.say(`Left #${room}.`, 'ok');
    },
  },
  {
    name: 'who', aliases: ['members'], args: '[server]', complete: 'joined', group: 'Servers', net: true,
    desc: "See who's in a server, and who owns it",
    async run(ctx, args) {
      const { app } = ctx;
      const room = roomOrCurrent(app, args[0], 'who <server>');
      needOnline(app);
      const chat = app.chat('#' + room);
      await app._refreshMembers(chat);
      const rank = (n) => (n === chat.owner ? 2 : 0) + (chat.members.get(n).online ? 1 : 0);
      const names = [...chat.members.keys()].sort((a, b) => rank(b) - rank(a) || (a < b ? -1 : 1));
      const rows = [[['#' + room, 'room'], [`   ${plural(names.length, 'member')} · ${chat.private ? 'invite-only' : 'public'}`, 'dim']]];
      for (const n of names) {
        const on = chat.members.get(n).online;
        const p = app.peers.get(n);
        rows.push([
          [on ? '● ' : '○ ', on ? 'ok' : 'dim'],
          [(n === app.me ? `${n} (you)` : n).padEnd(26), 'name:' + n],
          [n === chat.owner ? '★ owner  ' : '         ', 'accent2'],
          [p && p.contact ? 'contact  ' : '', 'dim'],
          [p && p.verified ? 'verified' : '', 'dim'],
        ]);
      }
      app.rows(rows);
    },
  },

  // ── Safety ──────────────────────────────────────────────────────────────
  {
    name: 'verify', args: '<user> [ok]', complete: 'user', group: 'Safety', net: true,
    desc: 'Check that nobody is listening in',
    async run(ctx, args) {
      const { app } = ctx;
      const name = args[0] ? userArg(app, args[0]) : app.target && app.target[0] === '@' ? app.target.slice(1) : null;
      if (!name) throw usage(ctx, this);
      const peer = await app.peerFor(name);
      if ((args[1] || '').toLowerCase() === 'ok') {
        if (peer.changed) throw new Error(`${name}'s key changed. Accept it first with ${app.hint(`trust ${name}`)}`);
        app.peers.update(name, (cur) => ({ ...(cur || peer), verified: true }));
        return app.say(`${name} is now marked as verified.`, 'ok');
      }
      const key = peer.changed ? peer.changed.signPub : peer.signPub;
      app.rows([
        [[`Safety number with ${name}`, 'bold'], [peer.changed ? '   (their NEW key)' : peer.verified ? '   verified' : '', peer.changed ? 'warn' : 'ok']],
        [['  ' + e2e.safetyNumber(app.identity.signPub, key), 'accent']],
        [[`Ask ${name} to run `, 'dim'], [app.hint(`verify ${app.me}`), null], [' and read you their number (in person or on a call).', 'dim']],
        [['Same number on both sides = only the two of you can read this chat.', 'dim']],
        peer.changed
          ? [['If it matches, accept the new key: ', 'dim'], [app.hint(`trust ${name}`), null]]
          : [['If it matches, remember that: ', 'dim'], [app.hint(`verify ${name} ok`), null]],
      ]);
    },
  },
  {
    name: 'trust', args: '<user>', need: 1, complete: 'changed', group: 'Safety',
    desc: "Accept someone's new security key",
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      const peer = app.peers.get(name);
      if (!peer || !peer.changed) throw new Error(`${name}'s key hasn't changed - nothing to accept.`);
      app.peers.update(name, (cur) => {
        const next = { ...(cur || peer), ...(cur || peer).changed, verified: false };
        delete next.changed;
        return next;
      });
      app.say(`Accepted ${name}'s new key. You can message them again.`, 'ok');
    },
  },
  {
    name: 'block', aliases: ['hush'], args: '<user>', need: 1, complete: 'user', group: 'Safety', net: true,
    desc: "Stop someone's messages (they aren't told)",
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      needOnline(app);
      const res = await app.link.request('block', { name });
      app.settings = app.vault.updateSettings((s) => { s.blocked = res.blocked || []; });
      app.say(`Blocked ${name}. Their messages won't reach you. Undo: ${app.hint(`unblock ${name}`)}`, 'ok');
    },
  },
  {
    name: 'unblock', aliases: ['unhush'], args: '<user>', need: 1, complete: 'blocked', group: 'Safety', net: true,
    desc: 'Unblock someone',
    async run(ctx, args) {
      const { app } = ctx;
      const name = userArg(app, args[0]);
      if (!name) throw usage(ctx, this);
      needOnline(app);
      const res = await app.link.request('unblock', { name });
      app.settings = app.vault.updateSettings((s) => { s.blocked = res.blocked || []; });
      app.say(`Unblocked ${name}.`, 'ok');
    },
  },

  // ── Make it yours ───────────────────────────────────────────────────────
  {
    name: 'config', aliases: ['set', 'settings', 'prefs'], args: '[setting] [value]', complete: 'setting', group: 'Make it yours',
    desc: 'See or change any setting',
    async run(ctx, args, rest) {
      const { app } = ctx;
      prefs.use(app.settings);
      if (!args[0]) {
        const rows = [[['Settings', 'head'], [`   change one with: ${app.hint('config <setting> <value>')}`, 'dim']]];
        for (const o of prefs.list()) {
          rows.push([[o.key.padEnd(17), null], [String(o.value).padEnd(11), o.changed ? 'accent2' : 'accent'], [o.desc, 'dim']]);
        }
        rows.push([['color.<part>'.padEnd(17), null], ['#hex'.padEnd(11), 'accent'], ['Recolour one part: accent, accent2, border, dim, ok, warn, err, server, link', 'dim']]);
        rows.push([['alias.<word>'.padEnd(17), null], ['command'.padEnd(11), 'accent'], ['Your own shortcut, e.g. alias.m "squawk maya"', 'dim']]);
        return app.rows(rows);
      }
      if (args[0] === 'reset') {
        const key = (args[1] || '').toLowerCase();
        if (!key) throw new Error(`Reset what? ${app.hint('config reset <setting>')} or ${app.hint('config reset all')}`);
        app.settings = prefs.reset(app.vault, key);
        app.emit('change');
        return app.say(key === 'all' ? 'Every setting is back to its default.' : `${key} is back to its default (${prefs.val(key) === undefined ? 'unset' : prefs.val(key)}).`, 'ok');
      }
      const key = args[0].toLowerCase();
      if (args.length === 1) {
        const o = prefs.list().find((x) => x.key === key);
        if (!o) {
          if (!/^(color|alias)\./.test(key)) prefs.validate(key, 'x'); // throws "no such setting"
          throw new Error(`${key} isn't set. Give it a value: ${app.hint(`config ${key} <value>`)}`);
        }
        return app.rows([
          [[o.key, 'bold'], ['  =  ', 'dim'], [String(o.value), 'accent'], [o.def !== '' && o.changed ? `   (default: ${o.def})` : '', 'dim']],
          [[o.desc, 'dim']],
          ...(o.accepts ? [[['Can be: ', 'dim'], [o.accepts, null]]] : []),
        ]);
      }
      const value = rest.replace(/^\s*\S+\s+/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
      const res = prefs.set(app.vault, key, value);
      app.settings = res.settings;
      app.emit('change');
      app.say(`${key} is now ${res.value}`, 'ok');
    },
  },
  {
    name: 'theme', aliases: ['themes', 'colors', 'colours'], args: '[name]', complete: 'theme', group: 'Make it yours',
    desc: 'Preview the colour schemes, or switch to one',
    async run(ctx, args) {
      const { app } = ctx;
      prefs.use(app.settings);
      if (args[0]) {
        const res = prefs.set(app.vault, 'theme', args[0]);
        app.settings = res.settings;
        app.emit('change');
        return app.say(`Theme is now ${res.value}.`, 'ok');
      }
      const now = prefs.val('theme');
      const rows = [];
      for (const [name, t] of Object.entries(Th.THEMES)) {
        const row = [[name === now ? '● ' : '  ', 'ok'], [name.padEnd(10), name === now ? 'bold' : null]];
        for (const part of ['accent', 'accent2', 'ok', 'warn', 'err', 'server']) row.push(['██', t[part].fg ? 'fg:' + t[part].fg : 'dim']);
        row.push([' ', null]);
        for (const c of t.names.slice(0, 4)) row.push(['▄▄', 'fg:' + c]);
        row.push(['  ' + t.about, 'dim']);
        rows.push(row);
      }
      rows.push([['Switch with ', 'dim'], [app.hint('theme <name>'), null], ['. Recolour one part: ', 'dim'], [app.hint('config color.accent #ff8800'), null]]);
      app.rows(rows);
    },
  },
  {
    name: 'mascot', aliases: ['penguin', 'pebble'], args: '[scene|random|off]', complete: 'scene', group: 'Make it yours',
    desc: 'Choose what the penguin does when gossip opens',
    async run(ctx, args) {
      const { app } = ctx;
      prefs.use(app.settings);
      if (!args[0]) {
        return app.say(`The penguin is set to "${prefs.val('mascot')}". Choices: random, ${M.SCENE_NAMES.join(', ')}, off. Watch one now: ${app.hint('dance')}`, 'sys');
      }
      const res = prefs.set(app.vault, 'mascot', args[0]);
      app.settings = res.settings;
      app.say(`The penguin is now set to ${res.value}.`, 'ok');
    },
  },
  {
    name: 'dance', args: '[scene]', complete: 'scene', group: 'Make it yours',
    desc: 'Watch the penguin do its thing',
    async run(ctx, args) {
      const want = (args[0] || 'dance').toLowerCase();
      if (!M.SCENES[want]) throw new Error(`The penguin knows: ${M.SCENE_NAMES.join(', ')}`);
      if (ctx.play) await ctx.play(want);
    },
  },

  // ── Setup ───────────────────────────────────────────────────────────────
  {
    name: 'whoami', aliases: ['me'], group: 'Setup',
    desc: 'Show your username and key fingerprint (in a chat, "/me waves" sends an action)',
    async run(ctx, args) {
      const { app } = ctx;
      if (args && args.length && ctx.shell) { // "/me waves" -> * dhruv waves
        if (!app.target) throw new Error(ctx.noTarget || 'Open a chat first.');
        return sendFromShell(app, app.target, '/me ' + args.join(' '));
      }
      app.rows([
        [['username     ', 'dim'], [app.me, 'name:' + app.me]],
        [['relay        ', 'dim'], [app.serverUrl || '(not set)', null]],
        [['fingerprint  ', 'dim'], [e2e.fingerprint(app.identity.signPub), null]],
        [['account file ', 'dim'], [app.vault.file('identity.json'), null]],
        [['Back that file up. There is no password reset - whoever has it is you.', 'dim']],
      ]);
    },
  },
  {
    name: 'relay', aliases: ['server'], args: '[address]', group: 'Setup',
    desc: 'Show or change the relay or website your messages go through',
    async run(ctx, args) {
      const { app } = ctx;
      const { resolveServer } = require('./app');
      if (!args[0]) {
        const rows = [[['relay   ', 'dim'], [app.serverUrl || '(not set)', null]]];
        if (ctx.shell) {
          const d = app.conn.detail || {};
          rows.push([['status  ', 'dim'], [app.conn.state === 'online' ? 'connected' : app.conn.state + (d.message ? ` - ${d.message}` : ''), app.conn.state === 'online' ? 'ok' : 'warn']]);
        }
        if (/^(ws|http):\/\/(?!localhost|127\.|\[::1\])/.test(app.serverUrl)) {
          rows.push([['No TLS on this address: message text is still end-to-end encrypted, but who you talk to is visible on the network.', 'warn']]);
        }
        return app.rows(rows);
      }
      const url = await resolveServer(args[0]);
      if (ctx.shell) {
        app.say(`Switching to ${url}…`, 'sys');
        app.switchServer(url);
      } else {
        app.settings = app.vault.updateSettings((s) => { s.server = url; });
        app.say(`Relay set to ${url}`, 'ok');
      }
    },
  },
  {
    name: 'reconnect', group: 'Setup', where: 'shell',
    desc: 'Connect again right now',
    async run(ctx) {
      const { app } = ctx;
      if (!app.link) throw new Error(`No relay is set. Use ${app.hint('relay <address>')} first.`);
      if (app.link.online) return app.say("You're already connected.", 'sys');
      app.link.retryNow();
    },
  },
  {
    name: 'help', aliases: ['h', 'commands'], group: 'Setup',
    desc: 'Show all commands',
    async run(ctx) {
      ctx.app.rows(helpRows(ctx.shell, ctx.view));
    },
  },
  {
    name: 'quit', aliases: ['q', 'exit', 'bye'], group: 'Setup', where: 'shell',
    desc: 'Leave gossip',
    async run(ctx) {
      ctx.quit();
    },
  },
  {
    // A quirk nobody is told about: the name of the bit of code that draws the prompt.
    name: 'shitty', hidden: true, group: 'Setup',
    desc: '',
    async run(ctx) {
      ctx.app.say('ShiTTY: the Shell-in-TTY quietly drawing this prompt. You found it. Tell no one.', 'sys');
    },
  },
];

const GROUPS = ['Chat', 'People', 'Servers', 'Safety', 'Make it yours', 'Setup'];

function usage(ctx, c) {
  return new Error(`Usage: ${ctx.app.hint(c.name)}${c.args ? ' ' + c.args : ''}`);
}

function find(name) {
  const n = String(name).toLowerCase();
  return COMMANDS.find((c) => c.name === n) || COMMANDS.find((c) => c.aliases && c.aliases.includes(n)) || null;
}

function didYouMean(word, extra = []) {
  const names = COMMANDS.filter((c) => !c.hidden).map((c) => c.name).concat(extra);
  return names.filter((n) => distance(n, word.toLowerCase()) <= 2)[0] || null;
}

function helpRows(shell, view) {
  const rows = [];
  const p = shell ? '/' : 'gossip ';
  const w = shell ? 30 : 36;
  if (shell) {
    rows.push([['Talking', 'head']]);
    rows.push([['  ' + '@maya hey there'.padEnd(w), null], ['Message a person (and keep talking to them)', 'dim']]);
    rows.push([['  ' + '#gamedev hello'.padEnd(w), null], ['Message a server', 'dim']]);
    rows.push([['  ' + 'just type'.padEnd(w), null], ['Goes to whoever is shown in the prompt', 'dim']]);
  } else {
    rows.push([['Everyday', 'head']]);
    rows.push([['  ' + 'gossip'.padEnd(w), null], ['Open the live chat prompt', 'dim']]);
    rows.push([['  ' + 'gossip check'.padEnd(w), null], ['See what arrived while you were away', 'dim']]);
    rows.push([['  ' + 'gossip listen [who]'.padEnd(w), null], ['Stay tuned: print messages as they arrive', 'dim']]);
  }
  for (const group of GROUPS) {
    const list = COMMANDS.filter((c) => c.group === group && !c.hidden && (shell || c.where !== 'shell') && !(c.name === 'check' && !shell));
    if (!list.length) continue;
    if (!(group === 'Chat' && !shell)) rows.push([[group === 'Servers' ? 'Servers (group chats)' : group, 'head']]);
    for (const c of list) rows.push([['  ' + `${p}${c.name}${c.args ? ' ' + c.args : ''}`.padEnd(w), null], [c.desc, 'dim']]);
  }
  if (shell) {
    rows.push([['Keys', 'head']]);
    const keys = view === 'full' ? [
      ['Tab', 'Open the menu - everything is in there'], ['Up / Down', 'Move between your chats'], ['Enter', 'Send'],
      ['Alt+Enter', 'New line'], ['PgUp / PgDn', 'Scroll older and newer messages'], ['Esc', 'Clear the line, or jump to the newest message'],
      ['Mouse', 'Click a chat, scroll with the wheel (hold Shift to select text)'], ['Ctrl+D', 'Leave'],
    ] : [
      ['Tab', 'Open the menu (or finish a name or command you started typing)'], ['Shift+Tab', 'Hop to the next chat'],
      ['Enter', 'Send'], ['Alt+Enter', 'New line'],
      ['Up / Down', 'Things you typed before'], ['Esc', 'Clear the line'], ['Ctrl+L', 'Clear the screen'], ['Ctrl+D', 'Leave'],
    ];
    for (const [k, d] of keys) rows.push([['  ' + k.padEnd(w), null], [d, 'dim']]);
    rows.push([['A line that starts with a space is always sent as plain text.', 'dim']]);
  } else {
    rows.push([['More', 'head']]);
    rows.push([['  ' + 'gossip --classic'.padEnd(w), null], ['Open the chat in the classic scrolling look (or: --full)', 'dim']]);
    rows.push([['  ' + 'gossip nearby'.padEnd(w), null], ['Chat with people on the same Wi-Fi or cable - no internet needed', 'dim']]);
    rows.push([['  ' + 'gossip serve'.padEnd(w), null], ['Run your own relay (gossip serve --help)', 'dim']]);
    rows.push([['  ' + 'gossip uninstall'.padEnd(w), null], ['Remove gossip from this computer (also: gossip delete)', 'dim']]);
    rows.push([['  ' + 'gossip update'.padEnd(w), null], ['Get the latest version', 'dim']]);
    rows.push([['Names work bare: "gossip squawk maya hi", "gossip squawk gamedev hi".', 'dim']]);
  }
  return rows;
}

/** Your own shortcuts (alias.<word> settings): "m" -> "squawk maya". */
function expandAlias(line) {
  const word = line.trim().split(/\s+/)[0] || '';
  const mine = prefs.family('alias.');
  if (!Object.prototype.hasOwnProperty.call(mine, word.toLowerCase()) || find(word)) return line;
  return mine[word.toLowerCase()] + line.trim().slice(word.length);
}

async function runCommand(ctx, line) {
  prefs.use(ctx.app.settings);
  const body = expandAlias(line).trim();
  const word = body.split(/\s+/)[0] || '';
  const rest = body.slice(word.length);
  const cmd = find(word);
  if (!cmd || (cmd.where === 'shell' && !ctx.shell)) {
    const close = didYouMean(word);
    throw new Error(`There's no "${word}" command.${close ? ` Did you mean ${ctx.app.hint(close)}?` : ''} See them all: ${ctx.app.hint('help')}`);
  }
  const args = rest.trim() ? rest.trim().split(/\s+/) : [];
  await cmd.run(ctx, args, rest);
}

/**
 * A line typed into the chat: a /command, "@maya hi", "#server hi", or just a
 * message for whoever you're talking to.
 */
async function handleInput(ctx, raw) {
  const { app } = ctx;
  const literal = raw[0] === ' '; // a leading space means "send this exactly as typed"
  const text = raw.trim();
  if (!literal && text[0] === '/' && text[1] !== '/') return runCommand(ctx, text.slice(1));
  if (!literal) {
    const m = /^([@#][A-Za-z0-9_-]+)(?:\s+([\s\S]+))?$/.exec(text);
    if (m) {
      const key = await resolveTarget(app, m[1]);
      app.setTarget(key);
      if (m[2] && m[2].trim()) sendFromShell(app, key, m[2]);
      return undefined;
    }
  }
  if (!app.target) {
    app.say(ctx.noTarget || 'Who to? Start with @username or #server - for example: @maya hey', 'warn');
    return undefined;
  }
  sendFromShell(app, app.target, !literal && text.startsWith('//') ? text.slice(1) : text);
  return undefined;
}

// ── suggestions for the live prompt ─────────────────────────────────────────

function people(app) {
  const out = [];
  for (const p of app.contacts()) out.push({ name: p.name, desc: app.presence.get(p.name) ? 'contact · online' : 'contact' });
  // Only people you added yourself. Someone you've merely seen in a server, or who
  // messaged you once, doesn't get put on your list for you.
  return out;
}

function candidates(app, kind) {
  switch (kind) {
    case 'user': return people(app);
    case 'contact': return app.contacts().map((p) => ({ name: p.name, desc: 'contact' }));
    case 'changed': return app.peers.values().filter((p) => p.changed).map((p) => ({ name: p.name, desc: 'key changed' }));
    case 'blocked': return app.settings.blocked.map((name) => ({ name, desc: 'blocked' }));
    case 'joined': return app.rooms().map((name) => ({ name, desc: 'server' }));
    case 'member': {
      const chat = app.target && app.chats.get(app.target);
      if (!chat || chat.kind !== 'room') return people(app);
      return [...chat.members.keys()].filter((n) => n !== app.me).map((name) => ({ name, desc: `in #${chat.name}` }));
    }
    case 'target':
      return people(app).map((x) => ({ ...x, name: '@' + x.name })).concat(app.rooms().map((name) => ({ name: '#' + name, desc: 'server' })));
    case 'room': {
      app.refreshRooms();
      const out = [];
      for (const [room, by] of app.invites) out.push({ name: room, desc: `invited by ${by}` });
      const seen = new Set(out.map((x) => x.name));
      for (const r of app.knownRooms) {
        if (!seen.has(r.name) && !r.joined) out.push({ name: r.name, desc: plural(r.members, 'member') });
      }
      return out;
    }
    case 'theme': return Object.entries(Th.THEMES).map(([name, t]) => ({ name, desc: t.about }));
    case 'scene': return M.SCENE_NAMES.map((name) => ({ name, desc: M.SCENES[name].about }));
    case 'setting': return prefs.OPTIONS.map((o) => ({ name: o.key, desc: `${prefs.val(o.key)} - ${o.desc}` })).concat([{ name: 'reset', desc: 'put a setting back to its default' }]);
    default: return [];
  }
}

/**
 * What to offer for the text typed so far in the live prompt.
 * Returns null or { stage: 'cmd' | 'arg', items: [{ label, hint, desc, value, needsArg }] }.
 */
function suggest(app, text) {
  if (!text || text.includes('\n')) return null;

  // "@ma" / "#ga" at the start of a line: who to talk to
  const addr = /^([@#])([a-z0-9_-]*)$/i.exec(text);
  if (addr) {
    const q = addr[2].toLowerCase();
    const pool = addr[1] === '@' ? people(app).map((x) => ({ ...x, name: '@' + x.name })) : app.rooms().map((name) => ({ name: '#' + name, desc: 'server' }));
    const items = pool.filter((x) => x.name.slice(1).startsWith(q)).slice(0, 50)
      .map((x) => ({ label: x.name, hint: '', desc: x.desc, value: x.name, needsArg: false }));
    return items.length ? { stage: 'arg', items } : null;
  }

  if (text[0] !== '/' || text[1] === '/') return null;
  const sp = text.indexOf(' ');
  if (sp < 0) {
    const q = text.slice(1).toLowerCase();
    const visible = COMMANDS.filter((c) => !c.hidden);
    const starts = visible.filter((c) => c.name.startsWith(q));
    const alias = visible.filter((c) => !starts.includes(c) && c.aliases && c.aliases.includes(q));
    const items = [...starts, ...alias].map((c) => ({
      label: '/' + c.name, hint: c.args || '', desc: c.desc, value: '/' + c.name, needsArg: !!c.need,
    }));
    for (const [word, runs] of Object.entries(prefs.family('alias.'))) {
      if (word.startsWith(q) && !find(word)) items.push({ label: '/' + word, hint: '', desc: `your shortcut for /${runs}`, value: '/' + word, needsArg: false });
    }
    return items.length ? { stage: 'cmd', items } : null;
  }
  const cmd = find(text.slice(1, sp));
  if (!cmd || !cmd.complete) return null;
  const rest = text.slice(sp + 1);
  if (/\s/.test(rest)) return null; // only the first argument is completed
  const q = rest.toLowerCase();
  const bare = q.replace(/^[@#]/, '');
  const items = candidates(app, cmd.complete)
    .filter((x) => x.name.startsWith(q) || x.name.replace(/^[@#]/, '').startsWith(bare))
    .slice(0, 50)
    .map((x) => ({ label: x.name, hint: '', desc: x.desc, value: `/${cmd.name} ${x.name}`, needsArg: false }));
  if (!items.length || (items.length === 1 && items[0].label === q)) return null;
  return { stage: 'arg', items };
}

module.exports = { COMMANDS, GROUPS, runCommand, handleInput, people, suggest, find, didYouMean, helpRows, resolveTarget, resolveLocal, sendFromShell, replay, pretty };

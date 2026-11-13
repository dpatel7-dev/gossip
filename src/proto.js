'use strict';
// Shared rules for the client and the relay: names, limits, conversation ids.

const PROTOCOL = 1;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{2,19}$/; // usernames: 3-20 chars
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/; // rooms: 2-24 chars
const ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const SIG_RE = /^[A-Za-z0-9_-]{86}$/; // 64 bytes, base64url

const RESERVED = new Set([
  'you', 'me', 'system', 'server', 'admin', 'gossip', 'everyone', 'all',
  'here', 'root', 'support', 'home', 'help', 'null', 'undefined',
]);

const LIMITS = {
  text: 4000, // characters per message
  frame: 256 * 1024, // bytes per network frame
  roomMembers: 256,
  queue: 500, // undelivered messages kept per user
  queueDays: 30,
  watch: 500,
};

const NAME_HELP = 'Usernames are 3-20 characters: a-z, 0-9, _ and -';
const ROOM_HELP = 'Server names are 2-24 characters: a-z, 0-9, _ and -';

function validName(s) {
  return typeof s === 'string' && NAME_RE.test(s) && !RESERVED.has(s);
}

function validRoom(s) {
  return typeof s === 'string' && ROOM_RE.test(s);
}

// Turn what a person typed ("@Maya", "#General ") into a bare lowercase name.
function cleanName(s) {
  return String(s || '').trim().replace(/^[@#]+/, '').toLowerCase();
}

function dmConv(a, b) {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

function roomConv(room) {
  return `room:${room}`;
}

function parseConv(conv) {
  if (typeof conv !== 'string' || conv.length > 64) return null;
  const parts = conv.split(':');
  if (parts[0] === 'dm' && parts.length === 3) {
    const [, a, b] = parts;
    if (NAME_RE.test(a) && NAME_RE.test(b) && a < b) return { kind: 'dm', a, b };
    return null;
  }
  if (parts[0] === 'room' && parts.length === 2 && ROOM_RE.test(parts[1])) {
    return { kind: 'room', room: parts[1] };
  }
  return null;
}

// Structural check of an encrypted envelope (no crypto here).
function validEnvelope(env) {
  if (!env || typeof env !== 'object' || env.v !== 1) return false;
  if (typeof env.id !== 'string' || !ID_RE.test(env.id)) return false;
  if (typeof env.from !== 'string' || !NAME_RE.test(env.from)) return false;
  if (!parseConv(env.conv)) return false;
  if (!Number.isSafeInteger(env.ts) || env.ts < 0) return false;
  if (typeof env.eph !== 'string' || !KEY_RE.test(env.eph)) return false;
  if (typeof env.n !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(env.n)) return false;
  if (typeof env.ct !== 'string' || !/^[A-Za-z0-9_-]{22,}$/.test(env.ct)) return false;
  if (typeof env.sig !== 'string' || !SIG_RE.test(env.sig)) return false;
  if (!env.keys || typeof env.keys !== 'object' || Array.isArray(env.keys)) return false;
  const names = Object.keys(env.keys);
  if (names.length > LIMITS.roomMembers) return false;
  for (const n of names) {
    if (!NAME_RE.test(n)) return false;
    if (typeof env.keys[n] !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(env.keys[n])) return false;
  }
  return true;
}

module.exports = {
  PROTOCOL, NAME_RE, ROOM_RE, ID_RE, KEY_RE, SIG_RE, RESERVED, LIMITS,
  NAME_HELP, ROOM_HELP,
  validName, validRoom, cleanName, dmConv, roomConv, parseConv, validEnvelope,
};

'use strict';
// Every knob gossip has, in one place.
//
//   gossip config                 list everything and what it's set to
//   gossip config theme ember     change one
//   gossip config reset theme     put one back        (or: reset all)
//
// Two families take any name:
//   color.<part>  #rrggbb or a terminal colour name - recolour one part of the theme
//   alias.<word>  a command - make your own shortcut, e.g. alias.m = "squawk maya"
//
// Preferences are stored in ~/.gossip/settings.json under "prefs".

const THEME_NAMES = ['arctic', 'ember', 'aurora', 'daylight', 'terminal', 'mono'];
const COLOR_PARTS = ['accent', 'accent2', 'border', 'dim', 'ok', 'warn', 'err', 'server', 'link'];
const ANSI_NAMES = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray',
  'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

const OPTIONS = [
  { key: 'view', choices: ['full', 'classic'], def: 'full', desc: 'The full chat screen, or the classic scrolling look' },
  { key: 'mouse', choices: ['on', 'off'], def: 'on', desc: 'Click and scroll in the full chat screen (off = select text freely)' },
  { key: 'theme', choices: THEME_NAMES, def: 'arctic', desc: 'Colour scheme' },
  { key: 'mascot', choices: ['random', 'dance', 'phone', 'laptop', 'off'], def: 'random', desc: 'What the penguin is up to when gossip opens' },
  { key: 'mascot.style', choices: ['auto', 'blocky', 'smooth'], def: 'auto', desc: 'How the penguin is drawn: blocky never shows stripes (auto picks it on macOS Terminal), smooth has more detail' },
  { key: 'mascot.animate', choices: ['on', 'off'], def: 'on', desc: 'Let the penguin move (off = a still picture)' },
  { key: 'mascot.speed', choices: ['slow', 'normal', 'fast'], def: 'normal', desc: 'How quickly the penguin moves' },
  { key: 'welcome', choices: ['full', 'compact', 'off'], def: 'full', desc: 'How much to show when gossip opens' },
  { key: 'prompt.style', choices: ['box', 'rules', 'bare'], def: 'box', desc: 'The frame around where you type' },
  { key: 'prompt.symbol', text: 3, def: '›', desc: 'The mark in front of what you type' },
  { key: 'footer', choices: ['on', 'off'], def: 'on', desc: 'The status line under the prompt' },
  { key: 'layout', choices: ['compact', 'cozy'], def: 'compact', desc: 'One line per message, or the name above the text' },
  { key: 'time', choices: ['12h', '24h', 'off'], def: '12h', desc: 'Clock on each message' },
  { key: 'names', choices: ['colored', 'plain'], def: 'colored', desc: 'Give each person their own colour' },
  { key: 'you', text: 20, def: 'you', desc: 'How your own messages are labelled' },
  { key: 'links', choices: ['underline', 'plain'], def: 'underline', desc: 'How web links are shown' },
  { key: 'security', choices: ['normal', 'strict'], def: 'normal', desc: 'strict = refuse to connect to anything that is not encrypted (https or wss)' },
  { key: 'mini.shrink', choices: ['on', 'off'], def: 'on', desc: 'Let `gossip mini` make the window small (and put it back after)' },
  { key: 'files', text: 300, def: '', desc: 'Folder for files people send you (empty: Downloads/gossip)' },
  { key: 'call.turn', text: 300, def: '', desc: 'Your own TURN server for calls on strict networks: turn:host:port username password' },
  { key: 'calls', choices: ['contacts', 'everyone', 'off'], def: 'contacts', desc: 'Who can call you' },
  { key: 'notify', choices: ['on', 'preview', 'off'], def: 'on', desc: 'Desktop pop-up for new messages when you are away: who it is from, with a preview, or never' },
  { key: 'emoji', choices: ['on', 'off'], def: 'on', desc: 'Turn :smile: style words into emoji when you send' },
  { key: 'bell', choices: ['all', 'mentions', 'off'], def: 'all', desc: 'Sound for DMs and @mentions, only @mentions, or never' },
  { key: 'typing', choices: ['on', 'off'], def: 'on', desc: 'Show (and send) "is typing…"' },
  { key: 'receipts', choices: ['on', 'off'], def: 'on', desc: 'Tell you when a DM is delivered' },
  { key: 'presence', choices: ['on', 'off'], def: 'on', desc: 'Tell you when a contact comes online' },
  { key: 'recap', number: [0, 50], def: 0, desc: 'Messages to replay when you switch to a chat (classic look)' },
  { key: 'update', choices: ['auto', 'notify', 'off'], def: 'auto', desc: 'Get new versions by itself, just tell you, or never check' },
];

const byKey = new Map(OPTIONS.map((o) => [o.key, o]));
let current = {}; // the prefs of the running app (set by use())

/** Point the rest of the app at these settings. */
function use(settings) {
  current = (settings && settings.prefs && typeof settings.prefs === 'object') ? settings.prefs : {};
}

/** Current value of an option (or its default). */
function val(key) {
  if (Object.prototype.hasOwnProperty.call(current, key)) return current[key];
  const o = byKey.get(key);
  return o ? o.def : undefined;
}

const on = (key) => val(key) === 'on';

function family(prefix) {
  const out = {};
  for (const k of Object.keys(current)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = current[k];
  return out;
}

/** Check and tidy a value. Returns the value to store, or throws a helpful Error. */
function validate(key, raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim();
  if (key.startsWith('color.')) {
    const part = key.slice(6);
    if (!COLOR_PARTS.includes(part) && !/^name[1-8]$/.test(part)) {
      throw new Error(`There's no colour called "${part}". Parts you can recolour: ${COLOR_PARTS.join(', ')}, name1 … name8`);
    }
    if (/^#?[0-9a-f]{6}$/i.test(value)) return '#' + value.replace('#', '').toLowerCase();
    const named = ANSI_NAMES.find((n) => n.toLowerCase() === value.toLowerCase());
    if (named) return named;
    throw new Error(`"${value}" isn't a colour. Use a hex code like #ffb86b, or one of: ${ANSI_NAMES.join(', ')}`);
  }
  if (key.startsWith('alias.')) {
    const word = key.slice(6);
    if (!/^[a-z][a-z0-9_-]{0,19}$/.test(word)) throw new Error('Alias names are 1-20 characters: a-z, 0-9, _ and -');
    const text = value.replace(/^\/+/, '');
    if (!text) throw new Error(`Say what "${word}" should run, for example: alias.${word} "squawk maya"`);
    if (text.length > 200) throw new Error('That alias is too long.');
    return text;
  }
  const o = byKey.get(key);
  if (!o) {
    const close = OPTIONS.map((x) => x.key).find((k) => k.includes(key) || key.includes(k.split('.').pop()));
    throw new Error(`There's no setting called "${key}".${close ? ` Did you mean "${close}"?` : ''}`);
  }
  if (o.choices) {
    const hit = o.choices.find((c) => c === value.toLowerCase())
      || (value === 'true' || value === 'yes' ? o.choices.find((c) => c === 'on') : null)
      || (value === 'false' || value === 'no' ? o.choices.find((c) => c === 'off') : null);
    if (!hit) throw new Error(`${key} can be: ${o.choices.join(', ')}`);
    return hit;
  }
  if (o.number) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < o.number[0] || n > o.number[1]) throw new Error(`${key} is a whole number from ${o.number[0]} to ${o.number[1]}`);
    return n;
  }
  if (o.text) {
    // no control characters, and not wider than the limit
    const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    if (!clean) throw new Error(`${key} can't be empty`);
    if (Array.from(clean).length > o.text) throw new Error(`${key} can be at most ${o.text} characters`);
    return clean;
  }
  return value;
}

/** Save one preference. Returns the stored value. */
function set(vault, key, raw) {
  const value = validate(key, raw);
  const settings = vault.updateSettings((s) => {
    s.prefs = s.prefs && typeof s.prefs === 'object' ? s.prefs : {};
    s.prefs[key] = value;
  });
  use(settings);
  return { value, settings };
}

/** Put one preference (or 'all') back to its default. */
function reset(vault, key) {
  if (key !== 'all' && !byKey.has(key) && !/^(color|alias)\./.test(key)) throw new Error(`There's no setting called "${key}".`);
  const settings = vault.updateSettings((s) => {
    if (key === 'all' || !s.prefs || typeof s.prefs !== 'object') s.prefs = {};
    else delete s.prefs[key];
  });
  use(settings);
  return settings;
}

/** Everything, for `gossip config`. */
function list() {
  const out = OPTIONS.map((o) => ({
    key: o.key, value: val(o.key), def: o.def, desc: o.desc, changed: val(o.key) !== o.def,
    accepts: o.choices ? o.choices.join(' | ') : o.number ? `${o.number[0]}-${o.number[1]}` : `text, up to ${o.text} characters`,
  }));
  for (const k of Object.keys(current).sort()) {
    if (/^(color|alias)\./.test(k)) out.push({ key: k, value: current[k], def: '', desc: k.startsWith('color.') ? 'Your colour override' : 'Your shortcut', changed: true, accepts: '' });
  }
  return out;
}

module.exports = { OPTIONS, THEME_NAMES, COLOR_PARTS, ANSI_NAMES, use, val, on, family, validate, set, reset, list };

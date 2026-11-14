'use strict';
// Desktop notifications: a small pop-up from your computer when a message
// arrives and you're looking at something else. Uses what the system already
// has (macOS: osascript, Linux: notify-send). Elsewhere it quietly does nothing
// and the terminal bell is all you get.
//
//   gossip config notify on        say who it's from (default)
//   gossip config notify preview   include the start of the message
//   gossip config notify off

const { spawn } = require('child_process');

let last = 0;

const tidy = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);

/** The command that shows a notification on this system, or null. */
function command(title, body, platform = process.platform) {
  if (platform === 'darwin') {
    const q = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return ['osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`]];
  }
  if (platform === 'linux') return ['notify-send', ['--app-name=gossip', '--', title, body]];
  return null;
}

function send(title, body) {
  const now = Date.now();
  if (now - last < 3000) return false; // a burst of messages is one pop-up, not twenty
  const cmd = command(tidy(title, 80), tidy(body, 160));
  if (!cmd) return false;
  last = now;
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // not installed: fine
    child.unref();
  } catch { /* fine */ }
  return true;
}

/** For an incoming message. mode: 'on' | 'preview' | 'off'. */
function message(mode, key, msg) {
  if (mode === 'off' || !msg || typeof msg.text !== 'string') return false;
  const where = key[0] === '#' ? `${msg.from} in ${key}` : msg.from;
  return send('gossip', mode === 'preview' ? `${where}: ${msg.text}` : `New message from ${where}`);
}

module.exports = { send, message, command };

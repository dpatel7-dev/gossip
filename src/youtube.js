'use strict';
// YouTube links: spotting them in messages, and the video's title for the player.
//
// gossip never downloads videos. They play in YouTube's own player (its
// privacy-enhanced youtube-nocookie.com one), inside gossip's player page.

const https = require('https');

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** "90", "90s", "1m30s", "1h2m3s", "1:30" -> seconds (or 0). */
function seconds(t) {
  const s = String(t || '').trim().toLowerCase();
  if (/^\d{1,6}s?$/.test(s)) return parseInt(s, 10);
  const colon = s.match(/^(?:(\d{1,3}):)?(\d{1,3}):(\d{2})$/);
  if (colon) return (parseInt(colon[1] || '0', 10) * 3600) + parseInt(colon[2], 10) * 60 + parseInt(colon[3], 10);
  const parts = s.match(/^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/);
  if (parts && s) return (parseInt(parts[1] || '0', 10) * 3600) + parseInt(parts[2] || '0', 10) * 60 + parseInt(parts[3] || '0', 10);
  return 0;
}

/** One link -> { id, start } if it's a YouTube video, else null. */
function parse(link) {
  let u;
  try {
    u = new URL(String(link || '').trim().replace(/[.,;:!?)\]'"]+$/, ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !HOSTS.has(u.hostname.toLowerCase())) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const bits = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = bits[0];
  else if (bits[0] === 'watch') id = u.searchParams.get('v');
  else if (['shorts', 'live', 'embed', 'v', 'e'].includes(bits[0])) id = bits[1];
  if (!id || !ID.test(id)) return null;
  const start = seconds(u.searchParams.get('t') || u.searchParams.get('start') || (u.hash.match(/t=([^&]+)/) || [])[1]);
  return { id, start };
}

/** Every YouTube video in a piece of text, in order, without repeats. */
function findAll(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(URL_RE)) {
    const v = parse(m[0]);
    if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); }
  }
  return out;
}

/** A short link to share: https://youtu.be/ID (?t=90). */
function link(id, start) {
  return `https://youtu.be/${id}${start ? `?t=${Math.floor(start)}` : ''}`;
}

/** The YouTube videos in one chat (or every chat), newest first. */
function videosIn(app, keys, limit = 60) {
  const out = [];
  const seen = new Set();
  const list = keys || app.vault.conversations();
  const rows = [];
  for (const key of list) {
    for (const r of app.vault.loadHistory(key, 3000)) {
      if (typeof r.text === 'string' && typeof r.from === 'string' && r.text.indexOf('http') >= 0) rows.push({ key, r });
    }
  }
  rows.sort((a, b) => b.r.ts - a.r.ts);
  for (const { key, r } of rows) {
    for (const v of findAll(r.text)) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push({ id: v.id, start: v.start, key, from: r.from, mine: r.from === app.me, ts: r.ts });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Titles come from YouTube's public oEmbed address (no account or key needed).
const titles = new Map(); // id -> { title, channel } | null
function title(id, timeout = 4000) {
  if (!ID.test(id)) return Promise.resolve(null);
  if (titles.has(id)) return Promise.resolve(titles.get(id));
  if (process.env.GOSSIP_OFFLINE_TITLES === '1') return Promise.resolve(null);
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`;
  return new Promise((resolve) => {
    const done = (v) => { if (v || !titles.has(id)) titles.set(id, v); resolve(v); };
    const req = https.get(url, { timeout, headers: { 'user-agent': 'gossip' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return done(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          done({ title: String(j.title || '').slice(0, 200), channel: String(j.author_name || '').slice(0, 100) });
        } catch {
          done(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null)); // not remembered: maybe offline for a moment
  });
}

module.exports = { ID, parse, findAll, link, seconds, videosIn, title, titles };

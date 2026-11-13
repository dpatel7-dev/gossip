'use strict';
// End-to-end encryption.
//
// The design is deliberately "classic iMessage" level, built only from
// standard, well-reviewed primitives that ship inside Node.js (OpenSSL):
//
//   identity key   Ed25519            signs messages, proves who you are
//   exchange key   X25519             lets others encrypt to you
//   message body   ChaCha20-Poly1305  fresh random key for every message
//   key wrapping   X25519 + HKDF-SHA256, one wrap per recipient
//
// The relay only ever sees ciphertext. Private keys never leave the device.
// What this does NOT give you: forward secrecy (a stolen key file can decrypt
// captured past traffic) or hidden metadata (the relay knows who talks to whom).

const crypto = require('crypto');
const { KEY_RE, SIG_RE, validEnvelope } = require('./proto');

const DH_CONTEXT = 'gossip/v1/dh-key\n';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');
const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

class CryptoError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const pubCache = new Map();
function pubKey(crv, x) {
  const k = crv + x;
  let key = pubCache.get(k);
  if (!key) {
    if (!KEY_RE.test(x)) throw new CryptoError('bad_key', 'malformed public key');
    key = crypto.createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
    if (pubCache.size > 2000) pubCache.clear();
    pubCache.set(k, key);
  }
  return key;
}

function privKey(crv, x, d) {
  return crypto.createPrivateKey({ key: { kty: 'OKP', crv, x, d }, format: 'jwk' });
}

function randomId() {
  return b64(crypto.randomBytes(12));
}

// ── identity ────────────────────────────────────────────────────────────────

function createIdentity() {
  const s = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const d = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  const id = { signPub: s.x, signKey: s.d, dhPub: d.x, dhKey: d.d };
  id.dhSig = signText(id, DH_CONTEXT + id.dhPub);
  return id;
}

function signText(identity, text) {
  const key = privKey('Ed25519', identity.signPub, identity.signKey);
  return b64(crypto.sign(null, Buffer.from(text, 'utf8'), key));
}

function verifyText(signPub, text, sig) {
  try {
    if (!SIG_RE.test(sig)) return false;
    return crypto.verify(null, Buffer.from(text, 'utf8'), pubKey('Ed25519', signPub), unb64(sig));
  } catch {
    return false;
  }
}

// The public half of an identity: safe to hand to the relay and to anyone.
function bundleOf(identity) {
  return { signPub: identity.signPub, dhPub: identity.dhPub, dhSig: identity.dhSig };
}

// A bundle is valid when the exchange key is signed by the identity key.
function validBundle(b) {
  if (!b || typeof b !== 'object') return false;
  if (typeof b.signPub !== 'string' || !KEY_RE.test(b.signPub)) return false;
  if (typeof b.dhPub !== 'string' || !KEY_RE.test(b.dhPub)) return false;
  if (typeof b.dhSig !== 'string') return false;
  return verifyText(b.signPub, DH_CONTEXT + b.dhPub, b.dhSig);
}

// Login proof: sign the relay's one-time nonce. No passwords anywhere.
function authText(nonce, name) {
  return `gossip/v1/auth\n${nonce}\n${name}`;
}
function authProof(identity, nonce, name) {
  return signText(identity, authText(nonce, name));
}
function checkAuthProof(signPub, nonce, name, sig) {
  return verifyText(signPub, authText(nonce, name), sig);
}

// ── messages ────────────────────────────────────────────────────────────────

function aeadSeal(key, nonce, plaintext, aad) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function aeadOpen(key, nonce, boxed, aad) {
  if (boxed.length < 16) throw new CryptoError('bad_ciphertext');
  const body = boxed.subarray(0, boxed.length - 16);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAAD(aad, { plaintextLength: body.length });
  d.setAuthTag(boxed.subarray(boxed.length - 16));
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new CryptoError('bad_ciphertext');
  }
}

// Everything that identifies a message is authenticated alongside it, including
// the sender's identity key, so a message can't be re-signed or re-addressed.
function aadFor(env, senderSignPub) {
  return Buffer.from(
    ['gossip/v1/msg', env.id, env.from, senderSignPub, env.conv, String(env.ts), env.eph].join('\n'),
    'utf8',
  );
}

function transcript(aad, nonce, ct) {
  return sha256('gossip/v1/sig\n', aad, '\n', nonce, ct);
}

function wrapKeyFor(shared, ephRaw, recipientDhRaw, id, name) {
  const salt = sha256(ephRaw, recipientDhRaw);
  const info = Buffer.from(`gossip/v1/wrap\n${id}\n${name}`, 'utf8');
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 44));
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32, 44) };
}

/**
 * Encrypt `payload` for a list of recipients.
 * recipients: [{ name, dhPub }]
 */
function seal({ identity, from, conv, recipients, payload, id, ts }) {
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = eph.publicKey.export({ format: 'jwk' }).x;
  const ephRaw = unb64(ephPub);

  const env = { v: 1, id: id || randomId(), from, conv, ts: ts || Date.now(), eph: ephPub };
  const aad = aadFor(env, identity.signPub);

  const messageKey = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const ct = aeadSeal(messageKey, nonce, Buffer.from(JSON.stringify(payload), 'utf8'), aad);
  env.n = b64(nonce);
  env.ct = b64(ct);

  env.keys = {};
  for (const r of recipients) {
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubKey('X25519', r.dhPub) });
    const w = wrapKeyFor(shared, ephRaw, unb64(r.dhPub), env.id, r.name);
    env.keys[r.name] = b64(aeadSeal(w.key, w.nonce, messageKey, aad));
  }

  const signer = privKey('Ed25519', identity.signPub, identity.signKey);
  env.sig = b64(crypto.sign(null, transcript(aad, nonce, ct), signer));
  return env;
}

/**
 * Verify and decrypt an envelope addressed to `me`.
 * senderSignPub must come from YOUR records (the pinned key), not the envelope.
 */
function open({ identity, me, env, senderSignPub }) {
  if (!validEnvelope(env)) throw new CryptoError('bad_envelope');
  const aad = aadFor(env, senderSignPub);
  const nonce = unb64(env.n);
  const ct = unb64(env.ct);

  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, transcript(aad, nonce, ct), pubKey('Ed25519', senderSignPub), unb64(env.sig));
  } catch { /* treated as a bad signature */ }
  if (!signatureOk) throw new CryptoError('bad_signature');

  const wrapped = Object.prototype.hasOwnProperty.call(env.keys, me) ? env.keys[me] : null;
  if (!wrapped) throw new CryptoError('not_for_me');

  let shared;
  try {
    shared = crypto.diffieHellman({
      privateKey: privKey('X25519', identity.dhPub, identity.dhKey),
      publicKey: pubKey('X25519', env.eph),
    });
  } catch {
    throw new CryptoError('bad_ciphertext');
  }
  const w = wrapKeyFor(shared, unb64(env.eph), unb64(identity.dhPub), env.id, me);
  const messageKey = aeadOpen(w.key, w.nonce, unb64(wrapped), aad);
  const plain = aeadOpen(messageKey, nonce, ct, aad);
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new CryptoError('bad_payload');
  }
}

// ── verification helpers ────────────────────────────────────────────────────

// Short, human-comparable form of one identity key.
function fingerprint(signPub) {
  return sha256('gossip/v1/fp\n', signPub).toString('hex').slice(0, 32).toUpperCase().match(/.{4}/g).join(' ');
}

// Both people see the same number; if a server swapped a key, they differ.
function safetyNumber(signPubA, signPubB) {
  const [x, y] = [signPubA, signPubB].sort();
  const h = sha256(`gossip/v1/safety\n${x}\n${y}`);
  const groups = [];
  for (let i = 0; i < 6; i++) groups.push(String(h.readUIntBE(i * 5, 5) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

module.exports = {
  CryptoError, b64, unb64, randomId,
  createIdentity, bundleOf, validBundle, signText, verifyText,
  authProof, checkAuthProof,
  seal, open, fingerprint, safetyNumber,
};

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const e2e = require('../src/e2e');
const P = require('../src/proto');

function person(name) {
  const identity = e2e.createIdentity();
  return { name, identity, bundle: { name, ...e2e.bundleOf(identity) } };
}

test('identity bundles verify, and tampered ones do not', () => {
  const a = person('alice');
  assert.equal(e2e.validBundle(a.bundle), true);
  const other = person('mallory');
  assert.equal(e2e.validBundle({ ...a.bundle, dhPub: other.bundle.dhPub }), false);
  assert.equal(e2e.validBundle({ ...a.bundle, signPub: other.bundle.signPub }), false);
  assert.equal(e2e.validBundle({}), false);
  assert.equal(e2e.validBundle(null), false);
});

test('auth proof is bound to nonce and name', () => {
  const a = person('alice');
  const sig = e2e.authProof(a.identity, 'nonce-1', 'alice');
  assert.equal(e2e.checkAuthProof(a.bundle.signPub, 'nonce-1', 'alice', sig), true);
  assert.equal(e2e.checkAuthProof(a.bundle.signPub, 'nonce-2', 'alice', sig), false);
  assert.equal(e2e.checkAuthProof(a.bundle.signPub, 'nonce-1', 'alicia', sig), false);
  assert.equal(e2e.checkAuthProof(person('bob').bundle.signPub, 'nonce-1', 'alice', sig), false);
});

test('a DM round-trips and passes the relay shape check', () => {
  const a = person('alice');
  const b = person('bob');
  const conv = P.dmConv('alice', 'bob');
  const env = e2e.seal({ identity: a.identity, from: 'alice', conv, recipients: [b.bundle], payload: { text: 'hi bob 👋' } });
  assert.equal(P.validEnvelope(env), true);
  assert.equal(JSON.stringify(env).includes('hi bob'), false, 'plaintext must not appear in the envelope');
  const out = e2e.open({ identity: b.identity, me: 'bob', env, senderSignPub: a.bundle.signPub });
  assert.deepEqual(out, { text: 'hi bob 👋' });
});

test('a room message opens for every member and nobody else', () => {
  const [a, b, c, eve] = ['alice', 'bob', 'carol', 'eve'].map(person);
  const env = e2e.seal({
    identity: a.identity, from: 'alice', conv: P.roomConv('general'),
    recipients: [b.bundle, c.bundle], payload: { text: 'hello room' },
  });
  for (const m of [b, c]) {
    // the relay strips other people's key wraps before delivering
    const delivered = { ...env, keys: { [m.name]: env.keys[m.name] } };
    assert.equal(e2e.open({ identity: m.identity, me: m.name, env: delivered, senderSignPub: a.bundle.signPub }).text, 'hello room');
  }
  assert.throws(() => e2e.open({ identity: eve.identity, me: 'eve', env, senderSignPub: a.bundle.signPub }), { code: 'not_for_me' });
  // eve can't use someone else's wrap either
  const stolen = { ...env, keys: { eve: env.keys.bob } };
  assert.throws(() => e2e.open({ identity: eve.identity, me: 'eve', env: stolen, senderSignPub: a.bundle.signPub }), { code: 'bad_ciphertext' });
});

test('tampering is detected', () => {
  const a = person('alice');
  const b = person('bob');
  const m = person('mallory');
  const conv = P.dmConv('alice', 'bob');
  const env = e2e.seal({ identity: a.identity, from: 'alice', conv, recipients: [b.bundle], payload: { text: 'pay bob $5' } });
  const openAs = (e, signPub = a.bundle.signPub) => e2e.open({ identity: b.identity, me: 'bob', env: e, senderSignPub: signPub });

  const flip = (s) => (s[5] === 'A' ? s.slice(0, 5) + 'B' + s.slice(6) : s.slice(0, 5) + 'A' + s.slice(6));
  assert.throws(() => openAs({ ...env, ct: flip(env.ct) }), { code: 'bad_signature' });
  assert.throws(() => openAs({ ...env, ts: env.ts + 1 }), { code: 'bad_signature' });
  assert.throws(() => openAs({ ...env, conv: P.dmConv('bob', 'carol') }), { code: 'bad_signature' });
  assert.throws(() => openAs({ ...env, keys: { bob: flip(env.keys.bob) } }), { code: 'bad_ciphertext' });
  // wrong pinned key for the sender (e.g. an impostor "alice")
  assert.throws(() => openAs(env, m.bundle.signPub), { code: 'bad_signature' });

  // Mallory strips Alice's signature and claims the message as her own.
  const forged = { ...env, from: 'mallory' };
  const crypto = require('crypto');
  // even with a valid signature of her own over the modified header, the body won't open
  assert.throws(() => e2e.open({ identity: b.identity, me: 'bob', env: forged, senderSignPub: m.bundle.signPub }));
  assert.ok(crypto);
});

test('safety numbers are symmetric and key-specific', () => {
  const a = person('alice');
  const b = person('bob');
  const c = person('carol');
  const ab = e2e.safetyNumber(a.bundle.signPub, b.bundle.signPub);
  assert.equal(ab, e2e.safetyNumber(b.bundle.signPub, a.bundle.signPub));
  assert.notEqual(ab, e2e.safetyNumber(a.bundle.signPub, c.bundle.signPub));
  assert.match(ab, /^(\d{5} ){5}\d{5}$/);
  assert.match(e2e.fingerprint(a.bundle.signPub), /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
});

test('names and conversation ids', () => {
  assert.equal(P.validName('dhruv'), true);
  assert.equal(P.validName('a'), false);
  assert.equal(P.validName('Dhruv'), false);
  assert.equal(P.validName('you'), false);
  assert.equal(P.validName('has space'), false);
  assert.equal(P.validName('x'.repeat(21)), false);
  assert.equal(P.cleanName(' @Maya '), 'maya');
  assert.equal(P.dmConv('bob', 'alice'), 'dm:alice:bob');
  assert.deepEqual(P.parseConv('dm:alice:bob'), { kind: 'dm', a: 'alice', b: 'bob' });
  assert.equal(P.parseConv('dm:bob:alice'), null);
  assert.equal(P.parseConv('dm:alice:alice'), null);
  assert.deepEqual(P.parseConv('room:general'), { kind: 'room', room: 'general' });
  assert.equal(P.parseConv('room:Bad Room'), null);
});

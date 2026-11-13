'use strict';
// Starts a real relay on a random local port and talks to it over real sockets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Relay } = require('../server/relay');
const { Link } = require('../src/net');
const ws = require('../src/ws');
const e2e = require('../src/e2e');
const P = require('../src/proto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRelay(opts = {}) {
  const relay = new Relay({ port: 0, host: '127.0.0.1', quiet: true, ...opts });
  await relay.start();
  relay.url = `ws://127.0.0.1:${relay.port}`;
  return relay;
}

function client(relay, name, identity = e2e.createIdentity(), mode = 'live') {
  const link = new Link({ url: relay.url, identity, name, mode });
  const c = { name, identity, link, pushes: [], bundle: { name, ...e2e.bundleOf(identity) } };
  link.on('push', (m) => c.pushes.push(m));
  c.ready = new Promise((resolve, reject) => {
    link.once('ready', resolve);
    link.once('authfail', reject);
  });
  c.next = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = c.pushes.findIndex(pred);
      if (i >= 0) return c.pushes.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`${name}: timed out waiting for a push`);
      await sleep(10);
    }
  };
  link.start();
  return c;
}

const dm = (from, to, text) => e2e.seal({
  identity: from.identity, from: from.name, conv: P.dmConv(from.name, to.name),
  recipients: [to.bundle], payload: { text },
});

test('websocket: large and tiny messages survive the trip', async () => {
  const relay = await startRelay();
  const conn = await ws.connect(relay.url);
  const hello = await new Promise((r) => conn.once('message', r));
  assert.equal(JSON.parse(hello).t, 'hello');
  conn.send(JSON.stringify({ t: 'ping', rid: 1 }));
  const pong = await new Promise((r) => conn.once('message', r));
  assert.deepEqual(JSON.parse(pong), { t: 'ok', rid: 1 });
  // oversize frames are refused
  const closed = new Promise((r) => conn.once('close', (code) => r(code)));
  conn.send('x'.repeat(P.LIMITS.frame + 10));
  assert.equal(await closed, 1009);
  await relay.stop();
});

test('http: health check answers', async () => {
  const relay = await startRelay();
  const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /gossip relay v/);
  await relay.stop();
});

test('sign-up, name ownership, and lookups', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  const first = await alice.ready;
  assert.equal(first.created, true);

  // somebody else can't take the name
  const impostor = client(relay, 'alice');
  await assert.rejects(impostor.ready, { code: 'name_taken' });
  assert.equal(impostor.link.fatal, true);

  // bad names are refused
  const bad = client(relay, 'admin');
  await assert.rejects(bad.ready, { code: 'bad_name' });

  const bob = client(relay, 'bob');
  await bob.ready;
  const found = await bob.link.request('lookup', { name: 'alice' });
  assert.equal(found.user.signPub, alice.bundle.signPub);
  assert.equal(e2e.validBundle(found.user), true);
  await assert.rejects(bob.link.request('lookup', { name: 'nobody' }), { code: 'no_such_user' });

  alice.link.stop(); bob.link.stop();
  await relay.stop();
});

test('DMs: live delivery, receipts, offline queue, redelivery until confirmed', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  await Promise.all([alice.ready, bob.ready]);

  // live
  const env = dm(alice, bob, 'hello bob');
  const ack = await alice.link.request('send', { env });
  assert.equal(ack.id, env.id);
  const got = await bob.next((m) => m.t === 'msg');
  assert.deepEqual(Object.keys(got.env.keys), ['bob']);
  assert.equal(e2e.open({ identity: bob.identity, me: 'bob', env: got.env, senderSignPub: alice.bundle.signPub }).text, 'hello bob');
  // the relay never saw the text
  assert.equal(JSON.stringify([...relay.db.bodies]).includes('hello bob'), false);

  // not confirmed yet -> still queued; confirmed -> gone + receipt to sender
  assert.equal(relay.db.queues.get('bob').length, 1);
  bob.link.notify('got', { mids: [got.mid] });
  const receipt = await alice.next((m) => m.t === 'receipt');
  assert.equal(receipt.id, env.id);
  assert.equal(receipt.by, 'bob');
  assert.equal(relay.db.queues.has('bob'), false);
  assert.equal(relay.db.bodies.size, 0);

  // offline: bob leaves, alice sends two, bob returns and gets both in order
  bob.link.stop();
  await sleep(50);
  const e1 = dm(alice, bob, 'one');
  const e2 = dm(alice, bob, 'two');
  await alice.link.request('send', { env: e1 });
  await alice.link.request('send', { env: e2 });
  // a duplicate send (retry after a dropped connection) is not queued twice
  await alice.link.request('send', { env: e2 });
  assert.equal(relay.db.queues.get('bob').length, 2);

  const bob2 = client(relay, 'bob', bob.identity);
  await bob2.ready;
  const m1 = await bob2.next((m) => m.t === 'msg');
  const m2 = await bob2.next((m) => m.t === 'msg');
  assert.deepEqual([m1.env.id, m2.env.id], [e1.id, e2.id]);

  // bob drops before confirming -> delivered again next time
  bob2.link.stop();
  await sleep(50);
  const bob3 = client(relay, 'bob', bob.identity);
  await bob3.ready;
  const again = await bob3.next((m) => m.t === 'msg');
  assert.equal(again.env.id, e1.id);

  alice.link.stop(); bob3.link.stop();
  await relay.stop();
});

test('senders cannot spoof, and strangers cannot post into rooms', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  const eve = client(relay, 'eve');
  await Promise.all([alice.ready, bob.ready, eve.ready]);

  // eve signs a message but labels it as coming from alice
  const spoof = e2e.seal({ identity: eve.identity, from: 'alice', conv: P.dmConv('alice', 'bob'), recipients: [bob.bundle], payload: { text: 'x' } });
  await assert.rejects(eve.link.request('send', { env: spoof }), { code: 'bad_message' });

  await alice.link.request('create', { room: 'secret', private: true });
  const post = e2e.seal({ identity: eve.identity, from: 'eve', conv: P.roomConv('secret'), recipients: [alice.bundle], payload: { text: 'x' } });
  await assert.rejects(eve.link.request('send', { env: post }), { code: 'not_member' });
  await assert.rejects(eve.link.request('join', { room: 'secret' }), { code: 'invite_only' });
  await assert.rejects(eve.link.request('members', { room: 'secret' }), { code: 'not_member' });
  const listed = await eve.link.request('rooms');
  assert.equal(listed.rooms.some((r) => r.name === 'secret'), false, 'private rooms are not listed');

  for (const c of [alice, bob, eve]) c.link.stop();
  await relay.stop();
});

test('rooms: create, join, fan-out, invites, leave', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  const carol = client(relay, 'carol');
  await Promise.all([alice.ready, bob.ready, carol.ready]);

  await alice.link.request('create', { room: 'general' });
  await assert.rejects(alice.link.request('create', { room: 'general' }), { code: 'room_exists' });
  await assert.rejects(bob.link.request('join', { room: 'nope' }), { code: 'no_such_room' });

  const joined = await bob.link.request('join', { room: 'general' });
  assert.deepEqual(joined.members.map((m) => m.name).sort(), ['alice', 'bob']);
  const ev = await alice.next((m) => m.t === 'room' && m.event === 'join');
  assert.equal(ev.user.name, 'bob');
  assert.equal(e2e.validBundle(ev.user), true);

  // private room + invite
  await alice.link.request('create', { room: 'club', private: true });
  await alice.link.request('invite', { room: 'club', name: 'carol' });
  const inv = await carol.next((m) => m.t === 'room' && m.event === 'invite');
  assert.deepEqual([inv.room, inv.by], ['club', 'alice']);
  await carol.link.request('join', { room: 'club' });

  // fan-out: each member only receives their own key wrap
  await carol.link.request('join', { room: 'general' });
  const env = e2e.seal({
    identity: alice.identity, from: 'alice', conv: P.roomConv('general'),
    recipients: [bob.bundle, carol.bundle], payload: { text: 'hi all' },
  });
  await alice.link.request('send', { env });
  for (const c of [bob, carol]) {
    const got = await c.next((m) => m.t === 'msg');
    assert.deepEqual(Object.keys(got.env.keys), [c.name]);
    assert.equal(e2e.open({ identity: c.identity, me: c.name, env: got.env, senderSignPub: alice.bundle.signPub }).text, 'hi all');
    c.link.notify('got', { mids: [got.mid] });
  }
  await sleep(50);
  assert.equal(relay.db.bodies.size, 0, 'ciphertext is deleted once everyone confirmed');

  await bob.link.request('leave', { room: 'general' });
  const left = await alice.next((m) => m.t === 'room' && m.event === 'leave');
  assert.equal(left.name, 'bob');

  for (const c of [alice, bob, carol]) c.link.stop();
  await relay.stop();
});

test('presence is mutual, blocking is silent', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  await Promise.all([alice.ready, bob.ready]);

  // alice adds bob, but bob hasn't added alice: nothing is revealed
  let res = await alice.link.request('watch', { names: ['bob'] });
  assert.deepEqual(res.online, []);
  // now it's mutual
  res = await bob.link.request('watch', { names: ['alice'] });
  assert.deepEqual(res.online, ['alice']);
  const on = await alice.next((m) => m.t === 'presence');
  assert.deepEqual([on.name, on.online], ['bob', true]);
  bob.link.stop();
  const off = await alice.next((m) => m.t === 'presence');
  assert.deepEqual([off.name, off.online], ['bob', false]);

  // blocking: the blocked sender still gets "sent", but nothing is stored or delivered
  const bob2 = client(relay, 'bob', bob.identity);
  await bob2.ready;
  await bob2.link.request('block', { name: 'alice' });
  await alice.link.request('send', { env: dm(alice, bob2, 'hello?') });
  await sleep(80);
  assert.equal(bob2.pushes.some((m) => m.t === 'msg'), false);
  assert.equal(relay.db.bodies.size, 0);

  alice.link.stop(); bob2.link.stop();
  await relay.stop();
});

test('one account, several terminals: live, peek and post sessions', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  await Promise.all([alice.ready, bob.ready]);
  await alice.link.request('watch', { names: ['bob'] });
  await bob.link.request('watch', { names: ['alice'] });
  await alice.next((m) => m.t === 'presence' && m.online);

  // bob opens a one-off "post" session (gossip squawk): the live one is NOT kicked
  const poster = client(relay, 'bob', bob.identity, 'post');
  await poster.ready;
  assert.equal(bob.link.state, 'online');
  assert.equal(relay.online.get('bob').size, 2);

  // a message for bob reaches the live session only
  const env = dm(alice, bob, 'for bob');
  await alice.link.request('send', { env });
  await bob.next((m) => m.t === 'msg');
  await sleep(60);
  assert.equal(poster.pushes.some((m) => m.t === 'msg'), false, 'post sessions never receive messages');
  assert.equal(poster.pushes.some((m) => m.t === 'caught_up'), false);

  // the post session leaving does not make bob look offline
  poster.link.stop();
  await sleep(60);
  assert.equal(alice.pushes.some((m) => m.t === 'presence' && m.online === false), false);

  // bob goes away entirely; a "peek" session (gossip check) collects mail without showing as online
  bob.link.stop();
  await alice.next((m) => m.t === 'presence' && m.online === false);
  const e2 = dm(alice, bob, 'while you were out');
  await alice.link.request('send', { env: e2 });
  const peek = client(relay, 'bob', bob.identity, 'peek');
  const res = await peek.ready;
  assert.equal(res.waiting, 2);
  const m1 = await peek.next((m) => m.t === 'msg');
  const m2 = await peek.next((m) => m.t === 'msg');
  const done = await peek.next((m) => m.t === 'caught_up');
  assert.equal(done.n, 2);
  assert.deepEqual([m1.env.id, m2.env.id], [env.id, e2.id]);
  const seen = await peek.link.request('watch', { names: ['alice'] });
  assert.deepEqual(seen.online, ['alice'], 'a peek session can still ask who is online');
  await sleep(60);
  assert.equal(alice.pushes.some((m) => m.t === 'presence' && m.online === true), false, 'peeking is invisible');
  const health = await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).text();
  assert.match(health, / 1 online/);

  alice.link.stop(); peek.link.stop();
  await relay.stop();
});

test('joining a room from one terminal tells your other terminals', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  await alice.ready;
  const second = client(relay, 'alice', alice.identity, 'post');
  await second.ready;
  await second.link.request('create', { room: 'general' });
  const ev = await alice.next((m) => m.t === 'room');
  assert.deepEqual([ev.event, ev.room], ['self_join', 'general']);
  await second.link.request('leave', { room: 'general' });
  const ev2 = await alice.next((m) => m.t === 'room');
  assert.equal(ev2.event, 'self_leave');
  alice.link.stop(); second.link.stop();
  await relay.stop();
});

test('only the owner can kick; a kicked member stays out until invited back', async () => {
  const relay = await startRelay();
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  const carol = client(relay, 'carol');
  await Promise.all([alice.ready, bob.ready, carol.ready]);
  await alice.link.request('create', { room: 'den' });
  await bob.link.request('join', { room: 'den' });
  const joined = await carol.link.request('join', { room: 'den' });
  assert.equal(joined.room.owner, 'alice');

  await assert.rejects(bob.link.request('kick', { room: 'den', name: 'carol' }), { code: 'not_owner' });
  await assert.rejects(alice.link.request('kick', { room: 'den', name: 'alice' }), { code: 'bad_name' });
  await assert.rejects(alice.link.request('kick', { room: 'den', name: 'nobody' }), { code: 'not_there' });
  await assert.rejects(carol.link.request('kick', { room: 'nope', name: 'bob' }), { code: 'not_member' });

  await alice.link.request('kick', { room: 'den', name: 'carol' });
  const told = await carol.next((m) => m.t === 'room' && m.event === 'kicked');
  assert.deepEqual([told.room, told.by], ['den', 'alice']);
  const seen = await bob.next((m) => m.t === 'room' && m.event === 'kick');
  assert.deepEqual([seen.name, seen.by], ['carol', 'alice']);
  assert.equal(relay.db.rooms.get('den').members.has('carol'), false);

  // out means out: can't post, can't read the member list, can't walk back in
  const post = e2e.seal({ identity: carol.identity, from: 'carol', conv: P.roomConv('den'), recipients: [alice.bundle], payload: { text: 'x' } });
  await assert.rejects(carol.link.request('send', { env: post }), { code: 'not_member' });
  await assert.rejects(carol.link.request('members', { room: 'den' }), { code: 'not_member' });
  await assert.rejects(carol.link.request('join', { room: 'den' }), { code: 'removed' });
  // ...and a regular member can't sneak them back in
  await assert.rejects(bob.link.request('invite', { room: 'den', name: 'carol' }), { code: 'removed' });

  // a message sent after the kick is not delivered to them
  const env = e2e.seal({ identity: alice.identity, from: 'alice', conv: P.roomConv('den'), recipients: [bob.bundle, carol.bundle], payload: { text: 'members only' } });
  await alice.link.request('send', { env });
  await bob.next((m) => m.t === 'msg');
  await sleep(60);
  assert.equal(carol.pushes.some((m) => m.t === 'msg'), false);

  // the owner can invite them back
  await alice.link.request('invite', { room: 'den', name: 'carol' });
  await carol.link.request('join', { room: 'den' });
  assert.equal(relay.db.rooms.get('den').members.has('carol'), true);

  // kicked while offline: they're told next time they check in
  carol.link.stop();
  await sleep(40);
  await alice.link.request('kick', { room: 'den', name: 'carol' });
  const back = client(relay, 'carol', carol.identity, 'peek');
  const res = await back.ready;
  assert.deepEqual(res.notices, [{ kind: 'kicked', room: 'den', by: 'alice' }]);

  // when the owner leaves, the longest-standing member takes over
  await alice.link.request('leave', { room: 'den' });
  const left = await bob.next((m) => m.t === 'room' && m.event === 'leave');
  assert.equal(left.owner, 'bob');
  assert.equal(relay.db.rooms.get('den').owner, 'bob');

  for (const c of [alice, bob, back]) c.link.stop();
  await relay.stop();
});

test('relay options: closed sign-ups and a member limit', async () => {
  const relay = await startRelay({ maxMembers: 2 });
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  const carol = client(relay, 'carol');
  await Promise.all([alice.ready, bob.ready, carol.ready]);
  await alice.link.request('create', { room: 'tiny' });
  await bob.link.request('join', { room: 'tiny' });
  await assert.rejects(carol.link.request('join', { room: 'tiny' }), { code: 'room_full' });

  relay.opts.signups = false;
  const dave = client(relay, 'dave');
  await assert.rejects(dave.ready, { code: 'signups_closed' });
  const again = client(relay, 'alice', alice.identity, 'post');
  await again.ready; // existing accounts still get in
  for (const c of [alice, bob, carol, again]) c.link.stop();
  await relay.stop();
});

test('the database survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-test-'));
  let relay = await startRelay({ dataDir: dir });
  const alice = client(relay, 'alice');
  const bob = client(relay, 'bob');
  await Promise.all([alice.ready, bob.ready]);
  await alice.link.request('create', { room: 'general' });
  bob.link.stop();
  await sleep(30);
  const env = dm(alice, bob, 'see you after the restart');
  await alice.link.request('send', { env });
  alice.link.stop();
  await relay.stop();

  relay = await startRelay({ dataDir: dir });
  const bob2 = client(relay, 'bob', bob.identity);
  const res = await bob2.ready;
  assert.equal(res.created, false);
  const got = await bob2.next((m) => m.t === 'msg');
  assert.equal(e2e.open({ identity: bob.identity, me: 'bob', env: got.env, senderSignPub: alice.bundle.signPub }).text, 'see you after the restart');
  assert.equal(relay.db.rooms.get('general').members.has('alice'), true);
  // still nobody else can claim alice
  const impostor = client(relay, 'alice');
  await assert.rejects(impostor.ready, { code: 'name_taken' });
  bob2.link.stop();
  await relay.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

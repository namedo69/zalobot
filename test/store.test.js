import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const credentials = { imei: 'device', userAgent: 'agent', cookie: [{ key: 'session', value: 'secret-cookie', domain: 'zalo.me' }] };
test('session encryption round-trips, rejects wrong key/tampering and never stores plaintext', t => {
  const store = new Store(':memory:', randomBytes(32));
  t.after(() => store.close());
  store.saveCredentials(credentials);
  assert.deepEqual(store.loadCredentials(), credentials);
  const encrypted = store.db.prepare('SELECT encrypted FROM credentials').get().encrypted;
  assert.equal(encrypted.includes('secret-cookie'), false);
  const key = store.key;
  store.key = randomBytes(32);
  assert.throws(() => store.loadCredentials());
  store.key = key;
  const bytes = Buffer.from(encrypted, 'base64'); bytes[bytes.length - 1] ^= 1;
  store.db.prepare('UPDATE credentials SET encrypted=?').run(bytes.toString('base64'));
  assert.throws(() => store.loadCredentials());
  store.clearCredentials();
  assert.equal(store.loadCredentials(), null);
});
test('pairing is single use, time bounded, hashed and revocable', t => {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  const invite = store.createInvite('User', 0);
  assert.equal(store.authenticate(invite.token).recipient_id, null);
  assert.equal(store.authenticate('bad-token'), undefined);
  assert.equal(store.bind('bad-code', '100', 1), false);
  assert.equal(store.bind(invite.code, '100', 599999), true);
  assert.equal(store.bind(invite.code, '101', 599999), false);
  assert.equal(store.authenticate(invite.token).recipient_id, '100');
  const second = store.createInvite('Other', 0);
  assert.equal(store.bind(second.code, '100', 1), false);
  assert.equal(store.bind(second.code, '101', 600000), false);
  const raw = store.db.prepare('SELECT * FROM devices WHERE id=?').get(second.id);
  assert.notEqual(raw.token_hash, second.token); assert.notEqual(raw.code_hash, second.code);
  assert.equal(JSON.stringify(store.listDevices()).includes(second.token), false);
  assert.equal(store.revoke(invite.id), true);
  assert.equal(store.authenticate(invite.token), undefined);
  assert.equal(store.bind(second.code, '100', 2), true);
});
test('persisted send claims become unknown on restart; bot identity cannot be switched', t => {
  mkdirSync(join(tmpdir(), 'opencode'), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'opencode', 'obee-notifier-test-'));
  const path = join(dir, 'db.sqlite'); const key = randomBytes(32);
  let store = new Store(path, key);
  const invite = store.createInvite('User', 0);
  store.bindBotIdentity('100'); store.saveCredentials(credentials);
  store.claim(invite.id, 'event-1', 'hash', 0);
  store.claim(invite.id, 'event-2', 'hash', 0); store.finish(invite.id, 'event-2', 'sent');
  store.close(); store = new Store(path, key);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.delivery(invite.id, 'event-1').status, 'unknown');
  assert.equal(store.delivery(invite.id, 'event-2').status, 'sent');
  assert.deepEqual(store.loadCredentials(), credentials);
  store.clearCredentials(); store.bindBotIdentity('100');
  assert.throws(() => store.bindBotIdentity('101'), /different Zalo bot/);
});

test('seeded invite lifecycle agrees with independent expiry/revocation model', t => {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  let seed = 0xC0FFEE;
  for (let i = 0; i < 200; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const elapsed = seed % 900001;
    const revoked = seed % 3 === 0;
    const invite = store.createInvite(`User ${i}`, 1000);
    if (revoked) store.revoke(invite.id);
    const expected = !revoked && elapsed < 600000;
    assert.equal(store.bind(invite.code, String(1000 + i), 1000 + elapsed), expected, `i=${i} elapsed=${elapsed} revoked=${revoked}`);
    assert.equal(store.bind(invite.code, String(2000 + i), 1000 + elapsed), false, `replay i=${i}`);
  }
});

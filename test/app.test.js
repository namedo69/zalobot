import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

const adminToken = 'A'.repeat(43);
const now = Date.parse('2026-11-27T08:00:00+07:00');
class FakeBot {
  ready = true;
  sent = [];
  fail = false;
  hold = null;
  status() { return { state: this.ready ? 'connected' : 'logged_out', ready: this.ready }; }
  qrImage() { return Buffer.from('private-QR'); }
  startQR() { return true; }
  async restore() { return true; }
  logout() { this.ready = false; return true; }
  async send(recipient, text) {
    this.sent.push({ recipient, text });
    if (this.fail) throw new Error('private error/cookie');
    if (this.hold) await this.hold;
  }
}
async function setup(t, sendTimeoutMs = 1000) {
  const store = new Store(':memory:', randomBytes(32)); const bot = new FakeBot();
  const server = createApp({ store, bot, adminToken, publicUrl: 'https://bot.example', now: () => now, sendTimeoutMs }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { token = adminToken, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => fetch(base + path, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const invite = store.createInvite('Luong', now); store.bind(invite.code, '100', now);
  const payload = () => ({ eventId: randomUUID(), kind: 'failed', punch: 'in', scheduledAt: '2026-11-27T07:55:00+07:00', reason: 'ip_invalid' });
  return { request, store, bot, invite, payload };
}
test('acceptance: provision, pair, send exact alert once, then revoke', async t => {
  const { request, store, bot, payload } = await setup(t);
  const created = await request('/admin-api/devices', { body: { name: 'Second laptop' } });
  assert.equal(created.status, 201); const invite = await created.json();
  assert.equal(store.bind(invite.code, '200', now), true);
  const body = payload();
  const sent = await request('/api/v1/alerts', { token: invite.token, body });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).status, 'sent');
  assert.deepEqual(bot.sent, [{ recipient: '200', text: 'OBee 07:55 27/11/26 — Không chấm được lượt vào: IP không hợp lệ. Vui lòng kiểm tra OBee và chấm thủ công nếu cần.' }]);
  const duplicate = await request('/api/v1/alerts', { token: invite.token, body });
  assert.equal((await duplicate.json()).duplicate, true); assert.equal(bot.sent.length, 1);
  await request(`/admin-api/devices/${invite.id}`, { method: 'DELETE' });
  assert.equal((await request('/api/v1/status', { token: invite.token })).status, 401);
});
test('authentication, QR privacy, origins and cross-role access fail closed', async t => {
  const { request, invite } = await setup(t);
  for (const path of ['/admin-api/status', '/admin-api/qr', '/api/v1/status']) {
    assert.equal((await request(path, { token: null })).status, 401);
  }
  assert.equal((await request('/admin-api/qr', { token: invite.token })).status, 401);
  assert.equal((await request('/api/v1/status')).status, 401);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }])
    assert.equal((await request('/admin-api/status', { headers })).status, 403);
  const qr = await request('/admin-api/qr');
  assert.equal(qr.status, 200); assert.equal(qr.headers.get('cache-control'), 'no-store');
  assert.equal(qr.headers.get('access-control-allow-origin'), null);
  const html = await request('/admin', { token: null });
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await html.text()).includes(adminToken), false);
});
test('strict payloads reject arbitrary text, recipients, unknown fields, malformed dates and oversize data', async t => {
  const { request, bot, invite, payload } = await setup(t);
  for (const body of [{ ...payload(), text: 'spam' }, { ...payload(), recipientId: '999' }, { ...payload(), cookie: 'secret' },
    { ...payload(), reason: 'anything' }, { ...payload(), scheduledAt: 'bad' }, { ...payload(), eventId: 'bad' },
    { ...payload(), scheduledAt: '2020-01-01T00:00:00Z' }])
    assert.equal((await request('/api/v1/alerts', { token: invite.token, body })).status, 400);
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body: { text: 'a'.repeat(5000) } })).status, 413);
  assert.equal(bot.sent.length, 0);
});
test('bot offline/unpaired do not claim delivery; event mutation conflicts and per-device caps apply', async t => {
  const { request, store, bot, invite, payload } = await setup(t);
  const unpaired = store.createInvite('Waiting', now);
  assert.equal((await request('/api/v1/alerts', { token: unpaired.token, body: payload() })).status, 409);
  bot.ready = false;
  const body = payload();
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body })).status, 503);
  assert.equal(store.delivery(invite.id, body.eventId), undefined);
  bot.ready = true;
  await request('/api/v1/alerts', { token: invite.token, body });
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body: { ...body, reason: 'gps_invalid' } })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await request('/api/v1/alerts', { token: invite.token, body: payload() })).status, 200);
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body: payload() })).status, 429);
  assert.equal(bot.sent.length, 3);
});
test('failed and timed-out sends stay unknown and are never retried automatically', async t => {
  const { request, store, bot, invite, payload } = await setup(t, 20);
  const body = payload(); bot.fail = true;
  const failed = await request('/api/v1/alerts', { token: invite.token, body });
  assert.equal(failed.status, 502); assert.equal((await failed.text()).includes('private error'), false);
  bot.fail = false;
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body })).status, 409);
  assert.equal(bot.sent.length, 1);
  let release;
  bot.hold = new Promise(resolve => { release = resolve; });
  const timedBody = payload();
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body: timedBody })).status, 502);
  assert.equal(store.delivery(invite.id, timedBody.eventId).status, 'unknown');
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body: payload() })).status, 503);
  release();
});
test('admin test-message uses the same durable deduplication and device binding', async t => {
  const { request, bot, invite } = await setup(t);
  const body = { eventId: randomUUID() };
  assert.equal((await request(`/admin-api/devices/${invite.id}/test`, { body })).status, 200);
  assert.equal((await request(`/admin-api/devices/${invite.id}/test`, { body })).status, 200);
  assert.deepEqual(bot.sent, [{ recipient: '100', text: 'OBee — Tin nhắn thử. Bot đã sẵn sàng gửi cảnh báo chấm công.' }]);
});

test('daily device limit and hourly global limit block sends independently of minute limit', async t => {
  const { request, store, bot, invite, payload } = await setup(t);
  for (let i = 0; i < 20; i++) store.claim(invite.id, randomUUID(), 'hash', now - 2 * 3600000);
  assert.equal((await request('/api/v1/alerts', { token: invite.token, body: payload() })).status, 429);
  const other = store.createInvite('Other', now); store.bind(other.code, '200', now);
  for (let i = 0; i < 60; i++) store.claim(invite.id, randomUUID(), 'hash', now - 120000);
  assert.equal((await request('/api/v1/alerts', { token: other.token, body: payload() })).status, 429);
  assert.equal(bot.sent.length, 0);
});

test('admin bot lifecycle routes are authenticated and expose no library secrets', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/admin-api/bot/qr', { body: {} })).status, 202);
  assert.equal((await request('/admin-api/bot/reconnect', { body: {} })).status, 200);
  assert.equal((await request('/admin-api/bot/logout', { body: {} })).status, 200);
  assert.equal((await request('/admin-api/status')).status, 200);
});

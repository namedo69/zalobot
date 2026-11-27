import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { LoginQRCallbackEventType as QR, ThreadType } from 'zca-js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';

function setup(t) {
  const store = new Store(':memory:', randomBytes(32));
  const credentials = { imei: 'imei', userAgent: 'agent', cookie: [{ key: 'session', value: 'cookie', domain: 'zalo.me' }] };
  const listener = new EventEmitter(); listener.start = () => listener.emit('connected'); listener.stop = () => listener.emit('closed');
  const messages = [];
  const api = { listener, getContext: () => ({ uid: '999' }), getCookie: () => ({ toJSON: () => ({ cookies: credentials.cookie }) }),
    sendMessage: async (...args) => { messages.push(args); } };
  const client = { login: async () => api, loginQR: async (_options, callback) => {
    callback({ type: QR.QRCodeGenerated, data: { image: Buffer.from('qr').toString('base64') }, actions: { abort() {} } });
    callback({ type: QR.GotLoginInfo, data: credentials }); return api;
  } };
  const bot = new Bot(store, { createClient: () => client, now: () => 10 });
  t.after(() => { bot.stop(); store.close(); });
  return { store, credentials, api, client, bot, messages };
}
test('QR login persists canonical session and only binds a direct, non-self exact pairing command', async t => {
  const { bot, store, api, messages, credentials } = setup(t);
  assert.equal(bot.startQR(), true); assert.equal(bot.startQR(), false);
  await bot.pending;
  assert.equal(bot.status().ready, true); assert.equal(bot.qrImage(), null);
  assert.deepEqual(store.loadCredentials(), credentials);
  const invite = store.createInvite('User', 0);
  const message = { type: ThreadType.User, isSelf: false, threadId: '100', data: { content: `OBEE ${invite.code}` } };
  api.listener.emit('message', { ...message, type: ThreadType.Group });
  api.listener.emit('message', { ...message, isSelf: true });
  api.listener.emit('message', { ...message, data: { content: 'hello private chat' } });
  assert.equal(store.authenticate(invite.token).recipient_id, null);
  api.listener.emit('message', message);
  assert.equal(store.authenticate(invite.token).recipient_id, '100');
  assert.equal(messages.length, 0);
  await bot.send('100', 'test'); assert.deepEqual(messages, [[{ msg: 'test' }, '100', ThreadType.User]]);
  api.listener.emit('disconnected'); assert.equal(bot.status().ready, false);
  await assert.rejects(bot.send('100', 'test'));
  assert.equal(await bot.restore(), true); assert.equal(bot.status().ready, true);
  assert.equal(bot.logout(), true); assert.equal(store.loadCredentials(), null);
});
test('expired QR is aborted, cleared and can be recreated', async t => {
  const { bot, client } = setup(t);
  let aborted = false;
  client.loginQR = async (_options, callback) => {
    callback({ type: QR.QRCodeExpired, actions: { abort() { aborted = true; } } });
    throw new Error('expired');
  };
  bot.startQR(); await bot.pending;
  assert.equal(aborted, true); assert.equal(bot.qrImage(), null);
  assert.equal(bot.status().state, 'qr_expired_or_declined'); assert.equal(bot.startQR(), true); await bot.pending;
});
test('network login failures do not erase stored sessions; wrong encryption is a fatal integrity error', async t => {
  const { bot, store, credentials, client } = setup(t);
  store.saveCredentials(credentials);
  client.login = async () => { throw new Error('private failure'); };
  assert.equal(await bot.restore(), false); assert.equal(bot.status().state, 'login_failed');
  assert.deepEqual(store.loadCredentials(), credentials);
  store.key = randomBytes(32);
  await assert.rejects(bot.restore());
});
test('switching bot accounts cannot silently reuse recipient/device bindings', async t => {
  const { bot, store, credentials } = setup(t);
  store.bindBotIdentity('111'); store.saveCredentials(credentials);
  await assert.rejects(bot.restore(), /different Zalo bot/);
  assert.equal(bot.status().ready, false);
});

import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { digest } from './store.js';

const reasons = {
  ip_invalid: 'IP không hợp lệ', gps_invalid: 'Vị trí không đạt', wifi_failed: 'Không kết nối được Wi-Fi',
  login_expired: 'Phiên OBee hết hạn', no_shift: 'Không có ca phù hợp', server_rejected: 'OBee từ chối yêu cầu',
  network_error: 'Lỗi kết nối', unknown_result: 'Chưa xác định kết quả, kiểm tra lịch sử OBee',
  app_unavailable: 'Ứng dụng không chạy đúng giờ',
};
const alertSchema = z.object({
  eventId: z.uuid(), kind: z.enum(['failed', 'missed']), punch: z.enum(['in', 'out']),
  scheduledAt: z.iso.datetime({ offset: true }), reason: z.enum(Object.keys(reasons)),
}).strict();
const eventSchema = z.object({ eventId: z.uuid() }).strict();
const nameSchema = z.object({ name: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} ._()\-]+$/u) }).strict();
const timeFormat = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short',
});

export function createApp({ store, bot, adminToken, publicUrl, production = false, now = Date.now, sendTimeoutMs = 15000 }) {
  const app = express();
  // Render's ingress is one trusted proxy hop. Do not trust arbitrary X-Forwarded-For chains.
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'"], baseUri: ["'none'"], formAction: ["'none'"], frameAncestors: ["'none'"],
    upgradeInsecureRequests: production ? [] : null,
  } } }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/', (_req, res) => res.redirect('/admin'));
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/admin', (_req, res) => res.sendFile('admin.html', { root: publicDir }));
  app.get('/admin.js', (_req, res) => res.sendFile('admin.js', { root: publicDir }));
  app.get('/admin.css', (_req, res) => res.sendFile('admin.css', { root: publicDir }));

  app.use(['/api', '/admin-api'], (req, res, next) => {
    const origin = req.get('origin');
    if ((origin && origin !== publicUrl) || req.get('sec-fetch-site') === 'cross-site')
      return res.status(403).json({ error: 'origin_forbidden' });
    next();
  });
  app.use(['/api', '/admin-api'], rateLimit({ windowMs: 60000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false }));
  const bearer = req => {
    const match = /^Bearer ([A-Za-z0-9_+/=-]{32,200})$/.exec(req.get('authorization') || '');
    return match ? match[1] : null;
  };
  const admin = express.Router();
  app.use('/admin-api', admin);
  admin.use((req, res, next) => {
    const token = bearer(req);
    if (!token || !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(adminToken))))
      return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  admin.use(express.json({ limit: '4kb', type: 'application/json' }));
  admin.get('/status', (_req, res) => res.json({ bot: bot.status(), devices: store.listDevices() }));
  admin.get('/qr', (_req, res) => {
    const image = bot.qrImage();
    if (!image) return res.status(404).json({ error: 'qr_unavailable' });
    res.type('png').send(image);
  });
  admin.post('/bot/qr', (_req, res) => {
    if (!bot.startQR()) return res.status(409).json({ error: 'bot_busy_or_already_logged_in' });
    res.status(202).json({ ok: true });
  });
  admin.post('/bot/reconnect', async (_req, res) => {
    const restored = await bot.restore();
    res.status(restored ? 200 : 409).json({ ok: restored });
  });
  admin.post('/bot/logout', (_req, res) => {
    if (!bot.logout()) return res.status(409).json({ error: 'login_in_progress' });
    res.json({ ok: true });
  });
  admin.post('/devices', (req, res) => {
    const input = nameSchema.parse(req.body);
    res.status(201).json(store.createInvite(input.name, now()));
  });
  admin.delete('/devices/:id', (req, res) => {
    const id = z.uuid().parse(req.params.id);
    res.status(store.revoke(id) ? 200 : 404).json({ ok: true });
  });

  // Single in-flight send, bounded wait, and a persistent claim BEFORE touching Zalo.
  // A timed-out request stays locked until the underlying operation settles.
  let sending = false;
  async function deliver(device, eventId, payload, text, res) {
    if (device.recipient_id === null) return res.status(409).json({ error: 'device_not_paired' });
    const payloadHash = digest(JSON.stringify(payload));
    const previous = store.delivery(device.id, eventId);
    if (previous) {
      if (previous.payload_hash !== payloadHash) return res.status(409).json({ error: 'event_payload_conflict' });
      return res.status(previous.status === 'sent' ? 200 : 409).json({ status: previous.status, duplicate: true });
    }
    if (!bot.status().ready) return res.status(503).json({ error: 'bot_not_connected' });
    if (sending) return res.status(503).json({ error: 'send_busy' });
    const timestamp = now();
    if (store.recentCount(device.id, timestamp - 60000) >= 3 || store.recentCount(device.id, timestamp - 86400000) >= 20
      || store.totalCount(timestamp - 3600000) >= 60)
      return res.status(429).json({ error: 'delivery_rate_limited' });
    store.claim(device.id, eventId, payloadHash, timestamp);
    sending = true;
    let timer;
    const operation = Promise.resolve().then(() => bot.send(device.recipient_id, text));
    operation.then(() => { sending = false; }, () => { sending = false; });
    try {
      await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Send timed out.')), sendTimeoutMs);
      })]);
      store.finish(device.id, eventId, 'sent');
      res.json({ status: 'sent', duplicate: false });
    } catch {
      store.finish(device.id, eventId, 'unknown');
      res.status(502).json({ status: 'unknown', error: 'send_result_unknown_do_not_retry_with_new_id' });
    } finally { clearTimeout(timer); }
  }

  admin.post('/devices/:id/test', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { eventId } = eventSchema.parse(req.body);
    const device = store.getDevice(id);
    if (!device) return res.status(404).json({ error: 'device_not_found' });
    await deliver(device, eventId, { kind: 'test' }, 'OBee — Tin nhắn thử. Bot đã sẵn sàng gửi cảnh báo chấm công.', res);
  });

  const api = express.Router();
  app.use('/api/v1', api);
  api.use((req, res, next) => {
    const token = bearer(req);
    const device = token ? store.authenticate(token) : null;
    if (!device) return res.status(401).json({ error: 'unauthorized' });
    req.device = device;
    next();
  });
  api.use(express.json({ limit: '4kb', type: 'application/json' }));
  api.get('/status', (req, res) => res.json({ linked: req.device.recipient_id !== null, bot: bot.status() }));
  api.post('/alerts', async (req, res) => {
    const payload = alertSchema.parse(req.body);
    // Do not accept arbitrary chat text, recipients, or OBee cookies/passwords.
    if (Math.abs(now() - Date.parse(payload.scheduledAt)) > 7 * 86400000)
      return res.status(400).json({ error: 'scheduled_at_out_of_range' });
    const time = timeFormat.format(new Date(payload.scheduledAt));
    const text = `OBee ${time} — ${payload.kind === 'missed' ? 'Bỏ lỡ' : 'Không chấm được'} lượt ${payload.punch === 'in' ? 'vào' : 'ra'}: ${reasons[payload.reason]}. Vui lòng kiểm tra OBee và chấm thủ công nếu cần.`;
    await deliver(req.device, payload.eventId, payload, text, res);
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError || error.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_request' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'body_too_large' });
    // Never log request bodies, auth headers, QR data, cookie jars, or library error details.
    console.error('Notifier request failed. Inspect service/storage health; secrets omitted.');
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

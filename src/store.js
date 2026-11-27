import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const digest = value => createHash('sha256').update(value).digest('hex');
const cookieSchema = z.object({ key: z.string().min(1), value: z.string(), domain: z.string().min(1) }).passthrough();
const credentialsSchema = z.object({
  imei: z.string().min(1), userAgent: z.string().min(1), cookie: z.array(cookieSchema).min(1),
}).strict();

export class Store {
  constructor(path, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('SESSION_KEY must decode to 32 bytes.');
    this.key = key;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    `);
    if (this.db.prepare('SELECT version FROM schema_version').get().version !== 1) throw new Error('Unsupported database schema.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY CHECK (id = 1), encrypted TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_identity (id INTEGER PRIMARY KEY CHECK (id = 1), uid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        code_hash TEXT UNIQUE, code_expires INTEGER, recipient_id TEXT, revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS devices_recipient ON devices(recipient_id) WHERE revoked = 0;
      CREATE TABLE IF NOT EXISTS deliveries (
        device_id TEXT NOT NULL REFERENCES devices(id), event_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sending', 'sent', 'unknown')), created_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, event_id)
      );
    `);
    // A process stopped during send cannot safely decide whether Zalo already accepted it.
    this.db.prepare("UPDATE deliveries SET status = 'unknown' WHERE status = 'sending'").run();
  }

  saveCredentials(value) {
    const credentials = credentialsSchema.parse(value);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('attendance-zalo-session-v1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    this.db.prepare('INSERT INTO credentials(id, encrypted) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted').run(encrypted);
  }

  loadCredentials() {
    const row = this.db.prepare('SELECT encrypted FROM credentials WHERE id=1').get();
    if (!row) return null;
    const bytes = Buffer.from(row.encrypted, 'base64');
    if (bytes.length < 29) throw new Error('Invalid encrypted Zalo session.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from('attendance-zalo-session-v1'));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    return credentialsSchema.parse(JSON.parse(plain));
  }

  clearCredentials() { this.db.prepare('DELETE FROM credentials').run(); }

  bindBotIdentity(uid) {
    const value = z.string().regex(/^\d{1,30}$/).parse(uid);
    const row = this.db.prepare('SELECT uid FROM bot_identity WHERE id=1').get();
    if (row && row.uid !== value) throw new Error('This database belongs to a different Zalo bot account.');
    if (!row) this.db.prepare('INSERT INTO bot_identity(id,uid) VALUES(1,?)').run(value);
  }

  createInvite(name, now) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const code = randomBytes(12).toString('hex').toUpperCase();
    const expiresAt = now + 10 * 60 * 1000;
    this.db.prepare('INSERT INTO devices(id,name,token_hash,code_hash,code_expires,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, name, digest(token), digest(code), expiresAt, now);
    return { id, name, token, code, expiresAt };
  }

  bind(code, recipientId, now) {
    // No await between lookup and update: one Node process owns this disk/database.
    const row = this.db.prepare('SELECT id FROM devices WHERE code_hash=? AND code_expires>? AND revoked=0 AND recipient_id IS NULL')
      .get(digest(code), now);
    if (!row || this.db.prepare('SELECT id FROM devices WHERE recipient_id=? AND revoked=0').get(recipientId)) return false;
    this.db.prepare('UPDATE devices SET recipient_id=?, code_hash=NULL, code_expires=NULL WHERE id=?').run(recipientId, row.id);
    return true;
  }

  authenticate(token) { return this.db.prepare('SELECT id,name,recipient_id FROM devices WHERE token_hash=? AND revoked=0').get(digest(token)); }
  getDevice(id) { return this.db.prepare('SELECT id,name,recipient_id FROM devices WHERE id=? AND revoked=0').get(id); }
  listDevices() {
    return this.db.prepare(`SELECT id,name,recipient_id IS NOT NULL AS linked,revoked,code_expires,created_at FROM devices ORDER BY created_at DESC`).all();
  }
  revoke(id) {
    return this.db.prepare('UPDATE devices SET revoked=1, code_hash=NULL, code_expires=NULL WHERE id=? AND revoked=0').run(id).changes === 1;
  }
  delivery(deviceId, eventId) { return this.db.prepare('SELECT status,payload_hash FROM deliveries WHERE device_id=? AND event_id=?').get(deviceId, eventId); }
  recentCount(deviceId, since) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE device_id=? AND created_at>=?').get(deviceId, since).n;
  }
  totalCount(since) { return this.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE created_at>=?').get(since).n; }
  claim(deviceId, eventId, payloadHash, now) {
    this.db.prepare("INSERT INTO deliveries(device_id,event_id,payload_hash,status,created_at) VALUES(?,?,?,'sending',?)")
      .run(deviceId, eventId, payloadHash, now);
  }
  finish(deviceId, eventId, status) {
    this.db.prepare('UPDATE deliveries SET status=? WHERE device_id=? AND event_id=?').run(status, deviceId, eventId);
  }
  close() { this.db.close(); }
}

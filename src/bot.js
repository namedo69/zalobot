import { LoginQRCallbackEventType, ThreadType, Zalo } from 'zca-js';

export class Bot {
  constructor(store, { createClient = () => new Zalo({ logging: false, checkUpdate: false, selfListen: false }), now = Date.now } = {}) {
    this.store = store;
    this.createClient = createClient;
    this.now = now;
    this.api = null;
    this.pending = null;
    this.qr = null;
    this.abortQR = null;
    this.stopped = false;
    this.state = 'logged_out';
  }

  status() { return { state: this.state, ready: this.state === 'connected' }; }
  qrImage() { return this.qr; }

  async restore() {
    if (this.pending || this.stopped) return false;
    // Decryption/schema errors are integrity failures, not an expired login.
    const credentials = this.store.loadCredentials();
    if (!credentials) return false;
    this.detach();
    this.state = 'restoring';
    this.pending = this.createClient().login(credentials);
    let api;
    try {
      api = await this.pending;
    } catch {
      this.state = 'login_failed';
      return false;
    } finally { this.pending = null; }
    if (this.stopped) return false;
    try { this.attach(api, credentials); }
    catch (error) { this.detach(); this.state = 'storage_or_identity_error'; throw error; }
    return true;
  }

  startQR() {
    if (this.pending || this.api || this.stopped) return false;
    this.state = 'creating_qr';
    // The library invokes callbacks synchronously and does not await them.
    let credentials = null;
    this.pending = Promise.resolve().then(() => this.createClient().loginQR({}, event => {
      if (this.stopped) {
        if (event.actions) event.actions.abort();
        return;
      }
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        this.qr = Buffer.from(event.data.image, 'base64');
        this.abortQR = event.actions.abort;
        this.state = 'awaiting_scan';
      } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
        this.qr = null;
        this.state = 'awaiting_confirmation';
      } else if ([LoginQRCallbackEventType.QRCodeExpired, LoginQRCallbackEventType.QRCodeDeclined].includes(event.type)) {
        this.state = 'qr_expired_or_declined';
        this.qr = null;
        event.actions.abort();
      } else if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        credentials = event.data;
      }
    })).then(api => {
      if (this.stopped) return;
      if (!credentials) throw new Error('Missing login credentials.');
      try { this.attach(api, credentials); }
      catch { this.detach(); this.state = 'storage_or_identity_error'; }
    }).catch(() => {
      if (!this.stopped && this.state !== 'qr_expired_or_declined') this.state = 'login_failed';
    }).finally(() => {
      this.pending = null;
      this.qr = null;
      this.abortQR = null;
    });
    return true;
  }

  attach(api, credentials) {
    this.store.bindBotIdentity(api.getContext().uid);
    // Persist the post-login jar, not the pre-login QR cookies.
    this.store.saveCredentials({
      imei: credentials.imei, userAgent: credentials.userAgent, cookie: api.getCookie().toJSON().cookies,
    });
    this.api = api;
    this.state = 'connecting';
    api.listener.on('connected', () => { if (this.api === api) this.state = 'connected'; });
    api.listener.on('disconnected', () => { if (this.api === api) this.state = 'disconnected'; });
    api.listener.on('closed', () => { if (this.api === api) this.state = 'disconnected'; });
    api.listener.on('error', () => { if (this.api === api) this.state = 'connection_error'; });
    api.listener.on('message', message => {
      if (this.api !== api || message.isSelf || message.type !== ThreadType.User || typeof message.data.content !== 'string') return;
      const match = /^OBEE ([A-F0-9]{24})$/.exec(message.data.content.trim().toUpperCase());
      if (!match || !/^\d{1,30}$/.test(message.threadId)) return;
      // Only a one-time pairing command is read; private conversations are not stored or answered.
      try { this.store.bind(match[1], message.threadId, this.now()); }
      catch { this.state = 'storage_error'; }
    });
    // Explicit reconnect from admin rather than unbounded library retries/timers.
    api.listener.start({ retryOnClose: false });
  }

  async send(recipientId, text) {
    if (!this.status().ready || !this.api) throw new Error('Bot is not connected.');
    await this.api.sendMessage({ msg: text }, recipientId, ThreadType.User);
  }

  detach() {
    const api = this.api;
    this.api = null;
    if (api) api.listener.stop();
  }

  logout() {
    if (this.pending) return false;
    this.detach();
    this.qr = null;
    this.store.clearCredentials();
    this.state = 'logged_out';
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.abortQR) this.abortQR();
    this.detach();
    this.qr = null;
    this.state = 'stopped';
  }
}

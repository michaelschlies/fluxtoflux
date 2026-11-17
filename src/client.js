import { EventEmitter } from 'node:events';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Closes after which retrying with the same token, shard or version cannot succeed.
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012]);

/** REST + Gateway client for one Fluxer instance, bot-token authenticated. */
export class FluxerClient extends EventEmitter {
  constructor(key, { origin, token, label }, log) {
    super();
    this.key = key;
    this.origin = origin;
    this.token = token;
    this.label = label;
    this.log = (...a) => log(`[${key}]`, ...a);
    this.user = null;
    this.endpoints = null;
    this.sessionId = null;
    this.seq = null;
    this.ws = null;
    this.stopped = false;
    this.reconnects = 0;
    this.globalBlockedUntil = 0;
    // Timing knobs, overridable so tests don't wait on production backoffs.
    this.retryBaseMs = 500;
    this.reconnectBaseMs = 1000;
    this.invalidSessionDelay = () => 1000 + Math.random() * 4000;
  }

  async discover() {
    const res = await fetch(`${this.origin}/.well-known/fluxer`);
    if (!res.ok) throw new Error(`discovery failed for ${this.origin}: HTTP ${res.status}`);
    const doc = await res.json();
    this.endpoints = doc.endpoints;
    this.apiBase = `${(doc.endpoints.api_public ?? doc.endpoints.api).replace(/\/+$/, '')}/v1`;
    return doc;
  }

  /** REST call with 429 retry. Webhook-token routes pass auth:false. */
  async rest(method, path, { json, form, query, auth = true } = {}) {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const wait = this.globalBlockedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const headers = {};
      if (auth) headers.Authorization = `Bot ${this.token}`;
      let body;
      if (form) body = form;
      else if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      }
      const res = await fetch(url, { method, headers, body });
      if (res.status === 429 && attempt < 6) {
        const info = await res.json().catch(() => ({}));
        const secs = info.retry_after ?? (Number(res.headers.get('retry-after')) || 1);
        const ms = Math.ceil(secs * 1000) + 50;
        if (info.global) this.globalBlockedUntil = Date.now() + ms;
        this.log(`rate limited on ${method} ${path}, waiting ${ms}ms`);
        await sleep(ms);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(this.retryBaseMs * 2 ** attempt);
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error(`${method} ${path} -> ${res.status} ${data?.code ?? ''} ${data?.message ?? ''}`.trim());
        err.status = res.status;
        err.code = data?.code;
        throw err;
      }
      return data;
    }
  }

  /** Learn the bot's own user before the Gateway is up, so history can be screened for our echoes. */
  async ensureUser() {
    this.user ??= await this.rest('GET', '/users/@me');
    return this.user;
  }

  // ---- Gateway ---------------------------------------------------------------

  async connect() {
    this.stopped = false;
    if (!this.endpoints) await this.discover();
    this.#open();
  }

  stop() {
    this.stopped = true;
    this.#stopHeartbeat();
    this.ws?.close(4000);
  }

  #open() {
    const url = new URL(this.endpoints.gateway);
    url.searchParams.set('v', '1');
    url.searchParams.set('encoding', 'json');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (ev) => this.#onPayload(JSON.parse(ev.data));
    ws.onerror = () => this.log('gateway socket error');
    ws.onclose = (ev) => this.#onClose(ev.code, ev.reason);
  }

  #send(op, d) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  #onPayload({ op, d, s, t }) {
    if (s != null) this.seq = s;
    switch (op) {
      case 10: // Hello
        this.#startHeartbeat(d.heartbeat_interval);
        if (this.sessionId) this.#send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else this.#identify();
        break;
      case 11: // Heartbeat ACK
        this.acked = true;
        break;
      case 1: // server-requested heartbeat
        this.#send(1, this.seq);
        break;
      case 7: // Reconnect: close with a non-1000 code so the session stays resumable
        this.ws.close(4000, 'reconnect requested');
        break;
      case 9: // Invalid Session (never resumable): identify fresh on the same socket
        this.sessionId = null;
        this.seq = null;
        setTimeout(() => this.#identify(), this.invalidSessionDelay());
        break;
      case 0:
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.user = d.user;
          this.reconnects = 0;
          this.log(`ready as ${d.user.username} (${d.user.id}), ${d.guilds?.length ?? 0} guild(s)`);
        } else if (t === 'RESUMED') {
          this.reconnects = 0;
          this.log('session resumed');
        }
        this.emit(t, d);
        break;
    }
  }

  #identify() {
    this.#send(2, {
      token: this.token,
      properties: { os: process.platform, browser: 'fluxtoflux', device: 'fluxtoflux' },
    });
  }

  #stopHeartbeat() {
    clearTimeout(this.hbStart);
    clearInterval(this.hbTimer);
  }

  #startHeartbeat(interval) {
    this.#stopHeartbeat();
    this.acked = true;
    this.hbStart = setTimeout(() => {
      this.#send(1, this.seq);
      this.acked = false;
      this.hbTimer = setInterval(() => {
        if (!this.acked) {
          this.log('heartbeat not acknowledged, reconnecting');
          this.ws.close(4000, 'missed heartbeat ack');
          return;
        }
        this.acked = false;
        this.#send(1, this.seq);
      }, interval);
    }, interval * Math.random());
  }

  async #onClose(code, reason) {
    this.#stopHeartbeat();
    if (this.stopped) return;
    this.log(`gateway closed ${code} ${reason ?? ''}`);
    if (FATAL_CLOSE.has(code)) {
      this.emit('fatal', new Error(`gateway close ${code}: ${reason}`));
      return;
    }
    this.reconnects++;
    const backoff = Math.min(30_000, this.reconnectBaseMs * 2 ** Math.min(this.reconnects, 5));
    await sleep(backoff * (0.5 + Math.random() / 2));
    if (!this.stopped) this.#open();
  }
}

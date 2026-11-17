import { createHash } from 'node:crypto';

const HOOK_NAME = 'Fluxer Bridge';
const MAX_CONTENT = 4000; // bots and webhooks always get at least this
const BRIDGED_TYPES = new Set([0, 19]); // DEFAULT, REPLY

const sha = (s) => createHash('sha1').update(s).digest('hex');
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Bridge {
  /** @param clients Map<instanceKey, FluxerClient> */
  constructor(cfg, clients, store, log) {
    this.cfg = cfg;
    this.clients = clients;
    this.store = store;
    this.log = log;
    this.byChannel = new Map(); // "inst:channel" -> link
    this.hooks = new Map(); // "inst:channel" -> { id, token }
    this.ownHooks = new Set(); // "inst:webhookId", used to drop our own echoes
    this.queues = new Map(); // per-destination-channel promise chain keeps order
    this.pending = new Set(); // in-flight event handlers, so tests can await idle()
    for (const link of cfg.links) {
      for (const [inst, chan] of Object.entries(link.channels)) this.byChannel.set(`${inst}:${chan}`, link);
    }
  }

  /** Resolve a webhook for every linked channel: configured URL, existing, or newly created. */
  async setupWebhooks() {
    for (const link of this.cfg.links) {
      for (const [inst, chan] of Object.entries(link.channels)) {
        const key = `${inst}:${chan}`;
        const client = this.clients.get(inst);
        let hook;
        const url = link.webhooks?.[inst];
        if (url) {
          const [id, token] = new URL(url).pathname.split('/').filter(Boolean).slice(-2);
          hook = { id, token };
        } else {
          const existing = await client.rest('GET', `/channels/${chan}/webhooks`);
          hook = existing.find((w) => w.name === HOOK_NAME && w.token);
          hook ??= await client.rest('POST', `/channels/${chan}/webhooks`, { json: { name: HOOK_NAME } });
          this.log(`[${inst}] webhook ready for "${link.name}" (${hook.id})`);
        }
        this.hooks.set(key, { id: hook.id, token: hook.token });
        this.ownHooks.add(`${inst}:${hook.id}`);
      }
    }
  }

  attach() {
    for (const [inst, client] of this.clients) {
      client.on('MESSAGE_CREATE', (m) => this.#safe(() => this.onCreate(inst, m)));
      client.on('MESSAGE_UPDATE', (m) => this.#safe(() => this.onUpdate(inst, m)));
      client.on('MESSAGE_DELETE', (m) => this.#safe(() => this.onDelete(inst, m.id, m.channel_id)));
      client.on('MESSAGE_DELETE_BULK', (m) =>
        this.#safe(async () => {
          for (const id of m.ids) await this.onDelete(inst, id, m.channel_id);
        }),
      );
    }
  }

  #safe(fn) {
    const p = (async () => {
      try {
        await fn();
      } catch (err) {
        this.log('bridge error:', err.message);
      }
    })();
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    return p;
  }

  /** Resolves once every received event has been fully processed and delivered. */
  async idle() {
    while (this.pending.size || this.queues.size) {
      await Promise.allSettled([...this.pending, ...this.queues.values()]);
    }
  }

  #targets(inst, channelId) {
    const link = this.byChannel.get(`${inst}:${channelId}`);
    if (!link) return [];
    if (link.oneWayFrom && link.oneWayFrom !== inst) return [];
    return Object.entries(link.channels).filter(([i]) => i !== inst);
  }

  #enqueue(key, task) {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(task).catch((err) => this.log('queue error:', err.message));
    this.queues.set(key, next);
    next.finally(() => this.queues.get(key) === next && this.queues.delete(key));
    return next;
  }

  #isEcho(inst, m) {
    if (m.webhook_id && this.ownHooks.has(`${inst}:${m.webhook_id}`)) return true;
    return m.author?.id === this.clients.get(inst).user?.id;
  }

  #bridgeable(inst, m) {
    if (!BRIDGED_TYPES.has(m.type ?? 0) || !m.author || this.#isEcho(inst, m)) return false;
    if ((m.author.bot || m.webhook_id) && !this.cfg.options.bridgeBots) return false;
    return true;
  }

  // ---- rendering ---------------------------------------------------------------

  #displayName(m) {
    return m.member?.nick ?? m.author.global_name ?? m.author.username;
  }

  #renderContent(m) {
    let text = m.content ?? '';
    const users = new Map([...(m.mentions ?? []), ...(m.users ?? [])].map((u) => [u.id, u]));
    const channels = new Map((m.mention_channels ?? []).map((c) => [c.id, c]));
    text = text
      .replace(/<@!?(\d+)>/g, (_, id) => `@${users.get(id)?.global_name ?? users.get(id)?.username ?? 'unknown-user'}`)
      .replace(/<@&(\d+)>/g, '@role')
      .replace(/<#(\d+)>/g, (_, id) => `#${channels.get(id)?.name ?? 'channel'}`);
    const ref = m.referenced_message;
    if (ref?.author) {
      const quote = truncate((ref.content ?? '').replace(/\s+/g, ' ').trim() || '(attachment)', 80);
      text = `> ↪ **${ref.member?.nick ?? ref.author.global_name ?? ref.author.username}**: ${quote}\n${text}`;
    }
    return text;
  }

  #identity(inst, m) {
    const label = this.clients.get(inst).label;
    const media = this.clients.get(inst).endpoints.media?.replace(/\/+$/, '');
    const a = m.author;
    return {
      username: truncate(`${this.#displayName(m)} · ${label}`, 80),
      avatar_url: a.avatar && media ? `${media}/avatars/${a.id}/${a.avatar}.png` : undefined,
    };
  }

  /** Download attachments; anything too big or failing becomes a link instead. */
  async #collectFiles(m) {
    const files = [];
    const links = [];
    for (const att of m.attachments ?? []) {
      const tooBig = att.size > this.cfg.options.maxAttachmentBytes;
      if (att.url && !tooBig) {
        try {
          const res = await fetch(att.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          files.push({ meta: att, blob: new Blob([await res.arrayBuffer()], { type: att.content_type }) });
          continue;
        } catch (err) {
          this.log(`attachment ${att.filename} download failed: ${err.message}`);
        }
      }
      if (att.url) links.push(att.url);
    }
    return { files, links };
  }

  // ---- event handlers ----------------------------------------------------------

  async onCreate(inst, m) {
    const targets = this.#targets(inst, m.channel_id);
    if (!targets.length || !this.#bridgeable(inst, m)) return;
    const { files, links } = await this.#collectFiles(m);
    let content = this.#renderContent(m);
    if (links.length) content += `${content ? '\n' : ''}${links.join('\n')}`;
    content = truncate(content, MAX_CONTENT);
    if (!content && !files.length) return; // e.g. sticker-only message
    // Hash the raw source text: it is all an update can be compared against, because
    // fallback links and reply quotes are not reproducible from an update payload.
    const hash = sha(m.content ?? '');

    for (const [dstInst, dstChan] of targets) {
      this.#enqueue(`${dstInst}:${dstChan}`, async () => {
        const hook = this.hooks.get(`${dstInst}:${dstChan}`);
        const dst = this.clients.get(dstInst);
        const body = {
          content,
          ...this.#identity(inst, m),
          allowed_mentions: { parse: [] },
        };
        const path = `/webhooks/${hook.id}/${hook.token}`;
        let sent;
        if (files.length) {
          const form = new FormData();
          body.attachments = files.map((f, i) => ({ id: i, filename: f.meta.filename, description: f.meta.description ?? undefined }));
          form.set('payload_json', JSON.stringify(body));
          files.forEach((f, i) => form.set(`files[${i}]`, f.blob, f.meta.filename));
          sent = await dst.rest('POST', path, { form, query: { wait: true }, auth: false });
        } else {
          sent = await dst.rest('POST', path, { json: body, query: { wait: true }, auth: false });
        }
        this.store.add(inst, m.id, dstInst, dstChan, sent.id, hash);
      });
    }
  }

  async onUpdate(inst, m) {
    if (!m.id || m.content == null || !m.author || !this.#bridgeable(inst, m)) return;
    const hash = sha(m.content);
    const rows = this.store.get(inst, m.id).filter((r) => r.hash !== hash); // equal = embed unfurl etc.
    if (!rows.length) return;
    // Attachments are left alone on edit; only links to files we refused to re-upload are restated.
    const oversize = (m.attachments ?? []).filter((a) => a.url && a.size > this.cfg.options.maxAttachmentBytes);
    let content = this.#renderContent(m);
    if (oversize.length) content += `${content ? '\n' : ''}${oversize.map((a) => a.url).join('\n')}`;
    content = truncate(content, MAX_CONTENT);
    for (const row of rows) {
      this.#enqueue(`${row.dst_inst}:${row.dst_chan}`, async () => {
        const hook = this.hooks.get(`${row.dst_inst}:${row.dst_chan}`);
        await this.clients
          .get(row.dst_inst)
          .rest('PATCH', `/webhooks/${hook.id}/${hook.token}/messages/${row.dst_msg}`, {
            json: { content, allowed_mentions: { parse: [] } },
            auth: false,
          });
        this.store.updateHash(inst, m.id, row.dst_inst, hash);
      });
    }
  }

  async onDelete(inst, messageId) {
    const rows = this.store.get(inst, messageId);
    if (!rows.length) return;
    this.store.delete(inst, messageId);
    for (const row of rows) {
      this.#enqueue(`${row.dst_inst}:${row.dst_chan}`, async () => {
        const hook = this.hooks.get(`${row.dst_inst}:${row.dst_chan}`);
        await this.clients
          .get(row.dst_inst)
          .rest('DELETE', `/webhooks/${hook.id}/${hook.token}/messages/${row.dst_msg}`, { auth: false })
          .catch((err) => err.status === 404 || Promise.reject(err)); // already gone
      });
    }
  }
}

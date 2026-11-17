import { createHash } from 'node:crypto';

const HOOK_NAME = 'Fluxer Bridge';
const MAX_CONTENT = 4000; // bots and webhooks always get at least this
const BRIDGED_TYPES = new Set([0, 19]); // DEFAULT, REPLY
const THREAD_TYPES = new Set([10, 11]); // announcement and public threads; private threads are never mirrored
const MAX_EMBEDS = 10;
const HISTORY_PAGE = 100;

const sha = (s) => createHash('sha1').update(s).digest('hex');
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
const stamp = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

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
    this.threadInfo = new Map(); // "inst:threadId" -> { parent_id, name, type, archived } or null for "not a thread"
    this.pairing = new Map(); // "inst:threadId" -> promise chain that creates its counterparts
    this.flattened = new Map(); // "inst:threadId" -> Set of instances where the thread could not be created
    this.holds = new Map(); // "inst:channel" -> promise that live messages wait on during catch-up
    this.releases = new Map(); // "inst:channel" -> function that resolves the hold
    this.stalled = new Set(); // "inst:channel" whose watermark must stop advancing after a failed delivery
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
      client.on('MESSAGE_REACTION_ADD', (r) => this.#safe(() => this.onReaction(inst, r, true)));
      client.on('MESSAGE_REACTION_REMOVE', (r) => this.#safe(() => this.onReaction(inst, r, false)));
      client.on('THREAD_CREATE', (t) => this.#safe(() => this.onThreadCreate(inst, t)));
      client.on('THREAD_UPDATE', (t) => this.#safe(() => this.onThreadUpdate(inst, t)));
      client.on('THREAD_DELETE', (t) => this.#safe(() => this.onThreadDelete(inst, t)));
      client.on('THREAD_LIST_SYNC', (d) => d.threads?.forEach((t) => this.#cacheThread(inst, t)));
      client.on('GUILD_CREATE', (g) => g.threads?.forEach((t) => this.#cacheThread(inst, t)));
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

  #targets(inst, link) {
    if (!link || (link.oneWayFrom && link.oneWayFrom !== inst)) return [];
    return Object.entries(link.channels).filter(([i]) => i !== inst);
  }

  /** Run task after everything queued for key; resolves true when it succeeded. */
  #enqueue(key, task) {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(task).then(
      () => true,
      (err) => {
        this.log('queue error:', err.message);
        return false;
      },
    );
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

  /** Rich embeds as the webhook accepts them. Link previews are left out: the destination builds its own. */
  #richEmbeds(m) {
    const media = (o) => o?.url && compact({ url: o.url, description: o.description });
    return (m.embeds ?? [])
      .filter((e) => e.type === 'rich')
      .slice(0, MAX_EMBEDS)
      .map((e) =>
        compact({
          url: e.url,
          title: e.title,
          color: e.color,
          timestamp: e.timestamp,
          description: e.description,
          author: e.author?.name && compact({ name: e.author.name, url: e.author.url, icon_url: e.author.icon_url }),
          image: media(e.image),
          thumbnail: media(e.thumbnail),
          footer: e.footer?.text && compact({ text: e.footer.text, icon_url: e.footer.icon_url }),
          fields: e.fields?.length && e.fields.map((f) => compact({ name: f.name, value: f.value, inline: f.inline })),
        }),
      );
  }

  /** Hash of everything an edit can change: the raw text and the rich embeds. */
  #hash(m, embeds) {
    return sha((m.content ?? '') + (embeds.length ? `\0${JSON.stringify(embeds)}` : ''));
  }

  /** Download attachments and stickers; anything too big or failing becomes a link or `[sticker: name]` instead. */
  async #collectFiles(inst, m) {
    const files = [];
    const links = [];
    const max = this.cfg.options.maxAttachmentBytes;
    for (const att of m.attachments ?? []) {
      const tooBig = att.size > max;
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
    const media = this.clients.get(inst).endpoints.media?.replace(/\/+$/, '');
    for (const st of m.stickers ?? []) {
      // Sticker IDs mean nothing on another instance, so the image itself is re-uploaded.
      try {
        if (!media) throw new Error('no media endpoint');
        const ext = st.animated ? 'gif' : 'webp';
        const res = await fetch(`${media}/stickers/${st.id}.${ext}${st.animated ? '?animated=true' : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > max) throw new Error('too large');
        const type = `image/${ext}`;
        files.push({ meta: { filename: `${st.name}.${ext}`, content_type: type }, blob: new Blob([bytes], { type }) });
      } catch (err) {
        this.log(`sticker ${st.name} download failed: ${err.message}`);
        links.push(`[sticker: ${st.name}]`);
      }
    }
    return { files, links };
  }

  // ---- threads -----------------------------------------------------------------

  #cacheThread(inst, t) {
    this.threadInfo.set(`${inst}:${t.id}`, {
      parent_id: t.parent_id,
      name: t.name,
      type: t.type,
      archived: !!t.thread_metadata?.archived,
    });
  }

  /** Thread details for a channel ID, or null when it is not a thread. Asks the API once per unknown channel. */
  async #threadOf(inst, channelId) {
    const key = `${inst}:${channelId}`;
    if (!this.threadInfo.has(key)) {
      try {
        const ch = await this.clients.get(inst).rest('GET', `/channels/${channelId}`);
        if (ch?.parent_id) this.#cacheThread(inst, ch);
        else this.threadInfo.set(key, null);
      } catch {
        return null; // not cached, so a later message can try again
      }
    }
    return this.threadInfo.get(key);
  }

  /** Which link and linked channel a message belongs to: the channel itself, or the parent of its thread. */
  async #route(inst, channelId) {
    const direct = this.byChannel.get(`${inst}:${channelId}`);
    if (direct) return { link: direct, chan: channelId, thread: null };
    if (this.cfg.options.bridgeThreads === false) return null;
    const info = await this.#threadOf(inst, channelId);
    if (!info || !THREAD_TYPES.has(info.type)) return null;
    const link = this.byChannel.get(`${inst}:${info.parent_id}`);
    return link ? { link, chan: info.parent_id, thread: channelId, info } : null;
  }

  /** Where a routed message goes: one entry per other channel in the link, with the paired thread if it has one. */
  async #destinations(inst, route) {
    const targets = this.#targets(inst, route.link);
    if (!route.thread) return targets.map(([dstInst, dstChan]) => ({ dstInst, dstChan, dstThread: null }));
    await this.#ensurePaired(inst, route);
    const group = new Map(this.store.threadGroup(inst, route.thread).map((r) => [r.inst, r]));
    return targets.map(([dstInst, dstChan]) => ({
      dstInst,
      dstChan,
      dstThread: group.get(dstInst)?.thread ?? null,
      flatName: group.has(dstInst) ? null : route.info.name,
    }));
  }

  /** Create the missing counterparts of a thread, one creation at a time per thread. */
  #ensurePaired(inst, route) {
    const key = `${inst}:${route.thread}`;
    const next = (this.pairing.get(key) ?? Promise.resolve())
      .then(() => this.#createCounterparts(inst, route))
      .catch((err) => this.log('thread pairing error:', err.message));
    this.pairing.set(key, next);
    next.finally(() => this.pairing.get(key) === next && this.pairing.delete(key));
    return next;
  }

  async #createCounterparts(inst, route) {
    const key = `${inst}:${route.thread}`;
    const rows = this.store.threadGroup(inst, route.thread);
    const have = new Set(rows.map((r) => r.inst));
    const grp = rows[0]?.grp ?? key;
    for (const [dstInst, dstChan] of this.#targets(inst, route.link)) {
      if (have.has(dstInst) || this.flattened.get(key)?.has(dstInst)) continue;
      try {
        const dstThread = await this.#createThread(inst, route, dstInst, dstChan);
        if (!have.has(inst)) {
          this.store.addThread(grp, inst, route.thread, route.chan);
          have.add(inst);
        }
        this.store.addThread(grp, dstInst, dstThread, dstChan);
        have.add(dstInst);
        this.threadInfo.set(`${dstInst}:${dstThread}`, { ...route.info, parent_id: dstChan });
      } catch (err) {
        if (!this.flattened.has(key)) this.flattened.set(key, new Set());
        this.flattened.get(key).add(dstInst);
        this.log(
          `[${dstInst}] cannot create thread "${route.info.name}": ${err.message}; its messages go to the parent channel`,
        );
      }
    }
  }

  async #createThread(inst, route, dstInst, dstChan) {
    const dst = this.clients.get(dstInst);
    const name = route.info.name ?? 'thread';
    // A thread started from a message has that message's ID, so attach to the copy of the message.
    const starter = this.store.get(inst, route.thread).find((r) => r.dst_inst === dstInst);
    const created = starter
      ? await dst.rest('POST', `/channels/${starter.dst_chan}/messages/${starter.dst_msg}/threads`, { json: { name } })
      : await dst.rest('POST', `/channels/${dstChan}/threads`, { json: { name, type: route.info.type } });
    return created.id;
  }

  async onThreadCreate(inst, t) {
    this.#cacheThread(inst, t);
    if (this.cfg.options.bridgeThreads === false || !t.newly_created || !THREAD_TYPES.has(t.type)) return;
    const link = this.byChannel.get(`${inst}:${t.parent_id}`);
    if (!link) return;
    await Promise.all(this.queues.values()); // let the starter message finish mirroring so the thread can attach to its copy
    await this.#ensurePaired(inst, {
      link,
      chan: t.parent_id,
      thread: t.id,
      info: this.threadInfo.get(`${inst}:${t.id}`),
    });
  }

  async onThreadUpdate(inst, t) {
    const prev = this.threadInfo.get(`${inst}:${t.id}`);
    this.#cacheThread(inst, t);
    if (this.cfg.options.bridgeThreads === false || !THREAD_TYPES.has(t.type)) return;
    const link = this.byChannel.get(`${inst}:${t.parent_id}`);
    if (!link || (link.oneWayFrom && link.oneWayFrom !== inst)) return;
    const archived = !!t.thread_metadata?.archived;
    const patch = {};
    if (t.name !== prev?.name) patch.name = t.name;
    if (archived !== prev?.archived) patch.archived = archived;
    if (!Object.keys(patch).length) return;
    for (const row of this.store.threadGroup(inst, t.id).filter((r) => r.inst !== inst)) {
      // Record the new state first, so the update event our own change causes is not mirrored back.
      const key = `${row.inst}:${row.thread}`;
      this.threadInfo.set(key, { ...this.threadInfo.get(key), name: t.name, archived });
      this.#enqueue(key, () => this.clients.get(row.inst).rest('PATCH', `/channels/${row.thread}`, { json: patch }));
    }
  }

  async onThreadDelete(inst, t) {
    this.threadInfo.delete(`${inst}:${t.id}`);
    this.store.removeThread(inst, t.id);
  }

  // ---- reactions ---------------------------------------------------------------

  /** Every message a reaction on (inst, messageId) should be repeated on: its copies, or its origin and the origin's other copies. */
  #reactionTargets(inst, messageId) {
    const out = [];
    const allowed = (link) => link && (!link.oneWayFrom || link.oneWayFrom === inst);
    const copyOf = (r) => ({ inst: r.dst_inst, channel: r.dst_thread ?? r.dst_chan, message: r.dst_msg });
    for (const r of this.store.get(inst, messageId)) {
      if (allowed(this.byChannel.get(`${r.dst_inst}:${r.dst_chan}`))) out.push(copyOf(r));
    }
    for (const copy of this.store.getByCopy(inst, messageId)) {
      if (!allowed(this.byChannel.get(`${inst}:${copy.dst_chan}`)) || !copy.src_chan) continue;
      out.push({ inst: copy.src_inst, channel: copy.src_chan, message: copy.src_msg });
      for (const r of this.store.get(copy.src_inst, copy.src_msg)) {
        if (r.dst_inst !== inst) out.push(copyOf(r));
      }
    }
    return out;
  }

  async onReaction(inst, r, added) {
    const client = this.clients.get(inst);
    // Custom emoji IDs only mean something on their own instance. Our own reactions are the mirror itself.
    if (this.cfg.options.bridgeReactions === false || r.emoji?.id || !r.emoji?.name || r.user_id === client.user?.id) {
      return;
    }
    const targets = this.#reactionTargets(inst, r.message_id);
    if (!targets.length) return;
    const emoji = encodeURIComponent(r.emoji.name);
    if (!added) {
      // The bot reacts once on behalf of everyone, so it only lets go when nobody on this side still has the emoji.
      const users = await client
        .rest('GET', `/channels/${r.channel_id}/messages/${r.message_id}/reactions/${emoji}`)
        .catch(() => null);
      if (!users || users.some((u) => u.id !== client.user?.id)) return;
    }
    await Promise.all(
      targets.map((t) =>
        this.#enqueue(`${t.inst}:${t.channel}`, async () => {
          try {
            await this.clients
              .get(t.inst)
              .rest(added ? 'PUT' : 'DELETE', `/channels/${t.channel}/messages/${t.message}/reactions/${emoji}/@me`);
          } catch (err) {
            if (err.status === 404) return; // the copy is gone
            this.log(`[${t.inst}] warning: reaction not mirrored: ${err.message}`);
          }
        }),
      ),
    );
  }

  // ---- event handlers ----------------------------------------------------------

  /** Mirror one message. Resolves false when a delivery failed; backfill skips copies that already exist. */
  async onCreate(inst, m, { backfill = false } = {}) {
    if (!backfill) await this.holds.get(`${inst}:${m.channel_id}`);
    if (!this.#bridgeable(inst, m)) return true;
    const route = await this.#route(inst, m.channel_id);
    if (!route) return true;
    let dests = await this.#destinations(inst, route);
    if (backfill) {
      const done = new Set(this.store.get(inst, m.id).map((r) => r.dst_inst));
      dests = dests.filter((d) => !done.has(d.dstInst));
    }
    if (!dests.length) {
      if (backfill && !route.thread) this.#advance(inst, m.channel_id, m.id);
      return true;
    }
    const { files, links } = await this.#collectFiles(inst, m);
    const embeds = this.#richEmbeds(m);
    let content = this.#renderContent(m);
    if (links.length) content += `${content ? '\n' : ''}${links.join('\n')}`;
    if (!content && !files.length && !embeds.length) return true; // nothing to show, e.g. a message of an unsupported kind
    // A webhook cannot set a timestamp, so backfilled messages carry their original time in the text.
    if (backfill && m.timestamp) content = `*${stamp(m.timestamp)}*${content ? `\n${content}` : ''}`;
    // Hash the raw source text: it is all an update can be compared against, because
    // fallback links and reply quotes are not reproducible from an update payload.
    const hash = this.#hash(m, embeds);

    const results = await Promise.all(
      dests.map((d) =>
        this.#enqueue(`${d.dstInst}:${d.dstThread ?? d.dstChan}`, async () => {
          const hook = this.hooks.get(`${d.dstInst}:${d.dstChan}`);
          const dst = this.clients.get(d.dstInst);
          const body = {
            content: truncate(d.flatName ? `[thread: ${d.flatName}] ${content}` : content, MAX_CONTENT),
            ...this.#identity(inst, m),
            allowed_mentions: { parse: [] },
          };
          if (embeds.length) body.embeds = embeds;
          const query = { wait: true };
          if (d.dstThread) query.thread_id = d.dstThread;
          const path = `/webhooks/${hook.id}/${hook.token}`;
          let sent;
          if (files.length) {
            const form = new FormData();
            body.attachments = files.map((f, i) => ({
              id: i,
              filename: f.meta.filename,
              description: f.meta.description ?? undefined,
            }));
            form.set('payload_json', JSON.stringify(body));
            files.forEach((f, i) => form.set(`files[${i}]`, f.blob, f.meta.filename));
            sent = await dst.rest('POST', path, { form, query, auth: false });
          } else {
            sent = await dst.rest('POST', path, { json: body, query, auth: false });
          }
          this.store.add(inst, m.id, d.dstInst, d.dstChan, sent.id, hash, m.channel_id, d.dstThread);
        }),
      ),
    );
    const ok = results.every(Boolean);
    if (!ok) this.stalled.add(`${inst}:${m.channel_id}`);
    else if (!route.thread) this.#advance(inst, m.channel_id, m.id);
    return ok;
  }

  /** Remember the newest delivered message of a channel, unless an earlier one failed. */
  #advance(inst, chan, id) {
    if (this.stalled.has(`${inst}:${chan}`)) return;
    const mark = this.store.watermark(inst, chan);
    if (!mark || BigInt(id) > BigInt(mark)) this.store.setWatermark(inst, chan, id);
  }

  async onUpdate(inst, m) {
    if (!m.id || m.content == null || !m.author || !this.#bridgeable(inst, m)) return;
    const embeds = this.#richEmbeds(m);
    const hash = this.#hash(m, embeds);
    const rows = this.store.get(inst, m.id).filter((r) => r.hash !== hash); // equal = embed unfurl etc.
    if (!rows.length) return;
    // Attachments are left alone on edit; only links to files we refused to re-upload are restated.
    const oversize = (m.attachments ?? []).filter((a) => a.url && a.size > this.cfg.options.maxAttachmentBytes);
    let content = this.#renderContent(m);
    if (oversize.length) content += `${content ? '\n' : ''}${oversize.map((a) => a.url).join('\n')}`;
    const thread = this.byChannel.has(`${inst}:${m.channel_id}`)
      ? null
      : this.threadInfo.get(`${inst}:${m.channel_id}`);
    for (const row of rows) {
      const flat = thread && !row.dst_thread ? `[thread: ${thread.name}] ` : '';
      const body = { content: truncate(flat + content, MAX_CONTENT), allowed_mentions: { parse: [] } };
      if (m.author.bot || m.webhook_id) body.embeds = embeds; // only bots and webhooks can send rich embeds
      this.#enqueue(`${row.dst_inst}:${row.dst_thread ?? row.dst_chan}`, async () => {
        const hook = this.hooks.get(`${row.dst_inst}:${row.dst_chan}`);
        await this.clients
          .get(row.dst_inst)
          .rest('PATCH', `/webhooks/${hook.id}/${hook.token}/messages/${row.dst_msg}`, {
            json: body,
            query: row.dst_thread ? { thread_id: row.dst_thread } : undefined,
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
      this.#enqueue(`${row.dst_inst}:${row.dst_thread ?? row.dst_chan}`, async () => {
        const hook = this.hooks.get(`${row.dst_inst}:${row.dst_chan}`);
        await this.clients
          .get(row.dst_inst)
          .rest('DELETE', `/webhooks/${hook.id}/${hook.token}/messages/${row.dst_msg}`, {
            query: row.dst_thread ? { thread_id: row.dst_thread } : undefined,
            auth: false,
          })
          .catch((err) => err.status === 404 || Promise.reject(err)); // already gone
      });
    }
  }

  // ---- history catch-up and backfill -------------------------------------------

  /** Channels to catch up: origin sides of links that have a watermark or a backfill setting. */
  #catchUpChannels(only) {
    const out = [];
    for (const link of this.cfg.links) {
      if (only && link.name !== only) continue;
      for (const [inst, chan] of Object.entries(link.channels)) {
        if (link.oneWayFrom && link.oneWayFrom !== inst) continue;
        if (link.backfill || this.store.watermark(inst, chan)) out.push({ inst, chan, link });
      }
    }
    return out;
  }

  /** Make live messages wait for catch-up. Call before connecting to the Gateway. */
  holdForCatchUp() {
    for (const { inst, chan } of this.#catchUpChannels()) {
      const key = `${inst}:${chan}`;
      this.holds.set(key, new Promise((resolve) => this.releases.set(key, resolve)));
    }
  }

  #release(key) {
    this.releases.get(key)?.();
    this.releases.delete(key);
    this.holds.delete(key);
  }

  /** Relay history the destinations are missing. Resolves true when every channel was read without error. */
  async catchUp({ link: only } = {}) {
    let ok = true;
    for (const ch of this.#catchUpChannels(only)) {
      try {
        await this.clients.get(ch.inst).ensureUser();
        await this.#catchUpChannel(ch);
      } catch (err) {
        ok = false;
        this.log(`[${ch.inst}] catch-up of "${ch.link.name}" failed: ${err.message}`);
      } finally {
        this.#release(`${ch.inst}:${ch.chan}`);
      }
    }
    for (const key of [...this.releases.keys()]) this.#release(key); // channels that dropped out since holdForCatchUp
    return ok;
  }

  async #catchUpChannel({ inst, chan, link }) {
    const client = this.clients.get(inst);
    const page = (query) =>
      client.rest('GET', `/channels/${chan}/messages`, { query: { limit: HISTORY_PAGE, ...query } });
    const deliver = async (m) => {
      try {
        if (!(await this.onCreate(inst, m, { backfill: true }))) {
          this.log(`[${inst}] message ${m.id} was not delivered`);
        }
      } catch (err) {
        this.stalled.add(`${inst}:${chan}`);
        this.log(`[${inst}] message ${m.id} failed: ${err.message}`);
      }
    };
    const mark = this.store.watermark(inst, chan);
    if (mark) {
      // Forward from the last delivered message.
      let cursor = mark;
      for (;;) {
        const msgs = (await page({ after: cursor })).sort(byId);
        for (const m of msgs) await deliver(m);
        if (msgs.length < HISTORY_PAGE) break;
        cursor = msgs.at(-1).id;
      }
      return;
    }
    // First backfill: walk backwards to the limit or the date, then deliver oldest first.
    const { since, limit } = link.backfill;
    const floor = since ? Date.parse(since) : null;
    const collected = [];
    let before;
    for (let done = false; !done;) {
      const msgs = (await page(before ? { before } : {})).sort((a, b) => -byId(a, b));
      for (const m of msgs) {
        if ((floor !== null && Date.parse(m.timestamp) < floor) || (limit && collected.length >= limit)) {
          done = true;
          break;
        }
        collected.push(m);
      }
      if (msgs.length < HISTORY_PAGE) done = true;
      before = msgs.at(-1)?.id;
    }
    for (const m of collected.sort(byId)) await deliver(m);
  }
}

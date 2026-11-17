// A minimal in-process Fluxer instance: discovery, the REST routes the bridge uses, webhook
// execution with multipart parsing, a file host, and a Gateway WebSocket. Faults are injected
// per route (inject) or per socket (closeSockets, ackHeartbeats, onIdentify, onResume).
import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startMock({ name = 'mock', userId = `bot-${name}` } = {}) {
  const m = {
    name,
    userId,
    origin: '',
    requests: [], // every HTTP request: { method, path, query, headers }
    hooks: [], // { id, channel_id, name, token }
    posts: [], // webhook executions
    patches: [],
    deletes: [],
    channels: new Map(), // id -> channel/thread object served by GET /channels/<id>
    threadCreates: [], // { channel, fromMessage, json, id }
    denyThreadCreate: false,
    channelPatches: [], // PATCH /channels/<id>: { id, json }
    reactionOps: [], // { op: 'PUT' | 'DELETE', channel, message, emoji }
    reactionUsers: {}, // "channel/message/emoji" -> users returned by the reaction list
    history: new Map(), // channel id -> messages served by GET /channels/<id>/messages
    files: new Map(), // name -> Buffer, served at /files/<name>
    unknownChannels: new Set(),
    denyWebhookCreate: false,
    goneHooks: new Set(), // webhook ids that answer 404 UNKNOWN_WEBHOOK
    postDelay: () => 0, // (postIndex) => ms, to simulate slow deliveries
    injections: [],
    sockets: [],
    gatewayUrls: [],
    received: [], // frames sent by the client: { op, d }
    helloInterval: 1000,
    ackHeartbeats: true,
    seq: 0,
    sessions: 0,
    nextId: 1000,
  };

  m.fileUrl = (file) => `${m.origin}/files/${file}`;
  m.addHook = (channel, hookName = 'Fluxer Bridge') => {
    const hook = { id: String(m.nextId++), channel_id: channel, name: hookName, token: `tok${m.nextId}` };
    m.hooks.push(hook);
    return hook;
  };
  /** Make the next `times` requests matching method + path answer with a canned response. */
  m.inject = ({ method, path, status, body = {}, headers = {}, times = 1 }) => {
    m.injections.push({ method, path, status, body, headers, times });
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    m.requests.push({ method: req.method, path, query, headers: req.headers, at: Date.now() });

    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(status === 204 || body === undefined ? undefined : JSON.stringify(body));
    };

    const inj = m.injections.find(
      (i) =>
        i.times > 0 &&
        i.method === req.method &&
        (i.path instanceof RegExp ? i.path.test(path) : path.includes(i.path)),
    );
    if (inj) {
      inj.times--;
      return reply(inj.status, inj.body, inj.headers);
    }

    if (path === '/.well-known/fluxer') {
      return reply(200, {
        endpoints: {
          api_public: m.origin,
          api: m.origin,
          gateway: `ws://${m.origin.slice(7)}/gw`,
          media: `${m.origin}/media`,
        },
      });
    }
    if (path.startsWith('/files/')) {
      const file = m.files.get(decodeURIComponent(path.slice(7)));
      if (!file) return reply(404, { code: 'NOT_FOUND' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(file);
    }

    if (path.startsWith('/media/stickers/')) {
      const file = m.files.get(`sticker-${path.slice(16).replace(/\.\w+$/, '')}`);
      if (!file) return reply(404, { code: 'NOT_FOUND' });
      res.writeHead(200, { 'content-type': 'image/webp' });
      return res.end(file);
    }
    if (path === '/v1/users/@me') return reply(200, { id: m.userId, username: 'bridge', bot: true });

    let match = path.match(/^\/v1\/channels\/(\w+)\/messages$/);
    if (match && req.method === 'GET') {
      const { before, after, limit = '50' } = query;
      let msgs = [...(m.history.get(match[1]) ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
      if (before) msgs = msgs.filter((x) => BigInt(x.id) < BigInt(before));
      if (after) msgs = msgs.filter((x) => BigInt(x.id) > BigInt(after));
      // Like the real API, `after` pages start at the oldest message past the cursor.
      if (after) msgs = msgs.reverse();
      return reply(200, msgs.slice(0, Number(limit)));
    }

    match = path.match(/^\/v1\/channels\/(\w+)\/(?:messages\/(\w+)\/)?threads$/);
    if (match && req.method === 'POST') {
      if (m.denyThreadCreate) return reply(403, { code: 'MISSING_PERMISSIONS' });
      const json = JSON.parse(raw.toString());
      const thread = { id: String(m.nextId++), parent_id: match[1], name: json.name, type: json.type ?? 11 };
      m.channels.set(thread.id, thread);
      m.threadCreates.push({ channel: match[1], fromMessage: match[2], json, id: thread.id });
      return reply(201, thread);
    }

    match = path.match(/^\/v1\/channels\/(\w+)\/messages\/(\w+)\/reactions\/([^/]+)(?:\/@me)?$/);
    if (match) {
      const [, channel, message, enc] = match;
      const emoji = decodeURIComponent(enc);
      if (req.method === 'GET') return reply(200, m.reactionUsers[`${channel}/${message}/${emoji}`] ?? []);
      m.reactionOps.push({ op: req.method, channel, message, emoji });
      return reply(204);
    }

    match = path.match(/^\/v1\/channels\/(\w+)$/);
    if (match && req.method === 'GET') {
      if (m.unknownChannels.has(match[1])) return reply(404, { code: 'UNKNOWN_CHANNEL' });
      return reply(200, m.channels.get(match[1]) ?? { id: match[1], name: `chan-${match[1]}` });
    }
    if (match && req.method === 'PATCH') {
      m.channelPatches.push({ id: match[1], json: JSON.parse(raw.toString()) });
      return reply(200, { id: match[1] });
    }

    match = path.match(/^\/v1\/channels\/(\w+)\/webhooks$/);
    if (match && req.method === 'GET') {
      return reply(
        200,
        m.hooks.filter((h) => h.channel_id === match[1]),
      );
    }
    if (match && req.method === 'POST') {
      if (m.denyWebhookCreate) return reply(403, { code: 'MISSING_PERMISSIONS' });
      const hook = m.addHook(match[1], JSON.parse(raw.toString()).name);
      m.hooks[m.hooks.length - 1].created = true;
      return reply(200, hook);
    }

    match = path.match(/^\/v1\/webhooks\/(\w+)\/(\w+)(?:\/messages\/(\w+))?$/);
    if (match) {
      const [, hookId, token, messageId] = match;
      if (m.goneHooks.has(hookId)) return reply(404, { code: 'UNKNOWN_WEBHOOK' });
      if (req.method === 'POST') {
        const post = { hookId, token, query, auth: req.headers.authorization, id: String(m.nextId++), at: Date.now() };
        const ct = req.headers['content-type'] ?? '';
        if (ct.startsWith('multipart/')) {
          const form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
          post.multipart = true;
          post.json = JSON.parse(form.get('payload_json'));
          post.files = [];
          for (const [key, value] of form.entries()) {
            if (typeof value !== 'string') {
              post.files.push({ field: key, filename: value.name, bytes: Buffer.from(await value.arrayBuffer()) });
            }
          }
        } else {
          post.json = JSON.parse(raw.toString());
        }
        const index = m.posts.length;
        m.posts.push(post);
        const delay = m.postDelay(index);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return query.wait === 'true' ? reply(200, { id: post.id }) : reply(204);
      }
      if (req.method === 'PATCH') {
        m.patches.push({ hookId, messageId, query, json: JSON.parse(raw.toString()), auth: req.headers.authorization });
        return reply(200, { id: messageId });
      }
      if (req.method === 'DELETE') {
        m.deletes.push({ hookId, messageId, ...(Object.keys(query).length && { query }) });
        return reply(204);
      }
    }
    reply(404, { code: 'NOT_FOUND' });
  });

  // ---- Gateway ---------------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/gw' });
  m.send = (ws, op, d, t) => ws.readyState === 1 && ws.send(JSON.stringify({ op, d, ...(t ? { t, s: ++m.seq } : {}) }));
  m.dispatch = (t, d) => m.sockets.forEach((ws) => m.send(ws, 0, d, t));
  // 1006 means "closed abnormally": it can't be sent in a close frame, so drop the TCP socket instead.
  m.closeSockets = (code = 1006, reason = '') =>
    m.sockets.forEach((ws) => (code === 1006 ? ws.terminate() : ws.close(code, reason)));
  m.onIdentify = (ws) =>
    m.send(
      ws,
      0,
      { session_id: `sess-${++m.sessions}`, user: { id: m.userId, username: 'bridge' }, guilds: [] },
      'READY',
    );
  m.onResume = (ws) => m.send(ws, 0, {}, 'RESUMED');

  wss.on('connection', (ws, req) => {
    m.sockets.push(ws);
    m.gatewayUrls.push(req.url);
    m.send(ws, 10, { heartbeat_interval: m.helloInterval });
    ws.on('message', (data) => {
      const frame = JSON.parse(data);
      m.received.push(frame);
      if (frame.op === 1 && m.ackHeartbeats) m.send(ws, 11);
      if (frame.op === 2) m.onIdentify(ws, frame.d);
      if (frame.op === 6) m.onResume(ws, frame.d);
    });
    ws.on('close', () => {
      m.sockets = m.sockets.filter((s) => s !== ws);
    });
  });

  m.ops = (op) => m.received.filter((f) => f.op === op);
  m.close = () =>
    new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  m.origin = `http://127.0.0.1:${server.address().port}`;
  return m;
}

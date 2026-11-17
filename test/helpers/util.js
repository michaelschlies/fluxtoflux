import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FluxerClient } from '../../src/client.js';
import { Bridge } from '../../src/bridge.js';
import { Store } from '../../src/store.js';
import { startMock } from './mock-instance.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(predicate, { timeout = 3000, interval = 10, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

export function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fluxtoflux-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

let nextMessageId = 1;
/** A MESSAGE_CREATE payload as Fluxer would send it. */
export function message(overrides = {}) {
  return {
    id: String(nextMessageId++),
    channel_id: '10',
    type: 0,
    content: 'hello',
    author: { id: '5', username: 'alice' },
    mentions: [],
    attachments: [],
    ...overrides,
  };
}

/**
 * Two (or more) mock instances, real clients, a real store and a real Bridge, wired without
 * Gateway sockets: tests feed events with emit() and await bridge.idle().
 */
export async function createHarness({ keys = ['a', 'b'], channels, options = {}, links, prepare } = {}) {
  const mocks = {};
  const instances = {};
  for (const key of keys) {
    mocks[key] = await startMock({ name: key });
    instances[key] = { origin: mocks[key].origin, token: `${key}.secret`, label: `label-${key}` };
  }
  try {
    return await build();
  } catch (err) {
    await Promise.all(Object.values(mocks).map((m) => m.close()));
    throw err;
  }

  async function build() {
    prepare?.(mocks);
    const defaultChannels = Object.fromEntries(keys.map((k, i) => [k, String(10 + i * 10)]));
    const cfg = {
      instances,
      links: links ?? [{ name: 'main', channels: channels ?? defaultChannels }],
      options: { bridgeBots: false, maxAttachmentBytes: 1024, dataDir: '', ...options },
    };
    const logs = [];
    const log = (...a) => logs.push(a.join(' '));
    const clients = new Map();
    for (const key of keys) {
      const client = new FluxerClient(key, instances[key], log);
      client.retryBaseMs = 1;
      await client.discover();
      client.user = { id: mocks[key].userId, username: 'bridge' };
      clients.set(key, client);
    }
    const tmp = tmpDir();
    const store = new Store(tmp.dir);
    const bridge = new Bridge(cfg, clients, store, log);
    await bridge.setupWebhooks();
    bridge.attach();

    return {
      mocks,
      clients,
      bridge,
      store,
      cfg,
      logs,
      tmp,
      /** Deliver an event to the bridge as if the Gateway had sent it, then wait for it to settle. */
      async emit(key, type, payload) {
        clients.get(key).emit(type, payload);
        await bridge.idle();
      },
      async cleanup() {
        store.db.close();
        tmp.remove();
        await Promise.all(Object.values(mocks).map((m) => m.close()));
      },
    };
  }
}

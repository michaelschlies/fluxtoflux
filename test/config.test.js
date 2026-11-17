// Spec: openspec/specs/channel-linking (configuration, instances, links, defaults)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { tmpDir } from './helpers/util.js';

const base = () => ({
  instances: {
    main: { origin: 'https://fluxer.app', token: 'a.b' },
    custom: { origin: 'https://chat.example.com', token: 'c.d' },
  },
  links: [{ name: 'general', channels: { main: '111111111111111111', custom: '222222222222222222' } }],
});

describe('loadConfig', () => {
  let tmp;
  beforeEach(() => {
    tmp = tmpDir();
    delete process.env.FLUXER_TOKEN_MAIN;
  });
  afterEach(() => {
    tmp.remove();
    delete process.env.FLUXER_TOKEN_MAIN;
  });

  const load = (obj) => {
    const path = join(tmp.dir, 'config.json');
    writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return loadConfig(path);
  };

  describe('source', () => {
    it('fails with the path and a hint when the file is missing', () => {
      assert.throws(() => loadConfig(join(tmp.dir, 'nope.json')), /nope\.json.*config\.example\.json/s);
    });
    it('fails on invalid JSON', () => {
      assert.throws(() => load('{ not json'), /Cannot read/);
    });
    it('honours BRIDGE_CONFIG when no path is given', () => {
      const path = join(tmp.dir, 'env.json');
      writeFileSync(path, JSON.stringify(base()));
      process.env.BRIDGE_CONFIG = path;
      try {
        assert.equal(loadConfig().instances.main.origin, 'https://fluxer.app');
      } finally {
        delete process.env.BRIDGE_CONFIG;
      }
    });
  });

  describe('instances', () => {
    it('accepts a valid config and applies option defaults', () => {
      const cfg = load(base());
      assert.deepEqual(cfg.options, {
        bridgeBots: false,
        bridgeReactions: true,
        bridgeThreads: true,
        maxAttachmentBytes: 25 * 1024 * 1024,
        dataDir: 'data',
      });
    });
    it('keeps explicit options and fills in the rest', () => {
      const cfg = load({ ...base(), options: { bridgeBots: true, dataDir: '/x' } });
      assert.equal(cfg.options.bridgeBots, true);
      assert.equal(cfg.options.dataDir, '/x');
      assert.equal(cfg.options.maxAttachmentBytes, 25 * 1024 * 1024);
    });
    it('defaults label to the key, trims origin slashes and strips a "Bot " prefix', () => {
      const c = base();
      c.instances.main = { origin: 'https://fluxer.app///', token: 'Bot a.b' };
      const inst = load(c).instances.main;
      assert.equal(inst.label, 'main');
      assert.equal(inst.origin, 'https://fluxer.app');
      assert.equal(inst.token, 'a.b');
    });
    it('prefers FLUXER_TOKEN_<KEY> over the file', () => {
      process.env.FLUXER_TOKEN_MAIN = 'env.token';
      assert.equal(load(base()).instances.main.token, 'env.token');
    });
    it('does not need a token in the file when the env var is set', () => {
      process.env.FLUXER_TOKEN_MAIN = 'env.token';
      const c = base();
      delete c.instances.main.token;
      assert.equal(load(c).instances.main.token, 'env.token');
    });
    it('rejects an instance with no token anywhere', () => {
      const c = base();
      delete c.instances.main.token;
      assert.throws(() => load(c), /Instance "main" needs origin and token/);
    });
    it('rejects an instance with no origin', () => {
      const c = base();
      delete c.instances.main.origin;
      assert.throws(() => load(c), /needs origin and token/);
    });
    it('rejects keys that cannot form an environment variable name', () => {
      const c = base();
      c.instances['my-instance'] = { origin: 'https://x', token: 'a.b' };
      assert.throws(() => load(c), /"my-instance" must contain only letters, digits and underscores/);
    });
  });

  describe('links', () => {
    it('rejects a link with fewer than two channels', () => {
      const c = base();
      c.links = [{ name: 'solo', channels: { main: '1' } }];
      assert.throws(() => load(c), /Link "solo" needs at least two channels/);
    });
    it('rejects a link with no channels object', () => {
      const c = base();
      c.links = [{ name: 'empty' }];
      assert.throws(() => load(c), /needs at least two channels/);
    });
    it('rejects an unknown instance', () => {
      const c = base();
      c.links[0].channels = { main: '1', ghost: '2' };
      assert.throws(() => load(c), /Link "general" uses unknown instance "ghost"/);
    });
    it('rejects a channel ID written as a JSON number (precision loss)', () => {
      const c = base();
      const json = JSON.stringify(c).replace('"111111111111111111"', '111111111111111111');
      assert.throws(() => load(json), /must be a quoted numeric ID string/);
    });
    it('rejects non-numeric channel IDs', () => {
      const c = base();
      c.links[0].channels.main = 'general';
      assert.throws(() => load(c), /must be a quoted numeric ID string/);
    });
    it('rejects the same channel appearing in two links', () => {
      const c = base();
      c.links.push({ name: 'dup', channels: { main: '111111111111111111', custom: '333' } });
      assert.throws(() => load(c), /Channel 111111111111111111 on "main" is used by more than one link/);
    });
    it('allows the same ID on different instances', () => {
      const c = base();
      c.links[0].channels = { main: '5', custom: '5' };
      assert.doesNotThrow(() => load(c));
    });
    it('rejects oneWayFrom naming a non-member', () => {
      const c = base();
      c.instances.third = { origin: 'https://t', token: 'x.y' };
      c.links[0].oneWayFrom = 'third';
      assert.throws(() => load(c), /oneWayFrom must be one of main, custom/);
    });
    it('accepts oneWayFrom naming a member', () => {
      const c = base();
      c.links[0].oneWayFrom = 'main';
      assert.equal(load(c).links[0].oneWayFrom, 'main');
    });
    describe('backfill', () => {
      const withBackfill = (backfill) => {
        const c = base();
        c.links[0].backfill = backfill;
        return c;
      };
      it('accepts since or limit', () => {
        assert.doesNotThrow(() => load(withBackfill({ since: '2026-01-01' })));
        assert.doesNotThrow(() => load(withBackfill({ limit: 50 })));
      });
      it('rejects both, neither, a bad date and a bad limit', () => {
        for (const bf of [
          { since: '2026-01-01', limit: 5 },
          {},
          { since: 'yesterday-ish' },
          { limit: 0 },
          { limit: 1.5 },
        ]) {
          assert.throws(() => load(withBackfill(bf)), /backfill/);
        }
      });
    });
    it('accepts a config with no links', () => {
      const c = base();
      delete c.links;
      assert.deepEqual(load(c).links, []);
    });
  });
});

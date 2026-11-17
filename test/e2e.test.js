// Runs the real process (src/index.js) against mock instances: startup, --check, fatal errors, live relay.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './helpers/mock-instance.js';
import { message, tmpDir, waitFor } from './helpers/util.js';

const root = join(import.meta.dirname, '..');

describe('process', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
  });

  async function scenario({ tokens = true, links, mutate } = {}) {
    const mocks = { a: await startMock({ name: 'a' }), b: await startMock({ name: 'b' }) };
    const tmp = tmpDir();
    cleanups.push(
      () => tmp.remove(),
      () => Promise.all(Object.values(mocks).map((m) => m.close())),
    );
    mutate?.(mocks);
    const config = {
      instances: {
        a: { origin: mocks.a.origin, label: 'alpha', ...(tokens && { token: 'a.secret' }) },
        b: { origin: mocks.b.origin, label: 'beta', ...(tokens && { token: 'b.secret' }) },
      },
      links: links ?? [{ name: 'main', channels: { a: '10', b: '20' } }],
      options: { dataDir: join(tmp.dir, 'data') },
    };
    const configPath = join(tmp.dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    return { mocks, tmp, config, configPath };
  }

  function run(configPath, args = [], env = {}) {
    const child = spawn(process.execPath, ['src/index.js', ...args], {
      cwd: root,
      env: { ...process.env, BRIDGE_CONFIG: configPath, ...env },
    });
    const proc = { out: '', code: undefined, child };
    child.stdout.on('data', (d) => (proc.out += d));
    child.stderr.on('data', (d) => (proc.out += d));
    proc.exited = new Promise((resolve) =>
      child.on('exit', (code) => {
        proc.code = code;
        resolve(code);
      }),
    );
    cleanups.push(async () => {
      if (proc.code === undefined) {
        child.kill();
        await proc.exited;
      }
    });
    return proc;
  }

  describe('--check', () => {
    it('exits 0, reports each channel, and neither connects nor creates the store', async () => {
      const { mocks, config, configPath } = await scenario();
      const r = run(configPath, ['--check']);
      assert.equal(await r.exited, 0, r.out);
      assert.match(r.out, /ok\s+\[a\] "main" -> #chan-10/);
      assert.match(r.out, /ok\s+\[b\] "main" -> #chan-20/);
      assert.equal(mocks.a.gatewayUrls.length + mocks.b.gatewayUrls.length, 0, 'no gateway connections');
      assert.ok(!existsSync(config.options.dataDir), 'no data directory');
      assert.equal(mocks.a.hooks.length, 1, 'webhook provisioned');
    });

    it('exits 1 and names the instance, link and channel when a channel is inaccessible', async () => {
      const { configPath } = await scenario({ mutate: (m) => m.b.unknownChannels.add('20') });
      const r = run(configPath, ['--check']);
      assert.equal(await r.exited, 1);
      assert.match(r.out, /FAIL\s+\[b\] "main" channel 20: .*404/);
      assert.match(r.out, /ok\s+\[a\]/, 'other channels are still reported');
    });

    it('exits 1 when webhooks cannot be created', async () => {
      const { configPath } = await scenario({ mutate: (m) => (m.a.denyWebhookCreate = true) });
      const r = run(configPath, ['--check']);
      assert.equal(await r.exited, 1);
      assert.match(r.out, /FAIL webhook setup:.*403.*Manage Webhooks/);
    });
  });

  describe('--backfill', () => {
    const history = (mocks) =>
      mocks.a.history.set('10', [
        message({ id: '101', channel_id: '10', content: 'old one', timestamp: '2026-01-02T15:04:05.000Z' }),
        message({ id: '102', channel_id: '10', content: 'old two', timestamp: '2026-01-02T15:05:05.000Z' }),
      ]);
    const backfillLinks = [{ name: 'main', channels: { a: '10', b: '20' }, backfill: { limit: 10 } }];

    it('relays history, exits 0 and never opens a gateway connection', async () => {
      const { mocks, configPath } = await scenario({ links: backfillLinks, mutate: history });
      const r = run(configPath, ['--backfill']);
      assert.equal(await r.exited, 0, r.out);
      assert.deepEqual(
        mocks.b.posts.map((p) => p.json.content),
        ['*2026-01-02 15:04 UTC*\nold one', '*2026-01-02 15:05 UTC*\nold two'],
      );
      assert.equal(mocks.a.gatewayUrls.length + mocks.b.gatewayUrls.length, 0);
      assert.match(r.out, /backfill finished/);
    });

    it('exits 1 for a link name that does not exist', async () => {
      const { configPath } = await scenario({ links: backfillLinks });
      const r = run(configPath, ['--backfill', '--link', 'nope']);
      assert.equal(await r.exited, 1);
      assert.match(r.out, /no link named "nope"/);
    });

    it('exits 1 when the origin channel cannot be read', async () => {
      const { configPath } = await scenario({
        links: backfillLinks,
        mutate: (m) => m.a.inject({ method: 'GET', path: '/messages', status: 403, times: 5 }),
      });
      const r = run(configPath, ['--backfill']);
      assert.equal(await r.exited, 1);
      assert.match(r.out, /catch-up of "main" failed/);
    });
  });

  describe('startup failures', () => {
    it('exits non-zero with a helpful message when the config file is missing', async () => {
      const tmp = tmpDir();
      cleanups.push(() => tmp.remove());
      const r = run(join(tmp.dir, 'missing.json'));
      assert.notEqual(await r.exited, 0);
      assert.match(r.out, /Cannot read .*missing\.json/);
    });

    it('exits non-zero when an instance cannot be reached for discovery', async () => {
      const { mocks, configPath } = await scenario();
      await mocks.b.close();
      const r = run(configPath);
      assert.notEqual(await r.exited, 0);
      assert.match(r.out, /fetch failed|ECONNREFUSED/);
    });

    it('exits non-zero when the config is invalid', async () => {
      const { config, configPath } = await scenario();
      config.links[0].channels.a = '10';
      config.links.push({ name: 'dup', channels: { a: '10', b: '30' } });
      writeFileSync(configPath, JSON.stringify(config));
      const r = run(configPath);
      assert.notEqual(await r.exited, 0);
      assert.match(r.out, /used by more than one link/);
    });

    it('exits 1 when the Gateway rejects the token (fatal close)', async () => {
      const { mocks, configPath } = await scenario({
        mutate: (m) => (m.a.onIdentify = (ws) => ws.close(4004, 'Invalid token')),
      });
      const r = run(configPath);
      assert.equal(await r.exited, 1);
      assert.match(r.out, /\[a\] fatal: gateway close 4004/);
      assert.ok(mocks.b.gatewayUrls.length <= 1);
    });
  });

  describe('running', () => {
    it('relays create, edit and delete end to end over real sockets', async () => {
      const { mocks, configPath } = await scenario();
      const r = run(configPath);
      await waitFor(() => (r.out.match(/ready as/g) ?? []).length === 2, {
        timeout: 8000,
        what: `both gateways ready\n${r.out}`,
      });

      const msg = message({ channel_id: '10', content: 'over the wire' });
      mocks.a.dispatch('MESSAGE_CREATE', msg);
      await waitFor(() => mocks.b.posts.length === 1, { what: 'mirrored message' });
      assert.equal(mocks.b.posts[0].json.content, 'over the wire');
      assert.equal(mocks.b.posts[0].json.username, 'alice · alpha');

      mocks.a.dispatch('MESSAGE_UPDATE', { ...msg, content: 'edited' });
      await waitFor(() => mocks.b.patches.length === 1, { what: 'edit' });
      assert.equal(mocks.b.patches[0].json.content, 'edited');
      assert.equal(mocks.b.patches[0].messageId, mocks.b.posts[0].id);

      mocks.a.dispatch('MESSAGE_DELETE', { id: msg.id, channel_id: '10' });
      await waitFor(() => mocks.b.deletes.length === 1, { what: 'delete' });

      mocks.b.dispatch('MESSAGE_CREATE', message({ channel_id: '20', content: 'and back' }));
      await waitFor(() => mocks.a.posts.length === 1, { what: 'reverse relay' });
      assert.equal(mocks.a.posts[0].json.username, 'alice · beta');
    });

    it('keeps relaying after the Gateway connection drops and resumes', async () => {
      const { mocks, configPath } = await scenario();
      const r = run(configPath);
      await waitFor(() => (r.out.match(/ready as/g) ?? []).length === 2, { timeout: 8000, what: 'ready' });
      mocks.a.closeSockets(1006);
      await waitFor(() => mocks.a.ops(6).length === 1, { timeout: 8000, what: 'resume' });
      await waitFor(() => /session resumed/.test(r.out), { what: 'resumed log' });
      mocks.a.dispatch('MESSAGE_CREATE', message({ channel_id: '10', content: 'after resume' }));
      await waitFor(() => mocks.b.posts.length === 1, { what: 'relay after resume' });
    });

    it('reads tokens from FLUXER_TOKEN_<KEY> when the config has none', async () => {
      const { mocks, configPath } = await scenario({ tokens: false });
      const r = run(configPath, ['--check'], { FLUXER_TOKEN_A: 'env-a.secret', FLUXER_TOKEN_B: 'env-b.secret' });
      assert.equal(await r.exited, 0, r.out);
      assert.ok(mocks.a.requests.some((q) => q.headers.authorization === 'Bot env-a.secret'));
      assert.ok(mocks.b.requests.some((q) => q.headers.authorization === 'Bot env-b.secret'));
    });

    it('does not start with a missing token', async () => {
      const { configPath } = await scenario({ tokens: false });
      const r = run(configPath, ['--check'], { FLUXER_TOKEN_A: '', FLUXER_TOKEN_B: '' });
      assert.notEqual(await r.exited, 0);
      assert.match(r.out, /needs origin and token/);
    });
  });
});

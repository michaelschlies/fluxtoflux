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
    cleanups.push(() => tmp.remove(), () => Promise.all(Object.values(mocks).map((m) => m.close())));
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
    const run = { out: '', code: undefined, child };
    child.stdout.on('data', (d) => (run.out += d));
    child.stderr.on('data', (d) => (run.out += d));
    run.exited = new Promise((resolve) =>
      child.on('exit', (code) => {
        run.code = code;
        resolve(code);
      }),
    );
    cleanups.push(async () => {
      if (run.code === undefined) {
        child.kill();
        await run.exited;
      }
    });
    return run;
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
      const { mocks, configPath } = await scenario({ mutate: (m) => (m.a.onIdentify = (ws) => ws.close(4004, 'Invalid token')) });
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
      await waitFor(() => (r.out.match(/ready as/g) ?? []).length === 2, { timeout: 8000, what: `both gateways ready\n${r.out}` });

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

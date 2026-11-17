// Spec: openspec/specs/instance-connection
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { FluxerClient } from '../src/client.js';
import { startMock } from './helpers/mock-instance.js';
import { sleep, waitFor } from './helpers/util.js';

const quiet = () => {};

async function makeClient(mock, tweak = {}) {
  const client = new FluxerClient('t', { origin: mock.origin, token: 't.secret', label: 'T' }, quiet);
  client.retryBaseMs = 1;
  client.reconnectBaseMs = 5;
  client.invalidSessionDelay = () => 5;
  Object.assign(client, tweak);
  await client.discover();
  return client;
}

describe('REST', () => {
  let mock, client;
  beforeEach(async () => {
    mock = await startMock();
    client = await makeClient(mock);
  });
  afterEach(() => mock.close());

  describe('discovery', () => {
    it('uses api_public + /v1 as the REST base', () => {
      assert.equal(client.apiBase, `${mock.origin}/v1`);
      assert.ok(client.endpoints.gateway.startsWith('ws://'));
    });
    it('falls back to endpoints.api and trims trailing slashes', async () => {
      mock.inject({
        method: 'GET',
        path: '/.well-known/fluxer',
        status: 200,
        body: { endpoints: { api: 'https://api.example.com//', gateway: 'wss://g' } },
      });
      await client.discover();
      assert.equal(client.apiBase, 'https://api.example.com/v1');
    });
    it('fails with the origin and status when discovery errors', async () => {
      mock.inject({ method: 'GET', path: '/.well-known/fluxer', status: 500 });
      await assert.rejects(client.discover(), (e) => e.message.includes(mock.origin) && e.message.includes('500'));
    });
  });

  describe('authentication', () => {
    it('sends the Bot scheme by default', async () => {
      await client.rest('GET', '/channels/1');
      assert.equal(mock.requests.at(-1).headers.authorization, 'Bot t.secret');
    });
    it('sends no Authorization header for webhook-token routes', async () => {
      await client.rest('DELETE', '/webhooks/1/tok/messages/2', { auth: false });
      assert.equal(mock.requests.at(-1).headers.authorization, undefined);
    });
  });

  describe('request encoding', () => {
    it('sends JSON bodies with a content type and applies query parameters', async () => {
      await client.rest('POST', '/webhooks/1/tok', { json: { content: 'hi' }, query: { wait: true }, auth: false });
      const req = mock.requests.at(-1);
      assert.equal(req.headers['content-type'], 'application/json');
      assert.equal(req.query.wait, 'true');
      assert.deepEqual(mock.posts[0].json, { content: 'hi' });
    });
    it('returns null for 204 responses', async () => {
      assert.equal(await client.rest('DELETE', '/webhooks/1/tok/messages/2', { auth: false }), null);
    });
  });

  describe('rate limits', () => {
    it('waits retry_after and retries, returning the eventual result', async () => {
      mock.inject({ method: 'GET', path: '/v1/channels/1', status: 429, body: { retry_after: 0.05, global: false } });
      const started = Date.now();
      const channel = await client.rest('GET', '/channels/1');
      assert.equal(channel.id, '1');
      assert.equal(mock.requests.filter((r) => r.path === '/v1/channels/1').length, 2);
      assert.ok(Date.now() - started >= 50, 'waited at least retry_after');
    });

    it('delays every request on the client after a global 429', async () => {
      mock.inject({ method: 'GET', path: '/v1/channels/1', status: 429, body: { retry_after: 0.2, global: true } });
      const first = client.rest('GET', '/channels/1');
      await waitFor(() => mock.requests.some((r) => r.path === '/v1/channels/1'), { what: 'first request' });
      const limitedAt = mock.requests.find((r) => r.path === '/v1/channels/1').at;
      const other = client.rest('GET', '/channels/2');
      await Promise.all([first, other]);
      const otherAt = mock.requests.find((r) => r.path === '/v1/channels/2').at;
      assert.ok(otherAt - limitedAt >= 190, `other request was sent ${otherAt - limitedAt}ms after the 429`);
    });

    it('does not block other requests after a non-global 429', async () => {
      mock.inject({ method: 'GET', path: '/v1/channels/1', status: 429, body: { retry_after: 0.3, global: false } });
      const first = client.rest('GET', '/channels/1');
      await waitFor(() => mock.requests.some((r) => r.path === '/v1/channels/1'));
      const t0 = Date.now();
      await client.rest('GET', '/channels/2');
      assert.ok(Date.now() - t0 < 200);
      await first;
    });

    it('gives up after 6 retries with a 429 error', async () => {
      mock.inject({ method: 'GET', path: '/v1/channels/1', status: 429, body: { retry_after: 0.001 }, times: 20 });
      await assert.rejects(client.rest('GET', '/channels/1'), (e) => e.status === 429);
      assert.equal(mock.requests.filter((r) => r.path === '/v1/channels/1').length, 7);
    });

    it('falls back to the Retry-After header when the body has no retry_after', async () => {
      mock.inject({ method: 'GET', path: '/v1/channels/1', status: 429, body: {}, headers: { 'retry-after': '1' } });
      const t0 = Date.now();
      await client.rest('GET', '/channels/1');
      assert.ok(Date.now() - t0 >= 1000);
    });
  });

  describe('errors', () => {
    it('retries 5xx and returns the eventual success', async () => {
      mock.inject({ method: 'GET', path: '/v1/channels/1', status: 500, times: 2 });
      assert.equal((await client.rest('GET', '/channels/1')).id, '1');
      assert.equal(mock.requests.filter((r) => r.path === '/v1/channels/1').length, 3);
    });
    it('surfaces a persistent 5xx after 3 retries', async () => {
      mock.inject({ method: 'GET', path: '/v1/channels/1', status: 503, times: 10 });
      await assert.rejects(client.rest('GET', '/channels/1'), (e) => e.status === 503);
      assert.equal(mock.requests.filter((r) => r.path === '/v1/channels/1').length, 4);
    });
    it('does not retry 4xx and exposes status, code and message', async () => {
      mock.inject({
        method: 'GET',
        path: '/v1/channels/1',
        status: 404,
        body: { code: 'UNKNOWN_CHANNEL', message: 'nope' },
      });
      await assert.rejects(client.rest('GET', '/channels/1'), (e) => {
        assert.equal(e.status, 404);
        assert.equal(e.code, 'UNKNOWN_CHANNEL');
        assert.match(e.message, /GET \/channels\/1 -> 404 UNKNOWN_CHANNEL nope/);
        return true;
      });
      assert.equal(mock.requests.filter((r) => r.path === '/v1/channels/1').length, 1);
    });
  });
});

describe('Gateway', () => {
  let mock, client;
  const noReconnects = () => assert.equal(mock.gatewayUrls.length, 1, 'no further connections');

  beforeEach(async () => {
    mock = await startMock();
    mock.helloInterval = 40;
    client = await makeClient(mock);
  });
  afterEach(async () => {
    client.stop();
    await mock.close();
  });

  const ready = async () => {
    const p = once(client, 'READY');
    await client.connect();
    return p;
  };

  describe('session lifecycle', () => {
    it('connects with v=1 and json encoding', async () => {
      await ready();
      assert.match(mock.gatewayUrls[0], /[?&]v=1/);
      assert.match(mock.gatewayUrls[0], /encoding=json/);
    });
    it('identifies with the raw token and client properties', async () => {
      await ready();
      const [identify] = mock.ops(2);
      assert.equal(identify.d.token, 't.secret');
      assert.ok(identify.d.properties.browser);
      assert.ok(identify.d.properties.os);
    });
    it('records the session and bot user from READY', async () => {
      await ready();
      assert.equal(client.sessionId, 'sess-1');
      assert.deepEqual(client.user, { id: mock.userId, username: 'bridge' });
    });
    it('re-emits dispatches by event name', async () => {
      await ready();
      const got = once(client, 'MESSAGE_CREATE');
      mock.dispatch('MESSAGE_CREATE', { id: '77' });
      assert.deepEqual((await got)[0], { id: '77' });
    });
    it('ignores unknown opcodes', async () => {
      await ready();
      mock.sockets.forEach((ws) => mock.send(ws, 99, {}));
      await sleep(50);
      assert.equal(client.ws.readyState, WebSocket.OPEN);
    });
  });

  describe('heartbeat', () => {
    it('heartbeats repeatedly with the latest sequence number', async () => {
      await ready();
      await waitFor(() => mock.ops(1).length >= 3, { what: 'three heartbeats' });
      assert.equal(mock.ops(1).at(-1).d, 1); // READY carried s=1
    });
    it('answers a server heartbeat request immediately', async () => {
      mock.helloInterval = 60_000; // no periodic beats during the test
      await ready();
      const before = mock.ops(1).length;
      mock.sockets.forEach((ws) => mock.send(ws, 1));
      await waitFor(() => mock.ops(1).length > before, { what: 'immediate heartbeat' });
    });
    it('reconnects and resumes when heartbeats are not acknowledged', async () => {
      mock.ackHeartbeats = false;
      await ready();
      await waitFor(() => mock.ops(6).length >= 1, { what: 'resume after missed ack' });
      assert.ok(mock.gatewayUrls.length >= 2);
    });
  });

  describe('resume and reconnect', () => {
    it('resumes with session_id and sequence after a dropped connection', async () => {
      await ready();
      const resumed = once(client, 'RESUMED');
      mock.closeSockets(1006);
      await resumed;
      const [resume] = mock.ops(6);
      assert.deepEqual(resume.d, { token: 't.secret', session_id: 'sess-1', seq: 1 });
      assert.equal(mock.ops(2).length, 1, 'did not identify again');
    });
    it('identifies afresh when the server answers Resume with Invalid Session', async () => {
      mock.onResume = (ws) => mock.send(ws, 9, false);
      await ready();
      const second = once(client, 'READY');
      mock.closeSockets(1006);
      await second;
      assert.equal(mock.ops(2).length, 2);
      assert.equal(client.sessionId, 'sess-2');
    });
    it('closes and resumes when the server requests a reconnect (op 7)', async () => {
      await ready();
      const resumed = once(client, 'RESUMED');
      mock.sockets.forEach((ws) => mock.send(ws, 7));
      await resumed;
      assert.equal(mock.ops(6).length, 1);
    });
    for (const code of [1006, 4000, 4008, 4009]) {
      it(`reconnects after close code ${code}`, async () => {
        await ready();
        mock.closeSockets(code);
        await waitFor(() => mock.gatewayUrls.length >= 2, { what: 'reconnect' });
      });
    }
    it('keeps retrying while the server is unreachable-then-back', async () => {
      await ready();
      let refused = 0;
      mock.onIdentify = () => {};
      mock.onResume = (ws) => {
        if (refused++ < 2) ws.close(4000, 'busy');
        else mock.send(ws, 0, {}, 'RESUMED');
      };
      const resumed = once(client, 'RESUMED');
      mock.closeSockets(1006);
      await resumed;
      assert.ok(mock.ops(6).length >= 3);
    });
  });

  describe('fatal close codes', () => {
    for (const code of [4004, 4010, 4011, 4012]) {
      it(`emits fatal and stays disconnected after ${code}`, async () => {
        mock.onIdentify = (ws) => ws.close(code, 'denied');
        const fatal = once(client, 'fatal');
        await client.connect();
        const [err] = await fatal;
        assert.match(err.message, new RegExp(`${code}.*denied`));
        await sleep(100);
        noReconnects();
      });
    }
  });

  describe('stop', () => {
    it('does not reconnect or heartbeat after stop()', async () => {
      await ready();
      client.stop();
      await waitFor(() => mock.sockets.length === 0, { what: 'socket closed' });
      const beats = mock.ops(1).length;
      await sleep(150);
      noReconnects();
      assert.equal(mock.ops(1).length, beats);
    });
    it('leaves no timers behind, even across reconnects', async () => {
      const baseline = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      mock.helloInterval = 20;
      await ready();
      for (let i = 0; i < 3; i++) {
        const resumed = once(client, 'RESUMED');
        mock.closeSockets(1006);
        await resumed;
      }
      client.stop();
      await sleep(150);
      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      assert.ok(after <= baseline, `${after} timers active after stop (baseline ${baseline})`);
    });
  });
});

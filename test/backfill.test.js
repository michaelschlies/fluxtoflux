// Spec: openspec/specs/history-backfill
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

const day = 86_400_000;
const link = (extra = {}) => [{ name: 'main', channels: { a: '10', b: '20' }, ...extra }];
/** A history message with a given id and age in days. */
const old = (id, ageDays = 1, over = {}) =>
  message({
    id: String(id),
    content: `m${id}`,
    timestamp: new Date(Date.now() - ageDays * day).toISOString(),
    ...over,
  });

describe('history backfill', () => {
  let h, A, B;
  const setup = async (opts = {}) => {
    h = await createHarness(opts);
    [A, B] = [h.mocks.a, h.mocks.b];
  };
  const seed = (mock, channel, msgs) => mock.history.set(channel, msgs);
  const contents = () => B.posts.map((p) => p.json.content.replace(/^\*[^*]+\*\n?/, ''));
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  describe('request', () => {
    it('relays messages since a date, oldest first', async () => {
      await setup({ links: link({ backfill: { since: new Date(Date.now() - 5 * day).toISOString() } }) });
      seed(A, '10', [old(101, 10), old(102, 4), old(103, 3), old(104, 1)]);
      assert.equal(await h.bridge.catchUp(), true);
      assert.deepEqual(contents(), ['m102', 'm103', 'm104']);
    });

    it('relays only the most recent messages up to the limit', async () => {
      await setup({ links: link({ backfill: { limit: 2 } }) });
      seed(A, '10', [old(101), old(102), old(103), old(104)]);
      await h.bridge.catchUp();
      assert.deepEqual(contents(), ['m103', 'm104']);
    });

    it('pages through histories longer than one page', async () => {
      await setup({ links: link({ backfill: { limit: 150 } }) });
      seed(
        A,
        '10',
        Array.from({ length: 230 }, (_, i) => old(1000 + i)),
      );
      await h.bridge.catchUp();
      assert.equal(B.posts.length, 150);
      assert.equal(contents()[0], 'm1080');
      assert.equal(contents().at(-1), 'm1229');
    });

    it('fetches no history for a link without backfill configuration', async () => {
      await setup();
      seed(A, '10', [old(101)]);
      await h.bridge.catchUp();
      assert.equal(A.requests.filter((r) => r.path.endsWith('/messages')).length, 0);
      assert.equal(B.posts.length, 0);
    });

    it('prefixes the original time because a webhook cannot set one', async () => {
      await setup({ links: link({ backfill: { limit: 1 } }) });
      seed(A, '10', [old(101, 1, { timestamp: '2026-01-02T15:04:05.000Z' })]);
      await h.bridge.catchUp();
      assert.equal(B.posts[0].json.content, '*2026-01-02 15:04 UTC*\nm101');
    });
  });

  describe('idempotence', () => {
    it('delivers each message once when run twice', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      seed(A, '10', [old(101), old(102)]);
      await h.bridge.catchUp();
      await h.bridge.catchUp();
      assert.equal(B.posts.length, 2);
    });

    it('skips messages that already have a copy', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      seed(A, '10', [old(101), old(102)]);
      h.store.add('a', '101', 'b', '20', '900', 'h', '10');
      await h.bridge.catchUp();
      assert.deepEqual(contents(), ['m102']);
    });

    it('does not relay copies the bridge itself posted', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      seed(A, '10', [
        old(101, 1, { webhook_id: A.hooks[0].id, author: { id: 'w', username: 'x', bot: true } }),
        old(102),
      ]);
      await h.bridge.catchUp();
      assert.deepEqual(contents(), ['m102']);
    });
  });

  describe('watermark and gaps', () => {
    it('relays what was posted while the bridge was down', async () => {
      await setup();
      const first = old(100, 0);
      await h.emit('a', 'MESSAGE_CREATE', first);
      assert.equal(h.store.watermark('a', '10'), '100');
      seed(A, '10', [first, old(101), old(102), old(103), old(104)]);
      await h.bridge.catchUp();
      assert.deepEqual(contents(), ['m100', 'm101', 'm102', 'm103', 'm104']);
    });

    it('resumes after the last delivered message', async () => {
      await setup({ links: link({ backfill: { limit: 50 } }) });
      seed(
        A,
        '10',
        Array.from({ length: 30 }, (_, i) => old(101 + i)),
      );
      h.store.setWatermark('a', '10', '120');
      await h.bridge.catchUp();
      assert.equal(contents()[0], 'm121');
      assert.equal(B.posts.length, 10);
      assert.equal(h.store.watermark('a', '10'), '130');
    });

    it('does not advance past a message that failed to deliver', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      seed(A, '10', [old(101), old(102), old(103)]);
      B.inject({ method: 'POST', path: '/v1/webhooks/', status: 400, body: { code: 'INVALID' } });
      await h.bridge.catchUp();
      assert.equal(B.posts.length, 2);
      assert.equal(h.store.watermark('a', '10'), null);
      assert.ok(h.logs.some((l) => l.includes('was not delivered')));
    });

    it('delivers later messages when one cannot be delivered', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      seed(A, '10', [old(101), old(102)]);
      B.inject({ method: 'POST', path: '/v1/webhooks/', status: 400, body: { code: 'INVALID' } });
      await h.bridge.catchUp();
      assert.deepEqual(contents(), ['m102']);
    });
  });

  describe('live traffic and rate limits', () => {
    it('delivers live messages after the backfilled ones', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      seed(A, '10', [old(101), old(102)]);
      h.bridge.holdForCatchUp();
      const live = h.emit('a', 'MESSAGE_CREATE', message({ id: '999', content: 'live' }));
      await h.bridge.catchUp();
      await live;
      assert.deepEqual(contents(), ['m101', 'm102', 'live']);
    });

    it('waits out a rate limit and still delivers the message once', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      seed(A, '10', [old(101)]);
      B.inject({ method: 'POST', path: '/v1/webhooks/', status: 429, body: { retry_after: 0.01 } });
      await h.bridge.catchUp();
      assert.equal(B.posts.length, 1);
    });

    it('reports failure when the origin channel cannot be read', async () => {
      await setup({ links: link({ backfill: { limit: 5 } }) });
      A.inject({ method: 'GET', path: '/messages', status: 403, body: { code: 'MISSING_ACCESS' } });
      assert.equal(await h.bridge.catchUp(), false);
      assert.ok(h.logs.some((l) => l.includes('catch-up of "main" failed')));
    });
  });

  describe('link scope', () => {
    it('reads history only from the origin of a one-way link', async () => {
      await setup({ links: link({ oneWayFrom: 'a', backfill: { limit: 5 } }) });
      seed(A, '10', [old(101)]);
      seed(B, '20', [old(201)]);
      await h.bridge.catchUp();
      assert.equal(B.requests.filter((r) => r.path.endsWith('/messages')).length, 0);
      assert.equal(A.posts.length, 0);
      assert.equal(B.posts.length, 1);
    });

    it('processes only the named link', async () => {
      await setup({
        keys: ['a', 'b'],
        links: [
          { name: 'one', channels: { a: '10', b: '20' }, backfill: { limit: 5 } },
          { name: 'two', channels: { a: '11', b: '21' }, backfill: { limit: 5 } },
        ],
      });
      seed(A, '10', [old(101, 1, { channel_id: '10' })]);
      seed(A, '11', [old(111, 1, { channel_id: '11' })]);
      await h.bridge.catchUp({ link: 'two' });
      assert.deepEqual(contents(), ['m111']);
    });
  });
});

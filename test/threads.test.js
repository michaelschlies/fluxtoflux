// Spec: openspec/specs/threads
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

const thread = (over = {}) => ({ id: '100', parent_id: '10', name: 'planning', type: 11, ...over });

describe('threads', () => {
  let h, A, B;
  const setup = async (opts) => {
    h = await createHarness(opts);
    [A, B] = [h.mocks.a, h.mocks.b];
  };
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });
  /** Register a thread on a mock so lazy lookups can find it, and post a message in it. */
  const post = (mock, t, over = {}) => {
    mock.channels.set(t.id, t);
    return h.emit(mock === A ? 'a' : 'b', 'MESSAGE_CREATE', message({ channel_id: t.id, ...over }));
  };

  describe('pairing', () => {
    beforeEach(() => setup());

    it('creates a thread with the same name on each destination when one is started', async () => {
      await h.emit('a', 'THREAD_CREATE', { ...thread(), newly_created: true });
      assert.equal(B.threadCreates.length, 1);
      assert.equal(B.threadCreates[0].channel, '20');
      assert.deepEqual(B.threadCreates[0].json, { name: 'planning', type: 11 });
      assert.deepEqual(
        h.store
          .threadGroup('a', '100')
          .map((r) => r.inst)
          .sort(),
        ['a', 'b'],
      );
    });

    it('ignores threads of channels that are not linked', async () => {
      await h.emit('a', 'THREAD_CREATE', { ...thread({ parent_id: '99' }), newly_created: true });
      assert.equal(B.threadCreates.length, 0);
    });

    it('does not create a counterpart when the session is merely added to an existing thread', async () => {
      await h.emit('a', 'THREAD_CREATE', thread());
      assert.equal(B.threadCreates.length, 0);
    });

    it('never mirrors private threads', async () => {
      await h.emit('a', 'THREAD_CREATE', { ...thread({ type: 12 }), newly_created: true });
      await post(A, thread({ type: 12 }));
      assert.equal(B.threadCreates.length, 0);
      assert.equal(B.posts.length, 0);
    });

    it('attaches the new thread to the copy of its starter message', async () => {
      const starter = message({ id: '77' });
      await h.emit('a', 'MESSAGE_CREATE', starter);
      const copyId = B.posts[0].id;
      await h.emit('a', 'THREAD_CREATE', { ...thread({ id: '77' }), newly_created: true });
      assert.equal(B.threadCreates[0].fromMessage, copyId);
    });

    it('keeps the pairing after a restart', async () => {
      await h.emit('a', 'THREAD_CREATE', { ...thread(), newly_created: true });
      const reopened = new h.store.constructor(h.tmp.dir);
      assert.equal(reopened.threadGroup('a', '100').length, 2);
      reopened.db.close();
    });
  });

  describe('messages', () => {
    beforeEach(() => setup());

    it('delivers a thread message to the paired thread, not the parent channel', async () => {
      await h.emit('a', 'THREAD_CREATE', { ...thread(), newly_created: true });
      await post(A, thread(), { content: 'hello' });
      const post0 = B.posts[0];
      assert.equal(post0.query.thread_id, B.threadCreates[0].id);
      assert.equal(post0.json.content, 'hello');
      assert.equal(post0.json.username, 'alice · label-a');
    });

    it('creates the counterpart when a message arrives in a thread it has never seen', async () => {
      await post(A, thread(), { content: 'first' });
      assert.equal(B.threadCreates.length, 1);
      assert.equal(B.posts[0].query.thread_id, B.threadCreates[0].id);
    });

    it('creates only one counterpart for messages that arrive together', async () => {
      A.channels.set('100', thread());
      await Promise.all([
        h.emit('a', 'MESSAGE_CREATE', message({ channel_id: '100' })),
        h.emit('a', 'MESSAGE_CREATE', message({ channel_id: '100' })),
      ]);
      assert.equal(B.threadCreates.length, 1);
      assert.equal(B.posts.length, 2);
    });

    it('relays a reply from the paired thread back to the origin thread', async () => {
      await post(A, thread(), { content: 'hello' });
      const bThread = B.threadCreates[0].id;
      await post(B, { ...thread({ id: bThread, parent_id: '20' }) }, { content: 'reply' });
      assert.equal(A.posts[0].query.thread_id, '100');
      assert.equal(A.posts[0].json.content, 'reply');
    });

    it('keeps messages in a thread in order when the first delivery is slow', async () => {
      A.channels.set('100', thread());
      await h.emit('a', 'THREAD_CREATE', { ...thread(), newly_created: true });
      B.postDelay = (i) => (i === 0 ? 80 : 0);
      for (const c of ['1', '2', '3']) {
        h.clients.get('a').emit('MESSAGE_CREATE', message({ channel_id: '100', content: c }));
      }
      await h.bridge.idle();
      assert.deepEqual(
        B.posts.map((p) => p.json.content),
        ['1', '2', '3'],
      );
    });

    it('propagates edits and deletes through the thread the copy is in', async () => {
      const msg = message({ channel_id: '100', content: 'v1' });
      A.channels.set('100', thread());
      await h.emit('a', 'MESSAGE_CREATE', msg);
      const threadId = B.threadCreates[0].id;
      await h.emit('a', 'MESSAGE_UPDATE', { ...msg, content: 'v2' });
      assert.equal(B.patches[0].query.thread_id, threadId);
      await h.emit('a', 'MESSAGE_DELETE', { id: msg.id, channel_id: '100' });
      assert.equal(B.deletes[0].query.thread_id, threadId);
    });

    it('does not mirror the thread starter system message', async () => {
      A.channels.set('100', thread());
      await h.emit('a', 'MESSAGE_CREATE', message({ channel_id: '100', type: 21 }));
      assert.equal(B.posts.length, 0);
    });
  });

  describe('lifecycle', () => {
    beforeEach(async () => {
      await setup();
      await h.emit('a', 'THREAD_CREATE', { ...thread(), newly_created: true });
      B.dst = B.threadCreates[0].id;
    });

    it('renames the paired thread', async () => {
      await h.emit('a', 'THREAD_UPDATE', thread({ name: 'roadmap' }));
      assert.deepEqual(B.channelPatches, [{ id: B.dst, json: { name: 'roadmap' } }]);
    });

    it('archives and unarchives the paired thread', async () => {
      await h.emit('a', 'THREAD_UPDATE', { ...thread(), thread_metadata: { archived: true } });
      assert.deepEqual(B.channelPatches.at(-1), { id: B.dst, json: { archived: true } });
      await h.emit('a', 'THREAD_UPDATE', { ...thread(), thread_metadata: { archived: false } });
      assert.deepEqual(B.channelPatches.at(-1), { id: B.dst, json: { archived: false } });
    });

    it('does not bounce its own rename back', async () => {
      await h.emit('a', 'THREAD_UPDATE', thread({ name: 'roadmap' }));
      await h.emit('b', 'THREAD_UPDATE', { id: B.dst, parent_id: '20', name: 'roadmap', type: 11 });
      assert.equal(A.channelPatches.length, 0);
    });

    it('removes the pairing when the thread is deleted', async () => {
      await h.emit('a', 'THREAD_DELETE', { id: '100', parent_id: '10', type: 11 });
      assert.deepEqual(h.store.threadGroup('a', '100'), []);
      assert.deepEqual(h.store.threadGroup('b', B.dst), []);
    });
  });

  describe('flattening', () => {
    beforeEach(async () => {
      await setup();
      B.denyThreadCreate = true;
    });

    it('delivers to the parent channel with a thread prefix when the thread cannot be created', async () => {
      await post(A, thread(), { content: 'hello' });
      assert.equal(B.posts[0].json.content, '[thread: planning] hello');
      assert.equal(B.posts[0].query.thread_id, undefined);
    });

    it('logs the failure once per thread', async () => {
      A.channels.set('100', thread());
      for (const c of ['1', '2']) await h.emit('a', 'MESSAGE_CREATE', message({ channel_id: '100', content: c }));
      assert.equal(h.logs.filter((l) => l.includes('cannot create thread')).length, 1);
      assert.equal(B.posts.length, 2);
    });

    it('keeps the prefix when the message is edited', async () => {
      const msg = message({ channel_id: '100', content: 'v1' });
      A.channels.set('100', thread());
      await h.emit('a', 'MESSAGE_CREATE', msg);
      await h.emit('a', 'MESSAGE_UPDATE', { ...msg, content: 'v2' });
      assert.equal(B.patches[0].json.content, '[thread: planning] v2');
    });
  });

  describe('options', () => {
    it('honours oneWayFrom', async () => {
      await setup({ links: [{ name: 'main', channels: { a: '10', b: '20' }, oneWayFrom: 'a' }] });
      await post(B, thread({ id: '200', parent_id: '20' }));
      assert.equal(A.posts.length, 0);
      assert.equal(A.threadCreates.length, 0);
    });

    it('ignores threads and does not look channels up when bridgeThreads is false', async () => {
      await setup({ options: { bridgeThreads: false } });
      await post(A, thread());
      await h.emit('a', 'THREAD_CREATE', { ...thread(), newly_created: true });
      assert.equal(B.posts.length, 0);
      assert.equal(B.threadCreates.length, 0);
      assert.equal(A.requests.filter((r) => r.path === '/v1/channels/100').length, 0);
    });
  });
});

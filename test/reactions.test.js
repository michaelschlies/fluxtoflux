// Spec: openspec/specs/reactions
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

describe('reactions', () => {
  let h, A, B;
  const setup = async (opts) => {
    h = await createHarness(opts);
    [A, B] = [h.mocks.a, h.mocks.b];
  };
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  /** Post a message on A and return it with the id of its copy on B. */
  const mirrored = async () => {
    const msg = message();
    await h.emit('a', 'MESSAGE_CREATE', msg);
    return { msg, copyId: B.posts.at(-1).id };
  };
  const react = (key, channel, messageId, emoji = { name: '👍' }, { remove = false, ...extra } = {}) =>
    h.emit(key, remove ? 'MESSAGE_REACTION_REMOVE' : 'MESSAGE_REACTION_ADD', {
      user_id: '5',
      channel_id: channel,
      message_id: messageId,
      emoji,
      ...extra,
    });

  describe('mirroring', () => {
    beforeEach(() => setup());

    it('adds the reaction to each copy', async () => {
      const { msg, copyId } = await mirrored();
      await react('a', '10', msg.id);
      assert.deepEqual(B.reactionOps, [{ op: 'PUT', channel: '20', message: copyId, emoji: '👍' }]);
    });

    it('adds the reaction to the source when a copy is reacted to', async () => {
      const { msg, copyId } = await mirrored();
      await react('b', '20', copyId, { name: '❤️' });
      assert.deepEqual(A.reactionOps, [{ op: 'PUT', channel: '10', message: msg.id, emoji: '❤️' }]);
    });

    it('ignores messages the bridge never mirrored', async () => {
      await react('a', '10', '999');
      assert.equal(B.reactionOps.length, 0);
    });

    it('mirrors a reaction on a message inside a paired thread', async () => {
      A.channels.set('100', { id: '100', parent_id: '10', name: 'planning', type: 11 });
      const msg = message({ channel_id: '100' });
      await h.emit('a', 'MESSAGE_CREATE', msg);
      const threadId = B.threadCreates[0].id;
      await react('a', '100', msg.id);
      assert.equal(B.reactionOps[0].channel, threadId);
    });
  });

  describe('custom emoji and echoes', () => {
    beforeEach(() => setup());

    it('does not mirror custom emoji', async () => {
      const { msg } = await mirrored();
      await react('a', '10', msg.id, { name: 'party', id: '77' });
      assert.equal(B.reactionOps.length, 0);
      assert.equal(h.logs.filter((l) => /error/i.test(l)).length, 0);
    });

    it('ignores reactions made by its own bot user', async () => {
      const { msg } = await mirrored();
      await react('a', '10', msg.id, { name: '👍' }, { user_id: A.userId });
      assert.equal(B.reactionOps.length, 0);
    });
  });

  describe('removal', () => {
    beforeEach(() => setup());

    it('removes the mirrored reaction when the last reactor leaves', async () => {
      const { msg, copyId } = await mirrored();
      await react('a', '10', msg.id, { name: '👍' }, { remove: true });
      assert.deepEqual(B.reactionOps, [{ op: 'DELETE', channel: '20', message: copyId, emoji: '👍' }]);
    });

    it('keeps it while other users still have the emoji', async () => {
      const { msg } = await mirrored();
      A.reactionUsers[`10/${msg.id}/👍`] = [{ id: '6' }];
      await react('a', '10', msg.id, { name: '👍' }, { remove: true });
      assert.equal(B.reactionOps.length, 0);
    });

    it('does not count its own reaction as a remaining reactor', async () => {
      const { msg } = await mirrored();
      A.reactionUsers[`10/${msg.id}/👍`] = [{ id: A.userId }];
      await react('a', '10', msg.id, { name: '👍' }, { remove: true });
      assert.equal(B.reactionOps.length, 1);
    });
  });

  describe('options and failures', () => {
    it('mirrors to every other copy of a three-way link', async () => {
      await setup({ keys: ['a', 'b', 'c'] });
      const msg = message();
      await h.emit('a', 'MESSAGE_CREATE', msg);
      const cCopy = h.mocks.c.posts[0].id;
      await react('b', '20', h.mocks.b.posts[0].id);
      assert.equal(A.reactionOps[0].message, msg.id);
      assert.equal(h.mocks.c.reactionOps[0].message, cCopy);
    });

    it('honours oneWayFrom', async () => {
      await setup({ links: [{ name: 'main', channels: { a: '10', b: '20' }, oneWayFrom: 'a' }] });
      const { msg, copyId } = await mirrored();
      await react('b', '20', copyId);
      assert.equal(A.reactionOps.length, 0);
      await react('a', '10', msg.id);
      assert.equal(B.reactionOps.length, 1);
    });

    it('mirrors nothing when bridgeReactions is false', async () => {
      await setup({ options: { bridgeReactions: false } });
      const { msg } = await mirrored();
      await react('a', '10', msg.id);
      assert.equal(B.reactionOps.length, 0);
    });

    it('logs a warning and keeps mirroring messages when the bot may not react', async () => {
      await setup();
      const { msg } = await mirrored();
      B.inject({ method: 'PUT', path: '/reactions/', status: 403, body: { code: 'MISSING_PERMISSIONS' } });
      await react('a', '10', msg.id);
      assert.ok(h.logs.some((l) => l.includes('warning: reaction not mirrored')));
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'later' }));
      assert.equal(B.posts.at(-1).json.content, 'later');
    });

    it('treats a deleted copy as already gone', async () => {
      await setup();
      const { msg } = await mirrored();
      B.inject({ method: 'PUT', path: '/reactions/', status: 404, body: { code: 'UNKNOWN_MESSAGE' } });
      await react('a', '10', msg.id);
      assert.equal(h.logs.filter((l) => l.includes('warning')).length, 0);
    });
  });
});

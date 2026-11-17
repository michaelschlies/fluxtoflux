// Spec: openspec/specs/message-sync (edit and delete propagation) and attachments untouched on edit
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

describe('sync', () => {
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
  const mirrored = async (overrides = {}) => {
    const msg = message(overrides);
    await h.emit('a', 'MESSAGE_CREATE', msg);
    return { msg, copyId: B.posts.at(-1).id };
  };
  const edit = (msg, content, extra = {}) => h.emit('a', 'MESSAGE_UPDATE', { ...msg, content, ...extra });

  describe('edits', () => {
    beforeEach(() => setup());

    it('patches the copy with the new text', async () => {
      const { msg, copyId } = await mirrored({ content: 'hello' });
      await edit(msg, 'hello world');
      assert.equal(B.patches.length, 1);
      const patch = B.patches[0];
      assert.equal(patch.hookId, B.hooks[0].id);
      assert.equal(patch.messageId, copyId);
      assert.equal(patch.json.content, 'hello world');
      assert.deepEqual(patch.json.allowed_mentions, { parse: [] });
      assert.equal(patch.auth, undefined);
    });

    it('does nothing when the text is unchanged (embed unfurl, pin, etc.)', async () => {
      const { msg } = await mirrored({ content: 'same' });
      await edit(msg, 'same', { embeds: [{ url: 'https://example.com' }] });
      assert.equal(B.patches.length, 0);
    });

    it('sends one patch when the same edit is delivered twice', async () => {
      const { msg } = await mirrored({ content: 'v1' });
      await edit(msg, 'v2');
      await edit(msg, 'v2');
      assert.equal(B.patches.length, 1);
    });

    it('tracks successive edits, including a revert to the original text', async () => {
      const { msg } = await mirrored({ content: 'v1' });
      await edit(msg, 'v2');
      await edit(msg, 'v1');
      assert.deepEqual(B.patches.map((p) => p.json.content), ['v2', 'v1']);
    });

    it('re-renders mentions in the edited text', async () => {
      const { msg } = await mirrored({ content: 'hi' });
      await edit(msg, 'hi <@5>', { mentions: [{ id: '5', username: 'alice' }] });
      assert.equal(B.patches[0].json.content, 'hi @alice');
    });

    it('truncates over-long edited text like new messages', async () => {
      const { msg } = await mirrored({ content: 'short' });
      await edit(msg, 'z'.repeat(6000));
      assert.equal(B.patches[0].json.content.length, 4000);
    });

    it('patches every copy when mirrored to several destinations', async () => {
      await h.cleanup();
      await setup({ keys: ['a', 'b', 'c'] });
      const msg = message({ content: 'one' });
      await h.emit('a', 'MESSAGE_CREATE', msg);
      await h.emit('a', 'MESSAGE_UPDATE', { ...msg, content: 'two' });
      assert.equal(h.mocks.b.patches.length, 1);
      assert.equal(h.mocks.c.patches.length, 1);
    });

    it('ignores updates for messages it never mirrored', async () => {
      await edit(message({ content: 'old' }), 'new');
      assert.equal(B.patches.length, 0);
    });

    it('ignores updates without content (partial payloads)', async () => {
      const { msg } = await mirrored({ content: 'x' });
      await h.emit('a', 'MESSAGE_UPDATE', { ...msg, content: undefined });
      await h.emit('a', 'MESSAGE_UPDATE', { ...msg, content: null });
      assert.equal(B.patches.length, 0);
    });

    it('does not edit when the update comes from its own webhook or a bot', async () => {
      const { msg } = await mirrored({ content: 'x' });
      await edit({ ...msg, webhook_id: A.hooks[0].id, author: { id: A.hooks[0].id, username: 'w', bot: true } }, 'changed');
      await edit({ ...msg, author: { id: '8', username: 'bot', bot: true } }, 'changed');
      assert.equal(B.patches.length, 0);
    });

    it('survives a failing patch and processes later edits', async () => {
      const { msg } = await mirrored({ content: 'v1' });
      B.goneHooks.add(B.hooks[0].id);
      await edit(msg, 'v2');
      B.goneHooks.clear();
      await edit(msg, 'v3');
      assert.deepEqual(B.patches.map((p) => p.json.content), ['v3']);
      assert.ok(h.logs.some((l) => l.includes('UNKNOWN_WEBHOOK')));
    });

    it('retries the same text after a failed patch (hash is not advanced on failure)', async () => {
      const { msg } = await mirrored({ content: 'v1' });
      B.goneHooks.add(B.hooks[0].id);
      await edit(msg, 'v2');
      B.goneHooks.clear();
      await edit(msg, 'v2');
      assert.deepEqual(B.patches.map((p) => p.json.content), ['v2']);
    });
  });

  describe('edits of messages with attachments', () => {
    beforeEach(() => setup({ options: { maxAttachmentBytes: 1024 } }));

    it('does not strip a fallback link when an update arrives with unchanged text', async () => {
      const gone = { id: 'x', filename: 'gone.png', size: 10, url: A.fileUrl('gone.png') };
      const { msg } = await mirrored({ content: 'pic', attachments: [gone] });
      assert.equal(B.posts[0].json.content, `pic\n${gone.url}`);
      await edit(msg, 'pic', { embeds: [{ url: 'https://example.com' }] });
      assert.equal(B.patches.length, 0, 'the link in the copy must not be overwritten');
    });

    it('restates links to oversized files when the text is edited', async () => {
      const big = { id: 'y', filename: 'big.bin', size: 5000, url: A.fileUrl('big.bin') };
      const { msg } = await mirrored({ content: 'v1', attachments: [big] });
      await edit(msg, 'v2');
      assert.equal(B.patches[0].json.content, `v2\n${big.url}`);
    });

    it('never touches the attachments of the copy on edit', async () => {
      A.files.set('p.txt', Buffer.from('data'));
      const att = { id: 'z', filename: 'p.txt', size: 4, url: A.fileUrl('p.txt') };
      const { msg } = await mirrored({ content: 'v1', attachments: [att] });
      await edit(msg, 'v2');
      assert.deepEqual(Object.keys(B.patches[0].json).sort(), ['allowed_mentions', 'content']);
    });
  });

  describe('deletes', () => {
    beforeEach(() => setup());
    const del = (id, extra) => h.emit('a', 'MESSAGE_DELETE', { id, channel_id: '10', ...extra });

    it('deletes the copy and forgets the mapping', async () => {
      const { msg, copyId } = await mirrored();
      await del(msg.id);
      assert.deepEqual(B.deletes, [{ hookId: B.hooks[0].id, messageId: copyId }]);
      assert.deepEqual(h.store.get('a', msg.id), []);
    });

    it('deletes every copy when mirrored to several destinations', async () => {
      await h.cleanup();
      await setup({ keys: ['a', 'b', 'c'] });
      const msg = message();
      await h.emit('a', 'MESSAGE_CREATE', msg);
      await h.emit('a', 'MESSAGE_DELETE', { id: msg.id, channel_id: '10' });
      assert.equal(h.mocks.b.deletes.length, 1);
      assert.equal(h.mocks.c.deletes.length, 1);
    });

    it('ignores deletes of messages it never mirrored', async () => {
      await del('424242');
      assert.equal(B.deletes.length, 0);
    });

    it('handles bulk deletes, skipping unmapped IDs', async () => {
      const one = await mirrored();
      const two = await mirrored();
      await h.emit('a', 'MESSAGE_DELETE_BULK', { ids: [one.msg.id, 'unmapped', two.msg.id], channel_id: '10' });
      assert.deepEqual(B.deletes.map((d) => d.messageId).sort(), [one.copyId, two.copyId].sort());
    });

    it('ignores an edit that arrives after the delete', async () => {
      const { msg } = await mirrored({ content: 'x' });
      await del(msg.id);
      await edit(msg, 'late edit');
      assert.equal(B.patches.length, 0);
    });

    it('treats a 404 on the copy as already deleted, without logging a failure', async () => {
      const { msg } = await mirrored();
      B.inject({ method: 'DELETE', path: /\/messages\//, status: 404, body: { code: 'UNKNOWN_MESSAGE' } });
      await del(msg.id);
      assert.ok(!h.logs.some((l) => l.includes('error')), `unexpected log: ${h.logs}`);
    });

    it('logs other failures and carries on', async () => {
      const first = await mirrored();
      B.inject({ method: 'DELETE', path: /\/messages\//, status: 403, body: { code: 'MISSING_PERMISSIONS' } });
      await del(first.msg.id);
      assert.ok(h.logs.some((l) => l.includes('MISSING_PERMISSIONS')));
      const second = await mirrored();
      await del(second.msg.id);
      assert.equal(B.deletes.at(-1).messageId, second.copyId);
    });
  });

  describe('out of scope', () => {
    beforeEach(() => setup());
    it('does not mirror reactions', async () => {
      await mirrored();
      const before = B.requests.length;
      await h.emit('a', 'MESSAGE_REACTION_ADD', { channel_id: '10', message_id: '1', emoji: { name: '🎉' } });
      assert.equal(B.requests.length, before);
    });
  });
});

// Spec: openspec/specs/message-relay (rich embed relay) and openspec/specs/message-sync (embed edit propagation)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

const bot = { id: '7', username: 'ci', bot: true };
const rich = (over = {}) => ({
  type: 'rich',
  title: 'Build 12',
  description: 'running',
  color: 5793266,
  fields: [{ name: 'Branch', value: 'main', inline: true }],
  provider: { name: 'ignored' },
  ...over,
});

describe('embeds', () => {
  let h, B;
  beforeEach(async () => {
    h = await createHarness({ options: { bridgeBots: true } });
    B = h.mocks.b;
  });
  afterEach(() => h.cleanup());

  it('forwards a rich embed without fields the destination cannot use', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ author: bot, content: '', embeds: [rich()] }));
    assert.deepEqual(B.posts[0].json.embeds, [
      {
        title: 'Build 12',
        description: 'running',
        color: 5793266,
        fields: [{ name: 'Branch', value: 'main', inline: true }],
      },
    ]);
  });

  it('does not forward link previews', async () => {
    const preview = { type: 'link', url: 'https://example.com', title: 'Example' };
    await h.emit('a', 'MESSAGE_CREATE', message({ content: 'see https://example.com', embeds: [preview] }));
    assert.equal(B.posts[0].json.embeds, undefined);
  });

  it('sends at most ten embeds', async () => {
    const embeds = Array.from({ length: 12 }, (_, i) => rich({ title: `e${i}` }));
    await h.emit('a', 'MESSAGE_CREATE', message({ author: bot, content: 'x', embeds }));
    assert.equal(B.posts[0].json.embeds.length, 10);
    assert.equal(B.posts[0].json.embeds[9].title, 'e9');
  });

  it('mirrors a message that has only an embed', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ author: bot, content: '', embeds: [rich()] }));
    assert.equal(B.posts.length, 1);
  });

  it('propagates a changed embed', async () => {
    const msg = message({ author: bot, content: '', embeds: [rich()] });
    await h.emit('a', 'MESSAGE_CREATE', msg);
    await h.emit('a', 'MESSAGE_UPDATE', { ...msg, embeds: [rich({ description: 'done' })] });
    assert.equal(B.patches.length, 1);
    assert.equal(B.patches[0].json.embeds[0].description, 'done');
  });

  it('ignores an update that only adds a link preview', async () => {
    const msg = message({ author: bot, content: 'see https://example.com', embeds: [rich()] });
    await h.emit('a', 'MESSAGE_CREATE', msg);
    await h.emit('a', 'MESSAGE_UPDATE', { ...msg, embeds: [rich(), { type: 'link', url: 'https://example.com' }] });
    assert.equal(B.patches.length, 0);
  });

  it('clears the embeds on the copy when the source embed is removed', async () => {
    const msg = message({ author: bot, content: 'text', embeds: [rich()] });
    await h.emit('a', 'MESSAGE_CREATE', msg);
    await h.emit('a', 'MESSAGE_UPDATE', { ...msg, embeds: [] });
    assert.deepEqual(B.patches[0].json.embeds, []);
  });

  it('does not add an embeds field to edits of human messages', async () => {
    const msg = message({ content: 'v1' });
    await h.emit('a', 'MESSAGE_CREATE', msg);
    await h.emit('a', 'MESSAGE_UPDATE', { ...msg, content: 'v2' });
    assert.equal('embeds' in B.patches[0].json, false);
  });
});

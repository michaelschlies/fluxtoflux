// Spec: openspec/specs/message-relay, plus webhook provisioning from openspec/specs/channel-linking
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

const created = (h, key = 'a') => h.emit(key, 'MESSAGE_CREATE', message({ channel_id: key === 'a' ? '10' : key === 'b' ? '20' : '30' }));

describe('relay', () => {
  let h, A, B;
  const setup = async (opts) => {
    h = await createHarness(opts);
    [A, B] = [h.mocks.a, h.mocks.b];
  };
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  describe('mirroring', () => {
    beforeEach(() => setup());

    it('posts text through the destination webhook as the author', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'hello' }));
      assert.equal(B.posts.length, 1);
      const post = B.posts[0];
      assert.equal(post.hookId, B.hooks[0].id);
      assert.equal(post.token, B.hooks[0].token);
      assert.equal(post.query.wait, 'true');
      assert.equal(post.auth, undefined);
      assert.equal(post.json.content, 'hello');
      assert.equal(post.json.username, 'alice · label-a');
      assert.equal(post.json.avatar_url, undefined);
      assert.deepEqual(post.json.allowed_mentions, { parse: [] });
    });

    it('builds the avatar URL from the source instance media endpoint', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ author: { id: '5', username: 'alice', avatar: 'abc123' } }));
      assert.equal(B.posts[0].json.avatar_url, `${A.origin}/media/avatars/5/abc123.png`);
    });

    it('relays in both directions', async () => {
      await h.emit('b', 'MESSAGE_CREATE', message({ channel_id: '20', content: 'from b' }));
      assert.equal(A.posts[0].json.content, 'from b');
      assert.equal(A.posts[0].json.username, 'alice · label-b');
      assert.equal(B.posts.length, 0);
    });

    it('prefers nickname, then global name, then username', async () => {
      const author = { id: '5', username: 'alice', global_name: 'Alice G' };
      await h.emit('a', 'MESSAGE_CREATE', message({ author, member: { nick: 'Ally' } }));
      await h.emit('a', 'MESSAGE_CREATE', message({ author }));
      await h.emit('a', 'MESSAGE_CREATE', message({ author: { id: '5', username: 'alice' } }));
      assert.deepEqual(B.posts.map((p) => p.json.username), ['Ally · label-a', 'Alice G · label-a', 'alice · label-a']);
    });

    it('limits the username to 80 characters', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ author: { id: '5', username: 'n'.repeat(200) } }));
      assert.ok(B.posts[0].json.username.length <= 80);
      assert.ok(B.posts[0].json.username.endsWith('…'));
    });

    it('passes multi-line, unicode and markdown text through unchanged', async () => {
      const content = '**bold** `code`\n日本語 🎉\n> quote';
      await h.emit('a', 'MESSAGE_CREATE', message({ content }));
      assert.equal(B.posts[0].json.content, content);
    });
  });

  describe('mention rendering', () => {
    beforeEach(() => setup());

    it('rewrites user, role and channel mentions to plain text', async () => {
      await h.emit(
        'a',
        'MESSAGE_CREATE',
        message({
          content: 'hi <@5> <@!6> <@&9> <#77> <@999> <@7>',
          mentions: [{ id: '5', username: 'alice' }, { id: '6', username: 'bob', global_name: 'Bob G' }],
          users: [{ id: '7', username: 'dave' }],
          mention_channels: [{ id: '77', name: 'general' }],
        }),
      );
      assert.equal(B.posts[0].json.content, 'hi @alice @Bob G @role #general @unknown-user @dave');
    });

    it('falls back to "#channel" for unresolved channel mentions', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'see <#42>' }));
      assert.equal(B.posts[0].json.content, 'see #channel');
    });

    it('never allows a mention to notify anyone, including @everyone', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ content: '@everyone @here' }));
      assert.deepEqual(B.posts[0].json.allowed_mentions, { parse: [] });
    });
  });

  describe('replies', () => {
    beforeEach(() => setup());
    const reply = (ref, content = 'answer') => message({ type: 19, content, referenced_message: ref });

    it('prefixes a quote line naming the replied-to author', async () => {
      await h.emit('a', 'MESSAGE_CREATE', reply({ content: 'orig', author: { username: 'carol' } }));
      assert.equal(B.posts[0].json.content, '> ↪ **carol**: orig\nanswer');
    });

    it('collapses whitespace and truncates the snippet to 80 characters', async () => {
      await h.emit('a', 'MESSAGE_CREATE', reply({ content: `line1\n\nline2   ${'z'.repeat(200)}`, author: { username: 'carol' } }));
      const quote = B.posts[0].json.content.split('\n')[0];
      assert.match(quote, /^> ↪ \*\*carol\*\*: line1 line2 z+…$/);
      assert.equal(quote.replace('> ↪ **carol**: ', '').length, 80);
    });

    it('shows (attachment) when the replied-to message had no text', async () => {
      await h.emit('a', 'MESSAGE_CREATE', reply({ content: '', author: { username: 'carol' } }));
      assert.match(B.posts[0].json.content, /^> ↪ \*\*carol\*\*: \(attachment\)\n/);
    });

    it('uses the replied-to nickname when present', async () => {
      await h.emit('a', 'MESSAGE_CREATE', reply({ content: 'x', author: { username: 'carol' }, member: { nick: 'CC' } }));
      assert.match(B.posts[0].json.content, /\*\*CC\*\*/);
    });

    it('adds no quote when the replied-to message is gone or has no author', async () => {
      await h.emit('a', 'MESSAGE_CREATE', reply(null));
      await h.emit('a', 'MESSAGE_CREATE', reply({ content: 'x' }));
      assert.deepEqual(B.posts.map((p) => p.json.content), ['answer', 'answer']);
    });
  });

  describe('length limit', () => {
    beforeEach(() => setup());

    it('truncates to exactly 4000 characters ending in an ellipsis', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'x'.repeat(5000) }));
      const sent = B.posts[0].json.content;
      assert.equal(sent.length, 4000);
      assert.ok(sent.endsWith('…'));
    });
    it('leaves a message of exactly 4000 characters alone', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'y'.repeat(4000) }));
      assert.equal(B.posts[0].json.content, 'y'.repeat(4000));
    });
  });

  describe('skipped messages', () => {
    beforeEach(() => setup());

    it('ignores system message types (join, pin, call, ...)', async () => {
      for (const type of [1, 3, 6, 7, 18, 21]) await h.emit('a', 'MESSAGE_CREATE', message({ type }));
      assert.equal(B.posts.length, 0);
    });
    it('ignores channels that are not linked', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ channel_id: '999' }));
      assert.equal(B.posts.length, 0);
    });
    it('ignores a message with no text and no attachment (e.g. sticker only)', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ content: '', stickers: [{ id: '1' }] }));
      assert.equal(B.posts.length, 0);
    });
    it('ignores messages without an author', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ author: undefined }));
      assert.equal(B.posts.length, 0);
    });
    it('does nothing for reaction events (not synchronised)', async () => {
      const before = B.requests.length;
      await h.emit('a', 'MESSAGE_REACTION_ADD', { channel_id: '10', message_id: '1', emoji: { name: '👍' } });
      assert.equal(B.requests.length, before);
    });
  });

  describe('loop prevention', () => {
    it('ignores messages sent by its own webhook (echo)', async () => {
      await setup();
      await h.emit('b', 'MESSAGE_CREATE', message({ channel_id: '20', webhook_id: B.hooks[0].id, author: { id: B.hooks[0].id, username: 'x', bot: true } }));
      assert.equal(A.posts.length, 0);
    });
    it('ignores messages from its own bot user', async () => {
      await setup();
      await h.emit('b', 'MESSAGE_CREATE', message({ channel_id: '20', author: { id: B.userId, username: 'bridge' } }));
      assert.equal(A.posts.length, 0);
    });
    it('ignores other bots and foreign webhooks by default', async () => {
      await setup();
      await h.emit('a', 'MESSAGE_CREATE', message({ author: { id: '8', username: 'otherbot', bot: true } }));
      await h.emit('a', 'MESSAGE_CREATE', message({ webhook_id: '424242', author: { id: '424242', username: 'hook' } }));
      assert.equal(B.posts.length, 0);
    });
    it('forwards other bots with bridgeBots, but still drops its own echoes', async () => {
      await setup({ options: { bridgeBots: true } });
      await h.emit('a', 'MESSAGE_CREATE', message({ author: { id: '8', username: 'otherbot', bot: true }, content: 'beep' }));
      await h.emit('a', 'MESSAGE_CREATE', message({ webhook_id: A.hooks[0].id, author: { id: A.hooks[0].id, username: 'echo', bot: true } }));
      await h.emit('a', 'MESSAGE_CREATE', message({ author: { id: A.userId, username: 'bridge', bot: true } }));
      assert.deepEqual(B.posts.map((p) => p.json.content), ['beep']);
    });
    it('does not ping-pong: a mirrored message re-delivered as an echo is dropped end to end', async () => {
      await setup();
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'once' }));
      // The destination reports the webhook message we just created; it must not bounce back.
      await h.emit('b', 'MESSAGE_CREATE', message({ id: B.posts[0].id, channel_id: '20', webhook_id: B.posts[0].hookId, author: { id: B.posts[0].hookId, username: 'alice · label-a', bot: true } }));
      assert.equal(A.posts.length, 0);
      assert.equal(B.posts.length, 1);
    });
  });

  describe('malformed events', () => {
    beforeEach(() => setup());

    it('logs a handler crash and keeps processing later events', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ mentions: 5 })); // not iterable
      await h.emit('a', 'MESSAGE_DELETE', null);
      await h.emit('a', 'MESSAGE_DELETE_BULK', {});
      assert.equal(h.logs.filter((l) => l.startsWith('bridge error:')).length, 3);
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'still alive' }));
      assert.deepEqual(B.posts.map((p) => p.json.content), ['still alive']);
    });
  });

  describe('link topology', () => {
    it('fans out to every other channel in a three-way link', async () => {
      await setup({ keys: ['a', 'b', 'c'] });
      await created(h, 'a');
      assert.equal(h.mocks.b.posts.length, 1);
      assert.equal(h.mocks.c.posts.length, 1);
      assert.equal(A.posts.length, 0);
    });
    it('honours oneWayFrom', async () => {
      await setup({ links: [{ name: 'oneway', channels: { a: '10', b: '20' }, oneWayFrom: 'a' }] });
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'fwd' }));
      await h.emit('b', 'MESSAGE_CREATE', message({ channel_id: '20', content: 'back' }));
      assert.equal(B.posts.length, 1);
      assert.equal(A.posts.length, 0);
    });
    it('keeps separate links independent', async () => {
      await setup({ links: [{ name: 'one', channels: { a: '10', b: '20' } }, { name: 'two', channels: { a: '11', b: '21' } }] });
      await h.emit('a', 'MESSAGE_CREATE', message({ channel_id: '11', content: 'to two' }));
      assert.equal(B.posts.length, 1);
      assert.equal(B.posts[0].hookId, B.hooks.find((x) => x.channel_id === '21').id);
    });
  });

  describe('ordering and failure isolation', () => {
    it('delivers to a destination in arrival order even when the first delivery is slow', async () => {
      await setup();
      B.postDelay = (i) => (i === 0 ? 80 : 0);
      for (let i = 0; i < 5; i++) h.clients.get('a').emit('MESSAGE_CREATE', message({ content: `m${i}` }));
      await h.bridge.idle();
      assert.deepEqual(B.posts.map((p) => p.json.content), ['m0', 'm1', 'm2', 'm3', 'm4']);
      assert.ok(B.posts[1].at - B.posts[0].at >= 70, 'second request waited for the first to finish');
    });
    it('does not let one broken destination stop the others', async () => {
      await setup({ keys: ['a', 'b', 'c'] });
      h.mocks.b.goneHooks.add(h.mocks.b.hooks[0].id);
      await created(h, 'a');
      assert.equal(h.mocks.c.posts.length, 1);
      assert.ok(h.logs.some((l) => l.includes('UNKNOWN_WEBHOOK')), 'failure was logged');
    });
    it('keeps delivering after a failed delivery to the same destination', async () => {
      await setup();
      B.goneHooks.add(B.hooks[0].id);
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'lost' }));
      B.goneHooks.clear();
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'delivered' }));
      assert.deepEqual(B.posts.map((p) => p.json.content), ['delivered']);
    });
    it('retries a delivery through a 429 without losing or duplicating it', async () => {
      await setup();
      B.inject({ method: 'POST', path: /\/webhooks\//, status: 429, body: { retry_after: 0.01, global: false } });
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'eventually' }));
      assert.deepEqual(B.posts.map((p) => p.json.content), ['eventually']);
    });
    it('stores the mapping only after a successful delivery', async () => {
      await setup();
      B.goneHooks.add(B.hooks[0].id);
      const msg = message();
      await h.emit('a', 'MESSAGE_CREATE', msg);
      assert.deepEqual(h.store.get('a', msg.id), []);
    });
  });

  describe('webhook provisioning', () => {
    it('creates a "Fluxer Bridge" webhook in each linked channel on first run', async () => {
      await setup();
      assert.equal(A.hooks.length, 1);
      assert.equal(A.hooks[0].name, 'Fluxer Bridge');
      assert.equal(A.hooks[0].channel_id, '10');
      assert.ok(A.hooks[0].created && B.hooks[0].created);
    });
    it('reuses an existing bridge webhook on restart', async () => {
      await setup({ prepare: (m) => m.a.addHook('10') });
      assert.equal(A.hooks.length, 1);
      assert.ok(!A.hooks[0].created);
      assert.ok(!A.requests.some((r) => r.method === 'POST' && r.path.endsWith('/webhooks')));
    });
    it('ignores webhooks with other names and creates its own', async () => {
      await setup({ prepare: (m) => m.a.addHook('10', 'Some Other Hook') });
      assert.equal(A.hooks.length, 2);
      assert.ok(h.bridge.hooks.get('a:10').id !== A.hooks[0].id);
    });
    it('uses a configured webhook URL without calling the webhook endpoints', async () => {
      await setup({ links: [{ name: 'x', channels: { a: '10', b: '20' }, webhooks: { b: 'http://127.0.0.1:1/v1/webhooks/777/secrettoken' } }] });
      assert.ok(!B.requests.some((r) => r.path.endsWith('/webhooks')));
      B.addHook('20'); // unrelated; must not be picked up
      await h.emit('a', 'MESSAGE_CREATE', message());
      assert.equal(B.posts[0].hookId, '777');
      assert.equal(B.posts[0].token, 'secrettoken');
    });
    it('treats a configured webhook as one of its own (no echo loop)', async () => {
      await setup({ links: [{ name: 'x', channels: { a: '10', b: '20' }, webhooks: { b: 'http://127.0.0.1:1/v1/webhooks/777/secrettoken' } }] });
      await h.emit('b', 'MESSAGE_CREATE', message({ channel_id: '20', webhook_id: '777', author: { id: '777', username: 'w', bot: true } }));
      assert.equal(A.posts.length, 0);
    });
    it('aborts when the bot may not create webhooks', async () => {
      await assert.rejects(setup({ prepare: (m) => (m.b.denyWebhookCreate = true) }), /403/);
    });
  });
});

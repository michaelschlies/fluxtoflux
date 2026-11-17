// Spec: openspec/specs/message-relay (sticker rendering)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

const sticker = (over = {}) => ({ id: '5', name: 'wave', animated: false, ...over });

describe('stickers', () => {
  let h, A, B;
  beforeEach(async () => {
    h = await createHarness();
    [A, B] = [h.mocks.a, h.mocks.b];
    A.files.set('sticker-5', Buffer.from('webp-bytes'));
    A.files.set('sticker-6', Buffer.from('gif-bytes'));
  });
  afterEach(() => h.cleanup());

  it('uploads the sticker image next to the text', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ content: 'look', stickers: [sticker()] }));
    const post = B.posts[0];
    assert.equal(post.multipart, true);
    assert.equal(post.json.content, 'look');
    assert.equal(post.files[0].filename, 'wave.webp');
    assert.equal(post.files[0].bytes.toString(), 'webp-bytes');
  });

  it('mirrors a message that has only a sticker', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ content: '', stickers: [sticker()] }));
    assert.equal(B.posts.length, 1);
    assert.equal(B.posts[0].files.length, 1);
  });

  it('asks for the animated GIF of an animated sticker', async () => {
    await h.emit(
      'a',
      'MESSAGE_CREATE',
      message({ content: '', stickers: [sticker({ id: '6', name: 'dance', animated: true })] }),
    );
    const req = A.requests.find((r) => r.path === '/media/stickers/6.gif');
    assert.equal(req.query.animated, 'true');
    assert.equal(B.posts[0].files[0].filename, 'dance.gif');
  });

  it('falls back to [sticker: name] when the image cannot be downloaded', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ content: 'hi', stickers: [sticker({ id: '404', name: 'gone' })] }));
    assert.equal(B.posts[0].json.content, 'hi\n[sticker: gone]');
    assert.equal(B.posts[0].multipart, undefined);
  });

  it('delivers a sticker-only message as text when the download fails', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ content: '', stickers: [sticker({ id: '404', name: 'gone' })] }));
    assert.equal(B.posts[0].json.content, '[sticker: gone]');
  });

  it('falls back to text when the sticker exceeds maxAttachmentBytes', async () => {
    A.files.set('sticker-7', Buffer.alloc(2048));
    await h.emit('a', 'MESSAGE_CREATE', message({ content: '', stickers: [sticker({ id: '7', name: 'huge' })] }));
    assert.equal(B.posts[0].json.content, '[sticker: huge]');
  });

  it('does not touch the sticker when the text is edited', async () => {
    const msg = message({ content: 'v1', stickers: [sticker()] });
    await h.emit('a', 'MESSAGE_CREATE', msg);
    await h.emit('a', 'MESSAGE_UPDATE', { ...msg, content: 'v2' });
    assert.deepEqual(Object.keys(B.patches[0].json).sort(), ['allowed_mentions', 'content']);
  });
});

// Spec: openspec/specs/attachments
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, message } from './helpers/util.js';

describe('attachments', () => {
  let h, A, B;
  beforeEach(async () => {
    h = await createHarness({ options: { maxAttachmentBytes: 1024 } });
    [A, B] = [h.mocks.a, h.mocks.b];
  });
  afterEach(() => h.cleanup());

  /** Register a file on instance A and return the attachment object Fluxer would send. */
  const file = (name, bytes, extra = {}) => {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    A.files.set(name, data);
    return { id: `att-${name}`, filename: name, size: data.length, content_type: 'application/octet-stream', url: A.fileUrl(name), ...extra };
  };

  it('re-uploads a file as multipart with its text and metadata', async () => {
    const att = file('pic.png', 'PNGDATA', { content_type: 'image/png', description: 'a picture' });
    await h.emit('a', 'MESSAGE_CREATE', message({ content: 'look', attachments: [att] }));
    const post = B.posts[0];
    assert.equal(post.multipart, true);
    assert.equal(post.json.content, 'look');
    assert.deepEqual(post.json.attachments, [{ id: 0, filename: 'pic.png', description: 'a picture' }]);
    assert.equal(post.files.length, 1);
    assert.equal(post.files[0].field, 'files[0]');
    assert.equal(post.files[0].filename, 'pic.png');
    assert.equal(post.files[0].bytes.toString(), 'PNGDATA');
    assert.equal(post.auth, undefined);
  });

  it('keeps binary content byte-for-byte', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 128, 10, 13, 0]);
    await h.emit('a', 'MESSAGE_CREATE', message({ attachments: [file('bin.dat', bytes)] }));
    assert.ok(B.posts[0].files[0].bytes.equals(bytes));
  });

  it('mirrors an attachment-only message', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ content: '', attachments: [file('a.txt', 'hi')] }));
    assert.equal(B.posts.length, 1);
    assert.equal(B.posts[0].files[0].filename, 'a.txt');
  });

  it('indexes several attachments 0..n-1 in order', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ attachments: [file('one.txt', '1'), file('two.txt', '2'), file('three.txt', '3')] }));
    const post = B.posts[0];
    assert.deepEqual(post.json.attachments.map((a) => [a.id, a.filename]), [[0, 'one.txt'], [1, 'two.txt'], [2, 'three.txt']]);
    assert.deepEqual(post.files.map((f) => [f.field, f.bytes.toString()]), [['files[0]', '1'], ['files[1]', '2'], ['files[2]', '3']]);
  });

  it('uploads a file exactly at the size cap', async () => {
    await h.emit('a', 'MESSAGE_CREATE', message({ attachments: [file('edge.bin', Buffer.alloc(1024, 1))] }));
    assert.equal(B.posts[0].files[0].bytes.length, 1024);
  });

  describe('size cap', () => {
    it('links to an oversized file instead of downloading it', async () => {
      const big = file('big.bin', Buffer.alloc(2000), { size: 2000 });
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'huge', attachments: [big] }));
      assert.ok(!A.requests.some((r) => r.path.startsWith('/files/')), 'no download attempted');
      assert.equal(B.posts[0].multipart, undefined);
      assert.equal(B.posts[0].json.content, `huge\n${big.url}`);
    });
    it('uploads the small file and links the large one in the same message', async () => {
      const big = file('big.bin', Buffer.alloc(2000), { size: 2000 });
      await h.emit('a', 'MESSAGE_CREATE', message({ content: '', attachments: [file('ok.txt', 'ok'), big] }));
      assert.deepEqual(B.posts[0].files.map((f) => f.filename), ['ok.txt']);
      assert.equal(B.posts[0].json.content, big.url, 'no leading newline when there was no text');
    });
  });

  describe('failures', () => {
    it('falls back to a link when a download fails, still uploading the others', async () => {
      const gone = { id: 'x', filename: 'gone.png', size: 10, url: A.fileUrl('gone.png') }; // 404 on the mock
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'two files', attachments: [gone, file('ok.txt', 'ok')] }));
      const post = B.posts[0];
      assert.equal(post.json.content, `two files\n${gone.url}`);
      assert.deepEqual(post.files.map((f) => f.filename), ['ok.txt']);
      assert.deepEqual(post.json.attachments, [{ id: 0, filename: 'ok.txt' }], 'index 0 refers to the file actually sent');
      assert.ok(h.logs.some((l) => l.includes('gone.png download failed')));
    });
    it('sends plain JSON when every download fails', async () => {
      const gone = { id: 'x', filename: 'gone.png', size: 10, url: A.fileUrl('gone.png') };
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'oops', attachments: [gone] }));
      assert.equal(B.posts[0].multipart, undefined);
      assert.equal(B.posts[0].json.content, `oops\n${gone.url}`);
    });
    it('skips an expired attachment (null url) without failing the message', async () => {
      const expired = { id: 'x', filename: 'old.png', size: 10, url: null, expired: true };
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'text stays', attachments: [expired] }));
      assert.equal(B.posts[0].json.content, 'text stays');
    });
    it('drops a message whose only attachment is expired', async () => {
      await h.emit('a', 'MESSAGE_CREATE', message({ content: '', attachments: [{ id: 'x', filename: 'old.png', size: 10, url: null }] }));
      assert.equal(B.posts.length, 0);
    });
    it('does not break the channel when the source file host is down', async () => {
      const unreachable = { id: 'x', filename: 'a.png', size: 5, url: 'http://127.0.0.1:1/a.png' };
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'first', attachments: [unreachable] }));
      await h.emit('a', 'MESSAGE_CREATE', message({ content: 'second' }));
      assert.deepEqual(B.posts.map((p) => p.json.content), [`first\n${unreachable.url}`, 'second']);
    });
  });
});

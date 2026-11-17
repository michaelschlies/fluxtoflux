// Spec: openspec/specs/message-sync (mirror mapping)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { tmpDir } from './helpers/util.js';

describe('Store', () => {
  let tmp, store;
  beforeEach(() => {
    tmp = tmpDir();
    store = new Store(tmp.dir);
  });
  afterEach(() => {
    store.db.close();
    tmp.remove();
  });

  it('returns nothing for an unknown message', () => {
    assert.deepEqual(store.get('a', '1'), []);
  });

  it('stores and returns one mirror per destination', () => {
    store.add('a', '1', 'b', '20', '900', 'h');
    store.add('a', '1', 'c', '30', '901', 'h');
    const rows = store.get('a', '1');
    assert.deepEqual(
      rows.map((r) => [r.dst_inst, r.dst_chan, r.dst_msg]).sort(),
      [['b', '20', '900'], ['c', '30', '901']],
    );
  });

  it('keeps instances apart even when message IDs collide', () => {
    store.add('a', '1', 'b', '20', '900', 'h');
    assert.deepEqual(store.get('b', '1'), []);
  });

  it('replaces a record for the same source and destination', () => {
    store.add('a', '1', 'b', '20', '900', 'old');
    store.add('a', '1', 'b', '20', '901', 'new');
    const rows = store.get('a', '1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dst_msg, '901');
  });

  it('updates only the hash of the given destination', () => {
    store.add('a', '1', 'b', '20', '900', 'h1');
    store.add('a', '1', 'c', '30', '901', 'h1');
    store.updateHash('a', '1', 'b', 'h2');
    const byDst = Object.fromEntries(store.get('a', '1').map((r) => [r.dst_inst, r.hash]));
    assert.deepEqual(byDst, { b: 'h2', c: 'h1' });
  });

  it('deletes every mirror of a source message', () => {
    store.add('a', '1', 'b', '20', '900', 'h');
    store.add('a', '1', 'c', '30', '901', 'h');
    store.add('a', '2', 'b', '20', '902', 'h');
    store.delete('a', '1');
    assert.deepEqual(store.get('a', '1'), []);
    assert.equal(store.get('a', '2').length, 1);
  });

  it('keeps snowflake IDs intact as strings', () => {
    const id = '1234567890123456789';
    store.add('a', id, 'b', '20', id, 'h');
    assert.equal(store.get('a', id)[0].dst_msg, id);
  });

  it('survives a restart', () => {
    store.add('a', '1', 'b', '20', '900', 'h');
    store.db.close();
    store = new Store(tmp.dir);
    assert.equal(store.get('a', '1')[0].dst_msg, '900');
  });

  it('purges records older than 90 days when opened, and keeps recent ones', () => {
    store.add('a', 'recent', 'b', '20', '1', 'h');
    store.db.close();
    const raw = new DatabaseSync(join(tmp.dir, 'bridge.sqlite'));
    const day = 86_400_000;
    raw.prepare('INSERT INTO mirrors VALUES (?,?,?,?,?,?,?)').run('a', 'old', 'b', '20', '2', 'h', Date.now() - 100 * day);
    raw.prepare('INSERT INTO mirrors VALUES (?,?,?,?,?,?,?)').run('a', 'edge', 'b', '20', '3', 'h', Date.now() - 89 * day);
    raw.close();
    store = new Store(tmp.dir);
    assert.deepEqual(store.get('a', 'old'), []);
    assert.equal(store.get('a', 'edge').length, 1);
    assert.equal(store.get('a', 'recent').length, 1);
  });

  it('creates the data directory when it does not exist', () => {
    const nested = join(tmp.dir, 'deep', 'er');
    const s = new Store(nested);
    s.add('a', '1', 'b', '2', '3', 'h');
    assert.equal(s.get('a', '1').length, 1);
    s.db.close();
  });
});

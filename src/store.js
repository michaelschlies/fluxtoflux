import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Maps a source message to its mirrored copies so edits and deletes can follow. */
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'bridge.sqlite'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mirrors (
        src_inst TEXT NOT NULL,
        src_msg  TEXT NOT NULL,
        dst_inst TEXT NOT NULL,
        dst_chan TEXT NOT NULL,
        dst_msg  TEXT NOT NULL,
        hash     TEXT NOT NULL,
        created  INTEGER NOT NULL,
        PRIMARY KEY (src_inst, src_msg, dst_inst)
      );
      CREATE INDEX IF NOT EXISTS mirrors_created ON mirrors (created);
      -- Paired threads: every row sharing a grp is the same thread on a different instance.
      CREATE TABLE IF NOT EXISTS threads (
        grp    TEXT NOT NULL,
        inst   TEXT NOT NULL,
        thread TEXT NOT NULL,
        chan   TEXT NOT NULL,
        PRIMARY KEY (inst, thread)
      );
      -- Last source message delivered from a channel, so a restart can catch up on what it missed.
      CREATE TABLE IF NOT EXISTS watermarks (
        inst     TEXT NOT NULL,
        chan     TEXT NOT NULL,
        last_msg TEXT NOT NULL,
        PRIMARY KEY (inst, chan)
      );
    `);
    // Columns added after the first release: src_chan (channel or thread the source message was in)
    // and dst_thread (thread the copy was posted in).
    const cols = this.db
      .prepare('PRAGMA table_info(mirrors)')
      .all()
      .map((c) => c.name);
    for (const col of ['src_chan', 'dst_thread']) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE mirrors ADD COLUMN ${col} TEXT`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS mirrors_copy ON mirrors (dst_inst, dst_msg)');
    this.insert = this.db.prepare(
      `INSERT OR REPLACE INTO mirrors (src_inst, src_msg, dst_inst, dst_chan, dst_msg, hash, created, src_chan, dst_thread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.find = this.db.prepare('SELECT * FROM mirrors WHERE src_inst = ? AND src_msg = ?');
    this.findCopy = this.db.prepare('SELECT * FROM mirrors WHERE dst_inst = ? AND dst_msg = ?');
    this.insertThread = this.db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?)');
    this.findGroup = this.db.prepare(
      'SELECT t2.* FROM threads t1 JOIN threads t2 ON t1.grp = t2.grp WHERE t1.inst = ? AND t1.thread = ?',
    );
    this.removeGroup = this.db.prepare(
      'DELETE FROM threads WHERE grp IN (SELECT grp FROM threads WHERE inst = ? AND thread = ?)',
    );
    this.findMark = this.db.prepare('SELECT last_msg FROM watermarks WHERE inst = ? AND chan = ?');
    this.setMark = this.db.prepare('INSERT OR REPLACE INTO watermarks VALUES (?, ?, ?)');
    this.setHash = this.db.prepare('UPDATE mirrors SET hash = ? WHERE src_inst = ? AND src_msg = ? AND dst_inst = ?');
    this.remove = this.db.prepare('DELETE FROM mirrors WHERE src_inst = ? AND src_msg = ?');
    // Keep 90 days of mappings; older messages are rarely edited or deleted.
    this.db.prepare('DELETE FROM mirrors WHERE created < ?').run(Date.now() - 90 * 86_400_000);
  }

  add(srcInst, srcMsg, dstInst, dstChan, dstMsg, hash, srcChan = null, dstThread = null) {
    this.insert.run(srcInst, srcMsg, dstInst, dstChan, dstMsg, hash, Date.now(), srcChan, dstThread);
  }
  get(srcInst, srcMsg) {
    return this.find.all(srcInst, srcMsg);
  }
  /** The mirror record whose copy is this message, for events that happen on the destination side. */
  getByCopy(dstInst, dstMsg) {
    return this.findCopy.all(dstInst, dstMsg);
  }
  addThread(grp, inst, thread, chan) {
    this.insertThread.run(grp, inst, thread, chan);
  }
  /** Every member of the pairing the thread belongs to, itself included. */
  threadGroup(inst, thread) {
    return this.findGroup.all(inst, thread);
  }
  removeThread(inst, thread) {
    this.removeGroup.run(inst, thread);
  }
  watermark(inst, chan) {
    return this.findMark.get(inst, chan)?.last_msg ?? null;
  }
  setWatermark(inst, chan, msg) {
    this.setMark.run(inst, chan, msg);
  }
  updateHash(srcInst, srcMsg, dstInst, hash) {
    this.setHash.run(hash, srcInst, srcMsg, dstInst);
  }
  delete(srcInst, srcMsg) {
    this.remove.run(srcInst, srcMsg);
  }
}

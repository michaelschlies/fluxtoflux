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
    `);
    this.insert = this.db.prepare(
      'INSERT OR REPLACE INTO mirrors VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.find = this.db.prepare('SELECT * FROM mirrors WHERE src_inst = ? AND src_msg = ?');
    this.setHash = this.db.prepare(
      'UPDATE mirrors SET hash = ? WHERE src_inst = ? AND src_msg = ? AND dst_inst = ?',
    );
    this.remove = this.db.prepare('DELETE FROM mirrors WHERE src_inst = ? AND src_msg = ?');
    // Keep 90 days of mappings; older messages are rarely edited or deleted.
    this.db.prepare('DELETE FROM mirrors WHERE created < ?').run(Date.now() - 90 * 86_400_000);
  }

  add(srcInst, srcMsg, dstInst, dstChan, dstMsg, hash) {
    this.insert.run(srcInst, srcMsg, dstInst, dstChan, dstMsg, hash, Date.now());
  }
  get(srcInst, srcMsg) {
    return this.find.all(srcInst, srcMsg);
  }
  updateHash(srcInst, srcMsg, dstInst, hash) {
    this.setHash.run(hash, srcInst, srcMsg, dstInst);
  }
  delete(srcInst, srcMsg) {
    this.remove.run(srcInst, srcMsg);
  }
}

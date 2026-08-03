import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('watch history', () => {
  let dataDir: string;
  let mediaDir: string;
  let db: typeof import('../src/db');

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-history-test-'));
    process.env.DATA_DIR = dataDir;
    db = await import('../src/db');
    const { config } = await import('../src/config');
    mediaDir = path.join(config.mediaDir, 'library');
    fs.mkdirSync(mediaDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('detects an orphaned .hls dir with no matching .mp4 as watched history', () => {
    fs.mkdirSync(path.join(mediaDir, 'The.Avengers.2012.hls'));
    fs.writeFileSync(path.join(mediaDir, 'Iron.Man.2008.mp4'), 'x');
    fs.mkdirSync(path.join(mediaDir, 'Iron.Man.2008.hls'));

    const found = db.scanForOrphanedHlsEntries();
    assert.deepEqual(found.map(f => f.title), ['The.Avengers.2012']);
  });

  it('records and lists watch history entries without duplicating on re-scan', () => {
    const found = db.scanForOrphanedHlsEntries();
    db.recordWatchHistoryEntries(found);
    db.recordWatchHistoryEntries(found); // re-scan should not duplicate
    const history = db.listWatchHistory();
    assert.equal(history.filter(h => h.title === 'The.Avengers.2012').length, 1);
  });

  it('dismissing an entry removes it from the active list', () => {
    const history = db.listWatchHistory();
    const entry = history.find(h => h.title === 'The.Avengers.2012')!;
    db.dismissWatchHistoryEntry(entry.id);
    const after = db.listWatchHistory();
    assert.ok(!after.some(h => h.id === entry.id));
  });
});

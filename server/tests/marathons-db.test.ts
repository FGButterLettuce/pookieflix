import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('marathon data access', () => {
  let dataDir: string;
  let db: typeof import('../src/db');

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookieflix-marathon-db-test-'));
    process.env.DATA_DIR = dataDir;
    db = await import('../src/db');
  });

  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a marathon with position 0', () => {
    const m = db.createMarathon('Avengers Marathon');
    assert.equal(m.name, 'Avengers Marathon');
    assert.equal(m.position, 0);
  });

  it('lists marathons with item/done counts', () => {
    const m = db.createMarathon('Test Marathon');
    const item = db.addMarathonItem(m.id, 'Iron Man', null);
    db.updateMarathonItem(item.id, { status: 'done' });
    const list = db.listMarathons();
    const found = list.find(x => x.id === m.id)!;
    assert.equal(found.itemCount, 1);
    assert.equal(found.doneCount, 1);
  });

  it('orders items by position and supports moving them', () => {
    const m = db.createMarathon('Order Test');
    const a = db.addMarathonItem(m.id, 'A', null);
    const b = db.addMarathonItem(m.id, 'B', null);
    db.moveMarathonItem(m.id, b.id, 'up');
    const items = db.listMarathonItems(m.id);
    assert.deepEqual(items.map(i => i.title), ['B', 'A']);
    void a;
  });

  it('upserts a review independently per viewer', () => {
    const m = db.createMarathon('Review Test');
    const item = db.addMarathonItem(m.id, 'Thor', null);
    db.upsertMarathonReview(item.id, 'user', 9, 'great');
    db.upsertMarathonReview(item.id, 'partner', 6, null);
    db.upsertMarathonReview(item.id, 'user', 10, 'even better');
    const items = db.listMarathonItems(m.id);
    const reviews = items[0].reviews;
    assert.equal(reviews.length, 2);
    assert.deepEqual(reviews.find(r => r.viewer === 'user'), { viewer: 'user', score: 10, note: 'even better' });
    assert.deepEqual(reviews.find(r => r.viewer === 'partner'), { viewer: 'partner', score: 6, note: null });
  });

  it('deleting a marathon cascades to its items and reviews', () => {
    const m = db.createMarathon('Cascade Test');
    const item = db.addMarathonItem(m.id, 'Doomed', null);
    db.upsertMarathonReview(item.id, 'user', 5, null);
    db.deleteMarathon(m.id);
    assert.equal(db.getMarathon(m.id), undefined);
    assert.equal(db.getMarathonItem(item.id), undefined);
  });
});

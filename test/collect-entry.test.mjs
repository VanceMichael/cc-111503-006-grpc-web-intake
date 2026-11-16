import test from 'node:test';
import assert from 'node:assert/strict';
import { votableFixture, votableDocument } from '../src/votable-source.mjs';
import { collect } from '../src/votable-collect.mjs';
import { previewTable } from '../src/votable-preview.mjs';
import { Inbox } from '../src/store.mjs';
import { serve } from '../src/http.mjs';

async function withSource(scenario, check) {
  const source = await votableFixture(scenario);
  const store = new Inbox();
  try {
    await check(source, store);
  } finally {
    store.close();
    await source.close();
  }
}

test('collect reads the source once and retains the untouched original', async () => {
  await withSource('normal', async (source, store) => {
    const result = await collect(source, store);
    assert.equal(result.mode, 'votable-collection');
    assert.deepEqual(source.requests, ['/catalogue']);
    const evidence = store.evidence();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].kind, 'votable');
    assert.equal(evidence[0].metadata.deliveryId, 'catalogue-2026A');
    // The retained bytes are the original document, not a decoded rebuild.
    const original = Buffer.from(votableDocument('normal'));
    assert.equal(evidence[0].size, original.length);
    assert.equal(result.evidence, evidence[0].id);
  });
});

test('the old descriptor preview still works and does not claim decoding', async () => {
  await withSource('normal', async (source, store) => {
    const preview = await previewTable(source, store);
    assert.equal(preview.mode, 'votable-descriptor-preview');
    assert.equal(preview.tables.length, 2);
    assert.deepEqual(Object.keys(preview).sort(), ['evidence', 'mode', 'tables']);
    // Preview and collect can share one Inbox: evidence is idempotent.
    const collected = await collect(source, store);
    assert.equal(collected.tables.length, 2);
    assert.equal(store.evidence().length, 1);
  });
});

test('a non-OK HTTP response fails clearly without a partial delivery', async () => {
  const source = await serve((request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('unavailable');
  });
  const store = new Inbox();
  try {
    await assert.rejects(() => collect({ ...source, path: '/catalogue' }, store), /HTTP 503/);
    assert.equal(store.evidence().length, 0);
  } finally {
    store.close();
    await source.close();
  }
});

test('non-UTF-8 originals are retained and reported rather than half-decoded', async () => {
  const source = await serve((request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-votable+xml' });
    response.end(Buffer.from([0x3c, 0x56, 0xff, 0xfe]));
  });
  const store = new Inbox();
  try {
    const result = await collect({ ...source, path: '/x', deliveryId: 'bad-encoding' }, store);
    assert.equal(result.evidence.length > 0, true);
    assert.equal(result.tables.length, 0);
    assert.match(result.pending[0].reason, /UTF-8/);
    assert.equal(store.evidence().length, 1);
  } finally {
    store.close();
    await source.close();
  }
});

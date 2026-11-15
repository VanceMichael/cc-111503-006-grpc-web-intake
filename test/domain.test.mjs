import test from 'node:test';
import assert from 'node:assert/strict';
import { frame, splitComplete } from '../src/frames.mjs';
import { fixture } from '../src/gateway.mjs';
import { preview } from '../src/preview.mjs';
import { Inbox } from '../src/store.mjs';

test('complete-frame splitter does not accept truncated payloads', () => {
  const bytes = frame(0, Buffer.from('payload')); assert.equal(splitComplete(bytes).length, 1);
  assert.throws(() => splitComplete(bytes.subarray(0, -1)), /incomplete/);
});
test('gateway returns HTTP 200 even when RPC trailer is an error', async () => {
  const source = await fixture('failure'); const store = new Inbox();
  try {
    const result = await preview(source, store); assert.equal(result.frames.at(-1).flag, 128);
    assert.equal(result.frames.length, 3); assert.equal(store.evidence().length, 1);
  } finally { store.close(); await source.close(); }
});

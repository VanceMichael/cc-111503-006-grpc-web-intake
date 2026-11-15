import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../src/gateway.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await fixture(scenario); const store = new Inbox();
  try {
    const result = await intake.collect(source, store);
    await check(result, source, store);
  } finally { store.close(); await source.close(); }
}

for (const scenario of ['normal', 'text']) {
  test(scenario + ' publishes only after the successful terminal RPC status', async () => {
    await run(scenario, async result => {
      assert.equal(result.status, 'complete'); assert.equal(result.records.length, 2);
      assert.equal(result.records[1].result, '需复核'); assert.ok(result.attemptId);
    });
  });
}
for (const scenario of ['failure', 'no-trailer', 'after-trailer']) {
  test(scenario + ' is not a complete successful retrieval', async () => {
    await run(scenario, async result => { assert.notEqual(result.status, 'complete'); assert.equal(result.records.length, 0); });
  });
}

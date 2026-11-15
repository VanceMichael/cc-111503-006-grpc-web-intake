import test from 'node:test';
import assert from 'node:assert/strict';
import { senmlFixture } from '../src/senml-source.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, representation, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await senmlFixture(scenario, representation);
  const store = new Inbox();
  try { await check(await intake.collect(source, store), source, store); }
  finally { store.close(); await source.close(); }
}

for (const representation of ['json', 'cbor']) {
  test(`按包恢复基准、类型和相对时间：${representation}`, async () => {
    await run('normal', representation, async (result, source, store) => {
      assert.equal(result.records.length, 6);
      const temperature = result.records.find(record => record.name === 'urn:station:A:temperature');
      assert.equal(temperature.valueType, 'number');
      assert.equal(temperature.value, 11.5);
      assert.equal(temperature.unit, 'Cel');
      assert.deepEqual(temperature.time, { kind: 'absolute', seconds: 1699999998 });
      const alarm = result.records.find(record => record.name === 'urn:station:A:alarm');
      assert.equal(alarm.valueType, 'boolean');
      assert.equal(alarm.value, true);
      assert.equal(alarm.unit, '/');
      const voltage = result.records.find(record => record.name === 'urn:station:B:voltage');
      assert.equal(voltage.value, 3);
      const relative = result.records.find(record => record.name === 'urn:station:C:temperature');
      assert.equal(relative.value, 8);
      assert.deepEqual(relative.time, { kind: 'relative', seconds: -5 });
      const bytes = result.records.find(record => record.name === 'urn:station:C:payload');
      assert.equal(bytes.valueType, 'bytes');
      assert.deepEqual(bytes.value, [0, 255, 17]);
      assert.ok(result.records.every(record => record.evidence && Number.isInteger(record.recordIndex) && record.packId));
      assert.deepEqual(new Set(source.requests), new Set(['/pack/one', '/pack/two']));
      assert.equal(store.evidence().length, 2);
    });
  });
}

for (const scenario of ['required-extension', 'conflicting-values', 'unsupported-version', 'truncated']) {
  test(`问题包不污染另一包且保留不完整边界：${scenario}`, async () => {
    await run(scenario, 'cbor', async (result, source, store) => {
      assert.equal(result.records.some(record => record.packId === 'one'), false);
      assert.equal(result.records.filter(record => record.packId === 'two').length, 3);
      assert.ok(result.pending.some(item => item.packId === 'one' && item.reason));
      assert.equal(store.evidence().length, 2);
      assert.equal(source.requests.length, 2);
    });
  });
}

test('未知可选字段不吞掉合法读数', async () => {
  await run('unknown-optional', 'json', async result => {
    assert.equal(result.records.length, 6);
    assert.equal(result.pending.length, 0);
  });
});

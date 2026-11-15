import test from 'node:test';
import assert from 'node:assert/strict';
import { votableFixture } from '../src/votable-source.mjs';
import * as intake from '../src/intake.mjs';
import { Inbox } from '../src/store.mjs';

async function run(scenario, check) {
  assert.equal(typeof intake.collect, 'function', 'collection entry is not available yet');
  const source = await votableFixture(scenario);
  const store = new Inbox();
  try { await check(await intake.collect(source, store), source, store); }
  finally { store.close(); await source.close(); }
}

test('BINARY2空值、空数组及64位身份保持区别，表和字段作用域不串用', async () => {
  await run('normal', async (result, source, store) => {
    const primary = result.tables.find(table => table.tableId === 'primary');
    const matches = result.tables.find(table => table.tableId === 'matches');
    assert.equal(primary.rows.length, 3);
    assert.equal(primary.rows[0].cells['target-id'].value, '9007199254740993');
    assert.equal(primary.rows[0].cells.samples.isNull, true);
    assert.deepEqual(primary.rows[1].cells.samples.value, []);
    assert.equal(primary.rows[1].cells.samples.isNull, false);
    assert.deepEqual(primary.rows[2].cells.samples.value, [0, -2]);
    assert.equal(matches.rows[0].cells.separation.value, 0);
    assert.equal(primary.context.release, '2026A');
    assert.equal(matches.context.release, '2026B');
    assert.deepEqual(primary.groups[0].fieldRefs, ['samples']);
    assert.ok(primary.rows.every(row => row.evidence && row.cells.samples.byteRange.length === 2));
    assert.equal(store.evidence().length, 1);
    assert.deepEqual(source.requests, ['/catalogue']);
  });
});

for (const scenario of ['truncated', 'bad-count', 'missing-reference']) {
  test(`隔离无法解释的表而保留独立表：${scenario}`, async () => {
    await run(scenario, async result => {
      assert.equal(result.tables.some(table => table.tableId === 'primary'), false);
      assert.equal(result.tables.find(table => table.tableId === 'matches').rows.length, 1);
      assert.ok(result.pending.some(item => item.tableId === 'primary' && item.reason));
    });
  });
}

test('TABLEDATA按同一字段描述解释长整数，不以显示名称作键', async () => {
  await run('tabledata', async result => {
    const primary = result.tables.find(table => table.tableId === 'primary');
    assert.equal(primary.rows[0].cells['target-id'].value, '9007199254740993');
    assert.deepEqual(primary.rows[2].cells.samples.value, [0, -2]);
    assert.equal(primary.fields.filter(field => field.name === 'value').length, 2);
  });
});

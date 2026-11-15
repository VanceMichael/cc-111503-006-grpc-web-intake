import test from 'node:test';
import assert from 'node:assert/strict';
import { binaryRow, votableDocument, votableFixture } from '../src/votable-source.mjs';
import { describeTables, previewTable } from '../src/votable-preview.mjs';
import { Inbox } from '../src/store.mjs';

test('BINARY2来源的空值标记不删除实际数组字节', () => {
  const row = binaryRow('9007199254740993', [4, 5], true);
  assert.equal(row[0], 64);
  assert.equal(row.readBigInt64BE(1).toString(), '9007199254740993');
  assert.equal(row.readInt32BE(9), 2);
  assert.equal(row.length, 21);
});

test('字段描述预览不因同名表或同名列而覆盖', () => {
  const tables = describeTables(Buffer.from(votableDocument()));
  assert.equal(tables.length, 2);
  assert.equal(tables[0].name, tables[1].name);
  assert.deepEqual(tables[0].fields.map(field => field.ID), ['target-id', 'samples']);
  assert.equal(tables[0].fields[0].name, tables[0].fields[1].name);
  assert.throws(() => describeTables(Buffer.from('<VOTABLE><TABLE></VOTABLE>')));
});

test('本地HTTP预览留存实际原件而不声称已经解码单元格', async () => {
  const source = await votableFixture();
  const store = new Inbox();
  try {
    const result = await previewTable(source, store);
    assert.equal(result.mode, 'votable-descriptor-preview');
    assert.equal(result.tables.length, 2);
    assert.deepEqual(source.requests, ['/catalogue']);
    assert.equal(store.evidence().length, 1);
  } finally { store.close(); await source.close(); }
});

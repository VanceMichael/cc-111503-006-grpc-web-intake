import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DecodeIssue, decodeBinaryRows, decodeTextCell, prepareField,
} from '../src/votable-decode.mjs';

const meta = (field) => prepareField(field);

function binaryField(datatype, arraysize) {
  return meta({ fieldId: 'x', datatype, arraysize });
}

test('BINARY2 null bit consumes the full physical width for every datatype', () => {
  // long + variable int array + double, all null, followed by a real value.
  const metas = [
    meta({ fieldId: 'a', datatype: 'long' }),
    meta({ fieldId: 'b', datatype: 'int', arraysize: '*' }),
    meta({ fieldId: 'c', datatype: 'double' }),
    meta({ fieldId: 'd', datatype: 'int' }),
  ];
  const payload = Buffer.alloc(1 + 8 + 4 + 8 + 4);
  payload[0] = 0b11100000;
  payload.writeInt32BE(1234, 1 + 8 + 4 + 8);
  const rows = decodeBinaryRows(metas, payload, { kind: 'stream' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].cells.a.byteRange, [1, 9]);
  assert.deepEqual(rows[0].cells.b.byteRange, [9, 13]);
  assert.equal(rows[0].cells.d.isNull, false);
  assert.equal(rows[0].cells.d.value, 1234);
  for (const name of ['a', 'b', 'c']) assert.equal(rows[0].cells[name].isNull, true);
  assert.deepEqual(rows[0].evidence.rowByteRange, [0, payload.length]);
});

test('BINARY2 null bitmap spans bytes when a table has more than eight fields', () => {
  const metas = Array.from({ length: 9 }, (_, index) => prepareField({
    fieldId: `f${index}`, datatype: 'int',
  }));
  const payload = Buffer.alloc(2 + 9 * 4);
  payload[0] = 0b10000000; // f0 null, highest bit first
  payload[1] = 0b10000000; // f8 null
  for (let index = 0; index < 9; index += 1) payload.writeInt32BE(index + 1, 2 + index * 4);
  const [row] = decodeBinaryRows(metas, payload, { kind: 'stream' });
  assert.equal(row.cells.f0.isNull, true);
  assert.equal(row.cells.f1.value, 2);
  assert.equal(row.cells.f8.isNull, true);
  // Every field keeps its declared slot: f8 is still the ninth 4-byte value.
  assert.deepEqual(row.cells.f8.byteRange, [2 + 8 * 4, 2 + 9 * 4]);
});

test('variable-length count comes from the declaration, not from sample values', () => {
  const metas = [prepareField({ fieldId: 'widths', datatype: 'int', arraysize: '2x*' })];
  const payload = Buffer.alloc(1 + 4 + 3 * 2 * 4);
  payload[0] = 0; // no nulls
  payload.writeInt32BE(3, 1); // three groups of the declared leading dim 2
  for (let index = 0; index < 6; index += 1) payload.writeInt32BE(index, 5 + index * 4);
  const [row] = decodeBinaryRows(metas, payload, { kind: 'stream' });
  assert.deepEqual(row.cells.widths.value, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(row.cells.widths.byteRange, [1, payload.length]);
});

test('negative and oversized variable counts fail without allocating', () => {
  const negative = Buffer.alloc(1 + 4);
  negative[0] = 0;
  negative.writeInt32BE(-1, 1);
  assert.throws(
    () => decodeBinaryRows([binaryField('int', '*')], negative, { kind: 'stream' }),
    error => error instanceof DecodeIssue && /negative/.test(error.message),
  );

  const absurd = Buffer.alloc(1 + 4 + 4);
  absurd[0] = 0;
  absurd.writeInt32BE(0x7fffffff, 1);
  assert.throws(
    () => decodeBinaryRows([binaryField('double', '*')], absurd, { kind: 'stream' }),
    error => error instanceof DecodeIssue && Boolean(error.boundary.limit),
  );
});

test('truncated BINARY2 payload reports the exact shortfall', () => {
  const payload = Buffer.from([0, 0, 0, 0]);
  assert.throws(
    () => decodeBinaryRows([binaryField('double')], payload, { kind: 'stream' }),
    error => error instanceof DecodeIssue
      && error.boundary.byteOffset === 1
      && error.boundary.neededBytes === 8
      && error.boundary.availableBytes === 3,
  );
});

test('empty array, zero and missing scalar stay distinct in TABLEDATA', () => {
  const variable = binaryField('int', '*');
  const scalar = binaryField('int');
  const emptyArray = decodeTextCell(variable, '', {});
  assert.deepEqual(emptyArray, { value: [], isNull: false });
  const zero = decodeTextCell(scalar, '0', {});
  assert.deepEqual(zero, { value: 0, isNull: false });
  const missing = decodeTextCell(scalar, '  ', {});
  assert.equal(missing.isNull, true);
  assert.equal(missing.value, null);
});

test('long values keep 64-bit identity as decimal strings in both encodings', () => {
  assert.equal(
    decodeTextCell(binaryField('long'), '9007199254740993', {}).value,
    '9007199254740993',
  );
  const payload = Buffer.alloc(1 + 8);
  payload.writeBigInt64BE(9007199254740993n, 1);
  const [row] = decodeBinaryRows([binaryField('long')], payload, { kind: 'stream' });
  assert.equal(row.cells.x.value, '9007199254740993');
  assert.equal(typeof row.cells.x.value, 'string');
});

test('values outside the declared type range are rejected, not truncated', () => {
  assert.throws(
    () => decodeTextCell(binaryField('int'), '2147483648', {}),
    error => error instanceof DecodeIssue && /int range/.test(error.message),
  );
  assert.throws(
    () => decodeTextCell(binaryField('long'), '9223372036854775808', {}),
    error => error instanceof DecodeIssue && /64-bit range/.test(error.message),
  );
  assert.throws(
    () => decodeTextCell(binaryField('int', '3'), '1 2', {}),
    error => error instanceof DecodeIssue && /arraysize/.test(error.message),
  );
});

test('variable ASCII char is text while a scalar char is one character', () => {
  assert.deepEqual(decodeTextCell(binaryField('char', '*'), '', {}), { value: '', isNull: false });
  assert.equal(decodeTextCell(binaryField('char'), 'A', {}).value, 'A');
  assert.throws(() => decodeTextCell(binaryField('char'), 'AB', {}), DecodeIssue);
});

test('variable-length character prefix scales with the declared leading dimension', () => {
  const metas = [prepareField({ fieldId: 's', datatype: 'char', arraysize: '2x*' })];
  const payload = Buffer.alloc(1 + 4 + 6);
  payload[0] = 0;
  payload.writeInt32BE(3, 1); // three declared 2-character cells = six bytes
  payload.write('ABCDEF', 5);
  const [row] = decodeBinaryRows(metas, payload, { kind: 'stream' });
  assert.equal(row.cells.s.value, 'ABCDEF');
  assert.deepEqual(row.cells.s.byteRange, [1, 11]);
});

test('variable unicodeChar counts characters, not bytes, in both directions', () => {
  const metas = [
    prepareField({ fieldId: 'u', datatype: 'unicodeChar', arraysize: '*' }),
    prepareField({ fieldId: 'n', datatype: 'int' }),
  ];
  const characters = '桥接表'; // three UTF-8 characters, nine bytes
  const encoded = Buffer.from(characters, 'utf8');
  const payload = Buffer.alloc(1 + 4 + encoded.length + 4);
  payload[0] = 0;
  payload.writeInt32BE(3, 1);
  encoded.copy(payload, 5);
  payload.writeInt32BE(77, 5 + encoded.length);
  const [row] = decodeBinaryRows(metas, payload, { kind: 'stream' });
  assert.equal(row.cells.u.value, characters);
  assert.deepEqual(row.cells.u.byteRange, [1, 5 + encoded.length]);
  assert.equal(row.cells.n.value, 77);
  assert.deepEqual(row.cells.n.byteRange, [5 + encoded.length, payload.length]);

  // A null variable unicodeChar cell must still consume the same bytes.
  const nullPayload = Buffer.from(payload);
  nullPayload[0] = 0b10000000;
  nullPayload.writeInt32BE(88, 5 + encoded.length);
  const [nullRow] = decodeBinaryRows(metas, nullPayload, { kind: 'stream' });
  assert.equal(nullRow.cells.u.isNull, true);
  assert.deepEqual(nullRow.cells.u.byteRange, [1, 5 + encoded.length]);
  assert.equal(nullRow.cells.n.value, 88);
});

test('binary floats keep non-finite values and signed zero distinct from null', () => {
  const metas = ['f0', 'f1', 'f2', 'f3'].map(fieldId => prepareField({
    fieldId, datatype: 'double',
  }));
  const payload = Buffer.alloc(1 + 4 * 8);
  payload[0] = 0;
  payload.writeDoubleBE(NaN, 1);
  payload.writeDoubleBE(-Infinity, 9);
  payload.writeDoubleBE(0, 17);
  payload.writeDoubleBE(-0, 25);
  const [row] = decodeBinaryRows(metas, payload, { kind: 'stream' });
  assert.equal(row.cells.f0.value, 'NaN');
  assert.equal(row.cells.f1.value, '-Infinity');
  assert.equal(row.cells.f2.value, 0);
  assert.ok(Object.is(row.cells.f3.value, -0));
  assert.ok(Object.values(row.cells).every(cell => cell.isNull === false));
});

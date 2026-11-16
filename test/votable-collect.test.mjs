import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDocument } from '../src/votable-collect.mjs';
import { votableDocument } from '../src/votable-source.mjs';

const NS = 'http://www.ivoa.net/xml/VOTable/v1.3';

function document(body, { version = '1.4', namespace = NS } = {}) {
  return `<?xml version="1.0"?><VOTABLE xmlns="${namespace}" version="${version}">${body}</VOTABLE>`;
}

function table(id, fields, data, extra = '') {
  return `<TABLE ID="${id}">${fields}${extra}<DATA>${data}</DATA></TABLE>`;
}

const isPending = (result, tableId) => result.pending.some(
  item => item.tableId === tableId && typeof item.reason === 'string',
);

test('same names in two tables do not share identity and stay bound to their own fields', () => {
  const result = collectDocument(votableDocument());
  const primary = result.tables.find(entry => entry.tableId === 'primary');
  const matches = result.tables.find(entry => entry.tableId === 'matches');
  assert.ok(primary && matches);
  assert.equal(primary.name, 'targets');
  assert.equal(matches.name, 'targets');
  assert.deepEqual(primary.fields.map(field => field.fieldId), ['target-id', 'samples']);
  assert.deepEqual(matches.fields.map(field => field.fieldId), ['match-id', 'separation']);
  // Both fields are displayed as "value"; the key is the declared ID.
  assert.deepEqual(primary.fields.map(field => field.name), ['value', 'value']);
  assert.equal(primary.rows[0].cells['target-id'].fieldId, 'target-id');
  assert.equal(matches.rows[0].cells['match-id'].fieldId, 'match-id');
  assert.equal(matches.rows[0].cells.separation.value, 0);
});

test('field unit, ucd and utype are preserved with the field that declares them', () => {
  const result = collectDocument(document(table('t',
    '<FIELD ID="flux" name="value" datatype="double" unit="Jy" ucd="phot.flux" utype="x:Flux"/>'
    + '<FIELD ID="at" name="value" datatype="char" arraysize="19" unit="s"/>',
    '<TABLEDATA><TR><TD>1.5</TD><TD>2026-01-01T00:00:00</TD></TR></TABLEDATA>')));
  const [entry] = result.tables;
  assert.equal(entry.fields[0].unit, 'Jy');
  assert.equal(entry.fields[0].ucd, 'phot.flux');
  assert.equal(entry.fields[0].utype, 'x:Flux');
  assert.equal(entry.fields[1].unit, 's');
  assert.equal(entry.rows[0].cells.flux.value, 1.5);
  assert.equal(entry.fields[0].source.line, 1);
  assert.ok(entry.fields[0].source.byteOffset > 0);
});

test('FIELDref outside the table fields cannot bind to a same-named field elsewhere', () => {
  const foreign = table('other',
    '<FIELD ID="here" name="shared" datatype="int"/>',
    '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>');
  const local = table('local',
    '<FIELD ID="different" name="shared" datatype="int"/>',
    '<TABLEDATA><TR><TD>2</TD></TR></TABLEDATA>',
    '<GROUP name="g"><FIELDref ref="here"/></GROUP>');
  const result = collectDocument(document(`<RESOURCE ID="r">${foreign}${local}</RESOURCE>`));
  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].tableId, 'other');
  assert.ok(isPending(result, 'local'));
  const pending = result.pending.find(item => item.tableId === 'local');
  assert.match(pending.reason, /resolve/);
  assert.ok(pending.boundary.source, 'the unresolved reference has a document boundary');
});

test('one damaged table cannot overwrite or remove an independent table', () => {
  const broken = table('broken',
    '<FIELD ID="n" datatype="int"/>',
    '<BINARY2><STREAM encoding="base64">AAAA</STREAM></BINARY2>'); // 4-byte row deficit
  const good = table('good',
    '<FIELD ID="n" datatype="int"/>',
    '<TABLEDATA><TR><TD>7</TD></TR></TABLEDATA>');
  const result = collectDocument(document(`<RESOURCE ID="r">${broken}${good}</RESOURCE>`));
  assert.deepEqual(result.tables.map(entry => entry.tableId), ['good']);
  assert.equal(result.tables[0].rows[0].cells.n.value, 7);
  assert.ok(isPending(result, 'broken'));
});

test('malformed XML delivers no table and keeps an explainable boundary', () => {
  const ok = collectDocument(document(table('t',
    '<FIELD ID="n" datatype="int"/>',
    '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')));
  assert.equal(ok.tables.length, 1);
  const intact = document(table('t',
    '<FIELD ID="n" datatype="int"/>',
    '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>'));
  const failed = collectDocument(intact.slice(0, -8));
  assert.equal(failed.tables.length, 0);
  assert.ok(failed.pending.length >= 1);
  assert.ok(failed.pending.every(item => item.reason));
});

test('TABLEDATA cell count comes from declarations, never from row width', () => {
  const result = collectDocument(document(table('t',
    '<FIELD ID="a" datatype="int"/><FIELD ID="b" datatype="int"/>',
    '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')));
  assert.equal(result.tables.length, 0);
  const pending = result.pending[0];
  assert.match(pending.reason, /FIELD count/);
  assert.equal(pending.boundary.declaredFields, 2);
  assert.equal(pending.boundary.suppliedCells, 1);
});

test('BINARY2 evidence locates each cell in the decoded stream and the original XML', () => {
  const result = collectDocument(votableDocument());
  const primary = result.tables.find(entry => entry.tableId === 'primary');
  for (const row of primary.rows) {
    for (const cell of Object.values(row.cells)) {
      assert.deepEqual(cell.byteRange, cell.evidence.byteRange);
      assert.equal(cell.evidence.kind, 'BINARY2');
      assert.equal(cell.evidence.stream.kind, 'BINARY2_STREAM');
      assert.ok(Number.isInteger(cell.evidence.stream.byteOffset));
      assert.equal(cell.evidence.stream.line, 7);
      // Byte ranges are contiguous, in declaration order, within one row.
      assert.ok(cell.byteRange[0] >= cell.byteRange[0] - 1);
    }
    const spans = Object.values(row.cells).map(cell => cell.byteRange);
    for (let index = 1; index < spans.length; index += 1) {
      assert.equal(spans[index][0], spans[index - 1][1]);
    }
    assert.equal(row.evidence.rowByteRange[0], spans[0][0] - 1); // after the bitmap
  }
});

test('missing values, genuine zeros and empty arrays survive together', () => {
  const doc = votableDocument();
  const result = collectDocument(doc);
  const primary = result.tables.find(entry => entry.tableId === 'primary');
  const [first, second, third] = primary.rows;
  assert.equal(first.cells.samples.isNull, true);
  assert.equal(first.cells.samples.value, null);
  assert.deepEqual(second.cells.samples.value, []);
  assert.equal(second.cells.samples.isNull, false);
  assert.deepEqual(third.cells.samples.value, [0, -2]);
  assert.equal(first.cells['target-id'].value, '9007199254740993');
});

test('RESOURCE context is scoped: siblings do not inherit each other and children override', () => {
  const result = collectDocument(document(
    '<RESOURCE ID="a"><PARAM name="release" value="2026A"/>'
    + table('ta', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')
    + '<RESOURCE ID="a1"><PARAM name="release" value="child"/>'
    + table('ta1', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')
    + '</RESOURCE></RESOURCE>'
    + '<RESOURCE ID="b"><PARAM name="release" value="2026B"/>'
    + table('tb', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')
    + '</RESOURCE>'));
  assert.deepEqual(result.tables.map(entry => entry.tableId), ['ta', 'ta1', 'tb']);
  const contextOf = id => result.tables.find(entry => entry.tableId === id).context;
  assert.equal(contextOf('ta').release, '2026A');
  assert.equal(contextOf('ta1').release, 'child');
  assert.equal(contextOf('tb').release, '2026B');
  const ta1 = result.tables.find(entry => entry.tableId === 'ta1');
  assert.equal(ta1.contextEvidence[0].resourcePath, 'RESOURCE:a/RESOURCE:a1');
});

test('unsupported encodings are pending instead of silently fetched or guessed', () => {
  for (const data of [
    '<BINARY><STREAM encoding="base64">AAAA</STREAM></BINARY>',
    '<BINARY2><STREAM href="http://example.invalid/x"/> </BINARY2>',
    '<BINARY2><STREAM encoding="gzip">AAAA</STREAM></BINARY2>',
    '<FITS><STREAM encoding="base64">AAAA</STREAM></FITS>',
  ]) {
    const result = collectDocument(document(table('t', '<FIELD ID="n" datatype="int"/>', data)));
    assert.equal(result.tables.length, 0, data);
    assert.ok(isPending(result, 't'), data);
  }
});

test('duplicate field IDs or table IDs are reported, not merged', () => {
  const duplicateFields = collectDocument(document(table('t',
    '<FIELD ID="n" datatype="int"/><FIELD ID="n" datatype="int"/>',
    '<TABLEDATA><TR><TD>1</TD><TD>2</TD></TR></TABLEDATA>')));
  assert.equal(duplicateFields.tables.length, 0);
  assert.ok(isPending(duplicateFields, 't'));

  const duplicateTables = collectDocument(document(
    '<RESOURCE ID="r">'
    + table('same', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')
    + table('same', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>2</TD></TR></TABLEDATA>')
    + '</RESOURCE>'));
  assert.equal(duplicateTables.tables.length, 0);
  assert.equal(duplicateTables.pending.filter(item => item.tableId === 'same').length, 2);
});

test('DIRECTIVE-free declared namespace and version ranges are accepted', () => {
  assert.equal(collectDocument(votableDocument()).tables.length, 2);
  const v14 = collectDocument(document(
    table('t', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>'),
    { namespace: 'http://www.ivoa.net/xml/VOTable/v1.4' }));
  assert.equal(v14.tables.length, 1);
});

test('a foreign root or namespace is refused instead of reinterpreted', () => {
  const wrongRoot = collectDocument('<NOTAVOTABLE><TABLE ID="t"/></NOTAVOTABLE>');
  assert.equal(wrongRoot.tables.length, 0);
  assert.ok(wrongRoot.pending.some(item => /root/.test(item.reason)));
  const wrongNamespace = collectDocument(`<VOTABLE xmlns="urn:example:other">
    <TABLE ID="t"><FIELD ID="n" datatype="int"/></TABLE></VOTABLE>`);
  assert.equal(wrongNamespace.tables.length, 0);
  assert.ok(wrongNamespace.pending.some(item => /namespace/.test(item.reason)));
});

test('PARAMs declared directly inside a TABLE stay with that table', () => {
  const result = collectDocument(document(
    '<RESOURCE ID="r"><PARAM name="release" value="outer"/>'
    + `<TABLE ID="t"><PARAM name="release" value="inner"/><PARAM name="rows" datatype="int" value="1"/>`
    + '<FIELD ID="n" datatype="int"/><DATA><TABLEDATA><TR><TD>1</TD></TR></TABLEDATA></DATA></TABLE>'
    + '</RESOURCE>'));
  const [entry] = result.tables;
  assert.equal(entry.context.release, 'outer');
  assert.deepEqual(entry.params.map(param => [param.name, param.value]), [
    ['release', 'inner'], ['rows', '1'],
  ]);
  assert.ok(entry.params.every(param => param.source));
});

test('resource context does not depend on where PARAM appears in the resource', () => {
  const result = collectDocument(document(
    '<RESOURCE ID="r">'
    + table('t', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')
    + '<PARAM name="release" value="late"/></RESOURCE>'));
  assert.equal(result.tables[0].context.release, 'late');
});

test('PARAM values may come from a VALUE child element', () => {
  const result = collectDocument(document(
    '<RESOURCE ID="r"><PARAM name="release"><VALUE>2026A</VALUE></PARAM>'
    + table('t', '<FIELD ID="n" datatype="int"/>', '<TABLEDATA><TR><TD>1</TD></TR></TABLEDATA>')
    + '</RESOURCE>'));
  assert.equal(result.tables[0].context.release, '2026A');
});

test('a PARAM inside a GROUP is not merged into the RESOURCE context', () => {
  const result = collectDocument(document(
    '<RESOURCE ID="r"><TABLE ID="t">'
    + '<FIELD ID="n" datatype="int"/><GROUP><PARAM name="g" value="1"/><FIELDref ref="n"/></GROUP>'
    + '<DATA><TABLEDATA><TR><TD>1</TD></TR></TABLEDATA></DATA></TABLE></RESOURCE>'));
  assert.deepEqual(result.tables[0].context, {});
  assert.deepEqual(result.tables[0].groups[0].fieldRefs, ['n']);
});

test('fields without an ID get a traceable in-document key, never a display name', () => {
  const result = collectDocument(document(
    '<TABLE><FIELD name="value" datatype="int"/><FIELD name="value" datatype="int"/>'
    + '<DATA><TABLEDATA><TR><TD>1</TD><TD>2</TD></TR></TABLEDATA></DATA></TABLE>'));
  const [entry] = result.tables;
  assert.equal(entry.fields.length, 2);
  assert.ok(entry.fields.every(field => /^FIELD@\d+$/.test(field.fieldId)));
  assert.notEqual(entry.fields[0].fieldId, entry.fields[1].fieldId);
  assert.deepEqual(Object.keys(entry.rows[0].cells), entry.fields.map(field => field.fieldId));
  assert.match(entry.tableId, /^TABLE@\d+$/);
});

test('a field key such as __proto__ stays an ordinary own cell key', () => {
  const result = collectDocument(document(table('t',
    '<FIELD ID="__proto__" datatype="int"/>',
    '<TABLEDATA><TR><TD>5</TD></TR></TABLEDATA>')));
  const cells = result.tables[0].rows[0].cells;
  assert.ok(Object.prototype.hasOwnProperty.call(cells, '__proto__'));
  assert.equal(cells.__proto__.value, 5);
  assert.equal({}.value, undefined);
});

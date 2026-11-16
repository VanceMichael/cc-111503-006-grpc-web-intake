import { votableFixture } from './votable-source.mjs';
import { collect } from './intake.mjs';
import { Inbox } from './store.mjs';

const scenario = process.argv[2] || 'normal';
const source = await votableFixture(scenario);
const store = new Inbox();
try {
  const result = await collect(source, store);
  console.log(JSON.stringify({
    scenario,
    mode: result.mode,
    evidence: store.evidence(),
    tables: result.tables.map(table => ({
      tableId: table.tableId,
      resourcePath: table.resourcePath,
      fields: table.fields.map(field => ({
        fieldId: field.fieldId,
        name: field.name,
        datatype: field.datatype,
        arraysize: field.arraysize,
        unit: field.unit,
        ucd: field.ucd,
      })),
      groups: table.groups.map(group => ({ name: group.name, fieldRefs: group.fieldRefs })),
      context: table.context,
      rows: table.rows.map(row => ({
        rowIndex: row.rowIndex,
        cells: Object.fromEntries(Object.entries(row.cells).map(([fieldId, cell]) => [fieldId, {
          value: cell.value,
          isNull: cell.isNull,
          byteRange: cell.byteRange ?? null,
        }])),
      })),
    })),
    pending: result.pending,
  }, null, 2));
} finally {
  store.close();
  await source.close();
}

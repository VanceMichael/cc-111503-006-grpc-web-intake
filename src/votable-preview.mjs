import { SaxesParser } from 'saxes';

export function describeTables(bytes) {
  const parser = new SaxesParser({ xmlns: true });
  const tables = [];
  let current = null;
  parser.on('doctype', () => { throw new Error('external declarations are not supported'); });
  parser.on('opentag', node => {
    const attributes = Object.fromEntries(Object.values(node.attributes).map(attribute => [attribute.local, attribute.value]));
    if (node.local === 'TABLE') {
      current = { id: attributes.ID, name: attributes.name, fields: [] };
      tables.push(current);
    }
    if (node.local === 'FIELD' && current) current.fields.push(attributes);
  });
  parser.on('closetag', node => { if (node.local === 'TABLE') current = null; });
  parser.write(bytes.toString('utf8')).close();
  return tables;
}

export async function previewTable(source, store) {
  const response = await fetch(source.url + source.path);
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence('votable', { url: response.url, deliveryId: source.deliveryId }, bytes);
  return { mode: 'votable-descriptor-preview', evidence, tables: describeTables(bytes) };
}

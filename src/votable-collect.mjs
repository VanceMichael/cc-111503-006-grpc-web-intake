import { SaxesParser } from 'saxes';
import {
  DecodeIssue, MAX_ROWS, MAX_STREAM_BYTES, SUPPORTED_DATATYPES,
  decodeBinaryRows, decodeTextCell, defineContextValue, prepareField,
} from './votable-decode.mjs';

// Collector for the VOTable subset in docs/source-contract.md.
//
// Parsing records structural facts (RESOURCE nesting, TABLE/FIELD identity,
// FIELDrefs, DATA payloads) without interpreting cells. Each TABLE is then
// explained independently from its own FIELD declarations. A table that
// cannot be explained is reported in `pending`; sibling tables are unaffected.
//
// Nothing here guesses columns from names, sample values or row widths.

// VOTable 1.3 is the interchange namespace used by this station. 1.4 and 1.5
// documents use their own namespace with the same compatible subset.
const VOTABLE_NAMESPACES = new Set([
  'http://www.ivoa.net/xml/VOTable/v1.3',
  'http://www.ivoa.net/xml/VOTable/v1.4',
  'http://www.ivoa.net/xml/VOTable/v1.5',
]);

class TableIssue extends Error {
  constructor(reason, boundary = {}) {
    super(reason);
    this.name = 'TableIssue';
    this.boundary = boundary;
  }
}

function reject(reason, boundary) {
  throw new TableIssue(reason, boundary);
}

function attributesOf(node) {
  const attributes = {};
  for (const attribute of Object.values(node.attributes || {})) {
    if (attribute.uri === 'http://www.w3.org/2000/xmlns/') continue;
    attributes[attribute.local] = attribute.value;
  }
  return attributes;
}

function makeLocator(xml) {
  const ascii = !/[^\x00-\x7f]/.test(xml);
  const lineStarts = [0];
  for (let index = 0; index < xml.length; index += 1) {
    if (xml[index] === '\n') lineStarts.push(index + 1);
  }
  return offset => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return {
      charOffset: offset,
      byteOffset: ascii ? offset : Buffer.byteLength(xml.slice(0, offset), 'utf8'),
      line: low + 1,
      column: offset - lineStarts[low] + 1,
    };
  };
}

function tagStartOf(xml, position) {  let index = position - 1;
  if (index >= 0 && xml[index] === '>') index -= 1;
  const start = xml.lastIndexOf('<', Math.max(0, index));
  return start < 0 ? 0 : start;
}

function decodeBase64(text, tableId) {
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned === '') return Buffer.alloc(0);
  // Check the budget from the declaration-side length before allocating.
  if (cleaned.length > Math.ceil((MAX_STREAM_BYTES * 4) / 3) + 4) {
    reject('BINARY2 STREAM exceeds the byte budget', {
      tableId, encodedCharacters: cleaned.length, limit: MAX_STREAM_BYTES,
    });
  }
  // Padding is optional in an embedded STREAM; a remainder of one character
  // can never be a whole base64 group.
  if (cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    reject('BINARY2 STREAM is not valid base64', { tableId });
  }
  if (/=/.test(cleaned) && cleaned.length % 4 !== 0) {
    reject('BINARY2 STREAM base64 padding is inconsistent', { tableId });
  }  return Buffer.from(cleaned, 'base64');
}

class DocumentReader {
  constructor(xml) {
    this.xml = xml;
    this.locate = makeLocator(xml);
    this.stack = [];
    this.rootResource = { resourcePath: [], ownParams: new Map(), parent: null };
    this.resource = this.rootResource;
    this.resources = [];
    this.tableStack = [];
    this.dataFrames = [];
    this.tables = [];
    this.error = null;
    this.stopped = false;
    this.stream = null;
    this.param = null;
    this.parser = new SaxesParser({ xmlns: true });
  }

  get currentTable() {
    return this.tableStack.at(-1) || null;
  }

  location(entry) {
    if (!entry) return null;
    const start = entry.start;
    return {
      byteOffset: start.byteOffset,
      charOffset: start.charOffset,
      line: start.line,
      column: start.column,
    };
  }

  range(entry) {
    const start = this.location(entry);
    if (!start) return null;
    return {
      ...start,
      endByteOffset: entry.end?.byteOffset ?? null,
      endLine: entry.end?.line ?? null,
    };
  }

  parse() {
    const parser = this.parser;
    parser.on('doctype', () => {
      // DTDs and external entities are refused, never resolved.
      this.error = new TableIssue('external DTD and entity declarations are not supported');
      this.stopped = true;
    });
    parser.on('error', error => {
      this.error = new TableIssue('XML is not well formed', { parser: error.message });
      this.stopped = true;
    });
    parser.on('opentag', node => { if (!this.stopped) this.open(node); });
    parser.on('closetag', node => { if (!this.stopped) this.close(node); });
    parser.on('text', text => { if (!this.stopped) this.text(text); });
    parser.on('cdata', text => { if (!this.stopped) this.text(text); });
    try {
      parser.write(this.xml).close();
    } catch (error) {
      if (!(error instanceof TableIssue) && !(error instanceof DecodeIssue)) throw error;
      this.error ||= error;
      this.stopped = true;
    }
    this.finish();
  }

  open(node) {
    const name = node.local;
    const attributes = attributesOf(node);
    if (this.stack.length === 0) {
      if (name !== 'VOTABLE') {
        this.error = new TableIssue('document root is not VOTABLE', { root: name });
        this.stopped = true;
        return;
      }
      if (node.uri !== undefined && !VOTABLE_NAMESPACES.has(node.uri)) {
        this.error = new TableIssue('document is not in a supported VOTable namespace', {
          namespace: node.uri,
        });
        this.stopped = true;
        return;
      }
      this.version = attributes.version ?? null;
    }
    const start = this.locate(tagStartOf(this.xml, this.parser.position));
    const entry = { name, attributes, start, selfClosing: node.isSelfClosing === true };
    this.stack.push(entry);

    if (name === 'RESOURCE') this.openResource(attributes, entry);
    else if (name === 'TABLE') this.openTable(attributes, entry);
    else if (name === 'FIELD') this.openField(attributes, entry);
    else if (name === 'PARAM') this.openParam(attributes, entry);
    else if (name === 'VALUE') this.openValue();
    else if (name === 'GROUP') this.openGroup(attributes, entry);
    else if (name === 'FIELDref' || name === 'PARAMref') this.openReference(name, attributes, entry);
    else if (name === 'DATA') this.openData(entry);
    else if (name === 'TABLEDATA' || name === 'BINARY2' || name === 'BINARY') {
      this.openEncoding(name, entry);
    } else if (name === 'STREAM') this.openStream(attributes, entry);
    else if (name === 'TR') this.openRow(entry);
    else if (name === 'TD') this.openCell(entry);
  }

  close(node) {
    const name = node.local;
    const entry = this.stack.pop();
    if (!entry || entry.name !== name) {
      this.error = new TableIssue('XML nesting is inconsistent', {
        expected: entry?.name, found: name,
      });
      this.stopped = true;
      return;
    }
    entry.end = this.locate(tagStartOf(this.xml, this.parser.position));

    if (name === 'RESOURCE') this.closeResource(entry);
    else if (name === 'TABLE') this.closeTable(entry);
    else if (name === 'PARAM') this.closeParam(entry);
    else if (name === 'TABLEDATA' || name === 'BINARY2' || name === 'BINARY') {
      this.closeEncoding(name, entry);
    } else if (name === 'STREAM') this.closeStream(entry);
    else if (name === 'TR') this.closeRow(entry);
    else if (name === 'TD') this.closeCell(entry);
    else if (name === 'GROUP') this.closeGroup(entry);
  }

  text(text) {
    const top = this.stack.at(-1);
    if (!top) return;
    if (top.name === 'TD') {
      const frame = this.dataFrames.at(-1);
      if (frame?.kind === 'TABLEDATA' && frame.cell?.entry === top) frame.cell.text += text;
    } else if (top.name === 'STREAM') {
      if (this.stream) this.stream.text += text;
    } else if (top.name === 'VALUE') {
      if (this.param && this.param.valueElement !== undefined) this.param.valueElement += text;
    } else if (top.name === 'PARAM') {
      if (this.param) this.param.text += text;
    }
  }

  // ----- resources and parameters -----------------------------------------

  openResource(attributes, entry) {
    const segment = attributes.ID
      ? `RESOURCE:${attributes.ID}`
      : `RESOURCE[${this.resources.length}]`;
    const resource = {
      resourcePath: [...this.resource.resourcePath, segment],
      // Only this resource's own PARAMs are stored. Context is merged along
      // the ancestry chain after parsing, so declaration order inside a
      // resource does not matter and sibling resources never mix.
      ownParams: new Map(),
      parent: this.resource,
      id: attributes.ID,
      href: attributes.href,
      entry,
      index: this.resources.length,
    };
    this.resources.push(resource);
    this.resource = resource;
  }

  closeResource(entry) {
    this.resource.close = entry;
    this.resource = this.resource.parent || this.rootResource;
  }

  openParam(attributes, entry) {
    this.param = {
      name: attributes.name,
      ID: attributes.ID,
      datatype: attributes.datatype,
      arraysize: attributes.arraysize,
      unit: attributes.unit,
      ucd: attributes.ucd,
      utype: attributes.utype,
      value: attributes.value,
      entry,
      resource: this.resource,
      // A PARAM value may be a value= attribute or a <VALUE> child element.
      valueElement: undefined,
      text: '',
    };
  }

  openValue() {
    if (this.param && this.stack.at(-2)?.name === 'PARAM') this.param.valueElement = '';
  }

  closeParam(entry) {
    const param = this.param;
    this.param = null;
    if (!param) return;
    if (param.value === undefined) {
      if (param.valueElement !== undefined) {
        const text = param.valueElement.trim();
        param.value = text === '' ? null : text;
      } else {
        const text = param.text.trim();
        param.value = text === '' ? null : text;
      }
    }
    if (!param.name) return;
    param.sourcePath = param.resource.resourcePath.join('/');
    param.source = this.location(param.entry);
    // Only a PARAM directly inside RESOURCE is resource context. A PARAM
    // declared inside a TABLE (directly or in a GROUP) belongs to that table
    // and is not merged into the enclosing resource's context.
    if (this.currentTable && this.stackParentName() !== 'RESOURCE') {
      (this.currentTable.ownParams ||= []).push(param);
      return;
    }
    param.resource.ownParams.set(param.name, param);
  }

  stackParentName() {
    // During close(), the closing entry has already been popped, so the
    // PARAM's own entry is not on the stack; the parent is the top.
    return this.stack.at(-1)?.name ?? null;
  }

  // ----- table declarations ------------------------------------------------

  openTable(attributes, entry) {
    const parent = this.currentTable;
    const resource = this.resource;
    const table = {
      declaredId: attributes.ID,
      name: attributes.name,
      attributes,
      resourcePath: [...resource.resourcePath],
      resource,
      fields: [],
      fieldIds: new Set(),
      groups: [],
      orphanRefs: [],
      rows: [],
      data: null,
      tabledata: null,
      binary2: null,
      ownParams: [],
      entry,
      close: null,
      index: this.tables.length,
      structuralIssue: null,
      resourceHref: resource.href,
    };
    if (parent) {
      parent.structuralIssue ||= 'TABLE contains a nested TABLE';
      table.structuralIssue = 'nested TABLE is not supported';
    }
    this.tables.push(table);
    this.tableStack.push(table);
  }

  closeTable(entry) {
    const table = this.currentTable;
    if (!table) return;
    table.close = entry;
    this.tableStack.pop();
  }

  openField(attributes, entry) {
    const table = this.currentTable;
    if (!table) return;
    const declaredId = attributes.ID;
    // A missing ID falls back to a traceable position in this original
    // document; the display name is never used as a key.
    const fieldId = declaredId || `FIELD@${entry.start.byteOffset}`;
    if (table.fieldIds.has(fieldId)) table.duplicateFieldId = true;
    table.fieldIds.add(fieldId);
    const field = {
      fieldId,
      declaredId,
      name: attributes.name,
      datatype: attributes.datatype,
      arraysize: attributes.arraysize,
      unit: attributes.unit,
      ucd: attributes.ucd,
      utype: attributes.utype,
      ref: attributes.ref,
      attributes,
      entry,
      source: this.location(entry),
    };
    table.fields.push(field);
  }

  openGroup(attributes, entry) {
    const table = this.currentTable;
    if (!table || this.dataFrames.length > 0) return;
    const group = {
      declaredId: attributes.ID,
      name: attributes.name,
      attributes,
      fieldRefs: [],
      paramRefs: [],
      entry,
      source: this.location(entry),
    };
    table.groups.push(group);
    this.group = group;
  }

  closeGroup(entry) {
    if (this.group?.entry === entry) this.group = null;
  }

  openReference(name, attributes, entry) {
    const table = this.currentTable;
    if (!table) return;
    const ref = { tag: name, ref: attributes.ref, attributes, entry, source: this.location(entry) };
    if (name === 'FIELDref') {
      const group = this.group;
      if (group) group.fieldRefs.push(ref);
      else {
        // A reference outside any GROUP cannot be explained as a grouping;
        // it is a structural problem, not something to silently drop.
        table.orphanRefs.push(ref);
        table.structuralIssue ||= 'FIELDref appears outside a GROUP';
      }
    } else if (this.group) {
      this.group.paramRefs.push(ref);
    }
  }

  // ----- DATA payloads -----------------------------------------------------

  openData(entry) {
    const table = this.currentTable;
    if (!table) return;
    if (table.data) {
      table.data.duplicate = true;
      table.structuralIssue ||= 'TABLE declares more than one DATA element';
      return;
    }
    table.data = { kind: null, entry, duplicate: false };
  }

  openEncoding(name, entry) {
    const table = this.currentTable;
    if (!table || this.dataFrames.length > 0) return;
    if (!table.data) {
      table.data = { kind: null, entry, duplicate: false };
    }
    if (table.data.kind && table.data.kind !== name) {
      table.structuralIssue ||= 'TABLE declares conflicting DATA encodings';
    }
    table.data.kind = name;
    const frame = { kind: name, entry, rows: [], row: null, cell: null, stream: null };
    this.dataFrames.push(frame);
    if (name === 'TABLEDATA') table.tabledata = frame;
    if (name === 'BINARY2') table.binary2 = frame;
    if (name === 'BINARY') table.structuralIssue ||= 'legacy BINARY encoding is not supported';
  }

  closeEncoding(name, entry) {
    const frame = this.dataFrames.at(-1);
    if (!frame || frame.kind !== name) {
      this.error = new TableIssue('DATA encoding nesting is inconsistent', {
        expected: frame?.kind, found: name,
      });
      this.stopped = true;
      return;
    }
    frame.close = entry;
    this.dataFrames.pop();
    this.stream = null;
  }

  openStream(attributes, entry) {
    const frame = this.dataFrames.at(-1);
    if (!frame || frame.kind !== 'BINARY2') return;
    if (frame.stream) {
      const table = this.currentTable;
      if (table) table.structuralIssue ||= 'TABLE declares more than one STREAM';
      return;
    }
    const stream = {
      encoding: attributes.encoding,
      href: attributes.href,
      text: '',
      entry,
      close: null,
    };
    frame.stream = stream;
    this.stream = stream;
  }

  closeStream(entry) {
    if (this.stream?.entry === entry) {
      this.stream.close = entry;
      this.stream = null;
    }
  }

  openRow(entry) {
    const frame = this.dataFrames.at(-1);
    if (!frame || frame.kind !== 'TABLEDATA') return;
    if (frame.row) {
      const table = this.currentTable;
      if (table) table.structuralIssue ||= 'TABLEDATA contains a nested TR';
      return;
    }
    frame.row = { entry, cells: [], source: this.location(entry) };
  }

  closeRow(entry) {
    const frame = this.dataFrames.at(-1);
    if (!frame || frame.kind !== 'TABLEDATA') return;
    if (!frame.row || frame.row.entry !== entry) return;
    frame.rows.push(frame.row);
    frame.row = null;
  }

  openCell(entry) {
    const frame = this.dataFrames.at(-1);
    if (!frame || frame.kind !== 'TABLEDATA') return;
    if (!frame.row) {
      const table = this.currentTable;
      if (table) table.structuralIssue ||= 'TABLEDATA TD outside TR';
      return;
    }
    if (frame.cell) return;
    frame.cell = { entry, text: '', source: this.location(entry) };
  }

  closeCell(entry) {
    const frame = this.dataFrames.at(-1);
    if (!frame || frame.kind !== 'TABLEDATA') return;
    if (!frame.cell || frame.cell.entry !== entry) return;
    if (frame.row) frame.row.cells.push({ ...frame.cell, raw: frame.cell.text });
    frame.cell = null;
  }

  // ----- table explanation -------------------------------------------------

  finish() {
    this.tables.forEach(table => {
      if (!table.close && !table.structuralIssue) {
        table.structuralIssue = 'TABLE was not closed before the document ended';
      }
    });
  }

  tableIdOf(table) {
    return table.declaredId || `TABLE@${table.entry.start.byteOffset}`;
  }

  explain(table) {
    if (table.structuralIssue) reject(table.structuralIssue);
    if (table.resourceHref) {
      reject('external RESOURCE href is not fetched', { href: table.resourceHref });
    }
    if (table.duplicateFieldId) {
      reject('duplicate FIELD ID in one TABLE');
    }    const metas = this.explainFields(table);
    const groups = this.explainGroups(table, metas);
    const rows = this.explainData(table, metas);
    return { metas, groups, rows, context: this.context(table) };
  }

  explainFields(table) {
    if (table.fields.length === 0) reject('TABLE declares no FIELD');
    const metas = [];
    const seen = new Set();
    for (const field of table.fields) {
      if (seen.has(field.fieldId)) {
        reject('duplicate FIELD ID in one TABLE', {
          fieldId: field.fieldId, source: field.source,
        });
      }
      seen.add(field.fieldId);
      if (field.ref !== undefined) {
        reject('FIELD with ref= is not a local declaration', {
          fieldId: field.fieldId, ref: field.ref, source: field.source,
        });
      }
      if (field.datatype === undefined) {
        reject('FIELD lacks a datatype declaration', {
          fieldId: field.fieldId, source: field.source,
        });
      }
      if (!SUPPORTED_DATATYPES.has(field.datatype)) {
        reject('unsupported FIELD datatype', {
          fieldId: field.fieldId, datatype: field.datatype, source: field.source,
        });
      }
      const meta = { ...prepareField(field), declaration: field, referencedBy: [] };
      metas.push(meta);
    }
    return metas;
  }

  explainGroups(table, metas) {
    const byFieldId = new Map(metas.map(meta => [meta.fieldId, meta]));
    const byDeclaredId = new Map();
    for (const meta of metas) {
      const declared = meta.declaration.declaredId;
      if (declared === undefined) continue;
      byDeclaredId.set(declared, byDeclaredId.has(declared) ? null : meta.fieldId);
    }
    const resolve = ref => {
      if (ref.ref === undefined || ref.ref === '') {
        reject('FIELDref lacks a ref attribute', { source: ref.source });
      }
      // Resolution is limited to this table's own fields: a same-named field
      // in another TABLE must not satisfy the reference.
      if (byFieldId.has(ref.ref)) return ref.ref;
      const declared = byDeclaredId.get(ref.ref);
      if (declared) return declared;
      reject('FIELDref does not resolve within this TABLE', {
        ref: ref.ref, source: ref.source,
      });
    };
    return table.groups.map(group => {
      const fieldRefs = group.fieldRefs.map(ref => {
        const fieldId = resolve(ref);
        byFieldId.get(fieldId).referencedBy.push(group.name ?? group.declaredId ?? null);
        return fieldId;
      });
      return {
        id: group.declaredId ?? null,
        name: group.name ?? null,
        fieldRefs,
        paramRefs: group.paramRefs.map(ref => ref.ref ?? null),
        attributes: group.attributes,
        source: group.source,
      };
    });
  }

  context(table) {
    const context = {};
    const evidence = [];
    // Merge from the outermost resource inwards so a nearer RESOURCE
    // overrides a farther one. Siblings never share their own PARAMs.
    const chain = [];
    for (let resource = table.resource; resource; resource = resource.parent) {
      chain.push(resource);
    }
    chain.reverse();
    const merged = new Map();
    for (const resource of chain) {
      for (const [name, param] of resource.ownParams) merged.set(name, param);
    }
    for (const [name, param] of merged) {
      defineContextValue(context, name, param.value === undefined ? null : param.value);
      evidence.push({
        name,
        id: param.ID ?? null,
        datatype: param.datatype ?? null,
        value: param.value === undefined ? null : param.value,
        unit: param.unit ?? null,
        ucd: param.ucd ?? null,
        utype: param.utype ?? null,
        resourcePath: param.sourcePath ?? null,
        source: param.source ?? null,
      });
    }
    return { context, evidence };
  }

  explainData(table, metas) {
    if (!table.data) reject('TABLE has no DATA element');
    if (table.data.duplicate) reject('TABLE declares more than one DATA element');
    if (!table.data.kind) reject('TABLE DATA encoding is not declared');
    if (table.data.kind === 'BINARY') reject('legacy BINARY encoding is not supported');
    if (table.data.kind === 'TABLEDATA') return this.explainTableData(table, metas);
    return this.explainBinary2(table, metas);
  }

  explainTableData(table, metas) {
    const frame = table.tabledata;
    if (!frame) reject('TABLEDATA content is missing');
    if (frame.rows.length > MAX_ROWS) {
      reject('TABLEDATA exceeds the row budget', {
        rows: frame.rows.length, limit: MAX_ROWS,
      });
    }
    return frame.rows.map((row, rowIndex) => {
      if (row.cells.length !== metas.length) {
        // Never drop an extra cell or pad a short row: widths come from the
        // table's FIELD declarations.
        reject('TABLEDATA row cell count does not match the declared FIELD count', {
          rowIndex, declaredFields: metas.length, suppliedCells: row.cells.length,
          source: row.source,
        });
      }
      const cells = {};
      metas.forEach((meta, index) => {
        const cell = row.cells[index];
        let decoded;
        try {
          decoded = decodeTextCell(meta, cell.raw, { rowIndex, fieldId: meta.fieldId });
        } catch (error) {
          if (error instanceof DecodeIssue) {
            error.boundary = { ...error.boundary, source: cell.source };
          }
          throw error;
        }
        Object.defineProperty(cells, meta.fieldId, {
          value: {
            fieldId: meta.fieldId,
            value: decoded.value,
            isNull: decoded.isNull,
            raw: cell.raw,
            evidence: {
              kind: 'TABLEDATA',
              row: row.source,
              cell: cell.source,
              // The raw TD text is the original representation; positions
              // locate the TR/TD elements themselves.
              raw: cell.raw,
            },
          },
          enumerable: true, writable: true, configurable: true,
        });
      });
      return {
        rowIndex,
        evidence: { kind: 'TABLEDATA', row: row.source },
        cells,
      };
    });
  }

  explainBinary2(table, metas) {
    const frame = table.binary2;
    const stream = frame?.stream;
    if (!stream) reject('BINARY2 lacks an embedded STREAM', {
      data: this.location(frame?.entry),
    });
    if (stream.href !== undefined) {
      reject('external STREAM href is not fetched', {
        href: stream.href, source: this.location(stream.entry),
      });
    }
    const encoding = (stream.encoding || '').toLowerCase();
    if (encoding !== 'base64') {
      reject('BINARY2 STREAM encoding must be base64', {
        encoding: stream.encoding ?? null, source: this.location(stream.entry),
      });
    }
    const payload = decodeBase64(stream.text, table.declaredId);
    if (payload.length > MAX_STREAM_BYTES) {
      reject('BINARY2 STREAM exceeds the byte budget', {
        bytes: payload.length, limit: MAX_STREAM_BYTES,
      });
    }
    const streamLocator = {
      kind: 'BINARY2_STREAM',
      byteOffset: stream.entry.start.byteOffset,
      line: stream.entry.start.line,
      column: stream.entry.start.column,
      decodedBytes: payload.length,
    };
    return decodeBinaryRows(metas, payload, streamLocator);
  }

  pendingOf(table, error) {
    const failure = error instanceof DecodeIssue || error instanceof TableIssue
      ? error
      : new TableIssue('table could not be explained', { message: error.message });
    return {
      tableId: this.tableIdOf(table),
      resourcePath: table.resourcePath,
      reason: failure.message,
      boundary: {
        ...failure.boundary,
        source: failure.boundary?.source || this.range(table.entry),
      },
    };
  }

  result() {
    const tables = [];
    const pending = [];
    // A document that is not well formed cannot be trusted to describe any
    // table boundary, so discovered tables are reported as pending instead
    // of being delivered from an incomplete structure.
    if (this.error) {
      for (const table of this.tables) {
        pending.push({
          tableId: this.tableIdOf(table),
          resourcePath: table.resourcePath,
          reason: this.error.message,
          boundary: {
            ...(this.error.boundary || {}),
            source: this.range(table.entry),
          },
        });
      }
      pending.push({
        tableId: null,
        resourcePath: this.resource?.resourcePath ?? [],
        reason: this.error.message,
        boundary: this.error.boundary ?? null,
      });
      return { version: this.version ?? null, tables, pending };
    }
    const duplicateIds = new Set();
    const seen = new Map();
    for (const table of this.tables) {
      if (table.declaredId === undefined) continue;
      const key = `${table.resourcePath.join('/')}\u0000${table.declaredId}`;
      if (seen.has(key)) {
        duplicateIds.add(seen.get(key));
        duplicateIds.add(table);
      } else {
        seen.set(key, table);
      }
    }
    for (const table of this.tables) {
      if (duplicateIds.has(table)) {
        pending.push({
          tableId: this.tableIdOf(table),
          resourcePath: table.resourcePath,
          reason: 'duplicate TABLE ID within one resource path',
          boundary: { source: this.range(table.entry) },
        });
        continue;
      }
      try {
        const explained = this.explain(table);
        tables.push({
          tableId: this.tableIdOf(table),
          declaredId: table.declaredId ?? null,
          name: table.name ?? null,
          resourcePath: table.resourcePath,
          source: this.range(table.entry),
          fields: explained.metas.map(meta => ({
            fieldId: meta.fieldId,
            declaredId: meta.declaration.declaredId ?? null,
            name: meta.declaration.name ?? null,
            datatype: meta.datatype,
            arraysize: meta.declaration.arraysize ?? null,
            unit: meta.declaration.unit ?? null,
            ucd: meta.declaration.ucd ?? null,
            utype: meta.declaration.utype ?? null,
            source: meta.declaration.source,
            referencedBy: meta.referencedBy,
          })),
          groups: explained.groups,
          context: explained.context.context,
          contextEvidence: explained.context.evidence,
          // PARAMs declared directly inside the TABLE are kept with the table
          // instead of being merged into the enclosing RESOURCE context.
          params: table.ownParams.map(param => ({
            name: param.name ?? null,
            id: param.ID ?? null,
            datatype: param.datatype ?? null,
            arraysize: param.arraysize ?? null,
            unit: param.unit ?? null,
            ucd: param.ucd ?? null,
            utype: param.utype ?? null,
            value: param.value ?? null,
            source: param.source ?? null,
          })),
          rows: explained.rows,
        });
      } catch (error) {
        pending.push(this.pendingOf(table, error));
      }
    }
    return { version: this.version ?? null, tables, pending };
  }
}

export function collectDocument(xml) {
  const reader = new DocumentReader(xml);
  reader.parse();
  return reader.result();
}

// Fetch the intact original once, retain it as evidence, and explain the
// tables from those bytes. The decoded rows are never substituted for the
// original document in the Inbox.
export async function collect(source, store) {
  const response = await fetch(source.url + source.path);
  if (!response.ok) {
    throw new Error(`VOTable source returned HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence(
    'votable',
    { url: response.url, deliveryId: source.deliveryId },
    bytes,
  );
  let xml;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      mode: 'votable-collection',
      evidence,
      tables: [],
      pending: [{
        tableId: null,
        resourcePath: [],
        reason: 'document is not valid UTF-8',
        boundary: { bytes: bytes.length },
      }],
    };
  }
  const result = collectDocument(xml);
  return { mode: 'votable-collection', evidence, version: result.version, ...result };
}

export { TableIssue };

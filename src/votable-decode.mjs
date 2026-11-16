// Decoding rules for the VOTable subset in docs/source-contract.md.
// Values are interpreted from the declarations of the table, never guessed
// from sample values or display names.

export const SUPPORTED_DATATYPES = new Set([
  'int', 'long', 'float', 'double', 'char', 'unicodeChar', 'boolean',
]);

export const MAX_ROWS = 1_000_000;
export const MAX_CELL_ELEMENTS = 1_000_000;
export const MAX_CELL_BYTES = 64 * 1024 * 1024;
export const MAX_STREAM_BYTES = 128 * 1024 * 1024;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export class DecodeIssue extends Error {
  constructor(reason, boundary = {}) {
    super(reason);
    this.name = 'DecodeIssue';
    this.boundary = boundary;
  }
}

function fail(reason, boundary) {
  throw new DecodeIssue(reason, boundary);
}

function isCharacterType(datatype) {
  return datatype === 'char' || datatype === 'unicodeChar';
}

function elementSize(datatype) {
  switch (datatype) {
    case 'int': return 4;
    case 'long': return 8;
    case 'float': return 4;
    case 'double': return 8;
    case 'boolean': return 1;
    default: return null;
  }
}

// arraysize is a declared shape: "4", "3x4", "4x*". The variable dimension,
// when present, is the last one. A scalar has no arraysize at all.
export function parseArraySize(raw, fieldId) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { scalar: true, variable: false, dims: [], fixedProduct: 1 };
  }
  const text = String(raw).trim();
  const parts = text.split(/\s*[xX]\s*/);
  const dims = [];
  let variable = false;
  let fixedProduct = 1;
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (token === '*') {
      if (index !== parts.length - 1) {
        fail('arraysize variable dimension is not last', { fieldId, arraysize: text });
      }
      variable = true;
      dims.push('*');
      continue;
    }
    if (!/^(0|[1-9]\d*)$/.test(token)) {
      fail('invalid arraysize declaration', { fieldId, arraysize: text });
    }
    const size = Number(token);
    if (!Number.isSafeInteger(size)) {
      fail('arraysize dimension is not representable', { fieldId, arraysize: text });
    }
    dims.push(size);
    if (!variable) {
      fixedProduct *= size;
      if (fixedProduct > MAX_CELL_ELEMENTS) {
        fail('declared arraysize exceeds the per-cell element budget', {
          fieldId, arraysize: text, limit: MAX_CELL_ELEMENTS,
        });
      }
    }
  }
  return { scalar: false, variable, dims, fixedProduct };
}

export function prepareField(descriptor) {
  const fieldId = descriptor.fieldId;
  const datatype = descriptor.datatype;
  if (!datatype) fail('FIELD lacks a datatype declaration', { fieldId });
  if (!SUPPORTED_DATATYPES.has(datatype)) {
    fail(`unsupported FIELD datatype: ${datatype}`, { fieldId, datatype });
  }
  const shape = parseArraySize(descriptor.arraysize, fieldId);
  return { fieldId, datatype, ...shape };
}

function numericToken(datatype, token, boundary) {
  switch (datatype) {
    case 'int': {
      if (!/^[+-]?\d+$/.test(token)) {
        fail('invalid integer text', { ...boundary, text: token });
      }
      const big = BigInt(token);
      if (big < BigInt(INT32_MIN) || big > BigInt(INT32_MAX)) {
        fail('integer exceeds the declared int range', { ...boundary, text: token });
      }
      return Number(big);
    }
    case 'long': {
      if (!/^[+-]?\d+$/.test(token)) {
        fail('invalid long integer text', { ...boundary, text: token });
      }
      const big = BigInt(token);
      if (big < INT64_MIN || big > INT64_MAX) {
        fail('long integer exceeds the 64-bit range', { ...boundary, text: token });
      }
      // Long values are always decimal strings so 64-bit identity is not lost.
      return big.toString();
    }
    case 'float':
    case 'double': {
      if (/^[+-]?(nan|inf|infinity)$/i.test(token)) {
        // A non-finite IEEE value is not a missing value; keep it distinct.
        const negative = token.startsWith('-');
        const nan = /nan/i.test(token);
        return nan ? 'NaN' : (negative ? '-Infinity' : 'Infinity');
      }
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
        fail('invalid floating point text', { ...boundary, text: token });
      }
      const value = Number(token);
      if (!Number.isFinite(value)) {
        fail('floating point text is not representable', { ...boundary, text: token });
      }
      return value;
    }
    case 'boolean': {
      const lowered = token.toLowerCase();
      if (token === 'T' || lowered === 'true' || token === '1') return true;
      if (token === 'F' || lowered === 'false' || token === '0') return false;
      fail('invalid boolean text', { ...boundary, text: token });
      break;
    }
    default:
      fail('unsupported scalar datatype', { ...boundary, datatype });
  }
}

// TABLEDATA cell interpretation. The raw TD text is retained separately by
// the caller as evidence; this function only derives value/isNull.
export function decodeTextCell(meta, raw, boundary) {
  if (typeof raw !== 'string') fail('missing TD text', boundary);
  if (raw.length > MAX_CELL_BYTES) {
    fail('TD text exceeds the per-cell byte budget', { ...boundary, limit: MAX_CELL_BYTES });
  }
  const datatype = meta.datatype;
  if (isCharacterType(datatype)) {
    if (meta.scalar) {
      if (raw === '') return { value: null, isNull: true };
      if ([...raw].length !== 1) {
        fail('character value exceeds the declared scalar', { ...boundary, textLength: [...raw].length });
      }
      return { value: raw, isNull: false };
    }
    if (meta.variable) {
      // A variable-length character cell is a string. An empty TD is empty
      // text, not a missing scalar.
      return { value: raw, isNull: false };
    }
    if (raw === '') return { value: null, isNull: true };
    const length = [...raw].length;
    if (length > meta.fixedProduct) {
      fail('character value exceeds the declared arraysize', {
        ...boundary, declared: meta.fixedProduct, textLength: length,
      });
    }
    return { value: raw, isNull: false };
  }

  if (meta.scalar) {
    const text = raw.trim();
    if (text === '') return { value: null, isNull: true };
    return { value: numericToken(datatype, text, boundary), isNull: false };
  }

  const text = raw.trim();
  if (text === '') {
    // Variable numeric arrays have a real empty-array value; fixed arrays
    // have no supplied elements and are marked missing.
    if (meta.variable) return { value: [], isNull: false };
    return { value: null, isNull: true };
  }
  const tokens = text.split(/\s+/);
  if (tokens.length > MAX_CELL_ELEMENTS) {
    fail('array value exceeds the per-cell element budget', {
      ...boundary, limit: MAX_CELL_ELEMENTS,
    });
  }
  if (meta.variable) {
    if (meta.fixedProduct > 1 && tokens.length % meta.fixedProduct !== 0) {
      fail('array length does not match the declared dimensions', {
        ...boundary, declaredLeadingProduct: meta.fixedProduct, length: tokens.length,
      });
    }
  } else if (tokens.length !== meta.fixedProduct) {
    fail('array length does not match the declared arraysize', {
      ...boundary, declared: meta.fixedProduct, length: tokens.length,
    });
  }
  return {
    value: tokens.map(token => numericToken(datatype, token, boundary)),
    isNull: false,
  };
}

class Reader {
  constructor(buffer, streamLocator, startRowIndex) {
    this.buffer = buffer;
    this.offset = 0;
    this.stream = streamLocator;
    this.startRowIndex = startRowIndex;
  }

  need(length, boundary) {
    if (length < 0 || this.offset + length > this.buffer.length) {
      fail('BINARY2 payload ends before the declared field data', {
        stream: this.stream,
        ...boundary,
        byteOffset: this.offset,
        neededBytes: length,
        availableBytes: this.buffer.length - this.offset,
      });
    }
  }

  bytes(length, boundary) {
    this.need(length, boundary);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(length, boundary) {
    this.need(length, boundary);
    this.offset += length;
  }

  u8(boundary) {
    this.need(1, boundary);
    return this.buffer[this.offset++];
  }

  i32(boundary) {
    this.need(4, boundary);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  i64(boundary) {
    this.need(8, boundary);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  f32(boundary) {
    this.need(4, boundary);
    const value = this.buffer.readFloatBE(this.offset);
    this.offset += 4;
    return value;
  }

  f64(boundary) {
    this.need(8, boundary);
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes, boundary) {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    fail('invalid UTF-8 in unicodeChar value', boundary);
  }
}

function readUtf8Character(reader, boundary) {
  const first = reader.buffer[reader.offset];
  if (first === undefined) reader.need(1, boundary);
  let width;
  if (first < 0x80) width = 1;
  else if ((first & 0xe0) === 0xc0) width = 2;
  else if ((first & 0xf0) === 0xe0) width = 3;
  else if ((first & 0xf8) === 0xf0) width = 4;
  else fail('invalid UTF-8 lead byte in unicodeChar value', { ...boundary, byteOffset: reader.offset });
  const bytes = reader.bytes(width, boundary);
  const text = decodeUtf8(bytes, boundary);
  if ([...text].length !== 1) fail('invalid UTF-8 sequence in unicodeChar value', boundary);
  return text;
}

function readFixedCharacters(reader, count, datatype, boundary) {
  if (datatype === 'char') {
    // Exactly `count` bytes are consumed whatever the content is. NUL is
    // padding in the fixed representation and is not a missing value.
    const bytes = reader.bytes(count, boundary);
    return bytes.toString('latin1').replace(/\u0000+$/, '');
  }
  let text = '';
  for (let index = 0; index < count; index += 1) text += readUtf8Character(reader, boundary);
  return text.replace(/\u0000+$/, '');
}

function binaryFloat(value) {
  if (Number.isFinite(value)) return value;
  if (Number.isNaN(value)) return 'NaN';
  return value > 0 ? 'Infinity' : '-Infinity';
}

function checkVariableCount(count, boundary) {
  if (count < 0) {
    fail('negative variable-length count', { ...boundary, count });
  }
}

// A variable-length character cell has one length prefix. With a leading
// fixed dimension ("2x*") that prefix counts cells of the declared leading
// shape, so the element count is fixedProduct * count. For char each element
// is one byte; for unicodeChar each element is one UTF-8 character, so the
// byte width is only known after reading them.
//
// NOTE: the exact meaning of the count prefix for multi-dimensional arrays is
// not settled by the station's contract wording alone; it is implemented as
// "count of declared leading-shape cells". Any document that contradicts this
// fails its row alignment and therefore lands in `pending`, never misaligned.
function characterElementCount(meta, count, boundary) {
  const total = meta.fixedProduct * count;
  if (!Number.isSafeInteger(total) || total > MAX_CELL_BYTES) {
    fail('variable-length character value exceeds the per-cell byte budget', {
      ...boundary, declared: meta.dims, count, limit: MAX_CELL_BYTES,
    });
  }
  return total;
}

function readVariableString(reader, meta, datatype, boundary) {
  const count = reader.i32(boundary);
  checkVariableCount(count, boundary);
  const total = characterElementCount(meta, count, boundary);
  if (datatype === 'char') return reader.bytes(total, boundary).toString('latin1');
  let text = '';
  for (let index = 0; index < total; index += 1) text += readUtf8Character(reader, boundary);
  return text;
}

function skipVariableString(reader, meta, datatype, boundary) {
  const count = reader.i32(boundary);
  checkVariableCount(count, boundary);
  const total = characterElementCount(meta, count, boundary);
  if (datatype === 'char') {
    reader.skip(total, boundary);
    return;
  }
  for (let index = 0; index < total; index += 1) readUtf8Character(reader, boundary);
}

function arrayTotal(meta, count, boundary) {
  let total;
  if (meta.variable) {
    total = meta.fixedProduct * count;
  } else {
    total = meta.fixedProduct;
  }
  if (!Number.isSafeInteger(total) || total > MAX_CELL_ELEMENTS) {
    fail('array length exceeds the per-cell element budget', {
      ...boundary, declared: meta.dims, count, limit: MAX_CELL_ELEMENTS,
    });
  }
  return total;
}

function readNumericArray(reader, meta, boundary) {
  const size = elementSize(meta.datatype);
  let total;
  if (meta.variable) {
    const count = reader.i32(boundary);
    checkVariableCount(count, boundary);
    total = arrayTotal(meta, count, boundary);
  } else {
    total = arrayTotal(meta, 0, boundary);
  }
  const bytes = total * size;
  reader.need(bytes, boundary);
  const values = new Array(total);
  for (let index = 0; index < total; index += 1) {
    switch (meta.datatype) {
      case 'int': values[index] = reader.i32(boundary); break;
      case 'long': values[index] = reader.i64(boundary).toString(); break;
      case 'float': values[index] = binaryFloat(reader.f32(boundary)); break;
      case 'double': values[index] = binaryFloat(reader.f64(boundary)); break;
      case 'boolean': {
        const byte = reader.u8(boundary);
        if (byte !== 0 && byte !== 1) {
          fail('invalid boolean byte in BINARY2 value', { ...boundary, byte });
        }
        values[index] = byte === 1;
        break;
      }
      default: fail('unsupported array datatype', boundary);
    }
  }
  return values;
}

function skipNumericArray(reader, meta, boundary) {
  const size = elementSize(meta.datatype);
  let total;
  if (meta.variable) {
    const count = reader.i32(boundary);
    checkVariableCount(count, boundary);
    // A null array still has a declared prefix; the same declaration-derived
    // budget applies so a corrupt value cannot claim an enormous range.
    total = arrayTotal(meta, count, boundary);
  } else {
    total = arrayTotal(meta, 0, boundary);
  }
  reader.skip(total * size, boundary);
}

function readBinaryValue(reader, meta, boundary) {
  const datatype = meta.datatype;
  if (meta.scalar) {
    switch (datatype) {
      case 'int': return reader.i32(boundary);
      case 'long': return reader.i64(boundary).toString();
      case 'float': return binaryFloat(reader.f32(boundary));
      case 'double': return binaryFloat(reader.f64(boundary));
      case 'boolean': {
        const byte = reader.u8(boundary);
        if (byte !== 0 && byte !== 1) {
          fail('invalid boolean byte in BINARY2 value', { ...boundary, byte });
        }
        return byte === 1;
      }
      case 'char': return reader.bytes(1, boundary).toString('latin1');
      case 'unicodeChar': return readUtf8Character(reader, boundary);
      default: fail('unsupported scalar datatype', { ...boundary, datatype });
    }
  }
  if (isCharacterType(datatype)) {
    if (meta.variable) return readVariableString(reader, meta, datatype, boundary);
    return readFixedCharacters(reader, meta.fixedProduct, datatype, boundary);
  }
  return readNumericArray(reader, meta, boundary);
}

function skipBinaryValue(reader, meta, boundary) {
  const datatype = meta.datatype;
  if (meta.scalar) {
    switch (datatype) {
      case 'int': case 'float': reader.skip(4, boundary); return;
      case 'long': case 'double': reader.skip(8, boundary); return;
      case 'boolean': case 'char': reader.skip(1, boundary); return;
      case 'unicodeChar': readUtf8Character(reader, boundary); return;
      default: fail('unsupported scalar datatype', { ...boundary, datatype });
    }
  }
  if (isCharacterType(datatype)) {
    if (meta.variable) skipVariableString(reader, meta, datatype, boundary);
    else if (datatype === 'char') reader.skip(meta.fixedProduct, boundary);
    else readFixedCharacters(reader, meta.fixedProduct, datatype, boundary);
    return;
  }
  skipNumericArray(reader, meta, boundary);
}

function defineCell(cells, fieldId, cell) {
  // Field IDs come from the file; defineProperty keeps even "__proto__"
  // as a normal own key instead of mutating the object prototype.
  Object.defineProperty(cells, fieldId, {
    value: cell, enumerable: true, writable: true, configurable: true,
  });
}

// BINARY2 rows are decoded strictly in declaration order. Every field
// consumes its full physical representation, including fields whose null
// bit is set, so the next field/row is never shifted.
export function decodeBinaryRows(metas, payload, streamLocator, startRowIndex = 0) {
  if (metas.length === 0) {
    if (payload.length === 0) return [];
    fail('BINARY2 payload exists but the TABLE declares no FIELD', {
      stream: streamLocator, availableBytes: payload.length,
    });
  }
  const reader = new Reader(payload, streamLocator, startRowIndex);
  const bitmapLength = Math.ceil(metas.length / 8);
  const rows = [];
  while (reader.offset < payload.length) {
    const rowIndex = startRowIndex + rows.length;
    if (rowIndex >= MAX_ROWS) {
      fail('row budget exceeded', {
        stream: streamLocator, rowIndex, limit: MAX_ROWS, byteOffset: reader.offset,
      });
    }
    const rowStart = reader.offset;
    if (payload.length - rowStart < bitmapLength) {
      fail('BINARY2 row null bitmap is truncated', {
        stream: streamLocator, rowIndex, byteOffset: rowStart,
        neededBytes: bitmapLength, availableBytes: payload.length - rowStart,
      });
    }
    const bitmap = Buffer.from(reader.bytes(bitmapLength, { rowIndex }));
    const cells = {};
    for (let index = 0; index < metas.length; index += 1) {
      const meta = metas[index];
      const isNull = (bitmap[index >> 3] & (0x80 >> (index & 7))) !== 0;
      const boundary = { stream: streamLocator, rowIndex, fieldId: meta.fieldId };
      const cellStart = reader.offset;
      let value = null;
      if (isNull) skipBinaryValue(reader, meta, boundary);
      else value = readBinaryValue(reader, meta, boundary);
      const cellEnd = reader.offset;
      defineCell(cells, meta.fieldId, {
        fieldId: meta.fieldId,
        value: isNull ? null : value,
        isNull,
        byteRange: [cellStart, cellEnd],
        evidence: {
          kind: 'BINARY2',
          stream: streamLocator,
          byteRange: [cellStart, cellEnd],
        },
      });
    }
    const rowEnd = reader.offset;
    if (rowEnd === rowStart) {
      fail('BINARY2 row consumed no bytes', { stream: streamLocator, rowIndex });
    }
    rows.push({
      rowIndex,
      evidence: {
        kind: 'BINARY2',
        stream: streamLocator,
        rowByteRange: [rowStart, rowEnd],
        nullBitmap: { offset: rowStart, length: bitmapLength, bytes: [...bitmap] },
      },
      cells,
    });
  }
  return rows;
}

export function defineContextValue(target, name, value) {
  Object.defineProperty(target, name, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

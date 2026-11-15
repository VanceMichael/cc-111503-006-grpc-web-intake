import { serve } from './http.mjs';

function head(major, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('fixture length is not supported');
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const result = Buffer.alloc(5); result[0] = (major << 5) | 26; result.writeUInt32BE(value, 1); return result;
}

export function encodeCbor(value) {
  if (typeof value === 'boolean') return Buffer.from([value ? 245 : 244]);
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
    const result = Buffer.alloc(9); result[0] = 251; result.writeDoubleBE(value, 1); return result;
  }
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])]);
  throw new Error('fixture value is not supported');
}

const labels = new Map([['bver', -1], ['bn', -2], ['bt', -3], ['bu', -4], ['bv', -5], ['bs', -6],
  ['n', 0], ['u', 1], ['v', 2], ['vs', 3], ['vb', 4], ['s', 5], ['t', 6], ['ut', 7], ['vd', 8]]);

export function encodePack(records, representation) {
  if (representation === 'json') return Buffer.from(JSON.stringify(records.map(record => Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('base64url') : value])))));
  return encodeCbor(records.map(record => new Map(Object.entries(record).map(([key, value]) => [labels.get(key) ?? key, value]))));
}

export function samplePacks(scenario = 'normal') {
  const first = [
    { bn: 'urn:station:A:', bt: 1700000000, bu: 'Cel', bv: 10, n: 'temperature', v: 1.5, t: -2 },
    { n: 'alarm', vb: true, u: '/' },
    { bn: 'urn:station:B:', bt: 1700000100, bu: 'V', bv: 0, n: 'voltage', v: 3, t: 0 },
  ];
  if (scenario === 'required-extension') first[1] = { n: 'alarm', vb: true, 'policy_': 1 };
  if (scenario === 'conflicting-values') first[1] = { n: 'alarm', vb: true, v: 1 };
  if (scenario === 'unsupported-version') first[0].bver = 11;
  if (scenario === 'unknown-optional') first[1].displayHint = 'red';
  return [first, [
    { bn: 'urn:station:C:', n: 'temperature', v: 8, t: -5, u: 'Cel' },
    { n: 'note', vs: '需复核' },
    { n: 'payload', vd: Buffer.from([0, 255, 17]) },
  ]];
}

export async function senmlFixture(scenario = 'normal', representation = 'cbor') {
  const requests = [];
  const packs = samplePacks(scenario);
  const source = await serve(async (request, response) => {
    requests.push(request.url);
    const index = request.url === '/pack/one' ? 0 : request.url === '/pack/two' ? 1 : -1;
    if (index < 0) { response.writeHead(404); response.end(); return; }
    let bytes = encodePack(packs[index], representation);
    if (scenario === 'truncated' && index === 0) bytes = bytes.subarray(0, bytes.length - 2);
    response.writeHead(200, { 'content-type': representation === 'json' ? 'application/senml+json' : 'application/senml+cbor' });
    for (let offset = 0; offset < bytes.length; offset += 3) {
      response.write(bytes.subarray(offset, offset + 3));
      await new Promise(resolve => setImmediate(resolve));
    }
    response.end();
  });
  return { ...source, packs: [{ id: 'one', path: '/pack/one' }, { id: 'two', path: '/pack/two' }], requests };
}

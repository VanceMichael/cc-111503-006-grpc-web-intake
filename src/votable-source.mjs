import { serve } from './http.mjs';

function integer(value, width) {
  const bytes = Buffer.alloc(width);
  if (width === 8) bytes.writeBigInt64BE(BigInt(value));
  else bytes.writeInt32BE(value);
  return bytes;
}

export function binaryRow(identifier, values, nullArray = false) {
  return Buffer.concat([Buffer.from([nullArray ? 64 : 0]), integer(identifier, 8),
    integer(values.length, 4), ...values.map(value => integer(value, 4))]);
}

export function votableDocument(scenario = 'normal') {
  let payload = Buffer.concat([
    binaryRow('9007199254740993', [4, 5], true),
    binaryRow('9007199254740994', [], false),
    binaryRow('9007199254740995', [0, -2], false),
  ]);
  if (scenario === 'truncated') payload = payload.subarray(0, payload.length - 1);
  if (scenario === 'bad-count') payload.writeInt32BE(-1, 9);
  const reference = scenario === 'missing-reference' ? 'missing-field' : 'samples';
  const binary = scenario === 'tabledata'
    ? '<TABLEDATA><TR><TD>9007199254740993</TD><TD/></TR><TR><TD>9007199254740994</TD><TD></TD></TR><TR><TD>9007199254740995</TD><TD>0 -2</TD></TR></TABLEDATA>'
    : '<BINARY2><STREAM encoding="base64">' + payload.toString('base64') + '</STREAM></BINARY2>';
  return `<?xml version="1.0"?><VOTABLE xmlns="http://www.ivoa.net/xml/VOTable/v1.3" version="1.4">
  <RESOURCE ID="catalogue" type="results"><PARAM name="release" datatype="char" arraysize="*" value="2026A"/>
    <TABLE ID="primary" name="targets">
      <FIELD ID="target-id" name="value" datatype="long" ucd="meta.id;meta.main"/>
      <FIELD ID="samples" name="value" datatype="int" arraysize="*" unit="adu"/>
      <GROUP name="measurement"><FIELDref ref="${reference}"/></GROUP>
      <DATA>${binary}</DATA>
    </TABLE>
    <RESOURCE ID="crossmatch"><PARAM name="release" datatype="char" arraysize="*" value="2026B"/>
      <TABLE ID="matches" name="targets"><FIELD ID="match-id" name="value" datatype="long"/>
        <FIELD ID="separation" name="value" datatype="double" unit="arcsec"/>
        <DATA><TABLEDATA><TR><TD>9007199254740993</TD><TD>0</TD></TR></TABLEDATA></DATA>
      </TABLE>
    </RESOURCE>
  </RESOURCE></VOTABLE>`;
}

export async function votableFixture(scenario = 'normal') {
  const requests = [];
  const source = await serve(async (request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/x-votable+xml; charset=utf-8' });
    const bytes = Buffer.from(votableDocument(scenario));
    for (let offset = 0; offset < bytes.length; offset += 11) {
      response.write(bytes.subarray(offset, offset + 11));
      await new Promise(resolve => setImmediate(resolve));
    }
    response.end();
  });
  return { ...source, path: '/catalogue', requests, deliveryId: 'catalogue-2026A' };
}

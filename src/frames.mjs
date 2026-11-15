export function frame(flag, payload) {
  const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
export function splitComplete(bytes) {
  const frames = []; let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 5) throw new Error('incomplete frame header');
    const length = bytes.readUInt32BE(offset + 1);
    if (length > bytes.length - offset - 5) throw new Error('incomplete frame payload');
    frames.push({ flag: bytes[offset], payload: bytes.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return frames;
}
export function inspection(recordId, result, sourceRevision) {
  const fields = [recordId, result, sourceRevision];
  return Buffer.concat(fields.map((value, index) => {
    const bytes = Buffer.from(value); if (bytes.length > 127) throw new Error('fixture string too long');
    return Buffer.concat([Buffer.from([((index + 1) << 3) | 2, bytes.length]), bytes]);
  }));
}

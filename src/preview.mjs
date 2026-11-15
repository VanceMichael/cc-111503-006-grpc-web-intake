import { splitComplete } from './frames.mjs';

export async function preview(source, store) {
  const response = await fetch(source.url + source.path, { method: 'POST', body: source.queryId });
  const bytes = Buffer.from(await response.arrayBuffer());
  const evidence = store.saveEvidence('rpc-wire', { queryId: source.queryId, contentType: response.headers.get('content-type') }, bytes);
  if (response.headers.get('content-type').includes('text')) return { mode: 'wire-preview', evidence, physicalBytes: bytes.length };
  const frames = splitComplete(bytes);
  return { mode: 'frame-preview', evidence, frames: frames.map(part => ({ flag: part.flag, size: part.payload.length })) };
}

export async function previewPack(source, store) {
  const pack = source.packs[0];
  const response = await fetch(source.url + pack.path);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mediaType = response.headers.get('content-type');
  const evidence = store.saveEvidence('senml-pack', { packId: pack.id, mediaType, url: response.url }, bytes);
  return { mode: 'senml-wire-preview', packId: pack.id, mediaType, bytes: bytes.length, evidence };
}

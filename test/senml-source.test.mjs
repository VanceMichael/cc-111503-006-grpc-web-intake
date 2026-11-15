import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCbor, encodePack, samplePacks, senmlFixture } from '../src/senml-source.mjs';
import { previewPack } from '../src/senml-preview.mjs';
import { Inbox } from '../src/store.mjs';

test('来源 CBOR 编码采用标准主要类型与整数标签', () => {
  assert.equal(encodeCbor(new Map([[-2, 'A'], [2, 1.5]])).toString('hex'), 'a221614102fb3ff8000000000000');
  assert.equal(encodeCbor(Buffer.from([0, 255])).toString('hex'), '4200ff');
  const json = JSON.parse(encodePack(samplePacks()[1], 'json').toString());
  assert.equal(json[2].vd, 'AP8R');
  assert.equal(json[1].vs, '需复核');
});

test('真实来源按媒体类型返回原件，预览不伪称已解析读数', async () => {
  for (const representation of ['json', 'cbor']) {
    const source = await senmlFixture('normal', representation);
    const store = new Inbox();
    try {
      const result = await previewPack(source, store);
      assert.equal(result.mode, 'senml-wire-preview');
      assert.equal(result.mediaType, 'application/senml+' + representation);
      assert.ok(result.bytes > 40);
      assert.equal(store.evidence().length, 1);
      assert.deepEqual(source.requests, ['/pack/one']);
    } finally { store.close(); await source.close(); }
  }
});

test('每包独立声明基准，异常来源保留原始冲突', () => {
  assert.equal(samplePacks()[1][0].bt, undefined);
  assert.equal(samplePacks('required-extension')[0][1].policy_, 1);
  assert.equal(samplePacks('unsupported-version')[0][0].bver, 11);
  assert.equal(samplePacks('conflicting-values')[0][1].vb, true);
});

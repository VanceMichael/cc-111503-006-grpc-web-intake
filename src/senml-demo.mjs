import { senmlFixture } from './senml-source.mjs';
import { previewPack } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await senmlFixture();
const store = new Inbox();
try { console.log(JSON.stringify({ result: await previewPack(source, store), evidence: store.evidence() }, null, 2)); }
finally { store.close(); await source.close(); }

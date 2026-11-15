import { votableFixture } from './votable-source.mjs';
import { previewTable } from './intake.mjs';
import { Inbox } from './store.mjs';

const source = await votableFixture();
const store = new Inbox();
try { console.log(JSON.stringify({ result: await previewTable(source, store), evidence: store.evidence() }, null, 2)); }
finally { store.close(); await source.close(); }

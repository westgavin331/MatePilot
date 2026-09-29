// Step 2 test: list every part in an assembly and whether it's a bolt.
import { urlFromArgs } from '../src/url.js';
import { getAssemblyDefinition, flattenParts } from '../src/assembly.js';
import { classifyOccurrences } from '../src/bolts.js';

try {
  const ctx = urlFromArgs();
  const occ = await classifyOccurrences(flattenParts(await getAssemblyDefinition(ctx)));
  console.log(`${occ.length} part instances, ${occ.filter((o) => o.isBolt).length} bolts\n`);
  console.table(
    occ.map((o) => ({ bolt: o.isBolt ? 'BOLT' : '', instance: o.name, description: o.description || o.metadataError || '(none)' }))
  );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

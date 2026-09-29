// Step 7 for real: creates the fastened mates in the given assembly.
// Requires --yes. Each mate verifies nothing moved, and undoes itself if something did.
import { urlFromArgs } from '../src/url.js';
import { scanAssembly } from '../src/pipeline.js';
import { createFastenedMates } from '../src/mates.js';

if (!process.argv.includes('--yes')) {
  console.error('This writes to Onshape. Add --yes to confirm.');
  process.exit(1);
}

try {
  const ctx = urlFromArgs();
  const r = await scanAssembly(ctx, console.log);
  const pairs = r.matches.map((m) => ({ bolt: m.bolt, hole: m.primary.hole }));
  console.log(`Creating ${pairs.length} mate(s)...`);
  const { batchId, results, error } = await createFastenedMates(ctx, pairs, { dryRun: false, log: console.log });
  console.log(`batch ${batchId}`, JSON.stringify(results, null, 2));
  if (error) process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

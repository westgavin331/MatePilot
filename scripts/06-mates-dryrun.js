// Step 7 test (safe): prints the exact requests that WOULD create the mates. Sends nothing.
import { urlFromArgs } from '../src/url.js';
import { scanAssembly } from '../src/pipeline.js';
import { createFastenedMates } from '../src/mates.js';

try {
  const ctx = urlFromArgs();
  const r = await scanAssembly(ctx, console.log);
  const pairs = r.matches.map((m) => ({ bolt: m.bolt, hole: m.primary.hole }));
  const { results: requests } = await createFastenedMates(ctx, pairs.slice(0, 1), { dryRun: true, log: console.log });
  console.log(`\n${pairs.length} mates would be created. Requests for the first one:\n`);
  console.log(JSON.stringify(requests, null, 2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

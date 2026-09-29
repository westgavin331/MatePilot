// Step 4 test: match every bolt in the assembly to the holes it sits in.
import { urlFromArgs } from '../src/url.js';
import { scanAssembly } from '../src/pipeline.js';
import { mm } from '../src/match.js';

try {
  const r = await scanAssembly(urlFromArgs(), console.log);
  for (const e of r.geometryErrors) console.warn('Could not read geometry:', e);

  console.log(`\n=== ${r.matches.length} bolts matched ===`);
  r.matches.forEach((m, i) => {
    console.log(`${i + 1}. ${m.bolt.occ.name}  (shaft Ø${mm(m.bolt.world.radius * 2)})`);
    m.holes.forEach(({ hole, check }, j) =>
      console.log(`     ${j === 0 ? '→ mate to' : '  also in '} ${hole.occ.name}  hole Ø${mm(hole.world.radius * 2)}, clearance ${mm(check.clearance)}, axis off by ${mm(check.distance)}`)
    );
  });

  if (r.unmatchedBolts.length) {
    console.log(`\n=== ${r.unmatchedBolts.length} bolts with no hole ===`);
    for (const b of r.unmatchedBolts) console.log(`  ${b.occ.name}`);
  }
  if (r.nearMisses.length) {
    console.log(`\n=== Near misses (lined up, but rejected) ===`);
    for (const n of r.nearMisses) console.log(`  ${n.bolt.occ.name} ↔ ${n.hole.occ.name}: ${n.check.reason}`);
  }
  if (r.boltsWithoutShaft.length) console.log(`\nBolts with no readable shaft: ${r.boltsWithoutShaft.map((o) => o.name).join(', ')}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

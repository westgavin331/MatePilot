// Read-only: asks Onshape for the exact parameter ids of the assembly "mateConnector"
// and "mate" features, and prints any existing mates in the assembly as JSON examples.
// Used to double-check the ids in src/mates.js before creating anything.
import { urlFromArgs } from '../src/url.js';
import { get } from '../src/onshape.js';
import { PARAMS } from '../src/mates.js';

try {
  const { documentId, wvmType, wvmId, elementId } = urlFromArgs();
  const base = `/assemblies/d/${documentId}/${wvmType}/${wvmId}/e/${elementId}`;

  const specs = await get(`${base}/featurespecs`);
  for (const type of ['mateConnector', 'mate']) {
    const spec = specs.featureSpecs?.find((s) => s.featureType === type);
    console.log(`\n${type} parameters:`);
    for (const p of spec?.parameters ?? []) console.log(`  ${p.parameterId.padEnd(24)} ${p.parameterName ?? ''}  (${p.btType})`);
  }

  const ids = new Set(
    specs.featureSpecs?.filter((s) => ['mateConnector', 'mate'].includes(s.featureType)).flatMap((s) => s.parameters.map((p) => p.parameterId))
  );
  console.log('\nChecking the ids MatePilot uses:');
  for (const [k, v] of Object.entries(PARAMS)) console.log(`  ${ids.has(v) ? 'OK     ' : 'MISSING'} ${k} = ${v}`);

  const { features } = await get(`${base}/features`);
  const examples = features.filter((f) => f.featureType === 'mate' || f.featureType === 'mateConnector').slice(0, 3);
  console.log(`\n${examples.length ? 'Existing mate features (for reference):' : 'No existing mates in this assembly to compare with.'}`);
  for (const f of examples) console.log(JSON.stringify(f, null, 2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

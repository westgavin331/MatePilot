// Step 1 test: can we talk to Onshape with the API keys?
import { get } from '../src/onshape.js';

try {
  const res = await get('/documents', { limit: 5, sortColumn: 'modifiedAt', sortOrder: 'desc' });
  console.log('Auth works. Your 5 most recently modified documents:');
  for (const d of res.items ?? []) console.log(`  - ${d.name}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

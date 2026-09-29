// Step 1: decide which parts are bolts, from their Description property.
import { get, pool } from './onshape.js';
import { groupByStudio, studioKey, partKey } from './assembly.js';

const BOLT_WORDS = /\b(cap\s+screws?|screws?|bolts?|shcs|bhcs|fhcs)\b/i;

export function isBoltDescription(desc) {
  return BOLT_WORDS.test(desc ?? '');
}

const propValue = (props, name) => props?.find((p) => p.name === name)?.value ?? '';

/** Returns Map(partKey -> { description, name }) for the given part refs. */
export async function getPartDescriptions(refs) {
  const result = new Map();
  const groups = [...groupByStudio(refs).values()];

  await pool(groups, 4, async ({ ref, partIds }) => {
    const base = `/metadata/d/${ref.documentId}/${ref.wvmType}/${ref.wvmId}/e/${ref.elementId}/p`;
    const query = { configuration: ref.configuration };
    try {
      // One call per Part Studio returns metadata for all its parts.
      const res = await get(base, query);
      for (const item of res.items ?? []) {
        const id = item.partId ?? decodeURIComponent(item.href?.match(/\/p\/([^/?]+)/)?.[1] ?? '');
        if (!partIds.has(id)) continue;
        result.set(`${studioKey(ref)}|${id}`, {
          description: propValue(item.properties, 'Description'),
          name: propValue(item.properties, 'Name'),
        });
      }
    } catch {
      // Fall through to per-part lookups below.
    }
    for (const partId of partIds) {
      const key = `${studioKey(ref)}|${partId}`;
      if (result.has(key)) continue;
      try {
        const item = await get(`${base}/${encodeURIComponent(partId)}`, query);
        result.set(key, {
          description: propValue(item.properties, 'Description'),
          name: propValue(item.properties, 'Name'),
        });
      } catch (e) {
        result.set(key, { description: '', name: '', error: e.message.split('\n')[0] });
      }
    }
  });
  return result;
}

/** Adds `description` and `isBolt` to each occurrence. */
export async function classifyOccurrences(occurrences) {
  const descs = await getPartDescriptions(occurrences.map((o) => o.ref));
  for (const o of occurrences) {
    const d = descs.get(partKey(o.ref)) ?? {};
    o.description = d.description ?? '';
    o.partName = d.name ?? '';
    o.metadataError = d.error;
    o.isBolt = isBoltDescription(o.description);
  }
  return occurrences;
}

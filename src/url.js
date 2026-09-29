// Turn an Onshape browser URL into its ids.
// e.g. https://cad.onshape.com/documents/<d>/w/<w>/e/<e>
const ID = /^[0-9a-f]{24}$/;

export function parseOnshapeUrl(url) {
  const m = String(url).match(/documents\/([0-9a-f]{24})\/([wvm])\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/);
  if (!m) throw new Error(`Not an Onshape element URL: ${url}\nExpected .../documents/<id>/w/<id>/e/<id>`);
  return { documentId: m[1], wvmType: m[2], wvmId: m[3], elementId: m[4] };
}

/** Validates ids coming from the browser before they go into API paths. */
export function assertIds(obj, keys) {
  for (const k of keys) {
    if (!ID.test(obj?.[k] ?? '')) throw new Error(`Invalid ${k}`);
  }
}

export function urlFromArgs() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/<script>.js "<Onshape assembly URL>"');
    process.exit(1);
  }
  return parseOnshapeUrl(arg);
}

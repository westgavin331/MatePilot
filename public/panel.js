// Panel UI. Talks only to our local server; never to Onshape's API directly.
const params = new URLSearchParams(location.search);
const ids = {
  documentId: params.get('documentId'),
  workspaceId: params.get('workspaceId'),
  elementId: params.get('elementId'),
};
const onshapeOrigin = (() => {
  try { return params.get('server') || new URL(document.referrer).origin; } catch { return 'https://cad.onshape.com'; }
})();

const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const button = form.querySelector('button');
let pendingToken = null;

function say(content, cls = 'bot') {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  if (typeof content === 'string') div.textContent = content;
  else div.append(content);
  log.append(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function toOnshape(message) {
  window.parent.postMessage({ ...message, ...ids }, onshapeOrigin);
}

async function call(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

async function scan() {
  const wait = say('Scanning the assembly… (this can take a little while on big assemblies)');
  const r = await call('/api/scan', ids);
  wait.remove();

  const box = document.createDocumentFragment();
  box.append(el('div', `Checked ${r.partCount} parts, found ${r.boltCount} unmated bolts` + (r.alreadyMated ? ` (${r.alreadyMated} already mated, skipped).` : '.')));
  if (r.pairs.length) {
    box.append(el('div', `${r.pairs.length} bolt${r.pairs.length === 1 ? '' : 's'} matched to holes (highlighted in the model):`));
    const ol = el('ol');
    for (const p of r.pairs) {
      const li = el('li', `${p.bolt} → ${p.hole} (hole Ø${p.holeDiameter}, clearance ${p.clearance})`);
      if (p.alsoThrough.length) li.append(el('div', `also passes through: ${p.alsoThrough.join(', ')}`, 'small'));
      ol.append(li);
    }
    box.append(ol);
  } else {
    box.append(el('div', 'No bolt-and-hole pairs found.'));
  }
  if (r.unmatched.length) box.append(el('div', `No hole found for: ${r.unmatched.join(', ')}`, 'small'));
  if (r.nearMisses.length) box.append(el('div', `Lined up but rejected:\n${r.nearMisses.join('\n')}`, 'small'));
  say(box);
  for (const w of r.warnings) say(w, 'bot warn');

  if (r.highlight.length) toOnshape({ messageName: 'requestSelectionHighlight', selections: r.highlight });

  pendingToken = r.token;
  if (pendingToken) {
    say(
      r.allowWrites
        ? `Create ${r.pairs.length} fastened mate${r.pairs.length === 1 ? '' : 's'}? Type "yes" or "cancel".`
        : `Type "yes" to do a DRY RUN (mate creation is switched off in .env, so nothing will change), or "cancel".`
    );
  }
}

async function confirm() {
  if (!pendingToken) return say('Nothing to confirm. Try "connect bolts to holes" first.');
  const token = pendingToken;
  pendingToken = null;
  const r = await call('/api/confirm', { token });
  if (r.kind === 'undo') {
    if (r.dryRun) return say(`Dry run: would delete ${r.wouldDelete.length} features. Nothing was changed (mate creation is off in .env).`);
    say(`Undone: deleted ${r.deleted} MatePilot features.`);
    if (r.leftover.length) say(`Could not delete: ${r.leftover.join(', ')}`, 'bot err');
    return;
  }
  say(
    r.dryRun
      ? `Dry run finished: ${r.created} mates would be created. The exact requests are printed in the server window.`
      : `Done: created ${r.created} fastened mate${r.created === 1 ? '' : 's'}.`
  );
  if (r.error) say(r.error, 'bot err');
}

async function undo() {
  const r = await call('/api/undo', ids);
  if (!r.token) return say('There is nothing from MatePilot to undo in this assembly.');
  pendingToken = r.token;
  const box = document.createDocumentFragment();
  box.append(el('div', `MatePilot's last run added ${r.mates} mate${r.mates === 1 ? '' : 's'} (${r.features.length} features):`));
  const ul = el('ul');
  for (const f of r.features) ul.append(el('li', f));
  box.append(ul);
  box.append(el('div', r.allowWrites ? 'Delete them? Type "yes" or "cancel".' : 'Type "yes" for a DRY RUN (nothing will change), or "cancel".'));
  say(box);
}

async function cancel() {
  if (pendingToken) await call('/api/cancel', { token: pendingToken });
  pendingToken = null;
  say('Cancelled. Nothing was changed.');
}

const COMMANDS = [
  { test: /\b(undo|revert)\b/i, run: undo },
  { test: /\b(connect|mate|attach|fasten|find|scan)\b.*\b(bolts?|screws?|fasteners?|holes?)\b|\bfind bolts\b/i, run: scan },
  { test: /^\s*(y|yes|yep|confirm|ok|go|do it)\s*[.!]*\s*$/i, run: confirm },
  { test: /^\s*(n|no|cancel|stop|nope)\s*[.!]*\s*$/i, run: cancel },
];

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  say(text, 'me');
  const cmd = COMMANDS.find((c) => c.test.test(text));
  if (!cmd) return say('I understand: "connect bolts to holes", "undo last batch", then "yes" or "cancel".');
  button.disabled = true;
  try {
    await cmd.run();
  } catch (e) {
    say(e.message, 'bot err');
  } finally {
    button.disabled = false;
    input.focus();
  }
});

if (!ids.documentId || !ids.workspaceId || !ids.elementId) {
  say(
    'Missing document ids in the page URL. In the Onshape extension settings, the action URL should end with:\n' +
      '?documentId={$documentId}&workspaceId={$workspaceId}&elementId={$elementId}',
    'bot err'
  );
  button.disabled = true;
} else {
  toOnshape({ messageName: 'applicationInit' });
  say('Hi! Type "connect bolts to holes" to find bolts and the holes they sit in.');
}

# MatePilot

Onshape side panel: type "connect bolts to holes", review the highlighted matches, type "yes", and fastened mates are created.

## Setup
1. Onshape → avatar → **My account → API keys → Create new API key** (Read + Write). Copy both keys.
2. Paste them into `.env` (`ONSHAPE_ACCESS_KEY`, `ONSHAPE_SECRET_KEY`). `.env` is private: never share or commit it.
3. `npm install` (once), then `npm start`.
4. Your Onshape extension's action URL should be:
   `http://localhost:3000/panel.html?documentId={$documentId}&workspaceId={$workspaceId}&elementId={$elementId}`

## Hosting on Render (permanent https address)
New → Web Service → this GitHub repo. Build command `npm install`, start command `npm start`, plan Free.
Environment variables: `ONSHAPE_AUTH_MODE=oauth`, `ONSHAPE_OAUTH_CLIENT_ID`, `ONSHAPE_OAUTH_CLIENT_SECRET`,
`SESSION_SECRET` (use Render's "Generate"), `MATEPILOT_ALLOW_WRITES`, `MATEPILOT_WRITE_DOCS`.
Leave out `PORT`, `ONSHAPE_OAUTH_REDIRECT_URI` and the API keys: Render's own address is picked up automatically.
Logins are kept in an encrypted cookie, so Render's restarts don't log anyone out.
Onshape Developer Portal (with `https://<your-app>.onrender.com`):
- OAuth redirect URL: `https://<your-app>.onrender.com/oauth/callback`
- Extension action URL: `https://<your-app>.onrender.com/panel.html?documentId={$documentId}&workspaceId={$workspaceId}&elementId={$elementId}`

## Step-by-step checks (run in this folder)
| Command | What it shows |
|---|---|
| `npm test` | Offline math tests |
| `node scripts/01-auth.js` | Keys work (lists your documents) |
| `node scripts/02-bolts.js "<assembly URL>"` | Every part, and which are bolts |
| `node scripts/03-holes.js "<assembly URL>"` | One bolt shaft + one hole, local and world coordinates |
| `node scripts/04-match.js "<assembly URL>"` | All bolt → hole matches and near misses |
| `node scripts/05-featurespecs.js "<assembly URL>"` | Read-only check of Onshape's mate parameter names |
| `node scripts/06-mates-dryrun.js "<assembly URL>"` | The exact mate requests, without sending them |

## Safety switch
Mates are only really created when `.env` has `MATEPILOT_ALLOW_WRITES=true`. Until then, "yes" in the panel is a dry run.

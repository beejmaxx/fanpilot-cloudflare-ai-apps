# Draft collaborative editor

Draft is a collaborative rich-text editor built entirely on Cloudflare. Multiple people edit through a shared Yjs document, request Llama 3.3 changes through a Workflow, and accept or reject reviewable suggestions.

Production: [editor.fanpilot.app](https://editor.fanpilot.app)

## Cloudflare architecture

- The Worker serves the React application and authenticated HTTP/WebSocket API.
- One SQLite-backed `DocumentRoom` Durable Object owns each document, participant list, Yjs history, comments, suggestions, revisions, and quotas.
- `AiEditWorkflow` coordinates Workers AI requests using Llama 3.3 and commits validated suggestions back to the room.
- Managed Turnstile verifies new-document creation. The secret remains in the Worker secret store; the browser receives only the public site key.
- A Worker Rate Limiting binding allows ten verified document creations per client address per minute. Turnstile and this limit run only on `POST /api/documents`; opening, joining, editing, and AI review do not show challenges.
- Participant identities use private, revocable return links. Access tokens stay in URL fragments and are stored as hashes by the Durable Object.

## Run locally

Use Node 26.8.2 from the repository root:

```bash
npm install
npm run dev:editor
```

Open the Vite URL shown in the terminal. Localhost automatically uses Cloudflare's published Turnstile test site key and test secret. Production credentials are never needed locally.

## Verify

```bash
npm run test:editor
npm run build:editor
npm run test:e2e:editor
```

Local E2E runs use Brave. CI installs Playwright Chromium and runs the same suite. The suite covers Turnstile enforcement and retry, creation rate limiting, collaboration, invitations, comments, AI proposals, conflict handling, access revocation, private-link behavior, persistence, and accessibility.

## Deploy

The public site key and expected hostname are non-secret Wrangler variables. Configure the matching private key once, then deploy:

```bash
cd apps/editor
npx wrangler secret put TURNSTILE_SECRET_KEY
cd ../..
npm run deploy:editor
```

The production widget is restricted to `editor.fanpilot.app`. Server-side Siteverify validation requires the expected hostname and `create-document` action before any document ID or Durable Object is allocated.

# Rally

**Make the plan, together.**

**Live demo:** [fanpilot.app](https://fanpilot.app)

Rally is an AI group planner for dinners, outings, game nights, day trips, and other small events. An organizer starts a room with one sentence, invites friends, and lets everyone contribute naturally through chat. Rally extracts the group's hard constraints and preferences, creates three viable plans, runs a vote, and preserves the final decision.

![Rally final planning room](docs/rally-room.png)

## Why this exists

Group plans often fail in the gap between conversation and decision. Preferences are scattered through chat, hard constraints are easy to miss, and nobody wants to reconcile the group manually.

Rally keeps the conversation as the input while maintaining a live, structured plan beside it. Every room is durable: participants can disconnect, refresh, and return without reconstructing what happened.

## Assignment requirements

| Requirement | Rally implementation |
| --- | --- |
| LLM | Llama 3.3 70B through Workers AI, using JSON Mode for structured extraction and proposal generation |
| Workflow / coordination | A Cloudflare Workflow creates a versioned proposal set; a Worker routes requests; one Durable Object serializes each room |
| Chat or voice input | Multi-user chat with hibernating WebSockets for realtime room updates |
| Memory or state | Durable Object SQLite for live room state and D1 for accounts, sessions, memberships, and invitations |

## Product flow

1. The organizer describes an event and verifies their email through a single-use magic link.
2. The organizer shares a separate, revocable invitation link. Participants verify their email once, then state their availability, budget, location, accessibility needs, dietary needs, and preferences.
3. Llama 3.3 converts relevant messages into structured constraints, preserving the source participant and message.
4. The organizer starts proposal generation.
5. A Workflow snapshots the room version, generates three options, and commits them only if the room has not changed underneath it.
6. Each participant casts one vote. Re-voting moves that vote.
7. The organizer confirms the final plan.
8. Chat, constraints, proposals, votes, and the final plan survive reconnects and Durable Object restarts.

## Architecture

```mermaid
flowchart LR
    UI[React chat UI] <-->|HTTP + hibernating WebSocket| W[Cloudflare Worker]
    W <--> D1[(D1 accounts + memberships)]
    W --> EMAIL[Cloudflare Email Service]
    W <--> DO[Room Durable Object]
    DO --> SQL[(Private SQLite database)]
    DO -->|structured extraction| AI[Workers AI\nLlama 3.3 70B]
    DO -->|versioned request| WF[Proposal Workflow]
    WF --> AI
    WF -->|idempotent commit| DO
```

The Durable Object is both the room's coordinator and the only process allowed to mutate its database. Important state is committed before it is broadcast. WebSocket connections use Cloudflare's Hibernation API, allowing idle rooms to sleep without disconnecting clients.

The Workflow uses a captured `state_version`. If a participant changes the room while proposals are being generated, the stale result cannot silently replace newer state. Workflow and message identifiers also make retries idempotent.

## Data model

Each room owns an independent SQLite database containing:

- `room`: stage, state version, workflow status, and final proposal;
- `participants`: role, RSVP status, and hashed room-session token;
- `messages`: durable chat history with client idempotency IDs;
- `constraints`: normalized facts linked to their source message and participant;
- `proposal_sets` and `proposals`: versioned AI-generated options;
- `votes`: one current choice per participant;
- `room_events`: an ordered audit stream;
- `workflow_runs`: durable execution references and outcomes.

New accounts use random, single-use magic-link tokens and revocable 30-day sessions. Only SHA-256 token hashes are stored in D1; browser sessions use `HttpOnly`, `Secure`, `SameSite=Lax` cookies. A unique `(room_id, user_id)` membership prevents duplicate participants across browsers and devices. Existing room-scoped tokens remain supported for rooms created before the account migration.

D1 contains `users`, `auth_challenges`, `sessions`, `rooms`, `room_memberships`, and `invitations`. Invitation URLs contain a separate random token and are not interchangeable with canonical room URLs. The room UUID identifies Durable Object state but does not grant membership.

## Local development

Requirements:

- Node.js 26.8.2 (see `.nvmrc`)
- npm
- Brave Browser for end-to-end tests
- A Cloudflare account only when exercising remote Workers AI or deploying

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

Workers AI does not have a local emulator. By default, Rally catches the unavailable binding and uses deterministic extraction and proposal fallbacks so the complete room lifecycle remains testable offline.

To use the real Llama binding during local development, authenticate Wrangler, provide a suitable `CLOUDFLARE_API_TOKEN`, and enable remote bindings:

```bash
CLOUDFLARE_REMOTE_BINDINGS=true npm run dev
```

Remote inference can consume the Workers AI allocation associated with that Cloudflare account.

## Validation

```bash
npm test
npm run build
npm run test:e2e
```

The Playwright suite launches the installed Brave executable locally and starts a dedicated Cloudflare runtime on port 4173. GitHub Actions runs the same suite in Playwright Chromium, the rendering engine Brave is built on, without installing Brave on the runner. Its ten scenarios cover the complete two-person create → join → message → Workflow → vote → finalize journey, magic-link identity restoration across fresh clients, duplicate-participant prevention, authorization and role enforcement, vote replacement, state restoration, WebSocket reconnection, concurrency, malformed input, mobile offline recovery, browser console errors, and serious accessibility violations. Local magic-link requests expose a development-only continuation URL; production responses never include the token.

Set `BRAVE_PATH` when Brave is installed somewhere other than the standard macOS or Linux location:

```bash
BRAVE_PATH=/path/to/brave npm run test:e2e
```

After deploying, run the opt-in Workers AI smoke test against the public origin. It fails if either extraction or proposal generation falls back from Workers AI:

```bash
RALLY_BASE_URL=https://fanpilot.app npm run test:smoke:remote
```

## Deployment

Enable Cloudflare Email Sending Beta for `fanpilot.app` (the Cloudflare account must have access to the service), apply the D1 migrations, then deploy the Worker, static assets, Durable Object migration, Workflow, Workers AI, D1, and email bindings:

```bash
npx wrangler email sending enable fanpilot.app
npx wrangler d1 migrations apply rally-auth --remote
npx wrangler login
npm run deploy
```

No model or email API key is stored in the application. The deployed Worker receives Workers AI and Email Service through bindings declared in [`wrangler.jsonc`](wrangler.jsonc).

## Deliberate MVP boundaries

The current product coordinates a group using their supplied constraints. It does not claim to verify venue availability, prices, reservations, or addresses. Venue search, maps, reminders, calendars, payments, and public event discovery remain outside the assignment scope.

This keeps the core demonstration focused on durable coordination: multiple users, realtime state, structured LLM output, recoverable Workflows, voting, and persistent memory.

## Project documentation

- [Product and technical design](docs/product-design.md)
- [AI prompt history](PROMPTS.md)
- [Mobile room preview](docs/rally-room-mobile.png)

The prompt history is kept chronologically because AI-assisted coding disclosure is part of the assignment.

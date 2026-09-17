# Two-app workspace and collaborative editor implementation plan

Status: implemented and deployed at https://editor.fanpilot.app.

This document records the approved design that guided implementation. The two-app workspace, editor, Cloudflare resources, automated test suite, Turnstile creation guard, and creation rate limit are now implemented.

## Product and scope

Build a collaborative writing app for small teams drafting product specs and proposals. Working name: Editor. People write together, ask AI to revise selected paragraphs or the document, and review explicit proposed changes before applying them.

Rally remains an independently functioning event-planning application. The editor becomes the primary assignment demo; the repository README introduces both.

### Required first release

- Create a titled document from a blank page or a product-spec/proposal template.
- Basic rich text: paragraphs, headings, bold, italic, simple ordered/unordered lists.
- Live collaborative typing, named cursors, selections, and presence.
- Owner, editor, and viewer access through scoped links.
- Shared AI chat with attributed requests and responses.
- Selected-paragraph rewriting and document-wide proposals.
- Before/after diffs; accept or reject individual changes and guarded Accept all.
- Paragraph comments with resolved/unresolved state; AI can propose addressing selected comments.
- Revision history, guarded reversion of accepted AI changes, and export of historical versions.
- Durable saves, honest save status, reconnect synchronization, and local pending-edit recovery.
- Markdown/plain-text export, copy, and device-local recent documents.

No pagination, tables, images, attachments, Word import, external research, email recovery, global accounts, or full offline-first product in this release. Comments anchor to paragraphs; arbitrary inline comment ranges are deferred. AI requests on a partial selection expand to its containing paragraph(s), visibly explained before submission. Reordering, inserting, and deleting document blocks through AI are deferred; humans can perform those operations normally.

## Repository organization

Use npm workspaces with one root lockfile; no additional build orchestrator initially.

```text
apps/
  rally/
    src/{client,shared,worker}/
    e2e/
    scripts/
    package.json
    wrangler.jsonc
    vite.config.ts
    playwright.config.ts
    vitest.config.ts
    tsconfig*.json
    worker-configuration.d.ts
    index.html
  editor/
    src/{client,shared,worker}/
    e2e/
    scripts/
    package.json
    wrangler.jsonc
    vite.config.ts
    playwright.config.ts
    vitest.config.ts
    tsconfig*.json
    worker-configuration.d.ts
    index.html
packages/                  Create packages only when genuine reuse exists
docs/
  rally/
  editor/
    implementation-plan.md
.github/workflows/
package.json
package-lock.json
.nvmrc
README.md
PROMPTS.md
```

Move existing Rally source, configs, scripts, and assets together. Move existing product documentation/screenshots to docs/rally and repair links. Keep root prompt history chronological. Dist, Wrangler state, TypeScript build caches, and browser artifacts stay app-local and ignored. Regenerate types/build outputs rather than moving stale generated caches. Preserve any useful local development state through a backup before adjusting its path.

Root commands should expose dev:rally, dev:editor, build, test, test:e2e:rally, test:e2e:editor, deploy:rally, and deploy:editor. Aggregate checks must never imply deploying both apps. Allocate distinct dev/test ports. Retain the existing Node version during the move.

Keep each app's permissions, schemas, API, styling, database, Workflow, and UI independent. Extract small shared utilities only after both apps need them. Avoid a generic collaboration framework or premature design system.

## Cloudflare resources and hosting

| App | Intended URL | Runtime and data |
| --- | --- | --- |
| Rally | fanpilot.app | Existing rally-planner Worker, RallyRoom namespace/migration history, proposal Workflow |
| Editor | editor.fanpilot.app | Separate Worker, DocumentRoom SQLite Durable Object namespace, AI editing Workflow |

Preserve Rally's exact Worker name, DO class name, migration tags, Workflow name, bindings, and route. A source-directory move must not create replacement resources or strand existing rooms. Keep the disconnected old D1 database untouched.

Editor receives new resource names and its own DO migration history. Verify hostname availability during implementation and configure the editor hostname without altering the apex route. Keep Cloudflare hosting; this is a Cloudflare assignment, not a Sites migration.

## Editor architecture

- React with the open-source Tiptap/ProseMirror editor and Yjs collaboration bindings.
- One DocumentRoom Durable Object per document; authenticated WebSockets carry Yjs updates and presence.
- DO SQLite stores Yjs updates/checkpoints plus server-owned metadata, permissions, chat, comments, jobs, proposals, revision history, and audit events.
- Workers AI Llama 3.3 generates schema-validated responses and proposed replacement content.
- A Cloudflare Workflow captures a fixed input snapshot, calls the model in bounded steps, validates results, and delivers proposals back to the document.
- Proposal approval is a separate server command. An optional Workflow notification can record completion, but no idle Workflow is required for every pending suggestion.

Durable Objects satisfy the coordination requirement themselves. Workflows provide useful recoverable AI jobs; they are not in the per-keystroke path. The Agents SDK is optional: use it only if its current Yjs/binary-WebSocket support reduces complexity. Do not force two competing document-state mechanisms together.

### Early technical proof before UI expansion

Prove the exact installed Tiptap/Yjs versions can:

1. Synchronize two browser editors through a Cloudflare DO.
2. Recover the identical Yjs document after a DO restart.
3. Apply a paragraph replacement server-side using the same editor schema without a browser DOM.
4. Preserve human edits elsewhere, formatting, stable block identity, and reconnect behavior.

This is a go/no-go gate. Do not implement AI by resetting the whole editor HTML or reconstructing a fresh Y.Doc. Use the existing shared types and appropriate ProseMirror/Yjs mapping. Verify library licensing and use open-source functionality; do not accidentally require a paid hosted collaboration or tracked-changes service.

## Data and protocol

Suggested per-document tables:

| Table | Purpose |
| --- | --- |
| documents | Title, content sequence, schema version, lifecycle metadata |
| participants | Display name, owner/editor/viewer role, hashed access token, revocation |
| invitations | Hashed token, granted role, expiry, revocation; never grants ownership |
| y_updates | Append-only binary updates, server sequence, authenticated sender, submission ID |
| y_checkpoints | Compacted Yjs state and covered sequence for efficient recovery |
| chat_messages | Shared prompts/responses, author, job reference, timestamps |
| comments | Stable block anchor, author, body, resolution status |
| ai_jobs | Request ID, captured input, scope, status, Workflow reference, limits, cancellation |
| suggestions | Job, target block, before-content fingerprint, proposed content, rationale, decision |
| revisions | Durable content checkpoints around accepted AI edits and named/manual snapshots |
| audit_events | Ordered server-authored records of approvals, access changes, and revisions |

Presence is ephemeral, expires on disconnect, and is separate from content. Cursor/selection anchors use Yjs relative positions instead of numeric offsets.

Every update has a client submission ID. Persist before acknowledging Saved or broadcasting. Duplicate delivery is safe; reconnect exchanges state vectors and missing updates. SQLite checkpoints and update pruning must be atomic: retain every update not included in the checkpoint. Hibernation/restart must reconstruct state before serving sockets.

Keep metadata and permissions outside the writable Y.Doc. Validate binary sizes, supported shared roots, and the resulting editor schema before accepting content updates; reject malformed data without corrupting the canonical document. Authenticated socket identity determines attribution; do not trust client-supplied Yjs IDs as user identity.

## Concurrency and AI changes

### Human collaboration

Yjs merges ordinary text operations and converges across clients. Personal undo is scoped to local editing origins; server-originated AI edits and other users' edits are excluded from personal typing undo. Different tabs get independent Yjs client IDs, even if using the same participant link.

Stable block identities survive typing. Define and test identity behavior for split, merge, paste, move, undo, and deletion. Duplicated/missing IDs must be normalized without creating conflicting client repairs. Deleted or unresolvable comment anchors are visibly marked detached.

### Generating and reviewing AI proposals

1. Flush pending edits and wait for server acknowledgement before capturing an AI request.
2. The server captures its own canonical input, target block identities, rich-content fingerprints, and content sequence.
3. The Workflow operates on that immutable snapshot. It returns bounded structured changes, not executable patches supplied directly by the model.
4. Validate allowed block IDs, editor schema, formatting, output sizes, and absence of unknown operations. Suggestions do not mutate content.
5. Persist proposals, attribute them to requester/job, and broadcast review state.
6. On acceptance, the server checks permissions, proposal status, target identity/content, and context policy again.
7. Apply a minimal Yjs transaction, persist update plus proposal decision/audit record atomically, then broadcast. Serialize this critical section without awaiting external work; a single-threaded DO alone does not prevent interleaving across awaits.

Selected-paragraph jobs remain applicable if their target rich content is unchanged. Show a context warning if content elsewhere changed. Document-wide proposals become stale after any external content edit; track already accepted patches from the same proposal batch so sequential acceptance does not invalidate its own remaining changes. Accept all is all-or-nothing after validating every pending patch.

Two simultaneous acceptances apply once. Competing proposals are revalidated. Deleted, split, merged, or altered targets require regeneration. No silent overwrite or automatic conflict resolution by another model call.

Late human updates not yet received at approval still merge via Yjs; consistency does not guarantee perfect prose or preservation of unseen semantic intent. Preserve recovery history and test this race explicitly. Never claim to eliminate this limitation.

### Undo and history

Record before/after checkpoints for accepted AI changes. Revert an AI change only if affected content still matches its accepted result; otherwise show a diff and offer export/copy of the earlier revision. Avoid unconditional whole-document restore in the MVP, which could discard concurrent work. Label audit attribution as update/command authorship, not perfect per-character authorship.

## Access and recovery

- Creator receives owner access. Invitations grant editor or viewer access.
- A private return link restores the same participant in a different browser; display names are editable and need not be unique.
- Keep secrets in URL fragments, transmit over authenticated API/WebSocket channels, store only token hashes on the server, and redact secrets from logs/test output.
- Owner can revoke participants and invitations. Participant can rotate their own token.
- Revocation/rotation closes affected sockets and stops future updates; validate permissions again on reconnect and server commands.
- Viewers can read document/chat/comments/suggestions but cannot mutate content, chat, comments, or trigger AI.
- An existing valid local participant opening an invitation gets a Continue as option, avoiding accidental duplicate joins on that device.
- Recent documents are device-local. Losing local storage and the private link means rejoining; do not imply email/account recovery exists.

Local pending updates are partitioned by document and participant. If access is revoked, do not upload recovered updates; offer export of the local draft. Clear private local data through a Forget this document action. Do not grant access based on a cached role.

## UX

Main surface: document title, save state, collaborator indicators, Share, and Ask AI. Document gets most of the screen. One optional side panel switches among shared chat, suggestions, comments, and history. Use contextual selection actions rather than permanent tool clutter.

Suggestion cards show requester, instruction, targeted paragraph, before/after diff, context warning/stale reason, and Accept/Reject. Accept buttons reflect server-confirmed outcome. Mobile uses a full-width panel/drawer rather than compressing editor and sidebar together.

Initial AI actions: clarify, shorten, change tone, identify unanswered questions, flag contradictions, and propose resolving selected comments. Distinguish advice-only replies from content-changing proposals. Treat document text as untrusted input, never as instructions to bypass application permissions.

## Limits and failures

Start with explicit configurable limits: 5 simultaneous editors, 20,000 document characters, 2,000 prompt characters, bounded binary messages, one active AI job per document, and participant/document request quotas. Match model input/output budgets to supported document size and reject oversized requests clearly rather than silently truncating.

Use durable quota accounting and a global creation/inference guard suitable for a public demo; per-document limits alone can be bypassed by creating many documents. Validate limits before model calls.

Workflow steps have bounded retry/timeouts. Cancellation is durable; late completion checks job status. Idempotency prevents duplicate proposals on retries, though an external model call may still be repeated after a failure. Production AI failures show a retryable error. Deterministic model fixtures are restricted to local/test environments and never presented as real inference.

## Delivery sequence and commit boundaries

1. **Workspace migration:** create feature branch, move Rally, repair paths/docs/CI, use root npm lockfile, run existing checks, commit reorganization alone. No production deploy needed just for a source move.
2. **Editor collaboration proof:** scaffold separate Worker/DO, prove two-client merge, durability and server-side targeted edits. Pin compatible library versions.
3. **Access and persistence:** scoped links/roles, revocation, synchronization, acknowledgements, pending-edit recovery, recent documents, export.
4. **Core writing UI:** formatting, presence, selection, paragraph identities, comments, mobile panels, accessible controls.
5. **AI and review:** shared chat, bounded Workflow generation, diffs, stale detection, exactly-once decisions, cancellation and retries.
6. **History and hardening:** guarded AI reversion, revision export, quotas, malicious inputs, crash/eviction recovery.
7. **Release verification:** complete test matrix, real Workers AI smoke, reviewer README/demo script, prompt history, clean commits and GitHub push. Deploy only editor resources to its intended subdomain when implementation/release is resumed and authorized.

Root CI runs independent Rally/editor jobs, with app-specific build/test artifacts. Local browsers use Brave; GitHub Actions uses Playwright Chromium. Keep Rally tests as a regression gate after the move. Do not rename the GitHub repository during implementation.

## Acceptance tests

### Workspace and Rally

- Clean root npm ci succeeds; both apps build and run independently on distinct ports.
- Existing Rally unit tests and all 12 E2E cases pass from the new path.
- Wrangler configuration comparison proves Rally resource identity and routes are preserved.
- App deploy commands cannot accidentally select the other app's generated Wrangler config.

### Collaboration and persistence

- Two real browser contexts edit different paragraphs and the same insertion point; states converge.
- Concurrent deletes/formatting, paragraph split/merge, paste and undo remain schema-valid.
- Duplicate/out-of-order updates, delayed updates, disconnect/reconnect and fresh-client sync converge.
- Pending edits survive reload; Saved appears only after durable acknowledgement.
- DO restart and checkpoint compaction preserve document state and history.
- Unicode, IME composition, long paragraphs and multi-tab identity work.

### Permissions

- Bare IDs/invitations cannot impersonate a participant; same names remain distinct.
- Viewers cannot mutate through either HTTP or raw WebSocket frames.
- Editor cannot grant ownership, forge approval history, or revoke another participant.
- Revocation/rotation disconnects active sockets and rejects pending/replayed access.
- Private links never appear in request URLs, referrers, logs or committed screenshots.

### AI and concurrency

- Real model generates a valid selected-paragraph proposal and document-wide proposal.
- Proposals remain separate from document until accepted; rejection changes no content.
- Changed/deleted/split targets fail safely; unrelated edits follow documented context policy.
- Concurrent acceptance, competing suggestions and repeated Workflow delivery apply at most once.
- Accept all is atomic; sequential acceptance of one proposal batch works.
- In-flight human edits during acceptance converge and recovery history is retained.
- Invalid model output, timeout, retry, quota exhaustion and cancellation are visible and safe.
- Guarded revert cannot overwrite later edits.

### UX and release

- Complete create → invite → collaborate → ask AI → review → accept → reload → export journey.
- Chat, comments and suggestion state synchronize to a second client.
- Keyboard navigation, focus handling, mobile layout and serious accessibility checks pass.
- No unexpected console errors; production smoke explicitly requires real AI success.
- Migration/deployment rollback procedure documented without deleting durable state.

## References checked during planning

- Yjs document updates: https://docs.yjs.dev/api/document-updates
- Yjs relative positions: https://docs.yjs.dev/api/relative-positions
- Yjs selective undo: https://docs.yjs.dev/api/undo-manager
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- Cloudflare Agents with Workflows: https://developers.cloudflare.com/agents/concepts/workflows/

Implementation must verify current library APIs and Cloudflare deployment behavior. Zero-traffic edge version overrides did not exercise new DO methods in the earlier Rally release; use a genuinely isolated staging Worker/DO namespace for editor integration testing instead of assuming edge version selection also switches DO execution.

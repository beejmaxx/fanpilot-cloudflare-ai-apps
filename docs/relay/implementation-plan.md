# Launch Relay: product and implementation plan

Status: implemented in `apps/relay`; deployed at https://launch.fanpilot.app.

## Product decision

Launch Relay helps small software teams turn a release into three accurate, coordinated launch posts, then keeps the campaign consistent when the release changes.

Primary user: a founder or developer who ships regularly and handles their own marketing. A teammate can review facts and copy. The initial product should work well for one person; collaboration is optional.

Core promise: **Turn what you shipped into a launch you can confidently share.**

The differentiating behavior is traceability and change propagation: factual statements reference confirmed release facts; changes invalidate affected approvals and produce reviewable revisions. A source citation demonstrates provenance, not independent truth verification.

## First release scope

Ship one complete loop:

1. Create a product workspace with name, website, audience, tone, and a short optional writing sample.
2. Paste release notes, import one exact public GitHub release URL, or paste a repository URL and let Relay select its latest published release with useful notes.
3. Review extracted facts and answer at most three prioritized clarification questions at a time through chat.
4. Confirm customer availability, launch date/time, audience, and relevant pricing or limitations.
5. Generate three posts: a LinkedIn announcement, an X announcement, and a LinkedIn feature follow-up. Channels can be changed before generation; initially support LinkedIn and single-post X text only.
6. Edit, inspect supporting facts, approve, and assign planned posting times.
7. Copy or export approved text and manually record the published URL and time.
8. Refresh the source or change a confirmed fact; see affected posts marked for review and request proposed updates.
9. Reuse product context and view past campaigns for the next release.

No direct social publishing in this release. Planned times produce an in-app "Ready to post" state, not an implied outbound post or notification. The product must explain this beside scheduling controls. An already-published post is never silently updated; source changes create a correction task.

Defer private GitHub access, GitHub Apps/webhooks, automatic polling, social OAuth, images/video, threads, email reminders, scraped websites, attribution analytics, and automatic performance optimization. Source refresh is an explicit action and the UI always shows its last checked time.

## User experience

Keep a single obvious next action on each screen.

### Workspace home

Product name, "New launch", and campaign cards grouped as In progress, Ready, and Completed. Show a short status such as "Confirm 2 facts" or "1 post needs review". Brand settings and team access are secondary actions.

### New launch

Accept a repository URL, exact release URL, or pasted notes. Repository import discovers the latest published release with useful notes, then persists its canonical release URL so source identity remains stable as later releases appear. An exact release URL pins a specific tag. A seeded demonstration can help first-time visitors, clearly labeled as sample data.

### Confirm what shipped

Show a concise release summary with editable fact cards and source excerpts. Distinguish source-backed facts, owner-provided facts, and unresolved questions. Ask availability questions explicitly: published release notes or merged code do not prove production rollout.

Minimum campaign brief: product, target audience, release availability, desired action, destination URL, and at least one confirmed user benefit or feature. Dates and prices are optional unless the campaign will mention them. Do not invent metrics, customer quotes, superlatives, or availability promises.

### Campaign review

Show three post cards with channel, purpose, planned time, and status. Open one card for editing, AI revision chat, and a collapsible "Based on" list. Explain factual blockers in ordinary language, e.g. "This says everyone has access; your release is marked private beta."

Use stages Source → Facts → Posts → Ready. Allow moving back without losing work. Scheduling, comments, and history should not become four permanent sidebars.

### Change review

Show the exact fact change and the affected posts. Offer "Propose updates" with before/after text, then accept per post. Never replace manual copy without a decision. Highlight already-published posts separately as "May need a correction".

## Example acceptance journey

Source notes describe Draft collaboration, AI rewrite suggestions, and private invitation links. The owner confirms private beta next Tuesday.

Relay produces three posts whose factual statements reference these confirmed facts. The owner approves two and assigns dates. A teammate edits the third; the owner reviews it.

The owner changes availability to next Thursday. Relay immediately blocks affected approved posts from being marked ready, preserves their previous revisions, and proposes updated copy. Unaffected text remains intact. Accepting the revisions still requires fresh approval. Refreshing or reconnecting preserves all decisions.

Use authentic release notes or explicitly labeled manual notes for our own demo. Do not invent a GitHub release just to appear integrated.

## Facts, provenance, and AI boundaries

- Store immutable source snapshots: provider, release ID/tag, canonical URL, fetched time, content hash, body, and relevant metadata.
- Each extracted fact includes a source snapshot ID and an exact excerpt. The server verifies excerpt membership. The owner can also add a fact with explicit user-provided provenance.
- Facts have stable IDs, integer revisions, confirmation state, and an actor. Editing a confirmed fact creates a new revision requiring confirmation; deletion creates a tombstone.
- Availability, audience, launch timing, and pricing are structured facts shared by all posts. Automatically attach campaign-wide availability/timing dependencies conservatively, even if the generator omits them.
- Generated post output includes text and a list of factual statements mapped to confirmed fact revisions. Reject unknown IDs, unconfirmed facts, bad excerpts, and invalid output shapes.
- Run a separate consistency check for unsupported claims and contradictions. This remains an AI-assisted check; it cannot guarantee exhaustive detection. Human approval is still required.
- Human edits trigger revalidation. Previously recorded dependencies remain until a successful new check replaces them. An unchecked edit cannot retain approval.
- Source refresh records a new snapshot and proposes fact additions/changes/removals. Conservatively mark dependencies from changed source snapshots as needing review before AI reconciliation, so the interval before analysis is safe. The owner confirms whether a source change actually changes the product fact.
- A source-backed fact does not become true merely because it was extracted. Preserve both source provenance and the owner's confirmation.
- Treat all imported text as untrusted content, never instructions that can change permissions or approve posts.
- Label model failures and offer retry. Deterministic fixtures run only in local/test mode.

## State and concurrency

Keep editorial state separate from delivery state:

| Dimension | States |
| --- | --- |
| Editorial | draft, checking, needs_changes, in_review, approved |
| Delivery | unplanned, planned, due, published, cancelled |
| Campaign | active, paused, completed, archived |

"Ready to post" is derived: approved exact text revision, current confirmed dependencies, scheduled time reached, and active campaign. A campaign pause blocks readiness but preserves its dates. Resuming does not publish anything or silently move overdue dates.

Approval records bind post revision, dependency fingerprint, channel, destination URL, and validator version. Copy changes, source/fact changes, destination changes, and channel changes invalidate approval. Changing a posting time rechecks time-sensitive statements and invalidates approval if their validity changes. Offer explicit ISO dates during drafting to reduce ambiguity around words such as "today".

Use optimistic concurrency for brief, fact, and post edits: mutations supply an expected version. A conflict returns the latest version and retains the user's unsaved text for reconciliation. Realtime notifications update collaborators. Full character-by-character collaborative editing and Yjs are unnecessary for three short posts.

AI jobs capture immutable inputs and their revision fingerprints. Completion saves a proposal only if the job is still active; it never overwrites a newer human revision. Applying a proposal rechecks its base version. Approvals, corrections, and repeated requests are idempotent.

Published records retain the exact copied/published revision. Marking published is a manual assertion with URL and timestamp, not API verification. A changed fact creates a correction task; completing that task records the user's action without claiming to edit the remote post.

## Cloudflare architecture

Workspace: `apps/relay`, package `@fanpilot/relay`, deployed independently at `launch.fanpilot.app` with its own Worker, Durable Object namespace, two Workflow bindings, migration history, and deploy command.

| Component | Responsibility |
| --- | --- |
| React application and Worker assets | Workspace, guided brief, campaign cards, chat, review, export |
| Worker API | Input validation, source fetching, routing, Turnstile, creation rate limiting |
| `LaunchWorkspace` SQLite Durable Object | One small product/team workspace: brand settings, campaigns, access, facts, posts, approvals, quotas, audit events |
| Hibernating WebSockets | Committed changes, job status, and collaborator presence |
| `ReleaseAnalysisWorkflow` | Extract proposed facts and clarification questions from an immutable source |
| `CampaignGenerationWorkflow` | Draft the three posts, validate bounded output, and return proposals |
| Workers AI | Llama 3.3 initially; isolate the model adapter so quality can be evaluated and the model changed |
| Durable Object alarm | Wake for the next planned time, recheck readiness, persist due state, then schedule the next alarm |

One Durable Object per workspace makes brand memory and cross-campaign history simple and keeps approval/invalidation transactions atomic. This is suitable for the bounded small-team proof of concept. Partitioning by campaign and a cross-workspace index can follow only if required.

All application data lives in Cloudflare Durable Object SQLite. No D1, external database, vector database, or R2 is needed for text-only v1. Store timestamps in UTC and preserve the selected IANA timezone; prompt clearly around daylight-saving ambiguity. Alarms can be late or repeated, so due checks are idempotent and also run on workspace reads. Exact-time delivery is not promised.

Workflows handle bounded analysis/generation jobs with retries and visible failures. Human approval state belongs in SQLite and can happen days later without keeping a generation Workflow open. Each external call happens outside the short transaction that commits a state transition.

### Assignment coverage

| Requirement | Implementation |
| --- | --- |
| LLM | Fact extraction, clarification chat, post generation, and consistency review |
| Workflow / coordination | Analysis/generation Workflows and workspace Durable Object |
| User input via chat or voice | AI clarification and revision chat, alongside structured forms |
| Memory / state | Durable product profile, campaign history, facts, approvals, and revision records |

## Data model

| Table | Key purpose |
| --- | --- |
| workspace | Product details, audience, tone, timezone, workspace version |
| participants / invitations | Owner/editor/viewer access, token hashes, revocation, one-time invitations |
| campaigns | Release identity, objective, availability, lifecycle state |
| source_snapshots | Immutable release bodies, hashes, metadata, fetched times |
| facts / fact_revisions | Stable identity, value, confirmation, provenance, exact source excerpt |
| posts / post_revisions | Channel, purpose, text, editorial state, immutable historical copy |
| post_dependencies | Post revision to confirmed fact revision mappings |
| validations | Checked revision, issues, model/check version, result |
| approvals | Exact revision/fingerprint, approver, timestamp, invalidation reason |
| publication_records | Planned time, manually reported published URL/time/revision |
| correction_tasks | Published revision affected by changed facts and recorded resolution |
| messages / comments | Attributed AI chat and post feedback |
| jobs | Immutable input references, Workflow ID, status, cancellation, idempotency key |
| audit_events / usage_events | Decisions, changes, and durable request budgets |

SQLite indexes support campaign listing and reverse dependency lookup. Persist mutations before broadcasting them. Preserve historical revisions rather than mutating the evidence used for an old approval.

## Source import and access

GitHub import accepts validated public repository and exact-release URLs, handles encoded tags, and constructs requests to the official GitHub API. Repository discovery selects the latest non-draft release with useful notes; when releases have no notes, it may use the latest tag and a root changelog. The chosen canonical source URL is persisted. Reject arbitrary hosts and redirects outside the allowed provider. Bound body sizes and timeouts; show rate-limit and not-found errors with paste-notes fallback. No user personal access tokens are accepted in v1.

Read the specific release by tag/ID. Persist `prerelease` and relevant timestamps; ask about availability independently. A private or deleted release becomes "Source unavailable" and retains the last stored evidence instead of being treated as unchanged.

Use the existing app pattern of scoped private return links and single-use invitations. Owner controls workspace membership, confirms facts, and approves posts; editors can edit, request AI, and comment; viewers can read. Solo owners may approve their own work. A bare workspace ID grants no access. Explain that a private return link restores the same identity; use invitations to add distinct people.

Lost tokens have no email recovery in the proof of concept. Reuse well-tested token hashing, rotation, fragment handling, and revocation patterns after reviewing their current behavior. Do not copy server secrets or share identity namespaces between apps.

## Limits and operating behavior

Initial configurable caps: 5 participants, 10 active campaigns per workspace, 3 posts per initial generation, 20,000 source characters, 2,000 chat characters, and one active AI job per campaign. Bound model input/output and retain explicit cancellation state. Cap historical context by selecting a small recent set; avoid sending every old campaign to the model.

Use Turnstile plus creation rate limits and durable per-workspace/participant AI budgets. Rate-limit expensive source fetches and generation entry points before invoking providers. Show remaining quota or reset time on exhaustion. Keep AI usage observable; do not promise the complete service will cost nothing or that per-workspace quotas impose a global spend ceiling.

Production model/Workflow errors must be visible and retryable; partial job success should preserve usable drafts with explicit per-post state. Retrying completion cannot duplicate posts or approvals. Model calls may repeat after provider/network failure, so do not claim exactly-once inference.

## Implementation phases and release gates

1. **Foundation and access:** independent workspace scaffold, product profile, token access, SQLite persistence, recent-workspace navigation, Turnstile, CI. Gate: create/join/reload/revoke in two Brave contexts.
2. **Source and confirmed facts:** paste/import, immutable snapshots, extraction Workflow, clarification chat, fact confirmation and revisions. Gate: real model extraction preserves source excerpts and never converts GitHub release status into rollout certainty.
3. **Campaign drafting:** three post cards, generation Workflow, source references, validation, manual edits, and optimistic concurrency. Gate: two users cannot silently overwrite each other's copy; late AI output cannot replace current text.
4. **Core differentiation:** dependency invalidation, version-bound approvals, source refresh, targeted revision proposals, correction tasks. Gate: changing availability blocks affected approved posts and preserves unaffected work and published history.
5. **Planning and handoff:** timezone-aware planned dates, due-state alarm, pause/resume, copy/export, manual publication records. Gate: duplicate alarms and rescheduling cannot make stale content ready.
6. **Release verification:** real Workers AI smoke, browser journeys, mobile and accessibility review, documentation, isolated deployment, and a repeatable demo using real project information.

Keep commits independently reviewable. Add app-specific root scripts and a CI job when the app exists. Keep Rally and Draft deployment/resource identities unchanged. Extract shared utilities only where their contracts genuinely match; do not undertake a collaboration framework rewrite or reuse Draft's rich-text editor wholesale.

## Required verification

- Valid, malformed, unavailable, and rate-limited GitHub imports; pasted-note fallback; exact release identity remains stable across subsequent releases.
- Unsupported facts, invented source excerpts, embedded instructions, invalid model JSON, timeouts, cancellation, and quota exhaustion.
- Fact edits/removals and refreshed source snapshots invalidate all dependent approvals; unchanged dependencies and unrelated posts are handled correctly.
- Human edits while generation/validation runs, competing edits, simultaneous approvals, repeated commands, and late Workflow completion.
- Owner/editor/viewer roles, same-name users, invitation replay, private-link restoration, token rotation, active revocation, and cross-workspace denial.
- End-to-end create → import → clarify → confirm → generate → edit → approve → plan → copy → record publication → change fact → review correction.
- Planned-time changes, DST, past dates, pause/resume, duplicate/late alarms, restarts, and reconnects.
- Small-screen layout, keyboard submission with Shift+Enter/IME handling, visible review buttons, clear failure/retry states, and serious accessibility checks.
- Local Brave, CI Chromium, plus explicit real-model production smoke. Keep fixture-based test success distinct from live provider validation.

## Planning assumptions

Default to public GitHub releases plus pasted notes, LinkedIn and X text, three posts per launch, owner approval, manual publishing, scoped-link access, and `launch.fanpilot.app`. These choices are sufficient to begin implementation if accepted. Private repositories and automatic publishing would materially change authentication and integration scope and should be planned separately.

## References checked

- [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases): release bodies, IDs/tags, timestamps, and prerelease metadata.
- [Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/): recoverable steps and event primitives.
- [Cloudflare Workflow sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/): durable waits and retries; generation jobs remain bounded in this design.

Platform limits, pricing, and model availability remain operational concerns. The implemented binding and domain configuration are the source of truth for the live deployment.

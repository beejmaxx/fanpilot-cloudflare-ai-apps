# Launch Relay AI prompt history

Status: implemented and deployed. This file is separate from the Rally and Draft histories.

## 2026-09-17 — exploration and planning

> do you think there's a good idea around social media marketing automation, something intersting we could also do? - let's consider

> consider this idea, and better ideas

> I like this idea: " Launch Relay               Small software teams                  Turn each release into an accurate, coordinated launch campaign      Understanding what actually shipped" I would use this - plan it out

Planning outcome: a focused launch campaign app using release sources, confirmed facts, three posts, reviewable AI changes, and approval invalidation when dependencies change. See the [implementation plan](implementation-plan.md). Direct social publishing is deferred in the proposed first version.

## 2026-09-17 — implementation

> impl

Implementation outcome: Launch Relay now has an independent React client and Cloudflare Worker, two Workflows, a SQLite-backed Durable Object, hibernating WebSockets, Workers AI, Turnstile, Worker Rate Limiting, Durable Object alarms, scoped access links, source-backed facts, versioned posts, approval invalidation, scheduling, manual publication records, correction tasks, tests, and deployment configuration.

## 2026-09-17 — portfolio routing

> note: when you're 100% completed with this, make fanpilot.app a page/portal describing each three apps and conformance and details relevant to the cloudflare challenge instead of relay, make rally it's own subdomain as this one will be

Implementation outcome: `fanpilot.app` became the three-application challenge portal, Rally moved to `rally.fanpilot.app`, Draft remains at `editor.fanpilot.app`, and Launch Relay uses `launch.fanpilot.app`. The portal preserves legacy Rally room and invitation paths by redirecting them to the Rally subdomain.

## 2026-09-17 — GitHub release discovery

> you should make this work with existing github releases, make it easy to select a github release for an open source product - or just even accept the github link and do the work to find the tags/changelog and generate the report/display

Implementation outcome: the GitHub input accepts either a repository or exact release URL. For a repository, Relay selects the latest non-draft release with useful notes and stores its canonical release URL. If releases lack notes, it can fall back to the latest tag plus a root changelog. The workspace displays a link to the selected source.

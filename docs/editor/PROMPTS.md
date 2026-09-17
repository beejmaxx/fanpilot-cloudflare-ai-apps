# Draft AI prompt history

These are the human prompts used to conceive, plan, implement, test, deploy, and refine the Draft collaborative editor. Shared assignment and repository prompts are in [`docs/shared/PROMPTS.md`](../shared/PROMPTS.md).

## 2026-09-17

> now that we've done this work - think of some better ideas of what we could build instead of this app that would be more interest/useful

> how about a google docs type of editor, that multiple people can use, and use the llm to make edits from? does that satisfy the requirements for this project?

> yes, ho wwill concurrent edits be handled?
> /model

> yes, ho wwill concurrent edits be handled?

> ok - can you think through the rest of the idea, are tehre any other potential holes that we need to clarify before planning/implementing?

> sounds good, plan it out, then switch to sol med to impl

> impl

> high level spot check/review

> then go back to sol high

> go ahead, e2e suite

> what is remaining? lets see what is important since this is more of a POC - but if we can utilize some of the free cloudflare tools we should consider

> ok look into turnstile, what are the implication, complications of adding it, what would change.

> ok go ahead and implement all 4 things you mentioned, get turnstile done 100% first

> [Image attached: Turnstile widget showing “Verification failed” and “Browser check could not load”.]

> when I hit enter, it doesn't submit the message in chat

> [Image attached: the AI suggestion panel with a long accepted suggestion.] I can't see the bottom buttons!

> FAILD

> [Image attached: a bare document URL opened in Incognito showing “Private link required”.] I opened the link in incognito and i see this https://editor.fanpilot.app/doc/54bdf4b1-f24b-4fae-8817-d63cebbed0af

> should we not just make the url be the private, shareable link?

> yes do that

## Resulting product decisions

- Tiptap and Yjs handle realtime rich-text convergence; one SQLite-backed Durable Object owns persistence, access, and serialized server decisions.
- Llama 3.3 produces reviewable suggestions through a Workflow. AI output cannot directly overwrite the document.
- Suggestions target stable blocks and become stale when their captured content no longer matches.
- Managed Turnstile and a Worker Rate Limiting binding protect public document creation without interrupting collaboration.
- The current participant can copy a private return link from **Share**. The browser removes secrets from the visible address bar after authentication, so a bare document URL remains intentionally inaccessible in a fresh browser.
- The detailed approved design is recorded in the [implementation plan](implementation-plan.md).

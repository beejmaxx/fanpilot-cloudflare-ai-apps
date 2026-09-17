# Rally AI prompt history

These are the human prompts used to select, design, implement, test, deploy, and refine Rally. Shared assignment and repository prompts are in [`docs/shared/PROMPTS.md`](../shared/PROMPTS.md).

## 2026-09-17

> how about an app for managing events/meetups?

> actually rally does sound interested...

> ok let's design it

> whats the data model, where does teh data live, where's the database? cloudflare?

> ok what are the costs for doing this?

> ok let me review thecurrnet plan

> ok looks good, build it

> ok looks good, build it

> don't use chrome for this - use brave if you must

> how do I test this app out?

> and what testing have you already done? any e2e tests?

> start dev server then

> ok whats thee e2e testing plan?

> ok go ahead run through them

> what else needs testing?

> yes go ahead

> it's using brave in github actions? I meant use brave for local testing

> but it's fine I suppose if it's the same as chrome on github actions

> [Temporary Cloudflare device authorization code omitted from the public history.]

> I authorized it via chrome (it was open?)

> is the testing 100% completed?

> the testing that we agreed to I mean

> can we deploy this to a public URL? do you need to use one of my existing cloudflare domains to do this?

> yes use fanpilot.app

> use the apex, doens't need to point to orbrunner

> wtf you just did it?

> [Image attached: screenshot of the Rally planning room.] the UI is a little cluttered, seems like it could be clearer/easier to use/tell what going on, it should be simple and not overwhelming to a first time user

> I thin kthe righ sidebar text could be larger/clearer

> so each time a user creates a new room? how is it linked? can they not reference it again after? what's the auth mechanism?

> can we use cloudflare for auth?

> what if two people have the same name? or what if they enter a different name after opening the link? https://fanpilot.app/room/41607f49-c304-4802-bc25-3fe804f4a3e1

> but I just used the same ID, opened in an incognito tab, it didn't recognize me as the same user, so won't hat create a new 'user' everytime the same person tries to open the page again?

> then it's broken, proprose a better design

> why not use magic link if we're going to use emails/

> yes let's do this, go ahead and implement

> after you're done with this change, make sure we commit properly with a good message to git

> ok test it out 100%

> why? email delivery should work from cloudflare, you have my cloudflare key!

> how do we make it be able to email anyone?

> so we can't make this work on the free plan then? any other way we can implement auth if we can't use email?

> I have a resend account, you can use that to set things up

> is tehr alternative for auth without email that makes sense?

> is tehr alternative for auth without email that makes sense?

> any other ideas? let's keep it simple

> yes that works, plan that out

> yes implement this - is there anything to cleanup from the old approaches? do that too

## Resulting product decisions

- Rally uses room-scoped invitation and private return links instead of accounts or email.
- Display names are presentation data; participant identities are random secrets and remain distinct when names collide.
- Secret tokens stay in URL fragments and only their SHA-256 hashes are stored.
- The room Durable Object owns persistent state and realtime coordination; a Workflow produces versioned AI proposals.
- Local end-to-end tests use Brave, while GitHub Actions uses Playwright Chromium.

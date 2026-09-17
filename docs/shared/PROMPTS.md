# Shared assignment and repository prompts

These prompts cover assignment interpretation, product discovery before an app was selected, and decisions that affect the combined repository. Product-specific prompts are recorded separately in the [Rally history](../rally/PROMPTS.md) and [Draft history](../editor/PROMPTS.md).

## 2026-09-16

> https://developers.cloudflare.com/agents/ can you read this

> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.

> here's the full context: Optional Assignment: Please share GitHub repo URL for the project here
> https://github.com/beejmaxx
> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.

> do they say what kind of ai app they want?

> give me your best ideas..

## 2026-09-17

> does it inclde all this? LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state

> any other ideas?

> what would be a cool end user product?

> make sure we have a git repo and make one on my github also

> what version of node are we on? get on latest?

> or ... reorg the code to contain both projects - advise

> yes do that, stop when done plannin

> can you make sure the github repo is properly documented for these two combined projects - also rename the repo to a more suitable name for this. what are the domains? root and editor. ?

> also make sure each app's prompts are separated proeprly

> make sure the github is presentable to cloudflare

## Repository outcomes

- The apps live in independent npm workspaces with one root lockfile and separate Cloudflare resources.
- The repository is named `fanpilot-cloudflare-ai-apps`.
- Rally is deployed at `fanpilot.app`; Draft is deployed at `editor.fanpilot.app`.
- Prompt disclosure is split into shared, Rally, and Draft histories.

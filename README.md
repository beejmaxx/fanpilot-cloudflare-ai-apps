# Fanpilot Cloudflare AI apps

This repository contains two independent Cloudflare applications in an npm workspace. Rally is the deployed group-planning app. Editor is the collaborative AI writing app described in the implementation plan and is being built as a separate application.

| App | Purpose | URL | Documentation |
| --- | --- | --- | --- |
| Rally | Realtime AI planning for groups | [fanpilot.app](https://fanpilot.app) | [App README](apps/rally/README.md) |
| Editor | Collaborative writing with reviewable AI edits | `editor.fanpilot.app` (planned) | [Implementation plan](docs/editor/implementation-plan.md) |

## Workspace commands

Use Node.js 26.8.2 from [`.nvmrc`](.nvmrc), then install once at the repository root:

```bash
npm install
```

Each app owns its source, Worker configuration, tests, and deployment command. Dependencies are recorded in the single root lockfile.

```bash
npm run dev:rally
npm run build:rally
npm run test:rally
npm run test:e2e:rally
npm run deploy:rally
```

Equivalent `:editor` commands are reserved for the Editor workspace as it is implemented. `npm run build` and `npm test` run the available checks across all workspaces; deployment is always app-specific.

Rally's production Worker name, Durable Object class and migration, Workflow name, bindings, and `fanpilot.app` route remain in [its Wrangler configuration](apps/rally/wrangler.jsonc).

The chronological [prompt history](PROMPTS.md) records the AI-assisted development process.

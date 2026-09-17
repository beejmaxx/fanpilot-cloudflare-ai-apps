# Fanpilot Cloudflare AI apps

This repository contains two independent Cloudflare applications in an npm workspace. Rally is the deployed group-planning app. Editor is the collaborative AI writing app described in the implementation plan and is being built as a separate application.

| App | Purpose | URL | Documentation |
| --- | --- | --- | --- |
| Rally | Realtime AI planning for groups | [fanpilot.app](https://fanpilot.app) | [App README](apps/rally/README.md) |
| Editor | Collaborative writing with reviewable AI edits | [editor.fanpilot.app](https://editor.fanpilot.app) | [App README](apps/editor/README.md) |

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

The same commands are available for Editor by replacing `rally` with `editor`. `npm run build` and `npm test` run checks across both workspaces; deployment is always app-specific.

Each app has independent Worker, Durable Object, Workflow, binding, and route configuration. Rally serves `fanpilot.app`; Editor serves `editor.fanpilot.app` as a Worker Custom Domain.

The chronological [prompt history](PROMPTS.md) records the AI-assisted development process.

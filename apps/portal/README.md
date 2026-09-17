# Fanpilot challenge portal

The portal at [fanpilot.app](https://fanpilot.app) presents Rally, Draft, and Launch Relay and explains how each application satisfies the Cloudflare AI application challenge. It is a small independent Worker with static React assets and no application state.

Legacy Rally paths under `/room/` and `/join/` redirect in the browser to `rally.fanpilot.app` while preserving the complete path, query, and private URL fragment.

```bash
npm run build:portal
npm run deploy:portal
```

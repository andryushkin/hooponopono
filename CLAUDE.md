# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Hooponopono meditation site on **Cloudflare Pages + Durable Objects**, TypeScript + Bun.
Migration from DigitalOcean (Python WebSocket server) is complete. Old code at `../hooponopono_old/`.

**Features:**
- Phrase synchronization — client-side, computed from unix timestamp (no server timer)
- Online counter — real WebSocket connections only (0 when nobody online)
- 12 languages, audio for EN only (sounds/hooponopono_en.m4a)
- Chrome Extension (MV3, newtab override)

## Stack

- **Runtime/package manager:** Bun
- **Hosting:** Cloudflare Pages (static) + Durable Objects (WebSocket, online counter)
- **TypeScript** throughout

## Key Commands

```bash
bun run build          # Build everything: frontend + worker (_worker.js) + extension
bun run build:frontend # dist/ — HTML/CSS/JS/sounds/phrases.json
bun run build:worker   # dist/_worker.js — Pages worker bundle (ESM)
bun run build:ext      # extension/dist/ — Chrome Extension bundle
bun run dev            # build + wrangler pages dev dist (local, with DO)
bun run deploy         # build:frontend + build:worker + wrangler pages deploy
bun run type-check     # tsc --noEmit for BOTH tsconfigs (worker + frontend)
```

## Architecture

```
src/
  frontend/
    script.ts        # Phrase sync (setInterval 200ms), WebSocket (online_count only)
    index.html       # No modal, no StatCounter
    style.css        # No modal CSS
    newtab.html      # Chrome Extension newtab
    tsconfig.json    # lib: ["DOM"], resolveJsonModule: true — NO workers-types
  worker/
    index.ts         # Pages worker: /ws → HoopRoom DO, else → ASSETS.fetch
    hoop-room.ts     # Durable Object: Hibernation API, broadcasts online count
    tsconfig.json    # types: ["@cloudflare/workers-types"] — NO DOM lib
public/
  phrases.json       # Single source of truth: phrases, labels, timing constants
  sounds/            # hooponopono_en.m4a
  _redirects         # www → apex 301 (Cloudflare only, warning locally — expected)
  _headers           # CORS for phrases.json
extension/
  manifest.json      # MV3, host_permissions: wss://hooponopono.online/*
  icons/             # User must add icon16.png, icon48.png, icon128.png manually
dist/                # gitignored — includes _worker.js (Pages Functions entry)
extension/dist/      # gitignored
wrangler.toml        # pages_build_output_dir = "dist", HoopRoom DO binding
```

## Critical: Two tsconfigs Required

`@cloudflare/workers-types` conflicts with DOM types. **Never merge into one tsconfig.**
- `src/worker/tsconfig.json` — Workers types only, no DOM
- `src/frontend/tsconfig.json` — DOM + resolveJsonModule, no Workers types
- Root `tsconfig.json` — IDE only (no types restriction)

Type-check runs both: `bun run type-check`

## Critical: build:worker Uses bun build, Not wrangler

`wrangler deploy --dry-run` does NOT exist for Pages. Worker is bundled via:
```bash
bun build src/worker/index.ts --outfile dist/_worker.js --format esm --minify
```
wrangler reads `dist/_worker.js` as the Pages Functions entry automatically.

## Phrase Synchronization

Constants live in `public/phrases.json` (imported by script.ts via bun):
- `START_TIMESTAMP = 1640995200`, `PHRASE_DURATION = 2`, `CYCLE_DURATION = 8`
- `index = Math.floor((elapsed % 8) / 2)` — deterministic, NTP-synced clocks

## Durable Object: HoopRoom

- **Hibernation API** (`state.acceptWebSocket()`) — DO sleeps between events
- `webSocketMessage` must be implemented (even empty) — required by workers-types
- Broadcasts `{ type: "online_count", count }` on every connect/disconnect
- `env.ASSETS` typed as `(env as unknown as { ASSETS: Fetcher }).ASSETS`

## WebSocket Reconnect: Exponential Backoff

```typescript
const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000); // 1s→2s→4s→…→30s
```
Old `setInterval` pattern created parallel connections — do NOT use it.

## Chrome Extension

- WS_URL hardcoded to `wss://hooponopono.online/ws` (not `pages.dev` — unstable)
- `isExtension` check via `globalThis['chrome']?.runtime` (no @types/chrome needed)
- icons/ must be populated before publishing to Chrome Web Store

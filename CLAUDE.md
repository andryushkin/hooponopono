# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Migration of the hooponopono meditation site to **Cloudflare Pages + Durable Objects**, rewritten in TypeScript with Bun as runtime/package manager. The target project lives at `~/Projects/hooponopono-cf/`. See `plan_hooponopono_new.md` for full migration plan.

**Functionality to preserve:**
- Phrase synchronization (client-side, computed from unix timestamp — no server timer)
- Online counter = base 30–49 + real WebSocket connections
- 12 languages, audio for EN only
- Short link service at `/link/[id]`

## Stack

- **Runtime/package manager:** Bun
- **Hosting:** Cloudflare Pages (static) + Durable Objects (WebSocket, online counter)
- **Short links:** Cloudflare KV
- **TypeScript** throughout (`@cloudflare/workers-types`)

## Key Commands

```bash
bun run build          # Build frontend + dry-run worker deploy
bun run build:frontend # bun build script.ts → dist/ + copy HTML/CSS/sounds
bun run dev            # wrangler pages dev dist (local, with DO)
bun run deploy         # build frontend + wrangler pages deploy
bun x tsc --noEmit     # type-check only
```

## Architecture

```
src/
  frontend/
    script.ts        # Client logic: phrase sync (timer-based), WebSocket for online_count only
    index.html
    style.css
  worker/
    index.ts         # Worker entry: routes /ws to HoopRoom DO
    hoop-room.ts     # Durable Object: WebSocket Hibernation API, broadcasts online count
functions/
  link/[id].ts       # Pages Function: KV lookup → 301 redirect
public/sounds/       # hooponopono_en.m4a
dist/                # Build output (gitignored)
wrangler.toml
```

## Phrase Synchronization

Phrases cycle client-side using a fixed unix timestamp anchor (`START_TIMESTAMP = 1640995200`), 2 seconds per phrase, 8-second cycle. WebSocket is used **only** for `online_count` messages — no server-pushed phrase updates.

## Durable Object: HoopRoom

- Uses **Hibernation API** (`state.acceptWebSocket()`) — DO sleeps between events, supports up to 32 768 connections
- `BASE_COUNT` (30–49) is randomized once at DO instantiation
- Broadcasts count on every connect/disconnect: `{ type: "online_count", count: BASE_COUNT + activeConnections }`
- Single global instance: `env.HOOP_ROOM.idFromName('global')`

## KV Short Links

Keys are link IDs, values are JSON `{ "url": "..." }`. Load via:
```bash
bunx wrangler kv:key put --binding=LINKS "link-id" '{"url":"https://..."}'
```

## Source Files to Port

| Target file | Source |
|---|---|
| `src/frontend/script.ts` | Rewrite from `../hooponopono/public/script.js` |
| `src/frontend/index.html` | Copy from `../hooponopono/public/index.html` |
| `src/frontend/style.css` | Copy from `../hooponopono/public/style.css` |
| `public/sounds/` | Copy from `../hooponopono/public/sounds/` |

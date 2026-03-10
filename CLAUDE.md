# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Hooponopono meditation site on **Cloudflare Pages + Durable Objects**, TypeScript + Bun.
Migration from DigitalOcean (Python WebSocket server) is complete.

**Features:**
- Phrase synchronization — client-side, computed from unix timestamp (no server timer)
- Online counter — real WebSocket connections only (0 when nobody online)
- 12 languages, audio for EN only (sounds/hooponopono_en.m4a)
- Chrome Extension (MV3, opens meditation on toolbar icon click)
- Anonymous session analytics — SQLite in DO, admin dashboard at `/stats/{hash}`

## Stack

- **Runtime/package manager:** Bun
- **Hosting:** Cloudflare Pages (static) + Durable Objects (WebSocket, online counter, session analytics)
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
    script.ts          # Phrase sync (setInterval 200ms), WebSocket with session metadata
    index.html         # No modal, no StatCounter
    style.css          # No modal CSS
    hooponopono.html   # Chrome Extension page (renamed from newtab.html)
    tsconfig.json    # lib: ["DOM"], resolveJsonModule: true — NO workers-types
  worker/
    index.ts         # Pages worker: /ws → DO, /stats/{hash} → dashboard/API, else → ASSETS
    hoop-room.ts     # DO: Hibernation API, online count, SQLite session tracking, stats API
    tsconfig.json    # types: ["@cloudflare/workers-types"] — NO DOM lib
public/
  phrases.json       # Single source of truth: phrases, labels, timing constants
  sounds/            # hooponopono_en.m4a
  _redirects         # www → apex 301 (Cloudflare only, warning locally — expected)
  _headers           # CORS for phrases.json
  stats.html         # Admin dashboard (self-contained, dark theme, source tabs)
extension/
  manifest.json      # MV3, default_locale: en, __MSG_*__ for name/description/title
  background.js      # service worker: opens hooponopono.html (+ ?welcome=1 on first install)
  _locales/          # chrome.i18n: en,ru,es,pt_BR,de,cs,fr,ja,zh_CN,id,ms,ar
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

### Session Analytics (SQLite)
- Tables: `sessions` (id, started, duration, locale, source, device, **client_id**) + `clients` (id, first_seen, last_seen, locale, source, device)
- `client_id` — UUID from client localStorage (`hoop_cid`), sent as WS query param `?cid=`
- On WS connect: UPSERT into `clients` + INSERT into `sessions` with `client_id`
- `client_id` migration: `ALTER TABLE sessions ADD COLUMN client_id TEXT DEFAULT ''` (try/catch — safe)
- Session metadata from WS URL query params: `?lang=en&src=web&device=desktop&cid=<uuid>`
- Sources: `web` (site), `ext` (Chrome Extension), `ios` (iOS app)
- Duration: server-side, computed from WS connect/disconnect timestamps
- WebSocket tags: `state.acceptWebSocket(server, [sid, startTimestamp])` — used on close/error
- Cleanup: records older than 90 days, max once per hour
- Stats API: `/stats` endpoint in DO, supports `?source=` and `?period=1d|7d|30d|90d|all`

### Admin Dashboard
- Route: `/stats/{STATS_SECRET}` → `stats.html`, `/stats/{STATS_SECRET}/api` → DO stats JSON
- `STATS_SECRET` is a Cloudflare Pages secret
- Dashboard: self-contained HTML, dark theme, tabs (All/Web/Ext/iOS), period selector (30d|1d|7d|90d|All)
- 6 metric cards: Sessions (period), Today Sessions, Avg Duration, Clients (period), Clients (All Time), New Clients Today
- Auto-refresh: **60 minutes** (not 60 seconds)

## Audio: EN-only, State Reset on Language Switch

- Audio is EN-only. `isMuted` persists in memory and localStorage.
- **Critical:** when switching away from EN, `isMuted` must be reset to `true` — otherwise returning to EN auto-plays audio without user action.
- In `setLanguage()`: the `if (currentAudio && lang !== 'en')` block sets `isMuted = true`, saves to localStorage, and updates the mute button to 🔇.

## WebSocket Reconnect: Exponential Backoff

```typescript
const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000); // 1s→2s→4s→…→30s
```
Old `setInterval` pattern created parallel connections — do NOT use it.

## UI Layout

- **Online counter** (`#online`) is inside `.language-selector` (flex column, align-items: flex-end) — flows as third item after language-dropdown and muteButton
- **CWS link** in `index.html`: `.cws-link-container` (position fixed, bottom center), plain text `<a>` — no image badge
- `hooponopono.html` does NOT have a CWS link
- **Cache-busting:** `style.css?v=N` — increment `N` whenever CSS changes to bypass Chrome/Cloudflare cache

## Chrome Extension

- **Does NOT override newtab** — meditation opens only on toolbar icon click
- `background.js` (service worker): `chrome.action.onClicked` → `chrome.tabs.create({ url: chrome.runtime.getURL('hooponopono.html') })`
- `chrome.runtime.onInstalled` → opens `hooponopono.html?welcome=1` on first install — shows welcome **modal overlay** inside meditation page (not a separate page)
- `chrome.tabs.create()` requires no extra permissions — allowed by default in MV3
- WS URL includes query params: `?lang=en&src=ext&device=desktop&cid=<uuid>` (session metadata + client identity)
- WS base URL hardcoded to `wss://hooponopono.online/ws` (not `pages.dev` — unstable)
- `isExtension` check via `globalThis['chrome']?.runtime` (no @types/chrome needed)
- icons/ must be populated before publishing to Chrome Web Store
- **Load from `extension/dist/` in Chrome** (not `extension/`) — source dir lacks hooponopono.html, script.js, etc.

### chrome.i18n Localization

- `manifest.json` uses `__MSG_extName__`, `__MSG_extDescription__`, `__MSG_actionTitle__` with `default_locale: "en"`
- `extension/_locales/` has 12 locale dirs (en, ru, es, pt_BR, de, cs, fr, ja, zh_CN, id, ms, ar)
- Each `messages.json` has 4 keys: `extName`, `extDescription`, `actionTitle`, `welcomeMessage` — all with `description` field
- Locale code mapping: project uses `pt`/`zh`, Chrome _locales use `pt_BR`/`zh_CN`
- `detectLanguage()` in extension context uses `chrome.i18n.getUILanguage()` to auto-detect Chrome UI language
- Runtime translations (phrases, labels, info modal) stay in `phrases.json` — NOT duplicated in `_locales/`
- **Critical:** `@@bidi_dir` is a reserved Chrome system key — do NOT define it in messages.json (causes extension load error)
- `build:ext` cleans `extension/dist/` with `rm -rf` before each build to prevent stale/nested `_locales/`

## CWS Listing Translations (51 languages)

- English template: `docs/lang/EN.md` (Title / Short Description / Long Description)
- Progress checklist: `docs/lang/Language.md` — 51 languages, `[x]` for completed
- Translation skill: `.claude/skills/translate-cws-listing/SKILL.md` — invoke with `/translate-cws-listing {code}`
- Character limits: Title ≤45, Short ≤132, Long ≤4500
- **"50+ languages"** in feature list (not "12")
- **"100% Free Forever"** feature bullet is removed — do NOT include in translations
- SEO: always include local transliteration of "ho'oponopono" + meditation/forgiveness/healing keywords

# Infrastructure

## Домены и DNS

| Домен | Назначение |
|-------|------------|
| `hooponopono.online` | Основной домен, Cloudflare Pages |
| `www.hooponopono.online` | 301 → `hooponopono.online` (воркер) |

**Регистратор:** Namecheap
**DNS:** Cloudflare (`jermaine.ns.cloudflare.com`, `mona.ns.cloudflare.com`)

---

## Cloudflare

**Аккаунт:** amitandrus@gmail.com
**Account ID:** `be368884473a7bdbddd708f8bfeda06f`

### Pages — `hooponopono`

- **URL:** `hooponopono-3t0.pages.dev` / `hooponopono.online`
- **Конфиг:** `wrangler.toml`
- **Build output:** `dist/`
- **Worker:** `dist/_worker.js` — перехватывает все запросы:
  - `www.*` → 301 редирект на apex
  - `/ws` → проксирует в DO `HOOP_ROOM`
  - всё остальное → `ASSETS` (статика)
- **Binding:** `HOOP_ROOM` → DO Worker `hooponopono-do`

### Worker — `hooponopono-do`

- **URL:** `hooponopono-do.amitandrus.workers.dev`
- **Конфиг:** `wrangler-do.toml`
- **Entry:** `src/worker/do-entry.ts`
- **Назначение:** хостит Durable Object класс `HoopRoom`
- **Migration:** `v1`, `new_sqlite_classes: [HoopRoom]` (требование free plan)

### Durable Object — `HoopRoom`

- **Hibernation API** — DO спит между событиями, не тратит ресурсы
- **Namespace:** `global` — один экземпляр для всех пользователей
- **Логика:** при connect/disconnect → broadcast `{ type: "online_count", count }`
- **Free plan лимиты:** 100k запросов/день (shared с аккаунтом)

---

## Сетевая схема

```
Пользователь
    │
    ▼
Cloudflare Edge (anycast)
    │
    ├─ www.hooponopono.online ──→ 301 → hooponopono.online
    │
    └─ hooponopono.online
           │
           ▼
      Pages Worker (_worker.js)
           │
           ├─ GET /ws (Upgrade: websocket)
           │       │
           │       ▼
           │  hooponopono-do (Worker)
           │       │
           │       ▼
           │  HoopRoom (Durable Object)
           │  Hibernation API, SQLite
           │
           └─ GET /* → ASSETS (статика из dist/)
```

---

## Локальная разработка

```bash
bun run dev          # build + wrangler pages dev dist (с DO локально)
```

- `wrangler pages dev` читает `wrangler.toml` и поднимает DO локально
- WebSocket доступен на `ws://localhost:8788/ws`
- `_redirects` с абсолютными URL даёт WARNING локально — ожидаемо

---

## Deploy

```bash
bun run deploy        # полный деплой: frontend + worker + DO Worker + Pages
bun run deploy:do     # только DO Worker (hooponopono-do)
```

**Порядок деплоя:**
1. `build:frontend` → `dist/` (HTML, CSS, JS, звуки, phrases.json)
2. `build:worker` → `dist/_worker.js`
3. `deploy:do` → деплой `hooponopono-do` Worker с HoopRoom
4. `wrangler pages deploy dist` → деплой Pages

**Важно:** DO Worker деплоится отдельно раньше Pages, иначе binding не найдёт класс.

---

## Chrome Extension

- **Manifest:** MV3
- **Функция:** переопределяет New Tab (`chrome_url_overrides.newtab`)
- **WebSocket:** `wss://hooponopono.online/ws` (хардкод, не `pages.dev`)
- **Build:** `bun run build:ext` → `extension/dist/`
- **Иконки:** нужно добавить вручную (`icons/icon16.png`, `icon48.png`, `icon128.png`)
- **Публикация:** через Chrome Web Store (вручную)

---

## Переменные окружения / секреты

Проект не использует секретов — вся конфигурация публичная:
- `phrases.json` — источник фраз и тайминга (публичный)
- WS_URL в extension — хардкод продакшн домена

---

## Структура репозитория

```
src/
  frontend/         # TypeScript фронтенд (компилируется в dist/)
  worker/
    index.ts        # Pages worker: роутинг
    hoop-room.ts    # Durable Object: online counter
    do-entry.ts     # Точка входа DO Worker (re-export HoopRoom)
public/             # Статика: phrases.json, sounds/, _redirects, _headers
extension/          # Chrome Extension (MV3)
dist/               # gitignored — артефакты сборки
extension/dist/     # gitignored — артефакты сборки extension
wrangler.toml       # Pages конфиг
wrangler-do.toml    # DO Worker конфиг
```

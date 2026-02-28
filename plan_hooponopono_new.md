# План: hooponopono на Cloudflare — новый проект на TypeScript + Bun

## Контекст

Переписать сайт hooponopono с нуля как новый проект на TypeScript с Bun в качестве рантайма/пакетного менеджера.
Хостинг: Cloudflare Pages (статика) + Durable Objects (WebSocket, счётчик онлайн).
DigitalOcean VPS выключается после успешной миграции.

**Сохранить функциональность:**
- Синхронизация фраз (клиент вычисляет фазу сам из unix timestamp — не нужен серверный таймер)
- Счётчик онлайн = base 30–49 + реальные WebSocket соединения
- 12 языков, аудио для EN
- Сервис коротких ссылок `/link/[id]`

---

## Где создать проект

```
~/Projects/hooponopono-cf/     # новый репозиторий
```

---

## Структура нового проекта

```
hooponopono-cf/
├── src/
│   ├── frontend/
│   │   ├── index.html          # HTML (перенести из текущего проекта, адаптировать)
│   │   ├── style.css           # CSS (перенести без изменений)
│   │   └── script.ts           # Переписанный script.js на TypeScript
│   └── worker/
│       ├── index.ts            # Worker entry point
│       └── hoop-room.ts        # Durable Object HoopRoom
├── functions/
│   └── link/
│       └── [id].ts             # Pages Function: редиректы из KV
├── public/
│   └── sounds/
│       └── hooponopono_en.m4a  # Скопировать из старого проекта
├── dist/                       # Артефакты сборки (gitignore)
├── wrangler.toml
├── package.json
├── tsconfig.json
└── PLAN.md                     # Этот план (скопировать)
```

---

## Шаг 1: инициализация

```bash
mkdir hooponopono-cf && cd hooponopono-cf
git init
bun init -y

# Зависимости
bun add -d typescript @cloudflare/workers-types wrangler

# Создать gitignore
echo "dist/\nnode_modules/\n.wrangler/" > .gitignore
```

---

## Шаг 2: tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src/**/*", "functions/**/*"]
}
```

---

## Шаг 3: wrangler.toml

```toml
name = "hooponopono"
pages_build_output_dir = "dist"
compatibility_date = "2026-01-01"

[[durable_objects.bindings]]
name = "HOOP_ROOM"
class_name = "HoopRoom"

[[migrations]]
tag = "v1"
new_classes = ["HoopRoom"]

[[kv_namespaces]]
binding = "LINKS"
id = "<создать через wrangler kv:namespace create LINKS>"
```

---

## Шаг 4: Durable Object (`src/worker/hoop-room.ts`)

```typescript
import type { DurableObjectState } from '@cloudflare/workers-types';

interface Env {
  HOOP_ROOM: DurableObjectNamespace;
  LINKS: KVNamespace;
}

export class HoopRoom implements DurableObject {
  private readonly BASE_COUNT: number;

  constructor(private state: DurableObjectState, private env: Env) {
    this.BASE_COUNT = Math.floor(Math.random() * 20) + 30; // 30–49, один раз при старте
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server); // Hibernation API
    this.broadcastCount();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketClose(_ws: WebSocket): void {
    this.broadcastCount();
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    this.broadcastCount();
  }

  private broadcastCount(): void {
    const count = this.BASE_COUNT + this.state.getWebSockets().length;
    const msg = JSON.stringify({ type: 'online_count', count });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* клиент отключился */ }
    }
  }
}
```

**Ключевые решения:**
- `state.acceptWebSocket()` — Hibernation API: DO спит между событиями, до 32 768 соединений
- `BASE_COUNT` генерируется один раз при создании DO (как в текущем Python-сервере)
- `broadcastCount()` вызывается при connect и disconnect — как в текущем сервере

---

## Шаг 5: Worker entry (`src/worker/index.ts`)

```typescript
export { HoopRoom } from './hoop-room';

interface Env {
  HOOP_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const id = env.HOOP_ROOM.idFromName('global');
      const stub = env.HOOP_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

---

## Шаг 6: Pages Function — редиректы (`functions/link/[id].ts`)

```typescript
interface Env {
  LINKS: KVNamespace;
}

export async function onRequest(
  ctx: EventContext<Env, 'id', Record<string, unknown>>
): Promise<Response> {
  const id = ctx.params.id as string;
  const raw = await ctx.env.LINKS.get(id);

  if (!raw) return new Response(null, { status: 404 });

  const { url } = JSON.parse(raw) as { url: string };
  return Response.redirect(url, 301);
}
```

**Загрузить существующие ссылки в KV:**
```bash
# Создать namespace
bunx wrangler kv:namespace create LINKS
# Вставить значение id из wrangler.toml

# Загрузить каждую ссылку
bunx wrangler kv:key put --binding=LINKS "simple-practice-136415508" '{"url":"https://..."}'
bunx wrangler kv:key put --binding=LINKS "here_and_now_the_only_reality" '{"url":"https://..."}'
bunx wrangler kv:key put --binding=LINKS "prayer_is_not_what_you_think" '{"url":"https://..."}'
```

---

## Шаг 7: Frontend TypeScript (`src/frontend/script.ts`)

Переписать `public/script.js` из текущего проекта. Ключевые изменения:

**Синхронизация фраз — клиентская (вместо WebSocket push):**
```typescript
const START_TIMESTAMP = 1640995200; // фиксированная точка, как в Python-сервере
const PHRASE_DURATION = 2; // секунд на фразу
const CYCLE_DURATION = 4 * PHRASE_DURATION; // 8 секунд

function getCurrentPhraseIndex(): number {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - START_TIMESTAMP;
  const cyclePos = elapsed % CYCLE_DURATION;
  return Math.floor(cyclePos / PHRASE_DURATION); // 0, 1, 2, 3
}

// Таймер: проверять индекс каждые 200ms, обновлять UI при смене
let lastIndex = -1;
setInterval(() => {
  const index = getCurrentPhraseIndex();
  if (index !== lastIndex) {
    lastIndex = index;
    updateDisplay(PHRASES[currentLang][index]);
    playAudio(index);
  }
}, 200);
```

**WebSocket — только для online_count:**
```typescript
// Удалить обработку phrase_update из WebSocket
// Оставить только обработку online_count и ping/pong
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'online_count') {
    updateOnlineCount(data.count);
  }
};
```

**Остальное без изменений:**
- Константы PHRASES, LABELS, MODAL_CONTENT (12 языков) — скопировать как есть
- Аудио логика — без изменений
- Модальное окно — без изменений
- localStorage для языка и mute — без изменений
- Автоматическое переподключение — без изменений

---

## Шаг 8: package.json — скрипты сборки через Bun

```json
{
  "name": "hooponopono-cf",
  "scripts": {
    "build": "bun run build:frontend && bun run build:worker",
    "build:frontend": "bun build src/frontend/script.ts --outfile dist/script.js --target browser --minify && cp src/frontend/index.html dist/ && cp src/frontend/style.css dist/ && cp -r public/sounds dist/",
    "build:worker": "bunx wrangler deploy --dry-run",
    "dev": "bunx wrangler pages dev dist --do HoopRoom=src/worker/hoop-room.ts",
    "deploy": "bun run build:frontend && bunx wrangler pages deploy dist --project-name hooponopono",
    "type-check": "bun x tsc --noEmit",
    "kv:links": "bunx wrangler kv:namespace create LINKS"
  }
}
```

**Bun build** заменяет esbuild/vite для фронтенда — нативная поддержка TypeScript, минификация, быстрая сборка.

---

## Шаг 9: HTML (`src/frontend/index.html`)

Скопировать из текущего `public/index.html`, изменить только:
```html
<!-- Было: -->
<script src="script.js"></script>
<!-- Остаётся тем же (bun build выдаёт dist/script.js) -->
<script src="script.js"></script>
```

---

## Порядок выполнения

1. `mkdir ~/Projects/hooponopono-cf && cd ~/Projects/hooponopono-cf`
2. Инициализация: `bun init`, установка зависимостей
3. Создать `tsconfig.json`, `wrangler.toml`
4. Написать `src/worker/hoop-room.ts`
5. Написать `src/worker/index.ts`
6. Написать `functions/link/[id].ts`
7. Переписать `src/frontend/script.ts` из `script.js`
8. Скопировать `index.html`, `style.css`, `sounds/`
9. Запустить `bun run build`
10. Запустить `bun run dev` — локальная проверка
11. Создать Cloudflare Pages проект, KV namespace
12. Загрузить ссылки в KV
13. `bun run deploy`
14. Переключить DNS на Cloudflare
15. Проверить → выключить DigitalOcean Droplet

---

## Проверка работы

```bash
# Локально
bun run dev
# Открыть http://localhost:8788

# Тесты:
# 1. Открыть 2 вкладки — фразы переключаются в одну секунду
# 2. Счётчик онлайн растёт при открытии вкладки
# 3. Счётчик падает при закрытии вкладки
# 4. /link/simple-practice-136415508 → редирект
# 5. Аудио работает на EN, молчит на других языках
# 6. Все 12 языков в дропдауне
# 7. Переключение языка сохраняется после перезагрузки
```

---

## Pricing (бесплатный план)

| Ресурс | Лимит Free | Хватит для |
|---|---|---|
| Pages запросы | Без лимита | ✅ |
| Workers requests | 100K/день | ~1000 уникальных посетителей |
| Durable Objects | Бесплатно с апр. 2025 | ✅ |
| KV reads | 100K/день | ✅ |
| Builds | 500/месяц | ✅ |

Paid план ($5/мес) нужен при >1000 активных пользователей в день.

---

## Критические файлы нового проекта

| Файл | Откуда |
|---|---|
| `src/worker/hoop-room.ts` | Написать с нуля |
| `src/worker/index.ts` | Написать с нуля |
| `functions/link/[id].ts` | Написать с нуля |
| `src/frontend/script.ts` | Переписать из `../hooponopono/public/script.js` |
| `src/frontend/index.html` | Скопировать из `../hooponopono/public/index.html` |
| `src/frontend/style.css` | Скопировать из `../hooponopono/public/style.css` |
| `public/sounds/` | Скопировать из `../hooponopono/public/sounds/` |
| `wrangler.toml` | Написать с нуля |
| `tsconfig.json` | Написать с нуля |
| `package.json` | `bun init` + добавить скрипты |

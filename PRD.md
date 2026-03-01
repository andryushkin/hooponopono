# План: hooponopono на Cloudflare — новый проект на TypeScript + Bun

> **✅ РЕАЛИЗОВАНО** (2026-03-01). `bun run build` + `bun run dev` работают локально.
> Осталось: `bun run deploy` → Custom Domain → выключить DigitalOcean.
>
> **Изменения vs план** (критически важные отличия реализации):
> - **2 tsconfig** вместо 1: `src/worker/tsconfig.json` (workers-types) + `src/frontend/tsconfig.json` (DOM)
> - **build:worker**: `bun build src/worker/index.ts --outfile dist/_worker.js --format esm --minify` (НЕ `wrangler deploy --dry-run` — не существует для Pages)
> - **dev**: `bun run build && bunx wrangler pages dev dist` (без `--do` флага — wrangler читает wrangler.toml)
> - **WS_URL extension**: `wss://hooponopono.online/ws` (НЕ `pages.dev` — нестабильный URL)
> - **phrases.json** — единственный источник истины, импортируется в `script.ts` через bun
> - **webSocketMessage** обязателен в HoopRoom (иначе type error)
> - **Exponential backoff** reconnect вместо setInterval

## Контекст

Переписать сайт hooponopono с нуля как новый проект на TypeScript с Bun в качестве рантайма/пакетного менеджера.
Хостинг: Cloudflare Pages (статика) + Durable Objects (WebSocket, счётчик онлайн).
DigitalOcean VPS выключается после успешной миграции.

**Сохранить функциональность:**
- Синхронизация фраз (клиент вычисляет фазу сам из unix timestamp — не нужен серверный таймер)
- Счётчик онлайн = реальные WebSocket соединения (0 когда никого нет)
- 12 языков, аудио для EN

---

## Где создать проект

```
/Users/andryushkin/Server/hooponopono/     # текущий репозиторий (уже создан)
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
├── public/
│   ├── _redirects              # www → apex редирект
│   ├── phrases.json            # Контракт данных для iOS и других клиентов
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
  "include": ["src/**/*"]
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
```

---

## Шаг 4: Durable Object (`src/worker/hoop-room.ts`)

```typescript
import type { DurableObjectState } from '@cloudflare/workers-types';

interface Env {
  HOOP_ROOM: DurableObjectNamespace;
}

export class HoopRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

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
    const count = this.state.getWebSockets().length;
    const msg = JSON.stringify({ type: 'online_count', count });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* клиент отключился */ }
    }
  }
}
```

**Ключевые решения:**
- `state.acceptWebSocket()` — Hibernation API: DO спит между событиями, до 32 768 соединений
- `broadcastCount()` вызывается при connect и disconnect, транслирует реальное число соединений

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

## Шаг 6: Frontend TypeScript (`src/frontend/script.ts`)

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
// Оставить только обработку online_count
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'online_count') {
    updateOnlineCount(data.count);
  }
};
```

**Выбор языка — автодетект:**

Три уровня приоритета:
1. `localStorage["hooponopono-lang"]` — уже выбирал раньше
2. `navigator.languages` (упорядоченный список) — предпочтения браузера
3. `"en"` — финальный fallback

```typescript
const SUPPORTED_LANGS = Object.keys(PHRASES) as LangCode[];

function detectLanguage(): LangCode {
  // 1. Сохранённое предпочтение пользователя
  const saved = localStorage.getItem('hooponopono-lang') as LangCode | null;
  if (saved && SUPPORTED_LANGS.includes(saved)) return saved;

  // 2. Браузерный язык (берём первичный subtag: "ru-RU" → "ru")
  const candidates = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const locale of candidates) {
    const code = locale.split('-')[0] as LangCode;
    if (SUPPORTED_LANGS.includes(code)) return code;
  }

  // 3. Fallback
  return 'en';
}

let currentLang: LangCode = detectLanguage();
```

`setLanguage()` сохраняет выбор в localStorage:
```typescript
function setLanguage(lang: LangCode): void {
  currentLang = lang;
  localStorage.setItem('hooponopono-lang', lang);
  // ... обновить UI
}
```

Детали алгоритма:
- `navigator.languages` возвращает упорядоченный список (`["ru-RU", "ru", "en-US", "en"]`) — перебираем по приоритету
- Берём только первичный subtag: `"ru-RU"` → `"ru"`, `"zh-TW"` → `"zh"`, `"pt-BR"` → `"pt"`
- Поддерживаемые коды: `en ru es pt de cs fr ja zh id ms ar` (12 языков)
- Если браузер говорит `"uk"` — нет в списке → следующий в `navigator.languages` или fallback `"en"`
- localStorage-ключ `"hooponopono-lang"` совпадает со старым сайтом — предпочтения пользователей сохранятся при переходе на новый сайт

**Остальное без изменений:**
- Константы PHRASES, LABELS (12 языков) — скопировать как есть
  // phrases.json — machine-readable source of truth для iOS/других клиентов
  // Данные в script.ts и phrases.json должны быть идентичными
- Аудио логика — без изменений
- Модальное окно — **удалить полностью**: убрать `MODAL_CONTENT`, `showModal()`, `closeModal()`, `modalShown`, fallback-таймер и все обращения к `#modalOverlay`
- localStorage для языка и mute — без изменений
- Автоматическое переподключение — без изменений

---

## Шаг 7: package.json — скрипты сборки через Bun

```json
{
  "name": "hooponopono-cf",
  "scripts": {
    "build": "bun run build:frontend && bun run build:worker",
    "build:frontend": "bun build src/frontend/script.ts --outfile dist/script.js --target browser --minify && cp src/frontend/index.html dist/ && cp src/frontend/style.css dist/ && cp -r public/sounds dist/ && cp public/_redirects dist/ && cp public/phrases.json dist/",
    "build:worker": "bunx wrangler deploy --dry-run",
    "dev": "bunx wrangler pages dev dist --do HOOP_ROOM=HoopRoom@src/worker/hoop-room.ts",
    "deploy": "bun run build:frontend && bunx wrangler pages deploy dist --project-name hooponopono",
    "type-check": "bun x tsc --noEmit"
  }
}
```

**Bun build** заменяет esbuild/vite для фронтенда — нативная поддержка TypeScript, минификация, быстрая сборка.

---

## Шаг 8: HTML (`src/frontend/index.html`)

Скопировать из текущего `public/index.html`, изменить только:
```html
<!-- Было: -->
<script src="script.js"></script>
<!-- Остаётся тем же (bun build выдаёт dist/script.js) -->
<script src="script.js"></script>
```

**Удалить из index.html** (и newtab.html) блок модального окна:
```html
<!-- УДАЛИТЬ: весь div.modal-overlay -->
<div class="modal-overlay" id="modalOverlay">...</div>
```

**Удалить из style.css** блоки `.modal-overlay`, `.modal-content`, `.modal-close`, `.modal-body`, `.modal-subtitle`, `.modal-text`, `.modal-buttons`, `.modal-button` (всё связанное с модалем).

**Создать `public/_redirects`** (редирект www → apex):
```
https://www.hooponopono.online/* https://hooponopono.online/:splat 301
```

**Не копировать из старого `index.html`:**
```html
<!-- НЕ КОПИРОВАТЬ: StatCounter аналитика не нужна -->
<!-- var sc_project = 13155414; ... statcounter.com/counter/counter.js -->
```

---

## Шаг 9: Кастомный домен (hooponopono.online)

1. В Cloudflare Pages → **Settings → Custom Domains** → добавить `hooponopono.online` и `www.hooponopono.online`
2. Cloudflare Pages выдаёт инструкции по DNS: обычно CNAME `hooponopono.online → hooponopono.pages.dev`
3. **Если домен уже на Cloudflare DNS** — записи добавятся автоматически или вручную в DNS-панели Cloudflare
4. **Если домен не на Cloudflare DNS** — добавить CNAME-запись у текущего регистратора; или (рекомендуется) перенести NS на Cloudflare, чтобы управлять DNS там же
5. SSL-сертификат выдаётся автоматически через Cloudflare (Let's Encrypt или Cloudflare CA)
6. После propagation DNS — проверить что `https://hooponopono.online` и `https://www.hooponopono.online` открывают сайт
7. **Только после проверки** — выключить DigitalOcean Droplet (шаг 15)

---

## Chrome Extension

Продукт существует и как сайт, и как Chrome-расширение — один монорепозиторий, один бэкенд, один `script.ts`.

**Формат расширения:** New Tab (заменяет страницу новой вкладки).
**Бэкенд:** тот же Cloudflare Durable Object WebSocket (`wss://hooponopono.pages.dev/ws`).

### Дополнение к структуре проекта

```
hooponopono-cf/
├── src/
│   └── frontend/
│       ├── script.ts        # общий — работает и на сайте, и в расширении
│       ├── index.html       # сайт (относительный /ws, без StatCounter)
│       ├── newtab.html      # расширение (без StatCounter, абсолютный wss://)
│       └── style.css        # общие стили
├── extension/
│   ├── manifest.json        # MV3
│   └── icons/               # 16×16, 48×48, 128×128 PNG
├── dist/                    # сайт (gitignore)
└── extension/dist/          # расширение (gitignore)
```

### WebSocket URL — автодетект среды

В `script.ts` добавить определение окружения:

```typescript
const WS_URL = (typeof chrome !== 'undefined' && chrome?.runtime?.id)
  ? 'wss://hooponopono.pages.dev/ws'    // расширение — абсолютный URL
  : `wss://${location.host}/ws`;         // сайт — относительный
```

### newtab.html

Копия `index.html`, отличия:
- Без тега `<script>` StatCounter — его нет и на основном сайте
- `<script src="script.js"></script>` — тот же бандл

### manifest.json (Manifest V3)

```json
{
  "manifest_version": 3,
  "name": "ho'oponopono",
  "version": "1.0.0",
  "description": "A meditation practice — I'm sorry, please forgive me, thank you, I love you",
  "chrome_url_overrides": {
    "newtab": "newtab.html"
  },
  "host_permissions": ["wss://hooponopono.pages.dev/*"],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### Обновлённые скрипты в package.json

Добавить `build:ext` и обновить `build`:

```json
"build:ext": "bun build src/frontend/script.ts --outfile extension/dist/script.js --target browser --minify && cp src/frontend/newtab.html extension/dist/ && cp src/frontend/style.css extension/dist/ && cp -r public/sounds extension/dist/ && cp public/phrases.json extension/dist/ && cp extension/manifest.json extension/dist/ && cp -r extension/icons extension/dist/",
"build": "bun run build:frontend && bun run build:worker && bun run build:ext"
```

### .gitignore — дополнить

```
extension/dist/
```

### CSP расширений (Manifest V3)

- Дефолтный CSP для страниц расширения: `script-src 'self'; object-src 'self'`
- StatCounter отсутствует везде: ни на сайте, ни в расширении — CSP MV3 всё равно блокирует внешние скрипты
- Inline-скрипты не работают, но у нас их нет (`<script src="script.js">`)
- Аудио работает нативно без дополнительных разрешений

### Порядок выполнения (расширение)

Добавить к существующим 15 шагам:

16. Создать `extension/manifest.json`
17. Создать `extension/icons/` (3 PNG иконки: 16×16, 48×48, 128×128)
18. Создать `src/frontend/newtab.html` (копия `index.html` без StatCounter)
19. Добавить автодетект среды в `script.ts`
20. Добавить `build:ext` в `package.json`, обновить `build`
21. Дополнить `.gitignore`: `extension/dist/`
22. `bun run build:ext` — собрать расширение
23. Загрузить `extension/dist/` в Chrome через `chrome://extensions` → "Load unpacked"
24. Публикация в Chrome Web Store (опционально)

### Проверка расширения

- Открыть новую вкладку в Chrome → показывает hooponopono
- Фразы переключаются синхронно с сайтом
- Счётчик онлайн обновляется
- Аудио работает на EN
- Нет ошибок CSP в консоли расширения (`Inspect` → DevTools)

---

## iOS-клиент

Архитектура поддерживает iOS без серверных изменений — только статический файл `phrases.json` нужен как контракт данных.

### `public/phrases.json`

Cloudflare Pages раздаёт `phrases.json` как статику. iOS-приложение делает `GET https://hooponopono.online/phrases.json` при запуске:

```json
{
  "startTimestamp": 1640995200,
  "phraseDuration": 2,
  "cycleDuration": 8,
  "phrases": {
    "en": ["I'm sorry", "Please forgive me", "Thank you", "I love you"],
    "ru": ["Мне очень жаль", "Пожалуйста, прости меня", "Благодарю", "Я люблю тебя"],
    "es": ["Lo siento", "Por favor, perdóname", "Gracias", "Te amo"],
    "pt": ["Desculpe", "Por favor, me perdoe", "Obrigado(a)", "Eu te amo"],
    "de": ["Es tut mir leid", "Bitte vergib mir", "Danke", "Ich liebe dich"],
    "cs": ["Promiň", "Prosím, odpusť mi", "Děkuji", "Miluji tě"],
    "fr": ["Je suis désolé(e)", "S'il te plaît, pardonne-moi", "Merci", "Je t'aime"],
    "ja": ["ごめんなさい", "許してください", "ありがとう", "愛しています"],
    "zh": ["对不起", "请原谅我", "谢谢", "我爱你"],
    "id": ["Maaf", "Tolong maafkan saya", "Terima kasih", "Aku cinta kamu"],
    "ms": ["Maaf", "Tolong maafkan saya", "Terima kasih", "Saya cinta padamu"],
    "ar": ["آسف", "سامحني من فضلك", "شكراً", "أنا أحبك"]
  },
  "audio": {
    "en": "sounds/hooponopono_en.m4a"
  },
  "wsPath": "/ws",
  "wsMessages": {
    "serverToClient": [
      { "type": "online_count", "count": "<number>" }
    ]
  }
}
```

**Данные в `phrases.json` и в `script.ts` должны быть идентичными.**

### Алгоритм синхронизации (Swift)

```swift
let START_TIMESTAMP: Int = 1640995200
let PHRASE_DURATION: Int = 2
let CYCLE_DURATION: Int = 8

func currentPhraseIndex() -> Int {
    let now = Int(Date().timeIntervalSince1970)
    let elapsed = now - START_TIMESTAMP
    let cyclePos = elapsed % CYCLE_DURATION
    return cyclePos / PHRASE_DURATION  // 0, 1, 2, 3
}
// Обновлять каждые 200ms, как в script.ts
```

### Выбор языка (Swift)

Аналогичный трёхуровневый алгоритм — UserDefaults вместо localStorage:

```swift
func detectLanguage(supported: [String]) -> String {
    // 1. UserDefaults — пользователь уже выбирал
    if let saved = UserDefaults.standard.string(forKey: "lang"),
       supported.contains(saved) { return saved }
    // 2. Системная локаль (упорядоченный список)
    for locale in Locale.preferredLanguages {
        let code = String(locale.split(separator: "-").first ?? "")
        if supported.contains(code) { return code }
    }
    // 3. Fallback
    return "en"
}
```

### WebSocket для iOS

```
wss://hooponopono.online/ws
```

Протокол: сервер шлёт только `{ "type": "online_count", "count": N }`.
Клиент ничего не отправляет — пинг не нужен (Hibernation API поддерживает соединение на уровне Cloudflare).

### Структура

iOS-приложение живёт в отдельном репозитории. Зависимость от этого монорепо — только `GET phrases.json`.

### Проверка

- `GET https://hooponopono.online/phrases.json` возвращает валидный JSON с 12 языками
- Фразы в iOS переключаются синхронно с сайтом и расширением
- Счётчик онлайн обновляется через WebSocket

---

## Порядок выполнения

1. (проект уже существует в `/Users/andryushkin/Server/hooponopono/`)
2. Инициализация: `bun init`, установка зависимостей
3. Создать `tsconfig.json`, `wrangler.toml`
4. Написать `src/worker/hoop-room.ts`
5. Написать `src/worker/index.ts`
6. Переписать `src/frontend/script.ts` из `script.js`
7. Скопировать `index.html`, `style.css`, `sounds/`
8. Запустить `bun run build`
9. Запустить `bun run dev` — локальная проверка
10. Создать Cloudflare Pages проект
11. `bun run deploy`
12. Добавить `hooponopono.online` как Custom Domain в Cloudflare Pages
13. Настроить DNS (CNAME или NS на Cloudflare)
14. Дождаться SSL и проверить домен
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
# 4. www.hooponopono.online → редирект 301 на hooponopono.online
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
| Builds | 500/месяц | ✅ |

Paid план ($5/мес) нужен при >1000 активных пользователей в день.

---

## Критические файлы нового проекта

| Файл | Откуда |
|---|---|
| `src/worker/hoop-room.ts` | Написать с нуля |
| `src/worker/index.ts` | Написать с нуля |
| `src/frontend/script.ts` | Переписать из `../hooponopono_old/public/script.js` |
| `src/frontend/index.html` | Скопировать из `../hooponopono_old/public/index.html` |
| `src/frontend/style.css` | Скопировать из `../hooponopono_old/public/style.css` |
| `public/sounds/` | Скопировать из `../hooponopono_old/sounds/` |
| `public/phrases.json` | Создать вручную из констант script.ts |
| `wrangler.toml` | Написать с нуля |
| `tsconfig.json` | Написать с нуля |
| `package.json` | `bun init` + добавить скрипты |

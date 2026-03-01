import phraseData from '../../public/phrases.json';

type LangCode = 'en' | 'ru' | 'es' | 'pt' | 'de' | 'cs' | 'fr' | 'ja' | 'zh' | 'id' | 'ms' | 'ar';

interface LabelSet {
  online: string;
  connecting: string;
  reconnecting: string;
  error: string;
}

const PHRASES = phraseData.phrases as Record<LangCode, string[]>;
const LABELS = phraseData.labels as Record<LangCode, LabelSet>;
const START_TIMESTAMP: number = phraseData.startTimestamp;
const PHRASE_DURATION: number = phraseData.phraseDuration;
const CYCLE_DURATION: number = phraseData.cycleDuration;
const SUPPORTED_LANGS = Object.keys(PHRASES) as LangCode[];

// --- Language detection ---

function detectLanguage(): LangCode {
  const saved = localStorage.getItem('hooponopono-lang') as LangCode | null;
  if (saved && SUPPORTED_LANGS.includes(saved)) return saved;

  const candidates = navigator.languages?.length
    ? [...navigator.languages]
    : [navigator.language];

  for (const locale of candidates) {
    const code = locale.split('-')[0] as LangCode;
    if (SUPPORTED_LANGS.includes(code)) return code;
  }
  return 'en';
}

// --- State ---

let currentLang: LangCode = detectLanguage();
let isMuted = localStorage.getItem('hooponopono-muted') === 'true';
let ws: WebSocket | null = null;
let currentOnlineCount = 0;
let lastPhraseIndex = -1;
let currentAudio: HTMLAudioElement | null = null;
let audioLoaded = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// --- WS URL ---

const isExtension =
  typeof (globalThis as Record<string, unknown>)['chrome'] !== 'undefined' &&
  !!(
    (globalThis as Record<string, unknown>)['chrome'] as Record<string, unknown>
  )['runtime'];

const WS_URL = isExtension
  ? 'wss://hooponopono.online/ws'
  : `wss://${window.location.host}/ws`;

// --- Phrase sync ---

function getCurrentPhraseIndex(): number {
  const elapsed = Math.floor(Date.now() / 1000) - START_TIMESTAMP;
  return Math.floor((elapsed % CYCLE_DURATION) / PHRASE_DURATION);
}

// --- Display ---

function updateDisplay(phrase: string): void {
  const phraseEl = document.getElementById('phrase');
  if (!phraseEl) return;
  if (phraseEl.textContent !== phrase) {
    phraseEl.textContent = phrase;
    phraseEl.classList.remove('show');
    phraseEl.offsetHeight; // trigger reflow for animation
    phraseEl.classList.add('show');
  }
}

function updateOnlineCount(): void {
  const el = document.getElementById('online');
  if (!el) return;
  if (currentOnlineCount > 0) {
    const labels = LABELS[currentLang];
    if (labels) el.textContent = `${labels.online}: ${currentOnlineCount}`;
  }
}

// --- Audio ---

function initAudio(): void {
  if (currentLang === 'en' && !audioLoaded) {
    currentAudio = new Audio('sounds/hooponopono_en.m4a');
    currentAudio.loop = false;
    audioLoaded = true;
  }
}

function playAudio(index: number): void {
  if (isMuted || currentLang !== 'en' || !currentAudio) return;
  if (index === lastPhraseIndex) return;
  lastPhraseIndex = index;

  const startTime = index * 2;
  if (currentAudio.readyState >= 2) {
    currentAudio.currentTime = startTime;
    if (currentAudio.paused) {
      currentAudio.play().catch((e) => console.log('Audio play failed:', e));
    }
  }
}

function toggleMute(): void {
  isMuted = !isMuted;
  localStorage.setItem('hooponopono-muted', String(isMuted));
  const btn = document.getElementById('muteButton');
  if (btn) btn.textContent = isMuted ? '🔇' : '🔊';

  if (isMuted && currentAudio) {
    currentAudio.pause();
  }
}

function setLanguage(lang: LangCode): void {
  currentLang = lang;
  localStorage.setItem('hooponopono-lang', lang);
  const langBtn = document.getElementById('languageButton');
  if (langBtn) langBtn.textContent = lang.toUpperCase();

  if (currentAudio && lang !== 'en') {
    currentAudio.pause();
    currentAudio = null;
    audioLoaded = false;
  }

  if (lang === 'en') initAudio();

  updateOnlineCount();
}

// --- WebSocket with exponential backoff ---

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function connectWebSocket(): void {
  ws?.close();

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    const el = document.getElementById('online');
    const labels = LABELS[currentLang];
    if (el && labels) el.textContent = labels.error;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(String(event.data)) as {
        type: string;
        count?: number;
      };
      if (data.type === 'online_count' && data.count !== undefined) {
        currentOnlineCount = data.count;
        updateOnlineCount();
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  };

  ws.onclose = () => {
    const el = document.getElementById('online');
    const labels = LABELS[currentLang];
    if (el && labels) el.textContent = labels.reconnecting;
    scheduleReconnect();
  };

  ws.onerror = () => {
    const el = document.getElementById('online');
    const labels = LABELS[currentLang];
    if (el && labels) el.textContent = labels.error;
  };
}

// --- Phrase update loop ---

function updatePhrase(): void {
  const index = getCurrentPhraseIndex();
  const phrases = PHRASES[currentLang] ?? PHRASES['en'];
  const phrase = phrases?.[index] ?? '';
  updateDisplay(phrase);
  playAudio(index);
}

// --- Init ---

function init(): void {
  setLanguage(currentLang);
  initAudio();

  const muteButton = document.getElementById('muteButton');
  if (muteButton) {
    muteButton.textContent = isMuted ? '🔇' : '🔊';
    muteButton.addEventListener('click', toggleMute);
  }

  const languageButton = document.getElementById('languageButton');
  const languageMenu = document.getElementById('languageMenu');

  languageButton?.addEventListener('click', (e) => {
    e.stopPropagation();
    languageMenu?.classList.toggle('show');
  });

  languageMenu?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('language-option')) {
      const lang = target.dataset['lang'] as LangCode | undefined;
      if (lang && SUPPORTED_LANGS.includes(lang)) {
        setLanguage(lang);
      }
      languageMenu.classList.remove('show');
    }
  });

  document.addEventListener('click', () => {
    languageMenu?.classList.remove('show');
  });

  const onlineEl = document.getElementById('online');
  const labels = LABELS[currentLang];
  if (onlineEl && labels) onlineEl.textContent = labels.connecting;

  connectWebSocket();

  updatePhrase();
  setInterval(updatePhrase, 200);
}

document.addEventListener('DOMContentLoaded', init);

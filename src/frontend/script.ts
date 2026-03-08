import phraseData from '../../public/phrases.json';

type LangCode = 'en' | 'ru' | 'es' | 'pt' | 'de' | 'cs' | 'fr' | 'ja' | 'zh' | 'id' | 'ms' | 'ar';

interface LabelSet {
  online: string;
  connecting: string;
  reconnecting: string;
  error: string;
}

interface InfoSection {
  h: string;
  p: string;
}

interface InfoContent {
  title: string;
  tagline: string;
  sections: InfoSection[];
  close: string;
}

const PHRASES = phraseData.phrases as Record<LangCode, string[]>;
const LABELS = phraseData.labels as Record<LangCode, LabelSet>;
const INFO = phraseData.info as Record<LangCode, InfoContent>;

const START_TIMESTAMP: number = phraseData.startTimestamp;
const PHRASE_DURATION: number = phraseData.phraseDuration;
const CYCLE_DURATION: number = phraseData.cycleDuration;
const SUPPORTED_LANGS = Object.keys(PHRASES) as LangCode[];

// --- Extension detection ---

const isExtension =
  typeof (globalThis as Record<string, unknown>)['chrome'] !== 'undefined' &&
  !!(
    (globalThis as Record<string, unknown>)['chrome'] as Record<string, unknown>
  )['runtime'];

// --- Language detection ---

function detectLanguage(): LangCode {
  const saved = localStorage.getItem('hooponopono-lang') as LangCode | null;
  if (saved && SUPPORTED_LANGS.includes(saved)) return saved;

  // В контексте расширения — используем язык Chrome UI
  if (isExtension) {
    const chromeObj = (globalThis as Record<string, unknown>)['chrome'] as Record<string, unknown> | undefined;
    const i18n = chromeObj?.['i18n'] as Record<string, unknown> | undefined;
    const getUILanguage = i18n?.['getUILanguage'] as (() => string) | undefined;
    const locale = getUILanguage?.() ?? 'en';
    const code = (locale.split('-')[0] ?? 'en').split('_')[0] as LangCode;
    return SUPPORTED_LANGS.includes(code) ? code : 'en';
  }

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
const savedMuted = localStorage.getItem('hooponopono-muted');
let isMuted = savedMuted === null ? true : savedMuted === 'true';
let ws: WebSocket | null = null;
let currentOnlineCount = 0;
let lastPhraseIndex = -1;
let currentAudio: HTMLAudioElement | null = null;
let audioLoaded = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isModalOpen = false;
let isWelcomeModalOpen = false;

const WS_BASE = isExtension
  ? 'wss://hooponopono.online/ws'
  : `wss://${window.location.host}/ws`;

function detectDevice(): 'mobile' | 'desktop' {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

function getClientId(): string {
  let cid = localStorage.getItem('hoop_cid');
  if (!cid) { cid = crypto.randomUUID(); localStorage.setItem('hoop_cid', cid); }
  return cid;
}

function buildWsUrl(): string {
  const params = new URLSearchParams({
    lang: currentLang,
    src: isExtension ? 'ext' : 'web',
    device: detectDevice(),
    cid: getClientId(),
  });
  return `${WS_BASE}?${params}`;
}

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

function updateMuteButtonVisibility(): void {
  const btn = document.getElementById('muteButton');
  if (!btn) return;
  if (currentLang === 'en') {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
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
    // Сброс состояния звука: при возврате на EN пользователь сам включит
    isMuted = true;
    localStorage.setItem('hooponopono-muted', 'true');
    const btn = document.getElementById('muteButton');
    if (btn) btn.textContent = '🔇';
  }

  if (lang === 'en') initAudio();

  updateOnlineCount();
  updateMuteButtonVisibility();
  if (isModalOpen) updateModalContent(lang);
}

// --- Welcome modal ---

function openWelcomeModal(): void {
  isWelcomeModalOpen = true;
  const chromeObj = (globalThis as Record<string, unknown>)['chrome'] as Record<string, unknown> | undefined;
  const i18n = chromeObj?.['i18n'] as Record<string, unknown> | undefined;
  const getMessage = i18n?.['getMessage'] as ((key: string) => string) | undefined;
  const title = getMessage?.('extName') || "Ho'oponopono Meditation";
  const msg = getMessage?.('welcomeMessage') || 'Thank you for installing. Click the toolbar icon to start meditating.';
  const titleEl = document.getElementById('welcomeTitle');
  const msgEl = document.getElementById('welcomeMessage');
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = msg;
  const overlay = document.getElementById('welcomeOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  (document.getElementById('welcomeModal') as HTMLElement | null)?.focus();
}

function closeWelcomeModal(): void {
  isWelcomeModalOpen = false;
  const overlay = document.getElementById('welcomeOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

// --- Info modal ---

function updateModalContent(lang: LangCode): void {
  const info = INFO[lang] ?? INFO['en'];
  if (!info) return;
  const modal = document.getElementById('infoModal');
  if (!modal) return;
  modal.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  const set = (id: string, text: string) => {
    const e = document.getElementById(id);
    if (e) e.textContent = text;
  };
  set('infoModalTitle', info.title);
  set('infoModalTagline', info.tagline);
  const closeBtn = document.getElementById('infoModalCloseBtn');
  if (closeBtn) closeBtn.setAttribute('aria-label', info.close);
  for (let i = 0; i < 4; i++) {
    const s = info.sections[i];
    if (!s) continue;
    set(`infoSectionH${i}`, s.h);
    set(`infoSectionP${i}`, s.p);
  }
}

function openModal(): void {
  isModalOpen = true;
  updateModalContent(currentLang);
  const overlay = document.getElementById('infoOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  (document.getElementById('infoModal') as HTMLElement | null)?.focus();
}

function closeModal(): void {
  isModalOpen = false;
  const overlay = document.getElementById('infoOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
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
    ws = new WebSocket(buildWsUrl());
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
  updateMuteButtonVisibility();

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

  // Info modal
  document.getElementById('infoButton')?.addEventListener('click', openModal);
  document.getElementById('infoOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('infoOverlay')) closeModal();
  });
  document.getElementById('infoModalCloseBtn')?.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isModalOpen) closeModal();
      if (isWelcomeModalOpen) closeWelcomeModal();
    }
  });

  // Welcome modal
  document.getElementById('welcomeCloseBtn')?.addEventListener('click', closeWelcomeModal);
  document.getElementById('welcomeOverlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('welcomeOverlay')) closeWelcomeModal();
  });
  if (new URLSearchParams(location.search).get('welcome') === '1') {
    openWelcomeModal();
  }

  const onlineEl = document.getElementById('online');
  const labels = LABELS[currentLang];
  if (onlineEl && labels) onlineEl.textContent = labels.connecting;

  connectWebSocket();

  updatePhrase();
  setInterval(updatePhrase, 200);
}

document.addEventListener('DOMContentLoaded', init);

import type { Translation } from './en';
import en from './en';
import ru from './ru';
import zh from './zh';

const LOCALE_KEY = 'j2me-web-player:locale';

const bundles: Record<string, Translation> = { en, ru, zh };

/** Detect the best locale from browser settings. */
function detectLocale(): string {
  const nav = navigator.language?.toLowerCase() ?? 'en';
  if (nav.startsWith('zh')) return 'zh';
  if (nav.startsWith('ru')) return 'ru';
  return 'en';
}

let current: Translation = bundles[detectLocale()] ?? en;

/** Switch the active language. Accepts 'en', 'ru', 'zh'. Persists to localStorage. */
export function setLocale(lang: string): void {
  const bundle = bundles[lang];
  if (!bundle) return;
  current = bundle;
  try {
    localStorage.setItem(LOCALE_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
}

/** Get the active translation bundle. */
export function t(): Translation {
  return current;
}

/** Get a translated string by key. */
export function tr(key: keyof Translation): string {
  return current[key];
}

/** Initialize locale from localStorage (or detect). Call once at startup. */
export function initLocale(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LOCALE_KEY);
  } catch {
    /* storage unavailable */
  }
  setLocale(saved && bundles[saved] ? saved : detectLocale());
}

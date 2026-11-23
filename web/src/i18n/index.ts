// The active language. A store rather than a context because the formatters,
// the validation and the chart builders are plain functions that read it too.
import { useSyncExternalStore } from "react";
import { en, type Messages } from "./en";
import { pt } from "./pt";

export type Locale = "en" | "pt";

export const LOCALES: { code: Locale; short: string; name: string }[] = [
  { code: "pt", short: "PT", name: "Português" },
  { code: "en", short: "EN", name: "English" },
];

const STORAGE_KEY = "batteryplan:locale";
const DICTIONARIES: Record<Locale, Messages> = { en, pt };
const INTL: Record<Locale, string> = { en: "en-US", pt: "pt-BR" };

function parseLocale(value: string | null | undefined): Locale | null {
  const code = value?.toLowerCase();
  if (code?.startsWith("pt")) return "pt";
  if (code?.startsWith("en")) return "en";
  return null;
}

function store(locale: Locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // storage may be unavailable; the choice then lasts until a reload
  }
}

function stored(): Locale | null {
  try {
    return parseLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** ?lang= is consumed here, so it cannot override a later choice on reload. */
function fromLink(): Locale | null {
  const url = new URL(window.location.href);
  const locale = parseLocale(url.searchParams.get("lang"));
  if (url.searchParams.has("lang")) {
    url.searchParams.delete("lang");
    window.history.replaceState(window.history.state, "", url);
  }
  if (locale) store(locale);
  return locale;
}

function detect(): Locale {
  if (typeof window === "undefined") return "en";
  return fromLink() ?? stored() ?? parseLocale(navigator.language) ?? "en";
}

function applyToDocument(locale: Locale) {
  if (typeof document === "undefined") return;
  const { meta } = DICTIONARIES[locale];
  document.documentElement.lang = INTL[locale];
  document.title = meta.title;
  document.querySelector('meta[name="description"]')?.setAttribute("content", meta.description);
}

let current = detect();
applyToDocument(current);

const listeners = new Set<() => void>();

export const getLocale = () => current;
export const intlLocale = () => INTL[current];
/** The dictionary of the active language, for code outside a component. */
export const messages = () => DICTIONARIES[current];

export function setLocale(next: Locale) {
  if (next === current) return;
  current = next;
  store(next);
  applyToDocument(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale);
  return { locale, t: DICTIONARIES[locale], setLocale };
}

// The site's charts share one palette: blue is charging, orange is delivering.
// Dark steps validated separately
// (the dataviz validator: lightness band, CVD separation, contrast).
import { useSyncExternalStore } from "react";

export interface Palette {
  dark: boolean;
  surface: string;
  ink: string;
  muted: string;
  faint: string;
  grid: string;
  charge: string;
  discharge: string;
  idle: string;
  chargeSoft: string;
  dischargeSoft: string;
  font: string;
  mono: string;
}

const FONT = '"Geist Variable", ui-sans-serif, system-ui, sans-serif';
const MONO = '"Geist Mono Variable", ui-monospace, monospace';

export const LIGHT: Palette = {
  dark: false,
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  muted: "#52514e",
  faint: "#8a8984",
  grid: "#e7e6e2",
  charge: "#2a78d6",
  discharge: "#eb6834",
  idle: "#d6d5d0",
  chargeSoft: "rgba(42,120,214,0.16)",
  dischargeSoft: "rgba(235,104,52,0.16)",
  font: FONT,
  mono: MONO,
};

export const DARK: Palette = {
  dark: true,
  surface: "#121211",
  ink: "#ecebe7",
  muted: "#a3a29d",
  faint: "#75746f",
  grid: "#2a2a28",
  charge: "#4c8ee3",
  discharge: "#dc6a36",
  idle: "#3a3a37",
  chargeSoft: "rgba(76,142,227,0.22)",
  dischargeSoft: "rgba(220,106,54,0.22)",
  font: FONT,
  mono: MONO,
};

const query = "(prefers-color-scheme: dark)";

function subscribe(callback: () => void): () => void {
  const media = window.matchMedia(query);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function usePalette(): Palette {
  const dark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
  return dark ? DARK : LIGHT;
}

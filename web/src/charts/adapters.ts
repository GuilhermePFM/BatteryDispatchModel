// Payload columns to chart data. Every column of result.schema.json may hold
// null where a value is undefined; nothing here turns a null into a zero
// unless the chart means "nothing happened" (a stacked share).
import type { Column } from "../contracts/types";

export type Value = number | null;

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** [key, value] pairs for a category or time axis; null stays null, which ECharts draws as a gap. */
export function pairs<K>(keys: K[], values: Column | undefined): [K, Value][] {
  return keys.map((key, i) => [key, isNum(values?.[i]) ? (values![i] as number) : null]);
}

export function hasData(values: Column | undefined): boolean {
  return Array.isArray(values) && values.some(isNum);
}

/** Running total; a null day adds nothing and is drawn as a gap. */
export function cumulative(values: Column): Value[] {
  let total = 0;
  return values.map((v) => {
    if (!isNum(v)) return null;
    total += v;
    return total;
  });
}

export function negate(values: Column): Value[] {
  return values.map((v) => (isNum(v) ? (v === 0 ? 0 : -v) : null));
}

/** hi - lo, for a band drawn as a stacked area on top of lo. */
export function bandHeight(lo: Column, hi: Column): Value[] {
  return lo.map((l, i) => (isNum(l) && isNum(hi[i]) ? (hi[i] as number) - l : null));
}

/** The price a sale must reach to pay for a purchase at `floor`, after the round trip. */
export function breakeven(floor: Column, markup: number): Value[] {
  return floor.map((f) => (isNum(f) && isNum(markup) ? f * (1 + markup) : null));
}

/** Each value over the first defined, non-zero one; all null when there is none. */
export function normaliseToFirst(values: Column): Value[] {
  const base = values.find((v) => isNum(v) && v !== 0);
  if (!isNum(base)) return values.map(() => null);
  return values.map((v) => (isNum(v) ? v / base : null));
}

export function quantile(values: Column, q: number): number | null {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

export function mean(values: Column): number | null {
  const defined = values.filter(isNum);
  return defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null;
}

export interface Histogram {
  edges: number[];
  counts: number[];
}

/** Equal-width bins over the defined values; one bin when they are all equal, none when there are none. */
export function histogram(values: Column, bins = 30): Histogram {
  const defined = values.filter(isNum);
  if (!defined.length) return { edges: [], counts: [] };
  const lo = Math.min(...defined);
  const hi = Math.max(...defined);
  if (hi === lo) return { edges: [lo - 0.5, hi + 0.5], counts: [defined.length] };
  const n = Math.max(1, Math.min(bins, Math.ceil(Math.sqrt(defined.length) * 2)));
  const width = (hi - lo) / n;
  const counts = new Array<number>(n).fill(0);
  for (const v of defined) counts[Math.min(n - 1, Math.floor((v - lo) / width))]++;
  return { edges: Array.from({ length: n + 1 }, (_, i) => lo + i * width), counts };
}

/** Bars of a histogram as [centre, count, lower edge, upper edge]. */
export function histogramBars(h: Histogram): [number, number, number, number][] {
  return h.counts.map((count, i) => [(h.edges[i] + h.edges[i + 1]) / 2, count, h.edges[i], h.edges[i + 1]]);
}

export interface Fit {
  slope: number;
  intercept: number;
  r2: number | null;
  n: number;
}

/** Least squares of y on x over the days where both are defined: battery_plan.analysis.fit. */
export function linearFit(x: Column, y: Column): Fit | null {
  const xs: number[] = [];
  const ys: number[] = [];
  x.forEach((xv, i) => {
    if (isNum(xv) && isNum(y[i])) {
      xs.push(xv);
      ys.push(y[i] as number);
    }
  });
  if (xs.length < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let residual = 0;
  let total = 0;
  for (let i = 0; i < xs.length; i++) {
    residual += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    total += (ys[i] - my) ** 2;
  }
  return { slope, intercept, r2: total ? 1 - residual / total : null, n: xs.length };
}

/** Scatter points [x, y, label] where both are defined. */
export function scatter(x: Column, y: Column, labels: string[]): [number, number, string][] {
  const out: [number, number, string][] = [];
  x.forEach((xv, i) => {
    if (isNum(xv) && isNum(y[i])) out.push([xv, y[i] as number, labels[i]]);
  });
  return out;
}

export interface HeatCells {
  cells: [number, number, number][];
  maxAbs: number;
}

/** The net power grid as [day index, hour index, MW], nulls left out; maxAbs at least 0.1. */
export function heatCells(values: Column[]): HeatCells {
  const cells: [number, number, number][] = [];
  let maxAbs = 0.1;
  values.forEach((row, d) =>
    (row ?? []).forEach((v, h) => {
      if (!isNum(v)) return;
      cells.push([d, h, v]);
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }),
  );
  return { cells, maxAbs };
}

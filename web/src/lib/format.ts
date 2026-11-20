// Number formatting for the page. Every formatter takes null (an undefined
// ratio, a day with nothing traded) and prints "n/a" rather than NaN.
export const NA = "n/a";

type N = number | null | undefined;

const ok = (value: N): value is number => typeof value === "number" && Number.isFinite(value);

export function gbp(value: N, digits = 0): string {
  if (!ok(value)) return NA;
  const sign = value < 0 ? "-" : "";
  return `${sign}£${Math.abs(value).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** £1.2k, £34k, £1.4m: for axes and tight tiles. */
export function gbpShort(value: N): string {
  if (!ok(value)) return NA;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${sign}£${trim(abs / 1e6, 2)}m`;
  if (abs >= 1e4) return `${sign}£${trim(abs / 1e3, 0)}k`;
  if (abs >= 1e3) return `${sign}£${trim(abs / 1e3, 1)}k`;
  return `${sign}£${trim(abs, abs < 10 ? 2 : 0)}`;
}

function trim(value: number, digits: number): string {
  return value.toLocaleString("en-GB", { maximumFractionDigits: digits });
}

export function num(value: N, digits = 0): string {
  if (!ok(value)) return NA;
  return value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(value: N, digits = 1): string {
  if (!ok(value)) return NA;
  return `${(value * 100).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function ratio(value: N, digits = 2): string {
  return ok(value) ? `${num(value, digits)}×` : NA;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2019-03-04 to "4 Mar 2019". */
export function day(iso: string | null | undefined): string {
  if (!iso) return NA;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function quarterLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
}

/** 7.5 to "07:30". */
export function hourLabel(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function duration(seconds: N): string {
  if (!ok(seconds)) return NA;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

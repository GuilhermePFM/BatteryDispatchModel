// The run form's rules: the run-request schema (bounds, defaults, integer
// fields) read from contracts/run-request.schema.json itself, plus the
// cross-field rules of contracts/README.md the schema cannot state.
import schema from "../../../contracts/run-request.schema.json";
import type { BatteryRequest, RunRequest } from "../contracts/types";

export const MAX_SPAN_DAYS = 365;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const CSV_HEADER = "timestamp,market_1,market_2";

type BatteryKey = keyof BatteryRequest;

interface SchemaNumber {
  description?: string;
  type: "number" | "integer";
  minimum: number;
  maximum: number;
  default?: number;
}

const batteryProps = schema.properties.battery.properties as Record<BatteryKey, SchemaNumber>;
const topProps = schema.properties as unknown as Record<string, SchemaNumber>;

export interface FieldSpec {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  integer: boolean;
  default: number | undefined;
  description: string;
  step: string;
}

/** Labels and units the schema leaves to the page; everything numeric comes from the schema. */
const BATTERY_UI: Record<BatteryKey, { label: string; unit: string; step: string }> = {
  max_charge_rate_mw: { label: "Charge rate", unit: "MW", step: "0.1" },
  max_discharge_rate_mw: { label: "Discharge rate", unit: "MW", step: "0.1" },
  max_storage_volume_mwh: { label: "Storage volume", unit: "MWh", step: "0.1" },
  charging_loss_fraction: { label: "Charging loss", unit: "fraction", step: "0.005" },
  discharging_loss_fraction: { label: "Discharging loss", unit: "fraction", step: "0.005" },
  lifetime_years: { label: "Calendar life", unit: "years", step: "1" },
  lifetime_cycles: { label: "Cycle life", unit: "cycles", step: "100" },
  degradation_pct_per_cycle: { label: "Degradation", unit: "% per cycle", step: "0.0005" },
  capex_gbp: { label: "Capex", unit: "GBP", step: "1000" },
  fixed_opex_gbp_per_year: { label: "Fixed opex", unit: "GBP / year", step: "100" },
};

function spec(key: string, s: SchemaNumber, ui: { label: string; unit: string; step: string }): FieldSpec {
  return {
    key,
    label: ui.label,
    unit: ui.unit,
    min: s.minimum,
    max: s.maximum,
    integer: s.type === "integer",
    default: s.default,
    description: s.description ?? "",
    step: ui.step,
  };
}

export const BATTERY_FIELDS: FieldSpec[] = (Object.keys(BATTERY_UI) as BatteryKey[]).map((key) =>
  spec(key, batteryProps[key], BATTERY_UI[key]),
);

export const CYCLE_BUDGET_FIELD = spec("cycle_budget", topProps.cycle_budget, {
  label: "Cycle budget",
  unit: "cycles",
  step: "1",
});

/** Every input as the text the user typed, so a half-typed number is not lost. */
export interface FormValues {
  battery: Record<BatteryKey, string>;
  cycle_budget: string;
  start: string;
  end: string;
}

export type FormErrors = Partial<Record<string, string>>;

export const DEFAULT_START = "2019-01-01";
export const DEFAULT_END = "2019-12-31";

export function defaultValues(): FormValues {
  const battery = {} as Record<BatteryKey, string>;
  for (const field of BATTERY_FIELDS) battery[field.key as BatteryKey] = String(field.default ?? "");
  return {
    battery,
    cycle_budget: "",
    start: DEFAULT_START,
    end: DEFAULT_END,
  };
}

/** The form a request would fill: used to edit and retry a run. */
export function valuesFromRequest(request: RunRequest): FormValues {
  const values = defaultValues();
  for (const field of BATTERY_FIELDS) {
    const value = request.battery?.[field.key as BatteryKey];
    if (typeof value === "number") values.battery[field.key as BatteryKey] = String(value);
  }
  values.cycle_budget = request.cycle_budget === undefined ? "" : String(request.cycle_budget);
  values.start = request.start ?? values.start;
  values.end = request.end ?? values.end;
  return values;
}

/** Why a typed number is not acceptable for a field, or null when it is. */
export function numberError(raw: string, field: FieldSpec, optional = false): string | null {
  const text = raw.trim();
  if (text === "") return optional ? null : "Required.";
  // Number("") is 0 and Number("1e3") is 1000: accept only plain decimals.
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) return "Enter a number.";
  const value = Number(text);
  if (!Number.isFinite(value)) return "Enter a number.";
  if (field.integer && !Number.isInteger(value)) return "Enter a whole number.";
  if (value < field.min) return `At least ${formatBound(field.min)} ${field.unit}.`;
  if (value > field.max) return `At most ${formatBound(field.max)} ${field.unit}.`;
  return null;
}

function formatBound(value: number): string {
  return value.toLocaleString("en-GB", { maximumFractionDigits: 6 });
}

const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** Days since the epoch for a YYYY-MM-DD that is a real calendar date, else null. */
export function parseDay(text: string): number | null {
  if (!DATE_RE.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.round(ms / 86_400_000);
}

export function dayToIso(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** What an uploaded file is known to cover, read in the browser. */
export interface PriceFileInfo {
  name: string;
  size: number;
  /** First and last day of data, when the file could be read. */
  firstDay?: string;
  lastDay?: string;
  /** A problem found before upload; the solver checks the rest. */
  problem?: string;
}

/** Checks the cheap things about a price CSV: size, header, and the span of dates it covers. */
export function inspectPriceCsv(name: string, size: number, text: string): PriceFileInfo {
  const info: PriceFileInfo = { name, size };
  if (size === 0) return { ...info, problem: "The file is empty." };
  if (size > MAX_UPLOAD_BYTES) return { ...info, problem: "The file is larger than 5 MB." };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = (lines[0] ?? "").replace(/\s/g, "").toLowerCase();
  if (header !== CSV_HEADER) {
    return { ...info, problem: `Line 1 should be the header "${CSV_HEADER}".` };
  }
  if (lines.length < 2) return { ...info, problem: "The file has a header but no rows." };
  const first = lines[1].split(",")[0]?.trim().slice(0, 10) ?? "";
  const last = lines[lines.length - 1].split(",")[0]?.trim().slice(0, 10) ?? "";
  if (parseDay(first) === null) {
    return { ...info, problem: `Line 2: "${lines[1].split(",")[0]}" is not an ISO 8601 timestamp.` };
  }
  if (parseDay(last) === null) {
    return {
      ...info,
      problem: `Line ${lines.length}: "${lines[lines.length - 1].split(",")[0]}" is not an ISO 8601 timestamp.`,
    };
  }
  return { ...info, firstDay: first, lastDay: last };
}

/** Every rule the API applies before queueing, per field; empty when the form can be sent. */
export function validate(values: FormValues, file?: PriceFileInfo | null): FormErrors {
  const errors: FormErrors = {};
  for (const field of BATTERY_FIELDS) {
    const error = numberError(values.battery[field.key as BatteryKey], field);
    if (error) errors[`battery.${field.key}`] = error;
  }
  const budget = numberError(values.cycle_budget, CYCLE_BUDGET_FIELD, true);
  if (budget) errors.cycle_budget = budget;

  const start = parseDay(values.start);
  const end = parseDay(values.end);
  if (start === null) errors.start = "Enter a date as YYYY-MM-DD.";
  if (end === null) errors.end = "Enter a date as YYYY-MM-DD.";
  if (start !== null && end !== null) {
    if (start > end) errors.end = "The end is before the start.";
    else if (end - start > MAX_SPAN_DAYS) {
      errors.end = `At most ${MAX_SPAN_DAYS} days after the start (${dayToIso(start + MAX_SPAN_DAYS)}).`;
    }
  }

  if (file?.problem) {
    errors.prices = file.problem;
  } else if (file) {
    const first = file.firstDay ? parseDay(file.firstDay) : null;
    const last = file.lastDay ? parseDay(file.lastDay) : null;
    if (start !== null && first !== null && start < first) {
      errors.start = `The file starts on ${file.firstDay}.`;
    }
    if (end !== null && last !== null && end > last) {
      errors.end = `The file ends on ${file.lastDay}.`;
    }
  } else {
    errors.prices = "Upload a price file.";
  }
  return errors;
}

/** The request body for a valid form. Optional fields are omitted, never null. */
export function buildRequest(values: FormValues, pricesKey?: string): RunRequest {
  const battery = {} as BatteryRequest;
  for (const field of BATTERY_FIELDS) {
    battery[field.key as BatteryKey] = Number(values.battery[field.key as BatteryKey].trim());
  }
  const request: RunRequest = {
    battery,
    start: values.start,
    end: values.end,
  };
  if (values.cycle_budget.trim() !== "") request.cycle_budget = Number(values.cycle_budget.trim());
  if (pricesKey) request.prices_key = pricesKey;
  return request;
}

/** Round trip and breakeven for the losses typed so far, or null while they are invalid. */
export function roundTrip(values: FormValues): { efficiency: number; markup: number } | null {
  const c = Number(values.battery.charging_loss_fraction);
  const d = Number(values.battery.discharging_loss_fraction);
  const fields = BATTERY_FIELDS.filter((f) => f.key.endsWith("loss_fraction"));
  if (fields.some((f) => numberError(values.battery[f.key as BatteryKey], f))) return null;
  const efficiency = (1 - c) * (1 - d);
  return { efficiency, markup: 1 / efficiency - 1 };
}

/** Days covered by a valid start and end, inclusive. */
export function spanDays(values: FormValues): number | null {
  const start = parseDay(values.start);
  const end = parseDay(values.end);
  if (start === null || end === null || end < start) return null;
  return end - start + 1;
}

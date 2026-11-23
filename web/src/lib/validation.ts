// The run form's rules: the bounds of contracts/v2/run-request.schema.json,
// read from the schema itself, plus the cross-field rules the schema cannot
// state. The form asks for the battery as sized in model.md §2 and derives the
// physical request from it.
import schema from "../../../contracts/v2/run-request.schema.json";
import type { BatteryRequest, RunRequest } from "../contracts/types";
import { intlLocale, messages } from "../i18n";
import { isDecimal, looksGrouped, toNumber } from "./decimal";
import { checkPldCsv } from "./pld";

export const BUNDLED_START = "2025-01-20";
export const BUNDLED_END = "2026-11-20";
/** end - start: any 365 consecutive days hold all twelve calendar months. */
export const MIN_SPAN_DAYS = 364;
export const MAX_SPAN_DAYS = 730;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The auction's sizing rules (CRCAP 5.1.1; model.md, contract limits). */
export const CONTRACT_MIN_POWER_MW = 30;
export const CONTRACT_MIN_HOURS = 4;
export const CONTRACT_MIN_RTE = 0.85;
export const CONTRACT_MAX_RECHARGE_HOURS = 6;

interface SchemaNumber {
  description?: string;
  type: "number" | "integer";
  minimum: number;
  maximum: number;
  default?: number;
}

const batteryProps = schema.properties.battery.properties as Record<keyof BatteryRequest, SchemaNumber>;
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
  /** Empty is valid: the value is then derived from the other fields. */
  optional?: boolean;
}

export type BatteryKey = "power_mw" | "duration_hours" | "round_trip_efficiency" | "charge_rate_mw" | "discharge_rate_mw" | "degradation_pct_per_cycle";

/** Each one-way efficiency is at least the schema's minimum, so the round trip is at least its square. */
const MIN_ROUND_TRIP = batteryProps.charge_efficiency.minimum * batteryProps.discharge_efficiency.minimum;

type FieldBounds = Omit<FieldSpec, "label" | "unit" | "description">;

/** A field whose texts are read from the active language each time they are shown. */
function localized(spec: FieldBounds): FieldSpec {
  const text = () => messages().fields[spec.key as keyof ReturnType<typeof messages>["fields"]];
  return Object.defineProperties(spec, {
    label: { get: () => text().label, enumerable: true },
    unit: { get: () => text().unit, enumerable: true },
    description: { get: () => text().description, enumerable: true },
  }) as FieldSpec;
}

const BATTERY_BOUNDS: FieldBounds[] = [
  {
    key: "power_mw",
    min: batteryProps.power_mw.minimum,
    max: batteryProps.power_mw.maximum,
    integer: false,
    default: batteryProps.power_mw.default,
    step: "1",
  },
  {
    key: "duration_hours",
    min: 0.25,
    max: 24,
    integer: false,
    default: 4,
    step: "0.5",
  },
  {
    key: "round_trip_efficiency",
    min: MIN_ROUND_TRIP,
    max: 1,
    integer: false,
    default: 0.85,
    step: "0.01",
  },
  {
    key: "charge_rate_mw",
    min: batteryProps.max_charge_mw.minimum,
    max: batteryProps.max_charge_mw.maximum,
    integer: false,
    default: undefined,
    step: "1",
    optional: true,
  },
  {
    key: "discharge_rate_mw",
    min: batteryProps.max_discharge_mw.minimum,
    max: batteryProps.max_discharge_mw.maximum,
    integer: false,
    default: undefined,
    step: "1",
    optional: true,
  },
  {
    key: "degradation_pct_per_cycle",
    min: batteryProps.degradation_pct_per_cycle.minimum,
    max: batteryProps.degradation_pct_per_cycle.maximum,
    integer: false,
    default: batteryProps.degradation_pct_per_cycle.default,
    step: "0.0005",
  },
];

export const BATTERY_FIELDS: FieldSpec[] = BATTERY_BOUNDS.map((spec) => localized(spec));

export const CYCLE_BUDGET_FIELD: FieldSpec = localized({
  key: "cycle_budget",
  min: topProps.cycle_budget.minimum,
  max: topProps.cycle_budget.maximum,
  integer: false,
  default: undefined,
  step: "1",
});

/** The horizon in days, inclusive of both dates. It moves the start date and is not sent. */
export const HORIZON_FIELD: FieldSpec = localized({
  key: "horizon_days",
  min: MIN_SPAN_DAYS + 1,
  max: MAX_SPAN_DAYS + 1,
  integer: true,
  default: MIN_SPAN_DAYS + 1,
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

/** The precomputed run: the last full year of the bundled prices. */
export const DEFAULT_START = "2025-11-21";
export const DEFAULT_END = BUNDLED_END;

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

/** Six decimals: enough to rebuild a form-made request, without the float noise. */
const tidy = (value: number) => String(Math.round(value * 1e6) / 1e6);

/** The form a request would fill: used to edit and retry a run. */
export function valuesFromRequest(request: RunRequest): FormValues {
  const values = defaultValues();
  const b = request.battery;
  if (b && [b.power_mw, b.volume_mwh, b.max_charge_mw, b.max_discharge_mw, b.charge_efficiency, b.discharge_efficiency].every((v) => typeof v === "number" && v > 0)) {
    const delivered = b.max_discharge_mw * b.discharge_efficiency;
    values.battery = {
      power_mw: tidy(b.power_mw),
      duration_hours: tidy((b.volume_mwh * b.discharge_efficiency) / b.power_mw),
      round_trip_efficiency: tidy(b.charge_efficiency * b.discharge_efficiency),
      // A rate that matches the automatic one stays empty, so it keeps following the battery.
      charge_rate_mw: Math.abs(b.max_charge_mw - b.power_mw) < 1e-6 ? "" : String(b.max_charge_mw),
      discharge_rate_mw: Math.abs(delivered - b.power_mw) < 1e-6 ? "" : String(delivered),
      degradation_pct_per_cycle: String(b.degradation_pct_per_cycle ?? values.battery.degradation_pct_per_cycle),
    };
  }
  values.cycle_budget = request.cycle_budget === undefined ? "" : String(request.cycle_budget);
  values.start = request.start ?? values.start;
  values.end = request.end ?? values.end;
  return values;
}

/** Why a typed number is not acceptable for a field, or null when it is. */
export function numberError(raw: string, field: FieldSpec, optional = false): string | null {
  const t = messages().validation;
  const text = raw.trim();
  if (text === "") return optional ? null : t.required;
  // Number("") is 0 and Number("1e3") is 1000: accept only plain decimals.
  if (!isDecimal(text)) return t.enterNumber;
  if (looksGrouped(text)) return t.groupedNumber;
  const value = toNumber(text);
  if (!Number.isFinite(value)) return t.enterNumber;
  if (field.integer && !Number.isInteger(value)) return t.wholeNumber;
  if (value < field.min) return t.atLeast(formatBound(field.min), field.unit);
  if (value > field.max) return t.atMost(formatBound(field.max), field.unit);
  return null;
}

function formatBound(value: number): string {
  return value.toLocaleString(intlLocale(), { maximumFractionDigits: 6 });
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

/** The start of a horizon of `days` ending on a valid end, inclusive, else null. */
export function startForHorizon(end: string, days: number): string | null {
  const last = parseDay(end);
  return last === null ? null : dayToIso(last - days + 1);
}

/** What an uploaded file is known to cover, read in the browser. */
export interface PriceFileInfo {
  name: string;
  size: number;
  /** First and last day of data, when the file could be read. */
  firstDay?: string;
  lastDay?: string;
  /** A problem found before upload; the solver checks the file again. */
  problem?: string;
}

/** The whole upload check of lib/pld.ts, plus the span of dates the file covers. */
export function inspectPriceCsv(name: string, size: number, data: Uint8Array): PriceFileInfo {
  const info: PriceFileInfo = { name, size };
  if (size === 0) return { ...info, problem: "The file is empty." };
  if (size > MAX_UPLOAD_BYTES) return { ...info, problem: "The file is larger than 5 MB." };
  const problem = checkPldCsv(data);
  if (problem) return { ...info, problem: problem.message };
  const lines = new TextDecoder().decode(data).split(/\r?\n/).filter((line) => line !== "");
  return { ...info, firstDay: lines[1].slice(0, 10), lastDay: lines[lines.length - 1].slice(0, 10) };
}

/** The physical request for typed values that are valid numbers (§2). */
export function physicalBattery(values: FormValues): BatteryRequest {
  const power = toNumber(values.battery.power_mw);
  const hours = toNumber(values.battery.duration_hours);
  const rte = toNumber(values.battery.round_trip_efficiency);
  const charge = values.battery.charge_rate_mw.trim();
  const discharge = values.battery.discharge_rate_mw.trim();
  const oneWay = Math.sqrt(rte);
  const volume = (hours * power) / oneWay;
  return {
    power_mw: power,
    volume_mwh: volume,
    max_charge_mw: charge === "" ? power : toNumber(charge),
    // The form states the rate at the grid; the request measures it in the store.
    max_discharge_mw: (discharge === "" ? power : toNumber(discharge)) / oneWay,
    charge_efficiency: oneWay,
    discharge_efficiency: oneWay,
    degradation_pct_per_cycle: toNumber(values.battery.degradation_pct_per_cycle),
  };
}

/** Every rule the API applies before queueing, per field; empty when the form can be sent. */
export function validate(values: FormValues, file?: PriceFileInfo | null): FormErrors {
  const t = messages().validation;
  const errors: FormErrors = {};
  for (const field of BATTERY_FIELDS) {
    const error = numberError(values.battery[field.key as BatteryKey], field, field.optional);
    if (error) errors[`battery.${field.key}`] = error;
  }
  if (!Object.keys(errors).length) {
    const b = physicalBattery(values);
    if (b.volume_mwh > batteryProps.volume_mwh.maximum) {
      errors["battery.duration_hours"] = t.volumeMost(formatBound(b.volume_mwh), formatBound(batteryProps.volume_mwh.maximum));
    } else if (b.volume_mwh < batteryProps.volume_mwh.minimum) {
      errors["battery.duration_hours"] = t.volumeLeast(formatBound(b.volume_mwh), formatBound(batteryProps.volume_mwh.minimum));
    }
    // Capex and opex scale with the power delivered, so a faster rate would come free.
    const mostPower = b.power_mw * (1 + 1e-9);
    if (b.max_charge_mw > mostPower) {
      errors["battery.charge_rate_mw"] = t.atMostPower(formatBound(b.power_mw));
    }
    if (b.max_discharge_mw * b.discharge_efficiency > mostPower) {
      errors["battery.discharge_rate_mw"] = t.atMostPower(formatBound(b.power_mw));
    }
  }
  const budget = numberError(values.cycle_budget, CYCLE_BUDGET_FIELD, true);
  if (budget) errors.cycle_budget = budget;

  const start = parseDay(values.start);
  const end = parseDay(values.end);
  if (start === null) errors.start = t.dateFormat;
  if (end === null) errors.end = t.dateFormat;
  if (start !== null && end !== null) {
    if (start > end) errors.end = t.endBeforeStart;
    else if (end - start < MIN_SPAN_DAYS) {
      errors.end = t.fullYear(dayToIso(start + MIN_SPAN_DAYS));
    } else if (end - start > MAX_SPAN_DAYS) {
      errors.end = t.maxSpan(MAX_SPAN_DAYS, dayToIso(start + MAX_SPAN_DAYS));
    }
  }

  if (file?.problem) {
    errors.prices = file.problem;
  } else if (file) {
    const first = file.firstDay ? parseDay(file.firstDay) : null;
    const last = file.lastDay ? parseDay(file.lastDay) : null;
    if (start !== null && first !== null && start < first) {
      errors.start = t.fileStarts(file.firstDay);
    }
    if (end !== null && last !== null && end > last) {
      errors.end = t.fileEnds(file.lastDay);
    }
  } else {
    const lo = parseDay(BUNDLED_START)!;
    const hi = parseDay(BUNDLED_END)!;
    if (start !== null && start < lo) errors.start = t.bundledStarts(BUNDLED_START);
    if (end !== null && end > hi) errors.end = t.bundledEnds(BUNDLED_END);
  }
  return errors;
}

/** The request body for a valid form. Optional fields are omitted, never null. */
export function buildRequest(values: FormValues, pricesKey?: string): RunRequest {
  const request: RunRequest = {
    battery: physicalBattery(values),
    start: values.start,
    end: values.end,
  };
  if (values.cycle_budget.trim() !== "") request.cycle_budget = toNumber(values.cycle_budget);
  if (pricesKey) request.prices_key = pricesKey;
  return request;
}

/** Round trip and breakeven for the efficiency typed so far, or null while it is invalid. */
export function roundTrip(values: FormValues): { efficiency: number; markup: number } | null {
  const field = BATTERY_FIELDS.find((f) => f.key === "round_trip_efficiency")!;
  if (numberError(values.battery.round_trip_efficiency, field)) return null;
  const efficiency = toNumber(values.battery.round_trip_efficiency);
  return { efficiency, markup: 1 / efficiency - 1 };
}

/** Why this battery could not enter the auction. A warning: the merchant case still runs. */
export function contractWarnings(values: FormValues): string[] {
  if (BATTERY_FIELDS.some((f) => numberError(values.battery[f.key as BatteryKey], f, f.optional))) return [];
  const power = toNumber(values.battery.power_mw);
  const hours = toNumber(values.battery.duration_hours);
  const rte = toNumber(values.battery.round_trip_efficiency);
  const b = physicalBattery(values);
  const t = messages().validation;
  const out: string[] = [];
  if (power < CONTRACT_MIN_POWER_MW) out.push(t.underPower(formatBound(CONTRACT_MIN_POWER_MW)));
  if (hours < CONTRACT_MIN_HOURS) out.push(t.underHours(formatBound(CONTRACT_MIN_HOURS)));
  if (rte < CONTRACT_MIN_RTE) out.push(t.underRte(formatBound(CONTRACT_MIN_RTE)));
  // CRCAP 5.1.1(vii) times the contracted 4 h of storage, not the whole volume.
  if (b.max_charge_mw * rte * CONTRACT_MAX_RECHARGE_HOURS < CONTRACT_MIN_HOURS * power * (1 - 1e-9)) {
    out.push(t.slowRecharge(formatBound(CONTRACT_MIN_HOURS), formatBound(CONTRACT_MAX_RECHARGE_HOURS)));
  }
  if (b.max_discharge_mw * b.discharge_efficiency < power * (1 - 1e-9)) {
    out.push(t.slowDischarge);
  }
  return out;
}

/** What an empty rate field resolves to, or null while the sizing fields are invalid. */
export function automaticRates(values: FormValues): { chargeMw: number; dischargeMw: number } | null {
  const sizing = BATTERY_FIELDS.filter((f) => ["power_mw", "duration_hours", "round_trip_efficiency"].includes(f.key));
  if (sizing.some((f) => numberError(values.battery[f.key as BatteryKey], f))) return null;
  const power = toNumber(values.battery.power_mw);
  return { chargeMw: power, dischargeMw: power };
}

/** Days covered by a valid start and end, inclusive. */
export function spanDays(values: FormValues): number | null {
  const start = parseDay(values.start);
  const end = parseDay(values.end);
  if (start === null || end === null || end < start) return null;
  return end - start + 1;
}

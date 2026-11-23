// The run form's rules: the bounds of contracts/v2/run-request.schema.json,
// read from the schema itself, plus the cross-field rules the schema cannot
// state. The form asks for the battery as sized in model.md §2 and derives the
// physical request from it.
import schema from "../../../contracts/v2/run-request.schema.json";
import type { BatteryRequest, RunRequest } from "../contracts/types";
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
}

export type BatteryKey = "power_mw" | "duration_hours" | "round_trip_efficiency" | "recharge_hours" | "degradation_pct_per_cycle";

/** Each one-way efficiency is at least the schema's minimum, so the round trip is at least its square. */
const MIN_ROUND_TRIP = batteryProps.charge_efficiency.minimum * batteryProps.discharge_efficiency.minimum;

export const BATTERY_FIELDS: FieldSpec[] = [
  {
    key: "power_mw",
    label: "Power delivered",
    unit: "MW",
    min: batteryProps.power_mw.minimum,
    max: batteryProps.power_mw.maximum,
    integer: false,
    default: batteryProps.power_mw.default,
    description: "Delivered to the grid. Under 30 MW the project cannot enter the auction.",
    step: "1",
  },
  {
    key: "duration_hours",
    label: "Duration",
    unit: "hours delivered",
    min: 0.25,
    max: 24,
    integer: false,
    default: 4,
    description: "Hours at full power from a full store, after losses. The contract needs 4.",
    step: "0.5",
  },
  {
    key: "round_trip_efficiency",
    label: "Round-trip efficiency",
    unit: "fraction",
    min: MIN_ROUND_TRIP,
    max: 1,
    integer: false,
    default: 0.85,
    description: "Energy back over energy in, split evenly between charging and discharging. The contract needs 0.85.",
    step: "0.01",
  },
  {
    key: "recharge_hours",
    label: "Full recharge",
    unit: "hours",
    min: 0.25,
    max: 48,
    integer: false,
    default: 6,
    description: "Hours to refill the whole store. The contract needs the contracted 4 h back within 6.",
    step: "0.5",
  },
  {
    key: "degradation_pct_per_cycle",
    label: "Degradation",
    unit: "% per cycle",
    min: batteryProps.degradation_pct_per_cycle.minimum,
    max: batteryProps.degradation_pct_per_cycle.maximum,
    integer: false,
    default: batteryProps.degradation_pct_per_cycle.default,
    description: "Share of the nominal volume lost per full cycle.",
    step: "0.0005",
  },
];

export const CYCLE_BUDGET_FIELD: FieldSpec = {
  key: "cycle_budget",
  label: "Cycle budget",
  unit: "cycles",
  min: topProps.cycle_budget.minimum,
  max: topProps.cycle_budget.maximum,
  integer: false,
  default: undefined,
  description: topProps.cycle_budget.description ?? "",
  step: "1",
};

/** Every input as the text the user typed, so a half-typed number is not lost. */
export interface FormValues {
  battery: Record<BatteryKey, string>;
  cycle_budget: string;
  start: string;
  end: string;
}

export type FormErrors = Partial<Record<string, string>>;

export const DEFAULT_START = BUNDLED_START;
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
  if (b && [b.power_mw, b.volume_mwh, b.max_charge_mw, b.charge_efficiency, b.discharge_efficiency].every((v) => typeof v === "number" && v > 0)) {
    values.battery = {
      power_mw: tidy(b.power_mw),
      duration_hours: tidy((b.volume_mwh * b.discharge_efficiency) / b.power_mw),
      round_trip_efficiency: tidy(b.charge_efficiency * b.discharge_efficiency),
      recharge_hours: tidy(b.volume_mwh / (b.charge_efficiency * b.max_charge_mw)),
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
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
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
  const power = Number(values.battery.power_mw.trim());
  const hours = Number(values.battery.duration_hours.trim());
  const rte = Number(values.battery.round_trip_efficiency.trim());
  const recharge = Number(values.battery.recharge_hours.trim());
  const oneWay = Math.sqrt(rte);
  const volume = (hours * power) / oneWay;
  return {
    power_mw: power,
    volume_mwh: volume,
    max_charge_mw: volume / (recharge * oneWay),
    max_discharge_mw: power / oneWay,
    charge_efficiency: oneWay,
    discharge_efficiency: oneWay,
    degradation_pct_per_cycle: Number(values.battery.degradation_pct_per_cycle.trim()),
  };
}

/** Every rule the API applies before queueing, per field; empty when the form can be sent. */
export function validate(values: FormValues, file?: PriceFileInfo | null): FormErrors {
  const errors: FormErrors = {};
  for (const field of BATTERY_FIELDS) {
    const error = numberError(values.battery[field.key as BatteryKey], field);
    if (error) errors[`battery.${field.key}`] = error;
  }
  if (!Object.keys(errors).length) {
    const b = physicalBattery(values);
    if (b.volume_mwh > batteryProps.volume_mwh.maximum) {
      errors["battery.duration_hours"] = `This makes ${formatBound(b.volume_mwh)} MWh; the most is ${formatBound(batteryProps.volume_mwh.maximum)}.`;
    } else if (b.volume_mwh < batteryProps.volume_mwh.minimum) {
      errors["battery.duration_hours"] = `This makes ${formatBound(b.volume_mwh)} MWh; the least is ${formatBound(batteryProps.volume_mwh.minimum)}.`;
    }
    if (b.max_charge_mw > batteryProps.max_charge_mw.maximum || b.max_charge_mw < batteryProps.max_charge_mw.minimum) {
      errors["battery.recharge_hours"] = `This needs a charge rate of ${formatBound(b.max_charge_mw)} MW, outside ${formatBound(batteryProps.max_charge_mw.minimum)} to ${formatBound(batteryProps.max_charge_mw.maximum)}.`;
    }
    if (b.max_discharge_mw > batteryProps.max_discharge_mw.maximum) {
      errors["battery.power_mw"] = `This needs a discharge rate above ${formatBound(batteryProps.max_discharge_mw.maximum)} MW.`;
    }
  }
  const budget = numberError(values.cycle_budget, CYCLE_BUDGET_FIELD, true);
  if (budget) errors.cycle_budget = budget;

  const start = parseDay(values.start);
  const end = parseDay(values.end);
  if (start === null) errors.start = "Enter a date as YYYY-MM-DD.";
  if (end === null) errors.end = "Enter a date as YYYY-MM-DD.";
  if (start !== null && end !== null) {
    if (start > end) errors.end = "The end is before the start.";
    else if (end - start < MIN_SPAN_DAYS) {
      errors.end = `At least a full year: ${dayToIso(start + MIN_SPAN_DAYS)} or later.`;
    } else if (end - start > MAX_SPAN_DAYS) {
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
    const lo = parseDay(BUNDLED_START)!;
    const hi = parseDay(BUNDLED_END)!;
    if (start !== null && start < lo) errors.start = `The bundled prices start on ${BUNDLED_START}.`;
    if (end !== null && end > hi) errors.end = `The bundled prices end on ${BUNDLED_END}.`;
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
  if (values.cycle_budget.trim() !== "") request.cycle_budget = Number(values.cycle_budget.trim());
  if (pricesKey) request.prices_key = pricesKey;
  return request;
}

/** Round trip and breakeven for the efficiency typed so far, or null while it is invalid. */
export function roundTrip(values: FormValues): { efficiency: number; markup: number } | null {
  const field = BATTERY_FIELDS.find((f) => f.key === "round_trip_efficiency")!;
  if (numberError(values.battery.round_trip_efficiency, field)) return null;
  const efficiency = Number(values.battery.round_trip_efficiency);
  return { efficiency, markup: 1 / efficiency - 1 };
}

/** Why this battery could not enter the auction. A warning: the merchant case still runs. */
export function contractWarnings(values: FormValues): string[] {
  if (BATTERY_FIELDS.some((f) => numberError(values.battery[f.key as BatteryKey], f))) return [];
  const power = Number(values.battery.power_mw);
  const hours = Number(values.battery.duration_hours);
  const rte = Number(values.battery.round_trip_efficiency);
  const recharge = Number(values.battery.recharge_hours);
  const out: string[] = [];
  if (power < CONTRACT_MIN_POWER_MW) out.push(`Under ${CONTRACT_MIN_POWER_MW} MW the project cannot enter the auction.`);
  if (hours < CONTRACT_MIN_HOURS) out.push(`Under ${CONTRACT_MIN_HOURS} h delivered, the contracted case is not solved.`);
  if (rte < CONTRACT_MIN_RTE) out.push(`Under ${CONTRACT_MIN_RTE} round trip, the contracted case is not solved.`);
  // CRCAP 5.1.1(vii) times the contracted 4 h of storage, not the whole volume.
  if ((recharge * CONTRACT_MIN_HOURS) / hours > CONTRACT_MAX_RECHARGE_HOURS * (1 + 1e-9)) {
    out.push(`If the contracted ${CONTRACT_MIN_HOURS} h take over ${CONTRACT_MAX_RECHARGE_HOURS} h to recharge, the contracted case is not solved.`);
  }
  return out;
}

/** Days covered by a valid start and end, inclusive. */
export function spanDays(values: FormValues): number | null {
  const start = parseDay(values.start);
  const end = parseDay(values.end);
  if (start === null || end === null || end < start) return null;
  return end - start + 1;
}

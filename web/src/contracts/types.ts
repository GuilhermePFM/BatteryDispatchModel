// TypeScript mirrors of contracts/v2/*.schema.json. The schemas are the source
// of truth; these types only describe what the browser reads and writes.
import type { MonthlyBlock } from "../finance/model";

export type Nullable<T> = T | null;
export type Column = Nullable<number>[];

export const CONTRACT_VERSION = 2;
export const MODEL_VERSION = "pld-hourly-1";

export type Submarket = "SE" | "S" | "NE" | "N";
export type BusinessCase = "contracted" | "merchant";

export interface BatteryRequest {
  power_mw: number;
  volume_mwh: number;
  max_charge_mw: number;
  max_discharge_mw: number;
  charge_efficiency: number;
  discharge_efficiency: number;
  degradation_pct_per_cycle: number;
}

export interface RunRequest {
  battery: BatteryRequest;
  cycle_budget?: number;
  start: string;
  end: string;
  prices_key?: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface Progress {
  phase: "solving" | "done";
  cases_done: number;
  cases_total: number;
  submarket: Nullable<Submarket>;
  case: Nullable<BusinessCase>;
  fraction: number;
  elapsed: number;
  done: boolean;
  updated_at: string;
}

export interface RunError {
  code: "prices_invalid" | "request_invalid" | "solver_failed";
  message: string;
}

export interface RunRecord {
  version: 2;
  run_id: string;
  user_sub: string;
  params_hash: string;
  status: RunStatus;
  request: RunRequest;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  progress?: Progress;
  error?: RunError;
  result?: Result;
  plan_csv_key?: string;
  /** Added by GET /api/runs/{id} once succeeded: a presigned GET, valid 1 h. */
  plan_csv_url?: string;
}

/** False for a record or result written by an earlier contract or model version. */
export function isCurrentRecord(record: { version?: unknown; result?: { version?: unknown; model_version?: unknown } | null }): boolean {
  if (record.version !== CONTRACT_VERSION) return false;
  const result = record.result;
  return !result || (result.version === CONTRACT_VERSION && result.model_version === MODEL_VERSION);
}

export interface RankingRow {
  rank: number;
  submarket: Submarket;
  balanced_year_brl: number;
  last_twelve_months_brl: number;
  regret_brl_per_year: number;
}

export interface ResultCase {
  submarket: Submarket;
  case: BusinessCase;
  value_brl: number;
  balanced_year_brl: number;
  last_twelve_months_brl: number;
  physical_cycles: number;
  cycles_per_year: number;
  max_injection_hours: number;
  method: "lp" | "lp-relaxation" | "milp";
  binary_days: number;
  solve_seconds: number;
  monthly: MonthlyBlock;
}

export interface ResultDetail {
  submarket: Submarket;
  case: BusinessCase;
  daily: {
    date: string[];
    value_brl: number[];
    cycles: number[];
    price_mean: number[];
    price_min: number[];
    price_max: number[];
    storage_end_mwh: number[];
  };
  profile: { hour: number[]; price: number[]; charge_mw: number[]; discharge_mw: number[] };
  week: { hora: string[]; price: number[]; charge_mw: number[]; discharge_mw: number[]; storage_mwh: number[] };
  net_power: { date: string[]; permille: number[][] };
}

export interface Result {
  version: 2;
  model_version: typeof MODEL_VERSION;
  horizon: { start: string; end: string; days: number; hours: number };
  battery: {
    power_mw: number;
    volume_mwh: number;
    max_charge_mw: number;
    max_discharge_mw: number;
    charge_efficiency: number;
    discharge_efficiency: number;
    round_trip_efficiency: number;
    degradation_pct_per_cycle: number;
    duration_hours: number;
    contract_cycles_per_physical: number;
    cycle_budget: Nullable<number>;
  };
  eligibility: {
    contract_eligible: boolean;
    contract_shortfalls: string[];
    below_minimum_power: boolean;
    minimum_power_mw: number;
  };
  ranking: RankingRow[];
  cases: ResultCase[];
  detail: ResultDetail;
  solve_seconds: number;
}

export interface Me {
  sub: string;
  /** Null when the ID token has no email. */
  email: string | null;
  quota: { used: number; limit: number; remaining: number; resets_at: string };
  global: { remaining: number };
}

export interface UploadTicket {
  url: string;
  fields: Record<string, string>;
  prices_key: string;
}

export interface RunCreated {
  run_id: string;
  status: RunStatus;
  cached: boolean;
}

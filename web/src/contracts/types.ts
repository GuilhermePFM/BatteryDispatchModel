// TypeScript mirrors of contracts/*.schema.json. The schemas are the source of
// truth; these types only describe what the browser reads and writes.

export type Nullable<T> = T | null;
export type Column = Nullable<number>[];

export interface BatteryRequest {
  max_charge_rate_mw: number;
  max_discharge_rate_mw: number;
  max_storage_volume_mwh: number;
  charging_loss_fraction: number;
  discharging_loss_fraction: number;
  lifetime_years: number;
  lifetime_cycles: number;
  degradation_pct_per_cycle: number;
  capex_gbp: number;
  fixed_opex_gbp_per_year: number;
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
  phase: string;
  pass_index: number;
  passes_estimated: Nullable<number>;
  passes_max: Nullable<number>;
  pass_fraction: number;
  fraction: number;
  cycle_value: number;
  elapsed: number;
  done: boolean;
  updated_at: string;
}

export interface RunError {
  code: "prices_invalid" | "request_invalid" | "solver_failed";
  message: string;
}

export interface RunRecord {
  version: 1;
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

export interface SpreadReading {
  key:
    | "day_range"
    | "harvestable_spread"
    | "volatility"
    | "market_gap"
    | "realised"
    | "price_level";
  reading: string;
  gbp_per_unit: Nullable<number>;
  r2: Nullable<number>;
  exogenous: boolean;
}

export interface Result {
  version: 1;
  horizon: {
    start: string;
    end: string;
    periods: number;
    days: number;
    period_minutes: number;
  };
  battery: {
    power_charge_mw: number;
    power_discharge_mw: number;
    volume_mwh: number;
    round_trip_efficiency: number;
    breakeven_markup: number;
    degradation_per_cycle: number;
    cycle_budget: number;
  };
  headline: {
    profit_gbp: number;
    net_revenue_market_1_gbp: number;
    net_revenue_market_2_gbp: number;
    income_gbp: number;
    cost_gbp: number;
    energy_bought_mwh: number;
    energy_delivered_mwh: number;
    mean_buy_price_gbp_per_mwh: Nullable<number>;
    mean_sell_price_gbp_per_mwh: Nullable<number>;
    cycles_used: number;
    cycle_budget: number;
    final_storage_mwh: number;
    final_usable_volume_mwh: number;
    periods: number;
    periods_charging: number;
    periods_discharging: number;
    periods_idle: number;
    profit_per_cycle_gbp: Nullable<number>;
    degradation_pct: number;
  };
  certificate: Nullable<{
    cycle_value: number;
    passes: number;
    stopped_early: boolean;
    stop_reason: Nullable<"time_limit">;
    dual_bound_gbp: Nullable<number>;
    dual_gap: Nullable<number>;
    plan_gap: Nullable<number>;
  }>;
  markets: {
    share_market_2_dearer: number;
    mean_spread_gbp_per_mwh: number;
    bought_market_1_mwh: number;
    bought_market_2_mwh: number;
    delivered_market_1_mwh: number;
    delivered_market_2_mwh: number;
    share_days_worth_trading: Nullable<number>;
    selling_periods_per_day: number;
    buying_periods_per_day: number;
  };
  profit_split: {
    time_arbitrage_gbp: number;
    market_2_gap_gbp: number;
    profit_gbp: number;
    market_2_share: Nullable<number>;
  };
  cycles: {
    used: number;
    budget: number;
    prorated_budget: number;
    prorated_crossed_at: Nullable<string>;
    volume_lost_mwh: number;
    realised_margin_gbp_per_mwh: Nullable<number>;
    cycles_per_day: Nullable<number>;
    forgone_per_year_gbp: Nullable<number>;
  };
  yardstick: {
    total_gbp: number;
    ratio: Nullable<number>;
    days_below: number;
    days: number;
    volume_mwh: number;
  };
  costs: {
    years: number;
    capex_gbp: number;
    fixed_opex_gbp: number;
    total_gbp: number;
    shortfall_gbp: number;
  };
  checks: {
    both_charging_and_delivering: number;
    market_2_not_flat_hours: number;
    over_rate_limit: number;
    over_degraded_volume: number;
    over_cycle_budget: number;
  };
  spread_explanation: SpreadReading[];
  series: {
    daily: {
      date: string[];
      profit_gbp: Column;
      cycles: Column;
      cycles_cumulative: Column;
      usable_volume_mwh: Column;
      mean_price: Column;
      buy_floor: Column;
      sell_ceiling: Column;
      day_range: Column;
      harvestable_spread: Column;
      delivered_mwh: Column;
      yardstick_gbp: Column;
    };
    monthly: {
      month: string[];
      price_1_mean: Column;
      price_1_p10: Column;
      price_1_p90: Column;
      price_2_mean: Column;
      price_2_p10: Column;
      price_2_p90: Column;
      profit_gbp: Column;
    };
    quarterly: { quarter: string[]; mean_price: Column; harvestable_spread: Column };
    yearly: {
      year: number[];
      profit_gbp: Column;
      mean_price_1: Column;
      mean_price_2: Column;
      cycles: Column;
      mean_day_range: Column;
      mean_harvestable: Column;
      profit_per_cycle: Column;
      yardstick_median_ratio: Column;
      share_days_beating_yardstick: Column;
    };
    profile: {
      hour: number[];
      price_1: Column;
      price_2: Column;
      charge_1_mw: Column;
      charge_2_mw: Column;
      discharge_1_mw: Column;
      discharge_2_mw: Column;
      share_charging: Column;
      share_delivering: Column;
      share_idle: Column;
    };
    spread_histogram: { clip: number; edges: number[]; counts: number[] };
    net_power: { days: string[]; hours: number[]; values: Column[] };
    week: {
      timestamp: string[];
      price_1: Column;
      price_2: Column;
      charge_1_mw: Column;
      charge_2_mw: Column;
      discharge_1_mw: Column;
      discharge_2_mw: Column;
      storage_mwh: Column;
    };
  };
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

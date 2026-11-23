// The investment layer over a result's cases: one evaluation per submarket and
// business case, ranked by the merchant NPV (model.md §6), recomputed in the
// browser whenever a financial input changes.
import type { Result, ResultCase, Submarket } from "../contracts/types";
import { messages } from "../i18n";
import { num } from "../lib/format";
import { measuredCapture, type RevenueBasis } from "./defaults";
import {
  baseReimbursement,
  baseRevenue,
  evaluateContracted,
  evaluateMerchant,
  maxViableCapex,
  minViableBid,
  type Evaluation,
  type FinanceInputs,
  type Physical,
} from "./model";

export interface SubmarketView {
  submarket: Submarket;
  rank: number;
  captureFactor: number;
  /** R_base, at the May 2026 base, on the chosen revenue basis. */
  merchantRevenue: number;
  merchant: Evaluation;
  merchantMaxCapex: number | null;
  /** Merchant NPV short of the best submarket. */
  regret: number;
  /** Null when the battery cannot meet the contract. */
  contracted: Evaluation | null;
  contractedMaxCapex: number | null;
  minBid: number | null;
  reimbursement: number | null;
  physicalMerchant: Physical;
  physicalContracted: Physical | null;
}

export interface PortfolioOptions {
  captureOverride: number | null;
  basis: RevenueBasis;
}

function physicalOf(result: Result, resultCase: ResultCase): Physical {
  return {
    powerMw: result.battery.power_mw,
    volumeMwh: result.battery.volume_mwh,
    dischargeEfficiency: result.battery.discharge_efficiency,
    degradationPerCycle: result.battery.degradation_pct_per_cycle / 100,
    cyclesPerYear: resultCase.cycles_per_year,
  };
}

/**
 * R_base on the chosen basis. The result carries the last twelve months as one
 * nominal figure, so that basis takes the balanced year's restatement ratio.
 */
export function merchantBase(resultCase: ResultCase, inflation: number, basis: RevenueBasis): number {
  const balanced = baseRevenue(resultCase.monthly, inflation);
  if (basis === "balanced") return balanced;
  const nominal = resultCase.balanced_year_brl;
  return nominal > 0 ? resultCase.last_twelve_months_brl * (balanced / nominal) : resultCase.last_twelve_months_brl;
}

export function evaluatePortfolio(result: Result, inputs: FinanceInputs, options: PortfolioOptions): SubmarketView[] {
  const submarkets = [...new Set(result.cases.map((c) => c.submarket))];
  const views = submarkets.map((submarket) => {
    const merchantCase = result.cases.find((c) => c.submarket === submarket && c.case === "merchant")!;
    const contractedCase = result.cases.find((c) => c.submarket === submarket && c.case === "contracted");
    const captureFactor = options.captureOverride ?? measuredCapture(submarket, result.battery.duration_hours);
    const withCapture = { ...inputs, captureFactor };

    const physicalMerchant = physicalOf(result, merchantCase);
    const merchantRevenue = merchantBase(merchantCase, inputs.ipca, options.basis);
    const merchantAt = (next: FinanceInputs) => evaluateMerchant(next, physicalMerchant, merchantRevenue);

    let contracted: Evaluation | null = null;
    let contractedMaxCapex: number | null = null;
    let minBid: number | null = null;
    let reimbursement: number | null = null;
    let physicalContracted: Physical | null = null;
    if (contractedCase && result.eligibility.contract_eligible) {
      physicalContracted = physicalOf(result, contractedCase);
      const physical = physicalContracted;
      const owed = baseReimbursement(contractedCase.monthly, inputs.ipca);
      reimbursement = owed;
      contracted = evaluateContracted(withCapture, physical, owed);
      contractedMaxCapex = maxViableCapex(withCapture, (next) => evaluateContracted(next, physical, owed));
      minBid = minViableBid(withCapture, physical, owed);
    }

    return {
      submarket,
      rank: 0,
      captureFactor,
      merchantRevenue,
      merchant: merchantAt(withCapture),
      merchantMaxCapex: maxViableCapex(withCapture, merchantAt),
      regret: 0,
      contracted,
      contractedMaxCapex,
      minBid,
      reimbursement,
      physicalMerchant,
      physicalContracted,
    };
  });

  views.sort((a, b) => b.merchant.npv - a.merchant.npv);
  const best = views[0]?.merchant.npv ?? 0;
  return views.map((view, i) => ({ ...view, rank: i + 1, regret: best - view.merchant.npv }));
}

export interface SensitivityRow {
  label: string;
  low: string;
  high: string;
  npvLow: number;
  npvHigh: number;
}

/** NPV of one case under one-at-a-time moves of the inputs, around the current values. */
export function sensitivity(base: FinanceInputs, evaluate: (next: FinanceInputs) => Evaluation, business: "contracted" | "merchant"): SensitivityRow[] {
  const fields = messages().finance.fields;
  const pp = (value: number) => `${num(value * 100, 1)}%`;
  const row = (label: string, key: keyof FinanceInputs, low: number, high: number, show: (v: number) => string): SensitivityRow => ({
    label,
    low: show(low),
    high: show(high),
    npvLow: evaluate({ ...base, [key]: low }).npv,
    npvHigh: evaluate({ ...base, [key]: high }).npv,
  });
  const money = (value: number) => `BRL ${num(value / 1e6, 1)}m`;
  const rows = [
    row(fields.ipca.label, "ipca", base.ipca - 0.02, base.ipca + 0.02, pp),
    row(fields.discountRate.label, "discountRate", Math.max(0, base.discountRate - 0.02), base.discountRate + 0.02, pp),
    row(fields.realPldGrowth.label, "realPldGrowth", base.realPldGrowth - 0.02, base.realPldGrowth + 0.02, pp),
    row(fields.capexPerMw.label, "capex", base.capex * 0.8, base.capex * 1.2, money),
    row(fields.opexPerMw.label, "opex", base.opex * 0.8, base.opex * 1.2, money),
  ];
  if (business === "merchant") {
    rows.push(row(fields.captureFactor.label, "captureFactor", base.captureFactor * 0.9, Math.min(1, base.captureFactor * 1.1), (v) => num(v, 3)));
  } else {
    rows.push(row(fields.bid.label, "fixedRevenue", base.fixedRevenue * 0.9, base.fixedRevenue * 1.1, (v) => `BRL ${num(Math.round(v))}`));
  }
  return rows;
}

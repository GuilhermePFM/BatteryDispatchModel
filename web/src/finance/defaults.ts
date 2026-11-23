// The financial inputs of the page, as the text the user typed, and their
// provenance. model.md §8.1: anything without a contract or measured source is
// an editable assumption and is labelled so.
import type { Submarket } from "../contracts/types";
import { capexIndexYears, type FinanceInputs } from "./model";

export type Product = "A" | "B";
export type RevenueBasis = "balanced" | "last12";
export type Provenance = "contract" | "client" | "measured" | "assumption";

/** Opening prices, BRL/MW-year at May 2026 (Editais 5/2026 and 6/2026, item 10.5.1). */
export const OPENING_PRICE: Record<Product, number> = { A: 1_760_000, B: 1_580_000 };

export const PRODUCT_LABEL: Record<Product, string> = {
  A: "Product A (Leilão 5/2026, national content)",
  B: "Product B (Leilão 6/2026)",
};

/** Edital item 11.8.2.6.2: the base of the consortium net-worth test, offered as a starting point only. */
export const CAPEX_REFERENCE_PER_MW = 6_000_000;

/** The month the bundled scenario was run, the price date of its capex. */
export const BUNDLED_RUN_MONTH = "2026-11";

/** The 24+0 backtest of docs/solve.md, by delivered hours. */
const CAPTURE_HOURS = [2, 4, 6, 8];
const MEASURED_CAPTURE: Record<Submarket, number[]> = {
  SE: [0.981, 0.98, 0.978, 0.966],
  S: [0.975, 0.972, 0.969, 0.956],
  NE: [0.967, 0.965, 0.961, 0.95],
  N: [0.968, 0.965, 0.961, 0.949],
};

/** The measured factor, interpolated between durations and held flat outside them. */
export function measuredCapture(submarket: Submarket, hours: number): number {
  const values = MEASURED_CAPTURE[submarket];
  if (hours <= CAPTURE_HOURS[0]) return values[0];
  for (let i = 1; i < CAPTURE_HOURS.length; i++) {
    if (hours <= CAPTURE_HOURS[i]) {
      const t = (hours - CAPTURE_HOURS[i - 1]) / (CAPTURE_HOURS[i] - CAPTURE_HOURS[i - 1]);
      return values[i - 1] + t * (values[i] - values[i - 1]);
    }
  }
  return values[values.length - 1];
}

export interface FinanceField {
  key: FinanceKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  integer?: boolean;
  optional?: boolean;
  provenance: Provenance;
  help: string;
}

export type FinanceKey =
  | "bid"
  | "capexPerMw"
  | "opexPerMw"
  | "ipca"
  | "discountRate"
  | "realPldGrowth"
  | "captureFactor"
  | "revenueTax"
  | "incomeTax"
  | "depreciationYears"
  | "calendarFade"
  | "replacementShare"
  | "penaltyAllowance"
  | "merchantReplaceEvery";

export type FinanceForm = Record<FinanceKey, string>;

export const MACRO_FIELDS: FinanceField[] = [
  { key: "ipca", label: "IPCA", unit: "% / year", min: -2, max: 30, provenance: "assumption", help: "Indexes the fixed revenue, opex, replacement and the PLD." },
  { key: "discountRate", label: "Nominal discount rate", unit: "% / year", min: 0, max: 60, provenance: "client", help: "Your hurdle rate or WACC." },
  { key: "realPldGrowth", label: "Real PLD growth", unit: "% / year", min: -20, max: 20, provenance: "assumption", help: "Above IPCA. Applies to merchant revenue and to the reimbursement." },
];

export const INVESTMENT_FIELDS: FinanceField[] = [
  { key: "bid", label: "Fixed revenue bid", unit: "BRL / MW-year", min: 0, max: 10_000_000, provenance: "contract", help: "At the May 2026 base. Starts at the product's opening price (item 10.5.1)." },
  { key: "capexPerMw", label: "Capex", unit: "BRL / MW", min: 0, max: 100_000_000, provenance: "assumption", help: "In BRL of the month the model was run, indexed by IPCA to the payment in August 2028. Starts at the BRL 6.0 million per MW of Edital item 11.8.2.6.2, which is a net-worth test base and not a cost reference." },
  { key: "opexPerMw", label: "Fixed opex", unit: "BRL / MW-year", min: 0, max: 20_000_000, provenance: "assumption", help: "At the May 2026 base." },
  { key: "replacementShare", label: "Replacement cost", unit: "% of capex", min: 0, max: 300, provenance: "assumption", help: "The whole volume, as a share of the capex paid in August 2028, indexed by IPCA from then. The contracted case pays only for the share it adds." },
  { key: "calendarFade", label: "Calendar fade", unit: "% / year", min: 0, max: 30, provenance: "assumption", help: "Capacity lost with time, on top of cycling." },
  { key: "merchantReplaceEvery", label: "Merchant replacement interval", unit: "years", min: 1, max: 15, integer: true, optional: true, provenance: "assumption", help: "Empty: never replaced. The contracted case adds modules when it must." },
  { key: "captureFactor", label: "Capture factor", unit: "fraction", min: 0, max: 1, optional: true, provenance: "measured", help: "Empty: the 24+0 backtest for each submarket and duration, itself an upper bound." },
];

export const TAX_FIELDS: FinanceField[] = [
  { key: "revenueTax", label: "Tax on revenue", unit: "%", min: 0, max: 99, provenance: "assumption", help: "Applied to gross revenue." },
  { key: "incomeTax", label: "Tax on income", unit: "%", min: 0, max: 99, provenance: "assumption", help: "With losses carried forward, with no statutory limit." },
  { key: "depreciationYears", label: "Tax depreciation", unit: "years", min: 1, max: 40, integer: true, provenance: "assumption", help: "Straight line on amounts paid, not indexed." },
  { key: "penaltyAllowance", label: "Penalty allowance", unit: "BRL / year", min: 0, max: 1_000_000_000, provenance: "assumption", help: "Contracted case only." },
];

export const FINANCE_FIELDS = [...MACRO_FIELDS, ...INVESTMENT_FIELDS, ...TAX_FIELDS];

/** Every default except the bid and the capex reference is an assumption with no market source. */
export function defaultForm(product: Product = "A"): FinanceForm {
  return {
    bid: String(OPENING_PRICE[product]),
    capexPerMw: String(CAPEX_REFERENCE_PER_MW),
    opexPerMw: "120000",
    ipca: "4.5",
    discountRate: "12",
    realPldGrowth: "0",
    captureFactor: "",
    revenueTax: "9.25",
    incomeTax: "34",
    depreciationYears: "10",
    calendarFade: "1",
    replacementShare: "50",
    penaltyAllowance: "0",
    merchantReplaceEvery: "",
  };
}

export type FinanceErrors = Partial<Record<FinanceKey, string>>;

export function validateForm(form: FinanceForm): FinanceErrors {
  const errors: FinanceErrors = {};
  for (const field of FINANCE_FIELDS) {
    const text = form[field.key].trim();
    if (text === "") {
      if (!field.optional) errors[field.key] = "Required.";
      continue;
    }
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) {
      errors[field.key] = "Enter a number.";
      continue;
    }
    const value = Number(text);
    if (field.integer && !Number.isInteger(value)) errors[field.key] = "Enter a whole number.";
    else if (value < field.min) errors[field.key] = `At least ${field.min.toLocaleString("en-US")}.`;
    else if (value > field.max) errors[field.key] = `At most ${field.max.toLocaleString("en-US")}.`;
  }
  return errors;
}

/** The contract years a replacement every `interval` years falls in. */
export function replacementYears(interval: number | null): number[] {
  if (!interval) return [];
  const years: number[] = [];
  for (let year = interval + 1; year <= 15; year += interval) years.push(year);
  return years;
}

/** The engine's inputs for a valid form. The capture factor is set per submarket. */
export function toInputs(form: FinanceForm, powerMw: number, runMonth: string = BUNDLED_RUN_MONTH): { inputs: FinanceInputs; captureOverride: number | null } {
  const n = (key: FinanceKey) => Number(form[key].trim());
  const percent = (key: FinanceKey) => n(key) / 100;
  const every = form.merchantReplaceEvery.trim();
  const capture = form.captureFactor.trim();
  return {
    captureOverride: capture === "" ? null : Number(capture),
    inputs: {
      fixedRevenue: n("bid"),
      ipca: percent("ipca"),
      discountRate: percent("discountRate"),
      realPldGrowth: percent("realPldGrowth"),
      captureFactor: 1,
      capex: n("capexPerMw") * powerMw,
      capexIndexYears: capexIndexYears(runMonth),
      opex: n("opexPerMw") * powerMw,
      revenueTax: percent("revenueTax"),
      incomeTax: percent("incomeTax"),
      depreciationYears: n("depreciationYears"),
      calendarFade: percent("calendarFade"),
      replacementShare: percent("replacementShare"),
      penaltyAllowance: n("penaltyAllowance"),
      merchantReplacementYears: replacementYears(every === "" ? null : Number(every)),
    },
  };
}

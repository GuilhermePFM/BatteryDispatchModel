// The financial inputs of the page, as the text the user typed, and their
// provenance. model.md §8.1: anything without a contract or measured source is
// an editable assumption and is labelled so.
import type { Submarket } from "../contracts/types";
import { intlLocale, messages } from "../i18n";
import { isDecimal, looksGrouped, toNumber } from "../lib/decimal";
import { capexIndexYears, type FinanceInputs } from "./model";

export type Product = "A" | "B";
export type RevenueBasis = "balanced" | "last12";
export type Provenance = "contract" | "client" | "measured" | "assumption";

/** Opening prices, BRL/MW-year at May 2026 (Editais 5/2026 and 6/2026, item 10.5.1). */
export const OPENING_PRICE: Record<Product, number> = { A: 1_760_000, B: 1_580_000 };

/** Edital item 11.8.2.6.2: the base of the consortium net-worth test, offered as a starting point only. */
export const CAPEX_REFERENCE_PER_MW = 6_000_000;

/** The month the bundled scenario was run, the price date of its capex. */
export const BUNDLED_RUN_MONTH = "2026-11";

/** The 24+0 backtest of docs/solve.md, by delivered hours. */
const CAPTURE_HOURS = [2, 4, 6, 8];
const MEASURED_CAPTURE: Record<Submarket, number[]> = {
  SE: [0.983, 0.981, 0.977, 0.959],
  S: [0.977, 0.974, 0.967, 0.947],
  NE: [0.967, 0.965, 0.959, 0.941],
  N: [0.968, 0.966, 0.96, 0.941],
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

type FinanceBounds = Omit<FinanceField, "label" | "unit" | "help">;

/** A field whose texts are read from the active language each time they are shown. */
function localized(spec: FinanceBounds): FinanceField {
  const text = () => messages().finance.fields[spec.key];
  return Object.defineProperties(spec, {
    label: { get: () => text().label, enumerable: true },
    unit: { get: () => text().unit, enumerable: true },
    help: { get: () => text().help, enumerable: true },
  }) as FinanceField;
}

const MACRO_BOUNDS: FinanceBounds[] = [
  { key: "ipca", min: -2, max: 30, provenance: "assumption" },
  { key: "discountRate", min: 0, max: 60, provenance: "client" },
  { key: "realPldGrowth", min: -20, max: 20, provenance: "assumption" },
];

export const MACRO_FIELDS = MACRO_BOUNDS.map((spec) => localized(spec));

const INVESTMENT_BOUNDS: FinanceBounds[] = [
  { key: "bid", min: 0, max: 10_000_000, provenance: "contract" },
  { key: "capexPerMw", min: 0, max: 100_000_000, provenance: "assumption" },
  { key: "opexPerMw", min: 0, max: 20_000_000, provenance: "assumption" },
  { key: "replacementShare", min: 0, max: 300, provenance: "assumption" },
  { key: "calendarFade", min: 0, max: 30, provenance: "assumption" },
  { key: "merchantReplaceEvery", min: 1, max: 15, integer: true, optional: true, provenance: "assumption" },
  { key: "captureFactor", min: 0, max: 1, optional: true, provenance: "measured" },
];

export const INVESTMENT_FIELDS = INVESTMENT_BOUNDS.map((spec) => localized(spec));

const TAX_BOUNDS: FinanceBounds[] = [
  { key: "revenueTax", min: 0, max: 99, provenance: "assumption" },
  { key: "incomeTax", min: 0, max: 99, provenance: "assumption" },
  { key: "depreciationYears", min: 1, max: 40, integer: true, provenance: "assumption" },
  { key: "penaltyAllowance", min: 0, max: 1_000_000_000, provenance: "assumption" },
];

export const TAX_FIELDS = TAX_BOUNDS.map((spec) => localized(spec));

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
  const t = messages().validation;
  const errors: FinanceErrors = {};
  for (const field of FINANCE_FIELDS) {
    const text = form[field.key].trim();
    if (text === "") {
      if (!field.optional) errors[field.key] = t.required;
      continue;
    }
    if (!isDecimal(text)) {
      errors[field.key] = t.enterNumber;
      continue;
    }
    if (looksGrouped(text)) {
      errors[field.key] = t.groupedNumber;
      continue;
    }
    const value = toNumber(text);
    if (field.integer && !Number.isInteger(value)) errors[field.key] = t.wholeNumber;
    else if (value < field.min) errors[field.key] = t.atLeast(field.min.toLocaleString(intlLocale()));
    else if (value > field.max) errors[field.key] = t.atMost(field.max.toLocaleString(intlLocale()));
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
  const n = (key: FinanceKey) => toNumber(form[key]);
  const percent = (key: FinanceKey) => n(key) / 100;
  const every = form.merchantReplaceEvery.trim();
  const capture = form.captureFactor.trim();
  return {
    captureOverride: capture === "" ? null : toNumber(capture),
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
      merchantReplacementYears: replacementYears(every === "" ? null : toNumber(every)),
    },
  };
}

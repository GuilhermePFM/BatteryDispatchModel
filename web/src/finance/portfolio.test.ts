import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import resultExample from "../../../contracts/examples/v2/result.example.json";
import { isCurrentRecord, type Result } from "../contracts/types";
import { defaultForm, measuredCapture, OPENING_PRICE, replacementYears, toInputs, validateForm } from "./defaults";
import { baseRevenue, evaluateMerchant } from "./model";
import { evaluatePortfolio, merchantBase, sensitivity } from "./portfolio";

const example = resultExample as unknown as Result;
const scenario = JSON.parse(readFileSync(new URL("../../public/scenarios/pld-2025-2026.json", import.meta.url), "utf8")) as Result;
const { inputs } = toInputs(defaultForm(), example.battery.power_mw);
const options = { captureOverride: null, basis: "balanced" as const };

describe("the default inputs", () => {
  it("are valid and use the official opening prices", () => {
    expect(validateForm(defaultForm())).toEqual({});
    expect(OPENING_PRICE).toEqual({ A: 1_760_000, B: 1_580_000 });
    expect(defaultForm("B").bid).toBe("1580000");
    expect(defaultForm().realPldGrowth).toBe("0");
  });

  it("rejects a negative discount rate, where NPV is no longer monotonic in capex", () => {
    expect(validateForm({ ...defaultForm(), discountRate: "-1" }).discountRate).toMatch(/At least 0/);
  });

  it("schedules merchant replacements at a fixed interval", () => {
    expect(replacementYears(null)).toEqual([]);
    expect(replacementYears(7)).toEqual([8, 15]);
  });

  it("interpolates the measured capture factor and holds it outside the table", () => {
    expect(measuredCapture("SE", 4)).toBe(0.98);
    expect(measuredCapture("SE", 5)).toBeCloseTo(0.979, 6);
    expect(measuredCapture("N", 1)).toBe(0.968);
    expect(measuredCapture("N", 24)).toBe(0.949);
  });
});

describe("evaluatePortfolio", () => {
  const views = evaluatePortfolio(example, inputs, options);

  it("ranks every submarket by merchant NPV", () => {
    expect(views).toHaveLength(4);
    expect(views.map((v) => v.rank)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < views.length; i++) expect(views[i - 1].merchant.npv).toBeGreaterThanOrEqual(views[i].merchant.npv);
    expect(views[0].regret).toBe(0);
  });

  it("restates the nominal balanced year to the May 2026 base", () => {
    for (const row of example.cases.filter((c) => c.case === "merchant")) {
      // Every month of this example is before May 2026, so the restatement raises it.
      expect(baseRevenue(row.monthly, inputs.ipca)).toBeGreaterThan(row.balanced_year_brl);
      expect(baseRevenue(row.monthly, inputs.ipca)).toBeLessThan(row.balanced_year_brl * 1.1);
    }
  });

  it("drops the contracted case when the battery cannot meet the contract", () => {
    const merchantOnly = structuredClone(example);
    merchantOnly.eligibility.contract_eligible = false;
    merchantOnly.cases = merchantOnly.cases.filter((c) => c.case === "merchant");
    const rows = evaluatePortfolio(merchantOnly, inputs, options);
    expect(rows.every((v) => v.contracted === null && v.minBid === null)).toBe(true);
    expect(rows.every((v) => Number.isFinite(v.merchant.npv))).toBe(true);
  });

  it("applies a typed capture factor to every submarket", () => {
    const rows = evaluatePortfolio(example, inputs, { ...options, captureOverride: 0.5 });
    expect(rows.every((v) => v.captureFactor === 0.5)).toBe(true);
  });

  it("uses the last twelve months as the alternative basis", () => {
    const row = example.cases.find((c) => c.case === "merchant")!;
    const skewed = { ...row, last_twelve_months_brl: row.balanced_year_brl * 1.2 };
    expect(merchantBase(skewed, 0.045, "last12")).toBeCloseTo(merchantBase(skewed, 0.045, "balanced") * 1.2, 4);
  });

  it("recomputes from the scenario for all eight cases", () => {
    const rows = evaluatePortfolio(scenario, toInputs(defaultForm(), scenario.battery.power_mw).inputs, options);
    expect(rows.every((v) => v.contracted !== null)).toBe(true);
  });
});

describe("the macro sensitivities", () => {
  const view = evaluatePortfolio(example, inputs, options)[0];
  const at = (next: typeof inputs) => evaluateMerchant(next, view.physicalMerchant, view.merchantRevenue);
  const rows = sensitivity({ ...inputs, captureFactor: view.captureFactor }, at, "merchant");

  it("cover IPCA, the discount rate and real PLD growth", () => {
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(["IPCA", "Nominal discount rate", "Real PLD growth", "Capex"]));
  });

  it("move the NPV the expected way", () => {
    const row = (label: string) => rows.find((r) => r.label === label)!;
    expect(row("Nominal discount rate").npvHigh).toBeLessThan(row("Nominal discount rate").npvLow);
    expect(row("Real PLD growth").npvHigh).toBeGreaterThan(row("Real PLD growth").npvLow);
    expect(row("Capex").npvHigh).toBeLessThan(row("Capex").npvLow);
  });
});

describe("records of an earlier model", () => {
  it("are told apart from current ones", () => {
    expect(isCurrentRecord({ version: 2, result: example })).toBe(true);
    expect(isCurrentRecord({ version: 2 })).toBe(true);
    expect(isCurrentRecord({ version: 1 })).toBe(false);
    expect(isCurrentRecord({ version: 2, result: { version: 2, model_version: "older" } })).toBe(false);
  });
});

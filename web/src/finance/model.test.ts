import { describe, expect, it } from "vitest";
import golden from "./golden-vectors.json";
import {
  baseReimbursement,
  baseRevenue,
  capexIndexYears,
  evaluateContracted,
  evaluateMerchant,
  indexYears,
  irr,
  maxViableCapex,
  minViableBid,
  npv,
  paidCapex,
  payback,
  positiveRoots,
  realDiscountRate,
  restatement,
  type Evaluation,
  type FinanceInputs,
  type MonthlyBlock,
  type Physical,
} from "./model";

interface GoldenCase {
  name: string;
  case: "contracted" | "merchant";
  inputs: FinanceInputs;
  physical: Physical;
  reimbursement?: number;
  revenue?: number;
  expected: {
    cashFlows: number[];
    capacity: number[];
    replacements: number[];
    npv: number;
    irr: number | null;
    payback: number | null;
    discountedPayback: number | null;
    realDiscountRate: number;
    maxViableCapex: number | null;
    minViableBid?: number | null;
  };
}

const cases = golden.cases as unknown as GoldenCase[];
const monthly = golden.monthly as unknown as { name: string; ipca: number; monthly: MonthlyBlock; baseRevenue: number; baseReimbursement: number }[];

function close(actual: number | null | undefined, wanted: number | null | undefined, relative = 1e-7) {
  if (wanted === null || wanted === undefined) {
    expect(actual ?? null).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - wanted)).toBeLessThanOrEqual(relative * Math.max(1, Math.abs(wanted)));
}

function evaluator(c: GoldenCase) {
  return (inputs: FinanceInputs): Evaluation =>
    c.case === "contracted" ? evaluateContracted(inputs, c.physical, c.reimbursement!) : evaluateMerchant(inputs, c.physical, c.revenue!);
}

describe("golden vectors from the independent reference", () => {
  it("cover the macro inputs and both cases", () => {
    expect(cases.some((c) => c.inputs.ipca !== 0.045)).toBe(true);
    expect(cases.some((c) => c.inputs.discountRate !== 0.12)).toBe(true);
    expect(cases.some((c) => c.inputs.realPldGrowth > 0)).toBe(true);
    expect(cases.some((c) => c.inputs.realPldGrowth < 0)).toBe(true);
    expect(new Set(cases.map((c) => c.case)).size).toBe(2);
    expect(cases.some((c) => c.expected.irr === null)).toBe(true);
  });

  for (const c of cases) {
    it(c.name, () => {
      const result = evaluator(c)(c.inputs);
      expect(result.replacements).toEqual(c.expected.replacements);
      result.flows.forEach((flow, i) => {
        close(flow.cashFlow, c.expected.cashFlows[i]);
        close(flow.capacity, c.expected.capacity[i]);
      });
      close(result.npv, c.expected.npv);
      close(result.irr, c.expected.irr, 1e-6);
      expect(result.payback).toBe(c.expected.payback);
      expect(result.discountedPayback).toBe(c.expected.discountedPayback);
      close(realDiscountRate(c.inputs.discountRate, c.inputs.ipca), c.expected.realDiscountRate);
      close(maxViableCapex(c.inputs, evaluator(c)), c.expected.maxViableCapex, 1e-6);
      if (c.case === "contracted") close(minViableBid(c.inputs, c.physical, c.reimbursement!), c.expected.minViableBid, 1e-6);
    });
  }

  for (const v of monthly) {
    it(`base revenue and reimbursement: ${v.name}`, () => {
      close(baseRevenue(v.monthly, v.ipca), v.baseRevenue);
      close(baseReimbursement(v.monthly, v.ipca), v.baseReimbursement);
    });
  }
});

describe("the macro inputs", () => {
  const base = cases.find((c) => c.name === "merchant, base inputs")!;
  const contracted = cases.find((c) => c.name === "contracted, base inputs")!;

  it("real PLD growth moves merchant revenue and not the fixed revenue", () => {
    const grown = { ...base.inputs, realPldGrowth: 0.02 };
    expect(evaluator(base)(grown).npv).toBeGreaterThan(evaluator(base)(base.inputs).npv);
    const noReimbursement = { ...contracted, reimbursement: 0 };
    close(evaluator(noReimbursement)({ ...contracted.inputs, realPldGrowth: 0.05 }).npv, evaluator(noReimbursement)(contracted.inputs).npv);
  });

  it("indexes every quantity from one base date", () => {
    expect(indexYears(1)).toBeCloseTo(26 / 12);
    expect(indexYears(15)).toBeCloseTo(26 / 12 + 14);
    const inputs = { ...contracted.inputs, ipca: 0.05, capex: 0, opex: 0, revenueTax: 0, incomeTax: 0 };
    const flows = evaluateContracted(inputs, { ...contracted.physical, volumeMwh: 1000 }, 0).flows;
    close(flows[0].revenue, inputs.fixedRevenue * contracted.physical.powerMw * 1.05 ** (26 / 12));
  });

  it("does not index depreciation after the payment", () => {
    const low = evaluator(contracted)({ ...contracted.inputs, capexIndexYears: 0, ipca: 0 });
    const high = evaluator(contracted)({ ...contracted.inputs, capexIndexYears: 0, ipca: 0.1 });
    expect(high.flows[0].depreciation).toBe(low.flows[0].depreciation);
    const indexed = evaluator(contracted)(contracted.inputs);
    close(indexed.flows[0].depreciation, indexed.capexPaid / contracted.inputs.depreciationYears);
  });

  it("restates to one at the May 2026 base", () => {
    expect(restatement("2026-05", 0.05)).toBe(1);
    expect(restatement("2025-05", 0.05)).toBeGreaterThan(1);
    // Past the published series, the assumed rate carries the index on.
    expect(restatement("2030-01", 0.1)).toBeLessThan(restatement("2030-01", 0.02));
  });
});

describe("buying back capacity", () => {
  const contracted = cases.find((c) => c.name === "contracted, base inputs")!;
  const inputs = { ...contracted.inputs, ipca: 0.05 };
  const exact = { ...contracted.physical, volumeMwh: (4 * contracted.physical.powerMw) / contracted.physical.dischargeEfficiency };
  const yearly = (1 - inputs.calendarFade) * (1 - exact.degradationPerCycle * exact.cyclesPerYear);

  it("adds only the volume lost when there is no margin", () => {
    const result = evaluateContracted(inputs, exact, 0);
    expect(result.replacements).toEqual(Array.from({ length: 14 }, (_, i) => i + 2));
    result.replacementShares.forEach((share) => close(share, 1 - yearly));
    result.flows.forEach((flow) => close(flow.capacity, 1));
    close(result.flows[1].replacement, inputs.replacementShare * (1 - yearly) * paidCapex(inputs) * 1.05);
  });

  it("buys nothing while the margin lasts", () => {
    const roomy = evaluateContracted(inputs, { ...exact, volumeMwh: exact.volumeMwh * 1.1 }, 0);
    const first = Math.ceil(Math.log(1 / 1.1) / Math.log(yearly)) + 1;
    expect(roomy.replacements[0]).toBe(first);
    close(roomy.flows[first - 1].capacity, 1 / 1.1);
  });

  it("indexes a replacement from the date K is paid", () => {
    const merchant = cases.find((c) => c.name === "merchant, replacement in year 8")!;
    const at = { ...merchant.inputs, ipca: 0.05 };
    const flow = evaluateMerchant(at, merchant.physical, merchant.revenue!).flows[7];
    close(flow.replacement, at.replacementShare * paidCapex(at) * 1.05 ** 7);
    expect(flow.capacity).toBe(1);
  });

  it("indexes K from the run month to August 2028", () => {
    expect(capexIndexYears("2026-11")).toBeCloseTo(21 / 12, 12);
    expect(capexIndexYears("2028-08")).toBe(0);
    expect(capexIndexYears("2030-01")).toBe(0);
    close(paidCapex({ ...inputs, capex: 100, ipca: 0.05, capexIndexYears: 2 }), 110.25);
  });
});

describe("the IRR is reported only when it is unique", () => {
  it("finds a single root", () => {
    expect(irr(100, [110])).toBeCloseTo(0.1, 9);
    expect(irr(100, [0, 121])).toBeCloseTo(0.1, 9);
  });

  it("returns null on two roots", () => {
    // -100 + 230v - 132v^2 has roots at 10% and 20%.
    expect(positiveRoots([-100, 230, -132])).toHaveLength(2);
    expect(irr(100, [230, -132])).toBeNull();
  });

  it("returns null when there is no root", () => {
    expect(irr(100, [-5, -5])).toBeNull();
    expect(irr(0, [0, 0])).toBeNull();
  });

  it("treats a double root as one distinct root", () => {
    // (1 - v)^2 = 1 - 2v + v^2.
    expect(positiveRoots([1, -2, 1])).toHaveLength(1);
  });
});

describe("payback and viability", () => {
  it("payback is the first year the flows reach K, or null", () => {
    expect(payback(100, [40, 40, 40])).toBe(3);
    expect(payback(100, [40, 40])).toBeNull();
    expect(payback(100, [60, 60], 0.5)).toBeNull();
  });

  it("NPV is zero at the maximum viable capex", () => {
    const c = cases.find((x) => x.name === "merchant, IPCA 3% and rate 9%")!;
    const capex = maxViableCapex(c.inputs, evaluator(c))!;
    expect(Math.abs(evaluator(c)({ ...c.inputs, capex }).npv)).toBeLessThan(1);
  });

  it("NPV is zero at the minimum viable bid", () => {
    const c = cases.find((x) => x.name === "contracted, base inputs")!;
    const bid = minViableBid(c.inputs, c.physical, c.reimbursement!)!;
    expect(Math.abs(evaluateContracted({ ...c.inputs, fixedRevenue: bid }, c.physical, c.reimbursement!).npv)).toBeLessThan(1);
  });

  it("agrees with the plain NPV", () => {
    expect(npv(0.1, 100, [110])).toBeCloseTo(0);
  });
});

describe("the finance module stays in the browser", () => {
  it("imports nothing that calls the API", async () => {
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [path, source] of Object.entries(sources)) {
      if (path.endsWith(".test.ts")) continue;
      expect(source).not.toMatch(/lib\/api|fetch\(/);
    }
  });
});

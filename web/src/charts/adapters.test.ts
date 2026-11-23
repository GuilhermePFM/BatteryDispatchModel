import { describe, expect, it } from "vitest";
import resultExample from "../../../contracts/examples/v2/result.example.json";
import type { Result } from "../contracts/types";
import {
  bandHeight,
  breakeven,
  cumulative,
  hasData,
  heatCells,
  histogram,
  linearFit,
  negate,
  normaliseToFirst,
  pairs,
  quantile,
  scatter,
} from "./adapters";
import { ALL_BUILDERS, cashFlowChart, dailyPriceBand, netPowerHeatmap, priceProfile } from "./options";
import { DARK, LIGHT } from "./theme";

const example = resultExample as unknown as Result;

describe("adapters keep nulls as gaps", () => {
  it("pairs and cumulative", () => {
    expect(pairs(["a", "b", "c"], [1, null, 3])).toEqual([["a", 1], ["b", null], ["c", 3]]);
    expect(pairs(["a"], undefined)).toEqual([["a", null]]);
    expect(cumulative([1, null, 2, -0.5])).toEqual([1, null, 3, 2.5]);
    expect(hasData([null, null])).toBe(false);
    expect(hasData([null, 0])).toBe(true);
  });

  it("bands, breakeven and negation", () => {
    expect(bandHeight([1, null, 2], [3, 4, null])).toEqual([2, null, null]);
    expect(breakeven([100, null], 0.1)).toEqual([110.00000000000001, null]);
    expect(negate([1, 0, null])).toEqual([-1, 0, null]);
  });

  it("normalises to the first defined, non-zero value", () => {
    expect(normaliseToFirst([null, 0, 2, 4, null])).toEqual([null, 0, 1, 2, null]);
    expect(normaliseToFirst([null, 0])).toEqual([null, null]);
  });

  it("histograms the defined values only", () => {
    expect(histogram([])).toEqual({ edges: [], counts: [] });
    expect(histogram([null, 2, 2])).toEqual({ edges: [1.5, 2.5], counts: [2] });
    const h = histogram([0, 1, 2, 3, null], 2);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(4);
    expect(h.edges[0]).toBe(0);
    expect(h.edges[h.edges.length - 1]).toBe(3);
  });

  it("fits like battery_plan.analysis.fit, skipping undefined days", () => {
    const fit = linearFit([1, 2, null, 3], [2, 4, 100, 6])!;
    expect(fit.slope).toBeCloseTo(2);
    expect(fit.intercept).toBeCloseTo(0);
    expect(fit.r2).toBeCloseTo(1);
    expect(fit.n).toBe(3);
    expect(linearFit([1, 1], [2, 3])).toBeNull();
    expect(linearFit([1, null], [2, 3])).toBeNull();
    expect(linearFit([1, 2], [5, 5])!.r2).toBeNull();
  });

  it("quantiles, scatter and heat cells", () => {
    expect(quantile([null, 1, 3], 0.5)).toBe(2);
    expect(quantile([null], 0.5)).toBeNull();
    expect(scatter([1, null, 3], [2, 2, null], ["a", "b", "c"])).toEqual([[1, 2, "a"]]);
    const heat = heatCells([[0.5, null], [-2]]);
    expect(heat.cells).toEqual([[0, 0, 0.5], [1, 0, -2]]);
    expect(heat.maxAbs).toBe(2);
    expect(heatCells([[null]]).maxAbs).toBe(0.1);
  });
});

const detailBlocks = (r: Result) => [r.detail.daily, r.detail.profile, r.detail.week] as Record<string, unknown>[];

/** The example with every numeric column of the detail nulled. */
function nulled(result: Result): Result {
  const copy = structuredClone(result);
  for (const block of detailBlocks(copy)) {
    for (const [key, value] of Object.entries(block)) {
      if (Array.isArray(value) && value.every((v) => typeof v === "number" || v === null) && key !== "hour") {
        block[key] = value.map(() => null);
      }
    }
  }
  copy.detail.net_power.permille = copy.detail.net_power.permille.map((row) => row.map(() => null as unknown as number));
  return copy;
}

describe("chart options", () => {
  it("build from the contract example in both themes", () => {
    for (const build of ALL_BUILDERS) {
      for (const palette of [LIGHT, DARK]) {
        const option = build(example, palette) as { series: unknown[] };
        expect(Array.isArray(option.series)).toBe(true);
        expect(JSON.stringify(option)).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it("build when every series is null", () => {
    const empty = nulled(example);
    for (const build of ALL_BUILDERS) {
      const option = build(empty, LIGHT);
      expect(JSON.stringify(option)).not.toMatch(/NaN|Infinity/);
    }
  });

  it("build from an empty horizon", () => {
    const none = structuredClone(example);
    for (const block of [...detailBlocks(none), none.detail.net_power as unknown as Record<string, unknown>]) {
      for (const key of Object.keys(block)) {
        if (Array.isArray(block[key])) block[key] = [];
      }
    }
    for (const build of ALL_BUILDERS) expect(() => build(none, LIGHT)).not.toThrow();
  });

  it("leaves the price axis uncapped: the PLD goes far past 200", () => {
    const high = structuredClone(example);
    high.detail.daily.price_max = high.detail.daily.price_max.map(() => 1500);
    const option = dailyPriceBand(high, LIGHT) as { yAxis: { max?: number } };
    expect(option.yAxis.max).toBeUndefined();
  });

  it("labels a day of 24 hours, in BRL", () => {
    const heat = netPowerHeatmap(example, LIGHT) as { yAxis: { data: string[] } };
    expect(heat.yAxis.data).toHaveLength(24);
    expect(heat.yAxis.data[23]).toBe("23:00");
    const profile = priceProfile(example, LIGHT) as { xAxis: { data: string[] }; yAxis: { name: string } };
    expect(profile.xAxis.data).toHaveLength(24);
    expect(profile.yAxis.name).toContain("R$");
  });

  it("converts the heatmap's permille to MW", () => {
    const one = structuredClone(example);
    one.detail.net_power = { date: ["2025-02-01"], permille: [[500, ...new Array<number>(23).fill(0)]] };
    const option = netPowerHeatmap(one, LIGHT) as { series: { data: [number, number, number][] }[] };
    expect(option.series[0].data[0]).toEqual([0, 0, 0.5 * one.battery.power_mw]);
  });

  it("charts the capex as year zero of the cash flows", () => {
    const flows = [{ year: 1, capacity: 1, revenue: 10, opex: 1, depreciation: 1, tax: 1, replacement: 0, cashFlow: 8 }];
    const option = cashFlowChart(flows, 100, LIGHT) as { xAxis: { data: string[] }; series: { data: unknown[] }[] };
    expect(option.xAxis.data).toEqual(["0", "1"]);
    expect(option.series[1].data).toEqual([-100, -92]);
  });
});

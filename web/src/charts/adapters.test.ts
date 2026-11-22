import { describe, expect, it } from "vitest";
import resultExample from "../../../contracts/examples/result.example.json";
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
import { ALL_BUILDERS, profitScatter } from "./options";
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

/** The example with every column nulled and every nullable scalar null. */
function nulled(result: Result): Result {
  const copy = structuredClone(result);
  for (const block of Object.values(copy.series)) {
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      if (Array.isArray(value) && value.every((v) => typeof v === "number" || v === null) && !["hour", "edges", "counts", "year"].includes(key)) {
        (block as Record<string, unknown>)[key] = value.map(() => null);
      }
    }
  }
  copy.series.net_power.values = copy.series.net_power.values.map((row) => row.map(() => null));
  copy.cycles.prorated_crossed_at = null;
  copy.cycles.realised_margin_gbp_per_mwh = null;
  copy.certificate = null;
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
    for (const block of Object.values(none.series)) {
      for (const key of Object.keys(block)) {
        const value = (block as Record<string, unknown>)[key];
        if (Array.isArray(value)) (block as Record<string, unknown>)[key] = [];
      }
    }
    for (const build of ALL_BUILDERS) expect(() => build(none, LIGHT)).not.toThrow();
  });

  it("draws the fit line only where a fit exists", () => {
    const option = profitScatter(example, LIGHT, "harvestable_spread") as { series: { data: unknown[] }[] };
    expect(option.series[1].data).toHaveLength(2);
    const flat = profitScatter(nulled(example), LIGHT, "harvestable_spread") as { series: { data: unknown[] }[] };
    expect(flat.series[0].data).toHaveLength(0);
    expect(flat.series[1].data).toHaveLength(0);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import example from "../../../contracts/examples/run-request.example.json";
import {
  BATTERY_FIELDS,
  buildRequest,
  defaultValues,
  inspectPriceCsv,
  numberError,
  parseDay,
  roundTrip,
  validate,
  valuesFromRequest,
} from "./validation";

const template = readFileSync(
  new URL("../../../contracts/examples/prices-template.csv", import.meta.url),
  "utf8",
);

describe("schema-driven fields", () => {
  it("pre-fills every battery field with the schema default", () => {
    const values = defaultValues();
    expect(BATTERY_FIELDS).toHaveLength(10);
    expect(values.battery.max_charge_rate_mw).toBe("2");
    expect(values.battery.degradation_pct_per_cycle).toBe("0.001");
    expect(values.battery.capex_gbp).toBe("500000");
    expect(values.commit_days).toBe("1");
    expect(values.cycle_budget).toBe("");
  });

  it("reads the bounds from the schema", () => {
    const rate = BATTERY_FIELDS.find((f) => f.key === "max_charge_rate_mw")!;
    expect([rate.min, rate.max]).toEqual([0.1, 100]);
    expect(numberError("0.05", rate)).toMatch(/At least 0.1/);
    expect(numberError("101", rate)).toMatch(/At most 100/);
    expect(numberError("2", rate)).toBeNull();
  });

  it("rejects text that Number() would accept", () => {
    const rate = BATTERY_FIELDS[0];
    expect(numberError("", rate)).toBe("Required.");
    expect(numberError("1e1", rate)).toBe("Enter a number.");
    expect(numberError("abc", rate)).toBe("Enter a number.");
    expect(numberError("", rate, true)).toBeNull();
  });
});

describe("validate", () => {
  it("accepts the defaults", () => {
    expect(validate(defaultValues())).toEqual({});
  });

  it("enforces integer window days in 1..2", () => {
    const values = { ...defaultValues(), commit_days: "1.5", lookahead_days: "3" };
    const errors = validate(values);
    expect(errors.commit_days).toBe("Enter a whole number.");
    expect(errors.lookahead_days).toMatch(/At most 2/);
  });

  it("checks the date order, the 365-day span and the bundled range", () => {
    expect(validate({ ...defaultValues(), start: "2019-03-01", end: "2019-02-01" }).end).toMatch(
      /before the start/,
    );
    // 2020 is a leap year: 2020-01-01 + 365 days is 2020-12-31, the limit.
    expect(validate({ ...defaultValues(), start: "2020-01-01", end: "2020-12-31" })).toEqual({});
    expect(validate({ ...defaultValues(), start: "2019-01-01", end: "2020-01-02" }).end).toMatch(
      /At most 365 days/,
    );
    expect(validate({ ...defaultValues(), start: "2017-12-31", end: "2018-01-05" }).start).toMatch(
      /2018-01-01/,
    );
    expect(validate({ ...defaultValues(), start: "2020-12-01", end: "2021-01-01" }).end).toMatch(
      /2020-12-31/,
    );
    expect(validate({ ...defaultValues(), start: "2019-02-30" }).start).toMatch(/YYYY-MM-DD/);
  });

  it("checks an optional cycle budget only when given", () => {
    expect(validate({ ...defaultValues(), cycle_budget: "0" }).cycle_budget).toMatch(/At least 1/);
    expect(validate({ ...defaultValues(), cycle_budget: "500" })).toEqual({});
  });

  it("holds the dates to an uploaded file's span instead of the bundled one", () => {
    const file = inspectPriceCsv("jan.csv", template.length, template);
    expect(file).toMatchObject({ firstDay: "2018-01-01", lastDay: "2018-01-31" });
    const ok = { ...defaultValues(), start: "2018-01-02", end: "2018-01-30" };
    expect(validate(ok, file)).toEqual({});
    const errors = validate({ ...ok, end: "2018-02-03" }, file);
    expect(errors.end).toBe("The file ends on 2018-01-31.");
  });
});

describe("inspectPriceCsv", () => {
  it("names a wrong header and an empty or oversized file", () => {
    expect(inspectPriceCsv("a.csv", 10, "time,p1,p2\n").problem).toMatch(/Line 1/);
    expect(inspectPriceCsv("a.csv", 0, "").problem).toMatch(/empty/);
    expect(inspectPriceCsv("a.csv", 6 * 1024 * 1024, template).problem).toMatch(/5 MB/);
    expect(inspectPriceCsv("a.csv", 30, "timestamp,market_1,market_2\n").problem).toMatch(/no rows/);
    expect(
      inspectPriceCsv("a.csv", 40, "timestamp,market_1,market_2\nyesterday,1,2\n").problem,
    ).toMatch(/Line 2/);
  });
});

describe("buildRequest", () => {
  it("round-trips the contract example and omits optional fields", () => {
    const values = valuesFromRequest(example);
    const request = buildRequest(values);
    expect(request).toEqual(example);
    expect("cycle_budget" in request).toBe(false);
    expect("prices_key" in request).toBe(false);
  });

  it("adds cycle_budget and prices_key when present", () => {
    const request = buildRequest({ ...defaultValues(), cycle_budget: " 750 " }, "uploads/abc.csv");
    expect(request.cycle_budget).toBe(750);
    expect(request.prices_key).toBe("uploads/abc.csv");
  });
});

describe("helpers", () => {
  it("parses only real calendar dates", () => {
    expect(parseDay("2020-02-29")).not.toBeNull();
    expect(parseDay("2019-02-29")).toBeNull();
    expect(parseDay("2019-2-01")).toBeNull();
  });

  it("derives the round trip from the losses", () => {
    const trip = roundTrip(defaultValues())!;
    expect(trip.efficiency).toBeCloseTo(0.9025, 6);
    expect(trip.markup).toBeCloseTo(0.10803324, 6);
  });
});

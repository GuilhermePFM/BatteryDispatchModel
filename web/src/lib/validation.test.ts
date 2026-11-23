import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import example from "../../../contracts/examples/v2/run-request.example.json";
import {
  BATTERY_FIELDS,
  automaticRates,
  buildRequest,
  contractWarnings,
  CYCLE_BUDGET_FIELD,
  defaultValues,
  inspectPriceCsv,
  numberError,
  parseDay,
  physicalBattery,
  roundTrip,
  validate,
  valuesFromRequest,
} from "./validation";

const template = new Uint8Array(readFileSync(new URL("../../../contracts/examples/pld-template.csv", import.meta.url)));
const encode = (text: string) => new TextEncoder().encode(text);

describe("schema-driven fields", () => {
  it("pre-fills the auction's smallest battery, 4 h by default", () => {
    const values = defaultValues();
    expect(BATTERY_FIELDS).toHaveLength(6);
    expect(values.battery.power_mw).toBe("30");
    expect(values.battery.duration_hours).toBe("4");
    expect(values.battery.round_trip_efficiency).toBe("0.85");
    expect(values.battery.charge_rate_mw).toBe("");
    expect(values.battery.discharge_rate_mw).toBe("");
    expect(values.battery.degradation_pct_per_cycle).toBe("0.001");
    expect(values.cycle_budget).toBe("");
  });

  it("reads the bounds from the schema", () => {
    const power = BATTERY_FIELDS.find((f) => f.key === "power_mw")!;
    expect([power.min, power.max]).toEqual([0.1, 2000]);
    expect(numberError("0.05", power)).toMatch(/At least 0.1/);
    expect(numberError("2001", power)).toMatch(/At most 2,000/);
    expect(numberError("30", power)).toBeNull();
    expect(CYCLE_BUDGET_FIELD.min).toBe(1);
  });

  it("rejects text that Number() would accept", () => {
    const power = BATTERY_FIELDS[0];
    expect(numberError("", power)).toBe("Required.");
    expect(numberError("1e1", power)).toBe("Enter a number.");
    expect(numberError("abc", power)).toBe("Enter a number.");
    expect(numberError("", power, true)).toBeNull();
  });
});

describe("validate", () => {
  it("accepts the defaults", () => {
    expect(validate(defaultValues())).toEqual({});
  });

  it("sends only the physical request: nothing financial", () => {
    const request = buildRequest(defaultValues());
    expect(Object.keys(request).sort()).toEqual(["battery", "end", "start"]);
    expect(Object.keys(request.battery).sort()).toEqual(Object.keys(example.battery).sort());
  });

  it("checks the date order, the span and the bundled range", () => {
    expect(validate({ ...defaultValues(), start: "2025-03-01", end: "2025-02-01" }).end).toMatch(/before the start/);
    expect(validate({ ...defaultValues(), start: "2025-02-01", end: "2026-01-31" })).toEqual({});
    expect(validate({ ...defaultValues(), start: "2025-02-01", end: "2026-01-30" }).end).toMatch(/full year/);
    expect(validate({ ...defaultValues(), start: "2025-01-19", end: "2026-06-01" }).start).toMatch(/2025-01-20/);
    expect(validate({ ...defaultValues(), start: "2025-06-01", end: "2026-11-21" }).end).toMatch(/2026-11-20/);
    expect(validate({ ...defaultValues(), start: "2025-02-30" }).start).toMatch(/YYYY-MM-DD/);
  });

  it("allows at most 730 days after the start", () => {
    const file = { name: "long.csv", size: 10, firstDay: "2023-01-01", lastDay: "2026-12-31" };
    expect(validate({ ...defaultValues(), start: "2023-01-01", end: "2024-12-31" }, file)).toEqual({});
    expect(validate({ ...defaultValues(), start: "2023-01-01", end: "2025-01-01" }, file).end).toMatch(/At most 730 days/);
  });

  it("checks an optional cycle budget only when given", () => {
    expect(validate({ ...defaultValues(), cycle_budget: "0" }).cycle_budget).toMatch(/At least 1/);
    expect(validate({ ...defaultValues(), cycle_budget: "500" })).toEqual({});
  });

  it("holds the dates to an uploaded file's span instead of the bundled one", () => {
    const file = { name: "pld.csv", size: 1000, firstDay: "2024-01-01", lastDay: "2025-06-30" };
    const ok = { ...defaultValues(), start: "2024-02-01", end: "2025-02-01" };
    expect(validate(ok, file)).toEqual({});
    const errors = validate({ ...ok, end: "2025-07-01" }, file);
    expect(errors.end).toBe("The file ends on 2025-06-30.");
  });

  it("holds the derived rates to the schema", () => {
    const huge = { ...defaultValues(), battery: { ...defaultValues().battery, power_mw: "2000", duration_hours: "24", round_trip_efficiency: "0.6" } };
    expect(validate(huge)["battery.duration_hours"]).toMatch(/MWh/);
  });
});

describe("inspectPriceCsv", () => {
  it("reads the span of a valid PLD file", () => {
    expect(inspectPriceCsv("t.csv", template.length, template)).toMatchObject({ firstDay: "2025-01-20", lastDay: "2025-01-21" });
    expect(inspectPriceCsv("t.csv", template.length, template).problem).toBeUndefined();
  });

  it("names a wrong header and an empty or oversized file", () => {
    expect(inspectPriceCsv("a.csv", 10, encode("time,p1,p2\n")).problem).toMatch(/line 1/);
    expect(inspectPriceCsv("a.csv", 0, new Uint8Array()).problem).toMatch(/empty/);
    expect(inspectPriceCsv("a.csv", 6 * 1024 * 1024, template).problem).toMatch(/5 MB/);
    expect(inspectPriceCsv("a.csv", 30, encode("hora,submercado,pld\n")).problem).toMatch(/no prices/);
    expect(inspectPriceCsv("a.csv", 40, encode("hora,submercado,pld\nyesterday,SE,2\n")).problem).toMatch(/line 2/);
  });

  it("rejects a UTC offset rather than shift the profile", () => {
    expect(inspectPriceCsv("a.csv", 40, encode("hora,submercado,pld\n2025-01-20T00:00-03:00,SE,2\n")).problem).toMatch(/offset/);
  });
});

describe("buildRequest", () => {
  it("rebuilds the contract example from the form it fills", () => {
    const values = valuesFromRequest(example);
    expect(values.battery.duration_hours).toBe("4");
    expect(values.battery.round_trip_efficiency).toBe("0.85");
    expect(values.battery.charge_rate_mw).toBe("");
    expect(values.battery.discharge_rate_mw).toBe("");
    const request = buildRequest(values);
    for (const key of Object.keys(example.battery) as (keyof typeof example.battery)[]) {
      expect(request.battery[key]).toBeCloseTo(example.battery[key], 9);
    }
    expect("cycle_budget" in request).toBe(false);
    expect("prices_key" in request).toBe(false);
  });

  it("sizes the battery as §2 does", () => {
    const b = physicalBattery(defaultValues());
    expect(b.volume_mwh * b.discharge_efficiency).toBeCloseTo(120, 9);
    expect(b.max_discharge_mw * b.discharge_efficiency).toBeCloseTo(30, 9);
    expect(b.max_charge_mw).toBe(30);
    expect(b.charge_efficiency * b.discharge_efficiency).toBeCloseTo(0.85, 9);
  });

  it("takes explicit rates at the grid and rebuilds them", () => {
    const values = { ...defaultValues(), battery: { ...defaultValues().battery, charge_rate_mw: "28", discharge_rate_mw: "35" } };
    const b = physicalBattery(values);
    expect(b.max_charge_mw).toBe(28);
    expect(b.max_discharge_mw * b.discharge_efficiency).toBeCloseTo(35, 9);
    const back = valuesFromRequest({ battery: b, start: values.start, end: values.end });
    expect(Number(back.battery.charge_rate_mw)).toBeCloseTo(28, 9);
    expect(Number(back.battery.discharge_rate_mw)).toBeCloseTo(35, 9);
  });

  it("follows the battery while the rates are empty", () => {
    const values = { ...defaultValues(), battery: { ...defaultValues().battery, power_mw: "60" } };
    const rates = automaticRates(values)!;
    expect(rates.dischargeMw).toBe(60);
    expect(rates.chargeMw).toBe(60);
    expect(physicalBattery(values).max_charge_mw).toBe(60);
  });

  it("adds cycle_budget and prices_key when present", () => {
    const request = buildRequest({ ...defaultValues(), cycle_budget: " 750 " }, "uploads/abc.csv");
    expect(request.cycle_budget).toBe(750);
    expect(request.prices_key).toBe("uploads/abc.csv");
  });
});

describe("the auction's sizing warnings", () => {
  const withBattery = (battery: Partial<ReturnType<typeof defaultValues>["battery"]>) => ({ ...defaultValues(), battery: { ...defaultValues().battery, ...battery } });

  it("says nothing for the default battery", () => {
    expect(contractWarnings(defaultValues())).toEqual([]);
  });

  it("only warns under 30 MW, and the form stays valid", () => {
    const small = withBattery({ power_mw: "10" });
    expect(contractWarnings(small)[0]).toMatch(/30 MW/);
    expect(validate(small)).toEqual({});
  });

  it("names each contract limit", () => {
    expect(contractWarnings(withBattery({ duration_hours: "3" }))[0]).toMatch(/4 h/);
    expect(contractWarnings(withBattery({ round_trip_efficiency: "0.8" }))[0]).toMatch(/0.85/);
    expect(contractWarnings(withBattery({ charge_rate_mw: "23" }))[0]).toMatch(/6 h/);
    expect(contractWarnings(withBattery({ discharge_rate_mw: "29" }))[0]).toMatch(/discharge rate/);
    // CRCAP 5.1.1(vii): the limit is on the contracted 4 h, so 8 h of volume needs no faster charger.
    expect(contractWarnings(withBattery({ duration_hours: "8", charge_rate_mw: "23.6" }))).toEqual([]);
    expect(contractWarnings(withBattery({ duration_hours: "8", charge_rate_mw: "23" }))[0]).toMatch(/6 h/);
  });
});

describe("helpers", () => {
  it("parses only real calendar dates", () => {
    expect(parseDay("2024-02-29")).not.toBeNull();
    expect(parseDay("2025-02-29")).toBeNull();
    expect(parseDay("2025-2-01")).toBeNull();
  });

  it("derives the markup from the round trip", () => {
    const trip = roundTrip(defaultValues())!;
    expect(trip.efficiency).toBeCloseTo(0.85, 6);
    expect(trip.markup).toBeCloseTo(0.17647059, 6);
  });
});

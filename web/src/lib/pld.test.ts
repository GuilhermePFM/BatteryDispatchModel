import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import corpus from "../../../contracts/examples/pld-upload-verdicts.json";
import { checkPldCsv, PLD_ERRORS } from "./pld";

interface Case {
  name: string;
  csv?: string;
  hex?: string;
  code: string | null;
  line: number | null;
}

function bytes(c: Case): Uint8Array {
  if (c.hex !== undefined) return Uint8Array.from(Buffer.from(c.hex, "hex"));
  return new TextEncoder().encode(c.csv ?? "");
}

describe("PLD upload check", () => {
  it("uses the shared messages", () => {
    expect(PLD_ERRORS).toEqual(corpus.messages);
  });

  it.each(corpus.cases as Case[])("$name", (c) => {
    const got = checkPldCsv(bytes(c));
    if (c.code === null) {
      expect(got).toBeNull();
      return;
    }
    expect(got).toEqual({
      code: c.code,
      line: c.line,
      message: `line ${c.line}: ${(corpus.messages as Record<string, string>)[c.code]}`,
    });
  });

  it("accepts the canonical file", () => {
    const raw = readFileSync(new URL("../../../data/raw/pld_hourly.csv", import.meta.url));
    expect(checkPldCsv(raw)).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { isDecimal, looksGrouped, toNumber } from "../lib/decimal";
import { brl, brlShort, day, num, pct, quarterLabel } from "../lib/format";
import { PLD_ERRORS, type PldErrorCode } from "../lib/pld";
import { BATTERY_FIELDS, numberError } from "../lib/validation";
import { extractMethodology } from "../methodology/extract";
import { renderMarkdown } from "../methodology/render";
import { getLocale, setLocale } from "./index";
import { localizeServerMessage } from "./server";

afterEach(() => setLocale("en"));

describe("the active language", () => {
  it("defaults to English outside a browser", () => {
    expect(getLocale()).toBe("en");
  });

  it("changes separators and words, and never the units", () => {
    expect(num(1234.5, 1)).toBe("1,234.5");
    expect(brl(1234)).toBe("R$ 1,234");
    setLocale("pt");
    expect(num(1234.5, 1)).toBe("1.234,5");
    expect(brl(1234)).toBe("R$ 1.234");
    expect(brlShort(2_500_000)).toMatch(/^R\$ 2,5\s?m$/);
    expect(pct(0.85, 0)).toBe("85%");
    expect(day("2026-02-03")).toBe("3 fev 2026");
    expect(quarterLabel("2026-05-01")).toMatch(/^T2/);
  });

  it("reads field texts when they are shown", () => {
    const power = BATTERY_FIELDS[0];
    expect(power.label).toBe("Power delivered");
    setLocale("pt");
    expect(power.label).toBe("Potência entregue");
    expect({ ...power }.unit).toBe("MW");
  });
});

describe("numbers as typed", () => {
  it("takes either separator as the decimal", () => {
    for (const locale of ["en", "pt"] as const) {
      setLocale(locale);
      expect(toNumber("0,85")).toBe(0.85);
      expect(toNumber("0.85")).toBe(0.85);
      expect(looksGrouped("0.001")).toBe(false);
      expect(looksGrouped("0,001")).toBe(false);
    }
  });

  it("refuses the active language's thousands instead of reading 1", () => {
    expect(looksGrouped("1,000")).toBe(true);
    expect(looksGrouped("1.000")).toBe(false);
    setLocale("pt");
    expect(looksGrouped("1.000")).toBe(true);
    expect(looksGrouped("1,000")).toBe(false);
    expect(numberError("1.000", BATTERY_FIELDS[0])).toMatch(/separador de milhar/);
  });

  it("still refuses what is not a plain decimal", () => {
    for (const text of ["1e3", "1,2,3", "1.2.3", "abc", ","]) expect(isDecimal(text)).toBe(false);
  });
});

describe("messages from the server", () => {
  it("are left as sent in English", () => {
    expect(localizeServerMessage("The file is empty.")).toBe("The file is empty.");
  });

  it("translate every price file error, keeping the line", () => {
    setLocale("pt");
    for (const code of Object.keys(PLD_ERRORS) as PldErrorCode[]) {
      const shown = localizeServerMessage(`line 7: ${PLD_ERRORS[code]}`);
      expect(shown).toMatch(/^linha 7: /);
      expect(shown).not.toContain(PLD_ERRORS[code]);
    }
  });

  it("translate the sentences with values", () => {
    setLocale("pt");
    expect(localizeServerMessage("cannot recharge the contracted 4.0 h within 6.0 h")).toBe("não recarrega as 4,0 h contratadas em até 6,0 h");
    expect(localizeServerMessage("A run covers at most 730 days after its start; shorten the dates.")).toContain("730 dias");
  });

  it("fall back to the original when unknown", () => {
    setLocale("pt");
    expect(localizeServerMessage("Something new.")).toBe("Something new.");
  });
});

describe("the Portuguese methodology", () => {
  const read = (name: string) => readFileSync(new URL(`../../../docs/model/${name}`, import.meta.url), "utf8");
  const options = { repoDocsUrl: "https://example.org/repo/blob/main" };
  const en = extractMethodology(read("model.md"), options);
  const pt = extractMethodology(read("model.pt.md"), options);
  const number = (text: string) => /^\d+(\.\d+)?/.exec(text)?.[0] ?? null;
  const display = (markdown: string) => markdown.match(/\$\$[\s\S]+?\$\$/g) ?? [];
  const inline = (markdown: string) => (markdown.replace(/\$\$[\s\S]+?\$\$/g, "").match(/\$[^$\n]+\$/g) ?? []).sort();

  it("has the same headings, in the same order", () => {
    expect(pt.headings.map((h) => [h.level, number(h.text)])).toEqual(en.headings.map((h) => [h.level, number(h.text)]));
  });

  it("has the same equations", () => {
    expect(display(pt.markdown)).toEqual(display(en.markdown));
    expect(inline(pt.markdown)).toEqual(inline(en.markdown));
  });

  it("keeps the English anchors", () => {
    const anchors = en.headings.map((h) => h.id);
    const html = renderMarkdown(pt.markdown, anchors);
    expect(html).toContain('id="how-much-foresight-is-enough"');
    expect(html).toContain('id="one-program-per-horizon"');
  });
});

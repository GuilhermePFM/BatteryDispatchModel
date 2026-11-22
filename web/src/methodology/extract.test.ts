import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMethodology, stripDroppedLinks } from "./extract";
import { renderMarkdown } from "./render";

const modelMd = readFileSync(new URL("../../../docs/model/model.md", import.meta.url), "utf8");

describe("extractMethodology on docs/model/model.md", () => {
  const { markdown, headings } = extractMethodology(modelMd, {
    repoDocsUrl: "https://example.org/repo/blob/main",
    resolveImage: (path) => (path === "figures/cutting-plane.png" ? "/assets/cutting-plane.png" : undefined),
  });

  it("keeps sections 1 to 6 and nothing after", () => {
    const top = headings.filter((h) => h.level === 2).map((h) => h.text);
    expect(top.map((t) => t.split(".")[0])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(markdown).not.toMatch(/^## 7\./m);
    expect(markdown).not.toMatch(/Reading and rendering/);
    expect(markdown).not.toMatch(/^# Battery dispatch model/m);
  });

  it("keeps the method's subsections, the cutting-plane one included", () => {
    const sub = headings.filter((h) => h.level === 3).map((h) => h.text);
    expect(sub).toContain("4.6 Cycle life");
    expect(sub).toContain("Lagrangian relaxation of the cycle budget");
    expect(sub).toContain("Minimising the dual: the cutting-plane method");
  });

  it("leaves out bisection, solver tuning and the stochastic model", () => {
    expect(markdown).not.toMatch(/bisection|bissection/i);
    expect(markdown).not.toMatch(/stochastic/i);
    expect(markdown).not.toMatch(/solver-parameter-tunning|tuned HiGHS settings/);
    expect(markdown).not.toMatch(/battery-dispatch\.pdf/);
  });

  it("removes only the offending sentence from a paragraph that still matters", () => {
    expect(markdown).toMatch(/taken as\s+\*\*known\*\*: the whole horizon is given before any decision is made\./);
    expect(markdown).toMatch(/\*\*Prices are known over the whole horizon\.\*\*/);
  });

  it("resolves the figure and points other documents at the repository", () => {
    expect(markdown).toContain("](/assets/cutting-plane.png)");
    expect(markdown).toContain("https://example.org/repo/blob/main/scripts/plot_cutting_plane.py");
  });

  it("renders with KaTeX, math intact, ids matching the headings", () => {
    const html = renderMarkdown(markdown);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toMatch(/KXINLINE|KXBLOCK|katex-error/);
    for (const heading of headings) expect(html).toContain(`id="${heading.id}"`);
    expect(html).toContain('<figure class="md-figure"><img src="/assets/cutting-plane.png"');
  });
});

describe("stripDroppedLinks", () => {
  it("drops the sentence, or the aside, and nothing else", () => {
    expect(stripDroppedLinks("Keep this. [x](model-stochastic.md) has more. Keep that too.")).toBe(
      "Keep this. Keep that too.",
    );
    expect(
      stripDroppedLinks("Fast (tuned; see [t](solver-parameter-tunning.md#a-b).) Next sentence."),
    ).toBe("Fast Next sentence.");
    expect(stripDroppedLinks("Only [this](battery-dispatch.pdf).")).toBe("");
  });

  it("keeps links to documents it does not drop as plain text without a repo URL", () => {
    const { markdown } = extractMethodology("## 1. A\n\nSee [`results.md`](results.md) now.\n");
    expect(markdown).toContain("See `results.md` now.");
  });
});

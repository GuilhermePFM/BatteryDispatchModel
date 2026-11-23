import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMethodology, stripDroppedLinks } from "./extract";
import { renderMarkdown } from "./render";

const modelMd = readFileSync(new URL("../../../docs/model/model.md", import.meta.url), "utf8");

describe("extractMethodology on docs/model/model.md", () => {
  const { markdown, headings } = extractMethodology(modelMd, {
    repoDocsUrl: "https://example.org/repo/blob/main",
  });

  it("keeps sections 1 to 6 and 8, and leaves out the results", () => {
    const top = headings.filter((h) => h.level === 2).map((h) => h.text);
    expect(top.map((t) => t.split(".")[0])).toEqual(["1", "2", "3", "4", "5", "6", "8"]);
    expect(markdown).not.toMatch(/^## 7\./m);
    expect(markdown).not.toMatch(/Reading and rendering/);
    expect(markdown).not.toMatch(/^# Battery dispatch and investment model/m);
  });

  it("keeps the method's subsections, the contract and investment ones included", () => {
    const sub = headings.filter((h) => h.level === 3).map((h) => h.text);
    expect(sub).toContain("4.6 Cycle life");
    expect(sub).toContain("4.5 Capacity contract obligations");
    expect(sub).toContain("5.1 Why no charge/discharge binary is needed");
    expect(sub).toContain("The contracted case: relaxation first");
    expect(sub).toContain("8.5 Cash flows");
    // Run.tsx deep-links to this one.
    expect(headings.map((h) => h.id)).toContain("how-much-foresight-is-enough");
  });

  it("leaves out the pointer to the typeset PDF", () => {
    expect(markdown).not.toMatch(/battery-dispatch\.pdf/);
  });

  it("removes only the offending sentence from a paragraph that still matters", () => {
    expect(markdown).toMatch(/taken as\s+\*\*known\*\*: the whole horizon is given before any decision is made\./);
    expect(markdown).toMatch(/at stock HiGHS settings\.\s+A rolling 24\+24 h window/);
    expect(markdown).toMatch(/\*\*Prices are known over the whole horizon\.\*\*/);
  });

  it("points other documents at the repository", () => {
    expect(markdown).toContain("https://example.org/repo/blob/main/docs/mercado-brasileiro.md");
    expect(markdown).toContain("https://example.org/repo/blob/main/docs/leilao-lrcap-2026/README.md");
  });

  it("renders with KaTeX, math intact, ids matching the headings", () => {
    const html = renderMarkdown(markdown);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toMatch(/KXINLINE|KXBLOCK|katex-error/);
    for (const heading of headings) expect(html).toContain(`id="${heading.id}"`);
  });
});

describe("extractMethodology on a note with a figure", () => {
  it("resolves the image and renders it as a figure", () => {
    const { markdown } = extractMethodology("## 1. A\n\n![A plot](figures/plot.png)\n", {
      resolveImage: (path) => (path === "figures/plot.png" ? "/assets/plot.png" : undefined),
    });
    expect(markdown).toContain("](/assets/plot.png)");
    expect(renderMarkdown(markdown)).toContain('<figure class="md-figure"><img src="/assets/plot.png"');
  });
});

describe("stripDroppedLinks", () => {
  it("drops the sentence and nothing else", () => {
    expect(stripDroppedLinks("Keep this. [x](battery-dispatch.pdf) has more. Keep that too.")).toBe(
      "Keep this. Keep that too.",
    );
    expect(stripDroppedLinks("Only [this](battery-dispatch.pdf).")).toBe("");
  });

  it("keeps links to documents it does not drop as plain text without a repo URL", () => {
    const { markdown } = extractMethodology("## 1. A\n\nSee [`results.md`](results.md) now.\n");
    expect(markdown).toContain("See `results.md` now.");
  });
});

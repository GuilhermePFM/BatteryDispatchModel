// docs/model/model.md is the single source: it is imported raw at build time,
// cut down to the deterministic model (§1 to §6, see methodology/extract.ts)
// and rendered with KaTeX here.
import "katex/dist/katex.min.css";
import { useEffect, useMemo, useState } from "react";
import modelMarkdown from "../../../docs/model/model.md?raw";
import { repoUrl } from "../lib/config";
import { extractMethodology } from "../methodology/extract";
import { renderMarkdown } from "../methodology/render";

const figures = import.meta.glob("../../../docs/model/figures/*", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

function resolveImage(path: string): string | undefined {
  const name = path.replace(/^\.\//, "").replace(/^figures\//, "");
  const key = Object.keys(figures).find((k) => k.endsWith(`/figures/${name}`));
  return key ? figures[key] : undefined;
}

function useCurrentHeading(ids: string[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);
  return current;
}

export default function Methodology() {
  const { html, headings } = useMemo(() => {
    const extracted = extractMethodology(modelMarkdown, { repoDocsUrl: repoUrl, resolveImage });
    return { html: renderMarkdown(extracted.markdown), headings: extracted.headings };
  }, []);
  const ids = useMemo(() => headings.map((h) => h.id), [headings]);
  const current = useCurrentHeading(ids);

  useEffect(() => {
    // Deep links: the route renders after the browser tried to scroll.
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) document.getElementById(hash)?.scrollIntoView();
  }, []);

  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>Methodology</h1>
          <p>
            The optimisation model behind every plan on this site: what is decided, what constrains it, and how the cycle budget is priced. This page is
            rendered from <a href={`${repoUrl}/docs/model/model.md`}>docs/model/model.md</a> in the repository.
          </p>
        </div>
        <div className="doc-layout">
          <nav className="doc-toc" aria-label="On this page">
            <ol>
              {headings.map((h) => (
                <li key={h.id} className={h.level === 3 ? "l3" : undefined}>
                  <a href={`#${h.id}`} className={current === h.id ? "current" : undefined}>
                    {h.text.replace(/\$/g, "")}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}

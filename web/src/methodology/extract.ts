// Picks the site's methodology out of docs/model/model.md, which stays the one
// source: §1 to §6 of the deterministic model, without the bisection method,
// the solver tuning notes, or anything about the stochastic model.

/** Top-level sections kept, by their hand-written number ("## 4. Constraints"). */
export const KEPT_SECTIONS = [1, 2, 3, 4, 5, 6];

/** A paragraph mentioning any of these is about material the site leaves out, and goes whole. */
export const DROPPED_BLOCKS: RegExp[] = [/\bbisection\b/i, /\bbissection\b/i, /\bstochastic\b/i];

/**
 * Links to documents the site leaves out. The sentence (or, for `parenthetical`,
 * the bracketed aside) carrying one is removed rather than the paragraph, which
 * usually still says something the model needs.
 */
export const DROPPED_LINKS: { target: RegExp; scope: "sentence" | "parenthetical" }[] = [
  { target: /model-stochastic\.md/, scope: "sentence" },
  { target: /battery-dispatch\.pdf/, scope: "sentence" },
  { target: /solver-parameter-tunning\.md/, scope: "parenthetical" },
];

export interface Heading {
  level: 2 | 3;
  text: string;
  id: string;
}

export interface Extracted {
  markdown: string;
  headings: Heading[];
}

export interface ExtractOptions {
  /** Base URL for links to other repository documents, relative to docs/model/; empty keeps them as text. */
  repoDocsUrl?: string;
  /** Resolves an image path relative to docs/model/ to the URL the page can load. */
  resolveImage?: (path: string) => string | undefined;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_$\\]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Splits markdown into its `## ` sections; the preamble before the first one is dropped. */
function sections(markdown: string): { number: number | null; body: string }[] {
  const out: { number: number | null; body: string }[] = [];
  let current: string[] | null = null;
  let number: number | null = null;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) {
      if (current) out.push({ number, body: current.join("\n") });
      const match = /^## (\d+)\./.exec(line);
      number = match ? Number(match[1]) : null;
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) out.push({ number, body: current.join("\n") });
  return out;
}

/** Paragraph-level blocks: text separated by blank lines. Display math has none inside. */
function blocks(text: string): string[] {
  return text.split(/\n[ \t]*\n/);
}

function removeSentence(block: string, index: number, length: number): string {
  const before = block.slice(0, index);
  let start = 0;
  const boundary = /[.!?](\s+)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(before))) start = match.index + match[0].length;
  const after = block.slice(index + length);
  const end = /[.!?](?=\s|$)/.exec(after);
  const stop = end ? index + length + end.index + 1 : block.length;
  const head = block.slice(0, start);
  const tail = /\s$/.test(head) ? block.slice(stop).replace(/^[ \t]+/, "") : block.slice(stop);
  return (head + tail).replace(/[ \t]+\n/g, "\n").trim();
}

function removeParenthetical(block: string, index: number): string | null {
  let depth = 0;
  let open = -1;
  for (let i = index - 1; i >= 0; i--) {
    const ch = block[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return null;
  depth = 0;
  for (let i = open; i < block.length; i++) {
    const ch = block[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        const head = block.slice(0, open).replace(/[ \t]+$/, "");
        return (head + block.slice(i + 1)).trim();
      }
    }
  }
  return null;
}

/** Removes every sentence or aside that links to a dropped document; "" when nothing is left. */
export function stripDroppedLinks(block: string): string {
  let text = block;
  for (const rule of DROPPED_LINKS) {
    for (let guard = 0; guard < 20; guard++) {
      const match = rule.target.exec(text);
      if (!match) break;
      // Widen the match to the whole markdown link it sits in, when it does.
      const link = /\[[^\]]*\]\([^)]*\)/g;
      let start = match.index;
      let length = match[0].length;
      let found: RegExpExecArray | null;
      while ((found = link.exec(text))) {
        if (found.index <= match.index && match.index < found.index + found[0].length) {
          start = found.index;
          length = found[0].length;
          break;
        }
      }
      const next =
        (rule.scope === "parenthetical" ? removeParenthetical(text, start) : null) ??
        removeSentence(text, start, length);
      if (next === text) break;
      text = next;
    }
  }
  return text;
}

/** Links to other repository documents point at the repository, or become plain text. */
export function rewriteLinks(block: string, options: ExtractOptions): string {
  return block.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang: string, text: string, href: string) => {
    if (bang) {
      const resolved = options.resolveImage?.(href);
      return resolved ? `![${text}](${resolved})` : whole;
    }
    if (/^(https?:|mailto:|#)/.test(href)) return whole;
    if (!options.repoDocsUrl) return text;
    const url = new URL(href, `${options.repoDocsUrl.replace(/\/$/, "")}/docs/model/`).toString();
    return `[${text}](${url})`;
  });
}

export function extractMethodology(markdown: string, options: ExtractOptions = {}): Extracted {
  const kept = sections(markdown.replace(/\r\n/g, "\n")).filter(
    (section) => section.number !== null && KEPT_SECTIONS.includes(section.number),
  );
  const parts: string[] = [];
  for (const section of kept) {
    for (const block of blocks(section.body)) {
      if (block.trim() === "" || /^-{3,}\s*$/.test(block.trim())) continue;
      // Links first: a sentence pointing at model-stochastic.md goes, its paragraph stays.
      const stripped = stripDroppedLinks(block);
      if (stripped.trim() === "") continue;
      if (DROPPED_BLOCKS.some((pattern) => pattern.test(stripped))) continue;
      parts.push(rewriteLinks(stripped, options));
    }
  }
  const text = parts.join("\n\n") + "\n";
  const headings: Heading[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) fenced = !fenced;
    const match = !fenced && /^(##|###) (.+)$/.exec(line);
    if (match) {
      const title = match[2].trim();
      headings.push({ level: match[1].length as 2 | 3, text: title, id: slugify(title) });
    }
  }
  return { markdown: text, headings };
}

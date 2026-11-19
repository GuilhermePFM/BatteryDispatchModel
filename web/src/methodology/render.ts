// Markdown to HTML with KaTeX: the math is lifted out before markdown-it sees it
// (so its underscores and asterisks are not read as emphasis), and put back
// rendered afterwards. Delimiters follow model.md: $$...$$ and $...$.
import katex from "katex";
import MarkdownIt from "markdown-it";
import { slugify } from "./extract";

const BLOCK = (n: number) => `KXBLOCK${n}KX`;
const INLINE = (n: number) => `KXINLINE${n}KX`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMarkdown(markdown: string): string {
  const display: string[] = [];
  const inline: string[] = [];
  let text = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    display.push(tex.trim());
    return `\n\n${BLOCK(display.length - 1)}\n\n`;
  });
  // Inline math may wrap a line, never a paragraph.
  text = text.replace(/\$((?:[^$\n]|\n(?!\s*\n))+?)\$/g, (_m, tex: string) => {
    inline.push(tex.replace(/\s*\n\s*/g, " ").trim());
    return INLINE(inline.length - 1);
  });

  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const title = tokens[idx + 1]?.content ?? "";
    // The id is built from the source text so the table of contents can match it.
    const source = title.replace(/KXINLINE(\d+)KX/g, (_m, n: string) => `$${inline[Number(n)]}$`);
    tokens[idx].attrSet("id", slugify(source));
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const src = String(token.attrGet("src") ?? "");
    const caption = token.content;
    return `<figure class="md-figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(caption)}" loading="lazy" /><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  };
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const href = String(tokens[idx].attrGet("href") ?? "");
    if (/^https?:/.test(href)) {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noreferrer");
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.table_open = () => '<div class="md-table"><table>';
  md.renderer.rules.table_close = () => "</table></div>";

  let html = md.render(text);
  // Inside an attribute the math stays as its TeX source.
  html = html.replace(/(alt|title)="([^"]*)"/g, (_m, attr: string, value: string) => {
    const plain = value.replace(/KXINLINE(\d+)KX/g, (_n, n: string) => escapeHtml(inline[Number(n)]));
    return `${attr}="${plain}"`;
  });
  html = html.replace(/<p>KXBLOCK(\d+)KX<\/p>/g, (_m, n: string) =>
    katex.renderToString(display[Number(n)], { displayMode: true, throwOnError: false, output: "html" }),
  );
  html = html.replace(/KXBLOCK(\d+)KX/g, (_m, n: string) =>
    katex.renderToString(display[Number(n)], { displayMode: true, throwOnError: false, output: "html" }),
  );
  html = html.replace(/KXINLINE(\d+)KX/g, (_m, n: string) =>
    katex.renderToString(inline[Number(n)], { displayMode: false, throwOnError: false, output: "html" }),
  );
  return html.replace(/<p>(<figure[\s\S]*?<\/figure>)<\/p>/g, "$1");
}

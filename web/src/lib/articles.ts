import type { ArticleData } from "./article-schema";

export type Article = { id: string; data: ArticleData; body?: string };

/** Future dates never publish a route. A later release still needs a new build. */
export function publishedArticles<T extends Article>(articles: T[], now = new Date()): T[] {
  return articles.filter(({ data }) => !data.draft && Date.parse(data.publishedAt) <= now.getTime())
    .sort((a, b) => Date.parse(b.data.publishedAt) - Date.parse(a.data.publishedAt) || a.id.localeCompare(b.id));
}

export const articlePath = (slug: string) => `/blog/${slug}/`;
export const articleDate = (date: string) => new Intl.DateTimeFormat("en-US", {
  month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York",
}).format(new Date(date));

export function articleWordCount(body: string): number {
  return body.replace(/\[[^\]]*\]\([^)]*\)/g, (link) => link.slice(1, link.indexOf("]")))
    .replace(/^\s*\[[^\]]+\]:.*$/gm, "")
    .match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** These are prose articles. Images are supplied by validated metadata. */
export function assertArticleMarkdown(body: string): void {
  if (/[<>]/.test(body) || /!\s*\[/.test(body) || /^\s*(?:import|export)\s/m.test(body)) {
    throw new Error("Article Markdown cannot contain HTML, autolink markup, inline images, imports or exports.");
  }
  if (/^\s*#\s+/m.test(body)) throw new Error("Use level-two or deeper headings; the page supplies its title.");
}

/** Check actual renderer output too, including reference links and entity decoding. */
export function assertArticleHtml(html: string): void {
  for (const match of html.matchAll(/\b(?:href|src)="([^"]*)"/gi)) {
    const url = match[1].replaceAll("&amp;", "&");
    // Require the rendered URL to start literally with one of these forms.
    // Reject encoded/control-character protocol tricks rather than decoding them.
    if (/[\u0000-\u0020\\]/.test(url) || /&(?:#|[a-z]+;)|%(?:0[0-9a-f]|1[0-9a-f]|20|5c)/i.test(url) ||
      !(url.startsWith("https://") || /^\/(?!\/)/.test(url) || url.startsWith("#"))) {
      throw new Error("Article links must use HTTPS, a site-relative path or a heading anchor.");
    }
    if (url.startsWith("https://")) {
      const parsed = new URL(url);
      if (!parsed.hostname || parsed.username || parsed.password) throw new Error("Article links cannot contain credentials.");
    }
    if (url.startsWith("/") && /(?:\.\.|%2e|%2f|%5c)/i.test(url)) {
      throw new Error("Article internal links cannot traverse or encode path separators.");
    }
  }
  if (/<(?:script|iframe|object|embed|form|style|img|h1)\b|\son[a-z]+\s*=/i.test(html)) {
    throw new Error("Article rendering produced unsupported HTML.");
  }
}

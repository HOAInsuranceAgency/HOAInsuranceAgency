import { htmlToHast, markdownToMdast } from "satteri";
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

type ContentNode = {
  type: string;
  children?: ContentNode[];
  depth?: number;
  url?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
};
function visitContent(node: ContentNode, visit: (node: ContentNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) visitContent(child, visit);
}

function assertArticleLink(url: string): void {
  // Parsers decode character references before this check. Percent-encoded
  // controls and separators still need rejecting before a browser uses the URL.
  if (/[\u0000-\u0020\\]/.test(url) || /&(?:#|[a-z]+;)/i.test(url) || /%(?:0[0-9a-f]|1[0-9a-f]|20|5c)/i.test(url) ||
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

/** Validate syntax nodes, leaving blockquotes, comparisons and code text intact. */
export function assertArticleMarkdown(body: string): void {
  if (/^\s*(?:import|export)\s/m.test(body)) {
    throw new Error("Article Markdown cannot contain imports or exports.");
  }
  visitContent(markdownToMdast(body) as ContentNode, (node) => {
    if (node.type === "html" || node.type === "image" || node.type === "imageReference") {
      throw new Error("Article Markdown cannot contain HTML or inline images.");
    }
    if (node.type === "heading" && node.depth === 1) {
      throw new Error("Use level-two or deeper headings; the page supplies its title.");
    }
    if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
      assertArticleLink(node.url);
    }
  });
}

const articleElements = new Set([
  "p", "h2", "h3", "h4", "h5", "h6", "a", "strong", "em", "del", "ul", "ol", "li",
  "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "pre", "code",
  "span", "br", "hr", "sup", "section", "input",
]);

/** Inspect actual elements and decoded attributes, never text that resembles them. */
export function assertArticleHtml(html: string): void {
  visitContent(htmlToHast(html, { fragment: true }) as ContentNode, (node) => {
    if (node.type !== "element") return;
    const tag = node.tagName ?? "";
    const attributes = node.properties ?? {};
    if (!articleElements.has(tag) || Object.keys(attributes).some((name) => /^on|^srcdoc$/i.test(name))) {
      throw new Error("Article rendering produced unsupported HTML.");
    }
    // GFM task lists may produce disabled checkboxes, never interactive inputs.
    if (tag === "input" && (attributes.type !== "checkbox" || attributes.disabled !== true)) {
      throw new Error("Article rendering produced an interactive input.");
    }
    for (const name of ["href", "src"]) {
      if (typeof attributes[name] === "string") assertArticleLink(attributes[name]);
    }
  });
}

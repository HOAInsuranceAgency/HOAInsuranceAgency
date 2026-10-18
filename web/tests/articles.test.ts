import assert from "node:assert/strict";
import test from "node:test";
import { articleSchema } from "../src/lib/article-schema";
import { articleDate, articlePath, assertArticleHtml, assertArticleMarkdown, publishedArticles } from "../src/lib/articles";

const metadata = {
  slug: "layout-fixture", title: "Synthetic layout fixture", description: "A synthetic article used only for automated rendering checks.",
  topic: "Testing", tags: ["fixture"], publishedAt: "2026-01-15T15:00:00-05:00", draft: false,
  image: { src: "/images/blog/layout-fixture/test.jpg", alt: "Synthetic fixture image", width: 800, height: 600, credit: "Test fixture", provenance: "Local test fixture only" },
  sources: [{ title: "Synthetic source", publisher: "Example", url: "https://example.com/reference", accessedAt: "2026-01-14T12:00:00Z" }],
};
const article = { id: metadata.slug, data: articleSchema.parse(metadata), body: "Synthetic body." };

test("strict metadata rejects missing slugs, credentials, cross-article images and invented authors", () => {
  for (const value of [
    { ...metadata, slug: undefined }, { ...metadata, slug: "../escape" }, { ...metadata, author: "An invented expert" },
    { ...metadata, image: { ...metadata.image, src: "/images/blog/another/test.jpg" } },
    { ...metadata, sources: [{ ...metadata.sources[0], url: "javascript:alert(1)" }] },
    { ...metadata, sources: [{ ...metadata.sources[0], url: "https://user:secret@example.com" }] },
    { ...metadata, updatedAt: "2026-01-01T00:00:00Z" },
  ]) assert.equal(articleSchema.safeParse(value).success, false);
  assert.equal(articleSchema.parse({ ...metadata, draft: undefined }).draft, true);
});

test("only released public articles appear in date order, including after a second unchanged read", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const draft = { ...article, id: "draft", data: { ...article.data, draft: true } };
  const future = { ...article, id: "future", data: { ...article.data, publishedAt: "2099-01-01T00:00:00Z" } };
  const newer = { ...article, id: "newer", data: { ...article.data, publishedAt: "2026-01-30T00:00:00Z" } };
  const entries = [article, draft, future, newer];
  assert.deepEqual(publishedArticles(entries, now).map((item) => item.id), ["newer", "layout-fixture"]);
  assert.deepEqual(publishedArticles(entries, now), publishedArticles(entries, now));
  assert.equal(entries.length, 4);
});

test("prose Markdown and renderer output reject HTML and disguised executable links", () => {
  assertArticleMarkdown("## Heading\n\nA useful [internal link](/what-we-do/) and a citation.");
  for (const body of ["<script>alert(1)</script>", "<Component />", "![inline image](x)", "import X from 'x'", "export const x = 1", "# Duplicate title"]) assert.throws(() => assertArticleMarkdown(body));
  for (const url of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "/&#x2f;/evil.example", "https://example.com/%0aevil", "https://user:pass@example.com", "/%2e%2e/private", "http://example.com", "https://example.com/&#Tab;bad"]) assert.throws(() => assertArticleHtml(`<p><a href="${url}">link</a></p>`));
  assertArticleHtml('<p><a href="https://example.com/?a=1&amp;b=2">source</a><a href="/what-we-do/">coverage</a><a href="#heading">heading</a></p>');
});

test("route and display date preserve the trailing-slash and Eastern-time contracts", () => {
  assert.equal(articlePath(metadata.slug), "/blog/layout-fixture/");
  assert.equal(articleDate("2026-01-16T01:00:00Z"), "January 15, 2026");
});

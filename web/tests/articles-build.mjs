import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { imageMetadata } from "astro/assets/utils";

const web = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(web, "..");
const keepPreview = process.argv.includes("--keep-preview");
const temporary = await mkdtemp(join(tmpdir(), "hoa-article-tests-"));
const root = join(temporary, "web");
const out = join(root, "dist");
const content = join(root, "src/content/articles");
const sourceImage = join(web, "public/images/board-meeting.jpg");
const dimensions = await imageMetadata(await readFile(sourceImage));
const metadata = (slug, extra = {}) => ({
  slug, title: `Synthetic fixture: ${slug}`, description: "Synthetic content for article route verification only.", topic: "Test fixture", tags: ["testing"], publishedAt: "2026-01-15T10:00:00-05:00", draft: false,
  image: { src: `/images/blog/${slug}/test.jpg`, alt: "Synthetic rendering fixture", width: dimensions.width, height: dimensions.height, credit: "Test fixture only", provenance: "Local fixture, not a published article" },
  sources: [{ title: "Synthetic reference", publisher: "Example", url: "https://example.com/reference", accessedAt: "2026-01-14T12:00:00Z" }], ...extra,
});
const paragraph = "This synthetic paragraph exercises the article layout with plain readable text. It is a software test fixture and makes no insurance claim. Readers can use the headings and source list to inspect the rendered page. The fixture never enters the production content collection. ";
const body = `## A synthetic heading\n\n${paragraph.repeat(13)}\n\n## A second heading\n\n> Quoted guidance from a synthetic source.\n\nThe plain-text comparison says one = two and 2 < 3.\n\n${paragraph.repeat(13)}\n\nSee the [existing coverage page](/what-we-do/) and the [synthetic reference](https://example.com/reference).`;
async function fixture(slug, extra = {}, text = body) {
  const data = metadata(slug, extra);
  await mkdir(join(root, `public/images/blog/${slug}`), { recursive: true });
  await cp(sourceImage, join(root, `public/images/blog/${slug}/test.jpg`));
  await writeFile(join(content, `${slug}.md`), `---\n${JSON.stringify(data)}\n---\n\n${text}\n`);
}
function build(success = true, expected) {
  const result = spawnSync(process.execPath, [join(web, "node_modules/astro/bin/astro.mjs"), "build"], { cwd: root, encoding: "utf8", env: { ...process.env, PUBLIC_ANALYTICS_DISABLED: "true", ASTRO_TELEMETRY_DISABLED: "1" } });
  const output = result.stdout + result.stderr;
  assert.equal(result.status === 0, success, output);
  if (expected) assert.match(output, expected);
}
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
try {
  await mkdir(root);
  for (const path of ["src", "public", "astro.config.mjs", "tsconfig.json", "package.json"]) await cp(join(web, path), join(root, path), { recursive: true });
  await cp(join(repository, "shared"), join(temporary, "shared"), { recursive: true });
  await symlink(join(web, "node_modules"), join(root, "node_modules"), "dir");
  await rm(content, { recursive: true, force: true });
  await mkdir(content);
  build();
  const empty = await readFile(join(out, "blog/index.html"), "utf8");
  assert.match(empty, /New articles will appear here/);
  assert.doesNotMatch(empty, /BlogPosting/);
  await fixture("layout-fixture");
  await fixture("draft-fixture", { draft: true });
  await fixture("future-fixture", { publishedAt: "2099-01-01T12:00:00Z" });
  build();
  const article = await readFile(join(out, "blog/layout-fixture/index.html"), "utf8");
  const listing = await readFile(join(out, "blog/index.html"), "utf8");
  const sitemap = await readFile(join(out, "sitemap-0.xml"), "utf8");
  assert.match(article, /<h2 id="a-synthetic-heading">/);
  assert.match(article, /<blockquote>/);
  assert.match(article, /one = two and 2 &lt; 3/);
  assert.match(article, /Sources &amp; further reading/);
  assert.match(article, /href="https:\/\/example.com\/reference"/);
  assert.match(article, /<meta property="og:type" content="article"/);
  assert.match(article, /<meta property="og:image:alt" content="Synthetic rendering fixture"/);
  assert.match(article, /rel="canonical" href="https:\/\/www.protectmyhoa.com\/blog\/layout-fixture\/"/);
  assert.equal((article.match(/<h1\b/g) ?? []).length, 1);
  const graphs = [...article.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].map((match) => JSON.parse(match[1]));
  const articleNodes = graphs.flatMap((graph) => graph["@graph"] ?? []).filter((node) => node["@type"] === "BlogPosting");
  assert.equal(articleNodes.length, 1);
  assert.equal(articleNodes[0].url, "https://www.protectmyhoa.com/blog/layout-fixture/");
  assert.deepEqual(articleNodes[0].author, { "@id": "https://www.protectmyhoa.com/#organization" });
  assert.equal(articleNodes[0].datePublished, "2026-01-15T10:00:00-05:00");
  assert.equal(articleNodes[0].dateModified, undefined);
  assert.deepEqual(articleNodes[0].citation, ["https://example.com/reference"]);
  assert.match(listing, /href="\/blog\/layout-fixture\/"/);
  assert.match(sitemap, /https:\/\/www.protectmyhoa.com\/blog\/layout-fixture\//);
  for (const slug of ["draft-fixture", "future-fixture", "missing-slug"]) {
    assert.equal(await exists(join(out, `blog/${slug}/index.html`)), false);
    assert.equal(sitemap.includes(`/blog/${slug}/`), false);
    assert.equal(listing.includes(`href="/blog/${slug}/"`), false);
  }
  build(); // unchanged restart produces the same published route set
  assert.equal(await readFile(join(out, "blog/layout-fixture/index.html"), "utf8"), article);
  await fixture("unsafe-html", {}, `${body}\n<script>alert(1)</script>`);
  build(false, /cannot contain HTML/);
  await rm(join(content, "unsafe-html.md"));
  await fixture("unsafe-link", {}, `${body}\n[Bad][unsafe]\n\n[unsafe]: javascript:alert(1)`);
  build(false, /Article links must use HTTPS/);
  await rm(join(content, "unsafe-link.md"));
  await fixture("wrong-filename", { slug: "other-slug", image: { ...metadata("wrong-filename").image, src: "/images/blog/other-slug/test.jpg" } });
  build(false, /filename must match its slug/);
  await rm(join(content, "wrong-filename.md"));
  await fixture("too-short", {}, "## A heading\n\nThis article is too short.");
  build(false, /1,000–2,000 words/);
  await rm(join(content, "too-short.md"));
  await fixture("missing-image", { image: { ...metadata("missing-image").image, src: "/images/blog/missing-image/not-found.jpg" } });
  build(false, /ENOENT/);
  await rm(join(content, "missing-image.md"));
  if (keepPreview) { build(); console.log(`Synthetic preview files: ${out}`); }
  console.log("PASS: real Astro builds cover empty, published, draft, future, missing route, restart, unsafe HTML/link, slug, word-count and missing-image cases.");
} finally { if (!keepPreview) await rm(temporary, { recursive: true, force: true }); }

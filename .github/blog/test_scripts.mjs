import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readArticle } from "./lib.mjs";

const script = (name) => fileURLToPath(new URL(name, import.meta.url));
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "hoa-blog-scripts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "web/src/content/articles"), { recursive: true });
  return root;
};
const run = (name, args, env = {}, expectedStatus = 0) => {
  const result = spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result.stdout.trim();
};

const yamlArticle = ({ slug = "manual-yaml", publishedAt, draft = false } = {}) => `---
slug: ${slug}
title: Original title
description: >-
  First sentence.
  Second sentence.
topic: Master Policies
tags: [renewals, board]
publishedAt: ${publishedAt}
draft: ${draft}
image:
  src: /images/blog/${slug}/cover.jpg
  width: 1600
  height: 900
sources:
  - title: Primary source
    publisher: Regulator
    url: https://example.gov/source
    accessedAt: 2026-11-05T12:00:00-05:00
---

> Review this article.

## Coverage

Article body.
`;

test("scheduled publishing finds due YAML articles and excludes drafts and future dates", (t) => {
  const root = fixture(t);
  const directory = join(root, "web/src/content/articles");
  const recently = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  writeFileSync(join(directory, "manual-yaml.md"), yamlArticle({ publishedAt: recently }));
  writeFileSync(join(directory, "unapproved.md"), yamlArticle({ slug: "unapproved", publishedAt: recently, draft: true }));
  writeFileSync(join(directory, "future.md"), yamlArticle({ slug: "future", publishedAt: future }));
  assert.equal(run("due.mjs", ["--root", root]), "due manual-yaml");
});

test("review commands update YAML articles while preserving nested metadata and the body", (t) => {
  const root = fixture(t);
  const file = join(root, "web/src/content/articles/manual-yaml.md");
  const source = yamlArticle({ publishedAt: "2026-11-10T08:00:00-05:00", draft: true }).replaceAll("\n", "\r\n");
  writeFileSync(file, source);
  run("review.mjs", ["--root", root, "--slug", "manual-yaml", "--out", join(root, "review-output")], {
    COMMENT_BODY: "/title Updated title", PR_BODY: "",
  });
  const updated = readArticle(readFileSync(file, "utf8"));
  const original = readArticle(source);
  assert.deepEqual(updated.data, { ...original.data, title: "Updated title" });
  assert.equal(updated.data.description, "First sentence. Second sentence.");
  assert.equal(updated.data.publishedAt, "2026-11-10T08:00:00-05:00");
  assert.equal(updated.body.trim(), original.body.trim());
  assert.match(readFileSync(join(root, "review-output/result.md"), "utf8"), /Title set:\*\* Updated title/);
});

const photoComment = `/photo
alt: Condominium building exterior
credit: Photo: HOA Insurance Agency
source: Agency photo, all rights held
link: https://example.com/photo
`;

test("photo review rejects multiple uploads without changing the article or any photo", (t) => {
  const root = fixture(t);
  const article = join(root, "web/src/content/articles/manual-yaml.md");
  const source = yamlArticle({ publishedAt: "2026-11-10T08:00:00-05:00", draft: true });
  writeFileSync(article, source);
  const folder = join(root, "web/public/images/blog/manual-yaml");
  mkdirSync(folder, { recursive: true });
  const photos = { "cover.jpg": "existing cover", "first.jpg": "first upload", "second.png": "second upload" };
  for (const [name, content] of Object.entries(photos)) writeFileSync(join(folder, name), content);
  // Checkout timestamps do not identify the reviewer's intended photo.
  utimesSync(join(folder, "first.jpg"), 100, 100);
  utimesSync(join(folder, "second.png"), 200, 200);
  const out = join(root, "review-output");
  run("review.mjs", ["--root", root, "--slug", "manual-yaml", "--out", out], { COMMENT_BODY: photoComment }, 2);
  assert.match(readFileSync(join(out, "result.md"), "utf8"), /exactly one uploaded photo.*found 2/);
  assert.equal(readFileSync(join(out, "changed.txt"), "utf8"), "");
  assert.equal(readFileSync(article, "utf8"), source);
  assert.deepEqual(readdirSync(folder).sort(), Object.keys(photos).sort());
  for (const [name, content] of Object.entries(photos)) assert.equal(readFileSync(join(folder, name), "utf8"), content);
});

test("photo review applies a single upload and marks the article ready", async (t) => {
  const root = fixture(t);
  const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url));
  const sharp = requireWeb("sharp");
  symlinkSync(fileURLToPath(new URL("../../web/node_modules", import.meta.url)), join(root, "web/node_modules"), "dir");
  const article = join(root, "web/src/content/articles/manual-yaml.md");
  const source = yamlArticle({ publishedAt: "2026-11-10T08:00:00-05:00", draft: true });
  writeFileSync(article, source);
  const folder = join(root, "web/public/images/blog/manual-yaml");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "cover.jpg"), "temporary cover");
  writeFileSync(join(folder, "README.txt"), "Preserve other article files.");
  await sharp({ create: { width: 1800, height: 1000, channels: 3, background: "#245355" } }).png().toFile(join(folder, "chosen.png"));
  const out = join(root, "review-output");
  run("review.mjs", ["--root", root, "--slug", "manual-yaml", "--out", out], { COMMENT_BODY: photoComment });
  const updated = readArticle(readFileSync(article, "utf8"));
  assert.equal(updated.data.draft, false);
  assert.equal(updated.body.trim(), readArticle(source).body.trim());
  assert.deepEqual(updated.data.image, {
    src: "/images/blog/manual-yaml/cover.jpg", alt: "Condominium building exterior", width: 1600, height: 900,
    credit: "Photo: HOA Insurance Agency", provenance: "Agency photo, all rights held", sourceUrl: "https://example.com/photo",
  });
  const cover = await sharp(join(folder, "cover.jpg")).metadata();
  assert.equal(cover.format, "jpeg");
  assert.equal(cover.width, 1600);
  assert.equal(cover.height, 900);
  assert.deepEqual(readdirSync(folder).sort(), ["README.txt", "cover.jpg"]);
  assert.equal(readFileSync(join(folder, "README.txt"), "utf8"), "Preserve other article files.");
  assert.match(readFileSync(join(out, "result.md"), "utf8"), /Photo applied/);
  assert.deepEqual(readFileSync(join(out, "changed.txt"), "utf8").split("\n").sort(), [
    "web/public/images/blog/manual-yaml", "web/src/content/articles/manual-yaml.md",
  ]);
});

for (const count of [1, 2]) {
  test(`the reminder shell loop marks all ${count} emailed draft(s)`, (t) => {
    const root = fixture(t);
    const input = join(root, "drafts.json");
    const marked = join(root, "marked.txt");
    const drafts = Array.from({ length: count }, (_, index) => ({
      number: 101 + index, title: `Blog draft: Article ${index + 1}`,
      url: `https://github.com/example/repo/pull/${101 + index}`,
      createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), comments: [],
    }));
    writeFileSync(input, JSON.stringify(drafts));
    assert.equal(run("notify.mjs", ["reminder", "--input", input, "--out", join(root, "email.json"), "--marked", marked], {
      BLOG_EMAIL_FROM: "sender@example.com", REVIEWER_EMAIL: "reviewer@example.com",
    }), "ready");
    const loop = spawnSync("bash", ["-c", 'while read -r number; do printf "%s\\n" "$number"; done < "$1"', "reminder-loop", marked], {
      encoding: "utf8", env: { PATH: process.env.PATH },
    });
    assert.equal(loop.status, 0, loop.stderr);
    assert.equal(loop.stdout, drafts.map((draft) => `${draft.number}\n`).join(""));
  });
}

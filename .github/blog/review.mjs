/**
 * Apply a reviewer's comment to a draft branch.
 *
 *   COMMENT_BODY=... PR_BODY=... node .github/blog/review.mjs --slug <slug> --out review-output
 *
 *   /title 2                  pick a title option from the pull request
 *   /title Your own wording   set the title directly
 *   /photo                    use the photo uploaded to the article's image folder
 *   alt: ...  credit: ...  source: ...  link: https://... (optional)
 *
 * Writes result.md (the reply comment) and changed.txt (paths to commit).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readArticle, writeArticle } from "./lib.mjs";

const { values: args } = parseArgs({ options: {
  slug: { type: "string" }, out: { type: "string", default: "review-output" }, root: { type: "string", default: "." },
} });
const root = resolve(args.root);
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const replies = [];
const changed = new Set();
const finish = (code = 0) => {
  writeFileSync(join(out, "result.md"), replies.join("\n\n"));
  writeFileSync(join(out, "changed.txt"), [...changed].join("\n"));
  process.exit(code);
};

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.slug ?? "")) { replies.push("This pull request is not a journal draft."); finish(1); }
const articleFile = `web/src/content/articles/${args.slug}.md`;
const imageDir = `web/public/images/blog/${args.slug}`;
if (!existsSync(join(root, articleFile))) { replies.push(`Could not find \`${articleFile}\` on this branch.`); finish(1); }
const { data, body } = readArticle(readFileSync(join(root, articleFile), "utf8"));

const comment = process.env.COMMENT_BODY ?? "";
const lines = comment.split(/\r?\n/).map((l) => l.trim());
const plain = (s, max) => s.length > 0 && s.length <= max && !/[<>\u0000-\u001f]/.test(s);
let failed = false;

// ── /title ──
const titleLine = lines.find((l) => /^\/title\b/i.test(l));
if (titleLine) {
  const value = titleLine.replace(/^\/title\s*/i, "").trim();
  let options = [];
  try { options = JSON.parse(/<!-- title-options: (\[[\s\S]*?\]) -->/.exec(process.env.PR_BODY ?? "")?.[1] ?? "[]"); } catch { /* handled below */ }
  const title = /^[1-9]$/.test(value) ? options[Number(value) - 1] : value;
  if (!title || !plain(title, 120)) {
    replies.push("**Title not changed.** Use `/title 1`, `/title 2`, `/title 3`, or `/title` followed by plain text of 120 characters or fewer.");
    failed = true;
  } else {
    data.title = title;
    replies.push(`**Title set:** ${title}`);
  }
}

// ── /photo ──
if (lines.some((l) => /^\/photo\b/i.test(l))) {
  const field = (name) => lines.find((l) => l.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
  const alt = field("alt"), credit = field("credit"), source = field("source"), link = field("link");
  const problems = [];
  if (!plain(alt, 240)) problems.push("`alt:` describing the photo (240 characters or fewer)");
  if (!plain(credit, 240)) problems.push("`credit:` line (240 characters or fewer)");
  if (!plain(source, 500)) problems.push("`source:` saying where the photo came from and its license");
  let sourceUrl;
  if (link) {
    try { const u = new URL(link); if (u.protocol === "https:" && !u.username && !u.password) sourceUrl = u.href; } catch { /* reported below */ }
    if (!sourceUrl) problems.push("`link:` must be a public https address (or leave it out)");
  }
  const folder = join(root, imageDir);
  const uploads = existsSync(folder)
    ? readdirSync(folder).filter((f) => f !== "cover.jpg" && /\.(jpe?g|png|webp)$/i.test(f))
      .map((f) => ({ f, t: statSync(join(folder, f)).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.f)
    : [];
  if (!uploads.length) problems.push(`a photo uploaded into \`${imageDir}/\` on this branch`);
  if (problems.length) {
    replies.push(`**Photo not applied.** Still needed: ${problems.join("; ")}.`);
    failed = true;
  } else {
    const upload = join(folder, uploads[0]);
    const sharp = createRequire(join(root, "web/package.json"))("sharp");
    const size = statSync(upload).size;
    const meta = await sharp(upload).metadata();
    if (size > 10 * 1024 * 1024) {
      replies.push("**Photo not applied.** The file is larger than 10 MB.");
      failed = true;
    } else if ((meta.width ?? 0) < 1600 || (meta.height ?? 0) < 900) {
      replies.push(`**Photo not applied.** It is ${meta.width} × ${meta.height}; it needs to be at least 1600 × 900.`);
      failed = true;
    } else {
      await sharp(upload).rotate().resize(1600, 900, { fit: "cover", position: "attention" })
        .jpeg({ quality: 80, mozjpeg: true, progressive: true }).toFile(join(folder, "cover.next.jpg"));
      rmSync(join(folder, "cover.jpg"), { force: true });
      writeFileSync(join(folder, "cover.jpg"), readFileSync(join(folder, "cover.next.jpg")));
      rmSync(join(folder, "cover.next.jpg"));
      for (const f of uploads) rmSync(join(folder, f));
      changed.add(imageDir);
      data.image = { src: `/images/blog/${args.slug}/cover.jpg`, alt, width: 1600, height: 900, credit, provenance: source, ...(sourceUrl ? { sourceUrl } : {}) };
      data.draft = false;
      replies.push(`**Photo applied.** Cropped to 1600 × 900 and saved as the cover. Credit: ${credit}. The article is now marked ready and will publish at its planned time once this pull request is merged.`);
    }
  }
}

if (!titleLine && !lines.some((l) => /^\/photo\b/i.test(l))) {
  replies.push("No command found. Use `/title` and/or `/photo`.");
  finish(1);
}
writeFileSync(join(root, articleFile), writeArticle(data, body));
changed.add(articleFile);
finish(failed ? 2 : 0);

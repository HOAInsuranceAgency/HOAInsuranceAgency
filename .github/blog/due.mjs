/**
 * Print "due" when an approved article's publish time fell within the last
 * few hours, so the scheduled rebuild only runs when something goes live.
 *
 *   node .github/blog/due.mjs [--hours 6]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readArticle } from "./lib.mjs";

const { values: args } = parseArgs({ options: { hours: { type: "string", default: "6" }, root: { type: "string", default: "." } } });
const dir = join(args.root, "web/src/content/articles");
const now = Date.now();
const window = Number(args.hours) * 3600_000;
const due = readdirSync(dir).filter((f) => f.endsWith(".md")).flatMap((f) => {
  try {
    const { data } = readArticle(readFileSync(join(dir, f), "utf8"));
    const at = Date.parse(data.publishedAt);
    return !data.draft && at <= now && at > now - window ? [data.slug] : [];
  } catch { return []; }
});
console.log(due.length ? `due ${due.join(" ")}` : "none");

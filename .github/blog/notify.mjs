/**
 * Build an Amazon SES SendEmail input file. Addresses come from the
 * BLOG_EMAIL_FROM and REVIEWER_EMAIL environment variables, which the
 * workflows fill from repository variables.
 *
 *   node .github/blog/notify.mjs draft    --meta blog-output/meta.json --pr-url <url> --upload-url <url> --out email.json
 *   node .github/blog/notify.mjs no-draft --input blog-output/no-draft.json --out email.json
 *   node .github/blog/notify.mjs reminder --input open-drafts.json --out email.json --marked marked.txt
 *
 * Prints "skip" and writes nothing when there is nothing to send or no
 * addresses are configured.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { approvalEmail, noDraftEmail, reminderEmail, sesMessage } from "./lib.mjs";

const { positionals: [kind], values: args } = parseArgs({ allowPositionals: true, options: {
  meta: { type: "string" }, input: { type: "string" }, out: { type: "string" },
  "pr-url": { type: "string" }, "upload-url": { type: "string" }, marked: { type: "string" },
} });
const from = process.env.BLOG_EMAIL_FROM?.trim();
const to = process.env.REVIEWER_EMAIL?.trim();
if (!from || !to) { console.log("skip: sender or reviewer address is not configured"); process.exit(0); }

let message;
if (kind === "draft") {
  const meta = JSON.parse(readFileSync(args.meta, "utf8"));
  message = approvalEmail({ meta, prUrl: args["pr-url"], uploadUrl: args["upload-url"] });
} else if (kind === "no-draft") {
  message = noDraftEmail(JSON.parse(readFileSync(args.input, "utf8")));
} else if (kind === "reminder") {
  // Open drafts older than two days whose last reminder is also two days old.
  const cutoff = Date.now() - 2 * 86400_000;
  const drafts = JSON.parse(readFileSync(args.input, "utf8")).filter((pr) => {
    if (Date.parse(pr.createdAt) > cutoff) return false;
    const last = (pr.comments ?? []).filter((c) => c.body?.includes("<!-- blog-reminder -->")).map((c) => Date.parse(c.createdAt));
    return !last.length || Math.max(...last) <= cutoff;
  }).map((pr) => ({ number: pr.number, title: pr.title.replace(/^Blog draft:\s*/, ""), url: pr.url }));
  if (!drafts.length) { console.log("skip: nothing waiting"); process.exit(0); }
  if (args.marked) writeFileSync(args.marked, drafts.map((d) => `${d.number}\n`).join(""));
  message = reminderEmail(drafts);
} else {
  throw new Error(`Unknown email kind: ${kind}`);
}
writeFileSync(args.out, JSON.stringify(sesMessage({ from, to, ...message }), null, 2));
console.log("ready");

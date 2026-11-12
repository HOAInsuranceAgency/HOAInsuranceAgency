/**
 * Shared rules for the journal automation: the publishing rotation, the
 * article front matter, the editorial checks the site build cannot make, and
 * the approval emails. docs/BLOG-EDITORIAL-GUIDE.md is the source for all of it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { tsImport } from "tsx/esm/api";
import { articleWordCount } from "../../shared/articleText.mjs";

// Load the shared TypeScript catalog on every supported Node 22 release.
const { US_STATE_CATALOG } = await tsImport("../../shared/usStates.ts", import.meta.url);

export const TIME_ZONE = "America/New_York";

/** Each category's own day and time (Eastern). */
export const CATEGORY_SLOTS = {
  "Master Policies": { day: "tue", time: "08:00" },
  "Laws & Compliance": { day: "tue", time: "10:00" },
  "Market & Renewals": { day: "wed", time: "08:00" },
  "Property & Catastrophe": { day: "wed", time: "10:00" },
  "D&O and Crime": { day: "wed", time: "12:00" },
  "Liability & Umbrella": { day: "thu", time: "10:00" },
  "Claims & Risk": { day: "thu", time: "12:00" },
  "Unit Owners (HO-6)": { day: "thu", time: "18:00" },
};

/** Four-week rotation, one article per day. */
export const ROTATION = [
  { tue: "Master Policies", wed: "Property & Catastrophe", thu: "Unit Owners (HO-6)" },
  { tue: "Laws & Compliance", wed: "D&O and Crime", thu: "Claims & Risk" },
  { tue: "Master Policies", wed: "Market & Renewals", thu: "Liability & Umbrella" },
  { tue: "Laws & Compliance", wed: "Property & Catastrophe", thu: "Unit Owners (HO-6)" },
];

const DAY_INDEX = { tue: 2, wed: 3, thu: 4 };
const pad = (n) => String(n).padStart(2, "0");

/** Calendar date (YYYY-MM-DD) of an instant, in Eastern time. */
export function easternDate(instant = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** ISO-8601 week number, used to place a date in the four-week rotation. */
export function isoWeek(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** "-05:00" or "-04:00" for an Eastern wall-clock time on a date. */
export function easternOffset(date, time) {
  const instant = new Date(`${date}T${time}:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(instant).find((p) => p.type === "timeZoneName").value;
  return name === "GMT" ? "+00:00" : name.replace("GMT", "");
}

/**
 * The slot a draft fills. A run drafts for the same weekday one week ahead,
 * so the reviewer has about a week to approve it.
 */
export function planSlot({ runDate = easternDate(), day, targetDate } = {}) {
  let date = targetDate;
  if (!date) {
    const want = DAY_INDEX[day];
    if (!want) throw new Error(`Unknown slot day: ${day}`);
    date = addDays(runDate, 6);
    while (weekday(date) !== want) date = addDays(date, 1);
  }
  const dayKey = Object.keys(DAY_INDEX).find((k) => DAY_INDEX[k] === weekday(date));
  if (!dayKey) throw new Error(`${date} is not a Tuesday, Wednesday or Thursday.`);
  const week = isoWeek(date);
  const weekIndex = week % 4;
  const month = Number(date.slice(5, 7));
  let category = ROTATION[weekIndex][dayKey];
  let seasonal = null;
  // Seasonal swaps stay on the swapped category's own day (Wednesday).
  if (weekIndex === 1 && dayKey === "wed" && month >= 6 && month <= 11) {
    category = "Property & Catastrophe"; seasonal = "Hurricane season";
  } else if (weekIndex === 3 && dayKey === "wed" && month >= 9) {
    category = "Market & Renewals"; seasonal = "Budget and renewal season";
  }
  const { time } = CATEGORY_SLOTS[category];
  const publishedAt = `${date}T${time}:00${easternOffset(date, time)}`;
  const focus = (week + DAY_INDEX[dayKey]) % 2 === 0 ? "national" : "state";
  return { date, day: dayKey, category, time, publishedAt, focus, seasonal, rotationWeek: weekIndex + 1 };
}

export const slugify = (text) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/, "");

/** Pages an article may link to. Every shared state identity has a site route. */
export function internalPages() {
  return [
    "/what-we-do/", "/condo-insurance/", "/why-choose-us/", "/quote/", "/contact/", "/carriers/",
    ...US_STATE_CATALOG.map(({ name }) => `/hoa-insurance-${name.toLowerCase().replaceAll(" ", "-")}/`),
  ];
}

/**
 * The structure rules from the editorial guide. Returns a list of problems;
 * an empty list means the body passes.
 */
export function checkBody(body, { pages = [] } = {}) {
  const problems = [];
  const lines = body.split("\n");
  const first = lines.find((l) => l.trim());
  if (!first?.startsWith("> ")) problems.push("The body must open with a one-paragraph “In brief” blockquote.");
  if (lines.some((l) => /^\s*([-*+]|\d+[.)])\s+/.test(l))) problems.push("Use paragraphs only: remove bullet points and numbered lists.");
  if (lines.some((l) => /^\s*\|/.test(l))) problems.push("Remove tables; explain in paragraphs.");
  if (lines.some((l) => /^#\s/.test(l))) problems.push("Do not use a level-one (#) heading.");
  if (/<[a-z!/]/i.test(body)) problems.push("Remove HTML.");
  if (/!\[/.test(body)) problems.push("Remove inline images.");
  const sections = body.split(/^#{2,3}\s.*$/m).slice(1);
  if (sections.length < 3) problems.push("Use at least three ## section headings.");
  sections.forEach((section, i) => {
    const paragraphs = section.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length > 4) problems.push(`Section ${i + 1} has ${paragraphs.length} paragraphs; the limit is 4.`);
  });
  const words = articleWordCount(body);
  if (words < 1050 || words > 1950) problems.push(`The body has ${words} words; aim for 1,100–1,900 (the site requires 1,000–2,000).`);
  const links = [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const internal = links.filter((u) => u.startsWith("/"));
  const unknown = internal.filter((u) => !pages.includes(u.split("#")[0]));
  if (unknown.length) problems.push(`These site links do not exist: ${unknown.join(", ")}.`);
  if (new Set(internal).size < 2) problems.push("Link to at least two different service pages.");
  if (links.some((u) => !u.startsWith("/") && !u.startsWith("https://") && !u.startsWith("#"))) {
    problems.push("Links must be https:// or a site path.");
  }
  return problems;
}

/** Front matter is written as JSON, which the site's YAML reader accepts. */
export function writeArticle(data, body) {
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n${body.trim()}\n`;
}

export function readArticle(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)(?:\r?\n)?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("Article front matter is missing.");
  // Native Astro articles accept YAML, including JSON as a YAML subset.
  const data = parse(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Article front matter must be an object.");
  return { data, body: match[2] };
}

/** Titles of everything already published or queued, for de-duplication. */
export function existingTitles(root) {
  const dir = join(root, "web/src/content/articles");
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    try { return readArticle(readFileSync(join(dir, f), "utf8")).data.title; } catch { return f.slice(0, -3); }
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Amazon SES v2 SendEmail input. Addresses come from repository variables. */
export function sesMessage({ from, to, subject, text, html }) {
  return {
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Simple: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
    } },
  };
}

const longDate = (iso) => new Intl.DateTimeFormat("en-US", {
  weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE,
}).format(new Date(iso)) + " ET";

/** The approval email sent for every new draft. */
export function approvalEmail({ meta, prUrl, uploadUrl }) {
  const subject = `Approval needed: “${meta.titleOptions[0]}” · publishes ${longDate(meta.publishedAt)}`;
  const rows = [
    ["Category", meta.category], ["Focus", meta.focus === "state" && meta.state ? `State · ${meta.state}` : "National"],
    ["Target search phrase", meta.searchPhrase], ["Why now", meta.whyNow],
    ["Length", `${meta.words.toLocaleString("en-US")} words · ${meta.sources.length} sources, all opened and checked`],
    ["Planned publish", longDate(meta.publishedAt)],
  ];
  const photo = [
    "Landscape (wide) photo, at least 1600 × 900 pixels, JPG, PNG or WebP, under 10 MB.",
    "A real photo that fits the topic. No carrier logos, and no recognizable faces without permission.",
    "A one-line credit, e.g. “Photo: HOA Insurance Agency” or “Photo: Jane Doe / Unsplash”.",
    "Where it came from: your own photo, or the stock site and license.",
    "Short alt text describing the image for screen readers.",
  ];
  const steps = [
    `Read the draft and open the sources: ${prUrl}`,
    `Upload the photo to the draft: ${uploadUrl}`,
    "Comment on the draft with the photo details and your title choice (example below).",
    "When the check passes, approve and merge. The article goes live at its planned time.",
  ];
  const example = "/title 1\n/photo\nalt: Condominium building exterior on a clear day\ncredit: Photo: HOA Insurance Agency\nsource: Agency photo, all rights held";
  const text = [
    "A new article is ready for your review.", "",
    ...rows.map(([k, v]) => `${k}: ${v}`), "",
    "Pick a title (or write your own with /title followed by the text):",
    ...meta.titleOptions.map((t, i) => `  ${i + 1}. ${t}`), "",
    `Fact check: ${meta.factCheck}`, "",
    "Cover photo needed:", ...photo.map((p) => `  · ${p}`), "",
    "How to approve:", ...steps.map((s, i) => `  ${i + 1}. ${s}`), "",
    "Example comment:", example, "",
    "Nothing publishes until the photo is added and the draft is merged. You'll get a reminder after 2 days.",
  ].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:640px;line-height:1.55">
<p>A new article is ready for your review.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">${rows.map(([k, v]) => `<tr><th style="text-align:left;padding:6px 10px;background:#f1f5f9;border:1px solid #e2e8f0;width:38%">${escapeHtml(k)}</th><td style="padding:6px 10px;border:1px solid #e2e8f0">${escapeHtml(v)}</td></tr>`).join("")}</table>
<p><strong>Pick a title</strong> (or write your own with <code>/title</code> followed by the text):</p>
<ol>${meta.titleOptions.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ol>
<p><strong>Fact check:</strong> ${escapeHtml(meta.factCheck)}</p>
<p><strong>Cover photo needed.</strong></p><ul>${photo.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
<p><a href="${escapeHtml(prUrl)}" style="display:inline-block;background:#2b6cb0;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Review the draft</a>
&nbsp;<a href="${escapeHtml(uploadUrl)}" style="display:inline-block;border:1px solid #cbd5e1;color:#1a365d;padding:10px 16px;border-radius:6px;text-decoration:none">Upload the photo</a></p>
<p>Then comment on the draft with the photo details and your title choice:</p>
<pre style="background:#f8fafc;border:1px solid #e2e8f0;padding:10px;font-size:13px">${escapeHtml(example)}</pre>
<p style="font-size:12.5px;color:#64748b">Nothing publishes until the photo is added and the draft is merged. You'll get a reminder after 2 days.</p></div>`;
  return { subject, text, html };
}

/** Sent when a run could not verify enough facts to draft anything. */
export function noDraftEmail({ slot, reason }) {
  const subject = `No draft this run: ${slot.category} · ${slot.date}`;
  const text = `The automation could not produce a verified draft for ${slot.category} (${slot.date}).\n\nReason: ${reason}\n\nThe next run will try again. You can also start one manually from the "Blog drafts" workflow in GitHub Actions.`;
  return { subject, text, html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` };
}

/** One reminder listing every draft waiting more than two days. */
export function reminderEmail(drafts) {
  const subject = drafts.length === 1 ? `Reminder: “${drafts[0].title}” is waiting for approval` : `Reminder: ${drafts.length} articles are waiting for approval`;
  const text = ["These drafts are waiting for your review:", "", ...drafts.map((d) => `· ${d.title}\n  ${d.url}`), "",
    "Each needs a cover photo (/photo comment) and approval before it publishes."].join("\n");
  const html = `<p>These drafts are waiting for your review:</p><ul>${drafts.map((d) => `<li><a href="${escapeHtml(d.url)}">${escapeHtml(d.title)}</a></li>`).join("")}</ul><p>Each needs a cover photo (<code>/photo</code> comment) and approval before it publishes.</p>`;
  return { subject, text, html };
}

/** A temporary branded cover so the site's image checks pass on the draft. */
export function coverSvg(category) {
  const label = escapeHtml(category.toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#132a4a"/><stop offset="1" stop-color="#23477a"/></linearGradient>
<pattern id="p" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" fill="none" stroke="#ffffff" stroke-opacity=".05" stroke-width="2"/></pattern></defs>
<rect width="1600" height="900" fill="url(#g)"/><rect width="1600" height="900" fill="url(#p)"/>
<rect x="120" y="380" width="80" height="6" fill="#e5c16a"/>
<text x="120" y="460" font-family="DejaVu Sans, Arial, sans-serif" font-size="44" font-weight="700" letter-spacing="6" fill="#e5c16a">${label}</text>
<text x="120" y="530" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" fill="#ffffff" fill-opacity=".8">The ProtectMyHOA Journal</text>
</svg>`;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  CATEGORY_SLOTS, ROTATION, approvalEmail, articleWordCount, checkBody, coverSvg, easternOffset,
  planSlot, readArticle, sesMessage, slugify, writeArticle,
} from "./lib.mjs";

test("every rotation slot sits on its category's own day", () => {
  for (const week of ROTATION) {
    for (const [day, category] of Object.entries(week)) assert.equal(CATEGORY_SLOTS[category].day, day, category);
  }
});

test("all eight categories appear in the rotation", () => {
  const used = new Set(ROTATION.flatMap((w) => Object.values(w)));
  assert.deepEqual([...used].sort(), Object.keys(CATEGORY_SLOTS).sort());
});

test("a Monday run drafts for the Tuesday a week later", () => {
  const slot = planSlot({ runDate: "2027-01-04", day: "tue" });
  assert.equal(slot.date, "2027-01-12");
  assert.equal(slot.day, "tue");
});

test("publish times carry the right Eastern offset", () => {
  assert.equal(easternOffset("2027-01-12", "08:00"), "-05:00");
  assert.equal(easternOffset("2027-07-13", "08:00"), "-04:00");
  const slot = planSlot({ targetDate: "2027-07-15" });
  assert.match(slot.publishedAt, /^2027-07-15T\d\d:00:00-04:00$/);
  assert.equal(slot.time, CATEGORY_SLOTS[slot.category].time);
});

test("seasonal swaps stay on Wednesday", () => {
  // Find a Wednesday in rotation week 2 during hurricane season.
  for (let d = 1; d <= 31; d++) {
    const date = `2027-07-${String(d).padStart(2, "0")}`;
    if (new Date(`${date}T12:00:00Z`).getUTCDay() !== 3) continue;
    const slot = planSlot({ targetDate: date });
    if (slot.rotationWeek === 2) {
      assert.equal(slot.category, "Property & Catastrophe");
      assert.equal(slot.seasonal, "Hurricane season");
    }
  }
  assert.throws(() => planSlot({ targetDate: "2027-01-11" }), /not a Tuesday/);
});

test("word count matches the site's counting", () => {
  assert.equal(articleWordCount("See [the page](/what-we-do/) now."), 4);
  assert.equal(articleWordCount("HO-6 owner’s policy"), 3);
});

const paragraph = "Boards should confirm the policy form before renewal so owners know what the association insures and what they must insure themselves. ".repeat(4).trim();
const section = (title) => `## ${title}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
const goodBody = `> ${paragraph}\n\n${["One", "Two", "Three", "Four", "Five"].map(section).join("\n\n")}\n\nSee [HOA Insurance](/what-we-do/) and [condo coverage](/condo-insurance/).`;
const pages = ["/what-we-do/", "/condo-insurance/"];

test("a well-formed body passes", () => {
  assert.deepEqual(checkBody(goodBody, { pages }), []);
});

test("lists, tables, HTML and unknown links are caught", () => {
  const bad = `${goodBody}\n\n- a bullet\n\n| a | b |\n\n<div>x</div>\n\n[x](/nowhere/)`;
  const problems = checkBody(bad, { pages }).join(" ");
  assert.match(problems, /bullet points/);
  assert.match(problems, /tables/);
  assert.match(problems, /HTML/);
  assert.match(problems, /\/nowhere\//);
});

test("more than four paragraphs in a section is caught", () => {
  const long = goodBody.replace("## One\n\n", `## One\n\n${paragraph}\n\n${paragraph}\n\n`);
  assert.match(checkBody(long, { pages }).join(" "), /paragraphs; the limit is 4/);
});

test("a body without the In brief opening is caught", () => {
  assert.match(checkBody(goodBody.slice(2), { pages }).join(" "), /In brief/);
});

test("front matter round-trips as JSON", () => {
  const data = { slug: "a-b", title: "T", draft: true };
  assert.deepEqual(readArticle(writeArticle(data, "Body text")), { data, body: "Body text\n" });
});

test("slugs are clean", () => {
  assert.equal(slugify("D&O for HOA Boards: What's Covered?"), "d-and-o-for-hoa-boards-what-s-covered");
});

test("emails escape model text", () => {
  const meta = { titleOptions: ["<b>One</b>", "Two", "Three"], publishedAt: "2027-01-12T08:00:00-05:00", category: "Master Policies",
    focus: "national", state: null, searchPhrase: "x", whyNow: "y", words: 1200, sources: [{}], factCheck: "ok" };
  const email = approvalEmail({ meta, prUrl: "https://github.com/o/r/pull/1", uploadUrl: "https://github.com/o/r/upload/b/p" });
  assert.doesNotMatch(email.html, /<b>One<\/b>/);
  assert.match(email.html, /&lt;b&gt;One/);
  const ses = sesMessage({ from: "a@example.com", to: "b@example.com", ...email });
  assert.deepEqual(ses.Destination.ToAddresses, ["b@example.com"]);
  assert.doesNotMatch(coverSvg("A & <B>"), /<B>/);
});

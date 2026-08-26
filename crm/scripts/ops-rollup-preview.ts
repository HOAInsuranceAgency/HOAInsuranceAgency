/**
 * Render one ops-rollup email from invented fixture data.
 *
 * The email is the product here, and an email you cannot look at is a design
 * you are guessing at. This builds a plausible Tuesday for a small habitational
 * agency, runs the real detectors, the real rollup and the real renderer over
 * it, and writes the HTML and the plain text out so both can be read.
 *
 * Every association, person and figure below is made up. Nothing touches a
 * data client and nothing is sent anywhere except, if ANTHROPIC_API_KEY is
 * set, the opening paragraph's prompt — which carries only these fixtures.
 *
 *   npx tsx scripts/ops-rollup-preview.ts [outDir]
 */
import { writeFileSync } from "node:fs";
import { buildFindings, type DetectInputs } from "../amplify/functions/ops-rollup/detect";
import { buildDone, type DoneInputs } from "../amplify/functions/ops-rollup/done";
import { buildProgress } from "../amplify/functions/ops-rollup/progress";
import { writeRead } from "../amplify/functions/ops-rollup/read";
import { renderRollup } from "../amplify/functions/ops-rollup/render";
import { editionFor, etMidnight } from "../amplify/functions/ops-rollup/window";

const NOW = new Date("2026-08-25T11:20:00Z"); // Tuesday, 07:20 Eastern
const edition = editionFor(NOW);
const YESTERDAY = "2026-08-24T18:30:00Z";

const leads = [
  { id: "l1", name: "Willow Bend Homeowners Association", createdAt: "2026-08-19T14:00:00Z" },
  { id: "l2", name: "Cedar Court Condominium Trust", createdAt: "2026-08-22T09:00:00Z" },
  { id: "l3", name: "Anchor Landing Association", createdAt: "2026-08-24T16:00:00Z" },
];

const clients = [
  { id: "c1", name: "Maple Ridge Condominium" },
  { id: "c2", name: "Harbour Point Association" },
  { id: "c3", name: "Brookline Gardens Condominium" },
  { id: "c4", name: "Stonegate Village" },
  { id: "c5", name: "Lakeview Estates Association" },
  { id: "c6", name: "Birchwood Commons" },
];

const carriers = [
  { id: "k1", name: "Travelers" },
  { id: "k2", name: "Community Association Underwriters" },
];

/**
 * One policy set feeds three modules whose input shapes differ — `detect` does
 * not read `commissionPct`, `progress` does — so this is typed as the union of
 * what they need rather than as any one of them.
 */
const policies: (DetectInputs["policies"][number] & { commissionPct?: number })[] = [
  // Bound yesterday — the win.
  {
    id: "p1",
    accountId: "c1",
    status: "ACTIVE",
    expirationDate: "2027-08-24",
    premium: 41200,
    carrierId: "k1",
    billType: "AGENCY",
    datePolicyBound: YESTERDAY,
  },
  // Expired eleven days ago with nothing marketed — the coverage gap.
  {
    id: "p2",
    accountId: "c2",
    status: "ACTIVE",
    expirationDate: "2026-08-14",
    premium: 63800,
    carrierId: "k2",
    billType: "AGENCY",
    datePolicyBound: "2025-08-14T12:00:00Z",
  },
  // Bound a fortnight ago, agency bill, never invoiced.
  {
    id: "p3",
    accountId: "c6",
    status: "ACTIVE",
    expirationDate: "2027-08-10",
    premium: 31000,
    carrierId: "k1",
    billType: "AGENCY",
    datePolicyBound: "2026-08-06T12:00:00Z",
  },
  // Renews in five weeks, nothing started.
  {
    id: "p4",
    accountId: "c5",
    status: "ACTIVE",
    expirationDate: "2026-09-29",
    premium: 42100,
    carrierId: "k2",
    billType: "DIRECT",
    datePolicyBound: "2025-09-29T12:00:00Z",
  },
  { id: "p5", accountId: "c3", status: "ACTIVE", expirationDate: "2027-02-01", premium: 28400, billType: "AGENCY", datePolicyBound: "2026-02-01T12:00:00Z" },
  { id: "p6", accountId: "c4", status: "ACTIVE", expirationDate: "2027-04-11", premium: 19750, billType: "AGENCY", datePolicyBound: "2026-04-11T12:00:00Z" },
  // Earlier this month, for the month-to-date figure.
  { id: "p7", accountId: "c3", status: "ACTIVE", expirationDate: "2027-08-04", premium: 55600, commissionPct: 12, billType: "DIRECT", datePolicyBound: "2026-08-04T12:00:00Z" },
  // Last month, same span, for the comparison.
  { id: "p8", accountId: "c4", status: "ACTIVE", expirationDate: "2027-07-08", premium: 47000, commissionPct: 12, billType: "DIRECT", datePolicyBound: "2026-07-08T12:00:00Z" },
  { id: "p9", accountId: "c5", status: "ACTIVE", expirationDate: "2027-07-19", premium: 38900, commissionPct: 12, billType: "DIRECT", datePolicyBound: "2026-07-19T12:00:00Z" },
];

const quotes: DetectInputs["quotes"] = [
  { id: "q1", accountId: "c1", status: "BOUND", premium: 41200, createdAt: "2026-07-02T12:00:00Z", updatedAt: YESTERDAY },
  // Sitting with an underwriter for a fortnight.
  { id: "q2", accountId: "c6", status: "SUBMITTED", premium: 58000, effectiveDate: "2026-10-01", createdAt: "2026-07-28T12:00:00Z", updatedAt: "2026-08-05T12:00:00Z" },
  // We hold a number and nobody has taken it back to the board.
  { id: "q3", accountId: "c4", status: "PRESENTED", premium: 34500, effectiveDate: "2026-09-15", createdAt: "2026-07-15T12:00:00Z", updatedAt: "2026-08-11T12:00:00Z" },
  { id: "q4", accountId: "l1", status: "QUOTED", premium: 12900, effectiveDate: "2026-09-20", createdAt: "2026-08-20T12:00:00Z", updatedAt: "2026-08-24T12:00:00Z" },
  // Effective date passed with the quote still open.
  { id: "q5", accountId: "c5", status: "PRESENTED", premium: 26700, effectiveDate: "2026-08-18", createdAt: "2026-07-01T12:00:00Z", updatedAt: "2026-08-14T12:00:00Z" },
  // Lost yesterday.
  { id: "q6", accountId: "c3", status: "DECLINED", premium: 21000, createdAt: "2026-07-10T12:00:00Z", updatedAt: YESTERDAY },
  { id: "q7", accountId: "c2", status: "LOST", premium: 15400, createdAt: "2025-06-02T12:00:00Z", updatedAt: "2026-08-01T12:00:00Z" },
];

const invoices: DetectInputs["invoices"] = [
  { id: "i1", accountId: "c4", number: "INV-2026-00142", status: "SENT", dueAt: "2026-07-22", policyId: "p6", stripeLinkAmountCents: 1_840_000 },
  { id: "i2", accountId: "c3", number: "INV-2026-00151", status: "SENT", dueAt: "2026-08-12", policyId: "p5", stripeLinkAmountCents: 340_000 },
  { id: "i3", accountId: "c5", number: "INV-2026-00155", status: "SENT", dueAt: "2026-08-11", stripeLinkAmountCents: 180_000 },
  { id: "i4", accountId: "c1", number: "INV-2026-00160", status: "SENT", dueAt: "2026-09-07", policyId: "p1", stripeLinkAmountCents: 4_120_000 },
  { id: "i5", accountId: "c6", number: "INV-2026-00161", status: "PAID", dueAt: "2026-08-20", stripeLinkAmountCents: 1_940_000 },
];

const tasks: DetectInputs["tasks"] = [
  { accountId: "c2", accountName: "Harbour Point Association", carrierName: "Travelers", status: "OPEN", submitBy: "2026-07-15", expirationDate: "2026-08-14" },
  { accountId: "c2", accountName: "Harbour Point Association", carrierName: "CAU", status: "OPEN", submitBy: "2026-07-15", expirationDate: "2026-08-14" },
  { accountId: "c6", accountName: "Birchwood Commons", carrierName: "Travelers", status: "COMPLETE", submitBy: "2026-09-01", expirationDate: "2026-10-01", resolution: "QUOTED" },
];

const detectInputs: DetectInputs = {
  leads,
  clients,
  policies,
  quotes,
  invoices,
  tasks,
  loans: [],
  notices: [],
  leadReplies: [
    { accountId: "l2", status: "FAILED", submittedAt: "2026-08-22T09:00:00Z", dueAt: "2026-08-22T09:08:00Z" },
  ],
  licenses: [],
  premiumFinanceEnabled: false,
};

const doneInputs: DoneInputs = {
  activity: [
    ...Array.from({ length: 6 }, (_, i) => ({ actor: "sub-greasley", entityId: `c${(i % 4) + 1}`, occurredAt: YESTERDAY })),
    { actor: "sub-greasley", entityId: "c1", subjectType: "Quote", occurredAt: YESTERDAY, changes: JSON.stringify([{ field: "status" }]) },
    { actor: "sub-greasley", entityId: "c1", subjectType: "Policy", action: "CREATE", occurredAt: YESTERDAY },
    ...Array.from({ length: 5 }, (_, i) => ({ actor: "sub-chen", entityId: `c${(i % 5) + 1}`, occurredAt: YESTERDAY })),
    { actor: "sub-chen", entityId: "c3", subjectType: "Quote", occurredAt: YESTERDAY, changes: JSON.stringify([{ field: "status" }]) },
    ...Array.from({ length: 3 }, (_, i) => ({ actor: "sub-whitfield", entityId: `l${i + 1}`, occurredAt: YESTERDAY })),
    ...Array.from({ length: 28 }, (_, i) => ({ actor: "send-invoice", entityId: `c${(i % 6) + 1}`, occurredAt: YESTERDAY })),
    // Trailing fortnight, for the 10-day column.
    ...Array.from({ length: 22 }, (_, i) => ({ actor: "sub-greasley", entityId: `t${i}`, occurredAt: "2026-08-18T12:00:00Z" })),
    ...Array.from({ length: 26 }, (_, i) => ({ actor: "sub-chen", entityId: `u${i}`, occurredAt: "2026-08-19T12:00:00Z" })),
    ...Array.from({ length: 9 }, (_, i) => ({ actor: "sub-whitfield", entityId: `v${i}`, occurredAt: "2026-08-17T12:00:00Z" })),
  ],
  profiles: [
    { userId: "sub-chen", firstName: "Sarah", lastName: "Chen", role: "PRODUCER" },
    { userId: "sub-greasley", firstName: "Jake", lastName: "Greasley", role: "ADMIN" },
    { userId: "sub-whitfield", firstName: "Dana", lastName: "Whitfield", role: "PRODUCER" },
  ],
  policies,
  accounts: [...leads, ...clients],
  certificates: [{ issuedAt: YESTERDAY }, { issuedAt: YESTERDAY }, { issuedAt: YESTERDAY }],
  invoices: [
    ...invoices.map((i) => ({ ...i, sentAt: undefined, paidAt: undefined })),
    { sentAt: YESTERDAY, stripeLinkAmountCents: 4_120_000 },
    { sentAt: YESTERDAY, stripeLinkAmountCents: 1_100_000 },
    { paidAt: "2026-08-24", stripeLinkAmountCents: 1_940_000 },
  ],
  tasks: [
    { completedAt: YESTERDAY, completedBy: "Sarah Chen", resolution: "QUOTED" },
    { completedAt: YESTERDAY, completedBy: "Sarah Chen", resolution: "QUOTED" },
    { completedAt: YESTERDAY, completedBy: "Jake Greasley", resolution: "OUT_OF_APPETITE" },
  ],
  loanPayments: [],
  loans: [],
  carriers,
  premiumFinanceEnabled: false,
};

async function main() {
  const findings = buildFindings(detectInputs, edition);
  const done = buildDone(doneInputs, edition, etMidnight("2026-08-11").getTime());
  const progress = buildProgress(
    { policies, quotes, accounts: [...leads.map((l) => ({ ...l, stage: "LEAD" })), ...clients.map((c) => ({ ...c, stage: "CLIENT" }))], carriers },
    edition.todayDay,
    edition.windowStartDay
  );

  const visible = findings.filter((f) => f.visibility === "row");
  const read = await writeRead({
    covering: edition.covering,
    exposed: visible.filter((f) => f.band === "exposed").map((f) => ({ subject: f.subject, clause: f.clause, amount: f.amount })),
    closing: visible.filter((f) => f.band === "closing").map((f) => ({ subject: f.subject, clause: f.clause, amount: f.amount })),
    money: visible.filter((f) => f.band === "money").map((f) => ({ subject: f.subject, clause: f.clause, amount: f.amount })),
    standingCounts: findings.filter((f) => f.visibility === "standing").reduce<Record<string, number>>((a, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {}),
    done: { ...done.summary, people: done.people.length },
    progress: { ...progress },
  });

  const out = renderRollup({
    edition,
    findings,
    done,
    progress,
    read: read.text,
    reads: {
      "activity rows": doneInputs.activity.length,
      invoices: invoices.length,
      quotes: quotes.length,
      "open tasks": tasks.filter((t) => t.status === "OPEN").length,
    },
    truncated: false,
    baseUrl: "https://crm.protectmyhoa.com",
  });

  const dir = process.argv[2] ?? ".";
  writeFileSync(`${dir}/ops-rollup-preview.html`, out.html);
  writeFileSync(`${dir}/ops-rollup-preview.txt`, `Subject: ${out.subject}\n\n${out.text}\n`);
  console.log(`subject: ${out.subject}`);
  console.log(`read: ${read.skipped ?? "written by the model"}`);
  console.log(`findings: ${findings.length} (${visible.length} shown)`);
  console.log(`\n${out.text}\n`);
}

void main();

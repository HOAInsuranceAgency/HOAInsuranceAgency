import { quoteCoverage, scopeLegacyQuotes } from "../../../../shared/renewalPolicy";
import { get, issue } from "../communications/store";
import { resolveIssue } from "../communications/routing";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import type { MarketingTaskSource } from "../../../src/lib/enums";
import { guideFits, summarizeLosses } from "../../../src/lib/appetite";

/**
 * Daily renewal-marketing sweep. See resource.ts for the why.
 *
 * Two passes, both idempotent so a re-run (or a retry) is harmless:
 *   1. RAISE    — one task per (expiring risk × appetite-matched carrier)
 *                 once today >= expiration − leadTime − 14.
 *   2. SETTLE   — close open tasks that a quote has since satisfied.
 */

const HEAD_START_DAYS = 14;
const DEFAULT_LEAD_TIME_DAYS = 30;

let dataClient: ReturnType<typeof generateClient<Schema>> | undefined;
async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};

interface Risk {
  sourceType: MarketingTaskSource;
  sourceId: string;
  accountId: string;
  accountName: string;
  expirationDate: string;
  lines: string[];
  policyId?: string;
}

export const handler = async () => {
  const client = await getDataClient();
  const today = isoDay(new Date());

  const [accounts, policies, carriers, guides, rawQuotes, tasks, losses, priorCoverage] =
    await Promise.all([
      // `.list()` caps at 100 — every read here must cover the whole table.
      listAllPages((nextToken) => client.models.Account.list({ nextToken, limit: 200 })),
      listAllPages((nextToken) => client.models.Policy.list({ nextToken, limit: 200 })),
      listAllPages((nextToken) => client.models.Carrier.list({ nextToken, limit: 200 })),
      listAllPages((nextToken) =>
        client.models.AppetiteGuide.list({ nextToken, limit: 200 })
      ),
      listAllPages((nextToken) => client.models.Quote.list({ nextToken, limit: 200 })),
      listAllPages((nextToken) =>
        client.models.MarketingTask.list({ nextToken, limit: 200 })
      ),
      // Read for the guides' loss restrictions. A carrier that caps losses
      // gets no task for an account over the cap.
      listAllPages((nextToken) => client.models.Loss.list({ nextToken, limit: 200 })),
      listAllPages((nextToken) => client.models.PriorCarrier.list({ nextToken, limit: 200 })),
    ]);

  const { quotes } = scopeLegacyQuotes(rawQuotes, policies);
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  // Summarised once per account rather than per (risk × carrier × guide):
  // the sweep's inner loop runs over every appointed carrier for every
  // expiring risk, and the five-year window does not move inside a run.
  // Bucketed in one pass rather than filtering the loss table per account,
  // which is the same quadratic this whole handler pages its reads to avoid.
  const lossRowsByAccount = new Map<string, (typeof losses)[number][]>();
  for (const l of losses) {
    const bucket = lossRowsByAccount.get(l.accountId);
    if (bucket) bucket.push(l);
    else lossRowsByAccount.set(l.accountId, [l]);
  }
  const lossesByAccount = new Map(
    accounts.map((a) => [
      a.id,
      summarizeLosses(lossRowsByAccount.get(a.id) ?? [], today),
    ])
  );

  const appointed = carriers.filter((c) => c.appointed);

  // ── Build the list of expiring risks ────────────────────────────────
  const risks: Risk[] = [];

  // Clients renew off their bound policies. `currentPolicyExpiration` is a
  // lead-only field and is deliberately ignored once an account converts.
  for (const p of policies) {
    if (p.status !== "ACTIVE" || !p.expirationDate) continue;
    const acct = accountById.get(p.accountId);
    if (!acct || acct.stage !== "CLIENT") continue;
    risks.push({
      sourceType: "POLICY",
      sourceId: p.id,
      accountId: acct.id,
      accountName: acct.name,
      expirationDate: p.expirationDate,
      lines: (p.lines ?? []).filter((l): l is string => !!l),
      policyId: p.id,
    });
  }

  for (const a of accounts) {
    // Prospects have no bound policy, so their incumbent's expiration is the
    // only renewal date available.
    if (a.stage !== "LEAD" || !a.currentPolicyExpiration) continue;
    risks.push({
      sourceType: "LEAD",
      sourceId: a.id,
      accountId: a.id,
      accountName: a.name,
      expirationDate: a.currentPolicyExpiration,
      lines: [...new Set([...priorCoverage.filter(p => p.accountId === a.id && p.expirationDate === a.currentPolicyExpiration && p.lineOfBusiness).map(p => p.lineOfBusiness!), ...quotes.filter(q => q.accountId === a.id && q.effectiveDate === a.currentPolicyExpiration).flatMap(q => (q.lines ?? []).filter((l): l is string => !!l))])],
    });
  }

  /** Lead time: guide matching this risk → carrier's longest → default. */
  function leadTimeFor(carrierId: string, matchedGuideDays: number | null): number {
    if (matchedGuideDays != null) return matchedGuideDays;
    const days = guides
      .filter((g) => g.carrierId === carrierId && g.quoteSubmissionLeadTimeDays != null)
      .map((g) => g.quoteSubmissionLeadTimeDays as number);
    return days.length ? Math.max(...days) : DEFAULT_LEAD_TIME_DAYS;
  }

  /**
   * The account's underwriting facts, in the shape `guideFits` reads. The
   * rules themselves live in `src/lib/appetite.ts` — shared with the Appetite
   * Finder, which is the whole point: this used to be a second copy of them
   * annotated "Mirrors the Appetite Finder", and mirrors drift.
   *
   * `paperType` is left unset on purpose. Admitted and E&S are both places a
   * renewal can legitimately go, and a nightly job has no business preferring
   * one; the filter exists for a human at the Finder.
   */
  function riskFacts(risk: Risk) {
    const acct = accountById.get(risk.accountId);
    if (!acct) return null;
    const lossSummary = lossesByAccount.get(acct.id);
    return {
      state: acct.state,
      totalInsuredValue: acct.totalInsuredValue,
      yearBuilt: acct.yearBuilt,
      coastal: acct.coastal,
      milesToCoast: acct.milesToCoast,
      rentalPct: acct.rentalPct,
      lossCount: lossSummary?.count ?? null,
      lossIncurred: lossSummary?.incurred ?? null,
      lines: risk.lines,
    };
  }

  const existingKeys = new Set(tasks.map((t) => t.dedupeKey));
  const quotedFor = (accountId: string, carrierId: string, term: string, lines: string[], policyId?: string | null) =>
    quoteCoverage(quotes, { accountId, carrierId, term, lines, policyId: policyId ?? undefined }, today).complete;

  // ── Pass 1: raise tasks ─────────────────────────────────────────────
  let created = 0;
  let skippedAlreadyQuoted = 0;

  for (const risk of risks) {
    const wf = await get<{ disposition?: string; deferredUntil?: string }>(`workflow:${risk.accountId}`);
    if (risk.sourceType === "LEAD" && (wf?.data.disposition && wf.data.disposition !== "ACTIVE" || wf?.data.deferredUntil && wf.data.deferredUntil > new Date().toISOString())) continue;
    // Lapsed and unmatched risks remain owned placement exceptions.
    if (risk.expirationDate < today) await issue(`expired-marketing:${risk.sourceId}:${risk.expirationDate}`, "The marketing term has expired. Review replacement coverage with the champion.", risk.accountId);

    const facts = riskFacts(risk);
    if (!facts) { await issue(`marketing-facts:${risk.sourceId}`, "Underwriting facts need review before placement", risk.accountId); continue; }
    let matches = 0;

    for (const carrier of appointed) {
      const carrierGuides = guides.filter((g) => g.carrierId === carrier.id);
      const matching = carrierGuides.filter((g) => guideFits(g, carrier, facts));
      // Appetite-matched only: a carrier with no matching guide is skipped.
      if (matching.length === 0) continue;
      matches++;

      const matchedDays = matching
        .map((g) => g.quoteSubmissionLeadTimeDays)
        .filter((d): d is number => d != null);
      const leadTime = leadTimeFor(
        carrier.id,
        matchedDays.length ? Math.max(...matchedDays) : null
      );

      const submitBy = addDays(risk.expirationDate, -leadTime);
      const triggerDate = addDays(submitBy, -HEAD_START_DAYS);
      if (today < triggerDate) continue; // window not open yet

      const dedupeKey = `${risk.sourceType}:${risk.sourceId}:${carrier.id}:${risk.expirationDate}`;
      if (existingKeys.has(dedupeKey)) continue;

      if (quotedFor(risk.accountId, carrier.id, risk.expirationDate, risk.lines, risk.policyId)) {
        skippedAlreadyQuoted++;
        existingKeys.add(dedupeKey);
        continue;
      }

      const { errors } = await client.models.MarketingTask.create({
        id: `marketing:${dedupeKey}`,
        accountId: risk.accountId,
        carrierId: carrier.id,
        policyId: risk.policyId,
        sourceType: risk.sourceType,
        dedupeKey,
        accountName: risk.accountName,
        carrierName: carrier.name,
        lines: risk.lines,
        expirationDate: risk.expirationDate,
        leadTimeDays: leadTime,
        submitBy,
        triggerDate,
        status: "OPEN",
      });
      if (!errors?.length) {
        created++;
        existingKeys.add(dedupeKey);
      } else {
        await issue(`marketing-create:${dedupeKey}`, "Carrier submission work could not be scheduled; it will retry", risk.accountId);
        throw new Error(errors[0].message);
      }
    }
    if (!matches && today >= addDays(risk.expirationDate, -90)) await issue(`placement:${risk.sourceId}:${risk.expirationDate}`, "No appointed carrier currently matches this risk. The champion must review placement.", risk.accountId);
    else await resolveIssue(`placement:${risk.sourceId}:${risk.expirationDate}`);
  }

  // ── Pass 2: settle tasks a quote has satisfied ──────────────────────
  let completed = 0;
  for (const t of tasks) {
    if (t.sourceType === "LEAD") {
      const w = await get<{ disposition?: string; deferredAt?: string; deferredExpiration?: string }>(`workflow:${t.accountId}`);
      if (w?.data.deferredAt && t.expirationDate !== w.data.deferredExpiration && t.createdAt <= w.data.deferredAt && t.status === "OPEN") {
        const changed = await client.models.MarketingTask.update({ id: t.id, status: "COMPLETE", resolution: "SUPERSEDED", completedAt: w.data.deferredAt, completedBy: "system (recorded next-year decision)" });
        if (changed.errors?.length) throw new Error("Could not retire the prior marketing cycle");
        continue;
      }
    }
    const covered = quotedFor(t.accountId, t.carrierId, t.expirationDate ?? "", (t.lines ?? []).filter((l): l is string => !!l), t.policyId);
    if (t.status === "COMPLETE" && t.resolution === "QUOTED" && !covered) {
      const result = await client.models.MarketingTask.update({ id: t.id, status: "OPEN", resolution: null, completedAt: null, completedBy: null });
      if (result.errors?.length) throw new Error("Could not repair quote coverage for marketing work");
      continue;
    }
    if (t.status !== "OPEN" || !covered) continue;
    const { errors } = await client.models.MarketingTask.update({
      id: t.id,
      status: "COMPLETE",
      resolution: "QUOTED",
      completedAt: new Date().toISOString(),
      completedBy: "system (usable quote verified)",
    });
    if (!errors?.length) completed++;
  }

  const summary = {
    risksReviewed: risks.length,
    appointedCarriers: appointed.length,
    tasksCreated: created,
    tasksAutoCompleted: completed,
    skippedAlreadyQuoted,
  };
  console.log("renewal-tasks sweep", JSON.stringify(summary));
  return summary;
};

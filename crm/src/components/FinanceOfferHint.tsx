import { useMemo, useState } from "react";
import { client, listAllPages, type Account } from "../lib/client";
import type { Schema } from "../../amplify/data/resource";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useIsAdmin } from "../lib/auth";
import { SaveStatus, useSaveStatus } from "./SaveStatus";
import {
  aprCapViolation,
  hasCurrentOpinion,
  jurisdictionFor,
  minPrincipalViolation,
  originationGate,
} from "../lib/premiumFinance/gate";
import { evaluateEligibility } from "../lib/premiumFinance/eligibility";
import {
  buildQuote,
  PF_DEFAULT_APR,
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
} from "../lib/premiumFinance/quote";
import { formatMoney } from "../lib/invoiceTotals";

type PfLoan = Schema["PfLoan"]["type"];
type PfOverride = Schema["PfOverride"]["type"];

/**
 * What the send will do about financing, said before the send does it.
 *
 * W8 made origination automatic — fixed terms, at send, through the server's
 * gates — which makes this hint the only origination surface a producer sees.
 * Everything here is advisory rendering of the same pure modules the send
 * Lambda runs; the server re-decides all of it, and its answer wins. The
 * gate keys off the association's PHYSICAL address state (Account.state,
 * the ACORD premises field), never a mailing address.
 *
 * The auditable screen's ADMIN override lives here too, inline, because the
 * screen it unblocks is displayed here and nowhere else now.
 */

export interface HintAnchor {
  kind: "policy" | "quote";
  id: string;
  lines: readonly (string | null | undefined)[];
  producerOfRecord: boolean | null | undefined;
  isAuditable: boolean | null | undefined;
}

export function FinanceOfferHint({
  account,
  anchor,
  retailTotal,
}: {
  account: Account;
  anchor: HintAnchor;
  retailTotal: number;
}) {
  const isAdmin = useIsAdmin();
  const overrideStatus = useSaveStatus({ autoClearMs: 4000 });
  const [overrideReason, setOverrideReason] = useState("");

  const j = useMemo(() => jurisdictionFor(account.state), [account.state]);
  const res = useAsyncResource(
    async () => {
      const [opinions, loans, overrides] = await Promise.all([
        j?.status === "conditional"
          ? client.models.PfCounselOpinion.list({
              filter: { jurisdiction: { eq: j.code } },
              limit: 100,
            }).then((r) =>
              hasCurrentOpinion(
                r.data.map((o) => ({ effectiveAt: o.effectiveAt, reviewBy: o.reviewBy })),
                new Date().toISOString().slice(0, 10)
              )
            )
          : Promise.resolve(true),
        listAllPages((nextToken) =>
          client.models.PfLoan.list({
            filter:
              anchor.kind === "policy"
                ? { policyId: { eq: anchor.id } }
                : { quoteId: { eq: anchor.id } },
            nextToken,
          })
        ),
        // PfOverride.policyId carries the ANCHOR id — policy or quote.
        listAllPages((nextToken) =>
          client.models.PfOverride.list({
            filter: { policyId: { eq: anchor.id } },
            nextToken,
          })
        ),
      ]);
      return {
        hasOpinion: opinions,
        loans: loans as PfLoan[],
        overrides: overrides as PfOverride[],
      };
    },
    [anchor.id, anchor.kind, j?.code, j?.status],
    { initialData: null, errorMessage: "Couldn't check financing." }
  );

  async function recordAuditableOverride() {
    if (!overrideReason.trim()) return;
    await overrideStatus.run(
      async () => {
        const { errors } = await client.models.PfOverride.create({
          policyId: anchor.id,
          check: "AUDITABLE",
          reason: overrideReason.trim(),
          occurredAt: new Date().toISOString(),
        });
        if (errors?.length) throw new Error(errors[0].message);
        setOverrideReason("");
        await res.refetch();
        return "Override recorded.";
      },
      { errorMessage: "Couldn't record the override." }
    );
  }

  if (!res.loaded || !res.data) {
    return res.error ? <p className="muted small">{res.error}</p> : null;
  }
  const { hasOpinion, loans, overrides } = res.data;

  // Money already touched a loan on this anchor: the choice was made.
  if (loans.some((l) => ["ACCEPTED", "ACTIVE", "DEFAULTED", "PAID"].includes(l.status))) {
    return (
      <p className="muted small">
        Financing is already set up for this premium — the email offers
        pay-in-full only.
      </p>
    );
  }

  const gate = originationGate(account.state, { hasCurrentCounselOpinion: hasOpinion === true });
  if (!gate.open) {
    return (
      <p className="muted small">
        Financing won't be offered: {gate.reason}
      </p>
    );
  }

  const auditableOverride = overrides.find(
    (o) => o.check === "AUDITABLE" && o.reason?.trim()
  );
  const checks = evaluateEligibility({
    lines: anchor.lines,
    accountType: account.type,
    producerOfRecord: anchor.producerOfRecord,
    isAuditable: anchor.isAuditable,
    requiresIncorporatedBorrower: gate.jurisdiction.requiresIncorporatedBorrower ?? false,
    incorporated: account.incorporated,
    jurisdictionName: gate.jurisdiction.name,
    overrides: auditableOverride ? { auditable: { reason: auditableOverride.reason } } : undefined,
  });
  const failed = checks.filter((c) => !c.ok);
  // The override waives a KNOWN auditable exposure — it has no effect on an
  // unrecorded flag (the evaluator honors it only when isAuditable is
  // true), so offering it there would record a permanent row that unblocks
  // nothing. Unrecorded means go answer the question.
  const auditableBlocking =
    anchor.isAuditable === true && failed.some((c) => c.check === "auditable");

  if (failed.length > 0) {
    return (
      <>
        <p className="muted small">
          Financing won't be offered with this email — the bill still sends:
        </p>
        <ul className="warn-list">
          {failed.map((c) => (
            <li key={c.check}>{c.reason}</li>
          ))}
        </ul>
        {isAdmin && auditableBlocking && (
          <div className="inline-actions">
            <div className="field full">
              <label htmlFor="pf-hint-ov">
                Admin override — auditable screen (written reason, permanent)
              </label>
              <textarea
                id="pf-hint-ov"
                rows={2}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="secondary"
              disabled={!overrideReason.trim() || overrideStatus.busy}
              onClick={() => void recordAuditableOverride()}
            >
              Record override
            </button>
            <SaveStatus {...overrideStatus.status} />
          </div>
        )}
      </>
    );
  }

  if (retailTotal <= 0) {
    return (
      <p className="muted small">
        Financing will be offered once the invoice has a total — the offer
        finances exactly what is billed.
      </p>
    );
  }

  // The standing QUOTED offer, or the terms the send will originate at. Both
  // are the same fixed product; the distinction is whether a re-price will
  // supersede an existing quote.
  const standing = [...loans]
    .filter((l) => l.status === "QUOTED")
    .sort((a, b) => (b.quotedAt ?? "").localeCompare(a.quotedAt ?? ""))[0];
  const preview = buildQuote({
    premium: retailTotal,
    downPct: PF_DEFAULT_DOWN_PCT,
    months: PF_DEFAULT_MONTHS,
    apr: PF_DEFAULT_APR,
    effectiveDate: new Date().toISOString().slice(0, 10),
  });
  // The two term gates the eligibility screens don't cover — the same
  // helpers the server runs, on the same built quote.
  const termProblem =
    aprCapViolation(PF_DEFAULT_APR, gate.jurisdiction, preview) ??
    minPrincipalViolation(preview.amountFinanced, gate.jurisdiction);
  if (termProblem) {
    return (
      <p className="muted small">Financing won't be offered: {termProblem}</p>
    );
  }
  return (
    <p className="muted small">
      The email offers pay-in-full and financing side by side:{" "}
      {formatMoney(preview.downPayment)} down (payment 1 of {PF_DEFAULT_MONTHS + 1}),
      then {PF_DEFAULT_MONTHS} monthly payments of {formatMoney(preview.payment)} at{" "}
      {PF_DEFAULT_APR}% APR.
      {standing && standing.premium !== retailTotal
        ? " The standing offer was quoted at a different total and will be re-issued at this one when sent."
        : ""}
    </p>
  );
}

export default FinanceOfferHint;

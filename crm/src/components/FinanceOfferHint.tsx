import { useMemo } from "react";
import { client, listAllPages, type Account } from "../lib/client";
import type { Schema } from "../../amplify/data/resource";
import { useAsyncResource } from "../lib/useAsyncResource";
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
 * No override machinery lives here (or anywhere): the two screens that had
 * one — MEP and auditable — both retired 2026-08-24, and every screen that
 * remains blocks on a fact only confirming can fix.
 */

export interface HintAnchor {
  kind: "policy" | "quote";
  id: string;
  lines: readonly (string | null | undefined)[];
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
  const j = useMemo(() => jurisdictionFor(account.state), [account.state]);
  const res = useAsyncResource(
    async () => {
      const [opinions, loans] = await Promise.all([
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
      ]);
      return { hasOpinion: opinions, loans: loans as PfLoan[] };
    },
    [anchor.id, anchor.kind, j?.code, j?.status],
    { initialData: null, errorMessage: "Couldn't check financing." }
  );

  if (!res.loaded || !res.data) {
    return res.error ? <p className="muted small">{res.error}</p> : null;
  }
  const { hasOpinion, loans } = res.data;

  // Money already touched a loan on this anchor: the choice was made.
  if (loans.some((l) => ["ACCEPTED", "ACTIVE", "DEFAULTED", "PAID"].includes(l.status))) {
    return (
      <div className="offer-banner">
        <strong>Financing is already set up for this premium</strong> — the
        email offers pay-in-full only.
      </div>
    );
  }

  const gate = originationGate(account.state, { hasCurrentCounselOpinion: hasOpinion === true });
  if (!gate.open) {
    return (
      <div className="offer-banner blocked">
        <strong>Financing won't be offered with this email</strong> — the bill
        still sends:
        <ul>
          <li>{gate.reason}</li>
        </ul>
      </div>
    );
  }

  const checks = evaluateEligibility({
    lines: anchor.lines,
    accountType: account.type,
    requiresIncorporatedBorrower: gate.jurisdiction.requiresIncorporatedBorrower ?? false,
    incorporated: account.incorporated,
    jurisdictionName: gate.jurisdiction.name,
  });
  const failed = checks.filter((c) => !c.ok);

  if (failed.length > 0) {
    return (
      <div className="offer-banner blocked">
        <strong>Financing won't be offered with this email</strong> — the bill
        still sends:
        <ul>
          {failed.map((c) => (
            <li key={c.check}>{c.reason}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (retailTotal <= 0) {
    return (
      <div className="offer-banner blocked">
        <strong>Financing won't be offered yet</strong> — the invoice has no
        total, and the offer finances exactly what is billed. Price the lines
        first.
      </div>
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
      <div className="offer-banner blocked">
        <strong>Financing won't be offered with this email</strong> — the bill
        still sends:
        <ul>
          <li>{termProblem}</li>
        </ul>
      </div>
    );
  }
  return (
    <div className="offer-banner">
      <strong>Financing will be offered</strong> beside pay-in-full:{" "}
      {formatMoney(preview.downPayment)} down (payment 1 of {PF_DEFAULT_MONTHS + 1}),
      then {PF_DEFAULT_MONTHS} monthly payments of {formatMoney(preview.payment)} at{" "}
      {PF_DEFAULT_APR}% APR.
      {standing && standing.premium !== retailTotal
        ? " The standing offer was quoted at a different total and will be re-issued at this one when sent."
        : ""}
    </div>
  );
}

export default FinanceOfferHint;

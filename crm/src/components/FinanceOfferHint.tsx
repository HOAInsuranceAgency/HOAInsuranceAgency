import { Button } from "./ui/Button";
import { useMemo } from "react";
import { client, type Account } from "../lib/client";
import { listAllPages } from "../../../shared/pagination";
import type { Schema } from "../../amplify/data/resource";
import { useAsyncResource } from "../lib/useAsyncResource";
import {
  hasCurrentOpinion,
  jurisdictionFor,
  minPrincipalViolation,
  originationGate,
} from "../../../shared/premiumFinance/gate";
import { evaluateEligibility } from "../../../shared/premiumFinance/eligibility";
import {
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
} from "../../../shared/premiumFinance/quote";
import { financePricing, financeRateDates } from "../../../shared/premiumFinance/pricing";
import { formatMoney } from "../../../shared/invoiceTotals";
import { usStateCode } from "../../../shared/usStates";

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
  coverageEffectiveDate?: string | null;
}

export function FinanceOfferHint({
  account,
  anchor,
  retailTotal,
  brokerFee = 0,
}: {
  account: Account;
  anchor: HintAnchor;
  retailTotal: number;
  brokerFee?: number;
}) {
  const j = useMemo(() => jurisdictionFor(account.state), [account.state]);
  const res = useAsyncResource(
    async () => {
      const [opinions, loans] = await Promise.all([
        j?.status === "conditional"
          ? listAllPages(nextToken => client.models.PfCounselOpinion.list({
              filter: { jurisdiction: { eq: j.code } },
              nextToken,
            })).then((opinions) =>
              hasCurrentOpinion(
                opinions.map((o) => ({ effectiveAt: o.effectiveAt, reviewBy: o.reviewBy })),
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
    { initialData: null, errorMessage: "Couldn't check financing." , live: true }
  );

  if (res.error) return <p className="muted small">{res.error} <Button type="button" disabled={res.loading} onClick={() => void res.refetch()}>Retry financing check</Button></p>;
  if (!res.loaded || !res.data) return null;
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

  const standing = [...loans]
    .filter((l) => l.status === "QUOTED")
    .sort((a, b) => (b.quotedAt ?? "").localeCompare(a.quotedAt ?? ""))[0];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const committed = !!standing && !!(standing.agreementSignedAt || standing.electedAt || standing.downPaymentIntentId ||
    (standing.electionCheckoutUrl && standing.electionCheckoutExpiresAt && standing.electionCheckoutExpiresAt > now.toISOString()));
  const coverageChanged = standing?.coverageEffectiveDate && standing.coverageEffectiveDate !== anchor.coverageEffectiveDate;
  const matching = standing && standing.premium === retailTotal &&
    usStateCode(standing.state) === usStateCode(account.state) &&
    (standing.brokerFeeCents ?? 0) === Math.round(brokerFee * 100) && !coverageChanged;
  const committedOffer = committed && matching ? standing : null;

  const gate = originationGate(account.state, { hasCurrentCounselOpinion: hasOpinion === true });
  if (!committedOffer && !gate.open) {
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

  const checks = !committedOffer && gate.open ? evaluateEligibility({
    lines: anchor.lines,
    accountType: account.type,
    requiresIncorporatedBorrower: gate.jurisdiction.requiresIncorporatedBorrower ?? false,
    incorporated: account.incorporated,
    jurisdictionName: gate.jurisdiction.name,
  }) : [];
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

  // Signed terms stay frozen. An unsigned offer must still fit today's
  // ceiling before it can be reused or replaced by the send.
  const rateDates = gate.open ? financeRateDates(gate.jurisdiction, now) : [];
  const needsReplacement = !!standing && !committed && (!matching || (standing.effectiveDate ?? today) < today ||
    (gate.open && gate.jurisdiction.maxAddOnApr !== null && !standing.coverageEffectiveDate));
  const standingPricing = standing && !committed && !needsReplacement && gate.open ? financePricing(gate.jurisdiction, {
    premium: standing.premium,
    downPct: standing.downPct,
    months: standing.months,
    effectiveDate: standing.effectiveDate,
    coverageEffectiveDate: anchor.coverageEffectiveDate,
  }, rateDates) : null;
  const preserved = committedOffer ?? (standing && !needsReplacement &&
    standingPricing && standing.apr <= standingPricing.apr ? standing : null);
  const pricing = preserved || committed || (standing && !needsReplacement && !standingPricing) || !gate.open ? null : financePricing(gate.jurisdiction, {
    premium: retailTotal,
    downPct: PF_DEFAULT_DOWN_PCT,
    months: PF_DEFAULT_MONTHS,
    effectiveDate: today,
    coverageEffectiveDate: anchor.coverageEffectiveDate,
  }, rateDates);
  const preview = preserved ?? pricing?.quote;
  const apr = preserved?.apr ?? pricing?.apr;
  const months = preserved?.months ?? PF_DEFAULT_MONTHS;
  if (!preview || apr === undefined) {
    return (
      <div className="offer-banner blocked">
        <strong>Financing won't be offered with this email</strong> — the bill
        still sends.
      </div>
    );
  }
  const termProblem = !committedOffer && gate.open ? minPrincipalViolation(preview.amountFinanced, gate.jurisdiction) : null;
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
      {formatMoney(preview.downPayment)} down (payment 1 of {months + 1}){brokerFee > 0 ? ` plus the ${formatMoney(brokerFee)} broker fee paid in full upfront` : ""},
      then {months} monthly payments of {formatMoney(preview.payment)} at{" "}
      {apr}% APR.
      {standing && standing.premium !== retailTotal
        ? " The standing offer was quoted at a different total and will be re-issued at this one when sent."
        : ""}
    </div>
  );
}

export default FinanceOfferHint;

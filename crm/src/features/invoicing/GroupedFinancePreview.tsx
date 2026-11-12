import type { ReactNode } from "react";
import { financeableInvoiceTotal, formatMoney } from "../../../../shared/invoiceTotals";
import { listAllPages } from "../../../../shared/pagination";
import { evaluateEligibility } from "../../../../shared/premiumFinance/eligibility";
import { hasCurrentOpinion, jurisdictionFor, minPrincipalViolation, originationGate } from "../../../../shared/premiumFinance/gate";
import { initialPaymentTotals } from "../../../../shared/premiumFinance/initialPayment";
import { financePricing, financeRateDates } from "../../../../shared/premiumFinance/pricing";
import { PF_DEFAULT_DOWN_PCT, PF_DEFAULT_MONTHS } from "../../../../shared/premiumFinance/quote";
import { Button } from "../../components/ui/Button";
import { Table } from "../../components/ui/Table";
import { client, fmtDate, type Account, type Invoice, type InvoiceLine, type Policy } from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { policyTermKey } from "./groupedInvoiceDrafts";
import { policyLabel } from "./invoiceInputs";

export function GroupedFinancePreview({ invoice, account, policies, lines, children }: {
  invoice: Invoice;
  account: Account | null;
  policies: readonly Policy[];
  lines: readonly InvoiceLine[];
  children?: ReactNode;
}) {
  const ids = invoice.groupedPolicyIds ?? [];
  const term = policies[0] && policyTermKey(policies[0]);
  const completeMembership = ids.length >= 2 && ids.length <= 8 && new Set(ids).size === ids.length &&
    policies.length === ids.length && policies.every(policy => ids.includes(policy.id) && policy.status === "ACTIVE" && policy.billType === "AGENCY");
  const commonTerm = term && policies.every(policy => policyTermKey(policy) === term);
  const completePremiums = policies.every(policy => {
    const premiums = lines.filter(line => line.policyId === policy.id && line.kind === "PREMIUM");
    return premiums.length === 1 && (premiums[0]?.retailAmount ?? 0) > 0;
  });
  const memberLines = lines.every(line => line.policyId && ids.includes(line.policyId) && line.kind !== "BROKER_FEE");
  const coverageEffectiveDate = policies[0]?.effectiveDate;
  const ready = completeMembership && commonTerm && completePremiums && memberLines && account && coverageEffectiveDate;
  return <div className="card inset">
    <h3>Combined financing preview</h3>
    <p className="muted small">Financing-only invoice</p>
    {ready
      ? <GroupedFinanceTerms account={account} policies={policies} coverageEffectiveDate={coverageEffectiveDate}
        premium={financeableInvoiceTotal(lines)}>{children}</GroupedFinanceTerms>
      : <p className="warn-inline">The account, policy term and premium lines are needed to calculate the payment schedule.</p>}
  </div>;
}

function GroupedFinanceTerms({ account, policies, coverageEffectiveDate, premium, children }: {
  account: Account;
  policies: readonly Policy[];
  coverageEffectiveDate: string;
  premium: number;
  children?: ReactNode;
}) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const jurisdiction = jurisdictionFor(account.state);
  const opinion = useAsyncResource(async () => {
    if (jurisdiction?.status !== "conditional") return true;
    const opinions = await listAllPages(nextToken => client.models.PfCounselOpinion.list({
      filter: { jurisdiction: { eq: jurisdiction.code } }, nextToken,
    }));
    return hasCurrentOpinion(opinions.map(row => ({ effectiveAt: row.effectiveAt, reviewBy: row.reviewBy })), today);
  }, [jurisdiction?.code, today], { initialData: null, errorMessage: "Couldn't check financing.", live: true });

  const opinionError = opinion.error || opinion.refreshError;
  if (opinionError) return <p className="error-text">{opinionError} <Button type="button" disabled={opinion.loading}
    onClick={() => void opinion.refetch()}>Retry financing check</Button></p>;
  if (!opinion.loaded) return <p className="muted small">Checking financing…</p>;
  const gate = originationGate(account.state, { hasCurrentCounselOpinion: opinion.data === true });
  if (!gate.open) return <p className="warn-inline">{gate.reason}</p>;

  const failures = policies.flatMap(policy => evaluateEligibility({
    lines: policy.lines ?? [],
    accountType: account.type,
    requiresIncorporatedBorrower: gate.jurisdiction.requiresIncorporatedBorrower ?? false,
    incorporated: account.incorporated,
    jurisdictionName: gate.jurisdiction.name,
  }).filter(check => !check.ok).map(check => ({ policy, check })));
  if (failures.length) return <ul className="warn-list">
    {failures.map(({ policy, check }) => <li key={`${policy.id}:${check.check}`}>{policyLabel(policy)} — {check.reason}</li>)}
  </ul>;

  const pricing = financePricing(gate.jurisdiction, {
    premium,
    downPct: PF_DEFAULT_DOWN_PCT,
    months: PF_DEFAULT_MONTHS,
    effectiveDate: today,
    coverageEffectiveDate,
  }, financeRateDates(gate.jurisdiction, now));
  if (!pricing) return <p className="warn-inline">Financing is unavailable for this combined draft.</p>;
  const { quote, apr } = pricing;
  const principalProblem = minPrincipalViolation(quote.amountFinanced, gate.jurisdiction);
  if (principalProblem) return <p className="warn-inline">{principalProblem}</p>;
  const initial = initialPaymentTotals(quote);
  const finalPayment = quote.schedule.at(-1)?.payment;

  return <>
    <p><strong>{formatMoney(initial.totalCents / 100)} initial payment</strong> ({formatMoney(initial.premiumCents / 100)} down plus {formatMoney(initial.originationFeeCents / 100)} origination fee).</p>
    {finalPayment !== undefined && finalPayment !== quote.payment
      ? <p>{PF_DEFAULT_MONTHS} monthly payments at {apr}% APR. The first {PF_DEFAULT_MONTHS - 1} are {formatMoney(quote.payment)} each and the final payment is {formatMoney(finalPayment)}.</p>
      : <p>{PF_DEFAULT_MONTHS} monthly payments of {formatMoney(quote.payment)} at {apr}% APR.</p>}
    <details>
      <summary>Payment schedule</summary>
      <Table aria-label="Combined payment schedule">
        <thead><tr><th>Payment</th><th>Due</th><th className="num">Amount</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>{fmtDate(today)}</td><td className="num">{formatMoney(initial.totalCents / 100)}</td></tr>
          {quote.schedule.map(row => <tr key={row.n}><td>{row.n + 1}</td><td>{fmtDate(row.dueDate)}</td><td className="num">{formatMoney(row.payment)}</td></tr>)}
        </tbody>
      </Table>
    </details>
    {children}
  </>;
}

/**
 * Premium finance quote arithmetic. Pure, and the only place it happens —
 * the invoiceTotals.ts convention, so the calculator the producer sees and
 * the issuance Lambda that validates run identical numbers.
 *
 * ── The method, and the methods this must never become ─────────────────────
 * Simple interest on the DECLINING BALANCE, compounded monthly, level payment
 * `pmt = P·r / (1 − (1+r)^−n)`. Not add-on. Not the Rule of 78s — that method
 * must not appear anywhere in this module or this codebase, and a test greps
 * for it. Prepayment refunds by the actuarial method: the borrower owes the
 * outstanding principal, and every cent of scheduled interest beyond it is
 * unearned and never collected.
 *
 * ── No late anything ────────────────────────────────────────────────────────
 * No late fees, no delinquency charges, no reinstatement fees — the fields do
 * not exist, deliberately. They are per-state regulated charges needing their
 * own design pass; building the columns first is how they get filled in.
 */

/**
 * Terms per the signed decision (2026-08-23): 25% down REQUIRED, collected up
 * front as payment 1 of 12, with the remainder financed over the other 11
 * months — one payment per month of the policy year. The down payment is a
 * floor, not a default someone can type under: `downPctViolation` enforces it
 * in the UI and the origination Lambda rejects beneath it.
 */
export const PF_MIN_DOWN_PCT = 25;
export const PF_DEFAULT_DOWN_PCT = 25;
export const PF_DEFAULT_MONTHS = 11;

/** Null = acceptable. The floor exists because MEP screens assume a real
 * collateral cushion at inception; below 25% the whole model thins. */
export function downPctViolation(downPct: number): string | null {
  if (!Number.isFinite(downPct) || downPct < PF_MIN_DOWN_PCT) {
    return `The down payment must be at least ${PF_MIN_DOWN_PCT}% — it is payment 1 of the schedule, collected at inception.`;
  }
  if (downPct >= 100) return "A 100% down payment is not a loan.";
  return null;
}
/**
 * 14.0 everywhere, whatever the jurisdiction's cap (decision E). The cap is a
 * ceiling, not a target: nothing may ever default an APR to it, and the UI
 * never displays it as a suggestion — pricing to the statutory maximum in
 * every state is how multi-state lenders get caught, and the market rate for
 * $17k–$35k accounts is below most caps anyway.
 */
export const PF_DEFAULT_APR = 14.0;

/**
 * Flat, per-agreement, refundable on prepayment. $10 is at or under the lowest
 * per-agreement cap in the country (Alaska and Connecticut), so it is safe in
 * every jurisdiction without a per-state table.
 */
export const PF_ORIGINATION_FEE = 10.0;

export interface QuoteInputs {
  /** Total policy premium, dollars. */
  premium: number;
  /** Down payment percent, e.g. 25. */
  downPct: number;
  /** Number of monthly installments. */
  months: number;
  /** Annual percentage rate, e.g. 14.0. */
  apr: number;
  /** ISO day the loan begins; installment n is due n months later. */
  effectiveDate: string;
}

export interface ScheduleRow {
  n: number;
  dueDate: string;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

export interface PfQuote {
  downPayment: number;
  amountFinanced: number;
  monthlyRate: number;
  /** The level payment, to the cent. The final row may differ by cents. */
  payment: number;
  schedule: ScheduleRow[];
  totalInterest: number;
  totalOfPayments: number;
  originationFee: number;
  /**
   * Mean of the twelve monthly OPENING balances across a 12-month policy
   * year, months (n+1)..12 at zero.
   *
   * ⚠️ This definition is load-bearing — do not "correct" it. Closing
   * balances, or averaging over the 9 loan months instead of the 12 policy
   * months, produce different figures and break the signed test vector
   * ($317,332 on the $1M/25%/9mo/14% case). Confirmed as the intended
   * convention 2026-08-21.
   */
  averageOutstanding12Mo: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * ISO day + n calendar months, clamped to the destination month's end and
 * computed in UTC — `new Date("2026-01-31")` shifted naively lands on
 * March 2/3, and a machine west of Greenwich would date everything a day
 * early. Same reasoning as addDays in InvoicesTab.
 */
export function addMonthsClamped(isoDay: string, months: number): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  const targetMonth = m - 1 + months;
  const first = new Date(Date.UTC(y, targetMonth, 1));
  const daysInTarget = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
  ).getUTCDate();
  first.setUTCDate(Math.min(d, daysInTarget));
  return first.toISOString().slice(0, 10);
}

export function buildQuote(inputs: QuoteInputs): PfQuote {
  const { premium, downPct, months, apr, effectiveDate } = inputs;
  const downPayment = round2(premium * (downPct / 100));
  const amountFinanced = round2(premium - downPayment);
  const r = apr / 100 / 12;

  const exact =
    r === 0
      ? amountFinanced / months
      : (amountFinanced * r) / (1 - Math.pow(1 + r, -months));
  const payment = round2(exact);

  /**
   * Cent-rounded schedule whose interest column sums to the EXACT total.
   *
   * Rounding each row's interest independently accumulates drift — on the
   * signed $1M/25%/9mo/14% case it lands one cent high (44,426.50 against the
   * exact 44,426.49), which crosses the dollar-rounding boundary and breaks
   * the signed vector. So interest rounds by cumulative remainder: each row
   * shows round2(exact-cumulative) minus what the earlier rows already
   * showed, which telescopes to round2(exact total) no matter the term. Each
   * row still satisfies payment = interest + principal, principal telescopes
   * to the amount financed, and the final payment clears the balance to zero
   * — a schedule that adds up to itself in every direction a treasurer might
   * add it.
   */
  const schedule: ScheduleRow[] = [];
  let balance = amountFinanced;
  let exactBalance = amountFinanced;
  let cumInterestExact = 0;
  let cumInterestShown = 0;
  for (let n = 1; n <= months; n++) {
    const interestExact = exactBalance * r;
    cumInterestExact += interestExact;
    exactBalance -= exact - interestExact;

    const interest = round2(round2(cumInterestExact) - cumInterestShown);
    cumInterestShown = round2(cumInterestShown + interest);

    const pay = n < months ? payment : round2(balance + interest);
    const principal = round2(pay - interest);
    balance = round2(balance - principal);
    schedule.push({
      n,
      dueDate: addMonthsClamped(effectiveDate, n),
      payment: pay,
      interest,
      principal,
      balance,
    });
  }

  const totalInterest = round2(schedule.reduce((s, row) => s + row.interest, 0));
  const totalOfPayments = round2(schedule.reduce((s, row) => s + row.payment, 0));

  // Opening balance of month k is the closing balance of month k−1.
  let sumOpening = 0;
  for (let k = 1; k <= 12; k++) {
    if (k === 1) sumOpening += amountFinanced;
    else if (k <= months) sumOpening += schedule[k - 2].balance;
    // months (n+1)..12 contribute zero — the loan is paid off.
  }

  return {
    downPayment,
    amountFinanced,
    monthlyRate: r,
    payment,
    schedule,
    totalInterest,
    totalOfPayments,
    originationFee: PF_ORIGINATION_FEE,
    averageOutstanding12Mo: round2(sumOpening / 12),
  };
}

export interface PayoffQuote {
  /** What the borrower owes to close the loan after payment k. */
  payoffAmount: number;
  /** Scheduled interest never collected — the actuarial refund framing. */
  unearnedInterest: number;
  /** The flat fee comes back in full on any prepayment. */
  originationFeeRefund: number;
}

/**
 * Payoff immediately after installment k has posted.
 *
 * Actuarial method, which under declining-balance simple interest is simply:
 * pay the remaining principal, owe nothing else. Interest here is earned only
 * as balances stand outstanding, so the "refund" is interest never charged
 * rather than money returned — plus the origination fee, which does come back.
 */
export function payoffAfterPayment(quote: PfQuote, k: number): PayoffQuote {
  if (!Number.isInteger(k) || k < 0 || k > quote.schedule.length) {
    throw new Error(`no payment ${k} on a ${quote.schedule.length}-month schedule`);
  }
  const balance = k === 0 ? quote.amountFinanced : quote.schedule[k - 1].balance;
  const unearned = round2(
    quote.schedule.slice(k).reduce((s, row) => s + row.interest, 0)
  );
  return {
    payoffAmount: balance,
    unearnedInterest: unearned,
    originationFeeRefund: PF_ORIGINATION_FEE,
  };
}

/**
 * A stored schedule, however many times AWSJSON wrapped it.
 *
 * The loan's schedule is written as JSON.stringify(rows) into an a.json()
 * column, and AWSJSON is itself a JSON string on the wire — so a reader can
 * receive the array, the string, or a string wrapping the string. One parse
 * of the double-wrapped form returns the INNER STRING, and iterating a
 * string yields characters whose .dueDate is undefined — which is how the
 * agreement renderer met pdf-lib's "text must be a string" on staging. The
 * aiExtraction.ts trap, met again where it prices money.
 */
export function parseScheduleJson(raw: unknown): ScheduleRow[] {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return [];
  }
  return Array.isArray(v) ? (v as ScheduleRow[]) : [];
}

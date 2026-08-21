/**
 * Invoice arithmetic. Pure, and the only place it happens.
 *
 * Totals are computed from the lines rather than stored on the invoice. A
 * stored total is a second copy of a number that can drift from the rows under
 * it, and this one would be drifting about money — an invoice whose header says
 * one thing and whose lines add to another is the kind of error a client
 * notices and an agency cannot explain.
 *
 * Dependency-free, like `pagination.ts` and `storageKeys.ts`, so the send-invoice
 * Lambda computes exactly what the screen showed.
 */

/** The fields these functions read off an InvoiceLine. */
export interface LineLike {
  /** What the association pays for this line. */
  retailAmount?: number | null;
  /** What is owed to the carrier for it. Never shown to the insured. */
  costAmount?: number | null;
  kind?: string | null;
}

export interface InvoiceTotals {
  /** What the association owes. The only figure the insured ever sees. */
  retail: number;
  /** What we owe the carrier. */
  cost: number;
  /** Agency revenue on this invoice: retail minus cost. */
  margin: number;
  /**
   * Margin as a share of retail, or null when retail is zero.
   *
   * Null rather than zero, because "no margin" and "nothing billed" are
   * different facts and a zero would render as a real 0% on screen.
   */
  marginPct: number | null;
}

/**
 * Money to the cent, with the floating-point noise removed.
 *
 * Premiums are entered as decimals and `19.99 + 0.01` is famously not `20`.
 * Rounding at each accumulation keeps a fifty-line invoice from ending in a
 * total that is a hundredth of a cent off and prints as `$12,480.010000001`.
 */
const cents = (n: number): number => Math.round(n * 100) / 100;

/** A number, or zero — nulls, undefined, NaN and infinities all read as zero. */
const amount = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

export function invoiceTotals(lines: readonly LineLike[]): InvoiceTotals {
  let retail = 0;
  let cost = 0;
  for (const line of lines) {
    retail = cents(retail + amount(line.retailAmount));
    cost = cents(cost + amount(line.costAmount));
  }
  const margin = cents(retail - cost);
  return {
    retail,
    cost,
    margin,
    marginPct: retail === 0 ? null : cents((margin / retail) * 100),
  };
}

/**
 * Line kinds that are billed at exactly what they cost.
 *
 * Taxes, surplus lines and stamping fees are collected on someone else's behalf
 * and passed straight through. Their margin is zero because it is supposed to
 * be, which is what `marginWarnings` needs to know so it does not flag them.
 */
const PASS_THROUGH = new Set(["TAX", "SURPLUS_LINES", "STAMPING_FEE"]);

export const isPassThrough = (kind: string | null | undefined): boolean =>
  PASS_THROUGH.has(kind ?? "");

/**
 * Things about these lines a producer should look at before sending.
 *
 * Warnings, never blocks. Every one of these is legitimate in some real case —
 * a courtesy rebill at cost, a carrier who charges more than the gross on an
 * endorsement — so the screen says so and lets a person decide. Refusing to
 * send would be wrong more often than it was right.
 */
export function marginWarnings(lines: readonly LineLike[]): string[] {
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const retail = amount(line.retailAmount);
    const cost = amount(line.costAmount);
    const where = `Line ${i + 1}`;
    if (retail < 0 || cost < 0) {
      out.push(`${where} has a negative amount.`);
      continue;
    }
    if (isPassThrough(line.kind)) {
      // Pass-through means pass through: anything else is a typo or a fee being
      // taken on a tax, and one of those is worse than the other.
      if (cents(retail - cost) !== 0) {
        out.push(`${where} is a pass-through but its cost and retail differ.`);
      }
      continue;
    }
    if (retail === 0 && cost === 0) continue;
    /**
     * A cost with nothing billed against it is not an underpriced line, it is
     * an unpriced one — which is exactly how every seeded line starts, since
     * `premiumLineFromPolicy` fills the cost and leaves the amount blank. Said
     * plainly, this is the to-do list for finishing the invoice; folded into
     * "costs more than it bills" it read as an alarm on a brand new draft.
     */
    if (retail === 0) {
      out.push(`${where} has a cost but nothing to bill yet.`);
    } else if (cost > retail) {
      out.push(`${where} costs more than it bills.`);
    } else if (retail > 0 && cost === 0) {
      out.push(`${where} has no cost recorded, so it reads as all margin.`);
    }
  }
  return out;
}

/**
 * Interest on an in-house payment plan. Agency income, but not commission.
 *
 * Its own category because the two are earned differently — one for placing
 * business, the other for lending — and corporate accounting books and reports
 * them separately. Nothing charges it yet; see `InvoiceLineKind` in the schema.
 */
const INTEREST_KINDS = new Set(["INTEREST"]);

/** How a collected payment divides, in whole cents. */
export interface RemittanceSplit {
  /** Owed onward to the carrier. Not the agency's money at any point. */
  carrierCents: number;
  /** Earned for placing the business. */
  commissionCents: number;
  /** Earned for financing it. Zero until in-house financing is offered. */
  interestCents: number;
  /** What the association paid. Always the sum of the three above. */
  totalCents: number;
}

/**
 * Split a payment into what must go to the carrier and what the agency keeps.
 *
 * ── Why this exists ──
 * Money paid on an invoice lands in the trust account as one figure, and almost
 * none of it is revenue: most is premium owed onward. Corporate finance cannot
 * reconcile the account from a bank line reading $27,500, and the CRM is the
 * only system that knows the division. This is the number that gets emailed to
 * them when a payment clears.
 *
 * ── How it divides ──
 * The carrier's share is the cost recorded on every line, which is what the
 * cost column has always meant — including on taxes and stamping fees, which
 * pass through at cost and so contribute nothing to either agency category.
 * Interest is the retail of interest lines. Commission is what is left, so the
 * three sum to the total by construction rather than by three separate
 * arithmetics that could disagree.
 *
 * ── Cents, not dollars ──
 * Because these are compared against `stripeLinkAmountCents` and against each
 * other, and a float that is a hundredth of a cent out reconciles to nothing.
 * `toCents` in `stripeLink.ts` rounds the same way.
 */
export function remittanceSplit(lines: readonly LineLike[]): RemittanceSplit {
  const totals = invoiceTotals(lines);
  const cents = (n: number) => Math.round(n * 100);

  const totalCents = cents(totals.retail);
  const carrierCents = cents(totals.cost);
  const interestCents = lines
    .filter((l) => INTEREST_KINDS.has(l.kind ?? ""))
    .reduce((sum, l) => sum + cents(amount(l.retailAmount) - amount(l.costAmount)), 0);

  return {
    carrierCents,
    interestCents,
    // The remainder, so the three always add up to what was charged. Deriving
    // it instead of summing margins is what makes that guarantee hold when a
    // line rounds against the total.
    commissionCents: totalCents - carrierCents - interestCents,
    totalCents,
  };
}

/**
 * Lines whose money belongs to the carrier on a direct-bill policy.
 *
 * Premium and endorsement premium, and nothing else. The pass-throughs are
 * deliberately absent: on a surplus lines placement the agency is often the
 * broker of record for the tax and the stamping fee and does collect and remit
 * them, whoever bills the premium — flagging those would be wrong in exactly
 * the case they most often appear. OTHER is absent for the same reason, since
 * a broker fee is the agency's own charge and is billed direct or not.
 */
const CARRIER_COLLECTED = new Set(["PREMIUM", "ENDORSEMENT"]);

/**
 * The one thing bill type is for, asked at the moment it matters.
 *
 * A direct-bill policy is one the carrier collects the premium on; commission
 * comes back to the agency afterwards. Billing that premium from here asks an
 * association to pay money it is already paying someone else — the kind of
 * error that is only discovered by the person who receives two bills.
 *
 * A warning, not a block, like everything else in this module. A direct-bill
 * policy can legitimately carry an agency invoice — a broker fee, a
 * cancellation adjustment — and those are lines this does not flag. What it
 * flags is premium, which on this policy is not ours to collect.
 *
 * Returns null when there is nothing to say, which includes a policy whose
 * bill type was never recorded: policies bound before that field existed have
 * no answer, and inventing "direct" for them would cry wolf on every old one.
 */
export function directBillWarning(
  billType: string | null | undefined,
  lines: readonly LineLike[]
): string | null {
  if (billType !== "DIRECT") return null;
  const n = lines.filter((l) => CARRIER_COLLECTED.has(l.kind ?? "")).length;
  if (n === 0) return null;
  return `This policy is direct bill — the carrier collects the premium. ${
    n === 1 ? "One line bills" : `${n} lines bill`
  } premium, which the association may already be paying the carrier.`;
}

/**
 * US dollars, for the screen and the emailed invoice.
 *
 * `en-US` explicitly rather than the runtime's locale: a Lambda runs in UTC with
 * no locale of its own, and an invoice that renders as `12 480,01 €` because
 * Node guessed differently is not a formatting bug anyone finds quickly.
 */
export function formatMoney(n: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount(n));
}

/**
 * A premium line, seeded from the policy.
 *
 * The premium goes in the **cost** box and the amount billed is left empty.
 *
 * That is the opposite of what this did, and the change is deliberate. It used
 * to put the gross premium in the amount and derive the cost from
 * `commissionPct`, which meant every seeded line arrived already claiming to
 * know both halves — and a derived cost is a guess: a carrier applies different
 * rates per line, and the remittance is whatever the statement says, not
 * whatever the percentage implies. A producer who trusted the prefill sent
 * invoices whose margin was arithmetic rather than fact.
 *
 * The premium is the one number the policy actually knows, and it is what the
 * agency owes. So it is filled in, and what to bill for it is left blank —
 * which is also the only field the producer has to think about.
 */
export function premiumLineFromPolicy(policy: {
  premium?: number | null;
}): { retailAmount: number | null; costAmount: number | null } {
  const premium = policy.premium;
  if (typeof premium !== "number" || !Number.isFinite(premium)) {
    return { retailAmount: null, costAmount: null };
  }
  return { retailAmount: null, costAmount: cents(premium) };
}

import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";
import { looksLikeElectionToken } from "../pfElectionToken";
import { handler as voidInvoice } from "../void-invoice/handler";
import {
  OWNERSHIP_DISCLOSURE,
  POWER_OF_ATTORNEY,
  PREPAYMENT_TERMS,
  CANCELLATION_PROCEDURE,
} from "../pf-agreement/agreementTerms";

/**
 * The public election endpoint. Dispatched on `info.fieldName` with the
 * upload-portal's discriminator fallback: only an accept carries `accept`.
 *
 * Everything here treats the token as possession, never authority: each call
 * re-reads the loan, the kill switch, and the policy's invoices, and the
 * decisions are made from those reads — the token only says which loan the
 * caller is looking at. Responses are deliberately thin (the association's
 * display name and the offer's own figures; no ids beyond what the page
 * cannot work without, no addresses, no contacts).
 *
 * ── The election's ordering (accept) ────────────────────────────────────────
 * 1. Validate: module on, token unexpired, loan QUOTED — and the agreement
 *    SIGNED (W8): a typed name and role arrive with the accept or nothing
 *    happens. The signature is stamped inside the election transaction, so
 *    no Checkout Session can exist for an unsigned agreement.
 * 2. The anchor's pay-in-full paths close FIRST: a PAID invoice refuses the
 *    election outright, a PROCESSING one refuses until it lands or fails, and
 *    every SENT invoice with a live link is voided through void-invoice's own
 *    handler — the path that already knows the deactivate-before-write order
 *    and loses correctly to a payment racing it.
 * 3. Stamp `electedAt` + agreementSigned* conditionally on the loan still
 *    being QUOTED under this token.
 * 4. Mint the Checkout Session (down payment + off-session mandate) and hand
 *    its URL back. Money moving is what advances the loan — the webhook flips
 *    QUOTED → ACCEPTED when the down payment succeeds, never this handler.
 *
 * Since W8 a loan may anchor to a quote instead of a policy (pre-bind
 * billing); every sibling and invoice scan matches on whichever anchor ids
 * the loan carries, so a bind rollover mid-election cannot open a second
 * payment path.
 */

type DataClient = ReturnType<typeof generateClient<Schema>>;
let dataClient: DataClient | undefined;
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

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

type PfLoan = Schema["PfLoan"]["type"];

const CLOSED = { ok: true, state: "closed" as const, reason: "This financing offer is no longer open. Your agent can issue a fresh one." };

async function moduleEnabled(client: DataClient): Promise<boolean> {
  try {
    const { data } = await client.models.AgencySettings.get({ id: "AGENCY" });
    return data?.premiumFinanceEnabled === true;
  } catch {
    // Fail closed, like PfContext: an unreadable flag offers nothing.
    return false;
  }
}

async function loanForToken(client: DataClient, token: unknown): Promise<PfLoan | null> {
  if (!looksLikeElectionToken(token)) return null;
  const { data } = await client.models.PfLoan.listPfLoanByElectionToken({
    electionToken: token,
  });
  return (data?.[0] as PfLoan | undefined) ?? null;
}

function tokenExpired(loan: PfLoan): boolean {
  return (
    !loan.electionTokenExpiresAt ||
    new Date(loan.electionTokenExpiresAt).getTime() < Date.now()
  );
}

/**
 * Siblings and invoices are matched on every anchor id the loan carries —
 * policy, quote, or (after a bind rollover) both. One list filter, built
 * once, so no scan can disagree about what "this premium" means.
 */
function anchorFilter(loan: PfLoan): Record<string, unknown> | null {
  const legs: Record<string, unknown>[] = [];
  if (loan.policyId) legs.push({ policyId: { eq: loan.policyId } });
  if (loan.quoteId) legs.push({ quoteId: { eq: loan.quoteId } });
  if (!legs.length) return null;
  return legs.length === 1 ? legs[0] : { or: legs };
}

/** The offer's own figures, and nothing else the page can't work without. */
function termsShape(loan: PfLoan, associationName: string, state: "open" | "done" | "active") {
  return {
    ok: true,
    state,
    associationName,
    premium: loan.premium,
    months: loan.months,
    apr: loan.apr,
    downPayment: loan.downPayment,
    amountFinanced: loan.amountFinanced,
    payment: loan.payment,
    totalInterest: loan.totalInterest,
    originationFee: loan.originationFee,
    effectiveDate: loan.effectiveDate,
    /**
     * The paragraphs the customer signs — the same constants the agreement
     * PDF prints, served rather than copied so the two can never diverge.
     * A signed OPEN loan reports who signed, so a revived link (failed
     * debit) doesn't ask a second time; settled pages get neither — the
     * token is possession, and a settled page has no reason to name anyone.
     */
    agreementTerms: [
      OWNERSHIP_DISCLOSURE,
      POWER_OF_ATTORNEY,
      PREPAYMENT_TERMS,
      CANCELLATION_PROCEDURE,
    ],
    agreementSignedName: state === "open" ? (loan.agreementSignedName ?? null) : null,
    agreementSignedRole: state === "open" ? (loan.agreementSignedRole ?? null) : null,
  };
}

async function handleTerms(client: DataClient, args: Record<string, unknown>) {
  const loan = await loanForToken(client, args.token);
  if (!loan) return CLOSED;

  // ACCEPTED and ACTIVE render a settled page whatever the clock says — the
  // association already committed; the link in their inbox should keep
  // telling them so instead of going generically cold.
  const account = await client.models.Account.get({ id: loan.accountId });
  const name = account.data?.name ?? "your association";
  if (loan.status === "ACCEPTED") return termsShape(loan, name, "done");
  if (loan.status === "ACTIVE" || loan.status === "PAID") {
    return termsShape(loan, name, "active");
  }

  if (loan.status !== "QUOTED" || tokenExpired(loan)) return CLOSED;
  // A down payment clearing reads as done — the customer just made it, and
  // the settled view's words ("submitted… clears within a few business
  // days") are exactly true of it.
  if (loan.downPaymentIntentId) return termsShape(loan, name, "done");
  // An anchorless loan cannot be accepted (the accept refuses it), so the
  // terms say closed now instead of rendering an offer that dies at the
  // click.
  if (!anchorFilter(loan)) return CLOSED;
  if (!(await moduleEnabled(client))) return CLOSED;
  return termsShape(loan, name, "open");
}

async function logElection(row: {
  accountId: string;
  jurisdiction: string;
  rule: string;
  outcome: "PASS" | "BLOCK";
  reason: string;
  inputs: Record<string, unknown>;
}) {
  const table = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!table) return;
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          id: randomUUID(),
          __typename: "PfComplianceLog",
          createdAt: now,
          updatedAt: now,
          accountId: row.accountId,
          jurisdiction: row.jurisdiction,
          rule: row.rule,
          outcome: row.outcome,
          reason: row.reason,
          inputs: JSON.stringify(row.inputs),
          actor: "pf-election",
          actorName: "Association (election link)",
          configSha256: PF_CONFIG_SHA256,
          occurredAt: now,
        },
      })
    );
  } catch (err) {
    console.error("[pf-election] log write failed", err);
  }
}

async function handleAccept(
  client: DataClient,
  args: Record<string, unknown>,
  sourceIp: string | null
) {
  const loan = await loanForToken(client, args.token);
  if (!loan) return CLOSED;
  if (loan.status === "ACCEPTED") {
    // Pressed twice, or a stale tab: the money already moved. Idempotent.
    return { ok: true, state: "done" };
  }
  if (loan.status !== "QUOTED" || tokenExpired(loan)) return CLOSED;
  if (!(await moduleEnabled(client))) return CLOSED;

  /**
   * The signature comes with the accept or the accept does not exist (W8).
   * A typed name and role — PM, PM's finance team, board member — are the
   * agreement's execution; possession of the link is not consent. A loan
   * already signed (a revived link after a failed debit) keeps its first
   * signature: the stamps below are if_not_exists.
   */
  const signerName = typeof args.signerName === "string" ? args.signerName.trim() : "";
  const signerRole = typeof args.signerRole === "string" ? args.signerRole.trim() : "";
  if (!loan.agreementSignedAt && (signerName.length < 2 || signerRole.length < 2)) {
    return {
      ok: false,
      error: "Type your full name and your role to sign the agreement first.",
    };
  }
  if (signerName.length > 120 || signerRole.length > 80) {
    return { ok: false, error: "That name or role is too long." };
  }

  /**
   * A down payment already clearing IS a choice — the loan-side mirror of
   * the invoice rule that PROCESSING refuses everything. The webhook stamps
   * the clearing intent onto `downPaymentIntentId` while the loan is still
   * QUOTED, and clears it if the debit fails, which revives this link.
   */
  if (loan.downPaymentIntentId) {
    return {
      ok: true,
      state: "closed",
      reason: "Your down payment is already clearing. If it fails, this link will work again.",
    };
  }

  /**
   * One live offer per anchor. A token names a loan, but the policy or
   * quote may carry siblings: financing that money already touched refuses
   * outright, and an older quote loses to a newer one — the offer staff
   * most recently stood behind is the only one a customer can accept.
   */
  const loanFilter = anchorFilter(loan);
  if (!loanFilter) return CLOSED;
  const siblings = await listAllPages((nextToken) =>
    client.models.PfLoan.list({
      filter: loanFilter,
      nextToken,
    })
  );
  if (siblings.some((s) => ["ACCEPTED", "ACTIVE", "DEFAULTED"].includes(s.status))) {
    return {
      ok: true,
      state: "closed",
      reason: "Financing is already set up for this premium. Nothing more to accept.",
    };
  }
  if (
    siblings.some(
      (s) =>
        s.id !== loan.id &&
        s.status === "QUOTED" &&
        (s.quotedAt ?? "") > (loan.quotedAt ?? "")
    )
  ) {
    return {
      ok: true,
      state: "closed",
      reason: "A newer financing offer replaced this one. Use the link from your latest invoice email.",
    };
  }

  /**
   * Close the pay-in-full paths before any money is asked for. Only links
   * billing THIS premium are voided — the amount check is what says so; an
   * open link for any other figure is other billing, and a human resolves
   * that before financing does anything.
   */
  const invoices = await listAllPages((nextToken) =>
    client.models.Invoice.list({
      filter: loanFilter,
      nextToken,
    })
  );
  if (invoices.some((i) => i.status === "PAID")) {
    return {
      ok: true,
      state: "closed",
      reason: "This premium has already been paid in full. There is nothing to finance.",
    };
  }
  if (invoices.some((i) => i.status === "PROCESSING")) {
    return {
      ok: true,
      state: "closed",
      reason:
        "A pay-in-full bank transfer is already clearing for this premium. If it fails, this link will work again.",
    };
  }
  const premiumCents = Math.round(loan.premium * 100);
  const openLinked = invoices.filter((i) => i.status === "SENT" && i.stripePaymentLinkId);
  if (
    openLinked.some(
      (i) => i.stripeLinkAmountCents != null && i.stripeLinkAmountCents !== premiumCents
    )
  ) {
    return {
      ok: true,
      state: "closed",
      reason:
        "This policy has other open billing beside the premium. Your agent needs to resolve it before financing can start.",
    };
  }
  const loanTable = process.env.PF_LOAN_TABLE;
  const settingsTable = process.env.AGENCY_SETTINGS_TABLE;
  if (!loanTable || !settingsTable) throw new Error("PF_LOAN_TABLE or AGENCY_SETTINGS_TABLE unset");
  const now = new Date().toISOString();
  // From the read the token resolved — a concurrent first accept can double
  // the audit row in a hair's-width race, which is bounded and harmless;
  // the stamp itself stays if_not_exists.
  const firstElection = !loan.electedAt;
  // The signature rides the same transaction as the election, first-writer-
  // wins: a revived link keeps the original signer, and no stamp exists
  // that a committed disable post-dates.
  const signing = !loan.agreementSignedAt;
  try {
    /**
     * The stamp rides a ConditionCheck on the kill switch — pf-originate's
     * pattern, for the same reason: the moduleEnabled read above is advice,
     * and a disable that is durable when this transaction commits must fail
     * the whole election, not race it. No election stamp can exist that
     * post-dates a committed disable, and the Checkout mint below only
     * follows a stamp that transacted with the flag.
     */
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: loanTable,
              Key: { id: loan.id },
              UpdateExpression: signing
                ? "SET electedAt = if_not_exists(electedAt, :now), " +
                  "agreementSignedAt = if_not_exists(agreementSignedAt, :now), " +
                  "agreementSignedName = if_not_exists(agreementSignedName, :signerName), " +
                  "agreementSignedRole = if_not_exists(agreementSignedRole, :signerRole), " +
                  "agreementSignedIp = if_not_exists(agreementSignedIp, :signerIp), " +
                  "updatedAt = :now"
                : "SET electedAt = if_not_exists(electedAt, :now), updatedAt = :now",
              /**
               * Expiry is enforced HERE, not only at the read: the checks
               * above sit before the invoice scans and voids, and a token
               * submitted seconds before its expiry must not finish
               * electing after it. The clock that matters is the one this
               * write serializes at. The down-payment guard is the same
               * rule for money: the read-time "already clearing" refusal
               * above races the webhook's stamp, and a clearing intent
               * that lands between that read and this write must fail the
               * election rather than run beside it.
               */
              ConditionExpression:
                "#s = :quoted AND electionToken = :tok AND electionTokenExpiresAt > :now AND attribute_not_exists(downPaymentIntentId)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":now": now,
                ":quoted": "QUOTED",
                ":tok": loan.electionToken,
                ...(signing
                  ? {
                      ":signerName": signerName,
                      ":signerRole": signerRole,
                      ":signerIp": sourceIp ?? "unknown",
                    }
                  : {}),
              },
            },
          },
          {
            ConditionCheck: {
              TableName: settingsTable,
              Key: { id: "AGENCY" },
              ConditionExpression: "premiumFinanceEnabled = :on",
              ExpressionAttributeValues: { ":on": true },
            },
          },
        ],
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "TransactionCanceledException") throw err;
    const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
    if (reasons?.[1]?.Code === "ConditionalCheckFailed") {
      console.warn(`[pf-election] kill switch closed under accept for ${loan.id}`);
    }
    // The loan moved under the click, or the module closed. Either way:
    return CLOSED;
  }

  /**
   * The voids run AFTER the guarded stamp, not before it. Voiding first
   * left a refused election — expired clock, closed module, moved loan —
   * with the pay-in-full links already dead: a customer with no way to pay
   * at all. This order means a refusal costs nothing; a void failure after
   * the stamp leaves a committed election the retry finishes (void-invoice
   * is idempotent, the stamp is if_not_exists). A pay-in-full payment
   * racing this window resolves through the webhook's supersession and the
   * claim's own status condition below.
   */
  const voided: string[] = [];
  for (const inv of openLinked) {
    const res = await voidInvoice({ arguments: { invoiceId: inv.id } });
    if (!res.ok) {
      // A link that cannot be closed leaves two open payment paths — the
      // exact state the exclusion rule exists to prevent. Refuse; the
      // committed stamp waits for the retry.
      console.error(`[pf-election] could not void ${inv.number ?? inv.id}: ${res.error}`);
      return {
        ok: true,
        state: "closed",
        reason: "We couldn't close the pay-in-full link. Try again in a moment.",
      };
    }
    voided.push(inv.number ?? inv.id);
    // The spec's name for this moment, in the log where an examiner reads it.
    await logElection({
      accountId: loan.accountId,
      jurisdiction: loan.state,
      rule: "exclusive-payment-path",
      outcome: "BLOCK",
      reason: `Pay-in-full invoice ${inv.number ?? inv.id} voided by the association's election.`,
      inputs: { loanId: loan.id, invoiceId: inv.id },
    });
  }

  // One election event, one audit row — a public button must not be able to
  // write the log by holding the retry key down.
  if (firstElection) {
    /**
     * The signer named in the audit row is read back off the loan AFTER the
     * commit, strongly — not echoed from this invocation's inputs. In a
     * racing double-accept both callers can believe they signed first, and
     * if_not_exists keeps only the winner's stamps; a PASS row naming the
     * loser would put a signer in the log who is not the signer of record.
     */
    const signedRow = await ddb
      .send(new GetCommand({ TableName: loanTable, Key: { id: loan.id }, ConsistentRead: true }))
      .then((r) => r.Item)
      .catch(() => null);
    await logElection({
      accountId: loan.accountId,
      jurisdiction: loan.state,
      rule: "election",
      outcome: "PASS",
      reason: "Association elected financing from the invoice email and signed the agreement.",
      inputs: {
        loanId: loan.id,
        voidedInvoices: voided,
        signerName: signedRow?.agreementSignedName ?? (signing ? signerName : loan.agreementSignedName),
        signerRole: signedRow?.agreementSignedRole ?? (signing ? signerRole : loan.agreementSignedRole),
        signerIp: signedRow?.agreementSignedIp ?? (signing ? (sourceIp ?? "unknown") : loan.agreementSignedIp),
      },
    });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("[pf-election] STRIPE_SECRET_KEY unset");
    return {
      ok: true,
      state: "closed",
      reason: "Payments are not configured. Contact your agent.",
    };
  }

  /**
   * One live Checkout session at a time, enforced at WRITE time. The stored
   * session is handed back until it expires (with a margin, so nobody lands
   * on a dying page) — and the slot itself is CLAIMED with a conditional
   * write before Stripe hears anything, because two overlapping accepts
   * would otherwise both read an empty slot and mint two payable sessions
   * for one down payment. Same claim discipline as the autopay cron: the
   * loser of the condition reads the winner's session instead of minting.
   */
  const liveStoredSession = (
    url: string | null | undefined,
    exp: string | null | undefined
  ): string | null =>
    url &&
    !url.startsWith("claim-") &&
    exp &&
    new Date(exp).getTime() > Date.now() + 5 * 60 * 1000
      ? url
      : null;
  const stored = liveStoredSession(loan.electionCheckoutUrl, loan.electionCheckoutExpiresAt);
  if (stored) return { ok: true, state: "checkout", url: stored };

  const sessionClaim = `claim-${randomUUID()}`;
  const claimExpiry = new Date(Date.now() + 36 * 60 * 1000).toISOString();
  const quotedSiblings = siblings.filter((s) => s.id !== loan.id && s.status === "QUOTED");
  try {
    /**
     * The claim carries the kill switch AND the siblings' slots. The mint
     * that follows can only follow a claim, so a disable durable at this
     * write forecloses the payable session — and the sibling checks
     * serialize sessions PER POLICY at commit time, where the read-time
     * sibling scan above cannot: two quoted loans on one policy racing
     * their accepts both pass their own reads, but the second claim's
     * transaction sees the first's slot and cancels. One premium, one
     * payable session, whichever token it rides.
     */
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: loanTable,
              Key: { id: loan.id },
              UpdateExpression:
                "SET electionCheckoutUrl = :claim, electionCheckoutExpiresAt = :exp, updatedAt = :now",
              // Free, or expired, or a stale claim past its own expiry —
              // never a live session, never a fresh claim someone else is
              // filling, never for a token past its clock, and never while
              // a down payment is clearing (same write-time rules as the
              // election stamp: a webhook stamping the intent between the
              // read and this claim must refuse the second session, not
              // race it — Stripe can sit on the completed event for hours).
              ConditionExpression:
                "#s = :quoted AND electionTokenExpiresAt > :now AND attribute_not_exists(downPaymentIntentId) AND (attribute_not_exists(electionCheckoutUrl) OR electionCheckoutExpiresAt < :now)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":claim": sessionClaim,
                ":exp": claimExpiry,
                ":quoted": "QUOTED",
                ":now": now,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: settingsTable,
              Key: { id: "AGENCY" },
              ConditionExpression: "premiumFinanceEnabled = :on",
              ExpressionAttributeValues: { ":on": true },
            },
          },
          ...quotedSiblings.map((s) => ({
            ConditionCheck: {
              TableName: loanTable,
              Key: { id: s.id },
              ConditionExpression:
                "attribute_not_exists(electionCheckoutUrl) OR electionCheckoutExpiresAt < :now",
              ExpressionAttributeValues: { ":now": now },
            },
          })),
        ],
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "TransactionCanceledException") throw err;
    const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
    if (
      reasons?.[1]?.Code === "ConditionalCheckFailed" &&
      reasons?.[0]?.Code !== "ConditionalCheckFailed"
    ) {
      // The kill switch alone refused: fail closed, no polling for winners.
      console.warn(`[pf-election] kill switch closed under session claim for ${loan.id}`);
      return CLOSED;
    }
    if (
      reasons?.slice(2).some((r) => r?.Code === "ConditionalCheckFailed") &&
      reasons?.[0]?.Code !== "ConditionalCheckFailed"
    ) {
      // A sibling offer holds a live session for this premium.
      return {
        ok: true,
        state: "closed",
        reason:
          "Financing for this premium is already being set up from another offer. Use the link from your latest invoice email.",
      };
    }
    /**
     * Someone holds the slot. If it is a live session, hand it back; if it
     * is a concurrent claim still being filled, wait briefly for the winner
     * to swap the real URL in.
     */
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 750));
      const fresh = await loanForToken(client, args.token);
      const url = liveStoredSession(fresh?.electionCheckoutUrl, fresh?.electionCheckoutExpiresAt);
      if (url) return { ok: true, state: "checkout", url };
      if (fresh?.status === "ACCEPTED") return { ok: true, state: "done" };
    }
    return {
      ok: true,
      state: "closed",
      reason: "Your payment is being set up in another window. Try again in a moment.",
    };
  }

  const siteUrl = process.env.SITE_URL || "";
  const account = await client.models.Account.get({ id: loan.accountId });
  const name = account.data?.name ?? "Association";
  const totalPayments = loan.months + 1;

  /**
   * Checkout collects payment 1 of the schedule and saves the bank account
   * for the 11 that follow (`setup_future_usage: "off_session"` is the ACH
   * mandate). `pfLoanId`/`pfKind` on the PaymentIntent is how the webhook
   * routes it — deliberately NOT `invoiceId`, which routes to the invoice
   * path. Sessions expire quickly because each accept can mint one and only
   * the money should decide which counts.
   */
  const stripe = new Stripe(key);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["us_bank_account"],
    customer_creation: "always",
    customer_email: loan.electionEmail ?? undefined,
    // 35 minutes: Stripe's minimum is exactly 30, and clock skew against an
    // exact minimum is an intermittent create failure nobody can reproduce.
    expires_at: Math.floor(Date.now() / 1000) + 35 * 60,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(loan.downPayment * 100),
          product_data: {
            name: `${name} — down payment (payment 1 of ${totalPayments})`,
          },
        },
      },
    ],
    payment_intent_data: {
      setup_future_usage: "off_session",
      metadata: { pfLoanId: loan.id, pfKind: "down" },
    },
    metadata: { pfLoanId: loan.id, pfKind: "down" },
    success_url: `${siteUrl}/finance/?t=${loan.electionToken}&done=1`,
    cancel_url: `${siteUrl}/finance/?t=${loan.electionToken}`,
    });
  } catch (err) {
    // Nothing was minted; free the slot so a retry doesn't wait out the
    // claim's own expiry.
    await releaseSessionClaim(loanTable, loan.id, sessionClaim);
    throw err;
  }

  if (!session.url) {
    console.error("[pf-election] checkout session has no url", session.id);
    await releaseSessionClaim(loanTable, loan.id, sessionClaim);
    return {
      ok: true,
      state: "closed",
      reason: "We couldn't start the payment. Try again in a moment.",
    };
  }
  /**
   * The mint itself cannot transact with DynamoDB, so the flag is read once
   * more AFTER it — strongly, straight off the table: an eventually
   * consistent read here could echo the pre-disable value and hand out the
   * session anyway. A disable that landed in the claim→mint window finds
   * the session expired before its URL was ever handed out or stored; a
   * disable that lands after this read resolves through the webhook's
   * settle-time record-and-alarm, because no read can outrun a commit.
   */
  const flagNow = await ddb
    .send(
      new GetCommand({ TableName: settingsTable, Key: { id: "AGENCY" }, ConsistentRead: true })
    )
    .then((r) => r.Item?.premiumFinanceEnabled === true)
    .catch((err) => {
      console.error("[pf-election] post-mint flag read failed; failing closed", err);
      return false;
    });
  if (!flagNow) {
    console.warn(`[pf-election] kill switch closed under mint for ${loan.id}; expiring ${session.id}`);
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (err) {
      console.error(`[pf-election] could not expire ${session.id}`, err);
    }
    await releaseSessionClaim(loanTable, loan.id, sessionClaim);
    return CLOSED;
  }
  /**
   * The claim becomes the real session, conditionally on still holding it.
   * A lost condition means the slot moved under us (a stale-claim takeover
   * by a concurrent accept, or a release) — this session is then an orphan
   * Stripe expires in 35 minutes; the money still can't double-collect,
   * because only one URL is ever handed out per slot.
   */
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: loanTable,
        Key: { id: loan.id },
        UpdateExpression:
          "SET electionCheckoutUrl = :url, electionCheckoutExpiresAt = :exp, updatedAt = :now",
        ConditionExpression: "electionCheckoutUrl = :claim",
        ExpressionAttributeValues: {
          ":url": session.url,
          ":exp": new Date((session.expires_at ?? 0) * 1000).toISOString(),
          ":claim": sessionClaim,
          ":now": new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
      console.error("[pf-election] could not store the checkout session", err);
    } else {
      console.warn(`[pf-election] session slot moved under ${loan.id}; not handing out ${session.id}`);
      return {
        ok: true,
        state: "closed",
        reason: "Your payment is being set up in another window. Try again in a moment.",
      };
    }
  }
  return { ok: true, state: "checkout", url: session.url };
}

/** Free a claimed session slot, if we still hold it. Best effort. */
async function releaseSessionClaim(loanTable: string, loanId: string, claim: string) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: loanTable,
        Key: { id: loanId },
        UpdateExpression:
          "REMOVE electionCheckoutUrl, electionCheckoutExpiresAt SET updatedAt = :now",
        ConditionExpression: "electionCheckoutUrl = :claim",
        ExpressionAttributeValues: { ":claim": claim, ":now": new Date().toISOString() },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
      console.error(`[pf-election] could not release the session claim on ${loanId}`, err);
    }
  }
}

export const handler = async (event: {
  info?: { fieldName?: string };
  arguments?: Record<string, unknown>;
  request?: { headers?: Record<string, string | undefined> };
}) => {
  const client = await getDataClient();
  const args = event.arguments ?? {};
  /**
   * The signer's address for the audit stamp: first hop of X-Forwarded-For,
   * which AppSync passes through. The first hop is client-influenced —
   * supporting evidence, never proof; the signature's substance is the
   * typed name and role. It is shape-checked so nothing unbounded or
   * non-address-like can reach the loan record, the compliance log, or the
   * printed agreement. Absence degrades to "unknown", never a refusal.
   */
  const firstHop =
    event.request?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ?? "";
  const sourceIp =
    /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})$/.test(firstHop) ? firstHop : null;
  try {
    const named = event.info?.fieldName;
    const isAccept =
      named === "acceptFinanceElection" ||
      (named !== "financeElectionTerms" && args.accept === true);
    return isAccept
      ? await handleAccept(client, args, sourceIp)
      : await handleTerms(client, args);
  } catch (err) {
    // Never leak an internal message to a public caller.
    console.error("pf-election failed", err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
};

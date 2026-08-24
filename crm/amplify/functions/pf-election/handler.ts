import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
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
 * 1. Validate: module on, token unexpired, loan QUOTED.
 * 2. The policy's pay-in-full paths close FIRST: a PAID invoice refuses the
 *    election outright, a PROCESSING one refuses until it lands or fails, and
 *    every SENT invoice with a live link is voided through void-invoice's own
 *    handler — the path that already knows the deactivate-before-write order
 *    and loses correctly to a payment racing it.
 * 3. Stamp `electedAt` conditionally on the loan still being QUOTED under
 *    this token.
 * 4. Mint the Checkout Session (down payment + off-session mandate) and hand
 *    its URL back. Money moving is what advances the loan — the webhook flips
 *    QUOTED → ACCEPTED when the down payment succeeds, never this handler.
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

async function handleAccept(client: DataClient, args: Record<string, unknown>) {
  const loan = await loanForToken(client, args.token);
  if (!loan) return CLOSED;
  if (loan.status === "ACCEPTED") {
    // Pressed twice, or a stale tab: the money already moved. Idempotent.
    return { ok: true, state: "done" };
  }
  if (loan.status !== "QUOTED" || tokenExpired(loan)) return CLOSED;
  if (!(await moduleEnabled(client))) return CLOSED;

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
   * One live offer per policy. A token names a loan, but the policy may
   * carry siblings: financing that money already touched refuses outright,
   * and an older quote loses to a newer one — the offer staff most recently
   * stood behind is the only one a customer can accept.
   */
  const siblings = await listAllPages((nextToken) =>
    client.models.PfLoan.list({
      filter: { policyId: { eq: loan.policyId } },
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
      filter: { policyId: { eq: loan.policyId } },
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
  const voided: string[] = [];
  for (const inv of openLinked) {
    const res = await voidInvoice({ arguments: { invoiceId: inv.id } });
    if (!res.ok) {
      // A link that cannot be closed leaves two open payment paths — the
      // exact state the exclusion rule exists to prevent. Refuse.
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

  const loanTable = process.env.PF_LOAN_TABLE;
  const settingsTable = process.env.AGENCY_SETTINGS_TABLE;
  if (!loanTable || !settingsTable) throw new Error("PF_LOAN_TABLE or AGENCY_SETTINGS_TABLE unset");
  const now = new Date().toISOString();
  // From the read the token resolved — a concurrent first accept can double
  // the audit row in a hair's-width race, which is bounded and harmless;
  // the stamp itself stays if_not_exists.
  const firstElection = !loan.electedAt;
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
              UpdateExpression:
                "SET electedAt = if_not_exists(electedAt, :now), updatedAt = :now",
              ConditionExpression: "#s = :quoted AND electionToken = :tok",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":now": now,
                ":quoted": "QUOTED",
                ":tok": loan.electionToken,
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

  // One election event, one audit row — a public button must not be able to
  // write the log by holding the retry key down.
  if (firstElection) {
    await logElection({
      accountId: loan.accountId,
      jurisdiction: loan.state,
      rule: "election",
      outcome: "PASS",
      reason: "Association elected financing from the invoice email.",
      inputs: { loanId: loan.id, voidedInvoices: voided },
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
   * One live Checkout session at a time. A public retry button must not be
   * able to mint unbounded Stripe objects; the stored session is handed back
   * until it expires (with a margin, so nobody lands on a dying page).
   */
  if (
    loan.electionCheckoutUrl &&
    loan.electionCheckoutExpiresAt &&
    new Date(loan.electionCheckoutExpiresAt).getTime() > Date.now() + 5 * 60 * 1000
  ) {
    return { ok: true, state: "checkout", url: loan.electionCheckoutUrl };
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
  const session = await stripe.checkout.sessions.create({
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

  if (!session.url) {
    console.error("[pf-election] checkout session has no url", session.id);
    return {
      ok: true,
      state: "closed",
      reason: "We couldn't start the payment. Try again in a moment.",
    };
  }
  // Remember the session for the retry path above. Best effort — a lost
  // write costs one extra session, which is the state we started from.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: loanTable,
        Key: { id: loan.id },
        UpdateExpression:
          "SET electionCheckoutUrl = :url, electionCheckoutExpiresAt = :exp, updatedAt = :now",
        ConditionExpression: "#s = :quoted",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":url": session.url,
          ":exp": new Date((session.expires_at ?? 0) * 1000).toISOString(),
          ":quoted": "QUOTED",
          ":now": new Date().toISOString(),
        },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
      console.error("[pf-election] could not store the checkout session", err);
    }
  }
  return { ok: true, state: "checkout", url: session.url };
}

export const handler = async (event: {
  info?: { fieldName?: string };
  arguments?: Record<string, unknown>;
}) => {
  const client = await getDataClient();
  const args = event.arguments ?? {};
  try {
    const named = event.info?.fieldName;
    const isAccept =
      named === "acceptFinanceElection" ||
      (named !== "financeElectionTerms" && args.accept === true);
    return isAccept ? await handleAccept(client, args) : await handleTerms(client, args);
  } catch (err) {
    // Never leak an internal message to a public caller.
    console.error("pf-election failed", err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
};

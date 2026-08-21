import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";

/**
 * Custom mutation handler: voidInvoice. See resource.ts for the why.
 *
 * One argument, the invoice id. Deactivates the Stripe Payment Link if there is
 * one, then writes VOID — conditionally.
 *
 * ── Why the write carries a condition ───────────────────────────────────────
 * Between this handler's read and its write sits a Stripe API call, and that
 * window is wide enough for a payment webhook to land, win its own conditional
 * write, and answer Stripe with a 200. An unconditional void afterwards would
 * bury that PAID: Stripe never redelivers an acknowledged event, and the
 * webhook skips void invoices, so money the agency has received would be
 * recorded nowhere. The condition makes the void lose that race instead, which
 * costs a producer one error message saying the bill was paid.
 *
 * ── Why DynamoDB and not the data client ────────────────────────────────────
 * The data client cannot express a conditional update, which is the whole fix —
 * the same reason `stripe-webhook/persist.ts` and `uploadQuota.ts` go direct.
 * Going direct for the read as well buys `ConsistentRead`: the retry below
 * re-reads after losing a race, and an eventually-consistent read can hand back
 * the exact stale row it just lost with.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

interface Row {
  status: string | null;
  number: string | null;
  stripePaymentLinkId: string | null;
}

async function readRow(tableName: string, id: string): Promise<Row | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true })
  );
  if (!res.Item) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    status: str(res.Item.status),
    number: str(res.Item.number),
    stripePaymentLinkId: str(res.Item.stripePaymentLinkId),
  };
}

/**
 * Write VOID, if the row still looks the way the decision saw it.
 *
 * Both fields the decision read are in the condition — the status, and the
 * link id. The second matters because a concurrent re-send can mint a fresh
 * link when the total changed; a void conditioned on status alone would then
 * retire the invoice while the *new* link stayed payable, which is the exact
 * state this function exists to prevent, one link over.
 */
async function writeVoid(
  tableName: string,
  id: string,
  seen: Row
): Promise<boolean> {
  const names: Record<string, string> = { "#s": "status", "#link": "stripePaymentLinkId" };
  const values: Record<string, unknown> = {
    ":void": "VOID",
    ":seen": seen.status,
    ":writer": "void-invoice",
    ":now": new Date().toISOString(),
  };
  const clauses = ["#s = :seen"];
  if (seen.stripePaymentLinkId === null) {
    clauses.push("attribute_not_exists(#link)");
  } else {
    clauses.push("#link = :seenLink");
    values[":seenLink"] = seen.stripePaymentLinkId;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id },
        // The url is removed, not nulled: a dead link in an email is worse
        // than none, and nothing should render a Pay button for it.
        // `updatedAt` by hand because this bypasses the data client, which
        // otherwise stamps it — same as persist.ts.
        UpdateExpression:
          "SET #s = :void, lastWriteBy = :writer, updatedAt = :now REMOVE paymentUrl",
        ConditionExpression: clauses.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

export const handler = async (event: {
  arguments?: { invoiceId?: string };
}): Promise<{ ok: boolean; error?: string }> => {
  const invoiceId = event.arguments?.invoiceId?.trim();
  if (!invoiceId) return { ok: false, error: "No invoice given." };
  const tableName = process.env.INVOICE_TABLE;
  if (!tableName) {
    console.error("[void-invoice] INVOICE_TABLE unset");
    return { ok: false, error: "Voiding is not configured." };
  }

  try {
    /**
     * Two passes, like the webhook's loop and for the same reason: losing the
     * condition means the row moved, and the answer to a moved row is to look
     * at it again, not to guess. The second look usually ends in one of the
     * terminal returns below — paid, or already void.
     */
    for (let attempt = 1; attempt <= 2; attempt++) {
      const invoice = await readRow(tableName, invoiceId);
      if (!invoice) return { ok: false, error: "That invoice no longer exists." };

      // Already void, and nothing to undo. Idempotent because a producer who
      // pressed it twice should not see an error the second time.
      if (invoice.status === "VOID") return { ok: true };

      /**
       * A paid invoice is a record of money received. Voiding it would say the
       * bill was withdrawn, which is not what happened, and the trust account
       * would disagree. This is also where the race resolves when a payment
       * lands mid-void: the retry reads PAID and stops here.
       */
      if (invoice.status === "PAID") {
        return {
          ok: false,
          error: "That invoice has been paid and cannot be voided.",
        };
      }

      /**
       * The link dies before the status changes.
       *
       * This order is the point of the whole function. If deactivation fails
       * and the status had already been written, the result is a void invoice
       * with a live payment link — money collectable against a bill the
       * webhook will ignore. Failing here leaves an ordinary unpaid invoice,
       * which a person can simply try again from.
       */
      const linkId = invoice.stripePaymentLinkId;
      if (linkId) {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key) {
          console.error("[void-invoice] STRIPE_SECRET_KEY unset; refusing to void");
          return {
            ok: false,
            error: "Payments are not configured, so the payment link cannot be closed.",
          };
        }
        try {
          await new Stripe(key).paymentLinks.update(linkId, { active: false });
        } catch (err) {
          /**
           * A link Stripe has never heard of is already unpayable, so that is
           * not a reason to refuse. Anything else is, because we cannot tell
           * whether it is still live.
           */
          const code = (err as { code?: string }).code;
          if (code !== "resource_missing") {
            console.error("[void-invoice] could not deactivate the payment link", err);
            return {
              ok: false,
              error: "Couldn't close the payment link, so the invoice was left alone.",
            };
          }
          console.warn(`[void-invoice] link ${linkId} already gone at Stripe`);
        }
      }

      if (await writeVoid(tableName, invoiceId, invoice)) {
        console.log(`void-invoice voided ${invoice.number ?? invoiceId}`);
        return { ok: true };
      }
      console.log(
        `void-invoice lost a race on ${invoice.number ?? invoiceId}, attempt ${attempt}`
      );
    }

    /**
     * Beaten twice. A button press is retryable by the person holding the
     * button, so no loop beyond this — say what happened and let them look.
     */
    return {
      ok: false,
      error: "The invoice changed while voiding it. Check it and try again.",
    };
  } catch (err) {
    console.error("void-invoice failed", err);
    return { ok: false, error: "We couldn't void that invoice. Please try again." };
  }
};

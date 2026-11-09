import { createDataClientGetter } from "../data-client";
import { captureHandledFailure } from "../monitoring";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { isRealIsoDay } from "../../../../shared/premiumFinance/noticeSequence";
import { listAllPages } from "../../../../shared/pagination";
import {
  PF_DEFAULT_DOWN_PCT,
  PF_DEFAULT_MONTHS,
} from "../../../../shared/premiumFinance/quote";
import { originateLoan } from "../pfOrigination";
import { getModel } from "../broker-fees/store";
import { assertStandalonePolicyBilling, claimStandalonePolicyLoan, GroupedDraftBillingBlocked } from "../grouped-draft-billing";
import type { Schema } from "../../data/resource";

/**
 * Custom mutation handler: issueFinanceQuote.
 *
 * Since W8 this is a thin shell over the shared origination core — the same
 * core the invoice send drives, because two writers of loans sharing the
 * gates by convention is how gates drift. The mutation remains for API
 * completeness and tooling; the product's origination path is the send.
 */

const getDataClient = createDataClientGetter();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

const AGENCY_SETTINGS_ID = "AGENCY";

export const handler = async (event: {
  arguments?: {
    policyId?: string;
    premium?: number;
    downPct?: number;
    months?: number;
    apr?: number;
    effectiveDate?: string;
  };
  identity?: { sub?: string; username?: string; claims?: Record<string, unknown> };
}): Promise<unknown> => {
  const a = event.arguments ?? {};
  const actor = event.identity?.sub ?? "unknown";
  const actorName =
    (typeof event.identity?.claims?.email === "string"
      ? event.identity.claims.email
      : null) ??
    event.identity?.username ??
    actor;

  if (
    !a.policyId ||
    typeof a.premium !== "number" ||
    typeof a.downPct !== "number" ||
    typeof a.months !== "number" ||
    typeof a.apr !== "number" ||
    !isRealIsoDay(a.effectiveDate)
  ) {
    return { ok: false, error: "Missing or malformed quote terms." };
  }
  if (a.premium <= 0 || a.downPct < 0 || a.downPct >= 100 || a.months < 1 || a.months > 12) {
    return { ok: false, error: "Quote terms out of range." };
  }
  /**
   * The down payment and installment count are fixed product terms. The
   * shared core derives APR from the account's state and rejects a caller
   * assertion that differs from that price.
   */
  if (
    a.downPct !== PF_DEFAULT_DOWN_PCT ||
    a.months !== PF_DEFAULT_MONTHS
  ) {
    return {
      ok: false,
      error: `Terms are fixed: ${PF_DEFAULT_DOWN_PCT}% down, ${PF_DEFAULT_MONTHS} monthly installments. The invoice send is the origination path.`,
    };
  }

  try {
    const client = await getDataClient();

    const policy = await getModel<Schema["Policy"]["type"]>("Policy", a.policyId);
    if (!policy) return { ok: false, error: "That policy no longer exists." };
    await assertStandalonePolicyBilling(policy);
    const policyLoanClaim = await claimStandalonePolicyLoan(policy);
    const { data: account } = await client.models.Account.get({
      id: policy.accountId,
    });
    if (!account) return { ok: false, error: "That account no longer exists." };

    const { data: settings } = await client.models.AgencySettings.get({
      id: AGENCY_SETTINGS_ID,
    });

    return await originateLoan(
      ddb,
      {
        // Paginated to exhaustion — a filtered list caps its SCAN, not its
        // matches, so `limit: 100` can silently miss the row that matters.
        listOpinions: async (code) => {
          const rows = await listAllPages((nextToken) =>
            client.models.PfCounselOpinion.list({
              filter: { jurisdiction: { eq: code } },
              nextToken,
            })
          );
          return rows.map((o) => ({ effectiveAt: o.effectiveAt, reviewBy: o.reviewBy }));
        },
      },
      settings?.premiumFinanceEnabled === true,
      {
        account: {
          id: account.id,
          state: account.state,
          type: account.type,
          incorporated: account.incorporated,
        },
        anchor: {
          kind: "policy",
          id: a.policyId,
          lines: policy.lines ?? [],
          coverageEffectiveDate: policy.effectiveDate,
        },
        policyLoanClaim,
        premium: a.premium,
        downPct: a.downPct,
        months: a.months,
        apr: a.apr,
        effectiveDate: a.effectiveDate,
        actor,
        actorName,
      }
    );
  } catch (err) {
    if (err instanceof GroupedDraftBillingBlocked) return { ok: false, error: err.message };
    captureHandledFailure(err);
    console.error("pf-originate failed", err);
    return { ok: false, error: "Couldn't evaluate that quote. Try again." };
  }
};

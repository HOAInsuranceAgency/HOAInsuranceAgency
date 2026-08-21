import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Schema } from "../../data/resource";
import {
  addDaysIso,
  canRecordCert,
  canRequestCancellation,
  CARRIER_REFUND_DAYS,
  NOTICE_DAYS,
  type NoticeRow,
} from "../../../src/lib/premiumFinance/noticeSequence";
import type { ScheduleRow } from "../../../src/lib/premiumFinance/quote";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";

/**
 * Custom mutation handler: servicePfLoan. Dispatched on `action`.
 *
 * Timestamps are server-set on every row this creates. The arguments carry
 * exactly two dates from the outside world — the physical USPS certificate's
 * own date, and the cancellation effective date agreed with the carrier —
 * because those are facts about paper and policy, not about when the operator
 * clicked. The click times are ours, and nothing accepts them as input.
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

async function logRow(row: {
  accountId: string;
  jurisdiction: string;
  rule: string;
  outcome: "PASS" | "BLOCK";
  reason?: string;
  inputs: Record<string, unknown>;
  actor: string;
  actorName: string;
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
          ...row,
          reason: row.reason ?? null,
          inputs: JSON.stringify(row.inputs),
          configSha256: PF_CONFIG_SHA256,
          occurredAt: now,
        },
      })
    );
  } catch (err) {
    console.error(`[pf-servicing] log write failed for ${row.rule}`, err);
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const handler = async (event: {
  arguments?: {
    loanId?: string;
    action?: string;
    boardResolutionExecutedAt?: string;
    boardResolutionDocumentId?: string;
    noticeId?: string;
    certMailedAt?: string;
    certNumber?: string;
    cancellationEffectiveAt?: string;
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
  if (!a.loanId || !a.action) return { ok: false, error: "Missing loan or action." };

  try {
    const client = await getDataClient();
    const { data: loan } = await client.models.PfLoan.get({ id: a.loanId });
    if (!loan) return { ok: false, error: "That loan no longer exists." };
    const now = new Date().toISOString();

    switch (a.action) {
      /**
       * QUOTED → ACTIVE, behind the staleness rule: the executed board
       * resolution must be from the financed term. A resolution executed
       * before the term's effective date is the prior board's paper — boards
       * turn over annually and a receiver can replace one mid-term — and the
       * power of attorney must trace to a body that currently exists.
       */
      case "ACTIVATE": {
        if (loan.status !== "QUOTED") {
          return { ok: false, error: `A ${loan.status.toLowerCase()} loan cannot be activated.` };
        }
        const executed = a.boardResolutionExecutedAt;
        if (!executed || !DAY.test(executed)) {
          return { ok: false, error: "The board resolution's execution date is required." };
        }
        const { data: policy } = await client.models.Policy.get({ id: loan.policyId });
        const termStart = policy?.effectiveDate ?? loan.effectiveDate;
        const stale = executed < termStart;
        await logRow({
          accountId: loan.accountId,
          jurisdiction: loan.state,
          rule: "board-resolution",
          outcome: stale ? "BLOCK" : "PASS",
          reason: stale
            ? `Resolution executed ${executed} predates the financed term effective ${termStart}. A current-term resolution is required.`
            : undefined,
          inputs: { loanId: loan.id, executed, termStart },
          actor,
          actorName,
        });
        if (stale) {
          return {
            ok: false,
            error: `That resolution was executed ${executed}, before the financed term began (${termStart}). Boards turn over — obtain a resolution executed for the current term.`,
          };
        }
        const { errors } = await client.models.PfLoan.update({
          id: loan.id,
          status: "ACTIVE",
          activatedAt: now,
          boardResolutionExecutedAt: executed,
          boardResolutionDocumentId: a.boardResolutionDocumentId ?? null,
        });
        if (errors?.length) throw new Error(errors[0].message);
        return { ok: true };
      }

      /**
       * Post the next scheduled installment, exactly. Partial and irregular
       * amounts are a per-state design of their own; until that exists, a
       * posting is the schedule row or it is refused — which also keeps the
       * interest/principal split beyond argument.
       */
      case "POST_PAYMENT": {
        if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") {
          return { ok: false, error: `A ${loan.status.toLowerCase()} loan cannot take a payment.` };
        }
        const { data: settings } = await client.models.AgencySettings.get({
          id: "AGENCY",
        });
        const bankAccount = settings?.pfLendingAccountName?.trim();
        if (!bankAccount) {
          // The segregation rule with teeth: no designated lending account,
          // no postings. Receipts must never default into the trust.
          return {
            ok: false,
            error: "No designated lending account is configured. Set it under Financing before posting — loan money must not touch the premium trust.",
          };
        }
        const schedule: ScheduleRow[] =
          typeof loan.schedule === "string" ? JSON.parse(loan.schedule) : (loan.schedule as never);
        const n = (loan.paidThrough ?? 0) + 1;
        const row = schedule[n - 1];
        if (!row) return { ok: false, error: "The schedule is fully paid." };

        const { errors: payErr } = await client.models.PfLoanPayment.create({
          loanId: loan.id,
          accountId: loan.accountId,
          n,
          amount: row.payment,
          interest: row.interest,
          principal: row.principal,
          bankAccount,
          postedAt: now,
          postedBy: actor,
          postedByName: actorName,
        });
        if (payErr?.length) throw new Error(payErr[0].message);

        const finished = n >= schedule.length;
        const { errors } = await client.models.PfLoan.update({
          id: loan.id,
          paidThrough: n,
          balance: row.balance,
          nextDueAt: finished ? null : schedule[n].dueDate,
          // A posting cures a default; a cleared schedule closes the loan.
          status: finished ? "PAID" : "ACTIVE",
          ...(finished ? { closedAt: now } : {}),
          ...(loan.status === "DEFAULTED" && !finished ? { defaultedAt: null } : {}),
        });
        if (errors?.length) throw new Error(errors[0].message);
        return { ok: true, posted: { n, amount: row.payment, balance: row.balance } };
      }

      /** Step one of cancellation: the 15-day clock starts here. */
      case "NOTICE_INTENT": {
        if (loan.status !== "DEFAULTED") {
          return { ok: false, error: "Intent to cancel is sent on a defaulted loan only." };
        }
        const { data: notice, errors } = await client.models.PfNotice.create({
          loanId: loan.id,
          accountId: loan.accountId,
          type: "INTENT_TO_CANCEL",
          occurredAt: now,
          clockExpiresAt: addDaysIso(now, NOTICE_DAYS),
          createdBy: actor,
          createdByName: actorName,
        });
        if (errors?.length || !notice) throw new Error(errors?.[0]?.message);
        return { ok: true, noticeId: notice.id, clockExpiresAt: notice.clockExpiresAt };
      }

      /** The USPS certificate, without which nothing advances. */
      case "RECORD_CERT": {
        if (!a.noticeId || !a.certMailedAt || !DAY.test(a.certMailedAt) || !a.certNumber?.trim()) {
          return { ok: false, error: "The certificate needs its notice, mailing date, and USPS number." };
        }
        const { data: noticeRows } = await client.models.PfNotice.list({
          filter: { loanId: { eq: loan.id } },
          limit: 200,
        });
        const verdict = canRecordCert(noticeRows as NoticeRow[], a.noticeId);
        if (!verdict.ok) return { ok: false, error: verdict.reason };
        const { errors } = await client.models.PfNotice.create({
          loanId: loan.id,
          accountId: loan.accountId,
          type: "CERT_OF_MAILING",
          occurredAt: now,
          refNoticeId: a.noticeId,
          certMailedAt: a.certMailedAt,
          certNumber: a.certNumber.trim(),
          createdBy: actor,
          createdByName: actorName,
        });
        if (errors?.length) throw new Error(errors[0].message);
        return { ok: true };
      }

      /**
       * Only after the 15 days expire, with a certificate on file. The
       * sequence check is the pure module the tests exercise; its refusal
       * strings name the missing step.
       */
      case "REQUEST_CANCELLATION": {
        if (loan.status !== "DEFAULTED") {
          return { ok: false, error: "Cancellation is requested on a defaulted loan only." };
        }
        const effective = a.cancellationEffectiveAt;
        if (!effective || !DAY.test(effective)) {
          return { ok: false, error: "The cancellation effective date is required." };
        }
        const { data: noticeRows } = await client.models.PfNotice.list({
          filter: { loanId: { eq: loan.id } },
          limit: 200,
        });
        const verdict = canRequestCancellation(noticeRows as NoticeRow[], now);
        await logRow({
          accountId: loan.accountId,
          jurisdiction: loan.state,
          rule: "notice-clock",
          outcome: verdict.ok ? "PASS" : "BLOCK",
          reason: verdict.ok ? undefined : verdict.reason,
          inputs: { loanId: loan.id, effective },
          actor,
          actorName,
        });
        if (!verdict.ok) return { ok: false, error: verdict.reason };

        const intent = (noticeRows as NoticeRow[]).find(
          (r) => r.type === "INTENT_TO_CANCEL"
        );
        const { errors: nErr } = await client.models.PfNotice.create({
          loanId: loan.id,
          accountId: loan.accountId,
          type: "CANCELLATION_REQUEST",
          occurredAt: now,
          refNoticeId: intent?.id ?? null,
          createdBy: actor,
          createdByName: actorName,
        });
        if (nErr?.length) throw new Error(nErr[0].message);
        const { errors } = await client.models.PfLoan.update({
          id: loan.id,
          status: "CANCELLED",
          cancellationEffectiveAt: effective,
          // The unearned-premium receivable: the carrier owes the refund
          // within 30 days of the cancellation effective date.
          expectedCarrierRefundAt: addDaysIso(`${effective}T00:00:00.000Z`, CARRIER_REFUND_DAYS).slice(0, 10),
          closedAt: now,
        });
        if (errors?.length) throw new Error(errors[0].message);
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown action "${a.action}".` };
    }
  } catch (err) {
    console.error("pf-servicing failed", err);
    return { ok: false, error: "Servicing action failed. Try again." };
  }
};

import { randomUUID } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  aprCapViolation,
  hasCurrentOpinion,
  minPrincipalViolation,
  originationGate,
} from "../../src/lib/premiumFinance/gate";
import { evaluateEligibility } from "../../src/lib/premiumFinance/eligibility";
import { buildQuote, downPctViolation } from "../../src/lib/premiumFinance/quote";
import { PF_CONFIG_SHA256 } from "../../src/lib/premiumFinance/jurisdictions";

/**
 * The one way a loan originates.
 *
 * Extracted from pf-originate when W8 moved origination into the invoice
 * send: two writers of loans sharing the gates by convention is how gates
 * drift, and the whole point of this module is that they cannot. Sits
 * beside `pfPosting.ts` for the same reason that module exists.
 *
 * W8 changes carried here:
 *  - The anchor is a POLICY or a QUOTE — premium is billable, and
 *    financeable, before bind. The loan row carries whichever id anchors
 *    it; BIND_ROLLOVER sets policyId when the quote binds.
 *  - The MEP screen is gone (signed 2026-08-24): the agency lends its own
 *    capital and knowingly accepts early-default undersecurity on high-MEP
 *    policies. MEP stays recorded as underwriting data.
 *  - Everything else is verbatim: every rule logged pass or block, log
 *    rows land before the loan exists, and the create transacts with the
 *    kill switch.
 */

const AGENCY_SETTINGS_ID = "AGENCY";

export interface OriginationDecision {
  rule: string;
  outcome: "PASS" | "BLOCK" | "OVERRIDE";
  reason?: string;
  inputs: Record<string, unknown>;
}

export interface OriginationAnchor {
  kind: "policy" | "quote";
  id: string;
  lines: readonly (string | null | undefined)[];
  producerOfRecord: boolean | null | undefined;
  isAuditable: boolean | null | undefined;
}

export interface OriginationAccount {
  id: string;
  state: string | null | undefined;
  type: string | null | undefined;
  incorporated: boolean | null | undefined;
}

/**
 * Reads the core needs, supplied by the caller as closures so the core
 * works from any Lambda that has a data client — the mutation handler and
 * the invoice send both do.
 */
export interface OriginationReads {
  listOpinions(code: string): Promise<{ effectiveAt: string; reviewBy: string }[]>;
  /** ADMIN overrides on file for this anchor. Only AUDITABLE remains. */
  listOverrides(anchorId: string): Promise<{ check?: string | null; reason?: string | null }[]>;
}

export interface OriginationRequest {
  account: OriginationAccount;
  anchor: OriginationAnchor;
  /** The amount being financed — under W8, the invoiced total. */
  premium: number;
  downPct: number;
  months: number;
  apr: number;
  /** The schedule anchor — under W8, the invoice send date. */
  effectiveDate: string;
  actor: string;
  actorName: string;
}

export type OriginationResult =
  | { ok: true; loanId: string | null; blocks: { rule: string; reason: string }[] }
  | { ok: false; error: string };

const blocked = (decisions: OriginationDecision[]) =>
  decisions
    .filter((d) => d.outcome === "BLOCK")
    .map((d) => ({ rule: d.rule, reason: d.reason ?? "" }));

/**
 * Every rule evaluated becomes a row, pass or block — the record that shows
 * an examiner the control was operating, not just that it existed. Log
 * failures are loud but do not abort a BLOCK (refusing to lend needs no
 * audit row to be safe); an all-pass origination, however, requires its rows
 * to have landed — an unlogged loan must not exist, the same direction the
 * kill switch fails.
 */
async function writeDecisions(
  ddb: DynamoDBDocumentClient,
  ctx: { accountId: string; jurisdiction: string; actor: string; actorName: string },
  decisions: OriginationDecision[]
): Promise<boolean> {
  const table = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!table) {
    console.error("[pfOrigination] PF_COMPLIANCE_LOG_TABLE unset");
    return false;
  }
  const now = new Date().toISOString();
  let allLanded = true;
  for (const d of decisions) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: {
            id: randomUUID(),
            __typename: "PfComplianceLog",
            createdAt: now,
            updatedAt: now,
            accountId: ctx.accountId,
            jurisdiction: ctx.jurisdiction,
            rule: d.rule,
            outcome: d.outcome,
            reason: d.reason ?? null,
            inputs: JSON.stringify(d.inputs),
            configSha256: PF_CONFIG_SHA256,
            actor: ctx.actor,
            actorName: ctx.actorName,
            occurredAt: now,
          },
        })
      );
    } catch (err) {
      console.error(`[pfOrigination] log write failed for ${d.rule}`, err);
      allLanded = false;
    }
  }
  return allLanded;
}

export async function originateLoan(
  ddb: DynamoDBDocumentClient,
  reads: OriginationReads,
  moduleOn: boolean,
  req: OriginationRequest
): Promise<OriginationResult> {
  const { account, anchor } = req;

  /**
   * Conditional jurisdictions open only on a counsel opinion that is
   * within its review date (decision D). The gate itself stays pure; the
   * store is context.
   */
  const preGate = originationGate(account.state);
  let opinionCurrent = false;
  if (preGate.jurisdiction?.status === "conditional") {
    const opinions = await reads.listOpinions(preGate.jurisdiction.code);
    opinionCurrent = hasCurrentOpinion(opinions, new Date().toISOString().slice(0, 10));
  }
  const gate = originationGate(account.state, {
    hasCurrentCounselOpinion: opinionCurrent,
  });
  const ctx = {
    accountId: account.id,
    jurisdiction:
      gate.jurisdiction?.code ?? ((account.state ?? "").trim() || "UNKNOWN"),
    actor: req.actor,
    actorName: req.actorName,
  };
  const decisions: OriginationDecision[] = [];
  const terms = {
    [anchor.kind === "policy" ? "policyId" : "quoteId"]: anchor.id,
    premium: req.premium,
    downPct: req.downPct,
    months: req.months,
    apr: req.apr,
    effectiveDate: req.effectiveDate,
  };

  /**
   * The module flag, server-side, read by the caller moments ago and
   * decided here. A hidden button is not a gate; the transactional
   * ConditionCheck below is the enforcement, this row is the record.
   */
  decisions.push({
    rule: "module-flag",
    outcome: moduleOn ? "PASS" : "BLOCK",
    reason: moduleOn ? undefined : "Premium finance is switched off.",
    inputs: terms,
  });

  if (moduleOn) {
    // Jurisdiction gate: physical address state, and nothing else.
    decisions.push({
      rule: "jurisdiction-gate",
      outcome: gate.open ? "PASS" : "BLOCK",
      reason: gate.open ? undefined : gate.reason,
      inputs: { state: account.state, ...terms },
    });

    if (gate.open) {
      // The 25% floor: payment 1 of the schedule, collected at inception.
      const downProblem = downPctViolation(req.downPct);
      decisions.push({
        rule: "min-down",
        outcome: downProblem ? "BLOCK" : "PASS",
        reason: downProblem ?? undefined,
        inputs: terms,
      });

      // The quote is built BEFORE the cap decision since RI joined: a
      // fee-in-cap jurisdiction tests the effective rate, which only the
      // schedule can answer. buildQuote is pure; the order costs nothing.
      const quote = buildQuote({
        premium: req.premium,
        downPct: req.downPct,
        months: req.months,
        apr: req.apr,
        effectiveDate: req.effectiveDate,
      });
      const aprProblem = aprCapViolation(req.apr, gate.jurisdiction, quote);
      decisions.push({
        rule: "apr-cap",
        outcome: aprProblem ? "BLOCK" : "PASS",
        reason: aprProblem ?? undefined,
        inputs: terms,
      });
      const principalProblem = minPrincipalViolation(
        quote.amountFinanced,
        gate.jurisdiction
      );
      decisions.push({
        rule: "min-principal",
        outcome: principalProblem ? "BLOCK" : "PASS",
        reason: principalProblem ?? undefined,
        inputs: { ...terms, amountFinanced: quote.amountFinanced },
      });

      // The screens, with any ADMIN override on file (auditable only,
      // since the MEP screen retired).
      const overrideRows = await reads.listOverrides(anchor.id);
      const auditableOverride = overrideRows.find(
        (o) => o.check === "AUDITABLE" && o.reason?.trim()
      );
      const checks = evaluateEligibility({
        lines: anchor.lines,
        accountType: account.type,
        producerOfRecord: anchor.producerOfRecord,
        isAuditable: anchor.isAuditable,
        requiresIncorporatedBorrower:
          gate.jurisdiction.requiresIncorporatedBorrower ?? false,
        incorporated: account.incorporated,
        jurisdictionName: gate.jurisdiction.name,
        overrides: {
          auditable: auditableOverride
            ? { reason: auditableOverride.reason! }
            : undefined,
        },
      });
      for (const c of checks) {
        decisions.push({
          rule: c.check,
          outcome: c.overridden ? "OVERRIDE" : c.ok ? "PASS" : "BLOCK",
          reason: c.overridden
            ? `${c.reason} Overridden by admin: ${c.overridden}`
            : c.reason,
          inputs: terms,
        });
      }

      if (blocked(decisions).length === 0) {
        /**
         * All pass. The log rows must land before the loan exists — an
         * unlogged origination is the kill switch's failure mode wearing a
         * different hat, and it fails the same direction: no record, no
         * loan.
         */
        const logged = await writeDecisions(ddb, ctx, decisions);
        if (!logged) {
          return {
            ok: false,
            error: "The compliance log could not be written, so the quote was NOT issued.",
          };
        }
        /**
         * The create and the flag check are ONE transaction: a
         * ConditionCheck on the settings row rides with the loan Put, so a
         * disable that is durable when this commits makes the whole thing
         * fail — there is no window between "flag read true" and "loan
         * exists" at all.
         */
        const settingsTable = process.env.AGENCY_SETTINGS_TABLE;
        const loanTable = process.env.PF_LOAN_TABLE;
        if (!settingsTable || !loanTable) {
          return { ok: false, error: "Origination tables are not configured." };
        }
        const loanId = randomUUID();
        const nowIso = new Date().toISOString();
        try {
          await ddb.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: {
                    TableName: settingsTable,
                    Key: { id: AGENCY_SETTINGS_ID },
                    ConditionExpression: "premiumFinanceEnabled = :on",
                    ExpressionAttributeValues: { ":on": true },
                  },
                },
                {
                  Put: {
                    TableName: loanTable,
                    Item: {
                      id: loanId,
                      __typename: "PfLoan",
                      createdAt: nowIso,
                      updatedAt: nowIso,
                      accountId: account.id,
                      ...(anchor.kind === "policy"
                        ? { policyId: anchor.id }
                        : { quoteId: anchor.id }),
                      status: "QUOTED",
                      state: gate.jurisdiction.code,
                      configSha256: PF_CONFIG_SHA256,
                      premium: req.premium,
                      downPct: req.downPct,
                      months: req.months,
                      apr: req.apr,
                      effectiveDate: req.effectiveDate,
                      downPayment: quote.downPayment,
                      amountFinanced: quote.amountFinanced,
                      payment: quote.payment,
                      totalInterest: quote.totalInterest,
                      originationFee: quote.originationFee,
                      schedule: JSON.stringify(quote.schedule),
                      balance: quote.amountFinanced,
                      nextDueAt: quote.schedule[0]?.dueDate ?? null,
                      paidThrough: 0,
                      quotedBy: req.actor,
                      quotedByName: req.actorName,
                      quotedAt: nowIso,
                    },
                  },
                },
              ],
            })
          );
        } catch (err) {
          const canceled = err as {
            name?: string;
            CancellationReasons?: { Code?: string }[];
          };
          /**
           * Only the flag check LOSING may write the kill-switch story: a
           * TransactionConflict (two sends condition-checking the same
           * settings row) or throttling cancels the transaction with the
           * flag untouched, and blaming the switch would fabricate an
           * audit record in a table built for examiners. Those cases fail
           * soft toward "no offer this send" — nothing was written, the
           * next send retries the world.
           */
          if (canceled.name === "TransactionCanceledException") {
            if (canceled.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
              await writeDecisions(ddb, ctx, [
                {
                  rule: "module-flag",
                  outcome: "BLOCK",
                  reason: "Premium finance was switched off during evaluation.",
                  inputs: terms,
                },
              ]);
              return {
                ok: true,
                loanId: null,
                blocks: [
                  {
                    rule: "module-flag",
                    reason: "Premium finance was switched off during evaluation.",
                  },
                ],
              };
            }
            console.warn(
              `[pfOrigination] loan create transaction cancelled without a flag refusal (${canceled.CancellationReasons?.map((r) => r?.Code).join(",")}); no loan, no log`
            );
            return { ok: false, error: "The origination didn't commit — nothing changed. Try again." };
          }
          throw err;
        }
        console.log(
          `[pfOrigination] quoted ${loanId} (${gate.jurisdiction.code}, $${quote.amountFinanced} @ ${req.apr}%, ${anchor.kind} ${anchor.id}) by ${req.actorName}`
        );
        return { ok: true, loanId, blocks: [] };
      }
    }
  }

  // Blocked somewhere. Log everything evaluated; refusal is safe even if
  // the log write is not, so a log failure here is loud but not fatal.
  await writeDecisions(ddb, ctx, decisions);
  return { ok: true, loanId: null, blocks: blocked(decisions) };
}

import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Schema } from "../../data/resource";
import {
  aprCapViolation,
  hasCurrentOpinion,
  minPrincipalViolation,
  originationGate,
} from "../../../src/lib/premiumFinance/gate";
import { evaluateEligibility } from "../../../src/lib/premiumFinance/eligibility";
import { buildQuote, downPctViolation } from "../../../src/lib/premiumFinance/quote";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";
import { isRealIsoDay } from "../../../src/lib/premiumFinance/noticeSequence";

/**
 * Custom mutation handler: issueFinanceQuote. See resource.ts.
 *
 * The browser ran all of this already; that was theater. This is the gate.
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

const AGENCY_SETTINGS_ID = "AGENCY";

interface Decision {
  rule: string;
  outcome: "PASS" | "BLOCK" | "OVERRIDE";
  reason?: string;
  inputs: Record<string, unknown>;
}

interface Ctx {
  accountId: string | null;
  jurisdiction: string;
  actor: string;
  actorName: string;
}

/**
 * Every rule evaluated becomes a row, pass or block — the record that shows
 * an examiner the control was operating, not just that it existed. Log
 * failures are loud but do not abort a BLOCK (refusing to lend needs no
 * audit row to be safe); an all-pass origination, however, requires its rows
 * to have landed — an unlogged loan must not exist, the same direction the
 * kill switch fails.
 */
async function writeDecisions(ctx: Ctx, decisions: Decision[]): Promise<boolean> {
  const table = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!table) {
    console.error("[pf-originate] PF_COMPLIANCE_LOG_TABLE unset");
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
      allLanded = false;
      console.error(`[pf-originate] log write failed for rule ${d.rule}`, err);
    }
  }
  return allLanded;
}

const blocked = (decisions: Decision[]) =>
  decisions
    .filter((d) => d.outcome === "BLOCK")
    .map((d) => ({ rule: d.rule, reason: d.reason ?? "" }));

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

  try {
    const client = await getDataClient();

    const { data: policy } = await client.models.Policy.get({ id: a.policyId });
    if (!policy) return { ok: false, error: "That policy no longer exists." };
    const { data: account } = await client.models.Account.get({
      id: policy.accountId,
    });
    if (!account) return { ok: false, error: "That account no longer exists." };

    /**
     * Conditional jurisdictions open only on a counsel opinion that is
     * within its review date, read here from the store (decision D). The
     * gate itself stays pure; the store is context.
     */
    const preGate = originationGate(account.state);
    let opinionCurrent = false;
    if (preGate.jurisdiction?.status === "conditional") {
      const { data: opinions } = await client.models.PfCounselOpinion.list({
        filter: { jurisdiction: { eq: preGate.jurisdiction.code } },
        limit: 100,
      });
      opinionCurrent = hasCurrentOpinion(
        opinions.map((o) => ({ effectiveAt: o.effectiveAt, reviewBy: o.reviewBy })),
        new Date().toISOString().slice(0, 10)
      );
    }
    const gate = originationGate(account.state, {
      hasCurrentCounselOpinion: opinionCurrent,
    });
    const ctx: Ctx = {
      accountId: account.id,
      jurisdiction:
        gate.jurisdiction?.code ?? ((account.state ?? "").trim() || "UNKNOWN"),
      actor,
      actorName,
    };
    const decisions: Decision[] = [];
    const terms = {
      policyId: a.policyId,
      premium: a.premium,
      downPct: a.downPct,
      months: a.months,
      apr: a.apr,
      effectiveDate: a.effectiveDate,
    };

    /**
     * The module flag, server-side. A hidden button is not a gate: the flag
     * is re-read here on every origination, so flipping it off stops quoting
     * for everyone the moment the flip lands, open browser tabs included.
     */
    const { data: settings } = await client.models.AgencySettings.get({
      id: AGENCY_SETTINGS_ID,
    });
    const moduleOn = settings?.premiumFinanceEnabled === true;
    decisions.push({
      rule: "module-flag",
      outcome: moduleOn ? "PASS" : "BLOCK",
      reason: moduleOn ? undefined : "Premium finance is switched off.",
      inputs: terms,
    });

    if (moduleOn) {
      // Jurisdiction gate: physical address state, and nothing else.
      // Conditional stays blocked until the opinion store (W6) can vouch.
      decisions.push({
        rule: "jurisdiction-gate",
        outcome: gate.open ? "PASS" : "BLOCK",
        reason: gate.open ? undefined : gate.reason,
        inputs: { state: account.state, ...terms },
      });

      if (gate.open) {
        // The 25% floor: payment 1 of the schedule, collected at inception.
        const downProblem = downPctViolation(a.downPct);
        decisions.push({
          rule: "min-down",
          outcome: downProblem ? "BLOCK" : "PASS",
          reason: downProblem ?? undefined,
          inputs: terms,
        });

        // The quote is built BEFORE the cap decision since RI joined: a
        // fee-in-cap jurisdiction tests the effective rate, which only the
        // schedule can answer. buildQuote is pure; the order costs nothing.
        const quote = buildQuote(terms);
        const aprProblem = aprCapViolation(a.apr, gate.jurisdiction, quote);
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

        // The four screens, with any ADMIN overrides on file.
        const { data: overrideRows } = await client.models.PfOverride.list({
          filter: { policyId: { eq: a.policyId } },
          limit: 100,
        });
        const overrides = {
          mep: overrideRows.find((o) => o.check === "MEP" && o.reason?.trim()),
          auditable: overrideRows.find(
            (o) => o.check === "AUDITABLE" && o.reason?.trim()
          ),
        };
        const checks = evaluateEligibility({
          lines: policy.lines ?? [],
          accountType: account.type,
          producerOfRecord: policy.producerOfRecord,
          minimumEarnedPremiumPct: policy.minimumEarnedPremiumPct,
          isAuditable: policy.isAuditable,
          requiresIncorporatedBorrower:
            gate.jurisdiction.requiresIncorporatedBorrower ?? false,
          incorporated: account.incorporated,
          jurisdictionName: gate.jurisdiction.name,
          downPct: a.downPct,
          overrides: {
            mep: overrides.mep ? { reason: overrides.mep.reason } : undefined,
            auditable: overrides.auditable
              ? { reason: overrides.auditable.reason }
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
          const logged = await writeDecisions(ctx, decisions);
          if (!logged) {
            return {
              ok: false,
              error:
                "The compliance log could not be written, so the quote was NOT issued.",
            };
          }
          /**
           * The flag, again, at the last possible moment. The first read was
           * seconds ago — override lookups, opinion reads and log writes sit
           * between it and this create — and counsel's disable landing in
           * that window must win. A cross-table transaction doesn't exist
           * here; this recheck shrinks the race to the create call itself,
           * and the kill switch's own semantics (stop NEW originations)
           * tolerate nothing wider.
           */
          /**
           * The create and the flag check are ONE transaction: a
           * ConditionCheck on the settings row rides with the loan Put, so a
           * disable that is durable when this commits makes the whole thing
           * fail — there is no window between "flag read true" and "loan
           * exists" at all. The earlier separate recheck shrank the race;
           * TransactWriteItems removes it.
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
                        policyId: a.policyId,
                        status: "QUOTED",
                        state: gate.jurisdiction.code,
                        configSha256: PF_CONFIG_SHA256,
                        premium: a.premium,
                        downPct: a.downPct,
                        months: a.months,
                        apr: a.apr,
                        effectiveDate: a.effectiveDate,
                        downPayment: quote.downPayment,
                        amountFinanced: quote.amountFinanced,
                        payment: quote.payment,
                        totalInterest: quote.totalInterest,
                        originationFee: quote.originationFee,
                        schedule: JSON.stringify(quote.schedule),
                        balance: quote.amountFinanced,
                        nextDueAt: quote.schedule[0]?.dueDate ?? null,
                        paidThrough: 0,
                        quotedBy: actor,
                        quotedByName: actorName,
                        quotedAt: nowIso,
                      },
                    },
                  },
                ],
              })
            );
          } catch (err) {
            if ((err as { name?: string }).name === "TransactionCanceledException") {
              await writeDecisions(ctx, [
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
                  { rule: "module-flag", reason: "Premium finance was switched off during evaluation." },
                ],
              };
            }
            throw err;
          }
          const loan = { id: loanId };
          console.log(
            `pf-originate: quoted ${loan.id} (${gate.jurisdiction.code}, $${quote.amountFinanced} @ ${a.apr}%) by ${actorName}`
          );
          return { ok: true, loanId: loan.id, blocks: [] };
        }
      }
    }

    // Blocked somewhere. Log everything evaluated; refusal is safe even if
    // the log write is not, so a log failure here is loud but not fatal.
    await writeDecisions(ctx, decisions);
    return { ok: true, loanId: null, blocks: blocked(decisions) };
  } catch (err) {
    console.error("pf-originate failed", err);
    return { ok: false, error: "Couldn't evaluate that quote. Try again." };
  }
};

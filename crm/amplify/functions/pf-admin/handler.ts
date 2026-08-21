import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";

/**
 * Custom mutation handler: setPremiumFinanceEnabled. See resource.ts.
 *
 * AppSync enforces the ADMIN group before this runs; the identity block still
 * names the actor for the log. Direct table writes, because the flip and its
 * audit row must both come from this one place.
 *
 * ── The directions are asymmetric, on purpose ───────────────────────────────
 * ENABLE is atomic with its log: if the log write fails after retries, the
 * flip is reverted and reported as not made — turning lending ON without a
 * record is the thing this Lambda exists to prevent, and the revert leaves
 * the module off, which is the safe state.
 *
 * DISABLE is unconditional: the flag goes off FIRST and stays off whatever
 * happens to the log. The disable path exists for the moment counsel says
 * stop, and a DynamoDB hiccup on the audit write must not turn lending back
 * on at exactly that moment. A failed log on disable is surfaced loudly and
 * left to be recorded by hand; it is never grounds to restore the flag.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/** The one AgencySettings row — the same fixed id the app addresses. */
const AGENCY_SETTINGS_ID = "AGENCY";

const LOG_ATTEMPTS = 3;

interface AppSyncIdentity {
  sub?: string;
  username?: string;
  claims?: Record<string, unknown>;
}

export const handler = async (event: {
  arguments?: { enabled?: boolean };
  identity?: AppSyncIdentity;
}): Promise<{ ok: boolean; enabled?: boolean; error?: string; warning?: string }> => {
  const enabled = event.arguments?.enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "enabled must be true or false." };
  }
  const settingsTable = process.env.AGENCY_SETTINGS_TABLE;
  const logTable = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!settingsTable || !logTable) {
    console.error("[pf-admin] table env unset");
    return { ok: false, error: "Premium finance admin is not configured." };
  }

  const actor = event.identity?.sub ?? "unknown";
  const actorName =
    (typeof event.identity?.claims?.email === "string"
      ? event.identity.claims.email
      : null) ??
    event.identity?.username ??
    actor;
  const now = new Date().toISOString();

  /**
   * The disable write is unconditional — off always wins — but ENABLE is
   * conditional on the flag not having moved since this invocation began:
   * an enable that raced a disable and would land second must lose, or
   * lending is on while the latest audit row says DISABLED.
   */
  const readStamp = async (): Promise<string | null> => {
    const res = await ddb.send(
      new GetCommand({ TableName: settingsTable, Key: { id: AGENCY_SETTINGS_ID } })
    );
    const v = res.Item?.premiumFinanceEnabledAt;
    return typeof v === "string" ? v : null;
  };

  const writeFlag = (value: boolean, seenStamp?: string | null) =>
    ddb.send(
      new UpdateCommand({
        TableName: settingsTable,
        Key: { id: AGENCY_SETTINGS_ID },
        UpdateExpression:
          "SET premiumFinanceEnabled = :v, premiumFinanceEnabledAt = :now, updatedBy = :by, updatedAt = :now",
        ExpressionAttributeValues: {
          ":v": value,
          ":by": actor,
          ":now": now,
          ...(seenStamp !== undefined && seenStamp !== null ? { ":seen": seenStamp } : {}),
        },
        ...(seenStamp !== undefined
          ? {
              ConditionExpression:
                seenStamp === null
                  ? "attribute_not_exists(premiumFinanceEnabledAt)"
                  : "premiumFinanceEnabledAt = :seen",
            }
          : {}),
      })
    );

  const writeLog = async (): Promise<boolean> => {
    const item = {
      id: randomUUID(),
      // AppSync needs these to read raw-written rows back through the model
      // without nulling non-null fields.
      __typename: "PfComplianceLog",
      createdAt: now,
      updatedAt: now,
      jurisdiction: "ALL",
      rule: "module-flag",
      outcome: enabled ? "ENABLED" : "DISABLED",
      reason: `Premium finance module switched ${enabled ? "on" : "off"}`,
      inputs: JSON.stringify({ enabled }),
      /**
       * The hash of the signed ruleset in force at the moment of the
       * decision. The admin screen's SHA answers "what is production running
       * today"; this answers the regulator's actual question — which signed
       * file governed a specific decision, months and re-signings later.
       * Every PfComplianceLog row carries it, from every writer.
       */
      configSha256: PF_CONFIG_SHA256,
      actor,
      actorName,
      occurredAt: now,
    };
    for (let attempt = 1; attempt <= LOG_ATTEMPTS; attempt++) {
      try {
        await ddb.send(new PutCommand({ TableName: logTable, Item: item }));
        return true;
      } catch (err) {
        console.error(`[pf-admin] log write attempt ${attempt} failed`, err);
        if (attempt < LOG_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
    }
    return false;
  };

  try {
    /**
     * ENABLE: log first, flip second. The invariant is "flag on ⇒ row
     * exists", and ordering guarantees it absolutely — the earlier
     * flip-then-revert left a hole where the revert itself failed and the
     * flag stood unlogged. A row for a flip that then fails is the safe
     * direction, and gets a best-effort correction row.
     */
    if (enabled) {
      const seenStamp = await readStamp();
      const logged = await writeLog();
      if (!logged) {
        return {
          ok: false,
          error: "The change could not be logged, so lending was NOT enabled.",
        };
      }
      try {
        await writeFlag(true, seenStamp);
      } catch (err) {
        const lost = (err as { name?: string }).name === "ConditionalCheckFailedException";
        /**
         * A thrown write is not necessarily an unapplied write — the commit
         * can land and the response be lost. Before recording a DISABLED
         * correction (which would then sit as the latest row over a flag
         * that is ON), read what is actually there and report THAT.
         */
        if (!lost) {
          try {
            const check = await ddb.send(
              new GetCommand({ TableName: settingsTable, Key: { id: AGENCY_SETTINGS_ID } })
            );
            if (check.Item?.premiumFinanceEnabled === true) {
              console.warn("[pf-admin] flip response was lost but the write landed; enable stands");
              return { ok: true, enabled: true };
            }
          } catch (checkErr) {
            console.error("[pf-admin] could not verify flag state after failed flip", checkErr);
          }
        }
        console.error(
          lost
            ? "[pf-admin] enable lost to a concurrent flip; module state unchanged by this call"
            : "[pf-admin] flip failed after logging; module remains off",
          err
        );
        try {
          await ddb.send(
            new PutCommand({
              TableName: logTable,
              Item: {
                id: randomUUID(),
                __typename: "PfComplianceLog",
                createdAt: now,
                updatedAt: now,
                jurisdiction: "ALL",
                rule: "module-flag",
                outcome: "DISABLED",
                reason: "Enable was logged but the flag write failed; the module remains OFF.",
                inputs: JSON.stringify({ enabled: false }),
                configSha256: PF_CONFIG_SHA256,
                actor,
                actorName,
                occurredAt: now,
              },
            })
          );
        } catch (corrErr) {
          console.error("[pf-admin] correction row also failed", corrErr);
        }
        return { ok: false, error: "Couldn't enable the module. Try again." };
      }
      console.log(`pf-admin: premium finance ENABLED by ${actorName}`);
      return { ok: true, enabled: true };
    }

    // DISABLE: flag first, unconditionally — off always wins.
    await writeFlag(false);
    const logged = await writeLog();
    if (!logged) {
      // The module is OFF and stays off. Never restore the flag over a log.
      console.error(
        "[pf-admin] LOG WRITE FAILED ON DISABLE — module is OFF; record this flip manually"
      );
      return {
        ok: true,
        enabled: false,
        warning:
          "The module is OFF, but the audit log write failed. Record this flip manually and tell engineering.",
      };
    }

    console.log(`pf-admin: premium finance DISABLED by ${actorName}`);
    return { ok: true, enabled: false };
  } catch (err) {
    console.error("pf-admin failed", err);
    return { ok: false, error: "Couldn't change the setting. Try again." };
  }
};

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
  let now = new Date().toISOString();

  /**
   * ISO now, clamped strictly past `floor`. occurredAt is the log's only
   * ordering, so a row recording a later event must carry a later stamp
   * even when the wall clocks that produced the two disagree by a second.
   */
  const isoAfter = (floor: string | null): string => {
    const t = new Date().toISOString();
    if (!floor || t > floor) return t;
    const ms = Date.parse(floor);
    return Number.isFinite(ms) ? new Date(ms + 1).toISOString() : t;
  };

  /**
   * The disable write is unconditional — off always wins — but ENABLE is
   * conditional on the flag not having moved since this invocation began:
   * an enable that raced a disable and would land second must lose, or
   * lending is on while the latest audit row says DISABLED.
   */
  const readStamp = async (): Promise<string | null> => {
    const res = await ddb.send(
      new GetCommand({
        TableName: settingsTable,
        Key: { id: AGENCY_SETTINGS_ID },
        // Strong: a replica's stale stamp would widen the race this
        // condition exists to close.
        ConsistentRead: true,
      })
    );
    const v = res.Item?.premiumFinanceEnabledAt;
    return typeof v === "string" ? v : null;
  };

  const writeFlag = async (value: boolean, seenStamp?: string | null): Promise<string | null> => {
    const res = await ddb.send(
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
        // The stamp this write overwrote — the ordering floor at the exact
        // serialization point, for free.
        ReturnValues: "UPDATED_OLD",
      })
    );
    const v = (res.Attributes as Record<string, unknown> | undefined)?.premiumFinanceEnabledAt;
    return typeof v === "string" ? v : null;
  };

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
      /**
       * The stamp this enable builds on can carry a LATER wall clock than
       * this invocation's start — a racing disable on a machine a second
       * ahead. An ENABLED row sorting BEFORE the DISABLED state it
       * supersedes reads, months later, as lending on under a latest row
       * that says off. The timestamp is therefore taken after the read and
       * clamped strictly past the stamp.
       */
      now = isoAfter(seenStamp);
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
         * can land and the response be lost. And a lost CONDITION is not
         * necessarily a module that is off: the flip that beat this one may
         * itself have been an enable — another admin, or the SDK retrying
         * this call's own landed write against the stamp it had already
         * moved. So EVERY failed flip verifies before it corrects, and the
         * read is strong: an eventually-consistent read here can echo the
         * pre-write value and manufacture exactly the false DISABLED row
         * this check exists to prevent.
         */
        let verifiedOff = false;
        let verifiedStamp: string | null = null;
        try {
          const check = await ddb.send(
            new GetCommand({
              TableName: settingsTable,
              Key: { id: AGENCY_SETTINGS_ID },
              ConsistentRead: true,
            })
          );
          if (check.Item?.premiumFinanceEnabled === true) {
            console.warn(
              lost
                ? "[pf-admin] enable lost its condition, but the module is ON; the ENABLED row stands"
                : "[pf-admin] flip response was lost but the write landed; enable stands"
            );
            return { ok: true, enabled: true };
          }
          verifiedOff = true;
          const vs = check.Item?.premiumFinanceEnabledAt;
          verifiedStamp = typeof vs === "string" ? vs : null;
        } catch (checkErr) {
          console.error("[pf-admin] could not verify flag state after failed flip", checkErr);
        }
        console.error(
          lost
            ? "[pf-admin] enable lost to a concurrent flip; module state unchanged by this call"
            : "[pf-admin] flip failed after logging; module remains off",
          err
        );
        if (!verifiedOff) {
          /**
           * State unknown — the flip failed AND the verify failed. A
           * DISABLED row here could be the false record over an ON flag;
           * writing nothing leaves the ENABLED row over a flag that may be
           * off, which a retry re-syncs. Of the two, only one fabricates.
           */
          return {
            ok: false,
            error:
              "Couldn't enable the module, and its state couldn't be verified. Check the admin screen and try again.",
          };
        }
        /**
         * The correction rides a transaction with a stamp bump on the
         * settings row, conditioned on the exact (off, stamp) state the
         * verify saw. Three windows close at once: a concurrent enable
         * committing between verify and correction cancels the whole
         * transaction (no DISABLED row over an ON flag); this call's own
         * still-in-flight flip can never land afterwards (its stamp
         * condition is now stale); and a retried enable clamps past the
         * bumped floor, so its ENABLED row sorts after this correction
         * instead of vanishing behind it.
         */
        /**
         * The correction retries once with a re-read stamp: a cancellation
         * caused by a concurrent DISABLE moving the stamp — flag still off —
         * used to abandon the correction, leaving this call's ENABLED row as
         * the loose end a skewed clock could sort last. Two attempts, then
         * the loud failure.
         */
        for (let attempt = 1; attempt <= 2; attempt++) {
          const correctedAt = isoAfter(
            verifiedStamp !== null && verifiedStamp > now ? verifiedStamp : now
          );
          try {
            await ddb.send(
              new TransactWriteCommand({
                TransactItems: [
                  {
                    Update: {
                      TableName: settingsTable,
                      Key: { id: AGENCY_SETTINGS_ID },
                      UpdateExpression: "SET premiumFinanceEnabledAt = :at",
                      ConditionExpression:
                        verifiedStamp === null
                          ? "(attribute_not_exists(premiumFinanceEnabled) OR premiumFinanceEnabled = :off) AND attribute_not_exists(premiumFinanceEnabledAt)"
                          : "(attribute_not_exists(premiumFinanceEnabled) OR premiumFinanceEnabled = :off) AND premiumFinanceEnabledAt = :seenOff",
                      ExpressionAttributeValues: {
                        ":at": correctedAt,
                        ":off": false,
                        ...(verifiedStamp !== null ? { ":seenOff": verifiedStamp } : {}),
                      },
                    },
                  },
                  {
                    Put: {
                      TableName: logTable,
                      Item: {
                        id: randomUUID(),
                        __typename: "PfComplianceLog",
                        createdAt: correctedAt,
                        updatedAt: correctedAt,
                        jurisdiction: "ALL",
                        rule: "module-flag",
                        outcome: "DISABLED",
                        reason: lost
                          ? "Enable was logged but lost to a concurrent flip; the module is OFF."
                          : "Enable was logged but the flag write failed; the module remains OFF.",
                        inputs: JSON.stringify({ enabled: false }),
                        configSha256: PF_CONFIG_SHA256,
                        actor,
                        actorName,
                        occurredAt: correctedAt,
                      },
                    },
                  },
                ],
              })
            );
            return { ok: false, error: "Couldn't enable the module. Try again." };
          } catch (corrErr) {
            if ((corrErr as { name?: string }).name !== "TransactionCanceledException") {
              console.error("[pf-admin] correction did not commit", corrErr);
              break;
            }
            // The state moved in the window. If it moved to ON, the admin's
            // ask is in effect — converge instead of reporting a failure. If
            // it is still OFF under a new stamp, retry against that stamp.
            try {
              const again = await ddb.send(
                new GetCommand({
                  TableName: settingsTable,
                  Key: { id: AGENCY_SETTINGS_ID },
                  ConsistentRead: true,
                })
              );
              if (again.Item?.premiumFinanceEnabled === true) {
                console.warn("[pf-admin] flag turned ON while correcting; the ENABLED row stands");
                return { ok: true, enabled: true };
              }
              const vs = again.Item?.premiumFinanceEnabledAt;
              verifiedStamp = typeof vs === "string" ? vs : null;
            } catch (reErr) {
              console.error("[pf-admin] re-verify after cancelled correction failed", reErr);
              break;
            }
          }
        }
        console.error("[pf-admin] correction never committed; the ENABLED row stands uncorrected");
        return { ok: false, error: "Couldn't enable the module. Try again." };
      }
      console.log(`pf-admin: premium finance ENABLED by ${actorName}`);
      return { ok: true, enabled: true };
    }

    // DISABLE: flag first, unconditionally — off always wins.
    const oldStamp = await writeFlag(false);
    /**
     * The DISABLED row must sort after the state it ends. The flag write
     * just returned the stamp it overwrote — a fresher clock's enable
     * would otherwise leave its ENABLED row out-sorting this one forever,
     * over a module that is off. The floor bump is conditional on our own
     * write still standing: if an enable already flipped the flag back,
     * the ordering is theirs, and this row keeps the invocation clock so
     * it sorts BEFORE their ENABLED row — the truthful order, since their
     * enable serialized after this disable.
     */
    if (oldStamp !== null && now <= oldStamp) {
      const bumped = isoAfter(oldStamp);
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: settingsTable,
            Key: { id: AGENCY_SETTINGS_ID },
            UpdateExpression: "SET premiumFinanceEnabledAt = :bumped",
            ConditionExpression:
              "premiumFinanceEnabled = :off AND premiumFinanceEnabledAt = :ours",
            ExpressionAttributeValues: { ":bumped": bumped, ":off": false, ":ours": now },
          })
        );
        now = bumped;
      } catch (bumpErr) {
        if ((bumpErr as { name?: string }).name !== "ConditionalCheckFailedException") {
          console.error(
            "[pf-admin] stamp bump failed; the DISABLED row keeps the invocation clock",
            bumpErr
          );
        }
      }
    }
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
    /**
     * The response reports what is durably true NOW, not what was true at
     * this call's serialization point. An enable that legally serialized
     * after this disable leaves the module ON — the audit trail is already
     * consistent (their ENABLED row clamps past our stamp), but an admin
     * told "disabled" while the switch sits enabled would act on a lie.
     * Best effort: an unreadable flag reports the disable this call made.
     */
    try {
      const finalRead = await ddb.send(
        new GetCommand({
          TableName: settingsTable,
          Key: { id: AGENCY_SETTINGS_ID },
          ConsistentRead: true,
        })
      );
      if (finalRead.Item?.premiumFinanceEnabled === true) {
        return {
          ok: true,
          enabled: true,
          warning:
            "This disable landed and was logged — but another admin has re-enabled the module since. It is ON now.",
        };
      }
    } catch (err) {
      console.error("[pf-admin] final state read failed; reporting the disable as made", err);
    }
    return { ok: true, enabled: false };
  } catch (err) {
    console.error("pf-admin failed", err);
    return { ok: false, error: "Couldn't change the setting. Try again." };
  }
};

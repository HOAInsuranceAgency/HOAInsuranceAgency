/**
 * One-time migration: Account columns → the child rows that replace them.
 *
 * Run against a deployed backend with `tsx`, staging first and `main` only
 * after staging's output has been read:
 *
 *   npx tsx scripts/backfill-lead-expansion.ts            # dry run, writes nothing
 *   npx tsx scripts/backfill-lead-expansion.ts --apply
 *   npx tsx scripts/backfill-lead-expansion.ts --apply --account <id>
 *
 * ## Where it sits in the rollout
 *
 * The ordering in docs/specs/lead-client-expansion.md is what keeps this
 * reversible, and it is not negotiable:
 *
 *   1. Add the new models. Deploy.               ← W1, W3 and W5 did this
 *   2. Run this, dry, and read the summary.
 *   3. Run it with --apply. Verify.
 *   4. Ship the UI reading the new rows.         ← W1, W3 and W5 did this too
 *   5. Only then delete the old columns.         ← NOT DONE YET
 *
 * Steps 1 and 4 landed together because the UI half is what makes the columns
 * unread, and a column nothing reads is a column that cannot drift while this
 * runs. Step 5 is a separate commit, deliberately: dropping a field from an
 * Amplify model does not delete the DynamoDB attribute, so until something
 * overwrites it the whole workstream is revertible by putting the fields back.
 * Nothing in W1, W3 or W5 writes to a column it is about to drop. Keep it that
 * way.
 *
 * ## What it covers
 *
 * | Columns on Account | Becomes |
 * |---|---|
 * | `contactFirstName`/`contactLastName`/`contactEmail`/`contactPhone` | one primary `Contact` |
 * | `inspectionContactName`/`inspectionContactPhone` | one INSPECTION `Contact` |
 * | `priorCarrierName`/`priorPolicyNumber`/`priorPremium`/`priorTermEffective`/`priorTermExpiration` | one General Liability `PriorCarrier` |
 * | `yearBuilt`/`stories`/`constructionType`/the four update years | one `Building`, or the empty fields of every existing one |
 *
 * That last row is the one the spec warns about, and it is the reason this
 * script prints a warning block rather than only a tally. An account-level
 * "roof updated 2019" is a fact about whichever building somebody had in
 * mind, and copying it onto all thirteen asserts it of twelve nobody checked.
 * The information about which building it described was never recorded, so
 * there is nothing better available — what the script does instead is fill
 * only EMPTY fields, never overwrite a typed value, and name every account
 * where the fan-out happened so the dry run can be read rather than skimmed.
 *
 * ## Authentication
 *
 * `authMode: "iam"`, against whatever AWS credentials are in the environment
 * (`AWS_PROFILE`, or the usual chain). Not a user session: the CRM signs in
 * with a Cognito magic link, which a script cannot complete. The foot of
 * `amplify/data/resource.ts` explains why IAM works here — Amplify sets
 * `enableIamAuthorizationMode: true`, under which `@auth` rules do not apply
 * to an IAM principal. That is the same property that makes the model-level
 * rules unable to constrain the granted Lambdas, and it is worth being aware
 * that this script is therefore *not* limited by any rule in that file.
 *
 * ## Idempotence
 *
 * Every row this creates carries `extractionSourceKey: "backfill:<model>"`.
 * A second run reads those back and skips the account. That is asserted by
 * running it twice and confirming the second run's tally is all zeros — do
 * that, rather than assuming it.
 */
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import outputs from "../amplify_outputs.json";
import type { Schema } from "../amplify/data/resource";
import { listAllPages } from "../src/lib/pagination";
import { DEFAULT_CONTACT_TYPE } from "../src/lib/enums";

Amplify.configure(outputs);
const client = generateClient<Schema>({ authMode: "iam" });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY = args[args.indexOf("--account") + 1];
const only = args.includes("--account") ? ONLY : null;

/** Provenance markers. One per row this script can create. */
const PRIMARY_KEY = "backfill:contact";
const INSPECTION_KEY = "backfill:inspection";
const PRIOR_CARRIER_KEY = "backfill:priorcarrier";
const BUILDING_KEY = "backfill:building";

/**
 * The line the five prior-carrier columns described.
 *
 * Not a guess: those columns fed `PriorCoverage_GeneralLiability_*` on the
 * ACORD 125 and nothing else, so General Liability is what they *were*,
 * whatever the agency may have been using them for in practice. Producing a
 * row with a blank line would be more honest about the uncertainty and less
 * useful — it would fill no prior-coverage row at all, which is a regression
 * against what the account's submissions print today.
 */
const BACKFILLED_LINE = "General Liability";

const trim = (v: string | null | undefined) => v?.trim() || null;

type TargetModel = "Contact" | "PriorCarrier" | "Building";

interface Planned {
  accountId: string;
  accountName: string;
  model: TargetModel;
  action: "create" | "update" | "skip";
  reason: string;
  /** Set on an update: the row being changed. */
  id?: string;
  row?: Record<string, unknown>;
  /** Louder than a row of values — see the fan-out warning in main(). */
  warning?: string;
}

async function plan(): Promise<Planned[]> {
  const accounts = await listAllPages((nextToken) =>
    client.models.Account.list({ nextToken })
  );
  const relevant = only ? accounts.filter((a) => a.id === only) : accounts;
  console.log(`Scanning ${relevant.length} account(s).\n`);

  const planned: Planned[] = [];

  for (const a of relevant) {
    // Read per account rather than listing the whole Contact table: this runs
    // once, and the account-scoped read is the one the app itself makes.
    const existing = await listAllPages((nextToken) =>
      client.models.Contact.list({
        filter: { accountId: { eq: a.id } },
        nextToken,
      })
    );
    const already = new Set(
      existing.map((c) => c.extractionSourceKey).filter(Boolean) as string[]
    );

    // ── The primary contact, from the four flat columns ──
    const name =
      [trim(a.contactFirstName), trim(a.contactLastName)].filter(Boolean).join(" ") ||
      null;
    const email = trim(a.contactEmail);
    const phone = trim(a.contactPhone);
    if (!name && !email && !phone) {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        model: "Contact",
        action: "skip",
        reason: "no contact columns set",
      });
    } else if (already.has(PRIMARY_KEY)) {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        model: "Contact",
        action: "skip",
        reason: "primary contact already backfilled",
      });
    } else {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        model: "Contact",
        action: "create",
        reason: "primary contact from contact* columns",
        row: {
          accountId: a.id,
          // `name` is required on the model. An account carrying only an
          // email or only a phone still describes a real person to call, and
          // the account's own name is the honest placeholder — better than
          // dropping the phone number the agency has been using.
          name: name ?? a.name,
          email,
          phone,
          type: DEFAULT_CONTACT_TYPE,
          // Nothing else on the account is primary — these columns *were* the
          // insured contact, so this row inherits that role.
          isPrimary: !existing.some((c) => c.isPrimary),
          extractionSourceKey: PRIMARY_KEY,
        },
      });
    }

    // ── The inspection contact, from its own pair ──
    const inspName = trim(a.inspectionContactName);
    const inspPhone = trim(a.inspectionContactPhone);
    if (!inspName && !inspPhone) {
      // Nothing to say — the common case, and printing a line per account for
      // it would bury the rows that matter.
    } else if (already.has(INSPECTION_KEY)) {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        model: "Contact",
        action: "skip",
        reason: "inspection contact already backfilled",
      });
    } else {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        model: "Contact",
        action: "create",
        reason: "inspection contact from inspectionContact* columns",
        row: {
          accountId: a.id,
          name: inspName ?? a.name,
          phone: inspPhone,
          type: "INSPECTION",
          isPrimary: false,
          extractionSourceKey: INSPECTION_KEY,
        },
      });
    }

    // ── The incumbent policy, from the five prior* columns ──
    const priorExisting = await listAllPages((nextToken) =>
      client.models.PriorCarrier.list({
        filter: { accountId: { eq: a.id } },
        nextToken,
      })
    );
    const carrier = trim(a.priorCarrierName);
    const policyNumber = trim(a.priorPolicyNumber);
    const effective = trim(a.priorTermEffective);
    const expiration = trim(a.priorTermExpiration);
    const premium = a.priorPremium ?? null;
    if (!carrier && !policyNumber && premium == null && !effective && !expiration) {
      // Nothing recorded. The common case for a lead nobody has worked yet.
    } else if (
      priorExisting.some((p) => p.extractionSourceKey === PRIOR_CARRIER_KEY)
    ) {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        model: "PriorCarrier",
        action: "skip",
        reason: "prior carrier already backfilled",
      });
    } else {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        model: "PriorCarrier",
        action: "create",
        reason: "prior carrier from prior* columns",
        row: {
          accountId: a.id,
          carrierName: carrier,
          policyNumber,
          lineOfBusiness: BACKFILLED_LINE,
          premium,
          effectiveDate: effective,
          expirationDate: expiration,
          extractionSourceKey: PRIOR_CARRIER_KEY,
        },
      });
    }

    // ── The construction columns, from Account onto every building ──
    //
    // THIS IS THE ONE THAT CAN PRODUCE WRONG DATA, and the spec says so. An
    // account-level "roof updated 2019" is a fact about whichever building
    // somebody had in mind, and copying it onto all thirteen asserts it of
    // twelve buildings nobody checked. There is no way to do better from
    // here — the information about which building it described was never
    // recorded — so the script does the only defensible thing: it copies only
    // into fields that are EMPTY, never overwriting a value somebody typed,
    // and it prints a warning per account that fans out to more than one
    // building so the output can be reviewed rather than skimmed.
    const construction: Record<string, number | string | null> = {
      yearBuilt: a.yearBuilt ?? null,
      stories: a.stories ?? null,
      constructionType: a.constructionType ?? null,
      roofYear: a.roofUpdatedYear ?? null,
      heatingYear: a.hvacUpdatedYear ?? null,
      wiringYear: a.electricalUpdatedYear ?? null,
      plumbingYear: a.plumbingUpdatedYear ?? null,
    };
    const setColumns = Object.entries(construction).filter(([, v]) => v != null);

    if (setColumns.length > 0) {
      const buildings = await listAllPages((nextToken) =>
        client.models.Building.list({
          filter: { accountId: { eq: a.id } },
          nextToken,
        })
      );

      if (buildings.length === 0) {
        // No buildings at all: the account's own construction answers become
        // the one building it evidently has.
        if (buildings.some((b) => b.extractionSourceKey === BUILDING_KEY)) {
          planned.push({
            accountId: a.id,
            accountName: a.name,
            model: "Building",
            action: "skip",
            reason: "building already backfilled",
          });
        } else {
          planned.push({
            accountId: a.id,
            accountName: a.name,
            model: "Building",
            action: "create",
            reason: "one building from the account's construction columns",
            row: {
              accountId: a.id,
              label: "Building 1",
              streetAddress: trim(a.address),
              ...Object.fromEntries(setColumns),
              extractionSourceKey: BUILDING_KEY,
            },
          });
        }
      } else {
        // Buildings exist: fill only the gaps, one planned update per
        // building that has any.
        for (const b of buildings) {
          const gaps = setColumns.filter(
            ([k]) => (b as Record<string, unknown>)[k] == null
          );
          if (gaps.length === 0) continue;
          planned.push({
            accountId: a.id,
            accountName: a.name,
            model: "Building",
            action: "update",
            id: b.id,
            reason: `${b.label ?? b.id}: filling ${gaps.map(([k]) => k).join(", ")}`,
            row: { id: b.id, ...Object.fromEntries(gaps) },
            warning:
              buildings.length > 1
                ? `account-level construction copied onto ${buildings.length} buildings — verify before dropping the columns`
                : undefined,
          });
        }
      }
    }
  }

  return planned;
}

async function main() {
  console.log(
    APPLY
      ? "── APPLY: this run writes. ──\n"
      : "── DRY RUN: nothing is written. Pass --apply to write. ──\n"
  );

  const planned = await plan();
  const writes = planned.filter((p) => p.action !== "skip");

  for (const p of planned) {
    const row = p.row;
    const detail = row
      ? [
          row.name,
          row.email,
          row.phone,
          row.type,
          row.carrierName,
          row.policyNumber,
          row.lineOfBusiness,
          row.premium,
          [row.effectiveDate, row.expirationDate].filter(Boolean).join(" → "),
        ]
          .filter(Boolean)
          .join(" · ")
      : p.reason;
    const mark = p.action === "create" ? "+" : p.action === "update" ? "~" : "·";
    console.log(
      `${mark} ${p.accountName} (${p.accountId})` +
        `\n    ${p.model}: ${p.action === "skip" ? `skipped — ${p.reason}` : `${p.reason}${detail ? ` — ${detail}` : ""}`}`
    );
  }

  // ── The fan-out warning, printed together rather than scattered ──
  //
  // W5's buildings pass is the one the spec says can produce wrong data: an
  // account-level "roof updated 2019" copied onto thirteen buildings asserts
  // it of twelve nobody checked. These accounts are the ones to read before
  // running with --apply, and burying the warning next to each row would let
  // it be skimmed past.
  const fannedOut = [...new Set(writes.filter((p) => p.warning).map((p) => `${p.accountName} (${p.accountId})`))];
  if (fannedOut.length) {
    console.warn(
      `\n!! ${fannedOut.length} account(s) have account-level construction ` +
        `values being copied onto more than one building. Only EMPTY fields ` +
        `are filled — nothing typed by hand is overwritten — but the values ` +
        `themselves were never per-building, so review these before --apply:`
    );
    for (const a of fannedOut) console.warn(`     ${a}`);
  }

  const tally = (m: TargetModel) => writes.filter((p) => p.model === m).length;
  console.log(
    `\n${tally("Contact")} contact, ${tally("PriorCarrier")} prior carrier ` +
      `and ${tally("Building")} building row(s) to write across ` +
      `${new Set(writes.map((p) => p.accountId)).size} account(s); ` +
      `${planned.length - writes.length} skipped.`
  );

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  let written = 0;
  const failures: string[] = [];
  for (const p of writes) {
    // The models take different payloads and buildings can be updated rather
    // than created, so this dispatches rather than pretending one signature
    // covers everything.
    const { errors } =
      p.action === "update"
        ? await client.models.Building.update(
            p.row as Parameters<typeof client.models.Building.update>[0]
          )
        : p.model === "Contact"
          ? await client.models.Contact.create(
              p.row as Parameters<typeof client.models.Contact.create>[0]
            )
          : p.model === "PriorCarrier"
            ? await client.models.PriorCarrier.create(
                p.row as Parameters<typeof client.models.PriorCarrier.create>[0]
              )
            : await client.models.Building.create(
                p.row as Parameters<typeof client.models.Building.create>[0]
              );
    if (errors?.length) {
      failures.push(
        `${p.accountName} (${p.accountId}) ${p.model}: ${errors[0].message}`
      );
    } else {
      written++;
    }
  }

  console.log(`\nWrote ${written} row(s).`);
  if (failures.length) {
    console.error(`\n${failures.length} failed:`);
    for (const f of failures) console.error(`  ${f}`);
    // A non-zero exit so this cannot be mistaken for a clean run in a log.
    process.exitCode = 1;
  }

  // ── Verification, in the script rather than left to the operator ──
  //
  // Re-read and confirm each account that had contact columns now has the
  // rows to match. This is the step that makes it safe to delete the columns,
  // so it is not optional and it is not a separate query someone has to
  // remember to run.
  console.log("\nVerifying…");
  const stillMissing: string[] = [];
  for (const p of writes) {
    if (p.action === "update") {
      // An update has no provenance key to look for — it filled gaps on a row
      // that already existed. Verify the gaps are gone instead.
      const { data } = await client.models.Building.get({ id: p.id as string });
      const unfilled = Object.keys(p.row ?? {})
        .filter((k) => k !== "id")
        .filter((k) => (data as Record<string, unknown> | null)?.[k] == null);
      if (unfilled.length) {
        stillMissing.push(
          `${p.accountName} (${p.accountId}) Building ${p.id}: ${unfilled.join(", ")}`
        );
      }
      continue;
    }
    const rows =
      p.model === "Contact"
        ? await listAllPages((nextToken) =>
            client.models.Contact.list({
              filter: { accountId: { eq: p.accountId } },
              nextToken,
            })
          )
        : p.model === "PriorCarrier"
          ? await listAllPages((nextToken) =>
              client.models.PriorCarrier.list({
                filter: { accountId: { eq: p.accountId } },
                nextToken,
              })
            )
          : await listAllPages((nextToken) =>
              client.models.Building.list({
                filter: { accountId: { eq: p.accountId } },
                nextToken,
              })
            );
    const keys = new Set(rows.map((r) => r.extractionSourceKey));
    if (!keys.has(p.row?.extractionSourceKey as string)) {
      stillMissing.push(
        `${p.accountName} (${p.accountId}) ${p.model}: ${p.row?.extractionSourceKey}`
      );
    }
  }
  if (stillMissing.length) {
    console.error(`${stillMissing.length} row(s) did not land:`);
    for (const m of stillMissing) console.error(`  ${m}`);
    process.exitCode = 1;
  } else {
    console.log("Every planned row is present. Safe to proceed to step 5.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

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
 *   1. Add the new models. Deploy.               ← W1 and W3 did this
 *   2. Run this, dry, and read the summary.
 *   3. Run it with --apply. Verify.
 *   4. Ship the UI reading the new rows.         ← W1 and W3 did this too
 *   5. Only then delete the old columns.         ← NOT DONE YET
 *
 * Steps 1 and 4 landed together because the UI half is what makes the columns
 * unread, and a column nothing reads is a column that cannot drift while this
 * runs. Step 5 is a separate commit, deliberately: dropping a field from an
 * Amplify model does not delete the DynamoDB attribute, so until something
 * overwrites it the whole workstream is revertible by putting the fields back.
 * Nothing in W1 or W3 writes to a column it is about to drop. Keep it that way.
 *
 * ## What it covers
 *
 * | Columns on Account | Becomes |
 * |---|---|
 * | `contactFirstName`/`contactLastName`/`contactEmail`/`contactPhone` | one primary `Contact` |
 * | `inspectionContactName`/`inspectionContactPhone` | one INSPECTION `Contact` |
 * | `priorCarrierName`/`priorPolicyNumber`/`priorPremium`/`priorTermEffective`/`priorTermExpiration` | one General Liability `PriorCarrier` |
 *
 * W5's buildings backfill is not here yet. It is the one that can produce
 * wrong data — an account-level "roof updated 2019" is not necessarily true
 * of all thirteen buildings — so it needs its own review pass.
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

type TargetModel = "Contact" | "PriorCarrier";

interface Planned {
  accountId: string;
  accountName: string;
  model: TargetModel;
  action: "create" | "skip";
  reason: string;
  row?: Record<string, unknown>;
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
  const creates = planned.filter((p) => p.action === "create");

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
    console.log(
      `${p.action === "create" ? "+" : "·"} ${p.accountName} (${p.accountId})` +
        `\n    ${p.model}: ${
          p.action === "create" ? detail : `skipped — ${p.reason}`
        }`
    );
  }

  const tally = (m: TargetModel) =>
    creates.filter((p) => p.model === m).length;
  console.log(
    `\n${tally("Contact")} contact row(s) and ${tally("PriorCarrier")} prior ` +
      `carrier row(s) to create across ` +
      `${new Set(creates.map((p) => p.accountId)).size} account(s); ` +
      `${planned.length - creates.length} skipped.`
  );

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  let written = 0;
  const failures: string[] = [];
  for (const p of creates) {
    // The two models take different payloads, so this dispatches rather than
    // pretending one create signature covers both.
    const { errors } =
      p.model === "Contact"
        ? await client.models.Contact.create(
            p.row as Parameters<typeof client.models.Contact.create>[0]
          )
        : await client.models.PriorCarrier.create(
            p.row as Parameters<typeof client.models.PriorCarrier.create>[0]
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
  for (const p of creates) {
    const rows =
      p.model === "Contact"
        ? await listAllPages((nextToken) =>
            client.models.Contact.list({
              filter: { accountId: { eq: p.accountId } },
              nextToken,
            })
          )
        : await listAllPages((nextToken) =>
            client.models.PriorCarrier.list({
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

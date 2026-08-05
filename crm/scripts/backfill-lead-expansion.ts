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
 *   1. Add the new models. Deploy.               ← W1 did this
 *   2. Run this, dry, and read the summary.
 *   3. Run it with --apply. Verify.
 *   4. Ship the UI reading the new rows.         ← W1 did this too
 *   5. Only then delete the old columns.         ← NOT DONE YET
 *
 * Steps 1 and 4 landed together because the UI half is what makes the columns
 * unread, and a column nothing reads is a column that cannot drift while this
 * runs. Step 5 is a separate commit, deliberately: dropping a field from an
 * Amplify model does not delete the DynamoDB attribute, so until something
 * overwrites it the whole of W1 is revertible by putting the fields back.
 * Nothing in W1 writes to a column it is about to drop. Keep it that way.
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

const trim = (v: string | null | undefined) => v?.trim() || null;

interface Planned {
  accountId: string;
  accountName: string;
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
        action: "skip",
        reason: "no contact columns set",
      });
    } else if (already.has(PRIMARY_KEY)) {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        action: "skip",
        reason: "primary contact already backfilled",
      });
    } else {
      planned.push({
        accountId: a.id,
        accountName: a.name,
        action: "create",
        reason: `primary contact from contact* columns`,
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
        action: "skip",
        reason: "inspection contact already backfilled",
      });
    } else {
      planned.push({
        accountId: a.id,
        accountName: a.name,
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
      ? [row.name, row.email, row.phone, row.type].filter(Boolean).join(" · ")
      : p.reason;
    console.log(
      `${p.action === "create" ? "+" : "·"} ${p.accountName} (${p.accountId})` +
        `\n    ${p.action === "create" ? detail : `skipped — ${p.reason}`}`
    );
  }

  console.log(
    `\n${creates.length} contact row(s) to create across ` +
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
    const { errors } = await client.models.Contact.create(
      p.row as Parameters<typeof client.models.Contact.create>[0]
    );
    if (errors?.length) {
      failures.push(`${p.accountName} (${p.accountId}): ${errors[0].message}`);
    } else {
      written++;
    }
  }

  console.log(`\nWrote ${written} contact row(s).`);
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
  for (const id of new Set(creates.map((p) => p.accountId))) {
    const rows = await listAllPages((nextToken) =>
      client.models.Contact.list({ filter: { accountId: { eq: id } }, nextToken })
    );
    const keys = new Set(rows.map((c) => c.extractionSourceKey));
    for (const p of creates.filter((c) => c.accountId === id)) {
      if (!keys.has(p.row?.extractionSourceKey as string)) {
        stillMissing.push(`${p.accountName} (${id}): ${p.row?.extractionSourceKey}`);
      }
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

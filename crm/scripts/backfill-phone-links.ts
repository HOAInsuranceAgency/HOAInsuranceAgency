/**
 * Fills the phone index from the contacts and accounts already in the table.
 *
 * Run against a deployed backend with `tsx`, staging first and `main` only
 * after staging's output has been read:
 *
 *   npx tsx scripts/backfill-phone-links.ts            # dry run, writes nothing
 *   npx tsx scripts/backfill-phone-links.ts --apply
 *   npx tsx scripts/backfill-phone-links.ts --apply --account <id>
 *
 * ## Why this exists at all
 *
 * `dialpad-phone-index` maintains `PhoneLink` off DynamoDB streams, and a
 * stream only carries what changes after the event source is created. Every
 * contact that already existed on the day W0 deployed is invisible to it —
 * which is nearly all of them. This is what makes the index complete, and it
 * is also the repair tool: `PhoneLink` is derived, so a wrong index is fixed
 * by rebuilding rather than by data entry.
 *
 * Safe to run at any time, as often as you like. It is not a one-time
 * migration and does not need to be retired.
 *
 * ## The rules are not restated here
 *
 * Which numbers index, under which id, and when a link should not exist come
 * from `planForContact` and `planForAccount` — the same pure functions the
 * stream handler calls. That is the point: an index built by this script and
 * one maintained by the handler cannot disagree, because there is only one
 * set of rules and neither owns it. Anything this file decided for itself
 * would be a second implementation drifting quietly out of step.
 *
 * ## Authentication
 *
 * `authMode: "iam"`, against whatever AWS credentials are in the environment
 * (`AWS_PROFILE`, or the usual chain) — same as
 * `backfill-lead-expansion.ts`, and for the same reason: the CRM signs in
 * with a Cognito magic link, which a script cannot complete. Note what that
 * implies, as that script's header does: an IAM principal is not subject to
 * the `@auth` rules in `amplify/data/resource.ts`, so PhoneLink's read-only
 * client rule does not constrain this.
 *
 * ## Idempotence
 *
 * Free, and by construction rather than by a provenance marker: every link id
 * is a pure function of the row it projects, so a second run overwrites the
 * same rows with the same content. Confirm it anyway — run it twice and check
 * the second run reports nothing changed.
 */
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import outputs from "../amplify_outputs.json";
import type { Schema } from "../amplify/data/resource";
import { listAllPages } from "../src/lib/pagination";
import {
  planForAccount,
  planForContact,
  type Plan,
} from "../amplify/functions/dialpad-phone-index/links";

Amplify.configure(outputs);
const client = generateClient<Schema>({ authMode: "iam" });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const only = args.includes("--account") ? args[args.indexOf("--account") + 1] : null;

const tally = { created: 0, updated: 0, deleted: 0, unindexable: 0, skipped: 0 };
/** Numbers that resolve to more than one account, reported rather than fixed. */
const byNumber = new Map<string, Set<string>>();

async function main() {
  console.log(APPLY ? "APPLYING" : "DRY RUN — nothing will be written");

  const accounts = await listAllPages((nextToken) =>
    client.models.Account.list({ nextToken, limit: 200 })
  );
  const contacts = await listAllPages((nextToken) =>
    client.models.Contact.list({ nextToken, limit: 200 })
  );
  const existing = await listAllPages((nextToken) =>
    client.models.PhoneLink.list({ nextToken, limit: 200 })
  );

  // Built from the list already in hand rather than read per contact: the
  // handler pays for that lookup because a stream record arrives alone, and
  // this does not.
  const accountName = new Map(accounts.map((a) => [a.id, a.name ?? null]));
  const before = new Map(existing.map((l) => [l.id, l]));
  const seen = new Set<string>();

  console.log(
    `${accounts.length} accounts, ${contacts.length} contacts, ${existing.length} links already indexed`
  );

  const plans: Plan[] = [];
  for (const account of accounts) {
    if (only && account.id !== only) continue;
    // No old image: nothing here is a rename, and an account that is present
    // cannot be a purge.
    plans.push(...planForAccount(undefined, account as unknown as Record<string, unknown>));
  }
  for (const contact of contacts) {
    if (only && contact.accountId !== only) continue;
    plans.push(
      ...planForContact(
        undefined,
        contact as unknown as Record<string, unknown>,
        accountName.get(contact.accountId) ?? null
      )
    );
  }

  for (const plan of plans) {
    if (plan.kind === "upsert") {
      const { link } = plan;
      seen.add(link.id);
      for (const [n, ids] of [[link.e164, byNumber.get(link.e164)]] as const) {
        if (!ids) byNumber.set(n, new Set([link.accountId]));
        else ids.add(link.accountId);
      }

      const prior = before.get(link.id);
      const unchanged =
        prior &&
        prior.e164 === link.e164 &&
        prior.accountId === link.accountId &&
        (prior.accountName ?? null) === link.accountName &&
        (prior.contactName ?? null) === link.contactName;
      if (unchanged) {
        tally.skipped++;
        continue;
      }

      prior ? tally.updated++ : tally.created++;
      if (!APPLY) continue;
      const row = {
        id: link.id,
        e164: link.e164,
        accountId: link.accountId,
        contactId: link.contactId ?? undefined,
        accountName: link.accountName ?? undefined,
        contactName: link.contactName ?? undefined,
        source: link.source,
        linkedAt: new Date().toISOString(),
      };
      const { errors } = prior
        ? await client.models.PhoneLink.update(row)
        : await client.models.PhoneLink.create(row);
      if (errors?.length) console.error(`  ${link.id}:`, JSON.stringify(errors));
    } else if (plan.kind === "delete") {
      // A contact or account with no usable number. Counted separately from a
      // deletion because on a first run it is not a removal at all — it is a
      // row that was never indexable, and the count is what says how much of
      // the book is unreachable by phone.
      if (!before.has(plan.id)) {
        tally.unindexable++;
        continue;
      }
      tally.deleted++;
      if (!APPLY) continue;
      const { errors } = await client.models.PhoneLink.delete({ id: plan.id });
      if (errors?.length) console.error(`  ${plan.id}:`, JSON.stringify(errors));
    }
  }

  // Links whose source row is gone. The handler deletes these as they happen;
  // anything here predates it or was written before a crash.
  const orphans = existing.filter((l) => !seen.has(l.id) && l.source !== "MANUAL");
  for (const orphan of orphans) {
    tally.deleted++;
    if (!APPLY) continue;
    const { errors } = await client.models.PhoneLink.delete({ id: orphan.id });
    if (errors?.length) console.error(`  ${orphan.id}:`, JSON.stringify(errors));
  }

  console.log("\n" + (APPLY ? "Applied" : "Would apply"));
  console.log(`  created      ${tally.created}`);
  console.log(`  updated      ${tally.updated}`);
  console.log(`  deleted      ${tally.deleted}${orphans.length ? ` (${orphans.length} orphaned)` : ""}`);
  console.log(`  unchanged    ${tally.skipped}`);
  console.log(`  no number    ${tally.unindexable}`);

  // Not a problem to fix — the expected shape of an HOA book, where one
  // property manager holds thirty associations. Reported because it is the
  // volume of AMBIGUOUS matching W1 will have to do, and it is better known
  // before that code is written than after.
  const shared = [...byNumber.entries()].filter(([, ids]) => ids.size > 1);
  if (shared.length) {
    console.log(`\n${shared.length} numbers reach more than one account:`);
    for (const [number, ids] of shared.slice(0, 20)) {
      console.log(`  ${number} → ${ids.size} accounts`);
    }
    if (shared.length > 20) console.log(`  … and ${shared.length - 20} more`);
  }

  if (!APPLY) console.log("\nRe-run with --apply to write.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

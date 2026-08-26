import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue, DynamoDBStreamEvent } from "aws-lambda";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { planForAccount, planForContact, type DesiredLink, type Plan } from "./links";

/**
 * Keeps `PhoneLink` in step with `Contact` and `Account`. See ./resource.ts
 * for why streams and why a second consumer, and ./links.ts for the rules
 * worth testing.
 *
 * Through the data client rather than straight to the table, which is the
 * opposite of what `stripe-webhook` does and worth saying why: the rename and
 * purge paths query PhoneLink by `accountId`, and a raw QueryCommand needs
 * the physical name of an Amplify-generated GSI. Nothing in this repo reads
 * one today, a guessed name fails at runtime, and `tsc` cannot see the
 * mistake. `listPhoneLinkByAccountId` is generated, typed, and cannot drift.
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

/** The create lost the race and the row is already there — so update it. */
const isAlreadyThere = (e: { message?: string }) =>
  /conditional request failed|ConditionalCheckFailed/i.test(e.message ?? "");

/** The update found nothing to update — so create it. */
const isMissing = (e: { message?: string }) =>
  /conditional request failed|ConditionalCheckFailed|not found/i.test(e.message ?? "");

/**
 * Account id → display name, cached for the life of the container.
 *
 * A contact link wants its account's name and the Contact image does not
 * carry one, so without this every contact write costs a read. A batch of ten
 * contacts under one account is then one read, and the staleness a
 * per-container cache allows is bounded by the rename path, which rewrites
 * the links directly.
 */
const accountNames = new Map<string, string | null>();

async function accountName(
  client: DataClient,
  accountId: string
): Promise<string | null> {
  const hit = accountNames.get(accountId);
  if (hit !== undefined) return hit;
  try {
    const { data } = await client.models.Account.get({ id: accountId });
    const name = data?.name ?? null;
    accountNames.set(accountId, name);
    return name;
  } catch (err) {
    // A link with no account name still matches; it only reads worse in the
    // triage queue. Not worth failing the record for.
    console.warn(`dialpad-phone-index: no name for account ${accountId}`, err);
    return null;
  }
}

/**
 * Write the row, whether or not it is already there.
 *
 * Create first, update on conflict. Both orders cost two calls in one branch
 * and one in the other; this way round the error being matched is the same
 * "already exists" condition `activity-log` already relies on, rather than a
 * second hand-written string match for a different failure.
 */
async function upsert(client: DataClient, link: DesiredLink): Promise<void> {
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

  const { errors } = await client.models.PhoneLink.create(row);
  if (!errors?.length) return;
  if (!errors.some(isAlreadyThere)) {
    console.error(`PhoneLink create failed for ${link.id}`, JSON.stringify(errors));
    return;
  }

  // `suppressed` is deliberately not in either payload. It is set by a person
  // from the triage queue and belongs to the number, not to this projection —
  // a contact edit must not un-suppress a robocaller.
  const { errors: updateErrors } = await client.models.PhoneLink.update(row);
  if (updateErrors?.length) {
    console.error(`PhoneLink update failed for ${link.id}`, JSON.stringify(updateErrors));
  }
}

async function remove(client: DataClient, id: string): Promise<void> {
  const { errors } = await client.models.PhoneLink.delete({ id });
  // Deleting a link that was never there is the normal case, not a problem:
  // every contact without a usable number takes this path on every write.
  if (errors?.length && !errors.some(isMissing)) {
    console.error(`PhoneLink delete failed for ${id}`, JSON.stringify(errors));
  }
}

/** Every link under an account. Paged, because a manager's book is not small. */
async function linksForAccount(client: DataClient, accountId: string) {
  return listAllPages((nextToken) =>
    client.models.PhoneLink.listPhoneLinkByAccountId(
      { accountId },
      { nextToken, limit: 200 }
    )
  );
}

async function apply(client: DataClient, plan: Plan): Promise<void> {
  switch (plan.kind) {
    case "upsert":
      return upsert(client, plan.link);
    case "delete":
      return remove(client, plan.id);
    case "renameAccount": {
      const links = await linksForAccount(client, plan.accountId);
      for (const link of links) {
        if (link.accountName === plan.accountName) continue;
        const { errors } = await client.models.PhoneLink.update({
          id: link.id,
          accountName: plan.accountName,
        });
        if (errors?.length) {
          console.error(`PhoneLink rename failed for ${link.id}`, JSON.stringify(errors));
        }
      }
      return;
    }
    case "purgeAccount": {
      const links = await linksForAccount(client, plan.accountId);
      for (const link of links) await remove(client, link.id);
      return;
    }
  }
}

const readImage = (
  image: Record<string, AttributeValue> | undefined
): Record<string, unknown> | undefined =>
  image ? (unmarshall(image as never) as Record<string, unknown>) : undefined;

/** `arn:…:table/Contact-abc123-NONE/stream/…` → `Contact`. */
export function modelFromArn(arn: string | undefined): string | null {
  const table = /table\/([^/]+)/.exec(arn ?? "")?.[1];
  if (!table) return null;
  return table.split("-")[0] || null;
}

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  const client = await getDataClient();

  for (const record of event.Records) {
    try {
      const model = modelFromArn(record.eventSourceARN);
      // Two tables stream into this function and nothing else should. A third
      // arriving here means backend.ts wired something new; drop it rather
      // than guess at its shape.
      if (model !== "Contact" && model !== "Account") continue;

      const oldImage = readImage(record.dynamodb?.OldImage);
      const newImage = readImage(record.dynamodb?.NewImage);

      const plans =
        model === "Contact"
          ? planForContact(
              oldImage,
              newImage,
              newImage?.accountId
                ? await accountName(client, String(newImage.accountId))
                : null
            )
          : planForAccount(oldImage, newImage);

      // A rename invalidates what the cache holds for that account, and the
      // batch may carry its contacts too.
      for (const plan of plans) {
        if (plan.kind === "renameAccount") {
          accountNames.set(plan.accountId, plan.accountName);
        }
      }

      for (const plan of plans) await apply(client, plan);
    } catch (err) {
      // Per record, so one malformed image does not cost the batch. A record
      // dropped here is not retried on its own — the batch as a whole may be
      // redelivered, which the deterministic ids make safe.
      console.error("PhoneLink record failed", err);
    }
  }
};

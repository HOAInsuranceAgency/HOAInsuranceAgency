import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue, DynamoDBStreamEvent } from "aws-lambda";
import type { Schema } from "../../data/resource";
import {
  buildSummary,
  diffImages,
  resolveEntityId,
  subjectLabel,
  type ActivityAction,
} from "./diff";

/**
 * One Activity row per streamed change. See ./resource.ts for why streams,
 * and ./diff.ts for the parts worth testing.
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

/**
 * Cognito sub → display name, cached for the life of the container.
 *
 * A batch of ten changes by one person is one lookup, and the cache being
 * per-container rather than global is the right staleness: a user renamed
 * mid-batch keeps their old name on that batch's rows, which is what
 * denormalising the name means anyway.
 */
const nameCache = new Map<string, string>();

/**
 * Writers that are not people. A Lambda stamps its own name rather than
 * leaving the field blank, so the timeline can say "Lead intake" instead of
 * the unattributed "System" — which is what an unstamped write gets and
 * should stay reserved for.
 */
const ROBOT_NAMES: Record<string, string> = {
  "lead-intake": "Lead intake",
  "extract-lead": "AI extraction",
  backfill: "Backfill script",
};

async function actorName(client: DataClient, actor: string): Promise<string> {
  if (actor === SYSTEM_ACTOR) return "System";
  const robot = ROBOT_NAMES[actor];
  if (robot) return robot;
  const hit = nameCache.get(actor);
  if (hit) return hit;
  try {
    // Through the userId index rather than a filtered scan: `userId` IS the
    // Cognito sub (see the schema comment) and the index exists for exactly
    // this lookup.
    const { data } = await client.models.UserProfile.listUserProfileByUserId({
      userId: actor,
    });
    const p = data?.[0];
    const name = [p?.firstName, p?.lastName].filter(Boolean).join(" ").trim();
    const resolved = name || p?.email || "Unknown user";
    nameCache.set(actor, resolved);
    return resolved;
  } catch (err) {
    // A failed lookup must not cost the activity row — the sub is still
    // recorded, so the name can be resolved later by anyone who cares.
    console.error(`Could not resolve actor ${actor}`, err);
    return "Unknown user";
  }
}

/** What a write with no `lastWriteBy` is attributed to. */
const SYSTEM_ACTOR = "system";

/** The create rejected because this stream record already has its row. */
const isAlreadyRecorded = (e: { message?: string }) =>
  /conditional request failed|ConditionalCheckFailed/i.test(e.message ?? "");

/** `arn:…:table/Account-abc123-NONE/stream/…` → `Account`. */
export function subjectTypeFromArn(arn: string | undefined): string | null {
  const table = /table\/([^/]+)/.exec(arn ?? "")?.[1];
  if (!table) return null;
  // Amplify names tables `<Model>-<apiId>-<env>`.
  return table.split("-")[0] || null;
}

const readImage = (
  image: Record<string, AttributeValue> | undefined
): Record<string, unknown> | undefined =>
  image ? (unmarshall(image as never) as Record<string, unknown>) : undefined;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  const client = await getDataClient();

  for (const record of event.Records) {
    try {
      const subjectType = subjectTypeFromArn(record.eventSourceARN);
      if (!subjectType) continue;

      const oldImage = readImage(record.dynamodb?.OldImage);
      const newImage = readImage(record.dynamodb?.NewImage);
      const image = newImage ?? oldImage;

      // Records with no resolvable account are dropped: the tab is
      // account-scoped and there is nowhere to show them.
      const entityId = resolveEntityId(subjectType, image);
      if (!entityId) continue;

      const action: ActivityAction =
        record.eventName === "INSERT"
          ? "CREATE"
          : record.eventName === "REMOVE"
            ? "DELETE"
            : "UPDATE";

      const changes = diffImages(oldImage, newImage);
      // An update whose diff is empty writes nothing. Without this every
      // save of an unchanged form would add a row saying nothing happened.
      if (action === "UPDATE" && changes.length === 0) continue;

      // Falls back to the account for a model keyed on it — `GlApplication`
      // and `DoApplication` declare `.identifier(["accountId"])`, so they
      // have no `id` attribute at all and this would otherwise be blank.
      const subjectId = String(image?.id ?? image?.accountId ?? "");
      const label = subjectLabel(subjectType, image);
      const actor =
        typeof newImage?.lastWriteBy === "string" && newImage.lastWriteBy
          ? newImage.lastWriteBy
          : SYSTEM_ACTOR;

      const { errors } = await client.models.Activity.create({
        // One row per stream record, not per delivery of one.
        //
        // A stream event source mapping is at-least-once. A batch that fails
        // part-way — a timeout, a shard rebalance, a lost response — is
        // redelivered whole, and `retryAttempts: 2` in backend.ts means that
        // can happen twice more; `reportBatchItemFailures` is off, so there
        // is no per-record checkpoint to resume from. Every record already
        // written would be written again.
        //
        // `eventID` identifies the stream record and is stable across those
        // redeliveries, so using it as the row's id makes a replay collide
        // with what the first delivery wrote. Amplify conditions every create
        // on the id not existing, so the collision is rejected rather than
        // duplicated. The SequenceNumber fallback is for the types' sake —
        // DynamoDB always sends an eventID.
        id:
          record.eventID ??
          `${subjectType}:${record.dynamodb?.SequenceNumber ?? subjectId}`,
        entityId,
        subjectType,
        subjectId,
        subjectLabel: label || undefined,
        action,
        actor,
        actorName: await actorName(client, actor),
        changes: JSON.stringify(changes),
        summary: buildSummary(action, subjectType, label, changes),
        // The stream's own clock, not this Lambda's: a batch processed late
        // must not claim the changes happened when it ran.
        occurredAt: new Date(
          (record.dynamodb?.ApproximateCreationDateTime ?? Date.now() / 1000) * 1000
        ).toISOString(),
      });
      // A redelivered record loses the id condition, which is the mechanism
      // working rather than a failure. Matched on the message because AppSync
      // does not type its errors — a miss costs a log line, not a row.
      if (errors?.length && !errors.some(isAlreadyRecorded)) {
        console.error("Activity write failed", JSON.stringify(errors));
      }
    } catch (err) {
      // Per record, so one malformed image does not cost the batch. A record
      // dropped here is not retried on its own — the batch as a whole may be
      // redelivered, which is what the id above makes safe.
      console.error("Activity record failed", err);
    }
  }
};

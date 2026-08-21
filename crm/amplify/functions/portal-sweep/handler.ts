import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { extractedAt, parseStoredJson } from "../../../src/lib/aiExtraction";
import { isExtractableCategory } from "../../../src/lib/enums";
import { AGENCY, AGENCY_FMT } from "../../../../shared/agency";
import { REQUESTED_DOCUMENTS } from "../../../../shared/leadDocuments";
import { decideSweep } from "./decide";
import { arrivedSections, renderNotification } from "./email";

/**
 * Lead document upload sweep. See resource.ts for the why.
 *
 * Per tick: find portals with an unreported upload → for each, decide → send,
 * kick extraction off, or leave it for the next tick.
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

const ses = new SESv2Client();
const lambda = new LambdaClient();
const s3 = new S3Client();

/**
 * Which of these documents actually exist in the bucket.
 *
 * A Document row is created when a presigned URL is *requested*, not when the
 * PUT succeeds — the browser asks for somewhere to put a file and the row is
 * how we know where. If the upload then fails, the row stays and nothing else
 * marks it. Counting those as arrivals means emailing the team that four
 * documents came in when none did.
 *
 * That is not a rare path either: signing `ContentLength` into the presign means
 * a mismatched body is now rejected by S3, so the failed-upload case became more
 * likely at exactly the moment this notification was added.
 *
 * A HEAD per fresh document, which is a handful per sitting. A file that cannot
 * be checked is treated as absent: a missed notification is recoverable by
 * looking at the account, a false one erodes trust in every future notification.
 */
async function landed<T extends { s3Key?: string | null }>(
  documents: readonly T[]
): Promise<T[]> {
  const bucket = process.env.DOCUMENTS_BUCKET;
  if (!bucket) {
    console.warn("[portal-sweep] DOCUMENTS_BUCKET unset; cannot confirm uploads");
    return [];
  }
  /**
   * The awaited value is a plain flag, never the document itself.
   *
   * Returning `T | null` from an async callback makes `Promise.all` produce
   * `Awaited<T> | null`, and the compiler will not accept that as `T` — a
   * generic could be instantiated as something promise-like, so `Awaited<T>`
   * and `T` are genuinely different types to it. Keeping `T` out of the await
   * sidesteps the question rather than fighting it.
   */
  const checks = await Promise.all(
    documents.map(async (doc) => {
      const key = doc.s3Key;
      // "pending" is the placeholder written before the real key is known.
      if (!key || key === "pending") return false;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    })
  );
  return documents.filter((_, i) => checks[i]);
}

/** Same per-branch mailbox as the auto-reply: sales on main, a test box else. */
const MAILBOX = process.env.AGENCY_MAILBOX || AGENCY_FMT.leadEmailLower;
const FROM = `${AGENCY.name} <${MAILBOX}>`;

/**
 * The fields worth putting in the email.
 *
 * Extraction produces a wide result, most of it not interesting to someone
 * deciding whether to ring a board back. These are the ones that change what
 * they would say on the call.
 */
const HEADLINE_FIELDS = [
  "currentCarrier",
  "masterPolicyExpiration",
  "totalInsuredValue",
  "unitCount",
  "lossCount",
  "openClaims",
];

/** `{ field: { value, confidence } }` → `{ field: value }`, headline keys only. */
function headlines(raw: unknown): Record<string, string> {
  const parsed = parseStoredJson(raw);
  if (!parsed) return {};
  const out: Record<string, string> = {};
  for (const key of HEADLINE_FIELDS) {
    const cell = parsed[key];
    const value =
      cell && typeof cell === "object" && "value" in cell
        ? (cell as { value?: unknown }).value
        : cell;
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if (typeof value === "number") out[key] = String(value);
  }
  return out;
}

export const handler = async () => {
  const client = await getDataClient();
  const now = new Date().toISOString();
  const summary = { open: 0, sent: 0, extracting: 0, waiting: 0, failed: 0 };

  /**
   * Only portals with something unreported.
   *
   * Filtered on `lastUploadAt` existing rather than on the comparison itself:
   * DynamoDB cannot compare two attributes in a filter, so the "is
   * `notifiedUpTo` behind `lastUploadAt`" question is answered in `decideSweep`.
   * The set that reaches it is small — portals that have ever received a file.
   */
  const portals = await listAllPages((nextToken) =>
    client.models.UploadPortal.list({
      filter: { lastUploadAt: { attributeExists: true } },
      limit: 1000,
      nextToken,
    })
  );
  summary.open = portals.length;

  for (const portal of portals) {
    try {
      const [account, documents] = await Promise.all([
        client.models.Account.get({ id: portal.accountId }),
        listAllPages((nextToken) =>
          client.models.Document.list({
            filter: { entityId: { eq: portal.accountId } },
            limit: 1000,
            nextToken,
          })
        ),
      ]);

      if (!account.data) {
        // The account went away under the portal. Stop reconsidering it every
        // ten minutes: mark this batch reported, since nobody can act on it.
        await client.models.UploadPortal.update({
          id: portal.id,
          notifiedUpTo: portal.lastUploadAt,
        });
        summary.failed++;
        continue;
      }

      const decision = decideSweep({
        portal,
        documents,
        account: {
          extractionStatus: account.data.extractionStatus,
          extractedAt: extractedAt(account.data.aiExtraction),
        },
        now,
        isExtractable: isExtractableCategory,
      });

      if (decision.action === "wait") {
        summary.waiting++;
        console.log("portal-sweep waiting", portal.id, decision.reason);
        continue;
      }

      if (decision.action === "extract") {
        /**
         * Invoked in the mutation's own event shape, exactly as `lead-reply`
         * does, so the PENDING marking and the self-invoke stay in one place
         * rather than being half-reimplemented here. The next tick sees a
         * terminal status and sends.
         */
        await lambda.send(
          new InvokeCommand({
            FunctionName: process.env.EXTRACT_LEAD_FUNCTION,
            InvocationType: "Event",
            Payload: Buffer.from(
              JSON.stringify({ arguments: { accountId: portal.accountId } })
            ),
          })
        );
        summary.extracting++;
        console.log("portal-sweep extraction started", portal.id, decision.reason);
        continue;
      }

      /**
       * Only what arrived since the last time anyone was told — and only what
       * genuinely arrived. A requested-but-abandoned upload leaves a row behind
       * with no object under it.
       */
      const fresh = await landed(
        documents.filter((d) => !decision.since || (d.createdAt ?? "") > decision.since)
      );
      const arrived = arrivedSections(fresh);
      if (arrived.length === 0) {
        /**
         * Files landed, but none against a checklist section — a staff upload,
         * or the post-submit panel's uncategorised files, which the auto-reply
         * already covered. Nothing to announce; mark it reported so this portal
         * stops being reconsidered.
         */
        await client.models.UploadPortal.update({
          id: portal.id,
          notifiedUpTo: decision.upTo,
        });
        summary.waiting++;
        continue;
      }

      const receivedCategories = new Set(
        documents.map((d) => d.category).filter(Boolean)
      );
      const outstanding = REQUESTED_DOCUMENTS.filter(
        (r) => !receivedCategories.has(r.category as never)
      ).map((r) => r.label);

      const { subject, text, html } = renderNotification({
        associationName: account.data.name,
        accountId: portal.accountId,
        arrived,
        extracted: headlines(account.data.aiExtraction),
        outstanding,
        crmBaseUrl: process.env.CRM_BASE_URL ?? "",
      });

      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: FROM,
          Destination: { ToAddresses: [MAILBOX] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: text, Charset: "UTF-8" },
                Html: { Data: html, Charset: "UTF-8" },
              },
            },
          },
        })
      );

      /**
       * Marked with the `lastUploadAt` the decision was made against, not with
       * `now`. A file that landed while this email was being built keeps
       * `lastUploadAt` ahead of `notifiedUpTo`, so the next quiet period reports
       * it instead of it being swallowed by this write.
       */
      await client.models.UploadPortal.update({
        id: portal.id,
        notifiedUpTo: decision.upTo,
      });
      summary.sent++;
      console.log("portal-sweep sent", portal.id, JSON.stringify({ subject }));
    } catch (err) {
      // One bad portal must not stop the others.
      summary.failed++;
      console.error("portal-sweep failed for", portal.id, err);
    }
  }

  console.log("portal-sweep", JSON.stringify(summary));
  return summary;
};

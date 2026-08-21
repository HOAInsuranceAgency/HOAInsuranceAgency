import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { safeSegment } from "../../../src/lib/storageKeys";
import { operationOf } from "./dispatch";
import {
  IDLE_AFTER_UPLOAD_MINUTES,
  MAX_FILES,
  REJECTION_MESSAGE,
  rejectUpload,
} from "../../../../shared/leadUpload";
import { reserveUploadSlot } from "../uploadQuota";

/**
 * Public document upload for a website lead. See resource.ts for the why.
 *
 * Two fields on one function because they share every guard: resolve the token
 * to a live window, or refuse. Splitting them would duplicate that.
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

const s3 = new S3Client();

/** The presign's validity. Long enough for a slow phone on a big PDF. */
const PRESIGN_TTL_SECONDS = 900;

const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

/**
 * The window this token names, or null.
 *
 * Deliberately indistinguishable outcomes for "no such token", "already sent"
 * and "already closed": all three return null and the caller is told the same
 * thing. A caller probing tokens learns nothing about which ones exist.
 */
async function liveWindow(client: DataClient, uploadToken: unknown) {
  if (typeof uploadToken !== "string" || uploadToken.length < 20) return null;
  const { data } = await client.models.LeadReply.listLeadReplyByUploadToken({
    uploadToken,
  });
  const reply = data?.[0];
  if (!reply) return null;
  if (reply.status !== "WAITING") return null;
  return reply;
}

const refused = { ok: false, error: "That upload link is no longer active." };

async function handleRequestUpload(
  client: DataClient,
  args: Record<string, unknown>
) {
  const reply = await liveWindow(client, args.uploadToken);
  if (!reply) return refused;

  const filename = String(args.filename ?? "");
  /**
   * The declared size is now load-bearing: it is signed into the PUT below, so
   * a body of any other length fails at S3. That only works if there is a real
   * number here, hence the refusal rather than a fallback.
   */
  const sizeBytes = typeof args.sizeBytes === "number" ? args.sizeBytes : NaN;
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: "We couldn't tell how large that file is." };
  }
  // Re-checked here, not just in the form: this mutation is public, so the
  // browser's validation is a courtesy and this is the actual limit.
  const rejection = rejectUpload({ filename, sizeBytes, alreadyUploaded: 0 });
  if (rejection) return { ok: false, error: REJECTION_MESSAGE[rejection] };

  /**
   * The count ceiling, taken atomically before anything is created.
   *
   * `rejectUpload` above is passed `alreadyUploaded: 0` on purpose — its count
   * rule cannot be enforced from a value read a moment ago, so the ceiling is
   * enforced here instead and what is wanted from it is its type, size and
   * filename rules.
   */
  const slot = await reserveUploadSlot({
    tableName: process.env.LEAD_REPLY_TABLE as string,
    id: reply.id,
    max: MAX_FILES,
  });
  if (slot === null) {
    return { ok: false, error: REJECTION_MESSAGE.count };
  }

  const { data: doc, errors } = await client.models.Document.create({
    entityType: "ACCOUNT",
    entityId: reply.accountId,
    // Unknown until someone looks: a visitor sending "our policy" may be
    // sending a dec page, a budget or the condo docs. OTHER is honest, and the
    // extraction pass does not depend on the category being right.
    category: "OTHER",
    name: filename,
    s3Key: "pending",
    contentType: typeof args.contentType === "string" ? args.contentType : undefined,
    sizeBytes,
    ocrStatus: "PENDING",
    lastWriteBy: "lead-upload",
  });
  if (errors?.length || !doc) {
    return { ok: false, error: "We couldn't accept that file. Please try again." };
  }

  // Same layout as a staff upload, so `process-document` can parse the
  // Document id back out of the key and OCR fires with no special case.
  const key = [
    "documents",
    "ACCOUNT",
    safeSegment(reply.accountId),
    safeSegment(doc.id),
    safeSegment(filename),
  ].join("/");

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: process.env.DOCUMENTS_BUCKET,
      Key: key,
      ContentType: typeof args.contentType === "string" ? args.contentType : undefined,
      /**
       * This is what makes the size limit real.
       *
       * `ContentLength` becomes part of `X-Amz-SignedHeaders`, so the body must
       * be exactly this long or S3 rejects the signature. Without it the limit
       * was advisory: a caller declared a kilobyte, passed the check, and PUT
       * whatever it liked into the bucket.
       */
      ContentLength: sizeBytes,
    }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );

  await client.models.Document.update({ id: doc.id, s3Key: key });

  /**
   * The window moves on *request*, not on completion.
   *
   * The browser tells us when a PUT finishes, and a browser that has gone away
   * cannot. Extending here means a visitor whose upload is still in flight when
   * the old deadline passes does not get their reply sent out from under them.
   * The cost is that an abandoned picker also extends the wait by 8 minutes,
   * which is the cheaper mistake.
   */
  const now = new Date().toISOString();
  // `uploadCount` is deliberately absent: it was incremented atomically above
  // and passing it here would write back a value read before that.
  await client.models.LeadReply.update({
    id: reply.id,
    lastUploadAt: now,
    dueAt: minutesFromNow(IDLE_AFTER_UPLOAD_MINUTES),
  });

  return { ok: true, documentId: doc.id, uploadUrl: url, uploadCount: slot };
}

async function handleCloseWindow(
  client: DataClient,
  args: Record<string, unknown>
) {
  const reply = await liveWindow(client, args.uploadToken);
  // Already sent or unknown: report success. The caller is usually a beacon
  // firing as a tab dies and cannot act on an error, and "your reply already
  // went" is not a failure from the visitor's side.
  if (!reply) return { ok: true, alreadyClosed: true };

  const now = new Date().toISOString();
  await client.models.LeadReply.update({
    id: reply.id,
    closedAt: now,
    // Only ever brings the deadline forward — there is no public path that
    // pushes it out, so a token cannot hold a reply open.
    dueAt: now,
  });
  return { ok: true };
}

export const handler = async (event: {
  info?: { fieldName?: string };
  arguments?: Record<string, unknown>;
}) => {
  const client = await getDataClient();
  const args = event.arguments ?? {};

  // NOT `event.info.fieldName` — Amplify's generated resolver does not send
  // `info`. See dispatch.ts; this dispatched to nothing until a live probe
  // showed every call returning "Unknown operation."
  switch (operationOf(event)) {
    case "requestLeadUpload":
      return handleRequestUpload(client, args);
    case "closeLeadUploadWindow":
      return handleCloseWindow(client, args);
    default:
      return { ok: false, error: "Unknown operation." };
  }
};

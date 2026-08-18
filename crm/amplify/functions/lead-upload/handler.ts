import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { safeSegment } from "../../../src/lib/storageKeys";
import {
  IDLE_AFTER_UPLOAD_MINUTES,
  REJECTION_MESSAGE,
  rejectUpload,
} from "../../../../shared/leadUpload";

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
  const sizeBytes = typeof args.sizeBytes === "number" ? args.sizeBytes : undefined;
  // Re-checked here, not just in the form: this mutation is public, so the
  // browser's validation is a courtesy and this is the actual limit.
  const rejection = rejectUpload({
    filename,
    sizeBytes,
    alreadyUploaded: reply.uploadCount ?? 0,
  });
  if (rejection) return { ok: false, error: REJECTION_MESSAGE[rejection] };

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
  const uploadCount = (reply.uploadCount ?? 0) + 1;
  const now = new Date().toISOString();
  await client.models.LeadReply.update({
    id: reply.id,
    uploadCount,
    lastUploadAt: now,
    dueAt: minutesFromNow(IDLE_AFTER_UPLOAD_MINUTES),
  });

  return { ok: true, documentId: doc.id, uploadUrl: url, uploadCount };
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

  switch (event.info?.fieldName) {
    case "requestLeadUpload":
      return handleRequestUpload(client, args);
    case "closeLeadUploadWindow":
      return handleCloseWindow(client, args);
    default:
      return { ok: false, error: "Unknown operation." };
  }
};

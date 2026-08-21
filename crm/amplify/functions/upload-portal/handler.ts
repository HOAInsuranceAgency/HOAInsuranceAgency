import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { safeSegment } from "../../../src/lib/storageKeys";
import { listAllPages } from "../../../src/lib/pagination";
import { REJECTION_MESSAGE, rejectUpload } from "../../../../shared/leadUpload";
import { PORTAL_MAX_FILES } from "../../../../shared/leadDocuments";
import { reserveUploadSlot } from "../uploadQuota";
import {
  PORTAL_REFUSAL_MESSAGE,
  buildChecklist,
  categoryForUpload,
  looksLikeToken,
  refusalFor,
} from "./portal";

/**
 * The lead document portal. See resource.ts for why it is its own function.
 *
 * Two fields, told apart by an explicit argument rather than by sniffing: a
 * `uploadPortalStatus` call has only a token, a `requestPortalUpload` call has a
 * `documentKey`. That is the "give it an argument no other one has" rule
 * `lead-upload/dispatch.ts` asks for, and here it falls out of the shapes
 * naturally.
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

/**
 * The portal this token names, or null.
 *
 * Returns the row whatever its state, so the caller can tell an expired link
 * (worth explaining) from an unknown one (worth saying nothing about). The
 * decision about which is which lives in `refusalFor`.
 */
async function findPortal(client: DataClient, token: unknown) {
  if (!looksLikeToken(token)) return null;
  const { data } = await client.models.UploadPortal.listUploadPortalByToken({
    token,
  });
  return data?.[0] ?? null;
}

/**
 * Every document on the account, for the checklist counts.
 *
 * Paged, for the reason `extract-lead` is: DynamoDB applies `filter` after
 * reading a page, so a single `list()` returns nothing once an account's rows
 * fall outside the first ~100 scanned. A portal whose checklist silently reads
 * all-zeroes would have a board re-sending everything they had already sent.
 */
async function documentsFor(client: DataClient, accountId: string) {
  return listAllPages((nextToken) =>
    client.models.Document.list({
      filter: { entityId: { eq: accountId } },
      limit: 1000,
      nextToken,
    })
  );
}

async function handleGetPortal(client: DataClient, args: Record<string, unknown>) {
  const portal = await findPortal(client, args.token);
  const now = new Date().toISOString();
  const refusal = refusalFor(portal, now);

  // `full` is not a reason to refuse to *render* the page — the checklist is
  // still worth seeing, and the message explains why nothing more will upload.
  if (refusal && refusal !== "full") {
    return { ok: false, error: PORTAL_REFUSAL_MESSAGE[refusal] };
  }
  if (!portal) return { ok: false, error: PORTAL_REFUSAL_MESSAGE.unknown };

  const account = await client.models.Account.get({ id: portal.accountId });
  if (!account.data) {
    // The account was deleted under the link. Same answer as a bad token.
    return { ok: false, error: PORTAL_REFUSAL_MESSAGE.unknown };
  }

  const documents = await documentsFor(client, portal.accountId);

  /**
   * Deliberately thin.
   *
   * Anyone holding this token gets the association's display name — which they
   * already know, because they filled in the form — the checklist, and how much
   * of it has landed. No contact details, no address, no document names, no ids.
   * A guessed token should be worth as little as possible.
   */
  return {
    ok: true,
    associationName: account.data.name,
    expiresAt: portal.expiresAt,
    uploadCount: portal.uploadCount ?? 0,
    maxFiles: PORTAL_MAX_FILES,
    full: refusal === "full",
    sections: buildChecklist(documents),
  };
}

async function handleRequestUpload(
  client: DataClient,
  args: Record<string, unknown>
) {
  const portal = await findPortal(client, args.token);
  const refusal = refusalFor(portal, new Date().toISOString());
  if (refusal || !portal) {
    return { ok: false, error: PORTAL_REFUSAL_MESSAGE[refusal ?? "unknown"] };
  }

  /**
   * The section decides the category, not the caller.
   *
   * This is a public mutation, so an unrecognised key is a caller sending
   * something the page cannot have sent. Refused rather than filed as OTHER:
   * quietly accepting invented keys is how junk categories get into the CRM.
   */
  const category = categoryForUpload(args.documentKey);
  if (!category) {
    return { ok: false, error: "We couldn't tell what that file is for." };
  }

  const filename = String(args.filename ?? "");
  /** Signed into the PUT below, so it has to be a real number. */
  const sizeBytes = typeof args.sizeBytes === "number" ? args.sizeBytes : NaN;
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: "We couldn't tell how large that file is." };
  }
  const contentType =
    typeof args.contentType === "string" ? args.contentType : undefined;
  /**
   * Re-checked here, not just in the page: this mutation is public, so the
   * browser's validation is a courtesy and this is the actual limit.
   *
   * `alreadyUploaded: 0` because the count ceiling is taken atomically below
   * rather than compared against a value read a moment ago. What is wanted from
   * `rejectUpload` here is its type, size and filename rules.
   */
  const rejection = rejectUpload({ filename, sizeBytes, alreadyUploaded: 0 });
  if (rejection) return { ok: false, error: REJECTION_MESSAGE[rejection] };

  /**
   * One slot, atomically. `refusalFor` above also checks the ceiling, from a
   * row read a moment ago — that check is what renders a helpful message on the
   * page, and this is what actually holds under two requests at once.
   */
  const slot = await reserveUploadSlot({
    tableName: process.env.UPLOAD_PORTAL_TABLE as string,
    id: portal.id,
    max: PORTAL_MAX_FILES,
  });
  if (slot === null) {
    return { ok: false, error: PORTAL_REFUSAL_MESSAGE.full };
  }

  const { data: doc, errors } = await client.models.Document.create({
    entityType: "ACCOUNT",
    entityId: portal.accountId,
    // The one real advantage this has over the post-submit panel: the visitor
    // told us which question they were answering, so the document arrives filed
    // instead of as an untyped blob for someone to open and categorise.
    category: category as Schema["Document"]["type"]["category"],
    name: filename,
    s3Key: "pending",
    contentType,
    sizeBytes,
    ocrStatus: "PENDING",
    lastWriteBy: "upload-portal",
  });
  if (errors?.length || !doc) {
    return { ok: false, error: "We couldn't accept that file. Please try again." };
  }

  // Same layout as a staff upload, so `process-document` parses the Document id
  // back out of the key and OCR fires with no special case.
  const key = [
    "documents",
    "ACCOUNT",
    safeSegment(portal.accountId),
    safeSegment(doc.id),
    safeSegment(filename),
  ].join("/");

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: process.env.DOCUMENTS_BUCKET,
      Key: key,
      ContentType: contentType,
      // Signed, so a body of any other length is rejected by S3 — see the note
      // in lead-upload for what this closes.
      ContentLength: sizeBytes,
    }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );

  await client.models.Document.update({ id: doc.id, s3Key: key });

  /**
   * Counted on *request*, not on completion, for the same reason the reply
   * window moves on request: a browser that has gone away cannot tell us the PUT
   * finished. Over-counting an abandoned picker is the cheaper mistake than
   * letting the file ceiling be bypassed by never reporting success.
   *
   * `lastUploadAt` is what the notification sweep compares against
   * `notifiedUpTo`, so this write is also what eventually tells the team.
   */
  // `uploadCount` is absent here on purpose: it was incremented atomically
  // above, and writing back a value read before that would undo the point.
  await client.models.UploadPortal.update({
    id: portal.id,
    lastUploadAt: new Date().toISOString(),
  });

  return {
    ok: true,
    documentId: doc.id,
    uploadUrl: url,
    uploadCount: slot,
    category,
  };
}

export const handler = async (event: {
  info?: { fieldName?: string };
  arguments?: Record<string, unknown>;
}) => {
  const client = await getDataClient();
  const args = event.arguments ?? {};

  try {
    // An explicit discriminator, not argument sniffing: only an upload names a
    // section. `info.fieldName` is preferred if a future runtime supplies it,
    // which today it does not — see lead-upload/dispatch.ts.
    const named = event.info?.fieldName;
    const isUpload =
      named === "requestPortalUpload" ||
      (named !== "getUploadPortal" && typeof args.documentKey === "string");

    return isUpload
      ? await handleRequestUpload(client, args)
      : await handleGetPortal(client, args);
  } catch (err) {
    // Never leak an internal message to a public caller.
    console.error("upload-portal failed", err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
};

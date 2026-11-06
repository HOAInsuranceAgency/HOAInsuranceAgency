import { assertWebsiteActionsEnabled } from "./migrationPreview";
import { publicApi } from "./publicApi";
import { readPortalStatus, readUploadDestination, type PortalStatus } from '../../../shared/publicUploads';
/**
 * The lead document portal's two calls against the CRM's public AppSync API.
 *
 * Sibling of `crmLead.ts` and configured by the same two env vars. Unlike that
 * module these DO surface failure to the caller: `crmLead` never throws because
 * a CRM hiccup must not break a quote form, whereas here the upload IS the page,
 * and a silent failure would have someone believe they had sent us their loss
 * runs when they had not.
 */

const API_URL = import.meta.env.PUBLIC_CRM_API_URL;
const API_KEY = import.meta.env.PUBLIC_CRM_API_KEY;

const STATUS_QUERY = `query UploadPortalStatus($token: String!) {
  uploadPortalStatus(token: $token)
}`;

const UPLOAD_MUTATION = `mutation RequestPortalUpload(
  $token: String!, $documentKey: String!, $filename: String!,
  $contentType: String, $sizeBytes: Int!
) {
  requestPortalUpload(
    token: $token, documentKey: $documentKey, filename: $filename,
    contentType: $contentType, sizeBytes: $sizeBytes
  )
}`;

async function call(query: string, variables: Record<string, unknown>, field: string) {
  return publicApi(query, variables, field, {
    url: API_URL, key: API_KEY, configurationError: 'Uploads are not configured on this build.',
    refused: 'That upload link is no longer active.',
  });
}

export async function fetchPortalStatus(token: string): Promise<PortalStatus> {
  const r = await call(STATUS_QUERY, { token }, "uploadPortalStatus");
  const status = readPortalStatus(r);
  if (!status) throw new Error('The server sent back something unreadable.');
  return status;
}

/**
 * Ask for somewhere to put one file, then PUT it there.
 *
 * The presign and the upload are one call from the page's point of view because
 * there is nothing useful it could do between them. Failure at either step is
 * the same outcome: this file did not arrive, say so on its row.
 */
export async function uploadPortalFile(
  token: string,
  documentKey: string,
  file: File
): Promise<void> {
  const r = await call(
    UPLOAD_MUTATION,
    {
      token,
      documentKey,
      filename: file.name,
      contentType: file.type || undefined,
      sizeBytes: file.size,
    },
    "requestPortalUpload"
  );
  const receipt = readUploadDestination(r);
  if (!receipt) throw new Error("The server didn't give us anywhere to put it.");

  assertWebsiteActionsEnabled();
  const put = await fetch(receipt.uploadUrl, {
    method: "PUT",
    // Must match the Content-Type the presign was signed with, or S3 rejects
    // the signature. An empty type is signed as absent and sent as absent.
    headers: file.type ? { "Content-Type": file.type } : undefined,
    body: file,
  });
  if (!put.ok) throw new Error(`That upload failed (${put.status}).`);
}

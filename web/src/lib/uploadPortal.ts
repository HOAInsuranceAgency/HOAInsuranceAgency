import { assertWebsiteActionsEnabled } from "./migrationPreview";
import { publicApi } from "./publicApi";
import { isHttpsUrl, isRecord } from '../../../shared/apiResponse';
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

export interface PortalSection {
  key: string;
  label: string;
  help: string;
  received: number;
}

export interface PortalStatus {
  associationName: string;
  expiresAt: string;
  uploadCount: number;
  maxFiles: number;
  full: boolean;
  sections: PortalSection[];
}

export async function fetchPortalStatus(token: string): Promise<PortalStatus> {
  const r = await call(STATUS_QUERY, { token }, "uploadPortalStatus");
  if (typeof r.associationName !== 'string' || typeof r.expiresAt !== 'string' || typeof r.full !== 'boolean'
    || !Number.isSafeInteger(r.uploadCount) || Number(r.uploadCount) < 0 || !Number.isSafeInteger(r.maxFiles) || Number(r.maxFiles) < 0
    || !Array.isArray(r.sections) || !r.sections.every(section => isRecord(section) && ['key', 'label', 'help'].every(key => typeof section[key] === 'string') && Number.isSafeInteger(section.received) && Number(section.received) >= 0)) {
    throw new Error('The server sent back something unreadable.');
  }
  return {
    associationName: String(r.associationName ?? "your association"),
    expiresAt: String(r.expiresAt ?? ""),
    uploadCount: Number(r.uploadCount ?? 0),
    maxFiles: Number(r.maxFiles ?? 0),
    full: r.full === true,
    sections: r.sections.map(section => ({ key: String(section.key), label: String(section.label), help: String(section.help), received: Number(section.received) })),
  };
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
  const uploadUrl = r.uploadUrl;
  if (!isHttpsUrl(uploadUrl)) throw new Error("The server didn't give us anywhere to put it.");

  assertWebsiteActionsEnabled();
  const put = await fetch(uploadUrl, {
    method: "PUT",
    // Must match the Content-Type the presign was signed with, or S3 rejects
    // the signature. An empty type is signed as absent and sent as absent.
    headers: file.type ? { "Content-Type": file.type } : undefined,
    body: file,
  });
  if (!put.ok) throw new Error(`That upload failed (${put.status}).`);
}

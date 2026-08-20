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
  $contentType: String, $sizeBytes: Int
) {
  requestPortalUpload(
    token: $token, documentKey: $documentKey, filename: $filename,
    contentType: $contentType, sizeBytes: $sizeBytes
  )
}`;

/**
 * `a.json()` is AWSJSON on the wire, which is a JSON *string*, and the fetch
 * above does no parsing. Same trap `crmLead.ts` documents: reading past the
 * string cost a working upload panel once already.
 */
function unwrap(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return null;
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

async function call(
  query: string,
  variables: Record<string, unknown>,
  field: string
): Promise<Record<string, unknown>> {
  if (!API_URL || !API_KEY) {
    throw new Error("Uploads are not configured on this build.");
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`We couldn't reach the server (${res.status}).`);
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors[0].message ?? "The server refused that request.");
  }
  const result = unwrap(body.data?.[field]);
  if (!result) throw new Error("The server sent back something unreadable.");
  // The handler's own refusals arrive as { ok: false, error }, and its messages
  // are written to be shown — an expired link explains how to get a new one.
  if (result.ok !== true) {
    throw new Error(String(result.error ?? "That upload link is no longer active."));
  }
  return result;
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
  return {
    associationName: String(r.associationName ?? "your association"),
    expiresAt: String(r.expiresAt ?? ""),
    uploadCount: Number(r.uploadCount ?? 0),
    maxFiles: Number(r.maxFiles ?? 0),
    full: r.full === true,
    sections: Array.isArray(r.sections) ? (r.sections as PortalSection[]) : [],
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
  const uploadUrl = String(r.uploadUrl ?? "");
  if (!uploadUrl) throw new Error("The server didn't give us anywhere to put it.");

  const put = await fetch(uploadUrl, {
    method: "PUT",
    // Must match the Content-Type the presign was signed with, or S3 rejects
    // the signature. An empty type is signed as absent and sent as absent.
    headers: file.type ? { "Content-Type": file.type } : undefined,
    body: file,
  });
  if (!put.ok) throw new Error(`That upload failed (${put.status}).`);
}

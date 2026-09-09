/** Durable website lead capture. A success means the CRM saved the enquiry. */
import { useRef } from "react";
import type { AccountType } from "../../../shared/accountType";

export interface CrmLeadInput {
  /** The CRM's `AccountType`. Named in `shared/` because it is the one schema
   *  enum both apps use, and `web` cannot import the CRM's Amplify schema. */
  type?: AccountType;
  name: string;
  answerSnapshot?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  unitNumber?: string;
  currentCarrier?: string;
  /** Sent as a string: the mutation parses it into `Account.unitCount`. */
  unitCount?: string;
  /** `YYYY-MM-DD`. Becomes `Account.currentPolicyExpiration`. */
  currentPolicyExpiration?: string;
  buildiumId?: string;
  source?: string;
  notes?: string;
}

/**
 * Hand-written, and every variable has to be named three times: once in the
 * signature, once in the call, and once as a key of `CrmLeadInput`. A field
 * missing from any of the three is dropped in silence with no type error, which
 * is how a unit count reached the CRM only as prose for months.
 * `webLeadFields.test.ts` in the CRM compares all three and fails on a mismatch.
 */
const MUTATION = `mutation SubmitWebLead(
  $submissionId: String!, $retryProof: String!, $answerSnapshot: String,
  $type: String, $name: String!, $contactFirstName: String, $contactLastName: String,
  $contactEmail: String, $contactPhone: String, $address: String, $city: String,
  $state: String, $zip: String, $unitNumber: String, $currentCarrier: String,
  $unitCount: String, $currentPolicyExpiration: String,
  $buildiumId: String, $source: String, $notes: String
) {
  submitWebLead(
    submissionId: $submissionId, retryProof: $retryProof, answerSnapshot: $answerSnapshot,
    type: $type, name: $name, contactFirstName: $contactFirstName,
    contactLastName: $contactLastName, contactEmail: $contactEmail,
    contactPhone: $contactPhone, address: $address, city: $city, state: $state,
    zip: $zip, unitNumber: $unitNumber, currentCarrier: $currentCarrier,
    unitCount: $unitCount, currentPolicyExpiration: $currentPolicyExpiration,
    buildiumId: $buildiumId, source: $source, notes: $notes
  )
}`;

/**
 * Successful durable intake receipt. Failures throw so the form keeps its
 * answers and shows a retryable error.
 */
export interface CrmLeadResult {
  accountId: string;
  /** Absent when the lead had no email address to reply to. */
  uploadToken: string | null;
}

/**
 * Unwrap what AppSync returns for an `a.json()` mutation.
 *
 * It comes back as a JSON *string*, not an object — `AWSJSON` is serialised, so
 * `data.submitWebLead` is `"{\"ok\":true,…}"`. Reading `.ok` off that is
 * `undefined`, which silently looked exactly like a refusal: intake worked, the
 * lead was created, and the browser concluded it had failed. That is why no
 * upload panel ever appeared.
 *
 * Tolerates an object too, in case a future runtime stops stringifying.
 */
function unwrap(payload: unknown): Record<string, unknown> | null {
  if (payload == null) return null;
  if (typeof payload === "object") return payload as Record<string, unknown>;
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export interface SubmissionIdentity { submissionId: string; retryProof: string }
export async function submitCrmLead(input: CrmLeadInput, identity: SubmissionIdentity): Promise<CrmLeadResult> {
  const url = import.meta.env.PUBLIC_CRM_API_URL;
  const key = import.meta.env.PUBLIC_CRM_API_KEY;
  if (!url || !key) throw new Error("The enquiry form is temporarily unavailable. Please call us.");
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query: MUTATION, variables: { ...input, ...identity } }),
    signal: AbortSignal.timeout(40000),
  });
  if (!response.ok) throw new Error("We couldn't confirm your request. Please try again.");
  const body = await response.json();
  if (body.errors?.length) throw new Error("We couldn't save your request. Please try again.");
  const result = unwrap(body.data?.submitWebLead);
  if (!result?.ok || typeof result.id !== "string") throw new Error(String(result?.error ?? "We couldn't save your request."));
  return { accountId: result.id, uploadToken: typeof result.uploadToken === "string" ? result.uploadToken : null };
}

/** Keep the same identity and proof through double clicks, timeouts and reloads. */
export function createLeadSubmission(send: typeof submitCrmLead = submitCrmLead) {
  const state: { current?: { identity: SubmissionIdentity; source: string; pending?: Promise<CrmLeadResult>; result?: CrmLeadResult; payload?: string } } = {};
  return {
    async submit(input: CrmLeadInput): Promise<CrmLeadResult> {
      const source = input.source ?? "website", payload = JSON.stringify(input);
      const storageKey = `hoa:submission:${source}`;
      // Identities belong to exact answers. A corrected enquiry is a new
      // submission; retrying unchanged answers still recovers the same receipt.
      if (state.current && (state.current.payload !== payload || state.current.source !== source)) state.current = undefined;
      if (!state.current) {
        let identity: SubmissionIdentity | undefined;
        try { const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null"); if (saved?.payload === payload && saved?.identity?.submissionId && saved.identity.retryProof) identity = saved.identity; } catch { /* Storage may be disabled. Memory still protects retries. */ }
        identity ??= { submissionId: crypto.randomUUID(), retryProof: Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, "0")).join("") };
        state.current = { identity, source, payload };
        try { sessionStorage.setItem(storageKey, JSON.stringify({ identity, payload })); } catch { /* Optional reload recovery. */ }
      }
      const current = state.current;
      if (current.result) return current.result;
      if (current.pending) return current.pending;
      current.pending = send(input, current.identity);
      try {
        current.result = await current.pending;
        try { if (JSON.parse(sessionStorage.getItem(storageKey) ?? "null")?.identity?.submissionId === current.identity.submissionId) sessionStorage.removeItem(storageKey); } catch { /* Capture already succeeded. */ }
        return current.result;
      } finally { current.pending = undefined; }
    },
    reset() { state.current = undefined; },
  };
}
export function useLeadSubmission() {
  const controller = useRef<ReturnType<typeof createLeadSubmission>>();
  controller.current ??= createLeadSubmission();
  return controller.current;
}

/* ──────────────────────────────────────────────────────────
   Post-submit document upload

   Both calls are gated server-side on `uploadToken`. Nothing here sends an
   account id — the token is the only thing that names the lead, so a stolen or
   guessed value is the only attack surface and it is unguessable.
   ────────────────────────────────────────────────────────── */

const REQUEST_UPLOAD = `mutation RequestLeadUpload(
  $uploadToken: String!, $filename: String!, $contentType: String, $sizeBytes: Int!
) {
  requestLeadUpload(
    uploadToken: $uploadToken, filename: $filename,
    contentType: $contentType, sizeBytes: $sizeBytes
  )
}`;

const CLOSE_WINDOW = `mutation CloseLeadUploadWindow($uploadToken: String!) {
  closeLeadUploadWindow(uploadToken: $uploadToken)
}`;

async function crmMutation(
  query: string,
  variables: Record<string, unknown>,
  opts?: { keepalive?: boolean }
): Promise<Record<string, unknown> | null> {
  const url = import.meta.env.PUBLIC_CRM_API_URL;
  const key = import.meta.env.PUBLIC_CRM_API_KEY;
  if (!url || !key) return null;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, variables }),
    // `keepalive`, not sendBeacon: a beacon cannot set the x-api-key header
    // AppSync requires, and this has to survive the page going away.
    keepalive: opts?.keepalive,
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  const [payload] = Object.values(body.data ?? {});
  return unwrap(payload);
}

/**
 * Reserve somewhere for one file and PUT it there.
 *
 * Throws with a message meant for the visitor — the panel shows it against the
 * row for that file. Like intake, this is not fail-soft: someone who just
 * chose a file needs to know it did not arrive.
 */
export async function uploadLeadFile(
  uploadToken: string,
  file: File
): Promise<void> {
  const result = await crmMutation(REQUEST_UPLOAD, {
    uploadToken,
    filename: file.name,
    contentType: file.type || undefined,
    sizeBytes: file.size,
  });
  if (!result?.ok) {
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : "We couldn't accept that file."
    );
  }
  const put = await fetch(String(result.uploadUrl), {
    method: "PUT",
    // Must match the type the URL was signed with, or S3 rejects it.
    headers: file.type ? { "Content-Type": file.type } : undefined,
    body: file,
  });
  if (!put.ok) throw new Error("That upload didn't complete. Please try again.");
}

/**
 * "I'm finished" — or the tab is going away. Brings the reply forward.
 *
 * Never throws: both callers are places where an error has nowhere to go, and
 * the server sends the reply on its own schedule regardless.
 */
export async function closeLeadUploads(
  uploadToken: string,
  opts?: { keepalive?: boolean }
): Promise<void> {
  try {
    await crmMutation(CLOSE_WINDOW, { uploadToken }, opts);
  } catch (err) {
    console.warn("Closing the upload window failed", err);
  }
}

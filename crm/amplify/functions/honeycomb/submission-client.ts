import { signature } from "./client";
import { object, portalUrl, type PartialInput } from "./submission-contract";
export const PARTIAL_PATH = "/v1/submissions/partial";
export type PartialResult = { status: "CREATED" | "EXISTING" | "REJECTED" | "UNKNOWN"; submissionId?: string; readableSubmissionId?: string; submissionStatus?: string; portalUrl?: string; result?: string; issue?: string };
export function partialResult(status: number, value: unknown): PartialResult {
  const data = object(value);
  const fields = ["submissionId", "submissionStatus", "readableSubmissionId", "declinationReasons", "message", "code", "details"];
  const result = JSON.stringify(Object.fromEntries(fields.filter(k => data[k] !== undefined).map(k => [k, data[k]])));
  const stored = Buffer.byteLength(result) <= 12000 ? { result } : {};
  const id = typeof data.submissionId === "string" ? data.submissionId : "";
  if ((status === 200 || status === 409 && data.code === "DUPLICATE_SUBMISSION_FOUND") && portalUrl(id) && typeof data.submissionStatus === "string" && data.submissionStatus.trim().length > 0 && data.submissionStatus.length < 100) {
    return { status: status === 200 ? "CREATED" : "EXISTING", submissionId: id, submissionStatus: data.submissionStatus,
      readableSubmissionId: typeof data.readableSubmissionId === "string" ? data.readableSubmissionId.slice(0, 200) : undefined,
      portalUrl: portalUrl(id), ...stored };
  }
  // A 409 without an existing ID, malformed success, 5xx or transport failure may have created a submission.
  return { status: [400, 401, 403, 422].includes(status) ? "REJECTED" : "UNKNOWN", issue: `HTTP_${status}`, ...stored };
}
export async function createPartial(input: PartialInput, request: typeof fetch = fetch): Promise<PartialResult> {
  const env = process.env;
  if (env.HONEYCOMB_ENABLED !== "true" || env.HONEYCOMB_API_BASE_URL !== "https://staging-api.honeycombinsurance.com" || !env.HONEYCOMB_API_SECRET_KEY || !env.HONEYCOMB_API_USER || !env.HONEYCOMB_PRODUCER_ID) return { status: "REJECTED", issue: "CONFIGURATION" };
  const body = JSON.stringify(input);
  try {
    const response = await request(env.HONEYCOMB_API_BASE_URL + PARTIAL_PATH, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", "x-user": env.HONEYCOMB_API_USER, "x-producer-id": env.HONEYCOMB_PRODUCER_ID,
        "x-signature": signature("POST", body, PARTIAL_PATH, env.HONEYCOMB_API_SECRET_KEY) }, body,
    });
    return partialResult(response.status, object(await response.text()));
  } catch (error) {
    return { status: "UNKNOWN", issue: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "TIMEOUT" : "REQUEST_FAILED" };
  }
}

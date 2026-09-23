import { createHmac } from "node:crypto";
import type { EstimateInput } from "./contract";
export const ESTIMATE_PATH = "/v1/estimations/eligibility-and-price-indication";
export function signature(method: string, body: string, path: string, key: string) {
  return createHmac("sha256", key).update(method.toUpperCase() + body + path, "utf8").digest("hex");
}
export type CarrierResult = { status: "READY" | "DECLINED" | "UNAVAILABLE" | "ERROR"; price?: number; estimationId?: string; result?: string; issue?: string };
export function parseResult(value: unknown): CarrierResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "ERROR", issue: "INVALID_RESPONSE" };
  const data = value as Record<string, unknown>;
  if (typeof data.isOkToSubmit !== "boolean") return { status: "ERROR", issue: "INVALID_RESPONSE" };
  // Store only the documented fields, bounded to DynamoDB's item limit.
  const result = JSON.stringify(Object.fromEntries(["isOkToSubmit", "program", "priceIndication", "estimationId", "buildingLimit", "generalLiability", "deductibles", "declinationReasons", "admittedDeclinationReasons"].filter(k => data[k] !== undefined).map(k => [k, data[k]])));
  if (Buffer.byteLength(result) > 64_000) return { status: "ERROR", issue: "INVALID_RESPONSE" };
  const metadata = { result, ...(typeof data.estimationId === "string" ? { estimationId: data.estimationId.slice(0, 200) } : {}) };
  if (!data.isOkToSubmit) return { status: "DECLINED", ...metadata };
  return typeof data.priceIndication === "number" && Number.isFinite(data.priceIndication) && data.priceIndication > 0
    ? { status: "READY", price: data.priceIndication, ...metadata }
    : { status: "UNAVAILABLE", issue: "NO_PRICE", ...metadata };
}
export async function estimate(input: EstimateInput, request: typeof fetch = fetch): Promise<CarrierResult> {
  const env = process.env;
  if (env.HONEYCOMB_ENABLED !== "true" || env.HONEYCOMB_API_BASE_URL !== "https://staging-api.honeycombinsurance.com" || !env.HONEYCOMB_API_SECRET_KEY || !env.HONEYCOMB_API_USER || !env.HONEYCOMB_PRODUCER_ID) return { status: "ERROR", issue: "CONFIGURATION" };
  const body = JSON.stringify(input);
  try {
    const response = await request(env.HONEYCOMB_API_BASE_URL + ESTIMATE_PATH, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", "x-user": env.HONEYCOMB_API_USER, "x-producer-id": env.HONEYCOMB_PRODUCER_ID,
        "x-signature": signature("POST", body, ESTIMATE_PATH, env.HONEYCOMB_API_SECRET_KEY) }, body,
    });
    // No automatic retry: an ambiguous response may already have created an estimate.
    if (!response.ok) return { status: "ERROR", issue: `HTTP_${response.status}` };
    return parseResult(await response.json());
  } catch (e) {
    return { status: "ERROR", issue: e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name) ? "TIMEOUT" : "REQUEST_FAILED" };
  }
}

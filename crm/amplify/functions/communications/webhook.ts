import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { config, credentials } from "./config";
import { row, save, hash, get } from "./store";

const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function verifyFront(raw: string, headers: Record<string, string | undefined>, secret: string, now = Date.now()) {
  const timestamp = headers["x-front-request-timestamp"] ?? "";
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000) throw new Error("Expired signature");
  const signature = createHmac("sha256", secret).update(`${timestamp}:${raw}`).digest("base64");
  if (!equal(signature, headers["x-front-signature"] ?? "")) throw new Error("Invalid signature");
  return JSON.parse(raw) as Record<string, unknown>;
}
export function verifyDialpad(raw: string, secret: string) {
  const token = raw.startsWith('"') ? JSON.parse(raw) as string : raw.trim();
  const pieces = token.split(".");
  if (pieces.length !== 3) throw new Error("Signed Dialpad payload required");
  const header = JSON.parse(Buffer.from(pieces[0], "base64url").toString());
  if (header.alg !== "HS256") throw new Error("Unsupported webhook signature");
  const signature = createHmac("sha256", secret).update(`${pieces[0]}.${pieces[1]}`).digest("base64url");
  if (!equal(signature, pieces[2])) throw new Error("Invalid signature");
  const payload = JSON.parse(Buffer.from(pieces[1], "base64url").toString());
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error("Expired signature");
  return payload as Record<string, unknown>;
}
export const handler = async (event: APIGatewayProxyEventV2) => {
  const response = (statusCode: number, body: string) => ({ statusCode, body, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  if (event.requestContext.http.method !== "POST") return response(405, "POST required");
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "";
  if (Buffer.byteLength(raw) > 180_000) return response(413, "Payload too large");
  let payload: Record<string, unknown>, provider: "front" | "dialpad";
  try {
    const [c, keys] = await Promise.all([config(), credentials()]);
    if (event.rawPath.endsWith("/front")) {
      provider = "front";
      if (!keys.frontSigningKey || !c.frontCompanyId) return response(503, "Webhook is not configured");
      payload = verifyFront(raw, event.headers, keys.frontSigningKey);
      if ((payload.authorization as { id?: string })?.id !== c.frontCompanyId) return response(403, "Company mismatch");
      if (payload.type === "sync" && event.headers["x-front-challenge"]) return response(200, event.headers["x-front-challenge"]!);
    } else if (event.rawPath.endsWith("/dialpad")) {
      provider = "dialpad";
      if (!keys.dialpadSigningKey || !c.dialpadCompanyId) return response(503, "Webhook is not configured");
      payload = verifyDialpad(raw, keys.dialpadSigningKey);
      // A dedicated secret binds events to the configured company. Check an
      // explicit company ID when present; target/line allowlists are checked by the worker.
      if (payload.company_id && String(payload.company_id) !== c.dialpadCompanyId) return response(403, "Company mismatch");
    } else return response(404, "Unknown webhook");
  } catch { return response(401, "Invalid webhook"); }
  const id = `event:${provider}:${hash(JSON.stringify(payload))}`;
  try { await save(row("EVENT", id, { provider, payload, attempts: 0 }, { dueAt: new Date().toISOString() })); }
  catch {
    // Only a verified stored receipt permits acknowledgement, even if an SDK
    // omits cancellation reasons or the original write response was lost.
    try { if (!await get(id)) return response(503, "Please retry"); }
    catch { return response(503, "Please retry"); }
  }
  try { const key = `health:webhook:${provider}`, old = await get(key); await save(row("HEALTH", key, { at: new Date().toISOString() }, { previous: old }), old); } catch { /* The durable event is already accepted. Health repairs on the next receipt. */ }
  return response(202, "Accepted");
};

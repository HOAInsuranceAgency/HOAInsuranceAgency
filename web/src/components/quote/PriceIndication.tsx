import { useEffect, useState } from "react";
export type PublicEstimate = { status: string; price?: number; currency?: string; staging?: boolean };
export async function readEstimate(token: string, signal: AbortSignal): Promise<PublicEstimate> {
  const url = import.meta.env.PUBLIC_CRM_API_URL, key = import.meta.env.PUBLIC_CRM_API_KEY;
  if (!url || !key) return { status: "unavailable" };
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key }, signal,
    body: JSON.stringify({ query: "query WebLeadEstimate($estimateToken: String!) { webLeadEstimate(estimateToken: $estimateToken) }", variables: { estimateToken: token } }),
  });
  if (!response.ok) return { status: "unavailable" };
  const body = await response.json();
  if (body.errors?.length) return { status: "unavailable" };
  const value = body.data?.webLeadEstimate;
  return (typeof value === "string" ? JSON.parse(value) : value) ?? { status: "unavailable" };
}
/** Nothing carrier-specific appears unless an eligible, numeric indication arrives. */
export default function PriceIndication({ token, read = readEstimate }: { token?: string; read?: typeof readEstimate }) {
  const [result, setResult] = useState<PublicEstimate | null>(null);
  useEffect(() => {
    setResult(null);
    if (!token) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => controller.abort(), 90_000);
    async function poll() {
      try {
        const value = await read(token!, controller.signal);
        if (controller.signal.aborted) return;
        if (value.status === "pending") timer = setTimeout(poll, 3000);
        else { setResult(value); clearTimeout(deadline); }
      } catch { /* Lead is saved. Keep the ordinary follow-up confirmation. */ }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
  }, [token, read]);
  if (result?.status !== "ready" || result.currency !== "USD" || typeof result.price !== "number" || !Number.isFinite(result.price) || result.price <= 0) return null;
  return <section className="qf-price-indication" aria-label="Price indication" aria-live="polite" style={{ border: "1px solid currentColor", borderRadius: 16, padding: 20, margin: "20px 0" }}>
    <p className="qf-sub-small">{result.staging ? "Staging test · " : ""}Preliminary price indication</p>
    <p style={{ fontSize: 32, fontWeight: 600, margin: "8px 0" }}>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(result.price)}</p>
    <p className="qf-sub-small">Based on the property details provided. This is an estimate, subject to underwriting and confirmation of coverage, limits and deductibles. Your agent will review it with you.</p>
  </section>;
}

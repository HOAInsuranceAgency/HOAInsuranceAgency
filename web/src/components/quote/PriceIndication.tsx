import { formatUsdDollars } from '../../../../shared/money';
import { publicApi } from "../../lib/publicApi";
import { useEffect, useState } from "react";
export type PublicEstimate = { status: string; price?: number; currency?: string; staging?: boolean };
export async function readEstimate(token: string, signal: AbortSignal): Promise<PublicEstimate> {
  const url = import.meta.env.PUBLIC_CRM_API_URL, key = import.meta.env.PUBLIC_CRM_API_KEY;
  if (!url || !key) return { status: "unavailable" };
  const value = await publicApi("query WebLeadEstimate($estimateToken: String!) { webLeadEstimate(estimateToken: $estimateToken) }", { estimateToken: token }, 'webLeadEstimate', {
    url, key, configurationError: 'Estimates are unavailable.', requireOk: false, request: { signal },
  }).catch(() => null);
  if (!value || typeof value.status !== 'string') return { status: 'unavailable' };
  return { status: value.status, ...(typeof value.price === 'number' && Number.isFinite(value.price) ? { price: value.price } : {}),
    ...(typeof value.currency === 'string' ? { currency: value.currency } : {}), ...(value.staging === true ? { staging: true } : {}) };
}
/** Nothing carrier-specific appears unless an eligible, numeric indication arrives. */
export default function PriceIndication({ token, read = readEstimate }: { token?: string; read?: typeof readEstimate }) {
  const [response, setResponse] = useState<{ token: string; value: PublicEstimate }>();
  // A new receipt starts loading immediately, without briefly showing the old price.
  const result = token && response?.token === token ? response.value : { status: "pending" };
  useEffect(() => {
    if (!token) return;
    setResponse({ token, value: { status: "pending" } });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => {
      controller.abort();
      clearTimeout(timer);
      setResponse({ token, value: { status: "unavailable" } });
    }, 90_000);
    async function poll() {
      try {
        const value = await read(token!, controller.signal);
        if (controller.signal.aborted) return;
        if (value.status === "pending") timer = setTimeout(poll, 3000);
        else { setResponse({ token: token!, value }); clearTimeout(deadline); }
      } catch {
        if (controller.signal.aborted) return;
        clearTimeout(deadline);
        // Lead is saved. Return to the ordinary follow-up confirmation.
        setResponse({ token: token!, value: { status: "unavailable" } });
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
  }, [token, read]);
  if (!token) return null;
  if (result.status === "pending") return <section className="qf-price-indication qf-price-indication--pending" role="status" aria-live="polite" aria-atomic="true">
    <span className="qf-estimate-spinner" aria-hidden="true" />
    <div>
      <h3>Checking for an initial estimate…</h3>
      <p>This usually takes about a minute. Your request is saved, and you can add documents while we check.</p>
    </div>
  </section>;
  if (result?.status !== "ready" || result.currency !== "USD" || typeof result.price !== "number" || !Number.isFinite(result.price) || result.price <= 0) return null;
  return <section className="qf-price-indication" aria-label="Price indication" role="status" aria-live="polite" aria-atomic="true">
    {result.staging && <span className="qf-estimate-badge">Staging test</span>}
    <h3>Preliminary price indication</h3>
    <p className="qf-estimate-price">{formatUsdDollars(result.price, 'whole')}</p>
    <p className="qf-estimate-disclaimer">
      This is a preliminary, non-binding estimate. Final premiums may be significantly higher
      or lower based on underwriting, verified property details, coverage selections and other
      factors. This estimate does not guarantee eligibility or coverage and does not bind Insurance.
    </p>
  </section>;
}

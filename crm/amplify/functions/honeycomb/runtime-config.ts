import { HONEYCOMB_ENDPOINTS, isHoneycombEnvironment } from "./environment";

// Identify the integration explicitly; the production edge rejects generic HTTP clients.
export const HONEYCOMB_USER_AGENT = "HOAInsuranceAgency-Honeycomb/1.0";

/** Reject cross-environment endpoints before a signed request can leave the worker. */
export function configuredHoneycomb(env = process.env): env is NodeJS.ProcessEnv & Record<
  "HONEYCOMB_API_BASE_URL" | "HONEYCOMB_API_USER" | "HONEYCOMB_API_SECRET_KEY" | "HONEYCOMB_PRODUCER_ID", string
> {
  const environment = env.HONEYCOMB_ENVIRONMENT;
  return env.HONEYCOMB_ENABLED === "true"
    && isHoneycombEnvironment(environment)
    && env.HONEYCOMB_API_BASE_URL === HONEYCOMB_ENDPOINTS[environment].api
    && !!env.HONEYCOMB_API_USER
    && !!env.HONEYCOMB_API_SECRET_KEY
    && !!env.HONEYCOMB_PRODUCER_ID;
}

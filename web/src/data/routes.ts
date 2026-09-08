/** Sitemap exclusions. Each matching page must also emit its own `noindex`. */
export const NOINDEX_ROUTE_PREFIXES = [
  /** Tokenised document portal. The URL carries a live upload secret. */
  "/documents/",
  /** Tokenised premium-finance election. Same reason. */
  "/finance/",
  /** Private per-association lead pages, distributed by property managers. */
  "/associations/",
  /** Paid-traffic landing pages that duplicate reviewed organic routes. */
  "/get-started/",
  /** Client-only quote wizard with no indexable server-rendered body. */
  "/quote/",
] as const;

/** True when a path (or full URL) falls under a route that must not be indexed. */
export function isNoindexRoute(pathOrUrl: string): boolean {
  return NOINDEX_ROUTE_PREFIXES.some((prefix) => pathOrUrl.includes(prefix));
}

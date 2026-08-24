/**
 * Document → policy/quote links, as pure helpers.
 *
 * A document BELONGS to its account (entityType/entityId stay the storage
 * and query root); a link is one extra fact — "this paper is about that
 * policy/quote" — carried as nullable ids the same way invoices and loans
 * anchor. One string key ("policy:<id>" / "quote:<id>" / "") moves through
 * the select, the URL, and the update payload, so the three can never
 * disagree about what a link is.
 */

export interface DocLink {
  policyId?: string | null;
  quoteId?: string | null;
}

/** The select/URL key for a document's current link. Policy wins after a
 * bind rollover leaves both ids set — the policy speaks for the anchor. */
export function linkKeyOf(d: DocLink): string {
  if (d.policyId) return `policy:${d.policyId}`;
  if (d.quoteId) return `quote:${d.quoteId}`;
  return "";
}

/**
 * The update payload for a chosen key. Both sides are explicit — null, not
 * undefined — so re-linking CLEARS the side it leaves: a document moved
 * from a quote to a policy must not keep pointing at both.
 */
export function linkFields(key: string): { policyId: string | null; quoteId: string | null } {
  const [kind, id] = key.split(":", 2);
  return {
    policyId: kind === "policy" && id ? id : null,
    quoteId: kind === "quote" && id ? id : null,
  };
}

/** "" matches everything; a link key matches its own documents only. */
export function matchesLink(d: DocLink, key: string): boolean {
  if (!key) return true;
  return linkKeyOf(d) === key;
}

/** The same identity rule the invoice anchor picker uses. */
export function policyLinkLabel(p: {
  policyNumber?: string | null;
  lines?: (string | null)[] | null;
  effectiveDate?: string | null;
}): string {
  const name =
    p.policyNumber?.trim() ||
    (p.lines ?? []).filter(Boolean).join(", ") ||
    "Policy";
  return p.effectiveDate ? `${name} (${p.effectiveDate})` : name;
}

/** Quotes have no number, so the lines of business are the identity. */
export function quoteLinkLabel(q: {
  lines?: (string | null)[] | null;
  effectiveDate?: string | null;
}): string {
  const name = `Quote — ${(q.lines ?? []).filter(Boolean).join(", ") || "coverage"}`;
  return q.effectiveDate ? `${name} (${q.effectiveDate})` : name;
}

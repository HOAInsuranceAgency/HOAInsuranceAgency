/**
 * The universal search bar's core: turning the a-tier tables into one flat
 * list of searchable rows, and ranking them against a query. Pure and
 * dependency-free like `dashboardStats.ts` — the fetch lives in
 * `searchIndexData.ts`, so everything here is assertable without a client.
 *
 * What is searchable is a decision, not an accident:
 *  - Accounts by name, legal name, city, state — the fields a human reaches
 *    for. NOT fein (tax-ID PII does not belong in a client-held index) and
 *    NOT buildiumId (documented write-only).
 *  - Contacts by name and email, landing on their account.
 *  - Policies, invoices and certificates by their numbers — rows without
 *    one are unfindable by text and stay out rather than matching nothing.
 *  - Carriers by name and NAIC code.
 *  - Quotes not at all: the schema gives them no human-searchable handle,
 *    and matching them on joined account names would only duplicate the
 *    account hits above them.
 * No token, secret, or payment link is ever an index field.
 */

export type SearchHitType =
  | "account"
  | "contact"
  | "policy"
  | "invoice"
  | "certificate"
  | "carrier";

/** Display order of the dropdown's groups — people before paper. */
export const HIT_TYPE_ORDER: readonly SearchHitType[] = [
  "account",
  "contact",
  "policy",
  "invoice",
  "certificate",
  "carrier",
];

export const HIT_TYPE_LABEL: Record<SearchHitType, string> = {
  account: "Accounts",
  contact: "Contacts",
  policy: "Policies",
  invoice: "Invoices",
  certificate: "Certificates",
  carrier: "Carriers",
};

export interface SearchRow {
  type: SearchHitType;
  id: string;
  /** The bold line of the hit. */
  label: string;
  /** The muted line under it — enough context to pick between hits. */
  sub: string;
  /** Where clicking the hit goes. */
  target: string;
  /** Lowercased strings the query is matched against. */
  haystack: string[];
}

export interface SearchIndexInput {
  accounts: readonly {
    id: string;
    name: string;
    legalName?: string | null;
    city?: string | null;
    state?: string | null;
    stage?: string | null;
  }[];
  contacts: readonly {
    id: string;
    accountId: string;
    name: string;
    email?: string | null;
  }[];
  policies: readonly {
    id: string;
    accountId: string;
    policyNumber?: string | null;
    carrierId?: string | null;
    status?: string | null;
  }[];
  invoices: readonly {
    id: string;
    accountId: string;
    number?: string | null;
    status?: string | null;
  }[];
  certificates: readonly {
    id: string;
    accountId: string;
    certificateNumber?: string | null;
    holderName: string;
  }[];
  carriers: readonly {
    id: string;
    name: string;
    naicCode?: string | null;
  }[];
}

const lower = (s: string | null | undefined) => s?.trim().toLowerCase() ?? "";

/** Sentence-case a stage/status enum token for display. */
const sentence = (s: string | null | undefined) =>
  s ? s.charAt(0) + s.slice(1).toLowerCase() : "";

export function buildSearchRows(input: SearchIndexInput): SearchRow[] {
  const accountName = new Map(input.accounts.map((a) => [a.id, a.name]));
  const carrierName = new Map(input.carriers.map((c) => [c.id, c.name]));
  const acct = (id: string) => accountName.get(id) ?? "Unknown account";
  const rows: SearchRow[] = [];

  for (const a of input.accounts) {
    rows.push({
      type: "account",
      id: a.id,
      label: a.name,
      sub: [sentence(a.stage), [a.city, a.state].filter(Boolean).join(", ")]
        .filter(Boolean)
        .join(" · "),
      target: `/accounts/${a.id}`,
      haystack: [a.name, a.legalName, a.city, a.state].map(lower).filter(Boolean),
    });
  }
  for (const c of input.contacts) {
    rows.push({
      type: "contact",
      id: c.id,
      label: c.name,
      sub: [c.email, acct(c.accountId)].filter(Boolean).join(" · "),
      target: `/accounts/${c.accountId}`,
      haystack: [c.name, c.email].map(lower).filter(Boolean),
    });
  }
  for (const p of input.policies) {
    if (!p.policyNumber) continue;
    rows.push({
      type: "policy",
      id: p.id,
      label: p.policyNumber,
      sub: [
        acct(p.accountId),
        p.carrierId ? carrierName.get(p.carrierId) : null,
        sentence(p.status),
      ]
        .filter(Boolean)
        .join(" · "),
      target: `/accounts/${p.accountId}?tab=policies`,
      haystack: [lower(p.policyNumber)],
    });
  }
  for (const i of input.invoices) {
    if (!i.number) continue;
    rows.push({
      type: "invoice",
      id: i.id,
      label: i.number,
      sub: [acct(i.accountId), sentence(i.status)].filter(Boolean).join(" · "),
      target: `/accounts/${i.accountId}?tab=invoices`,
      haystack: [lower(i.number)],
    });
  }
  for (const c of input.certificates) {
    rows.push({
      type: "certificate",
      id: c.id,
      label: c.certificateNumber ?? c.holderName,
      sub: [
        c.certificateNumber ? c.holderName : null,
        acct(c.accountId),
      ]
        .filter(Boolean)
        .join(" · "),
      target: `/accounts/${c.accountId}?tab=certificates`,
      haystack: [c.certificateNumber, c.holderName].map(lower).filter(Boolean),
    });
  }
  for (const c of input.carriers) {
    rows.push({
      type: "carrier",
      id: c.id,
      label: c.name,
      sub: c.naicCode ? `NAIC ${c.naicCode}` : "Carrier",
      target: `/carriers/${c.id}`,
      haystack: [c.name, c.naicCode].map(lower).filter(Boolean),
    });
  }
  return rows;
}

/** Queries shorter than this match too much to mean anything — the same
 * floor the document search has always enforced. */
export const MIN_QUERY_LENGTH = 2;

export interface SearchGroup {
  type: SearchHitType;
  hits: SearchRow[];
  /** Matches beyond the per-group cap — shown, not silently dropped. */
  more: number;
}

/**
 * Rank rows against a query: a field starting with the query beats a word
 * inside a field starting with it, which beats a bare substring — so "har"
 * puts "Harbor Pointe" above "New Harbor" above "Lechmere". Ties break
 * alphabetically to keep the list stable while typing. Results come back
 * grouped in HIT_TYPE_ORDER with a per-group cap, and each group says how
 * many matches the cap hid.
 */
export function searchRows(
  rows: readonly SearchRow[],
  query: string,
  perType = 5
): SearchGroup[] {
  const q = lower(query);
  if (q.length < MIN_QUERY_LENGTH) return [];

  const scored = new Map<SearchHitType, { row: SearchRow; score: number }[]>();
  for (const row of rows) {
    let score = 0;
    for (const h of row.haystack) {
      if (h.startsWith(q)) score = Math.max(score, 3);
      else if (h.includes(` ${q}`)) score = Math.max(score, 2);
      else if (h.includes(q)) score = Math.max(score, 1);
    }
    if (score === 0) continue;
    const list = scored.get(row.type);
    if (list) list.push({ row, score });
    else scored.set(row.type, [{ row, score }]);
  }

  const groups: SearchGroup[] = [];
  for (const type of HIT_TYPE_ORDER) {
    const list = scored.get(type);
    if (!list) continue;
    list.sort(
      (a, b) => b.score - a.score || a.row.label.localeCompare(b.row.label)
    );
    groups.push({
      type,
      hits: list.slice(0, perType).map((s) => s.row),
      more: Math.max(0, list.length - perType),
    });
  }
  return groups;
}

/**
 * The ±60-character context window around the first match in a document's
 * OCR text — moved verbatim from the old DocumentSearch page so the /search
 * results keep reading the same. Null when the text has no match (the file
 * name matched instead) or there is no text at all.
 */
export function ocrSnippet(
  text: string | null | undefined,
  query: string
): string | null {
  const q = query.trim().toLowerCase();
  if (!text || !q) return null;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + q.length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

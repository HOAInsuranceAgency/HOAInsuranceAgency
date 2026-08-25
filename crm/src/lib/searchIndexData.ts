import { client, listAllPages } from "./client";
import { buildSearchRows, type SearchRow } from "./universalSearch";

/**
 * The universal search bar's index read: six full-table scans, each with a
 * selectionSet cut to exactly the fields `buildSearchRows` indexes.
 *
 * The selectionSets are the first in this codebase, and they are here for
 * two reasons the generated full-row reads can't answer:
 *  - weight — Account carries the `aiExtraction` evidence blob and ~50
 *    columns, and this read runs for every user's session, not one page;
 *  - containment — the index is a long-lived client-side structure, and the
 *    narrow read makes "no token, payment link, or tax id ever transits
 *    here" a property of the query, not a promise of the mapping code.
 *
 * One read per session (the bar fetches lazily on first focus); at agency
 * scale these six tables are the same scans the dashboard already runs per
 * tab, minus most of the bytes.
 */
export async function fetchSearchIndexRows(): Promise<SearchRow[]> {
  const [accounts, contacts, policies, invoices, certificates, carriers] =
    await Promise.all([
      listAllPages((nextToken) =>
        client.models.Account.list({
          selectionSet: ["id", "name", "legalName", "city", "state", "stage"],
          nextToken,
        })
      ),
      listAllPages((nextToken) =>
        client.models.Contact.list({
          selectionSet: ["id", "accountId", "name", "email"],
          nextToken,
        })
      ),
      listAllPages((nextToken) =>
        client.models.Policy.list({
          selectionSet: ["id", "accountId", "policyNumber", "carrierId", "status"],
          nextToken,
        })
      ),
      listAllPages((nextToken) =>
        client.models.Invoice.list({
          selectionSet: ["id", "accountId", "number", "status"],
          nextToken,
        })
      ),
      listAllPages((nextToken) =>
        client.models.Certificate.list({
          selectionSet: ["id", "accountId", "certificateNumber", "holderName"],
          nextToken,
        })
      ),
      listAllPages((nextToken) =>
        client.models.Carrier.list({
          selectionSet: ["id", "name", "naicCode"],
          nextToken,
        })
      ),
    ]);
  return buildSearchRows({
    accounts,
    contacts,
    policies,
    invoices,
    certificates,
    carriers,
  });
}

/** A document hit as the typeahead needs it — deliberately WITHOUT ocrText:
 * the dropdown shows no snippet, and pulling full Textract text per
 * keystroke is the exact weight the old page's press-Search design avoided.
 * The /search page fetches full rows for its snippets instead. */
export interface DocumentHit {
  id: string;
  name: string;
  entityType: string;
  entityId: string;
}

/** How much of the Document table one typeahead query may walk. Smaller
 * than the /search page's 25 — a dropdown that answers late answers wrong. */
const TYPEAHEAD_DOC_PAGES = 5;

export async function fetchDocumentHits(query: string): Promise<DocumentHit[]> {
  const rows = await listAllPages(
    (nextToken) =>
      client.models.Document.list({
        filter: {
          or: [{ name: { contains: query } }, { ocrText: { contains: query } }],
        },
        selectionSet: ["id", "name", "entityType", "entityId"],
        nextToken,
      }),
    { maxPages: TYPEAHEAD_DOC_PAGES }
  );
  return rows as DocumentHit[];
}

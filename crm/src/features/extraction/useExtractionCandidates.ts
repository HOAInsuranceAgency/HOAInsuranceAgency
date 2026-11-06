import { useMemo } from "react";
import { isAuthorizationError } from "../../../../shared/authorizationError";
import {
  buildingAliases,
  contactAliases,
  lossAliases
} from "../../../../shared/extractionKeys";
import { listAllPages } from "../../../../shared/pagination";
import { client, type Building, type Contact, type Loss } from "../../lib/client";
import {
  classifyCandidate
} from "../../lib/extractionMatch";
import { useAsyncResource } from "../../lib/useAsyncResource";
import type { ExtractionResult } from './extractionModel';
import { buildingWrite, contactWrite, lossWrite, namedContact, usableBuilding, usableLoss } from './extractionModel';
export function useExtractionCandidates(accountId: string, result: ExtractionResult | null) {

  // The account's existing contacts, so a candidate can be classified before
  // it is written. Without this the apply path can only ever create, which is
  // how re-running an extraction duplicates everything it already applied.
  //
  // A separate resource rather than part of the poll: the poll is an interval
  // that deliberately drops most of its successful responses, and this is a
  // plain fetch-per-account. Applying candidates waits for these reads: a
  // failed match lookup must never classify every existing row as a new row.
  const contactsRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Contact.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as Contact[], clearDataOnError: isAuthorizationError, live: true }
  );

  // Same shape and the same reason as the contacts read: a candidate has to
  // be classified against what exists before it is written, or re-applying an
  // extraction files every loss a second time.
  const lossesRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Loss.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as Loss[], clearDataOnError: isAuthorizationError, live: true }
  );

  // Buildings were the original bug: they were created unconditionally on
  // every apply, so a re-run duplicated the whole property schedule.
  const buildingsRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Building.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as Building[], clearDataOnError: isAuthorizationError, live: true }
  );

  /**
   * Every candidate the panel will show, already classified.
   *
   * Computed once here rather than per row, because the review table and the
   * apply path must not disagree about what a candidate is: the checkbox a
   * reviewer ticked and the write it authorises come from the same object.
   */
  const contactCandidates = useMemo(
    () =>
      (result?.contacts ?? [])
        .map((c, i) => ({ i, row: c, ...contactWrite(c) }))
        .filter((x) => namedContact(x.row))
        .map((x) => ({
          ...x,
          match: classifyCandidate(
            x.key,
            x.supplied,
            contactsRes.data,
            contactAliases
          ),
        })),
    [result, contactsRes.data]
  );

  const lossCandidates = useMemo(
    () =>
      (result?.losses ?? [])
        .map((l, i) => ({ i, row: l, ...lossWrite(l) }))
        .filter((x) => usableLoss(x.row))
        .map((x) => ({
          ...x,
          match: classifyCandidate(x.key, x.supplied, lossesRes.data, lossAliases),
        })),
    [result, lossesRes.data]
  );

  const buildingCandidates = useMemo(
    () =>
      (result?.buildings ?? [])
        .map((b, i) => ({ i, row: b, ...buildingWrite(b, i) }))
        .filter((x) => usableBuilding(x.row))
        .map((x) => ({
          ...x,
          match: classifyCandidate(
            x.key,
            x.supplied,
            buildingsRes.data,
            buildingAliases
          ),
        })),
    [result, buildingsRes.data]
  );
  return { contactsRes, lossesRes, buildingsRes, contactCandidates, lossCandidates, buildingCandidates };
}
export type ExtractionCandidates = ReturnType<typeof useExtractionCandidates>;

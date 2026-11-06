import { relationshipCurrent } from "../../../../shared/relationships";
import { assertGraphqlErrors } from '../../lib/apiResponse';
import { client, type Account, type Building, type Contact, type Loss } from "../../lib/client";
import type { ExtractionResult } from './extractionModel';
import { ExtractedField, coerce, fieldDefsFor, isEmpty } from './extractionModel';
import type { ExtractionCandidates } from './useExtractionCandidates';
interface ReviewedExtraction {
  account: Account;
  result: ExtractionResult;
  alreadyApplied: boolean;
  force: boolean;
  selected: Record<string, boolean>;
  selectedContacts: Record<number, boolean>;
  selectedLosses: Record<number, boolean>;
  selectedBuildings: Record<number, boolean>;
  contactCandidates: ExtractionCandidates['contactCandidates'];
  lossCandidates: ExtractionCandidates['lossCandidates'];
  buildingCandidates: ExtractionCandidates['buildingCandidates'];
  existingContacts: Contact[];
  refreshContacts: () => Promise<unknown>;
  refreshLosses: () => Promise<unknown>;
  refreshBuildings: () => Promise<unknown>;
  onApplied: (account: Account) => void;
}
/** The account marker and matching child writes form one reviewed apply operation. */
export async function applyExtractionReview({
  account,
  result,
  alreadyApplied,
  force,
  selected,
  selectedContacts,
  selectedLosses,
  selectedBuildings,
  contactCandidates,
  lossCandidates,
  buildingCandidates,
  existingContacts,
  refreshContacts,
  refreshLosses,
  refreshBuildings,
  onApplied,
}: ReviewedExtraction) {

  // The idempotency rule. Match-then-write already makes a second apply
  // harmless row by row, but "harmless" is not the same as "did
  // nothing": it still writes the account patch, still bumps every
  // matched row's updatedAt, and still fills the activity log with
  // edits nobody made.
  //
  // The button stays enabled and this returns a message, rather than
  // the button being disabled: a disabled control says "no" without
  // saying why, and the spec asks for an explicit no-op, not a dead
  // button. This is also the only place the rule is enforced — there is
  // no second copy of it in the JSX to disagree with.
  if (alreadyApplied && !force) {
    return "This extraction has already been applied, so nothing was written. Re-run the extraction to pick up new documents, or use “Apply again anyway” to write it a second time.";
  }

  const patch: Record<string, unknown> = {};
  const noteLines: string[] = [];
  for (const def of fieldDefsFor(account)) {
    if (!selected[def.key]) continue;
    const f = result[def.key] as ExtractedField | undefined;
    if (!f || isEmpty(f.value)) continue;
    const coerced = coerce(def, f.value);
    if (coerced === undefined) continue;
    if (def.kind === "patch") {
      patch[def.key] = coerced;
    } else {
      const shown = def.display ? def.display(f.value) : String(coerced);
      noteLines.push(`${def.label.replace(" → notes", "")}: ${shown}`);
    }
  }
  if (noteLines.length) {
    patch.notes = [account.notes, `[From documents] ${noteLines.join(" · ")}`]
      .filter(Boolean)
      .join("\n");
  }

  const { data, errors } = await client.models.Account.update({
    id: account.id,
    ...patch,
    // Marks *this* result as applied. Written with the patch rather
    // than after the child rows, so a run that fails partway through
    // still records that it happened — a second attempt then reports
    // "already applied" instead of silently re-writing the half that
    // did land.
    ...(result.extractedAt ? { aiExtractionAppliedAt: result.extractedAt } : {}),
  });
  assertGraphqlErrors({ errors });
  if (!data) throw new Error(errors?.[0]?.message);

  // Contacts, losses and buildings all follow the same rule now: match
  // on the natural key, then create, update, or do nothing. Buildings
  // were the original bug — they were created unconditionally, so a
  // re-run duplicated the whole property schedule.
  //
  // An update is a *merge*: only fields the documents actually
  // supported are sent. A candidate found in a budget that names the
  // manager but not their phone number must not blank the phone number
  // somebody typed in by hand.
  let contactFailures = 0;
  let unchanged = 0;
  let primaryTaken = existingContacts.some((c) => c.isPrimary && relationshipCurrent(c));
  for (const c of contactCandidates) {
    if (!selectedContacts[c.i]) continue;
    if (c.match.existing && !relationshipCurrent(c.match.existing)) { unchanged++; continue; }
    if (c.match.verdict === "identical") {
      unchanged++;
      continue;
    }
    if (!c.supplied.name) continue;
    const written = c.match.existing
      ? await client.models.Contact.update({
        id: c.match.existing.id,
        ...c.supplied,
      })
      : await client.models.Contact.create({
        accountId: account.id,
        ...(c.supplied as Partial<Contact>),
        name: c.supplied.name as string,
        // An account with nobody flagged has no answer for the ACORD
        // insured block, so the first contact to exist takes it.
        isPrimary: !primaryTaken,
        extractionSourceKey: c.key,
      });
    if (written.errors?.length || !written.data) contactFailures++;
    else if (!c.match.existing) primaryTaken = true;
  }
  // So a second apply in the same session classifies against what the
  // first one wrote, rather than re-creating it.
  if (contactCandidates.length) await refreshContacts();

  let lossFailures = 0;
  for (const l of lossCandidates) {
    if (!selectedLosses[l.i]) continue;
    if (l.match.verdict === "identical") {
      unchanged++;
      continue;
    }
    const written = l.match.existing
      ? await client.models.Loss.update({
        id: l.match.existing.id,
        ...l.supplied,
      })
      : await client.models.Loss.create({
        accountId: account.id,
        ...(l.supplied as Partial<Loss>),
        dateOfLoss: l.supplied.dateOfLoss as string,
        lineOfBusiness: l.supplied.lineOfBusiness as string,
        extractionSourceKey: l.key,
      });
    if (written.errors?.length || !written.data) lossFailures++;
  }
  if (lossCandidates.length) await refreshLosses();

  // These `errors` used to be dropped entirely, so a building that
  // failed to create reported the same green "Applied" as one that did.
  // The account fields did land, so this is a partial success, not a
  // failure: it comes back as `run`'s warning, not a throw.
  let buildingFailures = 0;
  for (const b of buildingCandidates) {
    if (!selectedBuildings[b.i]) continue;
    if (b.match.verdict === "identical") {
      unchanged++;
      continue;
    }
    const written = b.match.existing
      ? await client.models.Building.update({
        id: b.match.existing.id,
        ...b.supplied,
      })
      : await client.models.Building.create({
        accountId: account.id,
        ...(b.supplied as Partial<Building>),
        extractionSourceKey: b.key,
      });
    if (written.errors?.length || !written.data) buildingFailures++;
  }
  if (buildingCandidates.length) await refreshBuildings();

  onApplied(data);
  // The account fields did land, so a child row that failed is a partial
  // success, not a failure: it comes back as `run`'s warning arm rather
  // than a throw, and it names where to finish the job by hand.
  const unfinished = [
    buildingFailures &&
    `${buildingFailures} building${buildingFailures === 1 ? "" : "s"} on the Property & coverage tab`,
    contactFailures &&
    `${contactFailures} contact${contactFailures === 1 ? "" : "s"} on the Contacts card`,
    lossFailures &&
    `${lossFailures} loss${lossFailures === 1 ? "" : "es"} on the Losses tab`,
  ].filter(Boolean);
  if (unfinished.length) {
    return `Fields applied. Couldn't save ${unfinished.join(
      " and "
    )}; add ${buildingFailures + contactFailures + lossFailures === 1 ? "it" : "them"
      } by hand.`;
  }
  // Not a warning — nothing needs acting on — but worth saying out
  // loud. A reviewer who ticked eight rows and got a bare "Applied"
  // has no way to tell that six of them were already on the record.
  return unchanged
    ? `Applied. ${unchanged} selected row${unchanged === 1 ? " was" : "s were"
    } already on the record and left alone.`
    : "";

}

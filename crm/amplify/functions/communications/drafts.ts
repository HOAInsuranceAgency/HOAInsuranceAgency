import type { Communication } from "../../../../shared/leadWorkflow";
import { accountRows, recordInbound } from "./workflow";
import { contactFence } from "./contactProgress";
import { get, row, save, check, put, commit, type Row } from "./store";

/** Repair older projections that lost Front's is_draft flag. Each step is replayable. */
export async function repairMisclassifiedDraft(candidate: Row<Communication>) {
  let draft = await get<Communication>(candidate.id);
  if (!draft || draft.data.frontDraft === false) return; // A sent message cannot become a draft on stale replay.
  const accountId = draft.accountId;
  if (draft.data.status !== "DRAFT") {
    const fence = accountId ? await contactFence(accountId) : undefined;
    const next = row("COMMUNICATION", draft.id, { ...draft.data, status: "DRAFT", frontDraft: true, contactApplied: false, contactAppliedKind: undefined, workflowApplied: false, seenAt: undefined }, { accountId, previous: draft });
    await commit([put(next, draft), ...(fence ? [put(row("CONTACT_FENCE", fence.id, {}, { previous: fence }), fence)] : [])]);
    draft = next;
  }
  if (!accountId) return;
  for (const candidate of await accountRows<Communication>(accountId, "COMMUNICATION")) {
    let source = await get<Communication>(candidate.id);
    if (source?.data.resolvedByCommunicationId !== draft.id) continue;
    // Keep the evidence pointer until recordInbound completes, so interruption resumes here.
    if (source.data.resolved) {
      const next = row("COMMUNICATION", source.id, { ...source.data, resolved: false, workflowApplied: false }, { accountId, previous: source });
      await commit([check(draft), put(next, source)]); source = next;
    }
    await recordInbound(source.data, source.data.purpose === "CARRIER" ? "CARRIER" : source.data.channel === "CALL" ? "CALLBACK" : "RESPONSE");
    const current = await get<Communication>(source.id);
    if (current?.data.resolvedByCommunicationId === draft.id) await save(row("COMMUNICATION", current.id, { ...current.data, resolvedByCommunicationId: undefined }, { accountId, previous: current, dueAt: current.dueAt }), current);
  }
}

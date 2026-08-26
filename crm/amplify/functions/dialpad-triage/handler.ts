import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import { decideTriage, type TriageRequest } from "./decide";

/**
 * The triage queue's four buttons. See ./resource.ts for why a Lambda and
 * ./decide.ts for the rules worth testing.
 */

type DataClient = ReturnType<typeof generateClient<Schema>>;

let dataClient: DataClient | undefined;
async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

/** How this function's writes are attributed in the activity log. */
const ACTOR = "dialpad-triage";

interface Event {
  arguments: TriageRequest;
  identity?: { sub?: string; username?: string } | null;
}

export const handler = async (event: Event) => {
  const decision = decideTriage(event.arguments);
  if (!decision.ok) return { ok: false, error: decision.error };

  const { plan } = decision;
  const client = await getDataClient();
  const who = event.identity?.sub ?? ACTOR;
  const now = new Date().toISOString();

  const { data: call } = await client.models.Communication.get({
    id: event.arguments.communicationId as string,
  });
  if (!call) return { ok: false, error: "That call no longer exists." };

  // Filing something already filed would write a second set of appearances
  // beside the first, and the timeline would show the call twice. The queue
  // only ever offers UNMATCHED rows, so reaching here means two people had
  // the queue open at once.
  if (call.matchConfidence !== "UNMATCHED") {
    return { ok: false, error: "Somebody already filed this call." };
  }

  const fileOn = [...plan.fileOn];
  let createdAccountId: string | null = null;

  if (plan.createLead) {
    const { data: account, errors } = await client.models.Account.create({
      stage: "LEAD",
      type: "ASSOCIATION",
      name: plan.createLead.name,
      // Where this lead came from, in the same vocabulary lead-intake uses.
      source: "phone",
      lastWriteBy: who,
    });
    if (errors?.length || !account) {
      console.error("triage: lead create failed", JSON.stringify(errors));
      return { ok: false, error: "Could not create the lead." };
    }
    createdAccountId = account.id;
    fileOn.push(account.id);

    // The person who rang, with the number that rang. Without this the lead
    // exists with no way to call anyone back.
    const { errors: contactErrors } = await client.models.Contact.create({
      accountId: account.id,
      name: plan.createLead.contactName ?? plan.createLead.name,
      phone: call.externalNumber,
      isPrimary: true,
      lastWriteBy: who,
    });
    if (contactErrors?.length) {
      // The lead is the thing that had to exist; a missing contact is
      // repairable from the screen, and failing the whole filing here would
      // leave an orphan account and a call still in the queue.
      console.error("triage: contact create failed", JSON.stringify(contactErrors));
    }
  }

  for (const accountId of fileOn) {
    const { errors } = await client.models.CommunicationAccount.create({
      communicationId: call.id,
      accountId,
      occurredAt: call.occurredAt,
    });
    if (errors?.length) {
      console.error(`triage: appearance failed for ${accountId}`, JSON.stringify(errors));
    }
  }

  // A PhoneLink written here is MANUAL: derived from nobody, so the stream
  // handler will not overwrite or reclaim it. That is what makes a
  // suppression stick and what stops a remembered number being undone by the
  // next edit to an unrelated contact.
  if ((plan.remember || plan.suppress) && (fileOn[0] || plan.suppress)) {
    const { errors } = await client.models.PhoneLink.create({
      id: `manual:${call.externalNumber}`,
      e164: call.externalNumber,
      // A suppression is about the number, not an account. It still needs an
      // accountId because the model requires one for the by-account index; a
      // suppressed row is never offered as a candidate, so the value is a
      // placeholder rather than a claim. Where there is a real account — a
      // remembered number — it is the real one.
      accountId: fileOn[0] ?? "suppressed",
      contactName: call.contactName ?? undefined,
      source: "MANUAL",
      suppressed: plan.suppress ? true : undefined,
      linkedAt: now,
    });
    // Already there: the number was filed before, which is not a failure.
    if (errors?.length) {
      const { errors: updateErrors } = await client.models.PhoneLink.update({
        id: `manual:${call.externalNumber}`,
        e164: call.externalNumber,
        accountId: fileOn[0] ?? "suppressed",
        source: "MANUAL",
        suppressed: plan.suppress ? true : undefined,
        linkedAt: now,
      });
      if (updateErrors?.length) {
        console.error("triage: phone link failed", JSON.stringify(updateErrors));
      }
    }
  }

  const { errors } = await client.models.Communication.update({
    id: call.id,
    matchConfidence: "MANUAL",
    appearanceCount: fileOn.length,
    matchedBy: who,
    matchedAt: now,
  });
  if (errors?.length) {
    console.error("triage: could not clear the call", JSON.stringify(errors));
    return { ok: false, error: "Filed, but the queue did not update. Reload." };
  }

  return {
    ok: true,
    filedOn: fileOn.length,
    createdAccountId,
    suppressed: plan.suppress,
  };
};

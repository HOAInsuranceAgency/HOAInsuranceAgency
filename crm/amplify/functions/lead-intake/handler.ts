import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
// Shares crm/src the way this handler already shares nothing else — see
// pagination.ts: enums.ts imports no runtime value beyond `shared/`, so it
// carries no browser data client into the bundle.
import {
  DEFAULT_ACCOUNT_TYPE,
  DEFAULT_CONTACT_TYPE,
  isAccountType,
} from "../../../src/lib/enums";
import { contactKey } from "../../../src/lib/extractionKeys";

/**
 * Public website → CRM lead intake.
 *
 * Exposed via the API-key-authorized `submitWebLead` mutation so the static
 * marketing site can create leads directly. Everything is forced to
 * stage=LEAD / source=website here regardless of input — the public surface
 * can only ever create leads.
 */

let dataClient: ReturnType<typeof generateClient<Schema>> | undefined;

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

const clean = (v: string | null | undefined, max = 500): string | undefined => {
  const t = v?.trim();
  return t ? t.slice(0, max) : undefined;
};

export const handler: Schema["submitWebLead"]["functionHandler"] = async (
  event
) => {
  const args = event.arguments;
  const client = await getDataClient();

  const name = clean(args.name, 200);
  if (!name) return { ok: false, error: "name is required" };

  const type = isAccountType(args.type) ? args.type : DEFAULT_ACCOUNT_TYPE;

  const email = clean(args.contactEmail, 320);
  // a.email() on Account rejects malformed addresses outright; drop instead
  // of losing the whole lead over a typo'd email.
  const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;

  const extraNotes = [
    clean(args.notes, 2000),
    validEmail !== email && email ? `Email (unvalidated): ${email}` : undefined,
    clean(args.unitNumber) && `Unit: ${clean(args.unitNumber)}`,
    clean(args.currentCarrier) && `Current carrier: ${clean(args.currentCarrier)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data, errors } = await client.models.Account.create({
    stage: "LEAD",
    type,
    name,
    address: clean(args.address, 300),
    city: clean(args.city, 100),
    state: clean(args.state, 2)?.toUpperCase(),
    zip: clean(args.zip, 10),
    buildiumId: clean(args.buildiumId, 50),
    source: clean(args.source, 100) ?? "website",
    notes: extraNotes || undefined,
  });

  if (errors?.length || !data) {
    console.error("Lead intake failed", JSON.stringify(errors));
    return { ok: false, error: errors?.[0]?.message ?? "create failed" };
  }

  // The person who filled the form, as a Contact rather than four columns on
  // the Account. The phone finally has a home of its own: it used to be
  // appended to `notes` as "Phone: …" because the comment here claimed
  // a.phone() would reject it — `Account.contactPhone` had already been
  // relaxed to a.string(), so that note was stale, and `Contact.phone` is
  // free-form for the same reason.
  //
  // This is deliberately not fatal. A web lead that 500s because a contact
  // row failed is worse than a lead with a name and address and nobody
  // attached to it — the account exists, the marketing site gets its `ok`,
  // and the failure is in the log for someone to fix by hand.
  const contactName =
    [clean(args.contactFirstName, 100), clean(args.contactLastName, 100)]
      .filter(Boolean)
      .join(" ") || undefined;
  if (contactName || validEmail || clean(args.contactPhone)) {
    const { errors: contactErrors } = await client.models.Contact.create({
      accountId: data.id,
      // `name` is required on the model, and a form that gave only a phone
      // number still describes a person worth keeping.
      name: contactName ?? name,
      email: validEmail,
      phone: clean(args.contactPhone, 50),
      type: DEFAULT_CONTACT_TYPE,
      isPrimary: true,
      // The same key the app computes, from the same function, so a form
      // submitted twice matches one contact instead of creating two — see W9.
      extractionSourceKey: contactKey({
        email: validEmail,
        name: contactName ?? name,
        type: DEFAULT_CONTACT_TYPE,
      }),
    });
    if (contactErrors?.length) {
      console.error(
        `Web lead ${data.id} created, but its contact was not`,
        JSON.stringify(contactErrors)
      );
    }
  }

  console.log(`Web lead created: ${data.id} (${name})`);
  return { ok: true, id: data.id };
};

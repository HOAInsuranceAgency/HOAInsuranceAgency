import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
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
import { listAllPages } from "../../../src/lib/pagination";
import {
  leadText,
  profileName,
  textRecipients,
  unreachableOptIns,
  type LeadSummary,
} from "./sms";

/**
 * Public website → CRM lead intake.
 *
 * Exposed via the API-key-authorized `submitWebLead` mutation so the static
 * marketing site can create leads directly. Everything is forced to
 * stage=LEAD / source=website here regardless of input — the public surface
 * can only ever create leads.
 *
 * Also texts whoever asked to hear about leads. That is here rather than on a
 * stream because "a lead came in" means *this* mutation: an Account reaching
 * stage=LEAD by any other route is a producer typing one in, and texting them
 * about the lead they just entered is noise.
 */

// Named rather than written inline as `Awaited<ReturnType<typeof
// getDataClient>>`: that indirection makes tsc give up with "excessive stack
// depth" on the generated model types.
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

/** How this handler's writes are attributed in the activity log. */
const WRITER = "lead-intake";

const sns = new SNSClient();

/**
 * Text everyone who asked to hear about leads.
 *
 * Swallows everything. The lead is already saved and the marketing site is
 * waiting on this mutation's `ok`; a texting outage must not turn a captured
 * lead into a failed form submission, which is the one outcome that actually
 * loses business. Same reasoning as the Contact create above.
 *
 * Sent in parallel and settled, not raced: one bad number must not stop the
 * other recipients, and this runs inside AppSync's 30s resolver limit with a
 * visitor watching a spinner.
 */
async function textLeadAlerts(
  client: DataClient,
  lead: LeadSummary
): Promise<void> {
  try {
    const baseUrl = process.env.CRM_BASE_URL;
    if (!baseUrl) {
      console.error("CRM_BASE_URL unset — skipping lead texts");
      return;
    }

    const profiles = await listAllPages((nextToken) =>
      client.models.UserProfile.list({ nextToken, limit: 200 })
    );

    // Opted in with nothing to send to. Logged rather than dropped: the
    // switch is on, so this person believes they are covered.
    for (const p of unreachableOptIns(profiles)) {
      console.error(
        `${profileName(p)} has lead texts on but no usable mobile number`
      );
    }

    const recipients = textRecipients(profiles);
    if (recipients.length === 0) return;

    const Message = leadText(lead, baseUrl);
    const results = await Promise.allSettled(
      recipients.map((r) =>
        sns.send(
          new PublishCommand({
            PhoneNumber: r.phone,
            Message,
            MessageAttributes: {
              // Lead alerts are the transactional kind: they must not be
              // dropped for cost optimisation the way Promotional may be.
              "AWS.SNS.SMS.SMSType": {
                DataType: "String",
                StringValue: "Transactional",
              },
            },
          })
        )
      )
    );

    results.forEach((res, i) => {
      if (res.status === "rejected") {
        console.error(
          `Lead text to ${profileName(recipients[i].profile)} failed`,
          res.reason
        );
      }
    });
    const sent = results.filter((r) => r.status === "fulfilled").length;
    console.log(`Lead texts sent: ${sent}/${recipients.length} for ${lead.id}`);
  } catch (err) {
    console.error("Lead texts failed entirely", err);
  }
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
    // Named rather than left to default to "system". The activity log can
    // then say a lead came from the website instead of implying a person did
    // it at 3am — see amplify/functions/activity-log/.
    lastWriteBy: WRITER,
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
    // `name` is required on the model, and a form that gave only a phone
    // number still describes a person worth keeping.
    const person = {
      name: contactName ?? name,
      email: validEmail,
      phone: clean(args.contactPhone, 50),
      type: DEFAULT_CONTACT_TYPE as Schema["Contact"]["type"]["type"],
    };
    // The same key the app computes, from the same function, so a form
    // submitted twice matches one contact instead of creating two.
    // W9 asks this handler to match-then-create so "a web form submitted twice
    // must not produce two contacts". It is written as a plain create anyway,
    // because the duplicate that rule describes cannot happen here and the
    // read that would prove it is guaranteed to come back empty:
    // `data.id` is the account created three statements ago, so no contact
    // can already be on it.
    //
    // The real duplicate a resubmitted form produces is two *accounts*, each
    // with one contact. Deduplicating those means matching an incoming lead
    // against existing LEAD accounts on name and address, which is a decision
    // about what counts as the same association — a different question from
    // this one, with a worse failure mode (two genuinely separate buildings
    // for one management company merged into one lead). It is not in scope
    // here and is called out in the report rather than half-built.
    //
    // The key below is not idle: it is what lets the extraction panel later
    // recognise this person in a prior policy packet and update this row
    // instead of filing a second copy of them.
    const { errors: contactErrors } = await client.models.Contact.create({
      accountId: data.id,
      ...person,
      isPrimary: true,
      lastWriteBy: WRITER,
      extractionSourceKey: contactKey(person),
    });
    if (contactErrors?.length) {
      console.error(
        `Web lead ${data.id} created, but its contact was not`,
        JSON.stringify(contactErrors)
      );
    }
  }

  console.log(`Web lead created: ${data.id} (${name})`);

  // After the contact, so the text carries the caller's name and number —
  // the two things that decide whether someone rings back now or later.
  await textLeadAlerts(client, {
    id: data.id,
    name,
    city: data.city,
    state: data.state,
    contactName,
    contactPhone: clean(args.contactPhone, 50),
    source: data.source,
  });

  return { ok: true, id: data.id };
};

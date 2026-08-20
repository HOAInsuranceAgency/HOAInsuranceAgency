import { randomUUID } from "node:crypto";
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
import { contactKey, priorCarrierKey } from "../../../src/lib/extractionKeys";
import { listAllPages } from "../../../src/lib/pagination";
import { NO_UPLOAD_WINDOW_MINUTES } from "../../../../shared/leadUpload";
import { parsePolicyExpiration, parseUnitCount } from "./fields";
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

  /**
   * Both have a real column, so `notes` is only the fallback for a value that
   * would not go in one. Recorded rather than dropped: a producer reading
   * "Units (unparsed): twelve-ish" can fix it, and a silent discard is how a
   * lead arrives looking like it never answered the question.
   */
  const unitCount = parseUnitCount(args.unitCount);
  const policyExpiration = parsePolicyExpiration(args.currentPolicyExpiration);
  const rawUnits = clean(args.unitCount, 50);
  const rawExpiration = clean(args.currentPolicyExpiration, 50);

  const extraNotes = [
    clean(args.notes, 2000),
    validEmail !== email && email ? `Email (unvalidated): ${email}` : undefined,
    clean(args.unitNumber) && `Unit: ${clean(args.unitNumber)}`,
    unitCount === null && rawUnits ? `Units (unparsed): ${rawUnits}` : undefined,
    policyExpiration === null && rawExpiration
      ? `Program expiry (unparsed): ${rawExpiration}`
      : undefined,
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
    // Drives the Units column on the accounts list.
    unitCount: unitCount ?? undefined,
    // Drives "Incumbent expires" there and the dashboard renewal pipeline.
    currentPolicyExpiration: policyExpiration ?? undefined,
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

  /**
   * The incumbent carrier as a `PriorCarrier` row.
   *
   * It used to be a line of prose in `notes`, where the account's own Prior
   * carriers tab could not see it and neither could the ACORD incumbent-coverage
   * block that `acordApp.ts` builds from these rows. A producer retyped what the
   * lead had already told us.
   *
   * `lineOfBusiness` is left empty on purpose. The form asks who the carrier is,
   * not which line they write, and an association routinely splits property, GL
   * and D&O across three of them. The wizard's "lines to review" answers say
   * what the board wants looked at, not what this carrier covers, so filling the
   * line from them would be inventing a fact about their program. The tab shows
   * an empty line as "—" and takes one keystroke to set.
   *
   * Keyed with the same `priorCarrierKey` the tab uses on a hand-typed row, so a
   * later extraction over the declarations page can recognise this row and
   * update it rather than file a second copy beside it.
   */
  const carrierName = clean(args.currentCarrier, 200);
  if (carrierName) {
    const prior = {
      carrierName,
      policyNumber: null,
      lineOfBusiness: null,
    };
    const { errors: carrierErrors } = await client.models.PriorCarrier.create({
      accountId: data.id,
      carrierName,
      // The expiry they gave is this carrier's term ending. Also on the account,
      // where it drives the lead renewal pipeline; here it is what makes the row
      // useful on an ACORD form rather than a bare name.
      expirationDate: policyExpiration ?? undefined,
      lastWriteBy: WRITER,
      extractionSourceKey: priorCarrierKey(prior),
    });
    if (carrierErrors?.length) {
      console.error(
        `Web lead ${data.id}: prior carrier row failed`,
        JSON.stringify(carrierErrors)
      );
      /**
       * Put it back in `notes` rather than lose it.
       *
       * This is the only field intake moves out of prose into a row of its own,
       * so it is the only one a failed child write can drop entirely. A repair
       * write in an already-failing path is cheap; a producer never learning who
       * the incumbent is costs a call.
       */
      const repaired = [extraNotes, `Current carrier: ${carrierName}`]
        .filter(Boolean)
        .join("\n");
      const { errors: noteErrors } = await client.models.Account.update({
        id: data.id,
        notes: repaired,
        lastWriteBy: WRITER,
      });
      if (noteErrors?.length) {
        console.error(
          `Web lead ${data.id}: could not record the carrier in notes either`,
          JSON.stringify(noteErrors)
        );
      }
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

  /**
   * Open the auto-reply window.
   *
   * Created after the contact and the text, so an email address failure here
   * cannot cost the agency its instant alert. A lead with no email gets no
   * window at all — there is nowhere to reply to — and that is not an error:
   * the account and the alert are the parts that matter.
   *
   * The token is what the visitor uses to upload files and to say they are
   * done. It is minted here, returned once, and never queryable, so it is the
   * only thing standing between an anonymous caller and someone else's lead.
   */
  const contactEmail = clean(args.contactEmail, 200);
  let uploadToken: string | null = null;
  if (contactEmail) {
    uploadToken = randomUUID() + randomUUID().replace(/-/g, "");
    const { errors: replyErrors } = await client.models.LeadReply.create({
      accountId: data.id,
      contactEmail,
      contactName,
      status: "WAITING",
      uploadToken,
      submittedAt: new Date().toISOString(),
      // No files yet, so the clock is the plain no-upload window.
      dueAt: new Date(Date.now() + NO_UPLOAD_WINDOW_MINUTES * 60_000).toISOString(),
      uploadCount: 0,
    });
    if (replyErrors?.length) {
      // Same reasoning as the contact above: the lead is captured and the
      // agency has been told. Losing the auto-reply is worse than losing the
      // lead only if it takes the lead with it.
      console.error("LeadReply create failed", JSON.stringify(replyErrors));
      uploadToken = null;
    }
  }

  return {
    ok: true,
    id: data.id,
    // Absent when there is no email to reply to, or the window failed to open.
    // The form treats a missing token as "no upload panel", never as an error.
    uploadToken,
    uploadWindowMinutes: uploadToken ? NO_UPLOAD_WINDOW_MINUTES : null,
  };
};

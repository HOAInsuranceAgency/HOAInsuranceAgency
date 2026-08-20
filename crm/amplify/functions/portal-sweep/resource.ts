import { defineFunction } from "@aws-amplify/backend";

/**
 * Tells the team when a lead has sent documents through their upload page.
 *
 * ## Why a sweep and not a trigger
 *
 * The obvious design is to email on upload. That produces five emails for five
 * years of loss runs, which is worse than none — it trains everyone to ignore
 * them. So the portal records `lastUploadAt` and this compares it against
 * `notifiedUpTo`, sending one email per sitting once the portal has been quiet
 * (see QUIET_MINUTES in decide.ts).
 *
 * ## Why it also runs extraction
 *
 * Because nothing else did. `extract-lead` is invoked from exactly two places:
 * `lead-reply`, during the eight-minute window after a form submission, and a
 * human pressing "Re-run extraction" in the app. Documents arriving through the
 * portal days later were OCR'd and then read by nobody. This closes that, and it
 * is why the email can say what the loss runs contain rather than that four
 * files showed up.
 *
 * ## Why its own function
 *
 * `lead-reply` already sweeps every minute and could have carried this. It
 * shouldn't: that function means "reply to a new lead" and these uploads land
 * weeks later on an established account. A name that lies is how the next person
 * loses an hour.
 *
 * Ten minutes, not one. Nothing here is urgent to the minute, and the quiet
 * period is ten minutes anyway, so a minutely tick would be fifty-nine wasted
 * invocations an hour.
 */
export const portalSweep = defineFunction({
  name: "portal-sweep",
  entry: "./handler.ts",
  schedule: {
    // Day-of-month `*`, day-of-week `?` — the one combination Amplify's
    // validator accepts. See task-digest for what happens when it isn't.
    cron: "*/10 * * * ? *",
    timezone: "America/New_York",
    description: "Lead document upload notifications",
  },
  timeoutSeconds: 300,
  memoryMB: 512,
  resourceGroupName: "data",
});

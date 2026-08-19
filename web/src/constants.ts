import { AGENCY, AGENCY_FMT } from "../../shared/agency";

export const PHONE = AGENCY.phone;
export const PHONE_HREF = AGENCY_FMT.phoneHref;
/** The agency's general address — footer, legal pages, JSON-LD. */
export const EMAIL = AGENCY.email;
export const EMAIL_HREF = AGENCY_FMT.emailHref;
/**
 * Sales. Shown on the lead-capture surfaces — the contact card beside the
 * inquiry form, and the "Prefer to talk?" block on the quote forms — so the
 * address a prospect is invited to write to is the one their form submission
 * already goes to.
 */
export const LEAD_EMAIL = AGENCY.leadEmail;
export const LEAD_EMAIL_HREF = AGENCY_FMT.leadEmailHref;
export const ADDRESS_LINE1 = AGENCY.addressLine1;
export const ADDRESS_LINE2 = AGENCY_FMT.addressLine2;
export const QUOTE_URL = "/quote";
/** Delivers to `LEAD_EMAIL` — see `AGENCY_FMT.formsubmitUrl`. */
export const FORMSUBMIT_URL = AGENCY_FMT.formsubmitUrl;

/**
 * Analytics kill switch — Google Ads and Microsoft Clarity.
 *
 * **On by default.** Production needs no configuration, so analytics can never
 * be lost to a forgotten variable. Set `PUBLIC_ANALYTICS_DISABLED=true` on the
 * **staging** Amplify app (and any branch preview) to turn both off there, so
 * a test lead cannot register a conversion against the live campaign and
 * staging sessions stay out of Clarity.
 *
 * Read via a helper rather than inline so the .astro <head>s and this module
 * share one definition — the account id itself is still repeated across four
 * heads (see INVENTORY §1.5).
 */
export const ANALYTICS_DISABLED =
  import.meta.env.PUBLIC_ANALYTICS_DISABLED === "true";

/* ── Measurement IDs ──
   Named here and consumed only by components/Analytics.astro. They used to be
   written out longhand in four separate <head>s, which is how a site ends up
   reporting to a property it no longer owns. */

/** GA4 property. Added 2026-08-11 — the site had no GA4 before this. */
export const GA4_ID = "G-VWMS4RWTRX";

/**
 * Google Ads accounts configured on every page.
 *
 * Two accounts, deliberately:
 *
 *   AW-18085022517  the original. Owns the conversion label in
 *                   ADS_CONVERSION_ID below and all historical conversion data.
 *   AW-18384211768  added 2026-08-17. Receives page views and auto-tagging only.
 *                   It has NO conversion label wired up, so it CANNOT record a
 *                   conversion yet — see the note on ADS_CONVERSION_ID.
 *
 * An array rather than two constants so Analytics.astro configures each in a
 * loop: adding or retiring an account is a one-line data edit here, with no
 * second place to forget.
 *
 * gtag/js is still requested exactly ONCE (see Analytics.astro). Extra accounts
 * are extra `config` calls off the same library — never extra script tags. The
 * snippet Google Ads hands you includes its own `gtag/js` tag; that half is
 * always discarded here.
 */
export const ADS_IDS = ["AW-18085022517", "AW-18384211768"] as const;

/** Microsoft Clarity project. */
export const CLARITY_ID = "wamnker55b";

/**
 * Google Ads conversion `send_to` — account id and label, slash-separated.
 *
 * ⚠ THIS POINTS AT THE OLDER OF THE TWO ACCOUNTS IN ADS_IDS.
 *
 * A conversion label belongs to the account that minted it, so this value can
 * only ever record against AW-18085022517. AW-18384211768 is configured for page
 * views and auto-tagging (it is in ADS_IDS) but has no label here, which means:
 *
 *   · its conversion actions will sit at zero and show "Unverified"
 *   · no amount of deploying changes that — the label is the missing piece
 *
 * To point conversions at the new account, replace this whole string with the
 * `send_to` value from that account's own event snippet:
 *   Google Ads → Goals → Conversions → the action → Tag setup →
 *   "Install the tag yourself" → event snippet → copy `send_to`.
 * Take ONLY that string. The gtag/js tag shown alongside it is already loaded by
 * components/Analytics.astro and must not be added a second time.
 *
 * One label, one account. If both accounts ever need to record the same lead,
 * this becomes an array and trackLead() loops it — do not paste a second gtag
 * call into a form to achieve it.
 */
const ADS_CONVERSION_ID = "AW-18085022517/Csp3COKBgpscELWWzq9D";

type Gtag = (
  command: "event",
  action: "generate_lead" | "conversion",
  params: Record<string, string | number>
) => void;

/**
 * Which form produced the lead. Sent to GA4 as the `form_name` parameter so one
 * report can be broken down per form rather than showing a single
 * undifferentiated total.
 *
 * A union rather than a bare string: every lead surface is named here exactly
 * once, so a typo at a call site is a compile error instead of a stray value that
 * quietly splits a report in two. Adding a sixth form means adding it here first.
 *
 * These strings reach GA4 and become report rows — treat them as an API. Renaming
 * one splits its history at the rename, so leave them alone once live.
 */
export type LeadForm =
  | "contact"
  | "coverage_calculator"
  | "instant_assessment"
  | "association_ho6"
  | "quote_wizard";

/**
 * Report one converted lead, to BOTH destinations.
 *
 * Every lead surface calls this and nothing else. It replaced `fireConversion`,
 * which sent the Google Ads conversion only — that left GA4 holding the channel
 * data (organic / paid / direct / referral) with no conversion to break down by
 * it, and Ads holding conversions with no visibility of organic. Each platform
 * had half the answer and neither could join them.
 *
 * -- Two events, one call --
 * 1. GA4 `generate_lead` — GA4's recommended event name for a captured lead, so
 *    it lands in the standard reports with no custom setup.
 * 2. Google Ads `conversion` — unchanged: same account, same label as before.
 *
 * Both go through the single gtag instance configured in
 * components/Analytics.astro. `send_to` on the second call is what routes it to
 * Ads; the first has no `send_to`, so it reaches the GA4 property.
 *
 * -- Attribution is NOT sent from here --
 * Do not add source / medium / campaign parameters. GA4 derives the channel from
 * the session that fired the event, and Ads from the click id. Anything passed
 * here would be a second, less reliable copy competing with the real one. To see
 * leads split by organic vs paid, use Reports -> Acquisition -> Traffic
 * acquisition with `generate_lead` as the selected conversion. That works because
 * of the session, not because of this payload.
 *
 * Declines silently when analytics is switched off, when there is no window
 * (SSR), or when the tag has not loaded.
 */
export function trackLead(form: LeadForm): void {
  if (ANALYTICS_DISABLED) return;
  if (typeof window === "undefined") return;
  const gtag = (window as Window & { gtag?: Gtag }).gtag;
  if (!gtag) return;

  // GA4. No send_to — this one is for the measurement property.
  gtag("event", "generate_lead", {
    currency: "USD",
    value: 1.0,
    form_name: form,
  });

  // Google Ads. send_to carries the account and the conversion label.
  gtag("event", "conversion", {
    send_to: ADS_CONVERSION_ID,
    value: 1.0,
    currency: "USD",
  });
}

export const SOCIAL = {
  instagram: "https://www.instagram.com/hoainsuranceagency",
  facebook: "https://www.facebook.com/people/HOA-Insurance-Agency/61575377498498/",
  linkedin: "https://www.linkedin.com/company/hoa-insurance-agency",
};

export const NAV_LINKS = [
  { label: "Home", path: "/" },
  { label: "HOA Insurance", path: "/what-we-do" },
  { label: "Why Choose Us", path: "/why-choose-us" },
  // Moved after Why Choose Us: the order now runs product → proof → who we are,
  // rather than putting the company before what it sells.
  //
  // Points at the homepage, not /about-us, by request. Two consequences worth
  // knowing about:
  //   1. Navbar.astro highlights only the FIRST matching link, otherwise Home
  //      and About Us would both light up on "/".
  //   2. /about-us still exists, is still indexed and is still linked from the
  //      homepage ("About our brokerage" in the practice section). It has lost
  //      its site-wide nav link, so that homepage link is now its only internal
  //      one — do not remove it without replacing the path here.
  { label: "About Us", path: "/" },
  // A real route now, not an in-page anchor. Navbar.astro treats non-hash paths
  // as highlightable, so Contact gains an active state on /contact.
  { label: "Contact", path: "/contact" },
];

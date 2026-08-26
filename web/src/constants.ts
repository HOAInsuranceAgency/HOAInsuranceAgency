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
/**
 * Where the FormSubmit notification lands.
 *
 * `PUBLIC_LEAD_NOTIFY_EMAIL` overrides the address per branch, so staging can
 * submit real forms without dropping test enquiries in the queue the team works
 * from. Unset falls back to the agency's sales address, which is what
 * production wants and what this always did.
 *
 * NOTE: FormSubmit activates per recipient. The first submission to a new
 * address emails that address a confirmation link, and nothing is delivered
 * until someone clicks it.
 */
const NOTIFY_EMAIL = import.meta.env.PUBLIC_LEAD_NOTIFY_EMAIL || AGENCY.leadEmail;
export const FORMSUBMIT_URL = `https://formsubmit.co/ajax/${NOTIFY_EMAIL.toLowerCase()}`;

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
 *   AW-18085022517  the original. Holds all conversion history before
 *                   2026-08-26.
 *   AW-18384211768  added 2026-08-17. Where the campaigns actually run.
 *
 * Being listed HERE only buys page views and auto-tagging. Recording a
 * conversion additionally needs a label in ADS_CONVERSION_IDS below — both
 * accounts now have one.
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
 * Google Ads conversion `send_to` values — account id and label, slash-separated,
 * one entry per Ads account that should record the lead.
 *
 * Both accounts record every lead as of 2026-08-26. `trackLead()` sends one
 * `conversion` event per entry, because `send_to` names exactly one
 * account-and-label pair — a single call cannot credit two accounts.
 *
 * -- Why the new account read "Inactive" for so long --
 * A conversion label is minted by, and belongs to, the account that created it.
 * AW-18384211768 sat at zero conversions with an Inactive action for days while
 * being correctly tagged, because it was listed in ADS_IDS (which buys page views
 * and auto-tagging) but had no label here. Being tagged is not being measured.
 *
 * -- Two traps when adding an account --
 * 1. An action created through *Event type: Form submission -> URL starts with*
 *    is RULE-BASED: Google evaluates it tag-side and never mints a label, so no
 *    event snippet exists to copy. It also cannot see this site's forms — they
 *    preventDefault() and never change the URL, and QuoteApp has no <form>
 *    element at all. Only "+ Add a conversion action manually", the link below
 *    the site-scan results, produces a label.
 * 2. The snippet Google shows FIRST is the account-level Google tag —
 *    gtag('config', 'AW-...'), with no send_to. That belongs in ADS_IDS, not
 *    here. The label lives in the SECOND block, the event snippet.
 *
 * Take only the `send_to` string. The gtag/js tag shown beside it is already
 * loaded once by components/Analytics.astro and must never be added again.
 */
const ADS_CONVERSION_IDS = [
  "AW-18384211768/S7dLCNSnnugcELieo75E",
  "AW-18085022517/Csp3COKBgpscELWWzq9D",
] as const;

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
 * -- One call, one event per destination --
 * 1. GA4 `generate_lead` — GA4's recommended event name for a captured lead, so
 *    it lands in the standard reports with no custom setup.
 * 2. Google Ads `conversion` — once per entry in ADS_CONVERSION_IDS. Currently
 *    two, so one lead credits both Ads accounts.
 *
 * All of them go through the single gtag instance configured in
 * components/Analytics.astro. `send_to` is what determines which Ads account
 * receives an event; the GA4 call carries none, so it reaches the property.
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

  // Google Ads. send_to carries the account and the conversion label, so one
  // event per label — a single call cannot credit two accounts.
  for (const sendTo of ADS_CONVERSION_IDS) {
    gtag("event", "conversion", {
      send_to: sendTo,
      value: 1.0,
      currency: "USD",
    });
  }
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

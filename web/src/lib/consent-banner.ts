/**
 * The privacy banner, the "Cookie Preferences" panel, and the tag loader.
 *
 * Google Analytics and Google Ads run by default and stop if the visitor
 * declines them; on Pacific time Google Ads waits for consent. Microsoft
 * Clarity always waits for consent (see lib/consent.ts for why). The banner and dialog are built here rather
 * than in a component so every page that renders <Analytics /> gets them,
 * including the full-bleed templates that do not use Layout. Styles live in
 * components/ConsentBanner.css.
 *
 * Any element with `data-privacy-choices`, or a URL ending in
 * `#privacy-choices`, opens the dialog.
 */
import { ANALYTICS_DISABLED, ADS_IDS, CLARITY_ID, GA4_ID } from "../constants";
import {
  consentFirstRegion,
  effectiveConsent,
  gpcEnabled,
  readConsent,
  saveConsent,
  type ConsentChoice,
  type ConsentState,
} from "./consent";

type TagWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  clarity?: unknown;
};

/* ── Tags ─────────────────────────────────────────────────────────────── */

const loaded = { gtag: false, ga4: false, ads: false, clarity: false };

function addScript(src: string): void {
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

/** Load and configure exactly the tags allowed. Never unloads. */
function applyTags(choice: ConsentChoice): void {
  if (ANALYTICS_DISABLED) return;
  const w = window as TagWindow;

  if ((choice.analytics || choice.marketing) && !loaded.gtag) {
    w.dataLayer = w.dataLayer || [];
    // gtag.js needs the real `arguments` object, not an array.
    w.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    };
    w.gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    addScript(`https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`);
    w.gtag("js", new Date());
    loaded.gtag = true;
  }
  const gtag = w.gtag;
  if (gtag) {
    gtag("consent", "update", {
      analytics_storage: choice.analytics ? "granted" : "denied",
      ad_storage: choice.marketing ? "granted" : "denied",
      ad_user_data: choice.marketing ? "granted" : "denied",
      ad_personalization: choice.marketing ? "granted" : "denied",
    });
    if (choice.analytics && !loaded.ga4) {
      // Without marketing consent GA4 stays pure measurement: no Google
      // signals and no ad personalization.
      gtag("config", GA4_ID, {
        allow_google_signals: choice.marketing,
        allow_ad_personalization_signals: choice.marketing,
      });
      loaded.ga4 = true;
    }
    if (choice.marketing && !loaded.ads) {
      for (const id of ADS_IDS) gtag("config", id);
      loaded.ads = true;
    }
  }

  if (choice.insights && !loaded.clarity) {
    // Clarity's own stub: queue calls as `arguments` objects until the tag loads.
    type ClarityStub = { (...args: unknown[]): void; q?: unknown[] };
    if (!w.clarity) {
      const stub: ClarityStub = function clarity() {
        // eslint-disable-next-line prefer-rest-params
        (stub.q = stub.q || []).push(arguments);
      };
      w.clarity = stub;
    }
    addScript(`https://www.clarity.ms/tag/${CLARITY_ID}`);
    loaded.clarity = true;
  }
}

/** Cookies set by the tags above, removed when the visitor turns them off. */
const TAG_COOKIE = /^(_ga|_gid|_gat|_gcl|_clck|_clsk|CLID|ANONCHK|MUID|SM|MR)/;

function clearTagCookies(): void {
  const host = window.location.hostname;
  const domains = ["", host, `.${host}`, `.${host.split(".").slice(-2).join(".")}`];
  for (const part of document.cookie.split("; ")) {
    const name = part.split("=")[0];
    if (!TAG_COOKIE.test(name)) continue;
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ""}`;
    }
  }
}

/** Save, then load newly allowed tags or reload to stop withdrawn ones. */
function commit(choice: ConsentChoice, source: ConsentState["source"]): void {
  const before = effectiveConsent();
  const saved = saveConsent(choice, source);
  hideBanner();
  closeDialog();
  const withdrew =
    (before.analytics && !saved.analytics) ||
    (before.insights && !saved.insights) ||
    (before.marketing && !saved.marketing) ||
    (loaded.ga4 && !saved.analytics) ||
    (loaded.clarity && !saved.insights) ||
    (loaded.ads && !saved.marketing);
  if (withdrew) {
    clearTagCookies();
    window.location.reload();
    return;
  }
  applyTags(saved);
}

const ALL_ON: ConsentChoice = { analytics: true, insights: true, marketing: true };
const ALL_OFF: ConsentChoice = { analytics: false, insights: false, marketing: false };

/* ── UI ───────────────────────────────────────────────────────────────── */
/*
 * The panel shows three categories: Functional, Performance and Targeting.
 * Performance covers Google Analytics (on unless declined) and Microsoft
 * Clarity, which starts only once the visitor confirms Performance through
 * "Accept All" or "Save Preferences". Targeting covers Google Ads.
 */

const GPC_NOTE =
  "A Global Privacy Control signal has been detected from your browser. Targeting cookies remain disabled.";

let banner: HTMLElement | null = null;
let dialog: HTMLDialogElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function policyLink(label = "Privacy Policy"): HTMLAnchorElement {
  return el("a", { href: "/privacy-policy/#cookies" }, label);
}

/** Targeting waits for consent here (Pacific time, or a GPC signal). */
function targetingNeedsConsent(): boolean {
  return consentFirstRegion() || gpcEnabled();
}

function showBanner(): void {
  if (banner) return;
  banner = el("section", { class: "pmh-consent", role: "region", "aria-labelledby": "pmh-consent-title" });
  const inner = el("div", { class: "pmh-consent__inner" });
  const copy = el("div", { class: "pmh-consent__copy" });
  copy.append(el("h2", { id: "pmh-consent-title", class: "pmh-consent__title" }, "Cookie Preferences"));
  // One paragraph, one style: the summary, then what is always on and what needs consent.
  const text = el("p", { class: "pmh-consent__text" });
  text.append(
    "This website uses cookies and similar technologies to operate securely, evaluate site performance and assess the effectiveness of our marketing. ",
    targetingNeedsConsent()
      ? "Functional cookies are always active. Session recording and targeting cookies are placed only with your consent. You may review or change your preferences at any time. "
      : "Functional cookies are always active. Session recording is enabled only with your consent. You may review or change your preferences at any time. ",
    policyLink(),
  );
  copy.append(text);
  if (gpcEnabled()) copy.append(el("p", { class: "pmh-consent__gpc" }, GPC_NOTE));

  const actions = el("div", { class: "pmh-consent__actions" });
  const accept = el("button", { type: "button", class: "pmh-consent__btn" }, "Accept All");
  const reject = el("button", { type: "button", class: "pmh-consent__btn" }, "Decline All");
  const manage = el("button", { type: "button", class: "pmh-consent__btn pmh-consent__btn--quiet pmh-consent__btn--wide" }, "Manage Preferences");
  accept.addEventListener("click", () => commit(ALL_ON, "banner"));
  reject.addEventListener("click", () => commit(ALL_OFF, "banner"));
  manage.addEventListener("click", () => openDialog());
  actions.append(accept, reject, manage);

  inner.append(copy, actions);
  banner.append(inner);
  document.body.append(banner);
}

function hideBanner(): void {
  banner?.remove();
  banner = null;
}

interface Category {
  id: string;
  title: string;
  summary: string;
  details: string[];
  checked: boolean;
  /** Switch shown on but fixed (Functional) or off but fixed (GPC). */
  disabled: boolean;
  /** Small label beside the switch, e.g. "Always active". */
  badge: string | null;
  status: string;
}

function categoryRow(c: Category): HTMLElement {
  const row = el("div", { class: "pmh-choice" });
  const top = el("div", { class: "pmh-choice__top" });
  const text = el("div", { class: "pmh-choice__text" });
  const title = el("label", { for: c.id, class: "pmh-choice__title" }, c.title);
  text.append(title, el("p", { id: `${c.id}-desc`, class: "pmh-choice__desc" }, c.summary));
  const input = el("input", {
    type: "checkbox",
    id: c.id,
    role: "switch",
    class: "pmh-switch",
    "aria-describedby": `${c.id}-desc`,
  });
  input.checked = c.checked;
  input.disabled = c.disabled;
  const control = el("div", { class: "pmh-choice__control" });
  if (c.badge) control.append(el("span", { class: "pmh-choice__badge" }, c.badge));
  control.append(input);
  top.append(text, control);

  const more = el("details", { class: "pmh-more" });
  more.append(el("summary", {}, "More information"));
  const body = el("div", { class: "pmh-more__body" });
  for (const paragraph of c.details) body.append(el("p", {}, paragraph));
  body.append(el("p", { class: "pmh-more__status" }, c.status));
  more.append(body);
  row.append(top, more);
  return row;
}

function buildDialog(): HTMLDialogElement {
  const current = readConsent();
  const choice = effectiveConsent();
  const gpc = gpcEnabled();
  const d = el("dialog", { class: "pmh-dialog", "aria-labelledby": "pmh-dialog-title" });
  const form = el("form", { method: "dialog", class: "pmh-dialog__form" });

  const head = el("div", { class: "pmh-dialog__head" });
  head.append(el("h2", { id: "pmh-dialog-title", class: "pmh-dialog__title" }, "Cookie Preferences"));
  const close = el("button", { type: "button", class: "pmh-dialog__close", "aria-label": "Close" }, "×");
  close.addEventListener("click", () => closeDialog());
  head.append(close);

  const intro = el("p", { class: "pmh-dialog__intro" });
  intro.append(
    "We use cookies and similar technologies in the categories described below. Select the categories you wish to permit and save your preferences. Your selection may be revised at any time. Further detail is available in our ",
    policyLink(),
    ".",
  );

  const list = el("div", { class: "pmh-dialog__list" });
  list.append(
    categoryRow({
      id: "pmh-functional",
      title: "Functional",
      summary: "Required for the website to operate securely and to retain your preferences.",
      details: [
        "These cookies support core website operations, including security, retention of the preferences selected in this panel and the delivery of inquiries submitted through our forms to our team.",
        "They are not used for advertising purposes and cannot be disabled.",
      ],
      checked: true,
      disabled: true,
      badge: "Always active",
      status: "Status: always active.",
    }),
    categoryRow({
      id: "pmh-performance",
      title: "Performance",
      summary: "Help us measure website usage and improve its performance.",
      details: [
        "Performance cookies provide aggregated information on visits, traffic sources and page performance, helping us understand how the website is used and where it can be improved.",
        "Where you confirm this category, on-page interactions such as clicks, scrolling and navigation may also be analyzed to identify usability issues. This analysis begins only after your preferences are confirmed.",
      ],
      checked: choice.analytics,
      disabled: false,
      badge: null,
      status: current
        ? `Status: ${choice.analytics ? "enabled" : "disabled"} by your saved preferences.`
        : "Status: active by default; interaction analysis requires your confirmation.",
    }),
    categoryRow({
      id: "pmh-targeting",
      title: "Targeting",
      summary: "Help us assess the effectiveness of our advertising.",
      details: [
        "Targeting cookies indicate when a visit that originates from one of our advertisements results in an inquiry, allowing us to evaluate and refine our campaigns.",
        "Under certain state privacy laws, this activity may constitute a “sale” or “sharing” of personal information or “targeted advertising.” Disabling this category opts you out of that activity for this browser.",
      ],
      checked: gpc ? false : choice.marketing,
      disabled: gpc,
      badge: gpc ? "Disabled" : null,
      status: gpc
        ? "Status: disabled in response to a Global Privacy Control signal."
        : current
          ? `Status: ${choice.marketing ? "enabled" : "disabled"} by your saved preferences.`
          : targetingNeedsConsent()
            ? "Status: requires your consent before activation."
            : "Status: active by default; may be disabled at any time.",
    }),
  );

  const actions = el("div", { class: "pmh-dialog__actions" });
  const save = el("button", { type: "button", class: "pmh-consent__btn pmh-consent__btn--quiet pmh-consent__btn--wide" }, "Save Preferences");
  const reject = el("button", { type: "button", class: "pmh-consent__btn" }, "Decline All");
  const accept = el("button", { type: "button", class: "pmh-consent__btn" }, "Accept All");
  save.addEventListener("click", () => {
    const checked = (id: string) => (d.querySelector(id) as HTMLInputElement).checked;
    const performance = checked("#pmh-performance");
    // Confirming Performance is the consent that starts Clarity.
    commit({ analytics: performance, insights: performance, marketing: checked("#pmh-targeting") }, "settings");
  });
  reject.addEventListener("click", () => commit(ALL_OFF, "settings"));
  accept.addEventListener("click", () => commit(ALL_ON, "settings"));
  actions.append(accept, reject, save);

  form.append(head, intro, list, actions);
  if (current) {
    form.append(
      el(
        "p",
        { class: "pmh-dialog__saved" },
        `Preferences last saved ${new Date(current.at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.`,
      ),
    );
  }
  d.append(form);
  d.addEventListener("close", () => {
    d.remove();
    if (dialog === d) dialog = null;
  });
  return d;
}

function openDialog(): void {
  if (dialog) return;
  dialog = buildDialog();
  document.body.append(dialog);
  dialog.showModal();
}

function closeDialog(): void {
  dialog?.close();
}

/** Called once per page by components/Analytics.astro. */
export function startConsent(): void {
  applyTags(effectiveConsent());
  if (!readConsent()) showBanner();

  document.addEventListener("click", (event) => {
    const trigger = (event.target as Element | null)?.closest("[data-privacy-choices]");
    if (!trigger) return;
    event.preventDefault();
    openDialog();
  });
  const openFromHash = () => {
    if (window.location.hash === "#privacy-choices") openDialog();
  };
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
}

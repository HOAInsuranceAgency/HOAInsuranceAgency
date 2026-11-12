import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../web/src/constants", () => ({
  ANALYTICS_DISABLED: false,
  ADS_IDS: ["AW-test"],
  CLARITY_ID: "clarity-test",
  GA4_ID: "G-test",
}));

const OFF = { analytics: false, insights: false, marketing: false };
const ON = { analytics: true, insights: true, marketing: true };

describe("website cookie preferences", () => {
  let jar: Map<string, string>;
  let writes: "allowed" | "ignored" | "throw";
  let blockedReads: boolean;
  let reload: ReturnType<typeof vi.fn>;
  let browser: Record<string, unknown>;
  let listeners: Array<[string, EventListenerOrEventListenerObject]>;

  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    writes = "allowed";
    blockedReads = false;
    listeners = [];
    reload = vi.fn();
    browser = {
      location: { protocol: "https:", hostname: "www.protectmyhoa.com", hash: "", reload },
      addEventListener: vi.fn(),
    };
    vi.stubGlobal("window", browser);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "America/New_York" } as Intl.ResolvedDateTimeFormatOptions);
    vi.spyOn(document, "cookie", "get").mockImplementation(() => {
      if (blockedReads) throw new Error("Cookies blocked");
      return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
    });
    vi.spyOn(document, "cookie", "set").mockImplementation((value) => {
      if (writes === "throw") throw new Error("Cookies blocked");
      if (writes === "ignored") return;
      const pair = value.split(";", 1)[0];
      const index = pair.indexOf("=");
      const key = pair.slice(0, index);
      if (value.includes("Max-Age=0;")) jar.delete(key);
      else jar.set(key, pair.slice(index + 1));
    });
    const addListener = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (listener) listeners.push([type, listener]);
      addListener(type, listener, options);
    });
    document.body.innerHTML = "";
    document.head.querySelectorAll("script").forEach((script) => script.remove());
    Object.defineProperty(navigator, "globalPrivacyControl", { value: false, configurable: true });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { value: vi.fn(), configurable: true });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      value: vi.fn(function (this: HTMLDialogElement) { this.dispatchEvent(new Event("close")); }),
      configurable: true,
    });
  });

  afterEach(() => {
    for (const [type, listener] of listeners) document.removeEventListener(type, listener);
    document.body.innerHTML = "";
    document.head.querySelectorAll("script").forEach((script) => script.remove());
    delete (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const tags = () => document.head.querySelectorAll('script[src*="googletagmanager"], script[src*="clarity.ms"]');
  const click = (label: string) => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(button).toBeDefined();
    button!.click();
  };
  const start = async () => {
    const consent = await import("../../../web/src/lib/consent");
    const { startConsent } = await import("../../../web/src/lib/consent-banner");
    startConsent();
    return consent;
  };

  it("preserves the normal defaults and saves a decline across page loads", async () => {
    const consent = await start();
    expect(consent.effectiveConsent()).toEqual({ analytics: true, insights: false, marketing: true });
    expect(tags()).toHaveLength(1);
    click("Decline All");
    expect(reload).toHaveBeenCalledOnce();
    expect(consent.readConsent()).toMatchObject(OFF);
    vi.resetModules();
    document.body.innerHTML = "";
    document.head.querySelectorAll("script").forEach((script) => script.remove());
    const nextPage = await start();
    expect(nextPage.effectiveConsent()).toMatchObject(OFF);
    expect(tags()).toHaveLength(0);
    expect(document.querySelector(".pmh-consent")).toBeNull();
  });

  it.each(["ignored", "throw"] as const)("keeps tags off when cookie writes are %s, including accept and decline clicks", async (mode) => {
    writes = mode;
    const consent = await start();
    expect(consent.effectiveConsent()).toEqual(OFF);
    expect(tags()).toHaveLength(0);
    click("Accept All");
    expect(consent.effectiveConsent()).toEqual(OFF);
    expect(consent.readConsent()).toBeNull();
    expect(tags()).toHaveLength(0);
    expect(document.body).toHaveTextContent("preferences could not be saved");
    click("Decline All");
    expect(reload).not.toHaveBeenCalled();
    expect(tags()).toHaveLength(0);
    click("Continue without optional tracking");
    expect(document.querySelector(".pmh-consent")).toBeNull();
    expect(consent.effectiveConsent()).toEqual(OFF);
  });

  it("does not trust a saved opt-in when the browser can no longer retain an opt-out", async () => {
    const consent = await import("../../../web/src/lib/consent");
    expect(consent.saveConsent(ON, "banner").persisted).toBe(true);
    writes = "ignored";
    vi.resetModules();
    const nextPage = await start();
    expect(nextPage.readConsent()).toBeNull();
    expect(nextPage.effectiveConsent()).toEqual(OFF);
    expect(tags()).toHaveLength(0);
  });

  it("unloads active tags after a failed withdrawal and keeps the next startup off", async () => {
    const consent = await start();
    click("Accept All");
    expect(consent.readConsent()).toMatchObject(ON);
    expect(tags()).toHaveLength(2);
    writes = "ignored";
    // A footer link uses the same settings dialog; reopen through a hash.
    browser.location = { protocol: "https:", hostname: "www.protectmyhoa.com", hash: "#privacy-choices", reload };
    const showModal = vi.mocked(HTMLDialogElement.prototype.showModal);
    const { startConsent } = await import("../../../web/src/lib/consent-banner");
    startConsent();
    expect(showModal).toHaveBeenCalled();
    click("Decline All");
    expect(consent.effectiveConsent()).toEqual(OFF);
    expect(reload).toHaveBeenCalledOnce();
    vi.resetModules();
    document.body.innerHTML = "";
    document.head.querySelectorAll("script").forEach((script) => script.remove());
    browser.location = { protocol: "https:", hostname: "www.protectmyhoa.com", hash: "", reload };
    await start();
    expect(tags()).toHaveLength(0);
    expect(document.body).toHaveTextContent("preferences could not be saved");
  });

  it("handles blocked cookie reads without enabling defaults", async () => {
    blockedReads = true;
    const consent = await start();
    expect(consent.effectiveConsent()).toEqual(OFF);
    expect(tags()).toHaveLength(0);
    expect(consent.saveConsent(ON, "settings")).toMatchObject({ state: OFF, persisted: false });
  });

  it("reports an unsuccessful save instead of returning an apparently stored opt-in", async () => {
    const consent = await import("../../../web/src/lib/consent");
    expect(consent.consentStorageAvailable()).toBe(true);
    writes = "ignored";
    expect(consent.saveConsent(ON, "settings")).toMatchObject({ state: OFF, persisted: false });
    expect(consent.effectiveConsent()).toEqual(OFF);
  });

  it("still honors GPC over an explicitly accepted marketing preference", async () => {
    Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    const consent = await start();
    click("Accept All");
    expect(consent.readConsent()).toMatchObject({ analytics: true, insights: true, marketing: false, gpc: true });
    expect((browser.dataLayer as IArguments[]).map((args) => [...args])).not.toContainEqual(["config", "AW-test"]);
  });

  it("preserves the Pacific-time marketing default when storage works", async () => {
    vi.mocked(Intl.DateTimeFormat.prototype.resolvedOptions).mockReturnValue({ timeZone: "America/Los_Angeles" } as Intl.ResolvedDateTimeFormatOptions);
    const consent = await start();
    expect(consent.effectiveConsent()).toEqual({ analytics: true, insights: false, marketing: false });
  });
});

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
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("BroadcastChannel", undefined);
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
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
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
    vi.clearAllTimers();
    vi.useRealTimers();
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
  const dispatchWindow = (type: string) => {
    const addListener = browser.addEventListener as ReturnType<typeof vi.fn>;
    for (const [name, callback] of addListener.mock.calls) {
      if (name === type) callback(new Event(type));
    }
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

  it("revokes active SDKs in a second page instance without reload or broadcast loops", async () => {
    const peers: TestChannel[] = [];
    const published: unknown[] = [];
    class TestChannel {
      owner = window;
      onmessage: ((event: MessageEvent) => void) | null = null;
      closed = false;
      constructor(public name: string) { peers.push(this); }
      close() { this.closed = true; }
      postMessage(data: unknown) {
        published.push(data);
        for (const peer of peers) {
          if (peer === this || peer.closed || peer.name !== this.name) continue;
          const sender = window;
          vi.stubGlobal("window", peer.owner);
          try { peer.onmessage?.(new MessageEvent("message", { data })); }
          finally { vi.stubGlobal("window", sender); }
        }
      }
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    const firstPage = await start();
    click("Accept All");
    expect(firstPage.readConsent()).toMatchObject(ON);
    const firstReload = reload;
    const firstBrowser = browser;

    // A separately evaluated page has its own tag state and channel but shares
    // the origin's cookie jar, just like a second open browser tab.
    vi.resetModules();
    reload = vi.fn();
    browser = {
      location: { protocol: "https:", hostname: "www.protectmyhoa.com", hash: "#privacy-choices", reload },
      addEventListener: vi.fn(),
    };
    vi.stubGlobal("window", browser);
    const secondPage = await start();
    expect(secondPage.readConsent()).toMatchObject(ON);
    expect(tags()).toHaveLength(4);

    click("Accept All");
    expect(firstReload).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    dispatchWindow("hashchange");
    click("Decline All");
    expect(firstReload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(secondPage.effectiveConsent()).toMatchObject(OFF);
    expect(published).toHaveLength(3); // two accepts, one decline; no replies

    peers[1].postMessage("changed");
    vi.advanceTimersByTime(10000);
    expect(firstReload).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();

    dispatchWindow("pagehide");
    browser = firstBrowser;
    vi.stubGlobal("window", browser);
    dispatchWindow("pagehide");
    expect(peers.every((peer) => peer.closed)).toBe(true);
    vi.resetModules();
    document.body.innerHTML = "";
    document.head.querySelectorAll("script").forEach((script) => script.remove());
    const reloadedPage = await start();
    expect(reloadedPage.effectiveConsent()).toMatchObject(OFF);
    expect(tags()).toHaveLength(0);
    expect(published).toHaveLength(4); // startup does not publish
    expect(firstReload).toHaveBeenCalledOnce();
  });

  it.each(["missing", "blocked", "posting-blocked"])("polls for withdrawals when BroadcastChannel is %s", async (mode) => {
    if (mode === "blocked") {
      vi.stubGlobal("BroadcastChannel", class { constructor() { throw new Error("Blocked"); } });
    }
    if (mode === "posting-blocked") {
      vi.stubGlobal("BroadcastChannel", class { postMessage() { throw new Error("Blocked"); } close() {} });
    }
    const consent = await start();
    click("Accept All");
    // Another page changed the shared cookie, but no channel notice arrives.
    consent.saveConsent({ analytics: true, insights: true, marketing: false }, "settings");
    vi.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(15000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["focus", "pageshow", "visibilitychange"])("rechecks withdrawals on %s after a page was suspended", async (event) => {
    const consent = await start();
    click("Accept All");
    consent.saveConsent(OFF, "settings");
    vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("hidden");
    // Suspended pages do not get timer callbacks; lifecycle events recheck as
    // soon as the browser resumes them instead of waiting for the next tick.
    expect(reload).not.toHaveBeenCalled();
    vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("visible");
    if (event === "visibilitychange") document.dispatchEvent(new Event(event));
    else dispatchWindow(event);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("rechecks storage access on focus instead of trusting an old opt-in", async () => {
    await start();
    click("Accept All");
    writes = "ignored";
    dispatchWindow("focus");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("also polls hidden pages when the browser allows their timers to run", async () => {
    const consent = await start();
    click("Accept All");
    vi.mocked(Object.getOwnPropertyDescriptor(document, "visibilityState")!.get!).mockReturnValue("hidden");
    consent.saveConsent(OFF, "settings");
    vi.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload or resend SDK consent updates for unchanged preferences", async () => {
    await start();
    click("Accept All");
    const commands = (browser.dataLayer as unknown[]).length;
    vi.advanceTimersByTime(15000);
    dispatchWindow("focus");
    expect(reload).not.toHaveBeenCalled();
    expect(browser.dataLayer).toHaveLength(commands);
  });

  it("shows preferences again when a saved choice disappears", async () => {
    const consent = await import("../../../web/src/lib/consent");
    consent.saveConsent(OFF, "banner");
    await start();
    expect(document.querySelector(".pmh-consent")).toBeNull();
    jar.clear();
    vi.advanceTimersByTime(5000);
    expect(document.querySelector(".pmh-consent")).not.toBeNull();
    expect(tags()).toHaveLength(1);
  });

  it("keeps failed-storage tracking off and its notice dismissed until an explicit save succeeds", async () => {
    writes = "ignored";
    const consent = await start();
    click("Decline All");
    click("Continue without optional tracking");
    writes = "allowed";
    vi.advanceTimersByTime(15000);
    expect(consent.effectiveConsent()).toEqual(OFF);
    expect(tags()).toHaveLength(0);
    expect(document.querySelector(".pmh-consent")).toBeNull();
    expect(consent.saveConsent(ON, "settings").persisted).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(tags()).toHaveLength(2);
  });
});

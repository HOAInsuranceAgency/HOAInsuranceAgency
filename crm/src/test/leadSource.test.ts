import { beforeEach, describe, expect, it } from "vitest";
import { acquisitionLabel, cleanAttribution, LEAD_SOURCES, websiteLeadSource } from "../../../shared/leadSource";
import { captureLeadAttribution } from "../../../web/src/lib/leadAttribution";
describe("lead acquisition", () => {
  beforeEach(() => { sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
  it("offers exactly the agreed channels without guessing historical website traffic", () => {
    expect(LEAD_SOURCES).toHaveLength(6);
    expect(acquisitionLabel(undefined, "website-ho6:elm")).toBe("Website · attribution not recorded");
  });
  it.each(["gclid", "gbraid", "wbraid"])("recognizes %s and preserves its case", key => {
    expect(websiteLeadSource({ [key]: "Click-ID-AbC" })).toBe("GOOGLE_AD_WEBSITE");
    expect(cleanAttribution({ [key]: "Click-ID-AbC" })[key as "gclid"]).toBe("Click-ID-AbC");
  });
  it.each([
    [{ utm_source: "Google", utm_medium: "CPC" }, "GOOGLE_AD_WEBSITE"],
    [{ utm_source: "google", utm_medium: "organic" }, "ORGANIC_WEBSITE"],
    [{ utm_source: "facebook", utm_medium: "paid_social" }, "META_AD"],
    [{ fbclid: "ordinary-share", utm_source: "facebook", utm_medium: "social" }, "ORGANIC_WEBSITE"],
    [{}, "ORGANIC_WEBSITE"],
  ])("classifies campaign %j as %s", (value, source) => expect(websiteLeadSource(value)).toBe(source));
  it("retains landing attribution through navigation and replaces it for a new tagged campaign", () => {
    window.history.replaceState(null, "", "/?gclid=AdClick&utm_campaign=fall&token=private");
    const landing = captureLeadAttribution();
    expect(landing).toEqual({ gclid: "AdClick", utm_campaign: "fall", landingPath: "/" });
    window.history.replaceState(null, "", "/quote"); expect(captureLeadAttribution()).toEqual(landing);
    window.history.replaceState(null, "", "/?utm_source=meta&utm_medium=paid_social");
    expect(websiteLeadSource(captureLeadAttribution())).toBe("META_AD");
    expect(captureLeadAttribution().gclid).toBeUndefined();
  });
  it("discards malformed attribution and unexpected/private fields", () => {
    expect(cleanAttribution("bad json")).toEqual({});
    expect(cleanAttribution({ gclid: "x".repeat(900), token: "private", referrer: "private" })).toEqual({ gclid: "x".repeat(500) });
  });
});

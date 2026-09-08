import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENCY, AGENCY_FMT } from "../../../shared/agency";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const STRUCTURE = read("../../../docs/WEBSITE-STRUCTURE.md");
const CONSTANTS = read("../../../web/src/constants.ts");

describe("release legal wording and revision dates", () => {
  it("identifies the legal entity as an independent agency, not a carrier", () => {
    const terms = read("../../../web/src/pages/terms-of-service.astro");
    expect(terms).toContain(
      `${AGENCY.name} is an independent insurance agency, not an insurance company or carrier.`
    );
    expect(terms).not.toContain("insurance agency/broker/producer");
  });

  it.each(["terms-of-service", "privacy-policy"])(
    "%s preserves its effective date and records the material revision",
    (page) => {
      const source = read(`../../../web/src/pages/${page}.astro`);
      expect(source).toContain(
        "Effective Date: January 1, 2026 | Last Updated: September 7, 2026"
      );
      expect(source).toContain('{EMAIL}');
      expect(source).not.toContain("{LEAD_EMAIL}");
    }
  );
});

describe("production website-lead recipient and operational documentation", () => {
  it("keeps production leads separate from general, service and ACORD email", () => {
    expect(AGENCY_FMT.leadEmailLower).toBe("sales@protectmyhoa.com");
    expect(AGENCY_FMT.emailLower).toBe("insurance@protectmyhoa.com");
    expect(AGENCY_FMT.leadEmailLower).not.toBe(AGENCY_FMT.emailLower);
    expect(AGENCY_FMT.formsubmitUrl).toBe(
      "https://formsubmit.co/ajax/sales@protectmyhoa.com"
    );
    expect(CONSTANTS).toMatch(
      /const NOTIFY_EMAIL = import\.meta\.env\.PUBLIC_LEAD_NOTIFY_EMAIL \|\| AGENCY\.leadEmail;/
    );
    expect(CONSTANTS).toContain(
      'export const FORMSUBMIT_URL = `https://formsubmit.co/ajax/${NOTIFY_EMAIL.toLowerCase()}`;'
    );
    expect(CONSTANTS).toContain("export const EMAIL = AGENCY.email;");
  });

  it("documents the same FormSubmit endpoint production code uses", () => {
    expect(STRUCTURE).toContain(AGENCY_FMT.formsubmitUrl);
    expect(STRUCTURE).not.toContain(
      `https://formsubmit.co/ajax/${AGENCY_FMT.emailLower}`
    );
    expect(STRUCTURE).toContain(
      "FormSubmit must be activated separately for every recipient"
    );
    expect(STRUCTURE).toContain(
      "Do not deploy production until `sales@protectmyhoa.com` is activated and tested by the user."
    );
  });

  it("keeps the closed guide-count note consistent with the homepage", () => {
    const homepage = read("../../../web/src/pages/index.astro");
    expect(homepage).toContain("const withGuides = reviewedStateSlugs;");
    expect(STRUCTURE).toContain("CLOSED — homepage guide count");
    expect(STRUCTURE).toContain("`withGuides = reviewedStateSlugs`");
    expect(STRUCTURE).not.toContain("The homepage state count renders wrong");
  });
});

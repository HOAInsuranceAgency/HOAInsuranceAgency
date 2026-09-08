import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AGENCY, AGENCY_FMT } from "../../../shared/agency";
import { ContactForm } from "../../../web/src/components/ContactForm";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const STRUCTURE = read("../../../docs/WEBSITE-STRUCTURE.md");
const CONSTANTS = read("../../../web/src/constants.ts");
type ContactFormProps = NonNullable<Parameters<typeof ContactForm>[0]>;
const renderContact = (props: ContactFormProps = {}) =>
  renderToStaticMarkup(createElement<ContactFormProps>(ContactForm, props));

describe("contact-page split integration", () => {
  it("preserves the full form and contact anchor for existing callers", () => {
    const html = renderContact();
    expect(html).toContain('id="contact"');
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html).toContain(AGENCY.name);
    expect(html).toContain("New business and quote requests");
  });

  it("renders a single form without duplicating the agency sidebar", () => {
    const html = renderContact({ part: "form" });
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html).not.toContain('id="contact"');
    expect(html).not.toContain('class="contact-info"');
  });

  it("keeps company identity and separate sales and claims mail in the static sidebar", () => {
    const html = renderContact({
      part: "info", showClaims: true,
    });
    expect(html).not.toContain("<form");
    expect(html).toContain(AGENCY.name);
    expect(html.toLowerCase()).toContain(`mailto:${AGENCY_FMT.leadEmailLower}`);
    expect(html.toLowerCase()).toContain(`mailto:${AGENCY_FMT.emailLower}?subject=`);
    expect(html).toContain("New business and quote requests");
    expect(html).toContain("Notifying us does not replace any notice your policy requires");
  });
});

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

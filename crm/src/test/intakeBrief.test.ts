import { describe, expect, it } from "vitest";
import { renderIntakeBrief, intakeReferenceFromHtml, type IntakeBriefInput } from "../../amplify/functions/lead-intake/brief";

const base: IntakeBriefInput = { snapshot: {}, accountId: "account-1", accountName: "Elm Condominium", submissionId: "submission-1", receivedAt: "2026-09-10T02:40:45.788Z", environment: "staging", crmBaseUrl: "https://staging.example.com" };
const render = (snapshot: Record<string, unknown>, overrides: Partial<IntakeBriefInput> = {}) => renderIntakeBrief({ ...base, snapshot, ...overrides });
const bodyText = (html: string) => { const doc = new DOMParser().parseFromString(html, "text/html"); return doc.body.textContent!; };

describe("agent intake brief", () => {
  it("makes an HO-6 form readable without technical fields, duplicates, or a UTC timestamp", () => {
    const { html } = render({ type: "PERSONAL", contactFirstName: "Jane", contactLastName: "Smith", contactEmail: "jane@example.com", contactPhone: "6178959530", address: "114 Elm Street", city: "Worcester", state: "MA", zip: "01609", unitNumber: "4B", currentCarrier: "Example Mutual", source: "website-ho6:elm", notes: "Association: Elm Condominium\nPlease call after 3.\nMy renewal is coming up.", answers: { "Building / Association": "Elm Condominium", "Building Address": "114 Elm Street, Worcester, MA, 01609", "First Name": "Jane", "Last Name": "Smith", Email: "jane@example.com", Phone: "6178959530", "Unit Number": "4B", "Current HO-6 Carrier": "Example Mutual", Notes: "Please call after 3.\nMy renewal is coming up.", "Buildium ID": "123935", _captcha: "false", _template: "table", _replyto: "jane@example.com", "Lead Type": "HO-6 Unit Owner" } });
    const text = bodyText(html);
    for (const value of ["HO-6 quote request", "Jane Smith", "(617) 895-9530", "Worcester, MA 01609", "Example Mutual", "Sep 9, 2026", "10:40 PM EDT", "STAGING TEST"]) expect(text).toContain(value);
    for (const value of ["Buildium", "123935", "_captcha", "_template", "_replyto", "submission-1", "null", "2026-09-10T"]) expect(text).not.toContain(value);
    expect(text.match(/Elm Condominium/g)).toHaveLength(1);
    expect(text.match(/Example Mutual/g)).toHaveLength(1);
    expect(html).toContain("Please call after 3.<br>My renewal is coming up.");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector('a[href^="mailto:"]')?.getAttribute("href")).toBe("mailto:jane@example.com");
    expect(doc.querySelector('a[href^="tel:"]')?.textContent).toBe("(617) 895-9530");
    expect(intakeReferenceFromHtml(html, base.crmBaseUrl)).toBe(base.submissionId);
  });

  it("preserves the quote wizard's coverage, role, agent, renewal, and second address line", () => {
    const { html } = render({ contactFirstName: "Jane", address: "181 Ruggles Street, Suite 2", city: "Westborough", state: "MA", zip: "01581", unitCount: 33, currentCarrier: "Example Mutual", currentPolicyExpiration: "2027-01-01", source: "website-quote", notes: "Role: Board Member / Trustee\nAssigned agent: Brian Cole\nLines to review: General Liability, Crime / Fidelity", answers: { Association: "Willow HOA", Role: "Board Member / Trustee", "Website Agent": "Brian Cole", "Property Address": "181 Ruggles Street", "Address Line 2": "Suite 2", "Unit Count": "33", "Current Carriers": "Example Mutual", "Program Expiry": "2027-01-01", "Lines to Review": "General Liability, Crime / Fidelity" } }, { environment: "main" });
    const text = bodyText(html);
    for (const value of ["Willow HOA", "33 units", "Jan 1, 2027", "General Liability, Crime / Fidelity", "Board Member / Trustee", "Brian Cole"]) expect(text).toContain(value);
    expect(text.match(/Suite 2/g)).toHaveLength(1);
    expect(text.match(/General Liability, Crime \/ Fidelity/g)).toHaveLength(1);
    expect(text).not.toContain("STAGING TEST"); expect(text).not.toContain("Submission notes");
  });

  it.each([
    ["website-assessment:Generic", "Insurance assessment", { "Unit Count": 12, Source: "Instant Assessment — Generic" }, "12 units"],
    ["website-contact", "Website enquiry", { Message: "Please review our renewal.\nCall tomorrow." }, "Please review our renewal."],
    ["website-coverage-calculator", "Coverage calculator enquiry", { "Coverages Shown": "Property (essential), D&O (recommended)" }, "D&O (recommended)"],
  ])("supports %s without irrelevant empty sections", (source, title, answers, detail) => {
    const { html } = render({ source, answers });
    expect(bodyText(html)).toContain(title); expect(bodyText(html)).toContain(detail);
    expect(bodyText(html)).not.toContain("Current carrier");
  });

  it("retains additional human answers, false and zero, without dumping nested JSON", () => {
    const { html } = render({ answers: { "Prior claims": false, "Claim count": 0, "Requested documents": ["Loss runs", "Dec page"], "Building details": { yearBuilt: 1985, sprinklered: true, _internal: "hidden" }, "Unit Count": "—" } });
    const text = bodyText(html);
    for (const value of ["Prior claims", "No", "Claim count", "0", "Loss runs", "Dec page", "Year Built: 1985", "Sprinklered: Yes"]) expect(text).toContain(value);
    expect(text).not.toContain("hidden"); expect(text).not.toContain("Association size");
  });

  it("escapes every submitted value and only creates safe links", () => {
    const attack = '<img src=x onerror="alert(1)">';
    const { html } = render({ contactFirstName: attack, contactEmail: 'bad@example.com?body=evil', contactPhone: attack, notes: attack, answers: { [attack]: attack } }, { accountName: attack, crmBaseUrl: "javascript:alert(1)" });
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelectorAll("img, script, [onerror]")).toHaveLength(0);
    expect(doc.querySelectorAll("a")).toHaveLength(0);
    expect(doc.body.textContent).toContain(attack);
    expect(html).not.toContain("javascript:");
  });

  it("keeps international numbers and extensions intact", () => {
    for (const phone of ["+44 20 7946 0958", "617-895-9530 ext. 12"]) expect(bodyText(render({ contactPhone: phone }).html)).toContain(phone);
    expect(bodyText(render({ contactPhone: "+16178959530" }).html)).toContain("(617) 895-9530");
  });

  it("only reads correlation hints from the configured CRM account links", () => {
    expect(intakeReferenceFromHtml('<a href="https://elsewhere.example.com/accounts/a?submission=evil">Open</a>', base.crmBaseUrl)).toBeUndefined();
    expect(intakeReferenceFromHtml('<a href="https://staging.example.com/other?submission=evil">Open</a>', base.crmBaseUrl)).toBeUndefined();
  });
});

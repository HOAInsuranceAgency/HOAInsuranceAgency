import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const suggestFormFields = vi.hoisted(() => vi.fn());
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: {}, mutations: { suggestFormFields } }),
}));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser: vi.fn() }));

import { applySuggestions, emptyTextFields } from "./acordPdf";
import { aiFillGaps } from "./aiFill";

/**
 * The browser's half of W8's gap-fill.
 *
 * The Lambda's gate is covered by `formFiller.test.ts`; this covers the gate
 * that has the PDF in front of it — what the deterministic pass already
 * answered, and what the template will physically accept — plus the rule that
 * no failure of the AI may cost the agency a correctly filled form.
 */

/** A one-page form with three text fields, one of them length-limited. */
async function makeForm() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 400]);
  const form = pdf.getForm();
  for (const [i, name] of ["Blank_A", "Filled_A", "Short_A"].entries()) {
    const field = form.createTextField(name);
    field.addToPage(page, { x: 20, y: 350 - i * 40, width: 300, height: 20 });
    if (name === "Short_A") field.setMaxLength(5);
  }
  form.getTextField("Filled_A").setText("Maple Ridge Condominium Association");
  return pdf;
}

describe("emptyTextFields", () => {
  it("reports only the blanks, with the length the template allows", async () => {
    const empty = await makeForm().then(emptyTextFields);
    // Filled_A is absent, and that is the mechanism rather than a convention:
    // a field the mapping answered is never offered to the model, so nothing
    // downstream can be handed it.
    expect(empty).toEqual([
      { name: "Blank_A" },
      { name: "Short_A", maxLength: 5 },
    ]);
  });
});

describe("applySuggestions", () => {
  it("writes a value into a blank field", async () => {
    const pdf = await makeForm();
    const { applied, rejected } = await applySuggestions(pdf, [
      { field: "Blank_A", value: "1985" },
    ]);
    expect(applied).toEqual(["Blank_A"]);
    expect(rejected).toEqual([]);
    expect(pdf.getForm().getTextField("Blank_A").getText()).toBe("1985");
  });

  it("refuses to overwrite what the mapping wrote", async () => {
    // Re-checked rather than trusted: the list of blanks was taken before a
    // network round trip, and a deterministic value must never lose to a
    // suggested one.
    const pdf = await makeForm();
    const { applied, rejected } = await applySuggestions(pdf, [
      { field: "Filled_A", value: "Maple Ridge HOA" },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toEqual([{ field: "Filled_A", reason: "already-filled" }]);
    expect(pdf.getForm().getTextField("Filled_A").getText()).toBe(
      "Maple Ridge Condominium Association"
    );
  });

  it("drops a value too long for the field rather than truncating it", async () => {
    // Truncating would put half a legal name on a carrier form and look
    // deliberate. Nothing is better than something wrong.
    //
    // The reason is asserted, not just the rejection: pdf-lib throws on an
    // over-long setText too, so a test that only checked "it didn't land"
    // would pass with the length check deleted — and the producer would then
    // be told the template has no such field.
    const pdf = await makeForm();
    const { applied, rejected } = await applySuggestions(pdf, [
      { field: "Short_A", value: "far too long" },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toEqual([{ field: "Short_A", reason: "too-long" }]);
    expect(pdf.getForm().getTextField("Short_A").getText()).toBeUndefined();
  });

  it("reports a field the template does not have instead of throwing", async () => {
    const pdf = await makeForm();
    const { applied, rejected } = await applySuggestions(pdf, [
      { field: "Nope_A", value: "x" },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toEqual([{ field: "Nope_A", reason: "no-such-field" }]);
  });
});

describe("aiFillGaps", () => {
  // mockClear, not mockReset: under vitest 4 a mockReset followed by an
  // async-throwing mockImplementation reports the rejection as an unhandled
  // test error even where the caller catches it. Each test sets its own
  // implementation, so there is nothing stale to reset away.
  beforeEach(() => {
    suggestFormFields.mockClear();
  });

  it("applies what survives and returns it for the review list", async () => {
    const pdf = await makeForm();
    suggestFormFields.mockImplementation(async () => ({
      data: JSON.stringify({
        ok: true,
        values: [
          { field: "Blank_A", value: "1985", why: "Building 1 yearBuilt" },
          { field: "Short_A", value: "far too long", why: "account.name" },
        ],
      }),
      errors: null,
    }));

    const res = await aiFillGaps(pdf, new Uint8Array(), emptyTextFields(pdf), "a1", "acord125");

    // The over-long one is on the page nowhere, so it is not in the list a
    // producer is asked to check — showing a value that was silently dropped
    // would send them looking for it.
    expect(res.applied).toEqual([
      { field: "Blank_A", value: "1985", why: "Building 1 yearBuilt" },
    ]);
    expect(res.note).toMatch(/1 suggested value was discarded: 1 too long for the field\./);
    expect(pdf.getForm().getTextField("Blank_A").getText()).toBe("1985");
  });

  it("keeps the deterministic bytes when the mutation fails", async () => {
    // A model outage may cost the gap-fill. It may never cost the agency a
    // correctly filled deterministic form.
    const pdf = await makeForm();
    const original = new Uint8Array([1, 2, 3]);
    suggestFormFields.mockImplementation(async () => {
      throw new Error("network down");
    });

    const res = await aiFillGaps(pdf, original, emptyTextFields(pdf), "a1", "acord25");
    expect(res.bytes).toBe(original);
    expect(res.applied).toEqual([]);
    expect(res.note).toMatch(/network down/);
  });

  it("says so when the handler reports its own failure", async () => {
    const pdf = await makeForm();
    const original = new Uint8Array([1]);
    suggestFormFields.mockImplementation(async () => ({
      data: { ok: false, error: "The model declined to complete this form." },
      errors: null,
    }));

    const res = await aiFillGaps(pdf, original, emptyTextFields(pdf), "a1", "acord25");
    expect(res.bytes).toBe(original);
    expect(res.note).toMatch(/declined/);
  });

  it("does not call the model when the form came out full", async () => {
    const pdf = await makeForm();
    const res = await aiFillGaps(pdf, new Uint8Array([9]), [], "a1", "acord25");
    expect(suggestFormFields).not.toHaveBeenCalled();
    expect(res.applied).toEqual([]);
  });
});

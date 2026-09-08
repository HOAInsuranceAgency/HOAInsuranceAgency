import { beforeEach, describe, expect, it, vi } from "vitest";
import { fillAcord25 } from "./acord25";
import { fillAcordApp } from "./acordApp";
import { fillTemplate, type FieldValues } from "./acordPdf";
import { ACORD25_TEMPLATE_PATH, ACORD_FORMS } from "./acordRegistry";
import type { Account, Certificate } from "./client";

// Inspect the generated field values without loading or writing a PDF.
vi.mock("./acordPdf", () => ({ fillTemplate: vi.fn() }));

const account = {
  id: "account-1",
  name: "Example Condominium Association",
  stage: "LEAD",
  type: "ASSOCIATION",
} as Account;

const certificate = {
  id: "certificate-1",
  accountId: account.id,
  account: vi.fn<Certificate["account"]>(),
  holderName: "Example Certificate Holder",
  policyIds: [],
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:00Z",
} satisfies Certificate;

function expectCompanyContact(values: FieldValues, addressField: string) {
  expect(values.producer.value).toBe("HOA Insurance Agency LLC");
  expect(values.producerContact.value).toBe("HOA Insurance Agency LLC");
  expect(`${values.producer.value} ${values.producerContact.value}`).not.toMatch(
    /\b(?:Jake|Jacob|Brian)\b/i,
  );
  expect(values[addressField].value).toBe("420 Lakeside Ave, Suite 202");
  expect(values.producerCity.value).toBe("Marlborough");
  expect(values.producerState.value).toBe("MA");
  expect(values.producerZip.value).toBe("01752");
  expect(values.producerPhone.value).toBe("508-233-2261");
  expect(values.producerEmail.value).toBe("insurance@ProtectMyHOA.com");
}

describe("ACORD agency contact identity", () => {
  beforeEach(() => {
    vi.mocked(fillTemplate).mockClear();
  });

  it("uses the company in the certificate producer and contact fields", async () => {
    await fillAcord25(account, certificate, [], []);

    expect(fillTemplate).toHaveBeenCalledTimes(1);
    const [path, values] = vi.mocked(fillTemplate).mock.calls[0];
    expect(path).toBe(ACORD25_TEMPLATE_PATH);
    expectCompanyContact(values, "producerAddress1");
  });

  it.each(ACORD_FORMS.filter((form) => form.key !== "acord25"))(
    "uses the company in the $key producer and contact fields",
    async (form) => {
      await fillAcordApp(form, account, [], [], [], [], [], null, []);

      expect(fillTemplate).toHaveBeenCalledTimes(1);
      const [path, values] = vi.mocked(fillTemplate).mock.calls[0];
      expect(path).toBe(form.path);
      expectCompanyContact(values, "producerAddr1");
    },
  );
});

import { describe, expect, it } from "vitest";
import {
  getFlow,
  STEPS,
  validateText,
  type FormData,
} from "../../../web/src/components/quote/schema";
import {
  buildCrmLead,
} from "../../../web/src/components/quote/submission";

function contactPhoneField() {
  const contact = STEPS.contact;
  if (contact.type !== "group") throw new Error("Expected a grouped contact step");
  const phone = contact.fields.find((field) => field.field === "contactPhone");
  if (!phone) throw new Error("Contact step must include a phone field");
  return phone;
}

describe.each(["board", "manager", "owner"])("%s quote contact step", (role) => {
  it("uses the shared required phone field before submission", () => {
    const flow = getFlow(role);
    expect(flow.filter((step) => step === "contact")).toHaveLength(1);
    expect(flow.slice(-2)).toEqual(["contact", "submitted"]);

    const phone = contactPhoneField();
    expect(phone.kind).toBe("text");
    expect(phone.inputType).toBe("tel");
    expect(phone.validation).toBe("phone");
    expect(phone.optional).not.toBe(true);
  });

  it.each(["", "   ", "\t\n"])("rejects a missing phone number: %j", (value) => {
    const phone = contactPhoneField();
    expect(validateText(value, phone.validation, !!phone.optional)).toBe(
      "Please enter a value to continue."
    );
  });

  it.each(["555-1234", "508555123", "not a phone number"])(
    "rejects an invalid phone number: %j",
    (value) => {
      const phone = contactPhoneField();
      expect(validateText(value, phone.validation, !!phone.optional)).toBe(
        "Please enter a valid phone number."
      );
    }
  );

  it.each(["5085551234", "(508) 555-1234", "+1 (508) 555-1234"])(
    "accepts and retains a valid phone number: %j",
    async (contactPhone) => {
      const phone = contactPhoneField();
      expect(validateText(contactPhone, phone.validation, !!phone.optional)).toBeNull();

      const data: FormData = {
        role,
        associationName: "Example Condominium Association",
        contactName: "Taylor Example",
        contactEmail: "taylor@example.com",
        contactPhone,
      };
      expect(buildCrmLead(data).contactPhone).toBe(contactPhone);

      const snapshot = JSON.parse(buildCrmLead(data).answerSnapshot!);
      expect(snapshot.Phone).toBe(contactPhone);
      expect(snapshot["Full Name"]).toBe("Taylor Example");

    }
  );
});

it("submits the prospect's details without claiming the website greeter is their assigned agent", () => {
  const lead = buildCrmLead({
    role: "board",
    associationName: "Trumbull Village",
    contactName: "Patrick Meres",
    contactEmail: "prospect@example.com",
    coverageNeeds: ["master_property", "general_liability"],
  });
  const snapshot = JSON.parse(lead.answerSnapshot!);

  expect(lead).toMatchObject({
    name: "Trumbull Village",
    contactFirstName: "Patrick",
    contactLastName: "Meres",
    contactEmail: "prospect@example.com",
    notes: "Role: Board Member / Trustee\nLines to review: Commercial Property, General Liability",
  });
  expect(snapshot).toMatchObject({
    "Full Name": "Patrick Meres",
    Association: "Trumbull Village",
    "Lines to Review": "Commercial Property, General Liability",
  });
  expect(snapshot).not.toHaveProperty("Website Agent");
  expect(JSON.stringify(lead)).not.toMatch(/Assigned agent|Brian Cole/);
});

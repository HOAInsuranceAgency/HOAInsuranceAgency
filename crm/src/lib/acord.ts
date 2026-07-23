import { PDFDocument, PDFTextField, PDFCheckBox } from "pdf-lib";
import { getUrl } from "aws-amplify/storage";
import { AGENCY } from "./agency";
import type { Account, Carrier, Certificate, Policy } from "./client";

/**
 * Mapping-driven ACORD form autofill.
 *
 * ACORD fillable PDFs are licensed, so templates are uploaded by the agency
 * to S3 (templates/acord25.pdf) via Settings. Field names vary between form
 * editions, so every logical value maps to a list of CANDIDATE field names —
 * the first one present in the template wins, everything else is skipped and
 * reported. Use the field inspector on the Settings page to see a template's
 * real names and extend the candidate lists below as needed.
 *
 * Adding another ACORD form later = new template path + new mapping object.
 */

export const ACORD25_TEMPLATE_PATH = "templates/acord25.pdf";

type FieldValues = Record<string, { candidates: string[]; value: string }>;

export interface FillResult {
  bytes: Uint8Array;
  filled: string[]; // logical fields written
  missing: string[]; // logical fields with no matching PDF field
}

const fmtUs = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-US") : "";

/** Candidate names cover the ACORD 25 (2016/03) eForm and common older editions. */
function buildAcord25Values(
  account: Account,
  cert: Certificate,
  policies: Policy[],
  carriers: Carrier[]
): FieldValues {
  const values: FieldValues = {
    date: {
      candidates: ["Form_CompletionDate_A", "DATE", "Date"],
      value: new Date().toLocaleDateString("en-US"),
    },

    // ── Producer (agency) block ──
    producer: {
      candidates: ["Producer_FullName_A", "PRODUCER", "Producer"],
      value: `${AGENCY.name}\n${AGENCY.addressLine1}\n${AGENCY.city}, ${AGENCY.state} ${AGENCY.zip}`,
    },
    producerContact: {
      candidates: ["Producer_ContactPerson_FullName_A", "CONTACT NAME:"],
      value: AGENCY.name,
    },
    producerPhone: {
      candidates: [
        "Producer_ContactPerson_PhoneNumber_A",
        "PHONE (A/C, No, Ext):",
      ],
      value: AGENCY.phone,
    },
    producerEmail: {
      candidates: ["Producer_ContactPerson_EmailAddress_A", "E-MAIL ADDRESS:"],
      value: AGENCY.email,
    },

    // ── Insured block ──
    insured: {
      candidates: ["NamedInsured_FullName_A", "INSURED", "Insured"],
      value: [
        account.name,
        account.address,
        [account.city, account.state].filter(Boolean).join(", ") +
          (account.zip ? ` ${account.zip}` : ""),
      ]
        .filter(Boolean)
        .join("\n"),
    },

    // ── Certificate holder ──
    holder: {
      candidates: [
        "CertificateHolder_FullName_A",
        "CERTIFICATE HOLDER",
        "CertificateHolder",
      ],
      value: [cert.holderName, cert.holderAddress].filter(Boolean).join("\n"),
    },

    // ── Description of operations ──
    description: {
      candidates: [
        "OperationsDescription_A",
        "DescriptionOfOperations_A",
        "DESCRIPTION OF OPERATIONS / LOCATIONS / VEHICLES",
      ],
      value: cert.descriptionOfOperations ?? "",
    },
  };

  // ── Insurer letters A–F with NAIC codes ──
  const certPolicies = policies.filter((p) => (cert.policyIds ?? []).includes(p.id));
  const carrierIds = [...new Set(certPolicies.map((p) => p.carrierId).filter(Boolean))];
  const letters = ["A", "B", "C", "D", "E", "F"];
  carrierIds.slice(0, 6).forEach((cid, i) => {
    const carrier = carriers.find((c) => c.id === cid);
    if (!carrier) return;
    values[`insurer${letters[i]}`] = {
      candidates: [
        `Insurer_FullName_${letters[i]}`,
        `INSURER ${letters[i]} :`,
        `InsurerLetter${letters[i]}`,
      ],
      value: carrier.name,
    };
    if (carrier.naicCode) {
      values[`insurer${letters[i]}Naic`] = {
        candidates: [`Insurer_NAICCode_${letters[i]}`, `NAIC ${letters[i]}`],
        value: carrier.naicCode,
      };
    }
  });

  // ── Coverage rows (policy number / effective / expiration) ──
  const rowFor = (needle: string) =>
    certPolicies.find((p) =>
      (p.lines ?? []).some((l) => l?.toLowerCase().includes(needle))
    );

  const gl = rowFor("liability");
  if (gl) {
    values.glPolicyNumber = {
      candidates: ["GeneralLiability_PolicyNumberIdentifier_A"],
      value: gl.policyNumber ?? "",
    };
    values.glEffective = {
      candidates: ["GeneralLiability_PolicyEffectiveDate_A"],
      value: fmtUs(gl.effectiveDate),
    };
    values.glExpiration = {
      candidates: ["GeneralLiability_PolicyExpirationDate_A"],
      value: fmtUs(gl.expirationDate),
    };
  }

  const umbrella = rowFor("umbrella");
  if (umbrella) {
    values.umbPolicyNumber = {
      candidates: [
        "ExcessUmbrella_PolicyNumberIdentifier_A",
        "Umbrella_PolicyNumberIdentifier_A",
      ],
      value: umbrella.policyNumber ?? "",
    };
    values.umbEffective = {
      candidates: [
        "ExcessUmbrella_PolicyEffectiveDate_A",
        "Umbrella_PolicyEffectiveDate_A",
      ],
      value: fmtUs(umbrella.effectiveDate),
    };
    values.umbExpiration = {
      candidates: [
        "ExcessUmbrella_PolicyExpirationDate_A",
        "Umbrella_PolicyExpirationDate_A",
      ],
      value: fmtUs(umbrella.expirationDate),
    };
  }

  // Property / other lines go in the OTHER row.
  const other = certPolicies.find((p) => p !== gl && p !== umbrella);
  if (other) {
    values.otherPolicyDescription = {
      candidates: ["OtherPolicy_PolicyDescription_A", "OtherPolicy_CoverageDescription_A"],
      value: (other.lines ?? []).filter(Boolean).join(", "),
    };
    values.otherPolicyNumber = {
      candidates: ["OtherPolicy_PolicyNumberIdentifier_A"],
      value: other.policyNumber ?? "",
    };
    values.otherEffective = {
      candidates: ["OtherPolicy_PolicyEffectiveDate_A"],
      value: fmtUs(other.effectiveDate),
    };
    values.otherExpiration = {
      candidates: ["OtherPolicy_PolicyExpirationDate_A"],
      value: fmtUs(other.expirationDate),
    };
  }

  return values;
}

async function fetchTemplate(path: string): Promise<ArrayBuffer> {
  const { url } = await getUrl({ path });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Template fetch failed (${res.status})`);
  return res.arrayBuffer();
}

/** List every form field in a template PDF — the Settings-page inspector. */
export async function listTemplateFields(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await fetchTemplate(path), {
    ignoreEncryption: true,
  });
  return pdf
    .getForm()
    .getFields()
    .map((f) => `${f.getName()}  (${f.constructor.name.replace("PDF", "")})`);
}

export async function fillAcord25(
  account: Account,
  cert: Certificate,
  policies: Policy[],
  carriers: Carrier[]
): Promise<FillResult> {
  const pdf = await PDFDocument.load(await fetchTemplate(ACORD25_TEMPLATE_PATH), {
    ignoreEncryption: true,
  });
  const form = pdf.getForm();
  const fieldNames = new Set(form.getFields().map((f) => f.getName()));

  const values = buildAcord25Values(account, cert, policies, carriers);
  const filled: string[] = [];
  const missing: string[] = [];

  for (const [logical, { candidates, value }] of Object.entries(values)) {
    if (!value) continue;
    const name = candidates.find((c) => fieldNames.has(c));
    if (!name) {
      missing.push(logical);
      continue;
    }
    const field = form.getField(name);
    if (field instanceof PDFTextField) {
      field.setText(value);
      filled.push(logical);
    } else if (field instanceof PDFCheckBox) {
      field.check();
      filled.push(logical);
    }
  }

  // Deliberately NOT flattened — the PDF stays editable for manual touch-ups.
  const bytes = await pdf.save();
  return { bytes, filled, missing };
}

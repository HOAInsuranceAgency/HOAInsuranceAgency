import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";

const m = vi.hoisted(() => ({ loan: vi.fn(), upload: vi.fn(), create: vi.fn(), document: vi.fn(), write: vi.fn() }));
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));
vi.mock("@aws-amplify/backend/function/runtime", () => ({
  getAmplifyDataClientConfig: async () => ({ resourceConfig: {}, libraryOptions: {} }),
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {
  PfLoan: { get: m.loan },
  AgencySettings: { get: async () => ({ data: { premiumFinanceEnabled: true } }) },
  Account: { get: async () => ({ data: { name: "Test Association" } }) },
  Quote: { get: async () => ({ data: null }) },
  Document: { create: m.create, get: m.document },
} }) }));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-s3")>(),
  S3Client: class { send = m.upload; },
}));
vi.mock("@aws-sdk/lib-dynamodb", async (original) => ({
  ...await original<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: m.write }) },
}));
import { handler as generate } from "../../amplify/functions/pf-agreement/handler";
import { handler as service } from "../../amplify/functions/pf-servicing/handler";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DOCUMENTS_BUCKET = "test-bucket";
  m.loan.mockResolvedValue({ data: {
    id: "loan-1", accountId: "account-1", quoteId: "quote-1", status: "QUOTED",
    premium: 10000, downPayment: 2500, amountFinanced: 7500,
    totalInterest: 87.5, apr: 14, months: 1, payment: 7587.5, originationFee: 10,
    effectiveDate: "2026-09-10", agreementSignedName: "Alex Signer", agreementSignedRole: "Treasurer",
    agreementSignedAt: "2026-09-10T12:00:00Z",
    schedule: JSON.stringify([{ n: 1, dueDate: "2026-10-10", payment: 7587.5, interest: 87.5, principal: 7500, balance: 0 }]),
  } });
  m.upload.mockResolvedValue({});
  m.create.mockResolvedValue({ data: { id: "agreement-1" } });
});

describe("one financing agreement", () => {
  it("renders and files only the financing agreement", async () => {
    expect(await generate({ arguments: { loanId: "loan-1" } })).toEqual({ ok: true, documentIds: ["agreement-1"] });
    expect(m.upload).toHaveBeenCalledTimes(1);
    expect(m.upload.mock.calls[0][0].input.Key).toBe("generated/pf/loan-1/premium-finance-agreement.pdf");
    expect(m.upload.mock.calls[0][0].input.Body.length).toBeGreaterThan(1000);
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ category: "PF_AGREEMENT", entityId: "account-1" }));
  });

  it("files a single grouped agreement with the four frozen policy identifications", async () => {
    const { data } = await m.loan();
    const policyLabels = ["Harbor POL-1", "Harbor POL-2", "Harbor POL-3", "Travelers POL-4"];
    m.loan.mockResolvedValue({ data: { ...data, quoteId: null, groupedInvoiceId: "group-1",
      groupedPolicyIds: ["p1", "p2", "p3", "p4"], groupedPolicyAgreementLines: policyLabels } });
    expect(await generate({ arguments: { loanId: "loan-1" } })).toEqual({ ok: true, documentIds: ["agreement-1"] });
    expect(m.upload).toHaveBeenCalledTimes(1);
    const pdf = await PDFDocument.load(m.upload.mock.calls[0][0].input.Body);
    const contents = pdf.getPages().flatMap(page => {
      const streams = page.node.Contents();
      return streams instanceof PDFArray ? streams.asArray() : [streams];
    }).map(ref => {
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) throw new Error("Missing agreement content stream");
      return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")
        .replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, hex: string) => Buffer.from(hex, "hex").toString("latin1"));
    }).join("\n");
    for (const policy of policyLabels) expect(contents).toContain(`POLICY: ${policy}`);
    expect(contents).not.toContain("(to be assigned)");
    expect(m.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ category: "PF_AGREEMENT", entityId: "account-1" }));
    expect(m.create.mock.calls[0][0]).not.toHaveProperty("policyId");
  });

  it("never asks an older client for a resolution or manually activates a loan", async () => {
    const result = await service({ arguments: { loanId: "loan-1", action: "ACTIVATE" } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("automatically") });
    expect(m.document).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
  });
});

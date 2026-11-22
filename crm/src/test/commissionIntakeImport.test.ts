import { expect, it, vi } from "vitest";
import {
  exactPolicyMatches,
  prepareIntakeRows,
  reuseImportMapping,
  rowIssues,
} from "../../../shared/commissionIntake";
import { commissionPolicy } from "./commissionFixtures";
const h = vi.hoisted(() => ({ send: vi.fn(), commit: vi.fn() }));
vi.mock("@aws-sdk/client-textract", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-textract")>()),
  TextractClient: class {
    send = h.send;
  },
}));
vi.mock("../../amplify/functions/commissions/store", () => ({
  commit: h.commit,
}));
import {
  statementTables,
  extractIntakeDocument,
} from "../../amplify/functions/commissions/intake-extraction";
import type { StatementIntake } from "../../../shared/commissionIntake";
it("keeps ambiguous terms unresolved and preserves malformed source rows for correction", () => {
  const p = commissionPolicy();
  expect(
    exactPolicyMatches({ policyNumber: "pol-1", effectiveDate: "" }, "c", [
      p,
      { ...p, id: "renewal", effectiveDate: "2027-01-01" },
    ]),
  ).toHaveLength(2);
  const rows = prepareIntakeRows(
    [
      ["Policy", "Reference", "Paid"],
      ["POL-1", "A", "$100.00"],
      ["POL-1", "B", "unreadable"],
    ],
    { policy: 0, reference: 1, amount: 2, effective: -1, transaction: -1 },
    "inbox",
    0,
    [p],
    "c",
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    policyId: "p",
    reviewStatus: "PENDING",
    agencyCents: 10000,
  });
  expect(rows[1].agencyCents).toBeUndefined();
  expect(rows[1].raw).toContain("unreadable");
  expect(rows[1].importIssue).toBeTruthy();
  expect(rowIssues({ ...rows[0], policyNumber: "OTHER" }, "c", [p])).toContain(
    "Explain the source policy number difference",
  );
});
it("reuses headings after column reorder and refuses ambiguous headings", () => {
  const t = {
    id: "c",
    version: 1,
    carrierId: "c",
    headers: ["Policy", "Reference", "Paid"],
    mapping: {
      policy: 0,
      reference: 1,
      amount: 2,
      effective: -1,
      transaction: -1,
    },
  };
  expect(reuseImportMapping(["Paid", "Policy", "Reference"], t)).toMatchObject({
    policy: 1,
    reference: 2,
    amount: 0,
  });
  expect(reuseImportMapping(["Policy", "Policy", "Paid"], t).policy).toBe(-1);
});
it("supports 1,000 source rows and does not silently truncate a larger table", () => {
  const t = [
    ["Policy", "Reference", "Paid"],
    ...Array.from({ length: 1000 }, (_, i) => ["POL-1", "T" + i, "1.00"]),
  ];
  const mapping = {
    policy: 0,
    reference: 1,
    amount: 2,
    effective: -1,
    transaction: -1,
  };
  expect(
    prepareIntakeRows(t, mapping, "inbox", 0, [commissionPolicy()], "c"),
  ).toHaveLength(1000);
  expect(() =>
    prepareIntakeRows(
      [...t, ["POL-1", "extra", "1.00"]],
      mapping,
      "inbox",
      0,
      [],
      "c",
    ),
  ).toThrow("1,000");
});
it("reassembles table cells and words across OCR pagination", () => {
  const result = statementTables([
    {
      Id: "t",
      BlockType: "TABLE",
      Page: 1,
      Relationships: [{ Type: "CHILD", Ids: ["c1", "c2"] }],
    },
    {
      Id: "c1",
      BlockType: "CELL",
      RowIndex: 1,
      ColumnIndex: 1,
      Confidence: 99,
      Relationships: [{ Type: "CHILD", Ids: ["w1"] }],
    },
    {
      Id: "c2",
      BlockType: "CELL",
      RowIndex: 2,
      ColumnIndex: 1,
      Confidence: 97,
      Relationships: [{ Type: "CHILD", Ids: ["w2"] }],
    },
    { Id: "w1", BlockType: "WORD", Text: "Paid" },
    { Id: "w2", BlockType: "WORD", Text: "$100.00" },
  ]);
  expect(result.tables[0]).toMatchObject({
    rows: [["Paid"], ["$100.00"]],
    confidence: 97,
  });
});
it("rejects partial OCR and repeated pagination without importing incomplete amounts", async () => {
  const intake = {
    id: "x",
    filename: "test.pdf",
    extractionJobId: "job",
  } as StatementIntake;
  h.send.mockResolvedValue({ JobStatus: "PARTIAL_SUCCESS", Blocks: [] });
  await expect(extractIntakeDocument(intake, "owner", {})).rejects.toThrow(
    "all pages",
  );
  h.send.mockResolvedValue({
    JobStatus: "SUCCEEDED",
    NextToken: "repeat",
    Blocks: [],
  });
  await expect(extractIntakeDocument(intake, "owner", {})).rejects.toThrow(
    "pagination",
  );
  expect(h.commit).not.toHaveBeenCalled();
});
it("drains successful OCR pages before returning a reviewable result", async () => {
  h.send.mockReset();
  h.send
    .mockResolvedValueOnce({
      JobStatus: "SUCCEEDED",
      NextToken: "page2",
      Blocks: [{ BlockType: "LINE", Text: "Page one" }],
    })
    .mockResolvedValueOnce({
      JobStatus: "SUCCEEDED",
      Blocks: [{ BlockType: "LINE", Text: "Page two" }],
    });
  expect(
    await extractIntakeDocument(
      {
        id: "x",
        filename: "test.pdf",
        extractionJobId: "job",
      } as StatementIntake,
      "owner",
      {},
    ),
  ).toMatchObject({ status: "READY", text: "Page one\nPage two" });
  expect(h.send).toHaveBeenCalledTimes(2);
});

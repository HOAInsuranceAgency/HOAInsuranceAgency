import { expect, it, vi } from "vitest";
import {
  exactPolicyMatches,
  prepareIntakeRows,
  reuseImportMapping,
  rowIssues,
  intakeSummary, importedPolicyDate, statementSummaryLabel, validateIntakeRow,
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

it("flags carrier summaries separately without dropping malformed policy rows or approving exclusions", () => {
  const mapping = { policy: 2, reference: 1, amount: 7, effective: 4, transaction: 3 };
  // Fictional values with the source layout; no customer statement data.
  const rows = prepareIntakeRows([
    ['Insured','Account','Policy','Transaction','Effective','Premium','Rate','Due'],
    ['Fictional Harbor','REF-A','A123456 BIP','NEW BUSINESS','08/28/26','1000.00','15','150.00'],
    ['Fictional Grove','REF-B','0123456789 LB','RENEWAL','07/27/2026','1000.00','10','100.00'],
    ['TOTAL COMM. ACTIVITY DIRECT BILL','','','','','2000.00','','250.00'],
    ['','','','','YEAR TO DATE COMMISSION','','','3000.00'],
    ['','','','','OCTOBER COMMISSION PAYABLE','','','250.00'],
    ['Unclear source','','','','','','','25.00'],
    ['TOTAL COMMISSION','REF-C','OTHER-12345','RECEIPT','2026-08-28','','','10.00'],
  ], mapping, 'inbox', 0, [], 'c');
  expect(rows).toHaveLength(7);
  expect(rows.slice(0,2).map(r => r.effectiveDate)).toEqual(['2026-08-28','2026-07-27']);
  expect(rows.slice(0,2).every(r => !r.importIssue)).toBe(true);
  expect(rows.filter(r => r.summaryLabel)).toHaveLength(3);
  expect(rows.every(r => !r.deleted && r.reviewStatus === 'PENDING')).toBe(true);
  expect(rows[5].summaryLabel).toBeUndefined();
  expect(rows[6].summaryLabel).toBeUndefined();
  expect(validateIntakeRow(rows[2], 'inbox').summaryLabel).toBe('TOTAL COMM. ACTIVITY DIRECT BILL');
  const reviewed = rows.slice(0,5).map(r => r.summaryLabel ? {...r, deleted:true, note:'Confirmed summary'} : r);
  expect(intakeSummary(reviewed,'c',[]).rowTotalCents).toBe(25000);
  expect(intakeSummary(reviewed,'c',[]).rowCount).toBe(2);
});
it("does not suggest exclusion for a row just because identifiers are missing", () => {
  const mapping = {policy:0,reference:1,amount:2,effective:-1,transaction:-1};
  expect(statementSummaryLabel(['','','100.00'], mapping)).toBeUndefined();
  expect(statementSummaryLabel(['POL-12345','TOTAL','100.00'], mapping)).toBeUndefined();
  expect(statementSummaryLabel(['TOTAL','','100.00'], mapping)).toBe('TOTAL');
});
it("parses US effective dates while rejecting impossible dates and preserving raw source", () => {
  expect(importedPolicyDate('10/04/26')).toBe('2026-10-04');
  expect(importedPolicyDate('1/2/2027')).toBe('2027-01-02');
  expect(importedPolicyDate('2026-08-28')).toBe('2026-08-28');
  expect(() => importedPolicyDate('02/30/26')).toThrow();
  const [row] = prepareIntakeRows([['Policy','Ref','Due','Date'],['POL','R','1.00','02/30/26']],
    {policy:0,reference:1,amount:2,effective:3,transaction:-1}, 'inbox',0,[],'c');
  expect(row.raw).toContain('02/30/26');
  expect(row.importIssue).toContain('effective date');
});

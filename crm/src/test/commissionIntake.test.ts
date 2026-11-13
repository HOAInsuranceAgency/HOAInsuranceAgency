import {
  payrollBlockers,
  suggestPayrollDates,
  type PayrollCycle,
} from "../../../shared/commissionPayroll";
import { beforeEach, expect, it, vi } from "vitest";
import { commissionPolicy, line, statement } from "./commissionFixtures";
import {
  appendEntry,
  type CommissionPolicy,
} from "../../../shared/commissions";
import { createHash } from "node:crypto";
import {
  intakePayrollStatements,
  intakeRowsKind,
  type IntakeRow,
  type IntakeSettlement,
  type StatementIntake,
} from "../../../shared/commissionIntake";
const h = vi.hoisted(() => ({
  get: vi.fn(),
  getMany: vi.fn(),
  list: vi.fn(),
  commit: vi.fn(),
  session: vi.fn(),
  bind: vi.fn(),
  s3: vi.fn(),
  db: vi.fn(),
  sources: new Map<string, Record<string, unknown>>(),
}));
vi.mock("../../amplify/functions/commissions/store", () => ({
  get: h.get,
  getMany: h.getMany,
  list: h.list,
  commit: h.commit,
  table: () => "private-ledger",
  db: { send: h.db },
}));
vi.mock("../../amplify/functions/commissions/bind", () => ({
  bindPolicy: h.bind,
}));
vi.mock("../../amplify/functions/crm-access/user-status", () => ({
  assertUserSession: h.session,
}));
vi.mock("../../amplify/functions/crm-access/access", () => ({
  tableName: (model: string) => model,
  AccountAccess: class {
    async get(model: string, id: string) {
      return h.sources.get(`${model}:${id}`);
    }
    async requireRecord(model: string, id: string) {
      const record = h.sources.get(`${model}:${id}`);
      if (!record) throw new Error("Not authorized");
      return record;
    }
  },
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = h.s3;
  },
}));
import {
  handler,
  type Event,
} from "../../amplify/functions/commissions/handler";
const request = (
  operation: string,
  input: unknown = {},
  role = "OWNER",
  groups = [role],
): Event => ({
  fieldName: "commissionAction",
  identity: { sub: "producer", groups },
  request: { headers: { "x-crm-role": role } },
  arguments: { operation, input },
});
let records: Map<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  records = new Map();
  h.sources.clear();
  h.s3.mockResolvedValue({});
  h.db.mockResolvedValue({ Items: [] });
  h.session.mockResolvedValue(undefined);
  h.get.mockImplementation(async (k, id) =>
    structuredClone(records.get(`${k}:${id}`)),
  );
  h.getMany.mockImplementation(async (refs: { kind: string; id: string }[]) =>
    structuredClone(
      refs.map((r) => records.get(`${r.kind}:${r.id}`)).filter(Boolean),
    ),
  );
  h.list.mockImplementation(async (k, producer, recordKind) =>
    structuredClone(
      [...records.entries()]
        .filter(([key, v]) =>
          producer
            ? (v as { producerId?: string }).producerId === k &&
              (!recordKind || key.startsWith(`${recordKind}:`))
            : key.startsWith(`${k}:`),
        )
        .map(([key, v]) => ({ ...(v as object), kind: key.split(":")[0] })),
    ),
  );
  h.commit.mockImplementation(
    async (
      changes: {
        kind: string;
        value: { id: string; version?: number };
        previous?: { version: number };
      }[],
      _actor: string,
      extras: {
        ConditionCheck: {
          Key: { kind: string; id: string };
          ConditionExpression: string;
          ExpressionAttributeValues?: Record<string, unknown>;
        };
      }[] = [],
    ) => {
      expect(changes.length + extras.length + 1).toBeLessThanOrEqual(100);
      const seen = new Set<string>();
      for (const c of changes) {
        const k = c.kind + ":" + c.value.id;
        if (seen.has(k)) throw new Error("Duplicate transaction key");
        seen.add(k);
      }
      for (const extra of extras) {
        const c = extra.ConditionCheck,
          old = records.get(c.Key.kind + ":" + c.Key.id) as
            { version: number } | undefined;
        if (
          c.ConditionExpression === "attribute_not_exists(id)"
            ? !!old
            : old?.version !== c.ExpressionAttributeValues?.[":v"]
        )
          throw new Error("Transaction conflict");
      }
      for (const c of changes) {
        const old = records.get(`${c.kind}:${c.value.id}`) as
          { version: number } | undefined;
        if (
          (old?.version ?? 0) !== (c.previous?.version ?? 0) ||
          (old && !c.previous)
        ) {
          const e = new Error("conflict");
          e.name = "TransactionCanceledException";
          throw e;
        }
      }
      for (const c of changes)
        records.set(
          `${c.kind}:${c.value.id}`,
          structuredClone({
            ...c.value,
            version: (c.previous?.version ?? 0) + 1,
          }),
        );
    },
  );
});
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const get = <T>(k: string, id: string): T =>
  structuredClone(records.get(k + ":" + id)) as T;
const all = <T>(kind: string): T[] =>
  [...records.entries()]
    .filter(([k]) => k.startsWith(kind + ":"))
    .map(([, v]) => structuredClone(v)) as T[];
const seed = (kind: string, v: { id: string }) =>
  records.set(kind + ":" + v.id, structuredClone(v));
const row = (p: Partial<IntakeRow> = {}): IntakeRow => ({
  id: "row1",
  version: 0,
  intakeId: "inbox",
  policyNumber: "POL-1",
  effectiveDate: "2026-01-01",
  policyId: "p",
  lineRef: "TX-1",
  agencyCents: 10000,
  transactionType: "RECEIPT",
  reviewStatus: "ELIGIBLE",
  note: "",
  postedCents: 0,
  ...p,
});
const intake = (p: Partial<StatementIntake> = {}): StatementIntake => ({
  id: "inbox",
  version: 1,
  carrierId: "c",
  carrierName: "Carrier",
  reference: "SOURCE-1",
  source: "statements/11111111-1111-1111-1111-111111111111",
  filename: "statement.pdf",
  fileHash: "source",
  documentReceivedOn: "2026-10-02",
  totalCents: 10000,
  createdAt: "2026-10-02T12:00:00Z",
  createdBy: "owner",
  status: "OPEN",
  rowCount: 0,
  rowTotalCents: 0,
  needsReview: 0,
  unmatched: 0,
  postedCents: 0,
  completedRows: 0,
  ...p,
});
const call = async (op: string, input: unknown = {}) =>
  (await handler(request(op, input))) as {
    ok: boolean;
    settlementId?: string;
    [key: string]: unknown;
  };
const version = () => get<StatementIntake>("STATEMENT_INTAKE", "inbox").version;
const save = (rows = [row()]) =>
  call("saveIntakeRows", {
    id: "inbox",
    version: version(),
    rows,
    confirmed: true,
    extractionReviewed: true,
  });
async function payment(
  ref = "BANK-1",
  amount = 10000,
  receivedOn = "2026-10-03",
) {
  const result = await call("recordIntakeSettlement", {
    id: "inbox",
    version: version(),
    reference: ref,
    totalCents: amount,
    receivedOn,
    settlementType: "DEPOSIT",
    evidence: "TEST bank evidence",
    confirmed: true,
  });
  expect(result).toMatchObject({ ok: true });
  return get<IntakeSettlement>("INTAKE_SETTLEMENT", result.settlementId!);
}
async function allocate(
  s: IntakeSettlement,
  allocations = [{ rowId: "row1", amountCents: s.totalCents }],
) {
  const result = await call("allocateIntakeSettlement", {
    id: "inbox",
    settlementId: s.id,
    version: s.version,
    confirmed: true,
    allocations,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return get<IntakeSettlement>("INTAKE_SETTLEMENT", s.id);
}
const post = (s: IntakeSettlement, requestId = "request1") =>
  call("postIntakeSettlement", {
    id: "inbox",
    settlementId: s.id,
    version: s.version,
    requestId,
    confirmed: true,
  });
beforeEach(() => {
  seed("POLICY", commissionPolicy());
  seed("CARRIER", commissionPolicy().carrierTerms);
  seed("STATEMENT_INTAKE", intake());
  h.s3.mockResolvedValue({
    ContentLength: 7,
    Body: { transformToByteArray: async () => Buffer.from("TESTPDF") },
  });
});
it.each([
  "intakeWorkspace",
  "getStatementIntake",
  "saveStatementIntake",
  "saveIntakeRows",
  "recordIntakeSettlement",
  "allocateIntakeSettlement",
  "postIntakeSettlement",
  "extractIntakeDocument",
  "policyIntakeContext",
  "saveCarrierImportTemplate",
  "voidIntakeSettlement",
  "voidStatementIntake",
])("restricts %s to active Owners before private reads", async (op) => {
  expect(
    await handler(request(op, {}, "ADMIN", ["OWNER", "ADMIN"])),
  ).toMatchObject({ ok: false });
  expect(h.get).not.toHaveBeenCalled();
  expect(h.list).not.toHaveBeenCalled();
  expect(h.s3).not.toHaveBeenCalled();
});
it("logs incomplete statements without earnings and detects duplicate files and references", async () => {
  records.delete("STATEMENT_INTAKE:inbox");
  const input = { ...intake(), version: 0, totalCents: undefined };
  expect(await call("saveStatementIntake", input)).toMatchObject({ ok: true });
  expect(all("EARNING")).toEqual([]);
  expect(get<CommissionPolicy>("POLICY", "p").entries).toEqual([]);
  expect(
    await call("saveStatementIntake", {
      ...input,
      id: "duplicate",
      reference: "SOURCE-2",
    }),
  ).toMatchObject({ ok: false });
  h.s3.mockResolvedValue({
    ContentLength: 9,
    Body: { transformToByteArray: async () => Buffer.from("OTHERFILE") },
  });
  expect(
    await call("saveStatementIntake", { ...input, id: "duplicate" }),
  ).toMatchObject({ ok: false });
});
it("saves missing matches and bad amounts and requires explicit extraction review", async () => {
  expect(
    await call("saveIntakeRows", {
      id: "inbox",
      version: 1,
      rows: [
        row({
          policyId: "",
          agencyCents: undefined,
          reviewStatus: "PENDING",
          importIssue: "Unreadable amount",
        }),
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(get<StatementIntake>("STATEMENT_INTAKE", "inbox")).toMatchObject({
    unmatched: 1,
    needsReview: 1,
  });
  expect(
    await call("saveIntakeRows", {
      id: "inbox",
      version: version(),
      rows: [row({ version: 1, importIssue: "Unreadable amount" })],
      confirmed: true,
    }),
  ).toMatchObject({ ok: false });
});
it("posts partial payments once and retains cumulative cents rounding", async () => {
  seed("STATEMENT_INTAKE", intake({ totalCents: 8 }));
  expect(await save([row({ agencyCents: 8 })])).toMatchObject({ ok: true });
  const a = await allocate(await payment("BANK-A", 3));
  expect(await post(a)).toMatchObject({ ok: true, complete: true });
  expect(await post(a)).toMatchObject({ ok: true });
  expect(get<CommissionPolicy>("POLICY", "p").entries).toHaveLength(1);
  expect(await save([row({ version: 2, agencyCents: 99 })])).toMatchObject({
    ok: false,
  });
  const b = await allocate(await payment("BANK-B", 5));
  expect(await post(b, "request2")).toMatchObject({ ok: true, complete: true });
  const p = get<CommissionPolicy>("POLICY", "p");
  expect(p.entries.map((e) => e.agencyCents)).toEqual([3, 5]);
  expect(p.entries.reduce((n, e) => n + e.producerCents, 0)).toBe(1);
  expect(get<StatementIntake>("STATEMENT_INTAKE", "inbox")).toMatchObject({
    completedRows: 1,
    postedCents: 8,
  });
});
it("rejects overallocations and control total differences", async () => {
  await save();
  const s = await payment("BANK-A", 10001);
  expect(
    await call("allocateIntakeSettlement", {
      id: "inbox",
      settlementId: s.id,
      version: s.version,
      confirmed: true,
      allocations: [{ rowId: "row1", amountCents: 10001 }],
    }),
  ).toMatchObject({ ok: false });
  seed("STATEMENT_INTAKE", intake({ version: version(), totalCents: 20000 }));
  expect(
    await call("allocateIntakeSettlement", {
      id: "inbox",
      settlementId: s.id,
      version: s.version,
      confirmed: true,
      allocations: [{ rowId: "row1", amountCents: 10000 }],
    }),
  ).toMatchObject({ ok: false });
  expect(all("EARNING")).toHaveLength(0);
});
it("prevents duplicate payment and transaction references across earlier reconciliation", async () => {
  records.set("SETTLEMENT:" + hash("c|bank-old"), {
    id: hash("c|bank-old"),
    version: 1,
  });
  expect(
    await call("recordIntakeSettlement", {
      id: "inbox",
      version: 1,
      reference: "BANK-OLD",
      receivedOn: "2026-10-03",
      totalCents: 10000,
      settlementType: "DEPOSIT",
      evidence: "Bank evidence",
      confirmed: true,
    }),
  ).toMatchObject({ ok: false });
  expect(all("INTAKE_SETTLEMENT")).toHaveLength(0);
  await save();
  const s = await allocate(await payment());
  records.set("CARRIER_TRANSACTION:" + hash("c|tx-1"), {
    id: hash("c|tx-1"),
    version: 1,
  });
  expect(await post(s)).toMatchObject({ ok: false });
  expect(get<CommissionPolicy>("POLICY", "p").entries).toHaveLength(0);
  expect(all("EARNING")).toHaveLength(0);
});
it("blocks payroll during interrupted posting and resumes without duplicates", async () => {
  seed("STATEMENT_INTAKE", intake({ totalCents: 70000 }));
  const rows = Array.from({ length: 7 }, (_, i) =>
    row({ id: "row" + i, lineRef: "TX-" + i }),
  );
  await save(rows);
  const s = await allocate(
    await payment("LARGE", 70000),
    rows.map((r) => ({ rowId: r.id, amountCents: 10000 })),
  );
  expect(await post(s)).toMatchObject({
    ok: true,
    complete: false,
    postedRows: 5,
  });
  const cycle = {
    ...suggestPayrollDates("2026-10"),
    status: "OPEN",
    batchIds: [],
    totalCents: 0,
    version: 1,
    revision: 1,
  } as PayrollCycle;
  expect(
    payrollBlockers(
      cycle,
      [],
      intakePayrollStatements(all("INTAKE_SETTLEMENT")),
    ),
  ).toHaveLength(1);
  expect(await post(s)).toMatchObject({ ok: true, postedRows: 5 });
  expect(
    await post(get<IntakeSettlement>("INTAKE_SETTLEMENT", s.id), "resume"),
  ).toMatchObject({ ok: true, complete: true, postedRows: 7 });
  expect(get<CommissionPolicy>("POLICY", "p").entries).toHaveLength(7);
  expect(
    payrollBlockers(
      cycle,
      [],
      intakePayrollStatements(all("INTAKE_SETTLEMENT")),
    ),
  ).toEqual([]);
});
it("uses the actual settlement date for payroll cutoffs", async () => {
  await save();
  await payment("LATE", 10000, "2026-10-24");
  const cycle = {
    ...suggestPayrollDates("2026-10"),
    status: "OPEN",
    batchIds: [],
    totalCents: 0,
    version: 1,
    revision: 1,
  } as PayrollCycle;
  expect(cycle.cutoff).toBe("2026-10-23");
  expect(
    payrollBlockers(
      cycle,
      [],
      intakePayrollStatements(all("INTAKE_SETTLEMENT")),
    ),
  ).toEqual([]);
});
it("voids only confirmed incorrect payments, retaining evidence and duplicate protection", async () => {
  const s = await payment();
  expect(
    await call("voidIntakeSettlement", {
      id: "inbox",
      settlementId: s.id,
      version: s.version,
      reason: "Incorrect bank record",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await call("voidIntakeSettlement", {
      id: "inbox",
      settlementId: s.id,
      version: s.version,
      reason: "TEST bank record was incorrect",
      confirmed: true,
    }),
  ).toMatchObject({ ok: true });
  expect(intakePayrollStatements(all("INTAKE_SETTLEMENT"))).toEqual([]);
  expect(get<IntakeSettlement>("INTAKE_SETTLEMENT", s.id).evidence).toBe(
    "TEST bank evidence",
  );
  expect(get("SETTLEMENT", s.id)).toBeDefined();
});
it("rejects stale row edits and prevents two payments claiming the same balance", async () => {
  await save();
  expect(
    await call("saveIntakeRows", {
      id: "inbox",
      version: 1,
      rows: [row({ agencyCents: 9900 })],
      confirmed: true,
    }),
  ).toMatchObject({ ok: false });
  expect(get<IntakeRow>(intakeRowsKind("inbox"), "row1").agencyCents).toBe(
    10000,
  );
  const a = await allocate(await payment("A", 6000));
  const b = await payment("B", 6000);
  expect(
    await call("allocateIntakeSettlement", {
      id: "inbox",
      settlementId: b.id,
      version: b.version,
      confirmed: true,
      allocations: [{ rowId: "row1", amountCents: 6000 }],
    }),
  ).toMatchObject({ ok: false });
  expect(await post(a)).toMatchObject({ ok: true });
});

it("validates later reversal rows before any part of the settlement posts", async () => {
  seed("STATEMENT_INTAKE", intake({ totalCents: 49900 }));
  const rows = [
    ...Array.from({ length: 5 }, (_, i) =>
      row({ id: "r" + i, lineRef: "T" + i }),
    ),
    row({
      id: "bad",
      lineRef: "REV",
      transactionType: "REVERSAL",
      agencyCents: -100,
      originalId: "missing-receipt",
      note: "TEST reversal",
    }),
  ];
  await save(rows);
  const s = await payment("BAD-TAIL", 49900);
  expect(
    await call("allocateIntakeSettlement", {
      id: "inbox",
      settlementId: s.id,
      version: s.version,
      confirmed: true,
      allocations: rows.map((r) => ({
        rowId: r.id,
        amountCents: r.agencyCents,
      })),
    }),
  ).toMatchObject({ ok: false });
  expect(get<IntakeSettlement>("INTAKE_SETTLEMENT", s.id).status).toBe(
    "RECORDED",
  );
  expect(get<CommissionPolicy>("POLICY", "p").entries).toHaveLength(0);
});
it("handles zero-net partial settlements without unlocking the original statement total", async () => {
  seed(
    "POLICY",
    appendEntry(
      commissionPolicy(),
      line({ agencyCents: 10000 }),
      statement(),
      "original",
    ),
  );
  seed("STATEMENT_INTAKE", intake({ totalCents: 0 }));
  await save([
    row(),
    row({
      id: "reversal",
      lineRef: "REV-1",
      transactionType: "REVERSAL",
      agencyCents: -10000,
      originalId: "original",
      note: "TEST carrier offset",
    }),
  ]);
  const s = await allocate(await payment("NET", 0), [
    { rowId: "row1", amountCents: 5000 },
    { rowId: "reversal", amountCents: -5000 },
  ]);
  expect(await post(s)).toMatchObject({ ok: true, complete: true });
  const parent = get<StatementIntake>("STATEMENT_INTAKE", "inbox");
  expect(parent).toMatchObject({ postedCents: 0, completedRows: 0 });
  expect(
    await call("saveStatementIntake", { ...parent, totalCents: 100 }),
  ).toMatchObject({ ok: false });
});

it("saves and recovers a private working draft without creating payroll or receipt records", async () => {
  const result = await call("saveIntakeWorkingDraft", { id:"inbox", scope:"rows", version:0, baseVersion:version(), data:{amount:"12.50"} });
  expect(result).toMatchObject({ok:true, draft:{version:1,baseVersion:1,data:{amount:"12.50"}}});
  expect(await call("getIntakeWorkingDraft",{id:"inbox",scope:"rows"})).toMatchObject({ok:true,draft:{data:{amount:"12.50"}}});
  expect(all("INTAKE_ROWS#inbox")).toHaveLength(0);
  expect(all("INTAKE_SETTLEMENT")).toHaveLength(0);
  expect(all("PAYROLL_STATE")).toHaveLength(0);
  expect(get<CommissionPolicy>("POLICY","p").entries).toHaveLength(0);
  const other = request("getIntakeWorkingDraft",{id:"inbox",scope:"rows"});
  other.identity = {...other.identity,sub:"another-owner"};
  expect(await handler(other)).toMatchObject({ok:true,draft:null});
});
it("rejects stale draft saves and changed statement versions without overwriting recovery data", async () => {
  const input = {id:"inbox",scope:"settlement",version:0,baseVersion:version(),data:{reference:"TEST"}};
  expect(await call("saveIntakeWorkingDraft",input)).toMatchObject({ok:true});
  expect(await call("saveIntakeWorkingDraft",input)).toMatchObject({ok:false});
  seed("STATEMENT_INTAKE",intake({version:2}));
  expect(await call("saveIntakeWorkingDraft",{...input,version:1})).toMatchObject({ok:false});
  expect(await call("getIntakeWorkingDraft",{id:"inbox",scope:"settlement"})).toMatchObject({draft:{baseVersion:1,data:{reference:"TEST"}}});
});
it("rejects unauthorized, unknown and oversized draft saves", async () => {
  const input={id:"inbox",scope:"rows",version:0,baseVersion:1,data:{}};
  expect(await handler(request("saveIntakeWorkingDraft",input,"ADMIN",["OWNER","ADMIN"]))).toMatchObject({ok:false});
  expect(await handler(request("getIntakeWorkingDraft",input,"ADMIN",["OWNER","ADMIN"]))).toMatchObject({ok:false});
  expect(await call("saveIntakeWorkingDraft",{...input,scope:"payroll"})).toMatchObject({ok:false});
  expect(await call("saveIntakeWorkingDraft",{...input,data:{text:"x".repeat(100_001)}})).toMatchObject({ok:false});
  expect(all("INTAKE_WORKING_DRAFT")).toHaveLength(0);
});
it("discards working values with a versioned tombstone and leaves the statement intact",async()=>{
  const input={id:"inbox",scope:"rows",version:0,baseVersion:1,data:{amount:"TEST"}};
  await call("saveIntakeWorkingDraft",input);
  expect(await call("saveIntakeWorkingDraft",{...input,version:1,data:null})).toMatchObject({ok:true,draft:{version:2,data:null}});
  expect(version()).toBe(1);
});

import {
  receiptEarnings,
  departureWorklist,
  type CommissionDeparture,
  type CommissionAllocation,
} from "../../../shared/commissionExceptions";
import {
  commissionPolicy,
  line,
  statement,
} from "../../src/test/commissionFixtures";
import {
  appendEntry,
  carrierReconciliationBalances,
  type CommissionPolicy,
  type CommissionOverview,
} from "../../../shared/commissions";
import {
  defaultPayrollSettings,
  suggestPayrollDates,
  payrollPreview,
  type PayrollWorkspace,
} from "../../../shared/commissionPayroll";
export const previewQuery = new URLSearchParams(location.protocol === 'file:' ? location.hash.slice(1) || location.search : location.search);
if (location.protocol === 'file:' && !previewQuery.has('scenario')) previewQuery.set('scenario', 'shared');
const base = commissionPolicy();
base.producerName = "Avery Brooks";
base.carrierName = "Harbor Mutual";
base.carrierTerms.name = "Harbor Mutual";
let policy = appendEntry(
  base,
  line({ agencyCents: 200000 }),
  statement(),
  "receipt-oct",
);
policy = appendEntry(
  policy,
  line({
    lineRef: "CANCEL-105",
    kind: "REVERSAL",
    originalId: "receipt-oct",
    agencyCents: -50000,
  }),
  statement(),
  "cancel-oct",
);
const installmentPolicy: CommissionPolicy = {
  ...base,
  id: 'installments',
  policyNumber: 'HARBOR-INSTALLMENTS',
  accountName: 'Seaside HOA',
  receiptForecast: {
    items: [{ dueOn: '2026-11-01', agencyCents: 100000 }, { dueOn: '2026-12-01', agencyCents: 100000 }],
    evidence: 'Fictional carrier installment schedule',
    confirmed: true,
    complete: false,
  },
  entries: [],
};
const receivedInstallment = appendEntry(
  installmentPolicy,
  line({ policyId: 'installments', agencyCents: 90000, lineRef: 'INSTALLMENT-1' }),
  { ...statement(), receivedOn: '2026-11-03' },
  'installment-receipt',
);
const previewDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
for (const previewPolicy of [policy, receivedInstallment])
  previewPolicy.reconciliationBalances = carrierReconciliationBalances(previewPolicy, previewDate);
export const data: CommissionOverview = {
  planDefinitions: [
    {
      id: "business-development",
      version: 1,
      name: "Business Development (fictional)",
      newBps: 1600,
      renewalBps: 800,
      agreement: "Fictional plan for visual testing",
      archived: false,
    },
  ],
  plans: [
    {
      id: "producer",
      producerId: "producer",
      name: "Avery Brooks",
      version: 1,
      terms: [
        {
          from: "2026-01-01",
          newBps: 1600,
          renewalBps: 800,
          agreement: "Fictional signed agreement",
          assignment: {
            id: "avery-2026",
            planId: "business-development",
            planVersion: 1,
            planName: "Business Development (fictional)",
            planReference: "Fictional plan for visual testing",
          },
        },
      ],
    },
  ],
  carriers: [base.carrierTerms],
  policies: [receivedInstallment, policy],
  statements: [{ ...statement(), lines: [line()], totalCents: 100000 }],
  batches: [],
};
export const readCommissions = async () =>
  structuredClone(
    useIsOwner()
      ? data
      : {
          ...data,
          policies: data.policies.filter((p) => p.producerId === "producer"),
          earnings: data.earnings?.filter((e) => e.producerId === "producer"),
          batches: data.batches.filter((b) => b.producerId === "producer"),
        },
  );
export const payrollWorkspace: PayrollWorkspace = {
  owner: true,
  environment: "local",
  producers: [{ id: "producer", name: "Avery Brooks" }],
  settings: {
    ...defaultPayrollSettings("approver@example.test"),
    hrRecipient: "hr@example.test",
  },
  cycles: ["2026-10", "2026-11"].map((month) => ({
    ...suggestPayrollDates(month),
    version: 1,
    revision: 1,
    status: "OPEN",
    batchIds: [],
    totalCents: 0,
    preview: {
      token: "fictional-preview",
      totalCents: 32000,
      entryCount: 1,
      employees: [
        { producerId: "producer", name: "Avery Brooks", amountCents: 32000 },
      ],
      blockers: [
        "Fictional preview only: payroll approval and delivery are disabled.",
      ],
    },
  })),
  deliveries: [],
  batches: [],
};
// Optional visual-only exception state; no sample is sent to the CRM.
if (previewQuery.get("scenario") === "exceptions") {
  const cycle = payrollWorkspace.cycles[1];
  const batch = {
    id: "cycle:2026-11:2:producer",
    version: 2,
    cycleId: cycle.id,
    cycleRevision: 2,
    producerId: "producer",
    producerName: "Avery Brooks",
    cutoff: cycle.cutoff,
    payDate: cycle.payDate,
    status: "APPROVED" as const,
    totalCents: 32000,
    lines: [
      {
        policyId: policy.id,
        entryId: "receipt-oct",
        accountName: policy.accountName,
        policyNumber: policy.policyNumber,
        receivedOn: "2026-10-01",
        transaction: policy.transaction,
        agencyCents: 200000,
        producerBps: 1600,
        amountCents: 32000,
      },
    ],
    payments: [
      {
        id: "example-payment",
        amountCents: 12000,
        paidOn: "2026-11-23",
        reference: "FICTIONAL-PAYROLL",
        recordedAt: "2026-11-23T15:00:00Z",
        recordedBy: "Example Owner",
      },
    ],
  };
  Object.assign(cycle, {
    status: "APPROVED",
    approvedAt: "2026-11-21T15:00:00Z",
    approvedBy: "Example Owner",
    revision: 2,
    totalCents: 32000,
    batchIds: [batch.id],
    replacesRevision: 1,
    correctionReason: "Fictional corrected receipt allocation",
    preview: undefined,
  });
  payrollWorkspace.batches = [batch];
  data.batches = [batch];
  data.policies = [
    {
      ...policy,
      entries: policy.entries.map((e) =>
        e.id === "receipt-oct" ? { ...e, batchId: batch.id } : e,
      ),
    },
  ];
  payrollWorkspace.reports = [1, 2].map((revision) => ({
    id: `${cycle.id}:${revision}`,
    cycleId: cycle.id,
    revision,
    totalCents: 32000,
    createdAt: "2026-11-21T15:00:00Z",
    createdBy: "Example Owner",
    contentHash: "fictional-report-integrity-reference",
  }));
  payrollWorkspace.deliveries = [
    {
      id: "example-delivery",
      version: 1,
      cycleId: cycle.id,
      cycleRevision: 2,
      reportType: "PAYROLL",
      status: "SENT",
      recipient: "hr@example.test",
      subject: "Fictional approved payroll",
      text: "Visual preview only",
      createdAt: "2026-11-23T13:00:00Z",
      updatedAt: "2026-11-23T14:00:00Z",
      feedback: ["Bounce"],
      messageId: "fictional-message-id",
    },
  ];
}
export const commissionAction = async (action: string, input: Record<string, unknown> = {}) => {
  if (action === "downloadPayrollCycle" && useIsOwner() && previewQuery.get("scenario") === "exceptions") {
    const { samplePayrollFiles } = await import("./sample-reports");
    return structuredClone(samplePayrollFiles(input));
  }
  if (action === "commissionExceptions" && useIsOwner())
    return structuredClone({
      policies: data.policies,
      earnings: data.earnings ?? [],
      adjustments: [],
      producers: data.plans.map((p) => ({ id: p.producerId, name: p.name })),
      departures: [
        {
          ...departure,
          worklist: departureWorklist(
            departure,
            data.policies,
            data.earnings ?? [],
            data.batches,
          ),
        },
      ],
    });
  if (action === 'intakeWorkspace' && useIsOwner()) return structuredClone({intakes: [inboxSample], settlements: [], templates: []});
  if (action === 'getStatementIntake' && useIsOwner()) return structuredClone({intake: inboxSample, rows: inboxRows, settlements: []});
  if (action === "payrollWorkspace" && useIsOwner())
    return structuredClone(payrollWorkspace);
  throw new Error(
    "This preview uses fictional data and cannot save or download private files.",
  );
};
export const useIsOwner = () =>
  previewQuery.get("role") !== "producer";
export const communicationRequest = async () => ({
  team: [{ userId: "producer", name: "Avery Brooks" }],
  items: [{ id: "a", name: "Cedar HOA" }],
});
export const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n,
  );
export const friendlyError = (e: unknown) =>
  e instanceof Error ? e.message : "Preview error";
export const client = {
  models: {
    Carrier: {
      list: async () => ({ data: [{ id: "c", name: "Harbor Mutual" }] }),
    },
    Policy: { list: async () => ({ data: [] }) },
  },
};
export const listAllPages = async <T>(fetch: () => Promise<{ data: T[] }>) =>
  (await fetch()).data;

export const departure: CommissionDeparture = {
  id: "producer",
  version: 1,
  producerId: "producer",
  producerName: "Avery Brooks",
  employmentEndOn: "2026-09-30",
  agreement: "Fictional departure agreement",
  evidence: "Fictional Owner review for visual testing",
  reviewOn: "2026-11-05",
  paymentDueOn: "2026-11-06",
  laterReceipts: "REVIEW",
  renewals: "REVIEW",
  status: "APPROVED",
  approvedBy: "Example Owner",
  approvedAt: "2026-11-05T12:00:00Z",
  decisions: [],
};
if (previewQuery.get("scenario") === "shared") {
  const allocation: CommissionAllocation = {
    id: "fictional-split",
    from: "2026-01-01",
    method: "INDIVIDUAL_PLAN_RATE",
    houseBps: 0,
    agreement: "Fictional shared-production agreement",
    approvedBy: "Example Owner",
    approvedAt: "2026-09-01T12:00:00Z",
    participants: [
      {
        producerId: "producer",
        producerName: "Avery Brooks",
        shareBps: 6000,
        producerBps: 2000,
        planVersion: 1,
        agreement: "Fictional sales plan",
        eligible: true,
      },
      {
        producerId: "jordan",
        producerName: "Jordan Hayes",
        shareBps: 4000,
        producerBps: 1600,
        planVersion: 1,
        agreement: "Fictional business development plan",
        eligible: true,
      },
    ],
  };
  const shared = appendEntry(
    {
      ...base,
      id: "shared-policy",
      accountName: "Maple Court HOA",
      policyNumber: "SHARED-102",
      allocations: [allocation],
    },
    line(),
    statement(),
    "shared-receipt",
  );
  data.policies.push(shared);
  data.earnings = receiptEarnings(shared, shared.entries[0], []);
  data.plans.push({
    ...data.plans[0],
    id: "jordan",
    producerId: "jordan",
    name: "Jordan Hayes",
  });
}

// Keep the visual payroll totals in step with the real earnings engine.
if (previewQuery.get("scenario") === "shared") {
  payrollWorkspace.producers = data.plans.map((p) => ({
    id: p.producerId,
    name: p.name,
  }));
  for (const cycle of payrollWorkspace.cycles) {
    const rows = payrollPreview(
      data.policies,
      cycle.cutoff,
      undefined,
      data.earnings,
    );
    cycle.preview = {
      token: "fictional-preview",
      totalCents: rows.reduce((n, r) => n + r.amountCents, 0),
      entryCount: rows.length,
      employees: payrollWorkspace.producers
        .map((p) => ({
          producerId: p.id,
          name: p.name,
          amountCents: rows
            .filter((r) => r.producerId === p.id)
            .reduce((n, r) => n + r.amountCents, 0),
        }))
        .filter((p) => p.amountCents > 0),
      blockers: [
        "Fictional preview only: payroll approval and delivery are disabled.",
      ],
    };
  }
}

// Local parsing only: never issue an upload URL or manufacture an evidence key.
export async function attachCommissionStatement(file: File) {
  if (!useIsOwner()) throw new Error('Only the Owner preview can read sample statements.');
  if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error('Use a fictional CSV or XLSX sample in this preview.');
  if (file.size > 5_000_000) throw new Error('Use a file under 5 MB.');
  return { key: '', uploaded: false };
}

const inboxSample = {id:'demo-inbox',version:1,carrierId:'c',carrierName:'Harbor Mutual',reference:'TEST-HARBOR-OCT',source:'fictional-source',filename:'harbor-october.csv',fileHash:'fictional',documentReceivedOn:'2026-10-15',totalCents:100000,createdAt:'2026-10-15T12:00:00Z',createdBy:'preview',status:'OPEN',rowCount:2,rowTotalCents:100000,needsReview:1,unmatched:1,postedCents:0,completedRows:0};
const inboxRows = [{id:'sample1',version:1,intakeId:'demo-inbox',policyNumber:'POL-1',effectiveDate:'2026-01-01',policyId:'p',lineRef:'TEST-TX-1',agencyCents:75000,transactionType:'RECEIPT',reviewStatus:'ELIGIBLE',note:'Fictional source review',postedCents:0},{id:'sample2',version:1,intakeId:'demo-inbox',policyNumber:'HARBOR-NEW',effectiveDate:'',policyId:'',lineRef:'TEST-TX-2',agencyCents:25000,transactionType:'RECEIPT',reviewStatus:'PENDING',note:'',postedCents:0}];
payrollWorkspace.statementReadiness = {activeStatements:1,statementsNeedingReview:1,unmatchedRows:1,pendingSettlements:[]};

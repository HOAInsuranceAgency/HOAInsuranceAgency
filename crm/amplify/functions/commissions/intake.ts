import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { AccountAccess } from "../crm-access/access";
import { object } from "../crm-access/policy";
import { fileClient } from "../crm-access/file-signing";
import {
  day,
  integer,
  required,
  sum,
  MONEY_MAX,
  receiptOnlyCarrierTerms,
  type CarrierCommissionTerms,
  type CommissionPolicy,
  type CommissionStatement,
} from "../../../../shared/commissions";
import {
  INTAKE_EDIT_LIMIT,
  INTAKE_POST_LIMIT,
  INTAKE_ROW_LIMIT,
  intakeRowsKind,
  intakeSummary,
  validateIntakeRow,
  validateSettlementAllocations,
  type StatementIntake,
  type IntakeRow,
  type IntakeSettlement,
  type CarrierImportTemplate,
  type IntakeAllocation,
} from "../../../../shared/commissionIntake";
import type { CommissionEarning } from "../../../../shared/commissionExceptions";
import { statementPostingChanges, assertStatementPostingPlan } from "./posting";
import * as store from "./store";
import type { Event } from "./handler";
import { bindDay } from "./account-history";

export const intakeOperations = new Set([
  "intakeWorkspace",
  "getStatementIntake",
  "saveStatementIntake",
  "saveIntakeRows",
  "voidStatementIntake",
  "recordIntakeSettlement",
  "voidIntakeSettlement",
  "allocateIntakeSettlement",
  "previewIntakeSettlement",
  "postIntakeSettlement",
  "saveCarrierImportTemplate",
  "extractIntakeDocument",
  "policyIntakeContext",
  "getIntakeWorkingDraft",
  "saveIntakeWorkingDraft",
]);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const change = (
  kind: string,
  value: unknown,
  previous?: unknown,
): store.Change => ({
  kind,
  value: value as store.Change["value"],
  ...(previous ? { previous: previous as store.Data } : {}),
});
const absent = (kind: string, id: string): store.Transaction[number] => ({
  ConditionCheck: {
    TableName: store.table(),
    Key: { kind, id },
    ConditionExpression: "attribute_not_exists(id)",
  },
});
const version = (input: store.Data, row?: { version: number }) => {
  if (input.version !== (row?.version ?? 0))
    throw new Error("This statement changed. Refresh before saving.");
};
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const s3 = fileClient();
async function reconciliationChange() {
  const previous = await store.get("PAYROLL_STATE", "reconciliation");
  return change("PAYROLL_STATE", { id: "reconciliation" }, previous);
}
async function getIntake(id: unknown) {
  const intake = await store.get<StatementIntake>(
    "STATEMENT_INTAKE",
    required(id, "a statement intake ID", 128),
  );
  if (!intake) throw new Error("Statement intake not found.");
  return intake;
}
async function children(intake: StatementIntake) {
  const [rows, settlements, policies] = await Promise.all([
    store.list<IntakeRow>(intakeRowsKind(intake.id)),
    store.list<IntakeSettlement>("INTAKE_SETTLEMENT"),
    store.list<CommissionPolicy>("POLICY"),
  ]);
  return {
    rows,
    settlements: settlements.filter((s) => s.intakeId === intake.id),
    policies,
  };
}
const open = (intake: StatementIntake) => {
  if (intake.status !== "OPEN")
    throw new Error("This statement is voided and remains in history.");
};
const settlementRefKey = (carrierId: string, ref: string) =>
  hash(carrierId + "|" + ref.toLowerCase());

export async function intakeAction(
  event: Event,
  actor: string,
  operation: string,
  input: store.Data,
) {
  if (operation === "intakeWorkspace") {
    const [intakes, settlements, templates] = await Promise.all([
      store.list<StatementIntake>("STATEMENT_INTAKE"),
      store.list<IntakeSettlement>("INTAKE_SETTLEMENT"),
      store.list<CarrierImportTemplate>("CARRIER_IMPORT_TEMPLATE"),
    ]);
    return {
      ok: true,
      intakes: intakes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      settlements,
      templates,
    };
  }
  if (operation === "policyIntakeContext") {
    const access = new AccountAccess(event.identity, undefined, event.request);
    const policy = await access.requireRecord(
      "Policy",
      required(input.policyId, "a policy ID"),
    );
    const account = await access.requireRecord(
      "Account",
      required(policy.accountId, "the policy account"),
    );
    const workflow = await access.get(
      "Communication",
      "workflow:" + account.id,
    );
    const classification = await store.get("ACCOUNT", String(account.id));
    const quote = policy.quoteId
      ? await access.get("Quote", String(policy.quoteId))
      : undefined;
    return {
      ok: true,
      accountId: account.id,
      accountName: account.name,
      classification: classification ?? null,
      suggestedProducerId: object(workflow?.data).salespersonId ?? "",
      policyNumber: policy.policyNumber,
      effectiveDate: policy.effectiveDate ?? "",
      expirationDate: policy.expirationDate ?? "",
      boundOn: bindDay(policy.datePolicyBound) ?? "",
      premium: policy.premium ?? null,
      agencyRate: policy.commissionPct ?? null,
      updatedAt: policy.updatedAt,
      transaction: quote ? (quote.renewalPolicyId ? "RENEWAL" : "NEW") : "",
    };
  }
  if (operation === "saveCarrierImportTemplate") {
    const carrierId = required(input.carrierId, "a carrier", 128);
    const old = await store.get<CarrierImportTemplate>(
      "CARRIER_IMPORT_TEMPLATE",
      carrierId,
    );
    version(input, old);
    if (!(await store.get("CARRIER", carrierId)))
      throw new Error("Choose a configured carrier.");
    if (
      !Array.isArray(input.headers) ||
      !input.headers.length ||
      input.headers.length > 64
    )
      throw new Error("Choose a statement table with headers.");
    const headers = input.headers.map((h) => String(h).slice(0, 200));
    const raw = object(input.mapping);
    const mapping = {
      policy: integer(raw.policy, 0, headers.length - 1, "policy column"),
      reference: integer(
        raw.reference,
        0,
        headers.length - 1,
        "reference column",
      ),
      amount: integer(raw.amount, 0, headers.length - 1, "commission column"),
      effective: integer(
        raw.effective,
        -1,
        headers.length - 1,
        "effective date column",
      ),
      transaction: integer(
        raw.transaction,
        -1,
        headers.length - 1,
        "transaction column",
      ),
    };
    const used = Object.values(mapping).filter((i) => i >= 0);
    if (new Set(used).size !== used.length)
      throw new Error("Map each field to a distinct column.");
    await store.commit(
      [
        change(
          "CARRIER_IMPORT_TEMPLATE",
          { id: carrierId, carrierId, headers, mapping },
          old,
        ),
      ],
      actor,
    );
    return { ok: true };
  }
  if (operation === "saveStatementIntake") {
    const id = input.id
      ? required(input.id, "an intake ID", 128)
      : randomUUID();
    const old = await store.get<StatementIntake>("STATEMENT_INTAKE", id);
    version(input, old);
    if (old) open(old);
    const carrierId = required(input.carrierId, "a carrier", 128);
    const source = required(input.source, "the original source file");
    if (!/^statements\/[a-f0-9-]{36}$/.test(source))
      throw new Error("Upload the original statement first.");
    if (old && (old.source !== source || old.carrierId !== carrierId))
      throw new Error(
        "Keep the original file and carrier. Void an incorrect intake and add the correct statement.",
      );
    const reference = required(input.reference, "a statement reference", 200);
    const documentReceivedOn = day(input.documentReceivedOn);
    if (documentReceivedOn > today())
      throw new Error("The statement received date cannot be in the future.");
    const totalCents =
      input.totalCents === undefined || input.totalCents === null
        ? undefined
        : integer(
            input.totalCents,
            -MONEY_MAX,
            MONEY_MAX,
            "statement agency commission total",
          );
    if (
      old &&
      (old.totalCents !== totalCents || old.reference !== reference) &&
      (await store.list<IntakeSettlement>("INTAKE_SETTLEMENT")).some(
        (s) => s.intakeId === id && s.postedRows.length > 0,
      )
    )
      throw new Error(
        "Statement reference and total are frozen after posting begins. Use a correction statement.",
      );
    const carrier = await store.get<CarrierCommissionTerms>(
      "CARRIER",
      carrierId,
    );
    const crmCarrier = carrier
      ? undefined
      : await new AccountAccess(
          event.identity,
          undefined,
          event.request,
        ).requireRecord("Carrier", carrierId);
    let fileHash = old?.fileHash;
    if (!fileHash) {
      const file = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.COMMISSION_BUCKET,
          Key: source,
        }),
      );
      if (!file.Body || !file.ContentLength || file.ContentLength > 10_000_000)
        throw new Error("Attach a source file up to 10 MB.");
      fileHash = createHash("sha256")
        .update(await file.Body.transformToByteArray())
        .digest("hex");
      const duplicate = await store.get<{ intakeId: string }>(
        "INTAKE_FILE",
        hash(carrierId + "|" + fileHash),
      );
      if (duplicate)
        throw new Error(
          "This source file is already logged. Open its existing statement inbox record.",
        );
    }
    const referenceId = settlementRefKey(carrierId, reference);
    const referenceClaim = await store.get<{ intakeId: string }>(
      "INTAKE_REFERENCE",
      referenceId,
    );
    if (referenceClaim && referenceClaim.intakeId !== id)
      throw new Error("This carrier statement reference is already logged.");
    const intake: StatementIntake = {
      ...(old ?? {
        rowCount: 0,
        rowTotalCents: 0,
        needsReview: 0,
        unmatched: 0,
        postedCents: 0,
        completedRows: 0,
      }),
      id,
      version: old?.version ?? 0,
      carrierId,
      carrierName: carrier?.name ?? String(crmCarrier!.name),
      reference,
      source,
      fileHash,
      filename:
        old?.filename ?? required(input.filename, "the source filename", 250),
      documentReceivedOn,
      ...(input.statementDate
        ? { statementDate: day(input.statementDate) }
        : { statementDate: undefined }),
      totalCents,
      createdAt: old?.createdAt ?? new Date().toISOString(),
      createdBy: old?.createdBy ?? actor,
      status: "OPEN",
    };
    const changes = [change("STATEMENT_INTAKE", intake, old)];
    if (!old)
      changes.push(
        change("INTAKE_FILE", {
          id: hash(carrierId + "|" + fileHash),
          intakeId: id,
          fileHash,
        }),
      );
    if (!referenceClaim)
      changes.push(
        change("INTAKE_REFERENCE", { id: referenceId, intakeId: id }),
      );
    if (!carrier)
      changes.push(
        change(
          "CARRIER",
          receiptOnlyCarrierTerms({
            id: carrierId,
            name: String(crmCarrier!.name),
            version: 0,
          }),
        ),
      );
    await store.commit(changes, actor);
    return { ok: true, id };
  }
  const intake = await getIntake(input.id);
  if (operation === "getStatementIntake")
    return { ok: true, intake, ...(await children(intake)) };
  open(intake);
  if (operation === "getIntakeWorkingDraft" || operation === "saveIntakeWorkingDraft") {
    const scope = required(input.scope, "a draft section", 128);
    if (!/^(header|rows|import|settlement|allocation-[A-Za-z0-9_-]+)$/.test(scope))
      throw new Error("Unknown statement draft section.");
    // A caller cannot read or overwrite another Owner's private working copy.
    const id = hash(actor + "|" + intake.id + "|" + scope);
    const old = await store.get<store.Data & { version: number }>("INTAKE_WORKING_DRAFT", id);
    if (operation === "getIntakeWorkingDraft") return { ok: true, draft: old ?? null };
    version(input, old as { version: number } | undefined);
    if (input.baseVersion !== intake.version)
      throw new Error("This statement changed. Refresh and compare your working draft before saving.");
    const draftData = input.data === null ? null : object(input.data);
    if (Buffer.byteLength(JSON.stringify(draftData), "utf8") > 100_000)
      throw new Error("This working draft is too large. Save smaller groups of source rows.");
    const value = { id, intakeId: intake.id, ownerId: actor, scope,
      baseVersion: intake.version, savedAt: new Date().toISOString(), data: draftData };
    await store.commit([change("INTAKE_WORKING_DRAFT", value, old)], actor, [{
      ConditionCheck: { TableName: store.table(), Key: { kind: "STATEMENT_INTAKE", id: intake.id },
        ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" },
        ExpressionAttributeValues: { ":v": intake.version } },
    }]);
    return { ok: true, draft: { ...value, version: Number(old?.version ?? 0) + 1 } };
  }
  if (operation === "extractIntakeDocument") {
    const { extractIntakeDocument } = await import("./intake-extraction");
    return extractIntakeDocument(intake, actor, input);
  }
  if (operation === "saveIntakeRows") {
    version(input, intake);
    if (
      !Array.isArray(input.rows) ||
      !input.rows.length ||
      input.rows.length > INTAKE_EDIT_LIMIT
    )
      throw new Error("Save up to 20 rows at a time.");
    const { rows, settlements, policies } = await children(intake);
    const changes: store.Change[] = [];
    const next = new Map(rows.map((r) => [r.id, r]));
    const touched = new Set<string>();
    for (const raw of input.rows as IntakeRow[]) {
      if (touched.has(raw.id))
        throw new Error("A row appears twice in this save.");
      touched.add(raw.id);
      const old = next.get(raw.id);
      version(raw as unknown as store.Data, old);
      if (
        old &&
        settlements.some(
          (s) =>
            s.status !== "VOID" &&
            s.allocations.some((a) => a.rowId === old.id),
        )
      )
        throw new Error(
          "Allocated source rows are locked. Use a separate correction after posting.",
        );
      const row = validateIntakeRow(raw, intake.id, old);
      if (row.reviewStatus !== "PENDING" && input.confirmed !== true)
        throw new Error(
          "Confirm the policy matches and eligibility decisions before saving reviewed rows.",
        );
      if (
        row.reviewStatus !== "PENDING" &&
        row.importIssue &&
        input.extractionReviewed !== true
      )
        throw new Error(
          "Review and correct the extracted source values before confirming eligibility.",
        );
      if (row.reviewStatus !== "PENDING") {
        row.importIssue = undefined;
      }
      if (
        row.policyId &&
        !policies.some(
          (p) => p.id === row.policyId && p.carrierId === intake.carrierId,
        )
      )
        throw new Error("Choose a tracked policy for this carrier.");
      next.set(row.id, row);
      changes.push(
        change(
          intakeRowsKind(intake.id),
          {
            ...row,
            ...(row.reviewStatus !== "PENDING"
              ? { reviewedAt: new Date().toISOString(), reviewedBy: actor }
              : {}),
          },
          old,
        ),
      );
    }
    if (next.size > INTAKE_ROW_LIMIT)
      throw new Error("A statement supports up to 1,000 source rows.");
    changes.push(
      change(
        "STATEMENT_INTAKE",
        {
          ...intake,
          ...intakeSummary([...next.values()], intake.carrierId, policies),
        },
        intake,
      ),
    );
    await store.commit(changes, actor);
    return { ok: true };
  }
  if (operation === "voidStatementIntake") {
    version(input, intake);
    const { settlements } = await children(intake);
    if (settlements.some((s) => s.status !== "VOID"))
      throw new Error(
        "Resolve recorded settlements before voiding the statement. Posted receipts require a linked reversal.",
      );
    if (input.confirmed !== true)
      throw new Error("Confirm that this statement should be voided.");
    await store.commit(
      [
        change(
          "STATEMENT_INTAKE",
          {
            ...intake,
            status: "VOID",
            voidReason: required(input.reason, "the reason for voiding", 2000),
            voidedAt: new Date().toISOString(),
            voidedBy: actor,
          },
          intake,
        ),
      ],
      actor,
    );
    return { ok: true };
  }
  if (operation === "recordIntakeSettlement") {
    version(input, intake);
    const reference = required(
      input.reference,
      "the unique deposit or retained commission reference",
      200,
    );
    const id = settlementRefKey(intake.carrierId, reference);
    const existing = await store.get<IntakeSettlement>("INTAKE_SETTLEMENT", id);
    if (existing)
      throw new Error(
        "This settlement reference is already recorded. Open the existing settlement.",
      );
    const receivedOn = day(input.receivedOn);
    if (receivedOn > today())
      throw new Error("Record a settlement only after it occurs.");
    if (input.confirmed !== true)
      throw new Error(
        "Confirm actual receipt or retained commission evidence.",
      );
    if (
      !["DEPOSIT", "RETAINED", "NET_SETTLEMENT"].includes(
        String(input.settlementType),
      )
    )
      throw new Error("Choose the settlement type.");
    const settlement: IntakeSettlement = {
      id,
      version: 0,
      intakeId: intake.id,
      carrierId: intake.carrierId,
      reference,
      receivedOn,
      totalCents: integer(
        input.totalCents,
        -MONEY_MAX,
        MONEY_MAX,
        "verified agency commission settlement total",
      ),
      settlementType:
        input.settlementType as IntakeSettlement["settlementType"],
      evidence: required(
        input.evidence,
        "payment or retained commission evidence",
        2000,
      ),
      status: "RECORDED",
      allocations: [],
      postedRows: [],
      statementIds: [],
      createdAt: new Date().toISOString(),
      createdBy: actor,
    };
    await store.commit(
      [
        change("INTAKE_SETTLEMENT", settlement),
        change("SETTLEMENT", {
          id,
          intakeId: intake.id,
          intakeSettlementId: id,
          amount: settlement.totalCents,
        }),
        change("STATEMENT_INTAKE", intake, intake),
        await reconciliationChange(),
      ],
      actor,
    );
    return { ok: true, settlementId: id };
  }
  const settlement = await store.get<IntakeSettlement>(
    "INTAKE_SETTLEMENT",
    required(input.settlementId, "a settlement"),
  );
  if (!settlement || settlement.intakeId !== intake.id)
    throw new Error("This settlement does not belong to the statement.");
  if (operation === "postIntakeSettlement") {
    if (input.confirmed !== true)
      throw new Error("Confirm the reviewed settlement before posting.");
    const requestId = required(input.requestId, "a posting request ID", 128);
    const prior = await store.get<{
      intakeId: string;
      settlementId: string;
      result: unknown;
    }>("INTAKE_POST", requestId);
    if (prior) {
      if (prior.intakeId !== intake.id || prior.settlementId !== settlement.id)
        throw new Error(
          "This posting request was used for another settlement.",
        );
      return prior.result;
    }
    version(input, settlement);
    if (input.confirmed !== true || settlement.status !== "POSTING")
      throw new Error("Review and allocate this settlement before posting.");
    const { rows, policies, settlements } = await children(intake);
    validateSettlementAllocations(
      intake,
      rows,
      settlements,
      settlement,
      settlement.allocations,
      policies,
    );
    const remaining = settlement.allocations.filter(
      (a) => !settlement.postedRows.includes(a.rowId),
    );
    const batch = remaining.slice(0, INTAKE_POST_LIMIT);
    if (!batch.length) throw new Error("No unposted allocations remain.");
    const statementId = hash(
      "intake-post|" + settlement.id + "|" + settlement.postedRows.length,
    );
    const lines = batch.map((a) => {
      const row = rows.find((r) => r.id === a.rowId)!;
      return {
        policyId: row.policyId,
        lineRef: row.lineRef + " / " + statementId.slice(0, 12),
        kind: row.transactionType,
        agencyCents: a.amountCents,
        eligible: row.reviewStatus === "ELIGIBLE",
        reviewStatus: row.reviewStatus,
        eligibilityNote:
          row.note ||
          "Owner reviewed the source row, policy match and eligibility; applicable policy agreement snapshot retained.",
        ...(row.originalId ? { originalId: row.originalId } : {}),
        ...(row.sourceRow ? { sourceRow: row.sourceRow } : {}),
      };
    });
    const statement: CommissionStatement = {
      id: statementId,
      version: 0,
      carrierId: intake.carrierId,
      reference:
        intake.reference +
        " / settlement " +
        settlement.reference +
        " / part " +
        (settlement.statementIds.length + 1),
      source: intake.source,
      receivedOn: settlement.receivedOn,
      settlementRef: settlement.reference + " / part " + statementId,
      settlementType: settlement.settlementType,
      totalCents: sum(lines.map((l) => l.agencyCents)),
      status: "DRAFT",
      lines,
    };
    const changes = await statementPostingChanges(statement, actor);
    const guards: store.Transaction = [];
    for (const a of batch) {
      const row = rows.find((r) => r.id === a.rowId)!;
      const key = settlementRefKey(intake.carrierId, row.lineRef);
      const claim = await store.get<{
        id: string;
        intakeId: string;
        rowId: string;
      }>("INTAKE_TRANSACTION", key);
      if (claim && (claim.intakeId !== intake.id || claim.rowId !== row.id))
        throw new Error(
          "A carrier transaction is already associated with another source row.",
        );
      if (!claim)
        changes.push(
          change("INTAKE_TRANSACTION", {
            id: key,
            intakeId: intake.id,
            rowId: row.id,
          }),
        );
      guards.push(absent("CARRIER_TRANSACTION", key));
      changes.push(
        change(
          intakeRowsKind(intake.id),
          { ...row, postedCents: sum([row.postedCents, a.amountCents]) },
          row,
        ),
      );
    }
    const postedRows = [...settlement.postedRows, ...batch.map((a) => a.rowId)];
    const complete = postedRows.length === settlement.allocations.length;
    const updatedRows = rows.map((r) => ({
      ...r,
      postedCents: sum([
        r.postedCents,
        batch.find((a) => a.rowId === r.id)?.amountCents ?? 0,
      ]),
    }));
    const result = {
      ok: true,
      complete,
      postedRows: postedRows.length,
      totalRows: settlement.allocations.length,
      settlementVersion: settlement.version + 1,
    };
    changes.push(
      change(
        "INTAKE_SETTLEMENT",
        {
          ...settlement,
          postedRows,
          statementIds: [...settlement.statementIds, statementId],
          status: complete ? "POSTED" : "POSTING",
        },
        settlement,
      ),
      change(
        "STATEMENT_INTAKE",
        {
          ...intake,
          ...intakeSummary(updatedRows, intake.carrierId, policies),
        },
        intake,
      ),
      change("INTAKE_POST", {
        id: requestId,
        intakeId: intake.id,
        settlementId: settlement.id,
        result,
      }),
      await reconciliationChange(),
    );
    await store.commit(changes, actor, guards);
    return result;
  }
  version(input, settlement);
  if (operation === "voidIntakeSettlement") {
    if (settlement.postedRows.length || settlement.status === "POSTED")
      throw new Error(
        "Posted settlements require linked corrections, not voiding.",
      );
    if (settlement.status === "VOID")
      throw new Error("This settlement is already voided.");
    if (input.confirmed !== true)
      throw new Error(
        "Confirm the recorded payment was incorrect before voiding it.",
      );
    await store.commit(
      [
        change(
          "INTAKE_SETTLEMENT",
          {
            ...settlement,
            status: "VOID",
            voidReason: required(
              input.reason,
              "the correction reason and evidence",
              2000,
            ),
          },
          settlement,
        ),
        change("STATEMENT_INTAKE", intake, intake),
        await reconciliationChange(),
      ],
      actor,
    );
    return { ok: true };
  }
  if (operation === "allocateIntakeSettlement" || operation === "previewIntakeSettlement") {
    if (settlement.status !== "RECORDED" || (operation === "allocateIntakeSettlement" && input.confirmed !== true))
      throw new Error(
        "Confirm reviewed source rows and payment allocation before posting.",
      );
    const { rows, settlements, policies } = await children(intake);
    if (!Array.isArray(input.allocations))
      throw new Error("Allocate the settlement to source rows.");
    const allocations = (input.allocations as IntakeAllocation[]).map((a) => ({
      rowId: required(a.rowId, "a source row", 100),
      amountCents: integer(
        a.amountCents,
        -MONEY_MAX,
        MONEY_MAX,
        "allocated agency commission",
      ),
    }));
    validateSettlementAllocations(
      intake,
      rows,
      settlements,
      settlement,
      allocations,
      policies,
    );
    const financialPreview = assertStatementPostingPlan(
      {
        id: settlement.id,
        version: 0,
        carrierId: intake.carrierId,
        reference: intake.reference,
        source: intake.source,
        receivedOn: settlement.receivedOn,
        settlementRef: settlement.reference,
        settlementType: settlement.settlementType,
        totalCents: settlement.totalCents,
        status: "DRAFT",
        lines: allocations.map((a) => {
          const row = rows.find((r) => r.id === a.rowId)!;
          return {
            policyId: row.policyId,
            lineRef: row.lineRef,
            kind: row.transactionType,
            agencyCents: a.amountCents,
            eligible: row.reviewStatus === "ELIGIBLE",
            reviewStatus: row.reviewStatus,
            eligibilityNote:
              row.note || "Owner reviewed source values and eligibility",
            ...(row.originalId ? { originalId: row.originalId } : {}),
          };
        }),
      },
      policies,
      await store.list<CommissionEarning>("EARNING"),
    );
    const sourceKeys = allocations.map((a) => ({
      rowId: a.rowId,
      id: settlementRefKey(
        intake.carrierId,
        rows.find((r) => r.id === a.rowId)!.lineRef,
      ),
    }));
    const [claims, legacy] = await Promise.all([
      store.getMany<{ id: string; intakeId: string; rowId: string }>(
        sourceKeys.map((k) => ({ kind: "INTAKE_TRANSACTION", id: k.id })),
      ),
      store.getMany<{ id: string }>(
        sourceKeys.map((k) => ({ kind: "CARRIER_TRANSACTION", id: k.id })),
      ),
    ]);
    if (
      legacy.length ||
      claims.some(
        (c) =>
          c.intakeId !== intake.id ||
          c.rowId !== sourceKeys.find((k) => k.id === c.id)?.rowId,
      )
    )
      throw new Error(
        "A carrier transaction is already associated with another source row or earlier reconciliation.",
      );
    if (operation === "previewIntakeSettlement") return { ok: true, ...financialPreview };
    await store.commit(
      [
        change(
          "INTAKE_SETTLEMENT",
          { ...settlement, allocations, status: "POSTING" },
          settlement,
        ),
        change("STATEMENT_INTAKE", intake, intake),
        await reconciliationChange(),
      ],
      actor,
    );
    return { ok: true };
  }
  throw new Error("Unknown statement intake action.");
}

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { bindDay, firstBindDate } from './account-history';
import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { activeRole, type RoleRequest } from '../crm-access/active-role';
import { assertUserSession } from '../crm-access/user-status';
import { AccountAccess, tableName } from '../crm-access/access';
import { type Identity, object } from '../crm-access/policy';
import {
  appendEntry,
  day,
  decimal,
  required,
  integer,
  sum,
  validatePlan,
  validateCommissionAccount,
  selectCommissionTerms,
  type CommissionAccount,
  MONEY_MAX,
  validateAllocationSnapshot,
  COMMISSION_BASES,
  type CommissionPlan,
  type CarrierCommissionTerms,
  type CommissionPolicy,
  type CommissionStatement,
  type CommissionBatch,
  type StatementLine,
} from '../../../../shared/commissions';
import { bindPolicy } from './bind';
import {
  downloadContentDisposition,
  fileClient,
  fileSigningOptions,
} from '../crm-access/file-signing';
import * as store from './store';

const agencyToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const s3 = fileClient();
const data = (value: unknown) => value as store.Data & { id: string };
const change = (kind: string, value: unknown, previous?: unknown): store.Change => ({
  kind,
  value: data(value),
  ...(previous ? { previous: data(previous) } : {}),
});
const currentVersion = (input: store.Data, old: { version: number } | undefined) => {
  if (input.version !== (old?.version ?? 0))
    throw new Error('This record changed. Refresh before saving.');
};
export type Event = {
  fieldName?: string;
  info?: { fieldName?: string };
  identity?: Identity;
  request?: RoleRequest;
  arguments?: store.Data;
};
/** Check active role before any financial read or write. A Cognito Owner in an
 * Admin view cannot use owner commands; a forged header cannot grant membership. */
export function permitted(event: Event) {
  const actor = required(event.identity?.sub, 'a signed-in user', 128),
    role = activeRole(event.identity, event.request);
  if (!role) throw new Error('Sign in with an active CRM role.');
  const field = event.fieldName ?? event.info?.fieldName;
  if (field === 'commissionAction' && role !== 'OWNER')
    throw new Error(
      'Only the active Owner role can reconcile commissions or change commission records.',
    );
  if (!['commissionOverview', 'commissionAction', 'bindCommissionPolicy'].includes(field ?? ''))
    throw new Error('Unknown commission request.');
  return { actor, role, field };
}
export async function handler(event: Event) {
  try {
    const { actor, role, field } = permitted(event);
    await assertUserSession(event.identity);
    const args = event.arguments ?? {},
      input = object(args.input);
    if (field === 'bindCommissionPolicy') return { ok: true, ...(await bindPolicy(event, input)) };
    if (field === 'commissionOverview') {
      if (role !== 'OWNER') {
        // Query only this identity, then load authoritative records consistently:
        // GSI lag can delay discovery, but cannot expose old payment/ownership data.
        const refs = await store.list<{ kind: string; id: string }>(actor, true);
        const rows = await store.getMany<CommissionPolicy | CommissionBatch>(
          refs.filter((r) => ['POLICY', 'BATCH'].includes(r.kind)),
        );
        const ownPolicies = rows.filter(
          (r): r is CommissionPolicy => !!r && r.producerId === actor && 'entries' in r,
        );
        const ownBatches = rows.filter(
          (r): r is CommissionBatch => !!r && r.producerId === actor && 'payDate' in r,
        );
        validateAllocationSnapshot(ownPolicies, ownBatches);
        const policies = rows
          .filter((r): r is CommissionPolicy => !!r && r.producerId === actor && 'entries' in r)
          .map((p) => ({
            id: p.id,
            accountName: p.accountName,
            policyNumber: p.policyNumber,
            carrierName: p.carrierName,
            producerId: p.producerId,
            producerName: p.producerName,
            effectiveDate: p.effectiveDate,
            expirationDate: p.expirationDate,
            transaction: p.transaction,
            premiumCents: p.premiumCents,
            agencyRateUnits: p.agencyRateUnits,
            producerBps: p.producerBps,
            eligibility: p.eligibility,
            receiptsFrom: p.receiptsFrom,
            entries: p.entries.map((e) => ({
              id: e.id,
              lineRef: e.lineRef,
              receivedOn: e.receivedOn,
              kind: e.kind,
              agencyCents: e.agencyCents,
              producerCents: e.producerCents,
              originalId: e.originalId,
              batchId: e.batchId,
              eligible: e.eligible,
            })),
          }));
        return {
          ok: true,
          policies,
          batches: rows.filter((r) => r && r.producerId === actor && 'payDate' in r),
        };
      }
      const [plans, carriers, policies, statements, batches] = await Promise.all([
        store.list<CommissionPlan>('PLAN'),
        store.list<CarrierCommissionTerms>('CARRIER'),
        store.list<CommissionPolicy>('POLICY'),
        store.list<CommissionStatement>('STATEMENT'),
        store.list<CommissionBatch>('BATCH'),
      ]);
      validateAllocationSnapshot(policies, batches);
      return {
        ok: true,
        plans,
        carriers,
        policies,
        statements,
        batches,
      };
    }
    const operation = required(args.operation, 'an operation');
    if (operation === 'getAccountClassification') {
      const accountId = required(input.id, 'an account');
      const account = await new AccountAccess(
        event.identity,
        undefined,
        event.request,
      ).requireRecord('Account', accountId);
      const classification = await store.get<CommissionAccount>('ACCOUNT', accountId);
      return {
        ok: true,
        classification: classification ?? null,
        accountName: String(account.name),
      };
    }
    if (operation === 'saveAccountClassification') {
      const accountId = required(input.id, 'an account');
      const account = await new AccountAccess(
        event.identity,
        undefined,
        event.request,
      ).requireRecord('Account', accountId);
      const old = await store.get<CommissionAccount>('ACCOUNT', accountId);
      currentVersion(input, old);
      const firstBoundOn = Object.hasOwn(input, 'firstBoundOn')
        ? input.firstBoundOn
        : old?.firstBoundOn;
      const neverBound = Object.hasOwn(input, 'neverBound')
        ? input.neverBound
        : firstBoundOn
          ? undefined
          : old?.neverBound;
      const bindingEvidence = Object.hasOwn(input, 'bindingEvidence')
        ? input.bindingEvidence
        : old?.bindingEvidence;
      if (old?.firstBoundOn && neverBound)
        throw new Error('An account with a recorded first bind cannot be reset to never bound.');
      if (old?.firstBoundOn && (!firstBoundOn || day(firstBoundOn) > old.firstBoundOn))
        throw new Error(
          'A recorded original first bind date cannot be cleared or moved forward. Earlier corrections require supporting evidence.',
        );
      const classification = validateCommissionAccount({
        id: accountId,
        version: Number(input.version),
        name: String(account.name),
        ...(firstBoundOn ? { firstBoundOn: day(firstBoundOn) } : {}),
        ...(neverBound !== undefined ? { neverBound: neverBound as true } : {}),
        ...(firstBoundOn || neverBound
          ? { bindingEvidence: required(bindingEvidence, 'the first-bind history reference') }
          : {}),
        ...(old?.firstBindPolicyId ? { firstBindPolicyId: old.firstBindPolicyId } : {}),
        periods: input.periods as CommissionAccount['periods'],
      });
      if (classification.firstBoundOn && classification.firstBoundOn > agencyToday())
        throw new Error('The original first bind date cannot be in the future.');
      await store.commit([change('ACCOUNT', classification, old)], actor);
      return { ok: true };
    }
    if (operation === 'savePlan') {
      const producerId = required(input.producerId, 'a producer', 128);
      const access = new AccountAccess(event.identity, undefined, event.request);
      const profile = await access.get('Communication', `eligibility:${producerId}`);
      if (!profile || object(profile.data).userId !== producerId)
        throw new Error('Choose a teammate from the team roster.');
      const old = await store.get<CommissionPlan>('PLAN', producerId);
      currentVersion(input, old);
      const plan = validatePlan({
        id: producerId,
        version: Number(input.version),
        producerId,
        ...(input.accountBoundFrom ? { accountBoundFrom: day(input.accountBoundFrom) } : {}),
        ...(input.receiptsFrom ? { receiptsFrom: day(input.receiptsFrom) } : {}),
        name: required(input.name, 'the producer name'),
        terms: input.terms as CommissionPlan['terms'],
      });
      await store.commit([change('PLAN', plan, old)], actor);
      return { ok: true };
    }
    if (operation === 'saveCarrier') {
      const carrierId = required(input.id, 'a carrier');
      const carrier = await new AccountAccess(
        event.identity,
        undefined,
        event.request,
      ).requireRecord('Carrier', carrierId);
      const old = await store.get<CarrierCommissionTerms>('CARRIER', carrierId);
      currentVersion(input, old);
      if (!Object.hasOwn(COMMISSION_BASES, String(input.basis)))
        throw new Error('Choose the carrier commission basis.');
      const terms = {
        id: carrierId,
        name: String(carrier.name),
        version: Number(input.version),
        basis: input.basis,
        schedule: required(input.schedule, 'the remittance schedule'),
        evidence: required(input.evidence, 'the carrier agreement reference'),
      };
      await store.commit([change('CARRIER', terms, old)], actor);
      return { ok: true };
    }
    if (operation === 'adoptPolicy') {
      const access = new AccountAccess(event.identity, undefined, event.request);
      const policy = await access.requireRecord(
        'Policy',
        required(input.policyId, 'an existing policy'),
      );
      if (policy.commissionSnapshotId || (await store.get('POLICY', String(policy.id))))
        throw new Error('This policy already has a commission snapshot.');
      const account = await access.requireRecord(
        'Account',
        required(policy.accountId, 'the policy account'),
      );
      const producerId = required(input.producerId, 'the original producer'),
        boundOn = day(input.boundOn),
        effectiveDate = day(input.effectiveDate ?? policy.effectiveDate),
        expirationDate = day(input.expirationDate ?? policy.expirationDate);
      if (!['NEW', 'RENEWAL'].includes(String(input.transaction)))
        throw new Error('Confirm the original transaction type.');
      const plan = await store.get<CommissionPlan>('PLAN', producerId),
        carrierTerms = await store.get<CarrierCommissionTerms>('CARRIER', String(policy.carrierId));
      if (!plan || !carrierTerms)
        throw new Error('Configure the original producer agreement and carrier terms first.');
      const rateDate = input.transaction === 'RENEWAL' ? effectiveDate : boundOn;
      const commissionAccount = await store.get<CommissionAccount>('ACCOUNT', String(account.id));
      let cursor: store.Data | undefined;
      let earliestKnown: string | undefined;
      if (commissionAccount?.firstBoundOn) {
        for (let page = 0; ; page++) {
          if (page === 100) throw new Error('Could not finish checking account policy history.');
          const found = await store.db.send(
            new QueryCommand({
              TableName: tableName('Policy'),
              IndexName: process.env.COMMISSION_POLICY_ACCOUNT_INDEX,
              KeyConditionExpression: 'accountId = :account',
              ExpressionAttributeValues: { ':account': account.id },
              ExclusiveStartKey: cursor,
            }),
          );
          for (const priorPolicy of found.Items ?? []) {
            const bound = bindDay(priorPolicy.datePolicyBound);
            if (bound && (!earliestKnown || bound < earliestKnown)) earliestKnown = bound;
          }
          cursor = found.LastEvaluatedKey;
          if (!cursor) break;
        }
      }
      const accountFirstBoundOn = firstBindDate(commissionAccount, boundOn, true, earliestKnown);
      const selectedTerms = selectCommissionTerms(
        plan,
        commissionAccount,
        rateDate,
        input.transaction as 'NEW' | 'RENEWAL',
        accountFirstBoundOn,
      );
      required(input.evidence, 'evidence of original producer attribution and policy terms');
      if (boundOn > agencyToday())
        throw new Error('A historical bind date cannot be in the future.');
      if (expirationDate <= effectiveDate)
        throw new Error('The policy term dates must be valid before adding commission tracking.');
      const premiumCents = integer(
        decimal(required(input.premium, 'the confirmed policy premium')),
        1,
        MONEY_MAX,
        'premium',
      );
      const agencyRateUnits = integer(
        decimal(required(input.agencyRate, 'the confirmed agency commission rate'), 4),
        0,
        1_000_000,
        'agency rate',
      );
      const snapshot: CommissionPolicy = {
        id: String(policy.id),
        version: 0,
        accountId: String(policy.accountId),
        accountName: String(account.name),
        quoteId: String(policy.quoteId ?? ''),
        policyNumber: String(policy.policyNumber || policy.id),
        carrierId: String(policy.carrierId),
        carrierName: carrierTerms.name,
        producerId,
        producerName: plan.name,
        boundAt: boundOn, // Historical source establishes a date, not an invented time.
        effectiveDate,
        expirationDate,
        transaction: input.transaction as 'NEW' | 'RENEWAL',
        premiumCents,
        agencyRateUnits,
        ...selectedTerms,
        planVersion: plan.version,
        carrierTerms,
        entries: [],
      };
      await store.commit(
        [
          change('POLICY', {
            ...snapshot,
            migrationEvidence: input.evidence,
            originalTermDates: {
              effectiveDate: policy.effectiveDate ?? null,
              expirationDate: policy.expirationDate ?? null,
            },
          }),
        ],
        actor,
        [
          {
            Update: {
              TableName: tableName('Policy'),
              Key: { id: policy.id },
              UpdateExpression:
                'SET commissionSnapshotId = :id, premium = :premium, commissionPct = :rate, effectiveDate = :effective, expirationDate = :expiration, updatedAt = :at, lastWriteBy = :actor',
              ConditionExpression:
                'updatedAt = :old AND attribute_not_exists(commissionSnapshotId)',
              ExpressionAttributeValues: {
                ':id': policy.id,
                ':old': policy.updatedAt,
                ':premium': premiumCents / 100,
                ':rate': agencyRateUnits / 10000,
                ':effective': effectiveDate,
                ':expiration': expirationDate,
                ':at': new Date().toISOString(),
                ':actor': actor,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: store.table(),
              Key: { kind: 'PLAN', id: producerId },
              ConditionExpression: '#v = :v',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':v': plan.version },
            },
          },
          {
            ConditionCheck: {
              TableName: store.table(),
              Key: { kind: 'CARRIER', id: carrierTerms.id },
              ConditionExpression: '#v = :v',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':v': carrierTerms.version },
            },
          },
          {
            ConditionCheck: {
              TableName: store.table(),
              Key: { kind: 'ACCOUNT', id: account.id },
              ConditionExpression: '#v = :v',
              ExpressionAttributeNames: { '#v': 'version' },
              ExpressionAttributeValues: { ':v': commissionAccount!.version },
            },
          },
        ],
      );
      return { ok: true };
    }
    if (operation === 'updatePolicyNumber') {
      const id = required(input.id, 'a policy'),
        snapshot = await store.get<CommissionPolicy>('POLICY', id);
      if (!snapshot) throw new Error('Commission policy not found.');
      currentVersion(input, snapshot);
      const policy = await new AccountAccess(
        event.identity,
        undefined,
        event.request,
      ).requireRecord('Policy', id);
      const policyNumber = required(input.policyNumber, 'the carrier policy number', 200);
      await store.commit([change('POLICY', { ...snapshot, policyNumber }, snapshot)], actor, [
        {
          Update: {
            TableName: tableName('Policy'),
            Key: { id },
            UpdateExpression: 'SET policyNumber = :number, updatedAt = :at, lastWriteBy = :actor',
            ConditionExpression: 'updatedAt = :old',
            ExpressionAttributeValues: {
              ':number': policyNumber,
              ':at': new Date().toISOString(),
              ':actor': actor,
              ':old': policy.updatedAt,
            },
          },
        },
      ]);
      return { ok: true };
    }
    if (operation === 'file') {
      const Bucket = process.env.COMMISSION_BUCKET;
      if (!Bucket) throw new Error('Private statement storage is not configured.');
      if (input.action === 'upload') {
        const bytes = integer(input.size, 1, 20 * 1024 * 1024, 'file size'),
          key = `statements/${randomUUID()}`;
        const type = required(input.contentType, 'a file type');
        if (
          ![
            'application/pdf',
            'text/csv',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'image/png',
            'image/jpeg',
          ].includes(type)
        )
          throw new Error('Upload a PDF, CSV, XLSX, PNG, or JPEG statement.');
        const url = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket,
            Key: key,
            ContentType: type,
            ContentLength: bytes,
            Metadata: {
              filename: encodeURIComponent(required(input.filename, 'the original filename', 200)),
            },
            IfNoneMatch: '*',
          }),
          fileSigningOptions,
        );
        return { ok: true, key, url };
      }
      const key = required(input.key, 'a statement file');
      if (!/^statements\/[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid statement file.');
      const source = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      const filename = source.Metadata?.filename
        ? decodeURIComponent(source.Metadata.filename)
        : 'carrier-statement';
      return {
        ok: true,
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket,
            Key: key,
            ResponseContentDisposition: downloadContentDisposition(filename),
          }),
          fileSigningOptions,
        ),
      };
    }
    if (operation === 'saveStatement') {
      const carrierId = required(input.carrierId, 'a carrier'),
        reference = required(input.reference, 'the carrier statement reference');
      const id = hash(`${carrierId}|${reference.toLowerCase()}`),
        old = await store.get<CommissionStatement>('STATEMENT', id);
      currentVersion(input, old);
      if (old?.status === 'POSTED')
        throw new Error('Posted statements are immutable. Record linked adjustments instead.');
      if (!(await store.get('CARRIER', carrierId)))
        throw new Error('Configure carrier terms first.');
      const source = required(input.source, 'the source statement file');
      if (!/^statements\/[a-f0-9-]{36}$/.test(source))
        throw new Error('Attach the original statement.');
      await s3.send(
        new HeadObjectCommand({
          Bucket: process.env.COMMISSION_BUCKET,
          Key: source,
        }),
      );
      const lines = input.lines as StatementLine[];
      if (!Array.isArray(lines) || !lines.length || lines.length > 20)
        throw new Error('Enter 1–20 statement lines per reconciliation batch.');
      if (!['DEPOSIT', 'RETAINED', 'NET_SETTLEMENT'].includes(String(input.settlementType)))
        throw new Error('Choose the settlement type.');
      const statement: CommissionStatement = {
        id,
        version: Number(input.version),
        carrierId,
        reference,
        source,
        receivedOn: day(input.receivedOn),
        settlementRef: required(
          input.settlementRef,
          'a unique deposit or settlement allocation reference',
        ),
        settlementType: input.settlementType as CommissionStatement['settlementType'],
        totalCents: integer(input.totalCents, -MONEY_MAX, MONEY_MAX, 'settlement total'),
        lines: lines.map((l) => ({
          ...(l.reportedPremiumCents != null
            ? {
                reportedPremiumCents: integer(
                  l.reportedPremiumCents,
                  -MONEY_MAX,
                  MONEY_MAX,
                  'carrier premium basis',
                ),
              }
            : {}),
          ...(l.reportedRateUnits != null
            ? {
                reportedRateUnits: integer(
                  l.reportedRateUnits,
                  0,
                  1_000_000,
                  'carrier commission rate',
                ),
              }
            : {}),
          policyId: required(l.policyId, 'a matched policy'),
          lineRef: required(l.lineRef, 'a unique carrier transaction reference'),
          kind: l.kind,
          agencyCents: integer(l.agencyCents, -MONEY_MAX, MONEY_MAX, 'agency commission'),
          eligible: l.eligible,
          eligibilityNote: required(l.eligibilityNote, 'eligibility and variance review notes'),
          ...(l.originalId ? { originalId: required(l.originalId, 'an original entry') } : {}),
        })),
        status: 'DRAFT',
      };
      if (statement.receivedOn > agencyToday())
        throw new Error('A receipt cannot be future dated.');
      if (new Set(statement.lines.map((l) => l.lineRef.toLowerCase())).size !== lines.length)
        throw new Error('Carrier transaction references must be unique.');
      if (sum(statement.lines.map((l) => l.agencyCents)) !== statement.totalCents)
        throw new Error('Statement lines must equal the verified settlement allocation total.');
      // Validate matching/adjustments now and again against fresh records at posting.
      const policies = new Map(
        (
          await store.getMany<CommissionPolicy>(
            [...new Set(statement.lines.map((line) => line.policyId))].map((id) => ({
              kind: 'POLICY',
              id,
            })),
          )
        ).map((policy) => [policy.id, policy]),
      );
      for (const line of statement.lines) {
        const policy = policies.get(line.policyId);
        if (!policy || policy.carrierId !== carrierId)
          throw new Error('Each line must match a policy for this carrier.');
        policies.set(policy.id, appendEntry(policy, line, statement, `${id}:${line.lineRef}`));
      }
      await store.commit([change('STATEMENT', statement, old)], actor);
      return { ok: true };
    }
    if (operation === 'postStatement') {
      const statement = await store.get<CommissionStatement>(
        'STATEMENT',
        required(input.id, 'a statement'),
      );
      if (!statement) throw new Error('Statement not found.');
      if (statement.status === 'POSTED') return { ok: true }; // Durable retry after lost response.
      currentVersion(input, statement);
      if (sum(statement.lines.map((l) => l.agencyCents)) !== statement.totalCents)
        throw new Error('Statement control totals do not balance.');
      if (input.confirmed !== true)
        throw new Error('Confirm settlement evidence and line eligibility before posting.');
      const changes: store.Change[] = [],
        originals = new Map<string, CommissionPolicy>(),
        updated = new Map<string, CommissionPolicy>();
      for (const line of statement.lines) {
        const original =
          originals.get(line.policyId) ??
          (await store.get<CommissionPolicy>('POLICY', line.policyId));
        if (!original || original.carrierId !== statement.carrierId)
          throw new Error('A policy match is no longer available.');
        originals.set(original.id, original);
        updated.set(
          original.id,
          appendEntry(
            updated.get(original.id) ?? original,
            line,
            statement,
            `${statement.id}:${line.lineRef}`,
          ),
        );
        changes.push(
          change('CARRIER_TRANSACTION', {
            id: hash(`${statement.carrierId}|${line.lineRef.toLowerCase()}`),
            statementId: statement.id,
          }),
        );
      }
      for (const [id, value] of updated) changes.push(change('POLICY', value, originals.get(id)));
      changes.push(
        change('SETTLEMENT', {
          id: hash(`${statement.carrierId}|${statement.settlementRef.toLowerCase()}`),
          statementId: statement.id,
          amount: statement.totalCents,
        }),
      );
      changes.push(
        change(
          'STATEMENT',
          {
            ...statement,
            status: 'POSTED',
            postedAt: new Date().toISOString(),
            postedBy: actor,
          },
          statement,
        ),
      );
      await store.commit(changes, actor);
      return { ok: true };
    }
    if (operation === 'preparePayroll') {
      const producerId = required(input.producerId, 'a producer'),
        cutoff = day(input.cutoff),
        payDate = day(input.payDate),
        id = required(input.requestId, 'a payroll request ID', 128);
      if (cutoff > payDate) throw new Error('The cutoff must not follow the pay date.');
      const existing = await store.get<CommissionBatch>('BATCH', id);
      if (existing) {
        if (
          existing.producerId !== producerId ||
          existing.cutoff !== cutoff ||
          existing.payDate !== payDate
        )
          throw new Error('Payroll request ID was already used.');
        return { ok: true };
      }
      const refs = await store.list<{ id: string }>(producerId, true, 'POLICY');
      const policies = (
        await store.getMany<CommissionPolicy>(refs.map((r) => ({ kind: 'POLICY', id: r.id })))
      ).filter((p) => p.producerId === producerId);
      const changes: store.Change[] = [],
        lines: CommissionBatch['lines'] = [];
      for (const p of policies) {
        const entries = p.entries.map((e) => {
          if (e.kind !== 'RECEIPT' || e.batchId || e.producerCents <= 0 || e.receivedOn > cutoff)
            return e;
          lines.push({
            policyId: p.id,
            entryId: e.id,
            accountName: p.accountName,
            policyNumber: p.policyNumber,
            agencyCents: e.agencyCents,
            producerBps: p.producerBps,
            amountCents: e.producerCents,
          });
          return { ...e, batchId: id };
        });
        if (entries.some((e, i) => e !== p.entries[i]))
          changes.push(change('POLICY', { ...p, entries }, p));
      }
      if (!lines.length)
        throw new Error('There are no unpaid, unbatched earnings through this cutoff.');
      if (changes.length > 70 || lines.length > 500)
        throw new Error('Payroll is too large. Use an earlier cutoff to prepare smaller batches.');
      const batch: CommissionBatch = {
        id,
        version: 0,
        producerId,
        producerName: policies[0].producerName,
        cutoff,
        payDate,
        status: 'APPROVED',
        totalCents: sum(lines.map((l) => l.amountCents)),
        lines,
      };
      await store.commit([...changes, change('BATCH', batch)], actor);
      return { ok: true };
    }
    if (operation === 'payPayroll' || operation === 'cancelPayroll') {
      const batch = await store.get<CommissionBatch>('BATCH', required(input.id, 'a batch'));
      if (!batch) throw new Error('Payroll batch not found.');
      const target = operation === 'payPayroll' ? 'PAID' : 'CANCELLED';
      if (batch.status === target) return { ok: true };
      currentVersion(input, batch);
      if (batch.status !== 'APPROVED')
        throw new Error('Only an approved, unpaid batch can change status.');
      const changes: store.Change[] = [];
      if (target === 'CANCELLED')
        for (const policyId of new Set(batch.lines.map((l) => l.policyId))) {
          const policy = await store.get<CommissionPolicy>('POLICY', policyId);
          if (!policy) throw new Error('Policy history is missing.');
          const entries = policy.entries.map((e) => {
            if (e.batchId !== batch.id) return e;
            const { batchId: _batch, ...rest } = e;
            return rest;
          });
          changes.push(change('POLICY', { ...policy, entries }, policy));
        }
      const reference = required(
        input.reference,
        target === 'PAID' ? 'the confirmed payroll payment reference' : 'the cancellation reason',
      );
      const payDate = target === 'PAID' ? day(input.payDate) : batch.payDate;
      if (target === 'PAID' && payDate > agencyToday())
        throw new Error('Confirm payment only after it occurs.');
      await store.commit(
        [...changes, change('BATCH', { ...batch, status: target, reference, payDate }, batch)],
        actor,
      );
      return { ok: true };
    }
    throw new Error('Unknown commission action.');
  } catch (error) {
    const conflict = ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(
      (error as Error).name,
    );
    return {
      ok: false,
      error: conflict
        ? 'The record changed or this statement, settlement, or carrier transaction was already posted. Refresh and check the ledger before retrying.'
        : error instanceof Error
          ? error.message
          : 'Commission operation failed.',
    };
  }
}

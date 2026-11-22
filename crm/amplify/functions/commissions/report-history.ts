import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { PayrollCycle, PayrollReport } from '../../../../shared/commissionPayroll';
import type { CommissionBatch } from '../../../../shared/commissions';
import { cycleBatches } from '../../../../shared/commissionPayroll';
import * as store from './store';
import { commissionReportFiles } from './reports';

// DynamoDB map order is not stable; hashes must not depend on property order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function freezeReport(cycle: PayrollCycle, batches: CommissionBatch[], actor: string): PayrollReport {
  const { preview: _preview, ...frozenCycle } = cycle;
  const selected = cycleBatches(cycle, batches);
  return { id: `${cycle.id}:${cycle.revision}`, version: 0, cycle: frozenCycle, batches: selected,
    contentHash: createHash('sha256').update(canonical([frozenCycle, selected])).digest('hex'), createdAt: cycle.approvedAt!, createdBy: actor };
}
export async function readReport(cycleId: string, revision: number): Promise<PayrollReport | undefined> {
  const report = await store.get<PayrollReport>('PAYROLL_REPORT', `${cycleId}:${revision}`);
  if (report) {
    try {
      if (report.cycle.id !== cycleId || report.cycle.revision !== revision || freezeReport(report.cycle, report.batches, report.createdBy).contentHash !== report.contentHash) throw new Error('Mismatch');
    } catch { throw new Error('The approved report snapshot failed its integrity check.'); }
  }
  return report;
}
/** Exact PDF bytes, not a re-render of a later ledger or report template. */
export async function archiveReport(cycle: PayrollCycle, batches: CommissionBatch[], actor: string) {
  const report = freezeReport(cycle, batches, actor);
  const files = await commissionReportFiles(cycle, batches);
  if (files.reduce((n, f) => n + f.content.byteLength, 0) > 5 * 1024 * 1024) throw new Error('Approved payroll PDFs exceed the delivery limit. Use smaller off-cycle groups.');
  report.documents = files.map((f, i) => ({ id: `${report.id}:${i}`, documentId: i ? report.batches[i - 1].id : 'summary', filename: f.filename, contentType: f.contentType, sha256: createHash('sha256').update(f.content).digest('hex') }));
  return [{ kind: 'PAYROLL_REPORT', value: report as unknown as store.Data & { id: string } }, ...files.map((f, i) => ({ kind: 'PAYROLL_REPORT_FILE', value: { ...report.documents![i], reportId: report.id, encoding: 'gzip-base64', content: gzipSync(f.content).toString('base64') } }))];
}
export async function reportFiles(report: PayrollReport, documentId?: string) {
  if (!report.documents?.length) throw new Error('The approved PDF archive is unavailable.');
  const selected = report.documents.filter(d => !documentId || d.documentId === documentId);
  if (!selected.length) throw new Error('Employee report is not part of this cycle.');
  const rows = await store.getMany<{ id: string; reportId: string; content: string; encoding: string }>(selected.map(d => ({ kind: 'PAYROLL_REPORT_FILE', id: d.id })));
  return selected.map(d => {
    const row = rows.find(r => r.id === d.id);
    if (!row || row.reportId !== report.id || row.encoding !== 'gzip-base64') throw new Error('Approved PDF archive is incomplete.');
    const content = gunzipSync(Buffer.from(row.content, 'base64'), { maxOutputLength: 5 * 1024 * 1024 });
    if (createHash('sha256').update(content).digest('hex') !== d.sha256) throw new Error('Approved PDF failed its integrity check.');
    return { filename: d.filename, contentType: d.contentType, content };
  });
}

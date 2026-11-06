interface SampleReportDocument { id: string; group: string; label: string; scenario: string; cycleId: string; revision: number; documentId: string; audience: string; producerId: string; title: string; totalCents: number | null; filename: string; content: string; contentType: string; }
const catalogs = import.meta.glob<{ documents: SampleReportDocument[] }>('./report-samples.generated.json', { eager: true, import: 'default' });
const catalog = catalogs['./report-samples.generated.json'] ?? { documents: [] };

export const sampleReportDocuments = catalog.documents;
export function visibleSampleReports(owner: boolean) {
  return sampleReportDocuments.filter(d => owner || (d.audience === 'EMPLOYEE' && d.producerId === 'producer'));
}
export function samplePayrollFiles(input: Record<string, unknown>) {
  if (input.id !== '2026-11') throw new Error('No sample report exists for this cycle.');
  if (input.revision !== undefined && input.historicalConfirmed !== true) throw new Error('Acknowledge historical records before downloading.');
  const revision = input.revision ?? 2;
  if (revision !== 1 && revision !== 2) throw new Error('No sample exists for this revision.');
  const selected = sampleReportDocuments.filter(d => d.scenario === 'exceptions' && d.cycleId === input.id &&
    d.revision === revision && (!input.documentId || d.documentId === input.documentId));
  if (!selected.length) throw new Error('The requested employee report is not in this sample.');
  return {files:selected.map(({filename,content,contentType})=>({filename,content,contentType}))};
}

import { commissionAction } from './commissions';

export type StatementAttachment = { key: string; uploaded: boolean };

/** Return an evidence key only after the private upload succeeds. */
export async function attachCommissionStatement(file: File): Promise<StatementAttachment> {
  const contentType = /\.csv$/i.test(file.name)
    ? 'text/csv'
    : /\.xlsx$/i.test(file.name)
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : file.type || 'application/pdf';
  const result = await commissionAction<{ key: string; url: string }>('file', {
    action: 'upload', size: file.size, contentType, filename: file.name,
  });
  const response = await fetch(result.url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'If-None-Match': '*' },
    body: file,
  });
  if (!response.ok) throw new Error('Statement upload failed.');
  return { key: result.key, uploaded: true };
}

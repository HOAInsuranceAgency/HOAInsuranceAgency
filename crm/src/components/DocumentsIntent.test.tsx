import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: {
  Document: { create: h.create, update: h.update, observeQuery: () => ({ subscribe: ({ next }: any) => { next({ items: [], isSynced: true }); return { unsubscribe() {} }; } }) },
  Quote: { list: async () => ({ data: [{ id: 'q1', lines: ['Property'], effectiveDate: '2026-10-01' }] }) },
  Policy: { list: async () => ({ data: [{ id: 'p1', policyNumber: 'POL-1' }] }) },
} }) }));
vi.mock('aws-amplify/auth', () => ({ getCurrentUser: async () => ({ userId: 'test' }) }));
vi.mock('aws-amplify/storage', () => ({ uploadData: () => ({ result: Promise.resolve() }), getUrl: vi.fn(), remove: vi.fn() }));
vi.mock('./FileButton', () => ({ default: ({ onFiles, id }: any) => <button id={id} onClick={() => onFiles([new File(['test'], 'example.pdf', { type: 'application/pdf' })])}>Choose test file</button> }));
import DocumentsPanel from './DocumentsPanel';
beforeEach(() => { vi.clearAllMocks(); h.create.mockResolvedValue({ data: { id: 'doc' } }); h.update.mockResolvedValue({ data: {} }); });
it('keeps the list association filter independent from the explicit destination for new files', async () => {
  render(<DocumentsPanel entityType="ACCOUNT" entityId="account" linkAccountId="account" />);
  await screen.findByRole('option', { name: /Quote — Property/ });
  fireEvent.change(screen.getByLabelText('Linked to'), { target: { value: 'quote:q1' } });
  fireEvent.click(screen.getByRole('button', { name: /Upload documents/ }));
  expect(screen.getByLabelText('Attach new files to')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Attach new files to'), { target: { value: 'policy:p1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  await waitFor(() => expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'account', policyId: 'p1', quoteId: null })));
  expect(screen.getByLabelText('Linked to')).toHaveValue('quote:q1');
});

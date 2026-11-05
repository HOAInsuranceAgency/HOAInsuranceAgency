import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ send: vi.fn(), void: vi.fn(), invoice: vi.fn(), certificate: vi.fn(), service: vi.fn(), agreement: vi.fn() }));
vi.mock('./client', () => ({ client: { mutations: {
  sendInvoice: calls.send, voidInvoice: calls.void, reserveInvoiceNumber: calls.invoice,
  reserveCertificateNumber: calls.certificate, servicePfLoan: calls.service, generatePfAgreement: calls.agreement,
} } }));
import { reserveInvoiceNumber, reserveCertificateNumber, sendInvoice, voidInvoice, serviceFinanceLoan } from './billingApi';
beforeEach(() => vi.resetAllMocks());

it('accepts no-ok counter contracts and never invents a missing reserved number', async () => {
  calls.invoice.mockResolvedValue({ data: JSON.stringify(JSON.stringify({ invoiceNumber: 'INV-123' })) });
  calls.certificate.mockResolvedValue({ data: { certificateNumber: 'CERT-123' } });
  expect(await reserveInvoiceNumber()).toBe('INV-123');
  expect(await reserveCertificateNumber()).toBe('CERT-123');
  calls.invoice.mockResolvedValue({ data: { invoiceNumber: null } });
  await expect(reserveInvoiceNumber()).rejects.toThrow('Nothing was created');
  expect(calls.invoice).toHaveBeenCalledTimes(2);
});
it('retains the exact send identity and sends no automatic retry after a lost response', async () => {
  const input = { invoiceId: 'invoice', toEmail: 'board@example.test', expectedSentAt: '2026-11-05T12:00:00Z' };
  calls.send.mockRejectedValue(new Error('Response lost'));
  await expect(sendInvoice(input)).rejects.toThrow('Response lost');
  expect(calls.send).toHaveBeenCalledExactlyOnceWith(input);
  calls.send.mockResolvedValue({ data: { ok: true, sentAt: '2026-11-05T13:00:00Z', sentTo: input.toEmail } });
  expect(await sendInvoice(input)).toMatchObject({ sentTo: input.toEmail });
  expect(calls.send.mock.calls[1][0]).toEqual(input);
});
it('keeps all GraphQL denial evidence at the send/void boundary', async () => {
  const errors = [{ message: 'Temporary read problem' }, { message: 'Inactive account', errorType: 'Unauthorized' }];
  calls.send.mockResolvedValue({ errors }); calls.void.mockResolvedValue({ errors });
  await expect(sendInvoice({ invoiceId: 'invoice' })).rejects.toMatchObject({ name: 'Unauthorized', errors, origin: 'graphql' });
  await expect(voidInvoice('invoice')).rejects.toMatchObject({ name: 'Unauthorized', errors, origin: 'graphql' });
  expect(calls.void).toHaveBeenCalledExactlyOnceWith({ invoiceId: 'invoice' });
});
it('refuses malformed installment receipts without repeating the payment action', async () => {
  calls.service.mockResolvedValue({ data: { ok: true, posted: { n: '2' } } });
  await expect(serviceFinanceLoan({ loanId: 'loan', action: 'POST_PAYMENT' })).rejects.toThrow('Refused.');
  expect(calls.service).toHaveBeenCalledExactlyOnceWith({ loanId: 'loan', action: 'POST_PAYMENT' });
});

import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { closeInvoiceCheckoutSessions } from '../../amplify/functions/invoiceCheckout';

type Session = Pick<Stripe.Checkout.Session, 'id' | 'status' | 'payment_status'> & Partial<Pick<Stripe.Checkout.Session, 'payment_intent'>>;
function fixture(pages: Session[][], intentStatus: Stripe.PaymentIntent.Status = 'requires_payment_method') {
  const expire = vi.fn(async (id: string) => ({ id, status: 'expired' }));
  const retrieve = vi.fn(async (id: string) => ({ id, status: intentStatus }));
  const list = vi.fn(() => (async function* () { for (const page of pages) for (const session of page) yield session; })());
  const stripe = { checkout: { sessions: { list, expire } }, paymentIntents: { retrieve } } as unknown as Stripe;
  return { stripe, expire, retrieve, list };
}
const open = (id: string): Session => ({ id, status: 'open', payment_status: 'unpaid' });
const completed = (payment_intent: Session['payment_intent'] = 'pi'): Session => ({ id: 'complete', status: 'complete', payment_status: 'unpaid', payment_intent });

describe('closing the checkout sessions behind an invoice Payment Link', () => {
  it('expires every open session across all returned pages and leaves expired sessions alone', async () => {
    const f = fixture([[open('one'), { id: 'expired', status: 'expired', payment_status: 'unpaid' }], [open('two')]]);
    await closeInvoiceCheckoutSessions(f.stripe, 'plink');
    expect(f.list).toHaveBeenCalledWith({ payment_link: 'plink', limit: 100 });
    expect(f.expire.mock.calls).toEqual([['one'], ['two']]); expect(f.retrieve).not.toHaveBeenCalled();
  });
  it.each(['canceled', 'requires_payment_method'] as const)('allows a completed unpaid attempt whose actual intent is %s', async status => {
    const f = fixture([[completed(status === 'canceled' ? { id: 'pi' } as Stripe.PaymentIntent : 'pi'), open('retry')]], status);
    await closeInvoiceCheckoutSessions(f.stripe, 'plink');
    expect(f.retrieve).toHaveBeenCalledWith('pi'); expect(f.expire).toHaveBeenCalledWith('retry');
  });
  it.each(['requires_action', 'requires_confirmation', 'requires_capture', 'processing', 'succeeded'] as const)('refuses a completed checkout whose intent is %s', async status => {
    const f = fixture([[completed(), open('later')]], status);
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('already been submitted');
    expect(f.expire).not.toHaveBeenCalled();
  });
  it('refuses a paid session even if its reported checkout status is still open', async () => {
    const f = fixture([[{ ...open('paid'), payment_status: 'paid' }]]);
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('already been submitted');
    expect(f.retrieve).not.toHaveBeenCalled(); expect(f.expire).not.toHaveBeenCalled();
  });
  it('refuses a completed checkout without an identifiable intent', async () => {
    const f = fixture([[completed(null)]]);
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('already been submitted');
    expect(f.retrieve).not.toHaveBeenCalled();
  });
  it('refuses an unverified session state', async () => {
    const f = fixture([[{ ...open('unknown'), status: null }]]);
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('could not be verified');
  });
  it('does not continue when a checkout expiration fails', async () => {
    const f = fixture([[open('one'), open('two')]]); f.expire.mockRejectedValueOnce(new Error('Stripe unavailable'));
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('Stripe unavailable');
    expect(f.expire.mock.calls).toEqual([['one']]);
  });
  it('does not continue when a completed intent cannot be retrieved', async () => {
    const f = fixture([[completed(), open('later')]]); f.retrieve.mockRejectedValueOnce(new Error('Intent lookup unavailable'));
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('Intent lookup unavailable');
    expect(f.expire).not.toHaveBeenCalled();
  });
  it('refuses an incomplete history beyond the 500-session bound', async () => {
    const f = fixture([Array.from({ length: 501 }, (_, index) => open(`session-${index}`))]);
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('too many payment sessions');
    expect(f.expire).toHaveBeenCalledTimes(500);
  });
  it('propagates a pagination failure instead of reporting every session closed', async () => {
    const f = fixture([]);
    f.list.mockReturnValue((async function* () { yield open('first'); throw new Error('Next page unavailable'); })());
    await expect(closeInvoiceCheckoutSessions(f.stripe, 'plink')).rejects.toThrow('Next page unavailable');
    expect(f.expire).toHaveBeenCalledWith('first');
  });
});

import type Stripe from 'stripe';

/** A disabled Payment Link leaves its already-open checkout sessions payable. */
export async function closeInvoiceCheckoutSessions(stripe: Stripe, linkId: string): Promise<void> {
  let count = 0;
  for await (const session of stripe.checkout.sessions.list({ payment_link: linkId, limit: 100 })) {
    if (++count > 500) throw new Error('This invoice has too many payment sessions to close automatically. Review its payments before replacing or voiding its link.');
    if (session.payment_status === 'paid') throw new Error('A payment on this invoice has already been submitted. Wait for it to settle or fail before replacing or voiding its link.');
    if (session.status === 'complete') {
      const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      const intent = intentId ? await stripe.paymentIntents.retrieve(intentId) : undefined;
      if (!intent || !['canceled', 'requires_payment_method'].includes(intent.status)) throw new Error('A payment on this invoice has already been submitted. Wait for it to settle or fail before replacing or voiding its link.');
    } else if (session.status === 'open') {
      await stripe.checkout.sessions.expire(session.id);
    } else if (session.status !== 'expired') {
      throw new Error('The invoice payment session could not be verified. Retry before replacing or voiding its link.');
    }
  }
}

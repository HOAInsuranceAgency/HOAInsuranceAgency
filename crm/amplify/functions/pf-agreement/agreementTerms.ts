/**
 * The agreement's fixed legal text, dependency-free.
 *
 * Lives apart from the PDF drawing so the election page's handler can serve
 * the same paragraphs the PDF prints without bundling pdf-lib into a public
 * hot path. What the customer signs on the election page and what the
 * agreement PDF says must be one text — this module is where that is true.
 * Everything here is reviewed with the spec; the ownership disclosure is
 * VERBATIM from the signed brief and test-pinned.
 */

/** Verbatim and prominent — the sentence the whole conflict disclosure is. */
export const OWNERSHIP_DISCLOSURE =
  "The lender under this agreement is HOA Insurance Agency LLC, the same company that placed your insurance. We earn interest on this loan in addition to commission on the policy. You are free to finance elsewhere or pay the premium in full.";

export const POWER_OF_ATTORNEY =
  "POWER OF ATTORNEY. The Borrower irrevocably appoints the Lender its attorney-in-fact, effective only upon default under this agreement, to cancel the insurance policy identified above, to request and receive from the insurer all unearned premium and unearned dividends, and to apply the amounts received against the Borrower's outstanding balance. Any surplus after payoff will be returned to the Borrower.";

export const PREPAYMENT_TERMS =
  "PREPAYMENT. The Borrower may prepay the outstanding balance in full at any time. On prepayment the Borrower owes only the outstanding principal balance; the refund of unearned finance charge is computed by the actuarial method, and the origination fee is refunded in full. No penalty, minimum charge, or additional fee applies to prepayment.";

export const CANCELLATION_PROCEDURE =
  "CANCELLATION ON DEFAULT. If an installment is not paid when due, the Lender will mail the Borrower written notice of intent to cancel, with a United States Postal Service certificate of mailing, at least 15 days before any cancellation request is made. If the default is not cured within that period, the Lender may request cancellation of the policy from the insurer and will send the Borrower notice of the cancellation request at the same time. Unearned premium returned by the insurer, expected within 30 days of the cancellation effective date, is applied to the Borrower's balance under the power of attorney above.";

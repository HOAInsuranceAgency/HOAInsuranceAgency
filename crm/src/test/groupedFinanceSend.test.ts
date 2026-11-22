import { describe, expect, it, vi } from "vitest";
import { renderInvoice } from "../../amplify/functions/send-invoice/invoice";

const invoice = vi.hoisted(() => vi.fn());
vi.mock("../../amplify/functions/data-client", () => ({
  createDataClientGetter: () => async () => ({ models: { Invoice: { get: invoice } } }),
}));
import { handler } from "../../amplify/functions/send-invoice/handler";

describe("retired in-house financing", () => {
  it.each(["DRAFT", "SENT"])("refuses a %s grouped invoice before publishing any payment route", async status => {
    invoice.mockResolvedValue({ data: { id: "legacy-group", status, sourcePricingVersion: 3 } });
    await expect(handler({ arguments: { invoiceId: "legacy-group" } })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining("In-house financing has ended"),
    });
  });

  it("keeps a regular invoice payable and omits any historical financing offer", () => {
    const historical = { associationName: "Example HOA", paymentUrl: "https://buy.stripe.com/pay",
      lines: [{ description: "Premium", retailAmount: 100 }],
      finance: { url: "https://example.test/finance/?t=old" } };
    const { html, text } = renderInvoice(historical);
    for (const message of [html, text]) {
      expect(message).toContain(historical.paymentUrl);
      expect(message).not.toContain(historical.finance.url);
    }
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  Policy: { list: vi.fn() },
  PfLoan: { list: vi.fn() },
  PfOverride: { list: vi.fn(), create: vi.fn() },
  PfCounselOpinion: { list: vi.fn() },
  PfNotice: { list: vi.fn() },
  Document: { list: vi.fn() },
}));
const mutations = vi.hoisted(() => ({
  issueFinanceQuote: vi.fn(),
  generatePfAgreement: vi.fn(),
  servicePfLoan: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models, mutations }),
}));

import { FinancingTab } from "./FinancingTab";
import type { Account } from "../../lib/client";

/** Servicing displays automatic enrollment and preserves installment posting safeguards. */

const account = {
  id: "a1",
  state: "MA",
  stage: "CLIENT",
  type: "ASSOCIATION",
  name: "TEST — Finance Path HOA",
} as unknown as Account;

const page = <T,>(data: T[]) => Promise.resolve({ data, nextToken: undefined });

const quotedLoan = {
  id: "loan-q",
  accountId: "a1",
  policyId: "p1",
  status: "QUOTED",
  state: "MA",
  configSha256: "abc",
  premium: 100000,
  downPct: 25,
  months: 11,
  apr: 14,
  effectiveDate: "2026-08-23",
  downPayment: 25000,
  amountFinanced: 75000,
  payment: 7304.68,
  totalInterest: 5351.46,
  originationFee: 10,
  schedule: "[]",
  balance: null,
  nextDueAt: null,
  paidThrough: null,
  quotedAt: "2026-08-23T00:00:00.000Z",
};

const activeLoan = {
  ...quotedLoan,
  id: "loan-a",
  status: "ACTIVE",
  balance: 68570.32,
  nextDueAt: "2026-10-23",
  paidThrough: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  models.Policy.list.mockImplementation(() => page([]));
  models.PfOverride.list.mockImplementation(() => page([]));
  models.PfCounselOpinion.list.mockImplementation(() => page([]));
  models.PfNotice.list.mockImplementation(() => page([]));
  models.Document.list.mockImplementation(() => page([]));
  models.PfLoan.list.mockImplementation(() => page([quotedLoan]));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("servicing reliability", () => {
  it("holds duplicate posting and loan switching until the updated loan finishes loading", async () => {
    const saved = deferred<{ data: string }>();
    const refreshed = deferred<{ data: typeof activeLoan[] }>();
    models.PfLoan.list.mockResolvedValueOnce({ data: [activeLoan] }).mockReturnValueOnce(refreshed.promise);
    mutations.servicePfLoan.mockReturnValue(saved.promise);
    await openServicing();

    const post = screen.getByRole("button", { name: "Post payment 3 of 12" });
    fireEvent.click(post);
    fireEvent.click(post);
    expect(mutations.servicePfLoan).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    await act(async () => saved.resolve({ data: JSON.stringify({ ok: true }) }));
    expect(post).toBeDisabled();
    expect(screen.getByText("$68,570.32")).toBeInTheDocument();
    await act(async () => refreshed.resolve({ data: [{ ...activeLoan, paidThrough: 2, balance: 62000 }] }));
    expect(await screen.findByRole("button", { name: "Post payment 4 of 12" })).toBeEnabled();
    expect(screen.getByText("$62,000.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("retains a successfully posted loan after a refresh failure and retries only its read", async () => {
    models.PfLoan.list.mockResolvedValueOnce({ data: [activeLoan] })
      .mockResolvedValueOnce({ data: [], errors: [{ message: "Loan read unavailable" }] })
      .mockResolvedValueOnce({ data: [{ ...activeLoan, paidThrough: 2 }] });
    mutations.servicePfLoan.mockResolvedValue({ data: JSON.stringify({ ok: true }) });
    await openServicing();
    await userEvent.click(screen.getByRole("button", { name: "Post payment 3 of 12" }));

    expect(await screen.findByText(/Payment posted\. Could not refresh financing/)).toBeInTheDocument();
    expect(screen.getByText("$68,570.32")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh financing" }));
    expect(await screen.findByRole("button", { name: "Post payment 4 of 12" })).toBeEnabled();
    expect(mutations.servicePfLoan).toHaveBeenCalledTimes(1);
  });

  it("reconciles an uncertain mutation error before another payment can be posted", async () => {
    models.PfLoan.list.mockResolvedValueOnce({ data: [activeLoan] })
      .mockRejectedValueOnce(new Error("Read failed"))
      .mockResolvedValueOnce({ data: [{ ...activeLoan, paidThrough: 2 }] });
    mutations.servicePfLoan.mockRejectedValue(new Error("Connection lost"));
    await openServicing();
    await userEvent.click(screen.getByRole("button", { name: "Post payment 3 of 12" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh financing" }));
    expect(await screen.findByRole("button", { name: "Post payment 4 of 12" })).toBeEnabled();
    expect(mutations.servicePfLoan).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "GraphQL", "generic refusal", "ledger refusal"])("retains the target installment after a %s failure and stale successful reads", async failure => {
    models.PfLoan.list.mockResolvedValueOnce({ data: [activeLoan] })
      .mockResolvedValueOnce({ data: [activeLoan] })
      .mockResolvedValueOnce({ data: [activeLoan] })
      .mockResolvedValueOnce({ data: [{ ...activeLoan, paidThrough: 2 }] });
    if (failure === "transport") mutations.servicePfLoan.mockRejectedValue(new Error("Connection lost"));
    else if (failure === "GraphQL") mutations.servicePfLoan.mockResolvedValue({ data: null, errors: [{ message: "Response unavailable" }] });
    else mutations.servicePfLoan.mockResolvedValue({ data: JSON.stringify({ ok: false, error: failure === "generic refusal"
      ? "Servicing action failed. Try again."
      : "The loan changed underneath posting installment 2. The payment is on the ledger; reconcile the loan by hand before anything else." }) });
    await openServicing();
    await userEvent.click(screen.getByRole("button", { name: "Post payment 3 of 12" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment status is unconfirmed");
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh financing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The requested payment is not yet confirmed");
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh financing" }));
    expect(await screen.findByRole("button", { name: "Post payment 4 of 12" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(mutations.servicePfLoan).toHaveBeenCalledTimes(1);
  });

  it("does not infer a definitive posting outcome from a familiar refusal message", async () => {
    models.PfLoan.list.mockResolvedValue({ data: [activeLoan] });
    mutations.servicePfLoan.mockResolvedValue({ data: JSON.stringify({ ok: false, error: "The loan's schedule is unreadable." }) });
    await openServicing();
    await userEvent.click(screen.getByRole("button", { name: "Post payment 3 of 12" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The loan's schedule is unreadable.");
    expect(screen.getByRole("alert")).toHaveTextContent("Payment status is unconfirmed");
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh financing" })).toBeEnabled();
    expect(mutations.servicePfLoan).toHaveBeenCalledTimes(1);
  });

  it("does not treat a successful read omitting the loan as payment confirmation", async () => {
    models.PfLoan.list.mockResolvedValueOnce({ data: [activeLoan] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ ...activeLoan, paidThrough: 2 }] });
    mutations.servicePfLoan.mockRejectedValue(new Error("Connection lost"));
    await openServicing();
    await userEvent.click(screen.getByRole("button", { name: "Post payment 3 of 12" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment status is unconfirmed");
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
    expect(screen.queryByText(/No financing on this association/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh financing" }));
    expect(await screen.findByRole("button", { name: "Post payment 4 of 12" })).toBeEnabled();
    expect(mutations.servicePfLoan).toHaveBeenCalledTimes(1);
  });

  it("keeps posting locked when a successful read still returns the pre-payment installment", async () => {
    models.PfLoan.list.mockResolvedValueOnce({ data: [activeLoan] })
      .mockResolvedValueOnce({ data: [activeLoan] })
      .mockResolvedValueOnce({ data: [{ ...activeLoan, paidThrough: 2 }] });
    mutations.servicePfLoan.mockResolvedValue({ data: JSON.stringify({ ok: true, posted: { n: 2 } }) });
    await openServicing();
    await userEvent.click(screen.getByRole("button", { name: "Post payment 3 of 12" }));
    expect(await screen.findByText(/Payment posted\. Could not refresh financing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh financing" }));
    expect(await screen.findByRole("button", { name: "Post payment 4 of 12" })).toBeEnabled();
    expect(mutations.servicePfLoan).toHaveBeenCalledTimes(1);
  });

  it("resets cancellation and certificate drafts when switching loans", async () => {
    const defaulted = { ...activeLoan, status: "DEFAULTED" };
    models.PfLoan.list.mockResolvedValue({ data: [defaulted, { ...defaulted, id: "loan-b" }] });
    models.PfNotice.list.mockImplementation(({ filter }) => page([{
      id: `intent-${filter.loanId.eq}`, loanId: filter.loanId.eq,
      type: "INTENT_TO_CANCEL", occurredAt: "2026-09-01T00:00:00Z",
    }]));
    render(<FinancingTab account={account} />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Service" }))[0]);
    fireEvent.change(await screen.findByLabelText("Cancellation effective"), { target: { value: "2026-10-01" } });
    fireEvent.change(await screen.findByLabelText("Notice"), { target: { value: "intent-loan-a" } });
    await userEvent.type(screen.getByLabelText("Certificate number"), "receipt-A");
    await userEvent.click(screen.getByRole("button", { name: "Service" }));
    expect(await screen.findByLabelText("Cancellation effective")).toHaveValue("");
    expect(await screen.findByLabelText("Certificate number")).toHaveValue("");
    expect(screen.getByLabelText("Notice")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Request cancellation" })).toBeDisabled();
  });

  it("surfaces notice and bound-policy read failures and retries without hiding the loan", async () => {
    models.PfLoan.list.mockResolvedValue({ data: [{ ...activeLoan, status: "DEFAULTED", quoteId: "q1", policyId: null }] });
    models.PfNotice.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Notice read failed" }] })
      .mockResolvedValue({ data: [] });
    models.Policy.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Policy read failed" }] })
      .mockResolvedValue({ data: [{ id: "p1", policyNumber: "HOA-1" }] });
    await openServicing();
    expect(await screen.findByText("Notice read failed")).toBeInTheDocument();
    expect(await screen.findByText("Policy read failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record notice of intent to cancel" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry notices" }));
    expect(screen.getByRole("button", { name: "Record notice of intent to cancel" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry bound policy" }));
    expect(await screen.findByRole("button", { name: "Roll to policy" })).toBeEnabled();
    expect(screen.getByText("$68,570.32")).toBeInTheDocument();
  });

  it("retries an initial loan failure without claiming the account has no financing", async () => {
    models.PfLoan.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Loan read failed" }] })
      .mockResolvedValueOnce({ data: [activeLoan] });
    render(<FinancingTab account={account} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Loan read failed");
    expect(screen.queryByText(/No financing on this association/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry financing" }));
    expect(await screen.findByText("$68,570.32")).toBeInTheDocument();
  });

  it("isolates late servicing responses and open loan state after an account switch", async () => {
    const pending = deferred<{ data: string }>();
    models.PfLoan.list.mockImplementation(({ filter }) => page(filter.accountId.eq === "a1" ? [activeLoan] : []));
    mutations.servicePfLoan.mockReturnValue(pending.promise);
    const view = render(<FinancingTab account={account} />);
    await userEvent.click(await screen.findByRole("button", { name: "Service" }));
    await userEvent.click(screen.getByRole("button", { name: "Post payment 3 of 12" }));
    view.rerender(<FinancingTab account={{ ...account, id: "a2" }} />);
    expect(await screen.findByText(/No financing on this association/)).toBeInTheDocument();
    await act(async () => pending.resolve({ data: JSON.stringify({ ok: true }) }));
    expect(screen.queryByText("$68,570.32")).not.toBeInTheDocument();
    expect(screen.queryByText("Servicing")).not.toBeInTheDocument();
    expect(screen.queryByText("Payment posted.")).not.toBeInTheDocument();
  });
});

const openServicing = async () => {
  render(<FinancingTab account={account} />);
  const service = await screen.findByRole("button", { name: "Service" });
  await userEvent.click(service);
};

describe("automatic enrollment", () => {
  it("shows pending settlement without requiring staff activation or a document upload", async () => {
    models.PfLoan.list.mockImplementation(() => page([{ ...quotedLoan, downPaymentIntentId: "pi_pending" }]));
    await openServicing();
    expect(await screen.findByText(/Initial payment is processing/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate loan" })).not.toBeInTheDocument();
    expect(models.Document.list).not.toHaveBeenCalled();
    expect(mutations.servicePfLoan).not.toHaveBeenCalled();
  });
});

describe("origination has no UI — servicing reaches every loan", () => {
  it("keeps a closed-jurisdiction ACTIVE loan visible and serviceable", async () => {
    const closed = { ...account, state: "NY" } as unknown as Account;
    models.PfLoan.list.mockImplementation(() => page([activeLoan]));
    mutations.servicePfLoan.mockResolvedValue({ data: JSON.stringify({ ok: true }) });

    render(<FinancingTab account={closed} />);

    // W8: origination happens at invoice send, never here — no policy
    // picker, no offer button, on any account in any state.
    expect(await screen.findByText("$68,570.32")).toBeInTheDocument();
    expect(screen.queryByLabelText("Policy to finance")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Offer financing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issue quote" })).not.toBeInTheDocument();

    // The loan stays serviceable whatever the jurisdiction says about NEW
    // lending: the gate applies at origination only, and we cannot un-lend.
    await userEvent.click(screen.getByRole("button", { name: "Service" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Post payment 3 of 12" })
    );
    await waitFor(() =>
      expect(mutations.servicePfLoan).toHaveBeenCalledWith({
        loanId: "loan-a",
        action: "POST_PAYMENT",
      })
    );
  });

  it("points an empty account at the invoice flow instead of a form", async () => {
    models.PfLoan.list.mockImplementation(() => page([]));
    render(<FinancingTab account={account} />);
    expect(
      await screen.findByText(/Offers originate automatically\s+when an invoice is sent/)
    ).toBeInTheDocument();
  });
});

describe("ACCEPTED loans and autopay", () => {
  it("shows automatic enrollment on a legacy ACCEPTED loan", async () => {
    models.PfLoan.list.mockImplementation(() =>
      page([
        {
          ...quotedLoan,
          status: "ACCEPTED",
          electedAt: "2026-08-24T01:00:00.000Z",
          downPaidAt: "2026-08-24T01:00:00.000Z",
          stripeCustomerId: "cus_1",
          stripePaymentMethodId: "pm_1",
        },
      ])
    );
    await openServicing();

    expect(await screen.findByText("ACCEPTED")).toBeInTheDocument();
    expect(
      screen.getByText(/down payment received.*autopay\s+mandate on file/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Monthly collections are enabled automatically/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate loan" })).not.toBeInTheDocument();
    expect(models.Document.list).not.toHaveBeenCalled();
  });

  it("holds the posting button while a debit is clearing", async () => {
    models.PfLoan.list.mockImplementation(() =>
      page([
        {
          ...activeLoan,
          stripeCustomerId: "cus_1",
          stripePaymentMethodId: "pm_1",
          autopayPendingIntentId: "pi_pending",
          autopayPendingInstallment: 2,
        },
      ])
    );
    await openServicing();

    expect(
      await screen.findByText("Autopay: a debit for installment 2 is clearing.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeDisabled();
  });

  it("says autopay is on when a mandate is filed and nothing is clearing", async () => {
    models.PfLoan.list.mockImplementation(() =>
      page([{ ...activeLoan, stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" }])
    );
    await openServicing();

    expect(
      await screen.findByText(/Autopay is on — due installments debit themselves/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post payment 3 of 12" })).toBeEnabled();
  });
});

describe("loan money and payment numbering", () => {
  it("renders loan money to the cent and leaves absent balances as an em dash", async () => {
    render(<FinancingTab account={account} />);
    expect(await screen.findByText("$75,000.00")).toBeInTheDocument();
    expect(screen.getByText("$7,304.68")).toBeInTheDocument();
    // The QUOTED loan has no balance yet — absent must not become $0.00.
    const row = screen.getByText("$75,000.00").closest("tr")!;
    expect(row.textContent).toContain("—");
  });

  it("numbers financed installment n as payment n+1 of the full schedule", async () => {
    models.PfLoan.list.mockImplementation(() => page([activeLoan]));
    render(<FinancingTab account={account} />);
    await userEvent.click(await screen.findByRole("button", { name: "Service" }));
    // paidThrough 1 of an 11-installment loan: next posting is payment 3 of 12.
    expect(
      await screen.findByRole("button", { name: "Post payment 3 of 12" })
    ).toBeInTheDocument();
  });
});

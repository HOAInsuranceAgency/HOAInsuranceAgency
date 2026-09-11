import { render, screen, waitFor } from "@testing-library/react";
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
  vi.clearAllMocks();
  models.Policy.list.mockImplementation(() => page([]));
  models.PfOverride.list.mockImplementation(() => page([]));
  models.PfCounselOpinion.list.mockImplementation(() => page([]));
  models.PfNotice.list.mockImplementation(() => page([]));
  models.Document.list.mockImplementation(() => page([]));
  models.PfLoan.list.mockImplementation(() => page([quotedLoan]));
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
    models.Document.list.mockImplementation(() =>
      page([
        { id: "d-exec", name: "Board resolution — signed.pdf", category: "PF_RESOLUTION_EXECUTED" },
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

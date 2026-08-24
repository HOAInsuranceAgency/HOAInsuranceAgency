import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

/**
 * The quote engine, gate, and eligibility rules have their own suites under
 * lib/premiumFinance; the servicing Lambda has its own. What is asserted here
 * is what this screen decides for itself: activation offers the account's
 * executed resolutions by NAME (Documents expose no id anywhere, so a paste-an-id
 * input was a dead end), loan money renders to the cent, and the posting button
 * numbers financed installment n as payment n+1 — the down payment is payment 1
 * everywhere the schedule is shown.
 */

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

describe("activation resolution picker", () => {
  it("offers the account's executed resolutions by name and activates with the chosen id", async () => {
    models.Document.list.mockImplementation(() =>
      page([
        { id: "d-exec", name: "Board resolution — signed.pdf", category: "PF_RESOLUTION_EXECUTED" },
        { id: "d-exec-2", name: "Board resolution — prior term.pdf", category: "PF_RESOLUTION_EXECUTED" },
      ])
    );
    mutations.servicePfLoan.mockResolvedValue({ data: JSON.stringify({ ok: true }) });

    await openServicing();

    const picker = await screen.findByLabelText("Executed resolution");
    expect(picker.tagName).toBe("SELECT");
    await waitFor(() =>
      expect(models.Document.list).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: {
            entityId: { eq: "a1" },
            category: { eq: "PF_RESOLUTION_EXECUTED" },
          },
        })
      )
    );
    await screen.findByRole("option", { name: "Board resolution — signed.pdf" });

    const activate = screen.getByRole("button", { name: "Activate loan" });
    expect(activate).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Board resolution executed"), {
      target: { value: "2026-08-23" },
    });
    await userEvent.selectOptions(picker, "d-exec");
    expect(activate).toBeEnabled();

    await userEvent.click(activate);
    await waitFor(() =>
      expect(mutations.servicePfLoan).toHaveBeenCalledWith({
        loanId: "loan-q",
        action: "ACTIVATE",
        boardResolutionExecutedAt: "2026-08-23",
        boardResolutionDocumentId: "d-exec",
      })
    );
  });

  it("says when nothing is on file and keeps activation disabled", async () => {
    await openServicing();

    await screen.findByText(
      "None on file — upload the signed copy under “Executed board resolution” on the Documents tab."
    );
    fireEvent.change(screen.getByLabelText("Board resolution executed"), {
      target: { value: "2026-08-23" },
    });
    expect(screen.getByRole("button", { name: "Activate loan" })).toBeDisabled();
  });
});

describe("closed jurisdictions and existing loans", () => {
  it("blocks origination but keeps the ACTIVE loan and its servicing reachable", async () => {
    const closed = { ...account, state: "NY" } as unknown as Account;
    models.PfLoan.list.mockImplementation(() => page([activeLoan]));
    mutations.servicePfLoan.mockResolvedValue({ data: JSON.stringify({ ok: true }) });

    render(<FinancingTab account={closed} />);

    // Origination is refused with the signed note, verbatim…
    expect(
      await screen.findByText("No agent exemption, no commercial carve-out")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Offer financing" })).toBeDisabled();
    expect(screen.queryByLabelText("Policy to finance")).not.toBeInTheDocument();

    // …while the loan stays visible and serviceable: the gate applies at
    // origination only and must never touch servicing of existing loans.
    expect(screen.getByText("$68,570.32")).toBeInTheDocument();
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
});

describe("ACCEPTED loans and autopay", () => {
  it("shows the election and offers activation on an ACCEPTED loan", async () => {
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
    // The paper gate is unchanged: activation is offered, with the picker.
    expect(await screen.findByLabelText("Executed resolution")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate loan" })).toBeInTheDocument();
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

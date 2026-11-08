import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ models: { PfCounselOpinion: { list: vi.fn() }, PfLoan: { list: vi.fn() } } }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => api }));
import { FinanceOfferHint } from "./FinanceOfferHint";
import type { Account } from "../lib/client";
import { jurisdictionFor } from "../../../shared/premiumFinance/gate";
import { financeInterestLimit, financePricing } from "../../../shared/premiumFinance/pricing";
import { buildQuote, effectiveAprWithFee } from "../../../shared/premiumFinance/quote";
import { formatMoney } from "../../../shared/invoiceTotals";

const today = "2026-11-07";
const props = {
  account: { id: "a1", state: "MA", type: "ASSOCIATION" } as Account,
  anchor: { id: "p1", kind: "policy" as const, lines: ["Commercial Property"] },
  retailTotal: 100000,
};
const conditionalProps = { ...props, account: { ...props.account, state: "OH" } as Account, retailTotal: 200000 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${today}T15:00:00Z`));
  api.models.PfLoan.list.mockResolvedValue({ data: [] });
  api.models.PfCounselOpinion.list.mockResolvedValue({ data: [] });
});
afterEach(() => { vi.useRealTimers(); });

it("reads later counsel opinion pages before deciding whether financing is available", async () => {
  api.models.PfCounselOpinion.list.mockResolvedValueOnce({ data: [], nextToken: "next" })
    .mockResolvedValueOnce({ data: [{ effectiveAt: "2026-01-01", reviewBy: "2027-01-01" }] });
  render(<FinanceOfferHint {...conditionalProps} />);
  expect(await screen.findByText("Financing will be offered")).toBeInTheDocument();
  expect(api.models.PfCounselOpinion.list).toHaveBeenLastCalledWith(expect.objectContaining({ nextToken: "next" }));
});
it("shows failed checks as errors with retry instead of a false financing decision", async () => {
  api.models.PfCounselOpinion.list.mockResolvedValueOnce({ data: [], errors: [{ message: "Opinion check failed" }] })
    .mockResolvedValueOnce({ data: [{ effectiveAt: "2026-01-01", reviewBy: "2027-01-01" }] });
  render(<FinanceOfferHint {...conditionalProps} />);
  expect(await screen.findByText(/Opinion check failed/)).toBeInTheDocument();
  expect(screen.queryByText("Financing won't be offered with this email")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry financing check" }));
  expect(await screen.findByText("Financing will be offered")).toBeInTheDocument();
});

it("previews the Massachusetts rate with the origination fee inside the 20% ceiling", async () => {
  const pricing = financePricing(jurisdictionFor("MA")!, {
    premium: props.retailTotal, downPct: 25, months: 11, effectiveDate: today,
  })!;
  expect(pricing.apr).toBeLessThan(20);
  expect(pricing.apr).toBeGreaterThan(19);
  expect(effectiveAprWithFee(pricing.quote)).toBeLessThanOrEqual(20);

  render(<FinanceOfferHint {...props} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`${pricing.apr}% APR`);
  expect(banner).toHaveTextContent(`11 monthly payments of ${formatMoney(pricing.quote.payment)}`);
  expect(banner).not.toHaveTextContent("14% APR");
});

it("previews the 18% agency rate in an uncapped state", async () => {
  const quote = buildQuote({ premium: props.retailTotal, downPct: 25, months: 11, apr: 18, effectiveDate: today });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state: "HI" } as Account} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent("18% APR");
  expect(banner).toHaveTextContent(`11 monthly payments of ${formatMoney(quote.payment)}`);
});

it("does not preview an automatic rate for Nevada without a filed schedule", async () => {
  render(<FinanceOfferHint {...props} account={{ ...props.account, state: "NV" } as Account} />);
  expect(await screen.findByText("Financing won't be offered with this email")).toBeInTheDocument();
  expect(screen.queryByText("Financing will be offered")).not.toBeInTheDocument();
  expect(screen.queryByText(/18% APR/)).not.toBeInTheDocument();
});

it("uses the existing blocked banner when the fee cannot fit within the rate ceiling", async () => {
  render(<FinanceOfferHint {...props} retailTotal={1} />);
  const banner = (await screen.findByText("Financing won't be offered with this email")).closest(".offer-banner");
  expect(banner).toHaveTextContent("Financing won't be offered with this email — the bill still sends.");
  expect(screen.queryByText("Financing will be offered")).not.toBeInTheDocument();
});

it.each(["DE", "KS"])("prices an early %s invoice from the coverage inception instead of the send date", async state => {
  const jurisdiction = jurisdictionFor(state)!;
  const inputs = { premium: props.retailTotal, downPct: 25, months: 11, effectiveDate: today };
  const atInception = financePricing(jurisdiction, { ...inputs, coverageEffectiveDate: today })!;
  const early = financePricing(jurisdiction, { ...inputs, coverageEffectiveDate: "2026-12-01" })!;
  expect(early.apr).toBeLessThan(atInception.apr);
  expect(early.quote.totalInterest).toBeLessThan(atInception.quote.totalInterest);
  expect(financeInterestLimit(jurisdiction, early.quote, "2026-12-01"))
    .toBeLessThan(financeInterestLimit(jurisdiction, atInception.quote, today)!);

  render(<FinanceOfferHint {...props} account={{ ...props.account, state } as Account}
    anchor={{ ...props.anchor, coverageEffectiveDate: "2026-12-01" }} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`${early.apr}% APR`);
  expect(banner).toHaveTextContent(formatMoney(early.quote.payment));
});

it.each(["DE", "KS"])("does not preview a new %s offer without its coverage inception date", async state => {
  render(<FinanceOfferHint {...props} account={{ ...props.account, state } as Account} />);
  expect(await screen.findByText("Financing won't be offered with this email")).toBeInTheDocument();
  expect(screen.queryByText("Financing will be offered")).not.toBeInTheDocument();
});

const legacyOffer = () => {
  const quote = buildQuote({ premium: props.retailTotal, downPct: 25, months: 9, apr: 14, effectiveDate: today });
  return {
    id: "loan-old", status: "QUOTED", state: "MA", premium: props.retailTotal,
    downPayment: quote.downPayment, amountFinanced: quote.amountFinanced, payment: quote.payment,
    downPct: 25, months: 9, apr: 14, effectiveDate: today, quotedAt: `${today}T13:00:00Z`,
  };
};

it.each(["MA", "Massachusetts", " ma "])("shows the frozen terms of a standing legacy offer with state %s", async state => {
  const standing = { ...legacyOffer(), state };
  api.models.PfLoan.list.mockResolvedValue({ data: [standing] });
  render(<FinanceOfferHint {...props} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`9 monthly payments of ${formatMoney(standing.payment)} at 14% APR`);
  expect(banner).toHaveTextContent("payment 1 of 10");
  expect(banner).not.toHaveTextContent("will be re-issued");
});

it.each(["agreementSignedAt", "electedAt"])("retains a stale standing offer after %s records commitment", async field => {
  const standing = { ...legacyOffer(), effectiveDate: "2026-11-06", [field]: "2026-11-06T13:00:00Z" };
  api.models.PfLoan.list.mockResolvedValue({ data: [standing] });
  render(<FinanceOfferHint {...props} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`9 monthly payments of ${formatMoney(standing.payment)} at 14% APR`);
});

it.each(["MS", "SC", "NV"])("shows matching signed %s terms despite the hold on new offers", async state => {
  const standing = { ...legacyOffer(), state, agreementSignedAt: `${today}T13:00:00Z` };
  api.models.PfLoan.list.mockResolvedValue({ data: [standing] });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state } as Account} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`9 monthly payments of ${formatMoney(standing.payment)} at 14% APR`);
});

it("does not reapply new coverage eligibility checks to matching signed terms", async () => {
  const standing = { ...legacyOffer(), agreementSignedAt: `${today}T13:00:00Z` };
  api.models.PfLoan.list.mockResolvedValue({ data: [standing] });
  render(<FinanceOfferHint {...props} anchor={{ ...props.anchor, lines: ["HO-6"] }} />);
  expect(await screen.findByText("Financing will be offered")).toBeInTheDocument();
  expect(screen.queryByText("Financing won't be offered with this email")).not.toBeInTheDocument();
});

it("does not reapply the new Ohio minimum principal to matching signed terms", async () => {
  const standing = { ...legacyOffer(), state: "OH", agreementSignedAt: `${today}T13:00:00Z` };
  api.models.PfLoan.list.mockResolvedValue({ data: [standing] });
  api.models.PfCounselOpinion.list.mockResolvedValue({ data: [{ effectiveAt: "2026-01-01", reviewBy: "2027-01-01" }] });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state: "OH" } as Account} />);
  expect(await screen.findByText("Financing will be offered")).toBeInTheDocument();
  expect(screen.queryByText(/permits financing only above/)).not.toBeInTheDocument();
});

it.each(["MA", "DE", "KS"])("blocks a signed %s offer after its known coverage date changes", async state => {
  api.models.PfLoan.list.mockResolvedValue({ data: [{ ...legacyOffer(), state,
    coverageEffectiveDate: today, agreementSignedAt: `${today}T13:00:00Z`,
  }] });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state } as Account}
    anchor={{ ...props.anchor, coverageEffectiveDate: "2026-12-01" }} />);
  expect(await screen.findByText("Financing won't be offered with this email")).toBeInTheDocument();
  expect(screen.queryByText("Financing will be offered")).not.toBeInTheDocument();
});

it("does not preview replacement pricing over a signed quote after a state correction", async () => {
  api.models.PfLoan.list.mockResolvedValue({ data: [{ ...legacyOffer(), agreementSignedAt: `${today}T13:00:00Z` }] });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state: "FL" } as Account} />);
  expect(await screen.findByText("Financing won't be offered with this email")).toBeInTheDocument();
  expect(screen.queryByText("Financing will be offered")).not.toBeInTheDocument();
});

it.each(["DE", "KS"])("reprices an uncommitted %s quote after its known coverage date changes", async state => {
  api.models.PfLoan.list.mockResolvedValue({ data: [{ ...legacyOffer(), state, coverageEffectiveDate: today }] });
  const pricing = financePricing(jurisdictionFor(state)!, {
    premium: props.retailTotal, downPct: 25, months: 11, effectiveDate: today, coverageEffectiveDate: "2026-12-01",
  })!;
  render(<FinanceOfferHint {...props} account={{ ...props.account, state } as Account}
    anchor={{ ...props.anchor, coverageEffectiveDate: "2026-12-01" }} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`11 monthly payments of ${formatMoney(pricing.quote.payment)} at ${pricing.apr}% APR`);
});

it.each(["DE", "KS"])("keeps an existing %s quote when its legacy coverage date is absent", async state => {
  const standing = { ...legacyOffer(), state };
  api.models.PfLoan.list.mockResolvedValue({ data: [standing] });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state } as Account}
    anchor={{ ...props.anchor, coverageEffectiveDate: "2026-12-01" }} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`9 monthly payments of ${formatMoney(standing.payment)} at 14% APR`);
});

it("previews Florida pricing after an account state correction instead of retaining Massachusetts terms", async () => {
  api.models.PfLoan.list.mockResolvedValue({ data: [legacyOffer()] });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state: "Florida" } as Account} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  const pricing = financePricing(jurisdictionFor("FL")!, {
    premium: props.retailTotal, downPct: 25, months: 11, effectiveDate: today,
  })!;
  expect(pricing.apr).toBeLessThanOrEqual(18);
  expect(effectiveAprWithFee(pricing.quote)).toBeLessThanOrEqual(18);
  expect(banner).toHaveTextContent(`11 monthly payments of ${formatMoney(pricing.quote.payment)} at ${pricing.apr}% APR`);
  expect(banner).not.toHaveTextContent("14% APR");
});

it("uses Iowa's local agreement month when the UTC schedule date has crossed into December", async () => {
  vi.setSystemTime(new Date("2026-12-01T00:30:00Z"));
  const pricing = financePricing(jurisdictionFor("IA")!, {
    premium: props.retailTotal, downPct: 25, months: 11, effectiveDate: "2026-12-01",
  }, ["2026-11-30"])!;
  expect(pricing.apr).toBeLessThanOrEqual(7);
  render(<FinanceOfferHint {...props} account={{ ...props.account, state: "IA" } as Account} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`${pricing.apr}% APR`);
  expect(banner).toHaveTextContent(formatMoney(pricing.quote.payment));
});

it("does not reoffer an unsigned Iowa quote after the same UTC day's local rate period expires", async () => {
  vi.setSystemTime(new Date("2027-01-01T07:00:00Z"));
  api.models.PfLoan.list.mockResolvedValue({ data: [{ ...legacyOffer(), state: "IA", apr: 7,
    effectiveDate: "2027-01-01", quotedAt: "2027-01-01T00:30:00Z",
  }] });
  render(<FinanceOfferHint {...props} account={{ ...props.account, state: "IA" } as Account} />);
  expect(await screen.findByText("Financing won't be offered with this email")).toBeInTheDocument();
  expect(screen.queryByText("Financing will be offered")).not.toBeInTheDocument();
});

it("previews replacement pricing when a current unsigned offer exceeds the current ceiling", async () => {
  const oldQuote = buildQuote({ premium: props.retailTotal, downPct: 25, months: 9, apr: 25, effectiveDate: today });
  api.models.PfLoan.list.mockResolvedValue({ data: [{ ...legacyOffer(), apr: 25, payment: oldQuote.payment }] });
  const pricing = financePricing(jurisdictionFor("MA")!, {
    premium: props.retailTotal, downPct: 25, months: 11, effectiveDate: today,
  })!;
  render(<FinanceOfferHint {...props} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent(`11 monthly payments of ${formatMoney(pricing.quote.payment)} at ${pricing.apr}% APR`);
  expect(banner).not.toHaveTextContent("25% APR");
});

it("blocks a North Dakota boundary preview while one local date has no configured ceiling", async () => {
  vi.setSystemTime(new Date("2026-11-01T05:30:00Z"));
  render(<FinanceOfferHint {...props} retailTotal={10000} account={{ ...props.account, state: "ND" } as Account} />);
  expect(await screen.findByText("Financing won't be offered with this email")).toBeInTheDocument();
  expect(screen.queryByText("Financing will be offered")).not.toBeInTheDocument();
});

it.each(["stale", "repriced", "fee changed"])("previews current pricing when a standing offer is %s", async reason => {
  const standing = legacyOffer();
  api.models.PfLoan.list.mockResolvedValue({ data: [{ ...standing,
    ...(reason === "stale" ? { effectiveDate: "2026-11-06" } : {}),
    ...(reason === "repriced" ? { premium: 90000 } : {}),
    ...(reason === "fee changed" ? { brokerFeeCents: 10000 } : {}),
  }] });
  render(<FinanceOfferHint {...props} />);
  const banner = (await screen.findByText("Financing will be offered")).closest(".offer-banner");
  expect(banner).toHaveTextContent("11 monthly payments");
  expect(banner).not.toHaveTextContent("14% APR");
});

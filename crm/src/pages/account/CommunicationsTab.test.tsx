import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const CommunicationAccount = vi.hoisted(() => ({
  listCommunicationAccountByAccountIdAndOccurredAt: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { CommunicationAccount } }),
}));

import { CommunicationsTab } from "./CommunicationsTab";

/**
 * The tab's one job beyond listing rows: never let a shared call read as a
 * call about the association whose timeline it is on.
 *
 * A call with a property manager who holds thirty associations appears on all
 * thirty, because the CRM knows who rang and not which association they rang
 * about. If the "also on N other accounts" line ever disappears, the tab
 * starts making a claim the data does not support — so it is asserted here
 * rather than left to a reviewer to notice.
 */

const appearance = (o: Record<string, unknown> = {}) => ({
  id: "ca1",
  occurredAt: "2026-08-26T14:30:00.000Z",
  communication: {
    id: "m1",
    channel: "CALL",
    direction: "INBOUND",
    externalNumber: "+15082332261",
    contactName: "Marcia Webb",
    userName: "Jake Greasley",
    state: "CONNECTED",
    durationSeconds: 252,
    body: null,
    recapSummary: null,
    matchConfidence: "EXACT",
    appearanceCount: 1,
    ...o,
  },
});

function loadWith(rows: unknown[]) {
  CommunicationAccount.listCommunicationAccountByAccountIdAndOccurredAt.mockResolvedValue({
    data: rows,
    nextToken: null,
  });
}

describe("a call that belongs to one association", () => {
  it("names who rang, who took it, and how long it ran", async () => {
    loadWith([appearance()]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText("Marcia Webb")).toBeTruthy();
    expect(screen.getByText("Jake Greasley")).toBeTruthy();
    expect(screen.getByText(/4m 12s/)).toBeTruthy();
  });

  it("says nothing about other accounts", async () => {
    loadWith([appearance()]);
    render(<CommunicationsTab accountId="a1" />);
    await screen.findByText("Marcia Webb");
    expect(screen.queryByText(/also on/)).toBeNull();
  });
});

describe("a call shared across a manager's book", () => {
  it("says so on the row, where it is read", async () => {
    loadWith([appearance({ matchConfidence: "SHARED", appearanceCount: 30 })]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText("also on 29 other accounts")).toBeTruthy();
  });

  it("counts the others, not the total", async () => {
    loadWith([appearance({ matchConfidence: "SHARED", appearanceCount: 2 })]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText("also on 1 other account")).toBeTruthy();
  });
});

describe("what a call says happened", () => {
  it("reports a missed call rather than leaving it blank", async () => {
    loadWith([appearance({ state: "MISSED", durationSeconds: null })]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText(/Missed/)).toBeTruthy();
  });

  it("falls back to the number when nobody is named", async () => {
    loadWith([appearance({ contactName: null })]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText("+15082332261")).toBeTruthy();
  });

  it("attributes an unclaimed call to the main line", async () => {
    loadWith([appearance({ userName: null })]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText("Main line")).toBeTruthy();
  });

  it("shows a text's body", async () => {
    loadWith([appearance({ channel: "SMS", body: "can you send the COI", state: null })]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText("can you send the COI")).toBeTruthy();
  });
});

describe("nothing recorded", () => {
  it("says so rather than rendering an empty table", async () => {
    loadWith([]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText(/Nothing recorded yet/)).toBeTruthy();
  });

  it("survives an appearance whose conversation did not come back", async () => {
    // A join row whose parent is missing would otherwise throw on render.
    loadWith([{ id: "ca1", occurredAt: "2026-08-26T14:30:00.000Z", communication: null }]);
    render(<CommunicationsTab accountId="a1" />);
    expect(await screen.findByText(/Nothing recorded yet/)).toBeTruthy();
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../lib/communications", () => ({ communicationRequest: h.request }));
vi.mock("../lib/client", () => ({ friendlyError: (error: Error) => error.message }));
import ReportDeliverySettings from "../components/ReportDeliverySettings";

const legacy = { version: 3, ownerId: "ops", reportChannelId: "cha_reports", members: [{ userId: "sales", salesManagerId: "ops", away: true, coverId: "ops" }] };
beforeEach(() => {
  h.request.mockReset().mockImplementation(async (operation: string, input: unknown) => operation === "team" ? { team: [
    { userId: "sales", name: "Sales Person", enabled: true, salesperson: true },
    { userId: "ops", name: "Operations Contact", enabled: true, salesperson: false },
  ] } : operation === "teamRouting" ? { routing: legacy } : { routing: input });
});

it("keeps report delivery editable without rendering or resaving legacy manager and coverage assignments", async () => {
  render(<ReportDeliverySettings />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit report delivery" })).toBeEnabled());
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByText(/sales manager|temporary cover|managers and coverage/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit report delivery" }));
  expect(screen.getAllByRole("combobox")).toHaveLength(3);
  fireEvent.change(screen.getByRole("combobox", { name: "Connection issues" }), { target: { value: "ops" } });
  fireEvent.click(screen.getByRole("button", { name: "Save report delivery" }));
  await waitFor(() => expect(h.request).toHaveBeenCalledWith("saveTeamRouting", {
    version: 3, ownerId: "ops", intakeOwnerId: undefined, integrationOwnerId: "ops", reportChannelId: "cha_reports", members: [],
  }, true));
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
});

it("retains a failed delivery edit for retry and disables editing after a failed initial read", async () => {
  h.request.mockImplementation(async (operation: string) => {
    if (operation === "saveTeamRouting") throw new Error("Settings changed; refresh and try again");
    return operation === "team" ? { team: [] } : { routing: legacy };
  });
  const view = render(<ReportDeliverySettings />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit report delivery" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Edit report delivery" }));
  fireEvent.click(screen.getByRole("button", { name: "Save report delivery" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings changed");
  expect(screen.getByRole("form")).toBeVisible();
  view.unmount();
  h.request.mockRejectedValue(new Error("Could not load delivery"));
  render(<ReportDeliverySettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load delivery");
  expect(screen.getByRole("button", { name: "Edit report delivery" })).toBeDisabled();
});

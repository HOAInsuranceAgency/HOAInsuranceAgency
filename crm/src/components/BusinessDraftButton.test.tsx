import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ mounted: vi.fn() }));
vi.mock("./BusinessDeliveryComposer", () => ({ default: (props: { accountId: string; conversationId?: string; kind?: string; recordId?: string; onClose: () => void }) => {
  h.mounted(props);
  return <div role="dialog" aria-label="Delivery composer"><span>{props.accountId}:{props.conversationId}:{props.kind}:{props.recordId}</span><button onClick={props.onClose}>Close composer</button></div>;
} }));
import BusinessDraftButton from "./BusinessDraftButton";
const props = { accountId: "a1", conversationId: "cnv_one", kind: "PACKAGE" as const, recordId: "option-one", label: "Prepare proposal in Front" };
beforeEach(() => { vi.clearAllMocks(); });
it("opens one shared composer without contacting Front when the launcher renders", () => {
  render(<BusinessDraftButton {...props} />);
  expect(h.mounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(h.mounted).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: props.accountId, conversationId: props.conversationId, kind: props.kind, recordId: props.recordId }));
  fireEvent.click(screen.getByRole("button", { name: "Close composer" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("closes the old composer when account or Front conversation changes", () => {
  const view = render(<BusinessDraftButton {...props} />);
  fireEvent.click(screen.getByRole("button"));
  view.rerender(<BusinessDraftButton {...props} accountId="a2" conversationId="cnv_two" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("a2:cnv_two:PACKAGE:option-one")).toBeInTheDocument();
});
it("supports a disabled generated-record entry and a generic account entry", () => {
  const view = render(<BusinessDraftButton {...props} disabled />);
  expect(screen.getByRole("button")).toBeDisabled();
  view.rerender(<BusinessDraftButton accountId="a1" />);
  fireEvent.click(screen.getByRole("button", { name: "Prepare email in Front" }));
  expect(h.mounted).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: "a1" }));
});

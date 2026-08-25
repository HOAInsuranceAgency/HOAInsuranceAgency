import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabFrame, Tile } from "./common";

/**
 * The frame's one hard rule: a failure only replaces content that never
 * loaded. After a success, an error is a line above the data, not a
 * replacement for it — and the Refresh control must survive the very event
 * it exists to recover from.
 */
describe("TabFrame", () => {
  const base = {
    loading: false,
    loaded: true,
    error: "",
    refetch: async () => {},
  };

  it("gates with Loading before anything has settled", () => {
    render(
      <TabFrame res={{ ...base, loaded: false, loading: true }}>secret</TabFrame>
    );
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("secret")).toBeNull();
  });

  it("a first-load failure shows the error and a way to retry", () => {
    let called = 0;
    render(
      <TabFrame
        res={{
          ...base,
          error: "Failed to load renewals",
          refetch: async () => {
            called += 1;
          },
        }}
      >
        secret
      </TabFrame>
    );
    expect(screen.queryByText("secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(called).toBe(1);
  });

  it("a retry in flight shows Loading again, not a blank error", () => {
    const { rerender } = render(
      <TabFrame res={{ ...base, error: "Failed to load" }}>secret</TabFrame>
    );
    rerender(
      <TabFrame res={{ ...base, error: "", loading: true }}>secret</TabFrame>
    );
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("a failed refresh keeps the data and the Refresh control on screen", () => {
    const { rerender } = render(<TabFrame res={base}>the table</TabFrame>);
    expect(screen.getByText("the table")).toBeTruthy();

    rerender(
      <TabFrame res={{ ...base, error: "Failed to load renewals" }}>
        the table
      </TabFrame>
    );
    expect(screen.getByText("the table")).toBeTruthy();
    expect(screen.getByText(/showing the last numbers/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});

describe("Tile", () => {
  it("activates on Space as well as Enter — role=button promises both", () => {
    let clicks = 0;
    render(
      <Tile
        n={3}
        label="Open leads"
        onClick={() => {
          clicks += 1;
        }}
      />
    );
    const tile = screen.getByRole("button", { name: /Open leads/ });
    fireEvent.keyDown(tile, { key: " " });
    fireEvent.keyDown(tile, { key: "Enter" });
    expect(clicks).toBe(2);
  });

  it("without onClick it is a plain figure, not a fake button", () => {
    render(<Tile n={7} label="New this week" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("New this week")).toBeTruthy();
  });
});

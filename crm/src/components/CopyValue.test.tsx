import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CopyValue from "./CopyValue";

/**
 * The copy control behind the sidebar NPNs.
 *
 * The point of the component is the clipboard, and the case worth holding is
 * the one that is easy to get wrong: on an insecure origin
 * `navigator.clipboard` is *undefined* rather than throwing, so an unguarded
 * `navigator.clipboard.writeText(...)` is a TypeError in the handler and the
 * button silently does nothing. Here it has to say so, and the digits have to
 * remain selectable so there is still a way to get them.
 */

const original = navigator.clipboard;

/**
 * ORDER MATTERS: call `userEvent.setup()` *before* either helper below.
 *
 * user-event installs its own `navigator.clipboard` stub during setup, so a
 * stub applied first is silently replaced — which makes the no-clipboard test
 * pass against a clipboard that exists, i.e. assert nothing.
 */
function withClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

function withoutClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: original,
    configurable: true,
  });
  vi.useRealTimers();
});

describe("CopyValue", () => {
  it("copies the value and confirms it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);
    render(<CopyValue label="Agency NPN" value="1234567" />);

    await user.click(screen.getByRole("button", { name: "Copy Agency NPN" }));

    expect(writeText).toHaveBeenCalledWith("1234567");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  /**
   * Two of these sit in the sidebar. Named only "Copy", they would be two
   * controls with the same accessible name and no way to tell them apart.
   */
  it("names the field in the button's accessible name", () => {
    render(
      <>
        <CopyValue label="Agency NPN" value="1" />
        <CopyValue label="DRLP NPN" value="2" />
      </>
    );

    expect(screen.getByRole("button", { name: "Copy Agency NPN" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy DRLP NPN" })).toBeInTheDocument();
  });

  it("says so when there is no clipboard, instead of failing silently", async () => {
    const user = userEvent.setup();
    withoutClipboard();
    render(<CopyValue label="Agency NPN" value="1234567" />);

    await user.click(screen.getByRole("button", { name: "Copy Agency NPN" }));

    expect(await screen.findByText("Press ⌘C")).toBeInTheDocument();
    // The fallback only works if the value is still on screen to select.
    expect(screen.getByText("1234567")).toBeInTheDocument();
  });

  it("reports a rejected write rather than claiming success", async () => {
    const user = userEvent.setup();
    withClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<CopyValue label="DRLP NPN" value="7654321" />);

    await user.click(screen.getByRole("button", { name: "Copy DRLP NPN" }));

    expect(await screen.findByText("Press ⌘C")).toBeInTheDocument();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  /*
   * NOT covered: the 1.8s revert from "Copied" back to "Copy", and the
   * clearTimeout on unmount.
   *
   * Both are timer behaviour, and driving them needs `vi.useFakeTimers()`,
   * under which `await user.click(...)` never settles — user-event schedules
   * its own work on the timers that have just been frozen. The revert is
   * cosmetic, so it is not worth a hand-dispatched click to reach it. The
   * unmount cleanup is a leak guard rather than something a user sees; if it
   * regressed, these tests would surface it as a React "state update on an
   * unmounted component" warning rather than a failure.
   */
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import LicenseMap, { coverageOf } from "./LicenseMap";
import { US_MAP_VIEWBOX, US_STATE_NAMES, US_STATE_PATHS } from "../../lib/usMap";
import type { License, UserProfile } from "../../lib/client";

/**
 * The coverage map.
 *
 * The rule is the whole feature: a state is green only when the firm and a
 * producer are *both* licensed and *both* unexpired, because either alone
 * cannot write business. Getting it wrong paints a state green that the
 * agency cannot legally write in, which is the one mistake this screen must
 * not make — and it would look completely fine.
 *
 * The CRM is behind Cognito magic-link auth, so this screen cannot be driven
 * in a browser without a real sign-in. This is the substitute.
 */

const YEAR_OUT = "2099-04-30";
const LONG_GONE = "2001-04-30";

const lic = (o: Partial<License> & { state: string }) =>
  ({
    id: `${o.state}-${o.holderType}-${o.licenseNumber ?? "x"}`,
    licenseClass: "PRODUCER",
    status: "ACTIVE",
    linesOfAuthority: ["Property"],
    expirationDate: YEAR_OUT,
    licenseNumber: "1234567",
    ...o,
  }) as License;

const profiles = [
  { id: "p1", firstName: "Jake", lastName: "Greasley" },
] as unknown as UserProfile[];

/** MA is fully covered; ME has only a firm licence; NH's producer expired. */
const FIRM = [
  lic({ state: "MA", holderType: "FIRM", licenseNumber: "F-MA" }),
  lic({ state: "ME", holderType: "FIRM", licenseNumber: "F-ME" }),
  lic({ state: "NH", holderType: "FIRM", licenseNumber: "F-NH" }),
];
const PERSONAL = [
  lic({ state: "MA", holderType: "PRODUCER", userProfileId: "p1" }),
  lic({ state: "NH", holderType: "PRODUCER", userProfileId: "p1", expirationDate: LONG_GONE }),
  lic({ state: "VT", holderType: "PRODUCER", userProfileId: "p1" }),
];

const renderMap = (over: { canEdit?: boolean; onEdit?: (l: License) => void } = {}) =>
  render(
    <LicenseMap
      firm={FIRM}
      personal={PERSONAL}
      profiles={profiles}
      canEdit={over.canEdit ?? false}
      onEdit={over.onEdit ?? (() => {})}
    />
  );

const stateEl = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name} —`) });

describe("the geometry it draws", () => {
  it("has a path for every state plus DC", () => {
    expect(Object.keys(US_STATE_PATHS)).toHaveLength(51);
    expect(Object.keys(US_STATE_NAMES)).toHaveLength(51);
  });

  it("keeps every path inside the viewBox", () => {
    // The Albers composite puts the Aleutians LEFT of x=0, so the usual
    // "0 0 975 610" viewBox silently crops the tail off Alaska. This is the
    // assertion that would have caught that.
    const [vx, vy, vw, vh] = US_MAP_VIEWBOX.split(" ").map(Number);
    for (const [code, d] of Object.entries(US_STATE_PATHS)) {
      for (const [, sx, sy] of d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
        const x = Number(sx);
        const y = Number(sy);
        expect(x, `${code} x`).toBeGreaterThanOrEqual(vx);
        expect(x, `${code} x`).toBeLessThanOrEqual(vx + vw);
        expect(y, `${code} y`).toBeGreaterThanOrEqual(vy);
        expect(y, `${code} y`).toBeLessThanOrEqual(vy + vh);
      }
    }
  });
});

describe("coverageOf", () => {
  it("needs both halves", () => {
    expect(coverageOf("MA", FIRM, PERSONAL)).toEqual({ firm: true, producers: true });
    expect(coverageOf("ME", FIRM, PERSONAL)).toEqual({ firm: true, producers: false });
    expect(coverageOf("VT", FIRM, PERSONAL)).toEqual({ firm: false, producers: true });
    expect(coverageOf("TX", FIRM, PERSONAL)).toEqual({ firm: false, producers: false });
  });

  it("does not count an expired licence", () => {
    // NH has both on file, and still cannot be written in.
    expect(coverageOf("NH", FIRM, PERSONAL)).toEqual({ firm: true, producers: false });
  });
});

describe("the map", () => {
  it("greens only the states with both, and reds the rest", () => {
    renderMap();
    expect(stateEl("Massachusetts").getAttribute("class")).toContain("is-covered");
    for (const name of ["Maine", "New Hampshire", "Vermont", "Texas"]) {
      expect(stateEl(name).getAttribute("class"), name).toContain("is-gap");
    }
  });

  it("colours every state, including the ones with nothing on file", () => {
    renderMap();
    // A blank state and a red one would be the same fact told two ways, and
    // the blank one reads as "no data" when it means "we can't write here".
    const paths = document.querySelectorAll("path.us-state");
    expect(paths).toHaveLength(51);
    for (const p of paths) {
      expect(p.getAttribute("class")).toMatch(/is-covered|is-gap/);
    }
  });

  it("names the specific gap, not just the colour", () => {
    renderMap();
    // The fill is not available to a screen reader, so the label carries it.
    expect(stateEl("Massachusetts")).toHaveAccessibleName(
      "Massachusetts — Licensed — firm and producer"
    );
    expect(stateEl("Maine")).toHaveAccessibleName(
      "Maine — Firm licensed, no active producer"
    );
    expect(stateEl("Vermont")).toHaveAccessibleName(
      "Vermont — Producer licensed, no firm licence"
    );
    expect(stateEl("Texas")).toHaveAccessibleName("Texas — Not licensed");
  });

  it("counts the writable states over the whole country", () => {
    renderMap();
    expect(screen.getByText(/1 of 51 states/)).toBeInTheDocument();
  });
});

describe("clicking a state", () => {
  it("lists both the firm and the personal licences, firm first", async () => {
    const user = userEvent.setup();
    renderMap();

    await user.click(stateEl("Massachusetts"));

    const rows = screen.getAllByRole("row").slice(1); // drop the header
    expect(rows).toHaveLength(2);
    // Firm first — and `useSort` sorts blanks last, so the obvious empty-string
    // sort key would quietly put it at the bottom instead.
    expect(within(rows[0]).getByText("Firm")).toBeInTheDocument();
    expect(within(rows[0]).getByText("F-MA")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Jake Greasley")).toBeInTheDocument();
  });

  it("says so when a state has nothing on file", async () => {
    const user = userEvent.setup();
    renderMap();

    await user.click(stateEl("Texas"));

    expect(screen.getByText("No licences on file for Texas.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Texas/ })).toBeInTheDocument();
  });

  it("shows the expired licence rather than hiding it", async () => {
    const user = userEvent.setup();
    renderMap();

    // NH is red *because* of this row — a panel that omitted it would leave
    // no way to find out why the state isn't green.
    await user.click(stateEl("New Hampshire"));

    expect(screen.getAllByRole("row").slice(1)).toHaveLength(2);
    // The panel heading repeats the reason, so the reader doesn't have to
    // work out which of two rows made the state red.
    expect(
      screen.getByRole("heading", {
        name: /New Hampshire · Firm licensed, no active producer/,
      })
    ).toBeInTheDocument();
  });

  it("toggles back off when the same state is clicked again", async () => {
    const user = userEvent.setup();
    renderMap();

    await user.click(stateEl("Massachusetts"));
    expect(screen.queryByRole("table")).toBeInTheDocument();

    await user.click(stateEl("Massachusetts"));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("opens the editor from a row, for an admin only", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const { unmount } = renderMap({ canEdit: true, onEdit });

    await user.click(stateEl("Massachusetts"));
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ licenseNumber: "F-MA" }));

    unmount();
    renderMap({ canEdit: false });
    await user.click(stateEl("Massachusetts"));
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});

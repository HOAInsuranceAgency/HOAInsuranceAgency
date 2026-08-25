import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same stubbing as DocumentsPanel.test.tsx: replace generateClient rather
// than ./client, so the actor proxy stays real.
const models = vi.hoisted(() => ({
  Account: { list: vi.fn() },
  Contact: { list: vi.fn() },
  Policy: { list: vi.fn() },
  Invoice: { list: vi.fn() },
  Certificate: { list: vi.fn() },
  Carrier: { list: vi.fn() },
  Document: { list: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models, mutations: {} }),
}));
vi.mock("aws-amplify/auth", () => ({
  getCurrentUser: vi.fn(async () => ({ userId: "u1" })),
}));

import UniversalSearch from "./UniversalSearch";

const page = (data: unknown[]) => ({ data, nextToken: null });

/** Match a hit label by its full text — the query's occurrence is wrapped
 * in <mark>, so plain text queries see the label split across elements. */
const hitLabel = (text: string) => (_: string, el: Element | null) =>
  (el?.classList.contains("hit-label") ?? false) && el?.textContent === text;

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderBar() {
  render(
    <MemoryRouter>
      <UniversalSearch />
      <LocationSpy />
    </MemoryRouter>
  );
  return screen.getByRole("combobox");
}

beforeEach(() => {
  vi.clearAllMocks();
  models.Account.list.mockResolvedValue(
    page([
      { id: "a1", name: "Harbor Pointe COA", legalName: null, city: "Boston", state: "MA", stage: "CLIENT" },
    ])
  );
  models.Contact.list.mockResolvedValue(
    page([{ id: "ct1", accountId: "a1", name: "Dana Reyes", email: "dana@harborpointe.org" }])
  );
  models.Policy.list.mockResolvedValue(page([]));
  models.Invoice.list.mockResolvedValue(page([]));
  models.Certificate.list.mockResolvedValue(page([]));
  models.Carrier.list.mockResolvedValue(page([]));
  models.Document.list.mockResolvedValue(
    page([{ id: "d1", name: "harbor-budget.pdf", entityType: "ACCOUNT", entityId: "a1" }])
  );
});

describe("UniversalSearch", () => {
  it("builds the index lazily on focus and answers keystrokes from it", async () => {
    const input = renderBar();
    expect(models.Account.list).not.toHaveBeenCalled();

    fireEvent.focus(input);
    expect(models.Account.list).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "har" } });
    expect(await screen.findByText(hitLabel("Harbor Pointe COA"))).toBeTruthy();
    // The joined context line: stage plus place, from the index alone.
    expect(screen.getByText("Client · Boston, MA")).toBeTruthy();
    expect(screen.getByText(hitLabel("Dana Reyes"))).toBeTruthy();
  });

  it("fills the Documents section in after the debounce, from a narrow server query", async () => {
    const input = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "harbor" } });

    // The document lane is slower than the index on purpose — its section
    // header says so until the debounced query lands.
    expect(screen.getByText("searching…")).toBeTruthy();
    expect(await screen.findByText(hitLabel("harbor-budget.pdf"))).toBeTruthy();

    const call = models.Document.list.mock.calls.at(-1)?.[0];
    expect(call.filter).toEqual({
      or: [{ name: { contains: "harbor" } }, { ocrText: { contains: "harbor" } }],
    });
    // Never ocrText into the typeahead — the dropdown shows no snippet and
    // full Textract text per keystroke is the weight the old page avoided.
    expect(call.selectionSet).toEqual(["id", "name", "entityType", "entityId"]);
  });

  it("Enter opens the selected hit; the top hit is selected by default", async () => {
    const input = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "har" } });
    await screen.findByText(hitLabel("Harbor Pointe COA"));

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/accounts/a1");
  });

  it("arrows walk every hit across sections and end on the footer, clamped", async () => {
    const input = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "har" } });
    await screen.findByText(hitLabel("Harbor Pointe COA"));
    await screen.findByText(hitLabel("harbor-budget.pdf"));

    // account hit → contact hit → document hit → footer, then clamp.
    for (let i = 0; i < 5; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/search?q=har");
  });

  it("with no quick matches, Enter lands on the full results page", async () => {
    const input = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz" } });
    await screen.findByText(/See all results/);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("loc").textContent).toBe("/search?q=zzz");
  });

  it("one character only asks for more instead of matching everything", () => {
    const input = renderBar();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "h" } });
    expect(screen.getByText(/two characters minimum/)).toBeTruthy();
    expect(models.Document.list).not.toHaveBeenCalled();
  });

  it("the / shortcut selects what the box holds, so typing starts a new search", async () => {
    const input = renderBar() as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "harbor" } });
    input.blur();

    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("harbor".length);
  });

  it("a sent /search link seeds the box — including Amplify's trailing-slash form", () => {
    render(
      <MemoryRouter initialEntries={["/search/?q=deductible"]}>
        <UniversalSearch />
      </MemoryRouter>
    );
    expect(screen.getByRole<HTMLInputElement>("combobox").value).toBe("deductible");
  });
});

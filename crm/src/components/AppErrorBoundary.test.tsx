import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary, RouteErrorBoundary } from "./AppErrorBoundary";

const removeErrorListeners: (() => void)[] = [];
function suppressExpectedRenderError(error: Error) {
  const listener = (event: ErrorEvent) => { if (event.error === error) event.preventDefault(); };
  window.addEventListener("error", listener);
  removeErrorListeners.push(() => window.removeEventListener("error", listener));
}

afterEach(async () => {
  await Sentry.close();
  removeErrorListeners.splice(0).forEach(remove => remove());
  vi.restoreAllMocks();
});

describe("app error boundary", () => {
  it("captures a route render failure and shows a safe recovery screen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const events: Sentry.ErrorEvent[] = [];
    Sentry.init({
      dsn: "https://public@o0.ingest.sentry.io/1",
      defaultIntegrations: false,
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      beforeSend: event => { events.push(event); return event; },
    });
    const failure = new Error("Private implementation detail");
    suppressExpectedRenderError(failure);
    function BrokenPage(): never { throw failure; }

    const router = createMemoryRouter([{
      path: "/leads", element: <BrokenPage />, errorElement: <RouteErrorBoundary />,
    }], { initialEntries: ["/leads"] });
    render(<StrictMode><AppErrorBoundary><RouterProvider router={router} /></AppErrorBoundary></StrictMode>);

    expect(screen.getByRole("alert")).toHaveTextContent("This page couldn't be displayed");
    expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].exception?.values?.some(value => value.value === failure.message)).toBe(true);
    expect(events[0].exception?.values?.at(-1)?.mechanism?.type).toBe("react.router.error_boundary");
  });

  it("can recover after a transient render failure while monitoring is disabled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("Transient failure");
    suppressExpectedRenderError(failure);
    let broken = true;
    function Page() {
      if (broken) throw failure;
      return <h1>Leads</h1>;
    }
    render(<AppErrorBoundary><MemoryRouter><Page /></MemoryRouter></AppErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Leads" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

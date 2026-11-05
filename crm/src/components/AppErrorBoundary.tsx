import { Button } from "./ui/Button";
import { captureException, ErrorBoundary } from "@sentry/react";
import { useEffect, useRef, type ReactNode } from "react";
import { useRouteError } from "react-router-dom";

function ErrorRecoveryScreen({ onRetry }: { onRetry?: () => void }) {
  return (
    <main className="auth-screen">
      <section className="card auth-card" role="alert">
        <h1>This page couldn't be displayed</h1>
        <p>{onRetry ? "Try again, or reload the app if this keeps happening." : "Reload the app to try again."}</p>
        <div className="form-actions">
          {onRetry && <Button variant="primary" type="button"  onClick={onRetry}>Try again</Button>}
          <Button type="button" variant={onRetry ? "secondary" : "primary"} onClick={() => window.location.reload()}>Reload app</Button>
        </div>
      </section>
    </main>
  );
}

/** React Router handles route failures before the outer React boundary sees them. */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const reported = useRef<{ error: unknown } | null>(null);
  useEffect(() => {
    // StrictMode replays effects during development; report each failure once.
    if (reported.current?.error === error) return;
    reported.current = { error };
    captureException(error, { mechanism: { type: "react.router.error_boundary", handled: true } });
  }, [error]);
  return <ErrorRecoveryScreen />;
}

/** Covers failures outside RouterProvider, including its own recovery screen. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary fallback={({ resetError }) => <ErrorRecoveryScreen onRetry={resetError} />}>
    {children}
  </ErrorBoundary>;
}

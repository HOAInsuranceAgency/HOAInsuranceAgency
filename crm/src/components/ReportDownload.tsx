import { createContext, useContext, useEffect, useRef, useState } from "react";
import { openReportWindow, saveReport, type DashboardReport } from "../lib/reportDownload";
export const ReportContext = createContext<{ disabled: boolean; asOf: Date | null }>({ disabled: false, asOf: null });
export function ReportDownload({ report, disabled = false, loadReport }: { report: DashboardReport; disabled?: boolean; loadReport?: () => Promise<DashboardReport> }) {
  const context = useContext(ReportContext), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const inFlight = useRef(false), mounted = useRef(true), pendingWindow = useRef<Window | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pendingWindow.current?.close(); pendingWindow.current = null; };
  }, []);
  return <div className="report-download" aria-busy={loading}>
    <select aria-label={`Download ${report.title}`} value="" disabled={disabled || context.disabled || loading} onChange={e => {
      const format = e.target.value;
      if (format !== "csv" && format !== "pdf" || inFlight.current) return;
      const snapshot = { asOf: context.asOf ?? new Date(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      if (!loadReport) {
        try { saveReport(report, snapshot, format); setError(""); }
        catch (err) { setError(err instanceof Error ? err.message : "Could not prepare the report."); }
        return;
      }
      inFlight.current = true; setLoading(true); setError("");
      // PDF needs its window opened in this synchronous event handler. The
      // data may take multiple authorized pages before it can be printed.
      let win: Window | undefined;
      try { if (format === "pdf") { win = openReportWindow(); pendingWindow.current = win; } }
      catch (err) {
        inFlight.current = false; setLoading(false);
        setError(err instanceof Error ? err.message : "Could not open the report.");
        return;
      }
      void (async () => {
        try {
          const prepared = await loadReport();
          if (!mounted.current) return;
          if (win) saveReport(prepared, snapshot, format, win);
          else saveReport(prepared, snapshot, format);
        } catch (err) {
          win?.close();
          if (mounted.current) setError(err instanceof Error ? err.message : "Could not prepare the report.");
        } finally {
          if (pendingWindow.current === win) pendingWindow.current = null;
          inFlight.current = false;
          if (mounted.current) setLoading(false);
        }
      })();
    }}><option value="">Download…</option><option value="csv">CSV spreadsheet</option><option value="pdf">Print / save PDF</option></select>
    {loading && <span className="muted small" role="status">Preparing full report…</span>}
    {error && <span className="error-text small" role="alert">{error}</span>}
  </div>;
}

import { createContext, useContext, useState } from "react";
import { saveReport, type DashboardReport } from "../lib/reportDownload";
export const ReportContext = createContext<{ disabled: boolean; asOf: Date | null }>({ disabled: false, asOf: null });
export function ReportDownload({ report, disabled = false }: { report: DashboardReport; disabled?: boolean }) {
  const context = useContext(ReportContext), [error, setError] = useState("");
  return <div className="report-download">
    <select aria-label={`Download ${report.title}`} value="" disabled={disabled || context.disabled} onChange={e => {
      const format = e.target.value;
      if (format !== "csv" && format !== "pdf") return;
      try { saveReport(report, { asOf: context.asOf ?? new Date(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, format); setError(""); }
      catch (err) { setError(err instanceof Error ? err.message : "Could not prepare the report."); }
    }}><option value="">Download…</option><option value="csv">CSV spreadsheet</option><option value="pdf">Print / save PDF</option></select>
    {error && <span className="error-text small" role="alert">{error}</span>}
  </div>;
}

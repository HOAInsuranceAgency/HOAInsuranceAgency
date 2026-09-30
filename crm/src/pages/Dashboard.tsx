import { useSearchParams } from "react-router-dom";
import {
  DASHBOARD_TABS,
  resolveDashboardTab,
  type DashboardTab,
} from "./dashboard/tabs";
import LeadsTab from "./dashboard/LeadsTab";
import FinanceTab from "./dashboard/FinanceTab";
import PerformanceTab from "./dashboard/PerformanceTab";

/** Each view loads its own snapshot; a failed read leaves navigation usable. */
export default function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Derived from the URL, not stored. Seeding state from `?tab=` once (the
   * first draft here did) desyncs the moment the URL changes without a
   * remount — the sidebar's "Dashboard" link navigates to "/" while this
   * route stays mounted, so the address bar would say Dashboard over a pane
   * still showing Finance, and the copied link would lie. One source of
   * truth, no second copy to correct.
   */
  const tab = resolveDashboardTab(searchParams.get("tab"));

  /**
   * Clicking a tab puts it in the URL, the way AccountDetail and Settings
   * already do — a copied link points at the pane the copier was reading.
   * `replace` rather than `push`: switching tabs is not a navigation Back
   * should have to walk out of one step at a time.
   */
  function selectTab(t: DashboardTab) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", t);
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Sales performance, pipeline, and receivables</p>

      {/* One control, two renderings: the strip on desktop, a native select
          on phones. CSS does
          the swap, so both stay wired to the same selectTab. */}
      <div className="tabs dash-tabs">
        {DASHBOARD_TABS.map(([t, label]) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            aria-pressed={tab === t}
            onClick={() => selectTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="dash-tab-select">
        <select
          aria-label="Dashboard view"
          value={tab}
          onChange={(e) => selectTab(e.target.value as DashboardTab)}
        >
          {DASHBOARD_TABS.map(([t, label]) => (
            <option key={t} value={t}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {tab === "dashboard" && <PerformanceTab />}
      {tab === "leads" && <LeadsTab />}
      {tab === "finance" && <FinanceTab />}
    </>
  );
}

import { useSearchParams } from "react-router-dom";
import {
  DASHBOARD_TABS,
  resolveDashboardTab,
  type DashboardTab,
} from "./dashboard/tabs";
import OverviewTab from "./dashboard/OverviewTab";
import LeadsTab from "./dashboard/LeadsTab";
import FinanceTab from "./dashboard/FinanceTab";
import RenewalsTab from "./dashboard/RenewalsTab";
import ReportingTab from "./dashboard/ReportingTab";

/**
 * The dashboard is a tab strip over five workspaces, each answering one
 * question: Overview "is anything wrong?", Leads "who's in the pipeline?",
 * Finance "where is the money?", Renewals "what expires and is it being
 * worked?", Reporting "how is the book doing?". Per-tab components live in
 * `pages/dashboard/`, the same convention as `pages/account/*Tab.tsx`.
 *
 * Each tab owns its own read. The single page this replaces pulled eight
 * tables in one fail-fast Promise.all, so one bad query blanked every number
 * on screen — the documented trade of that design. Splitting the read along
 * the tab seams dissolves it: a failure blanks one tab, the strip stays
 * navigable, and a visit fetches only the slices the open tab needs.
 */
export default function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Derived from the URL, not stored. Seeding state from `?tab=` once (the
   * first draft here did) desyncs the moment the URL changes without a
   * remount — the sidebar's "Dashboard" link navigates to "/" while this
   * route stays mounted, so the address bar would say Overview over a pane
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
      <p className="sub">Agency command center</p>

      {/* One control, two renderings: the strip on desktop, a native select
          on phones — five buttons wrap into a ragged two-row strip under
          800px, and the OS picker beats any custom dropdown there. CSS does
          the swap, so both stay wired to the same selectTab. */}
      <div className="tabs dash-tabs">
        {DASHBOARD_TABS.map(([t, label]) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => selectTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="field dash-tab-select">
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

      {tab === "overview" && <OverviewTab />}
      {tab === "leads" && <LeadsTab />}
      {tab === "finance" && <FinanceTab />}
      {tab === "renewals" && <RenewalsTab />}
      {tab === "reporting" && <ReportingTab />}
    </>
  );
}

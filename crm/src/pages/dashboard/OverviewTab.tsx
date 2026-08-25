import { useNavigate } from "react-router-dom";
import { client, listAllPages } from "../../lib/client";
import { openQuoteStatusFilter } from "../../lib/quoteStatus";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { TabFrame, Tile } from "./common";

/**
 * The landing tab: five counts and nothing else. A tabbed dashboard with no
 * landing makes you click four times to learn nothing is on fire — this tab
 * is the glance. Rows live on the tabs and list pages the tiles link to, so
 * only counts are kept here.
 */
interface OverviewData {
  leads: number;
  clients: number;
  openQuotes: number;
  activePolicies: number;
  openTasks: number;
}

const EMPTY: OverviewData = {
  leads: 0,
  clients: 0,
  openQuotes: 0,
  activePolicies: 0,
  openTasks: 0,
};

export default function OverviewTab() {
  const navigate = useNavigate();

  const res = useAsyncResource<OverviewData>(
    async () => {
      const [leads, clients, openQuotes, activePolicies, tasks] =
        await Promise.all([
          listAllPages((nextToken) =>
            client.models.Account.list({
              filter: { stage: { eq: "LEAD" } },
              nextToken,
            })
          ),
          listAllPages((nextToken) =>
            client.models.Account.list({
              filter: { stage: { eq: "CLIENT" } },
              nextToken,
            })
          ),
          listAllPages((nextToken) =>
            client.models.Quote.list({
              filter: openQuoteStatusFilter(),
              nextToken,
            })
          ),
          // ACTIVE only. The tile this replaces said "Policies bound" over a
          // count of every row — EXPIRED, CANCELLED and NON_RENEWED included —
          // so it could only ever grow. In-force is the number an agency
          // actually steers by.
          listAllPages((nextToken) =>
            client.models.Policy.list({
              filter: { status: { eq: "ACTIVE" } },
              nextToken,
            })
          ),
          listAllPages((nextToken) =>
            client.models.MarketingTask.list({
              filter: { status: { eq: "OPEN" } },
              limit: 500,
              nextToken,
            })
          ),
        ]);
      return {
        leads: leads.length,
        clients: clients.length,
        openQuotes: openQuotes.length,
        activePolicies: activePolicies.length,
        openTasks: tasks.length,
      };
    },
    [],
    { initialData: EMPTY, errorMessage: "Failed to load the overview" }
  );

  const d = res.data;

  return (
    <TabFrame res={res}>
      <div className="stat-row">
        <Tile n={d.leads} label="Open leads" onClick={() => navigate("/leads")} />
        <Tile n={d.clients} label="Clients" onClick={() => navigate("/clients")} />
        <Tile
          n={d.openQuotes}
          label="Quotes in flight"
          onClick={() => navigate("/quotes")}
        />
        <Tile
          n={d.activePolicies}
          label="Active policies"
          onClick={() => navigate("/policies")}
        />
        <Tile n={d.openTasks} label="Open tasks" onClick={() => navigate("/tasks")} />
      </div>
    </TabFrame>
  );
}

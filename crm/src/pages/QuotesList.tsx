import { Select } from "../components/ui/Select";
import { Button } from "../components/ui/Button";
import { Table } from "../components/ui/Table";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  client,
  fmtDate,
  fmtMoney,
  listAllPages,
  type Account,
  type Carrier,
  type Quote,
} from "../lib/client";
import { Badge, statusBadge, QUOTE_STATUS_BADGE } from "../lib/badges";
import { useSort, SortTh } from "../lib/useSort";
import { isOpenQuoteStatus } from "../lib/quoteStatus";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useAgencyDay } from "../lib/useAgencyDay";
import { matchesQuoteOfferFilter, quoteOfferDate, type QuoteOfferFilter } from "../lib/quoteOfferExpiry";
import QuoteOfferExpiry from "../components/QuoteOfferExpiry";

export default function QuotesList() {
  const [openOnly, setOpenOnly] = useState(true);
  const [offerExpiry, setOfferExpiry] = useState<QuoteOfferFilter>("all");
  const today = useAgencyDay(), filterId = useId();
  const navigate = useNavigate();

  // Paginated: a bare .list() returns one ~100-row page and stops — this
  // list must not show fewer quotes than the dashboard tile that links here.
  const quoteRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Quote.list({ nextToken })),
    [],
    { initialData: [] as Quote[], errorMessage: "Failed to load quotes" }
  );
  const quotes = quoteRes.data;

  // Name lookups. Surfaced rather than ignored for the same reason as
  // PoliciesList: a missing name renders "—", which reads as data, not failure.
  const accountRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Account.list({ nextToken })),
    [],
    { initialData: [] as Account[], errorMessage: "Failed to load account names" }
  );
  const accounts = accountRes.data;

  const carrierRes = useAsyncResource(
    async () =>
      listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carrier names" }
  );
  const carriers = carrierRes.data;

  const accountName = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts]
  );
  const carrierName = useMemo(
    () => new Map(carriers.map((c) => [c.id, c.name])),
    [carriers]
  );

  const visible = quotes.filter(q => (!openOnly || isOpenQuoteStatus(q.status)) && matchesQuoteOfferFilter(q, offerExpiry, today));
  const expiringCount = quotes.filter(q => matchesQuoteOfferFilter(q, "expiring", today)).length;
  const expiredCount = quotes.filter(q => matchesQuoteOfferFilter(q, "expired", today)).length;

  const { sorted, sortKey, dir, toggle } = useSort(
    visible,
    {
      account: (q) => accountName.get(q.accountId) ?? "",
      carrier: (q) => (q.carrierId ? carrierName.get(q.carrierId) ?? "" : null),
      premium: (q) => q.premium,
      effective: (q) => q.effectiveDate,
      offerExpiry: quoteOfferDate,
      status: (q) => q.status,
    },
    "account"
  );

  return (
    <>
      <h1>Quotes</h1>
      <p className="sub">All quotes across leads and clients</p>

      <div className="toolbar quote-offer-filters">
        <SegmentedControl label="Quote status views" value={openOnly ? 'open' : 'all'} onChange={value => setOpenOnly(value === 'open')}
          items={[{ value: 'open', label: 'In flight' }, { value: 'all', label: 'All' }]} />
        <label className="field" htmlFor={`${filterId}-expiry`}>Offer expiry
          <Select id={`${filterId}-expiry`} value={offerExpiry} aria-describedby={`${filterId}-help`} onChange={e => setOfferExpiry(e.target.value as QuoteOfferFilter)}>
            <option value="all">Any offer expiry</option>
            <option value="expiring">Expiring within 7 days ({expiringCount})</option>
            <option value="expired">Expired ({expiredCount})</option>
          </Select>
        </label>
        <p id={`${filterId}-help`} className="quote-offer-filter-help">Expiry filters include quoted and presented offers. An offer remains valid through the recorded date, including today.</p>
      </div>

      {accountRes.error && <p className="error-text" role="alert">{accountRes.error} <Button disabled={accountRes.loading} onClick={() => void accountRes.refetch()}>Retry account names</Button></p>}
      {carrierRes.error && <p className="error-text" role="alert">{carrierRes.error} <Button disabled={carrierRes.loading} onClick={() => void carrierRes.refetch()}>Retry carriers</Button></p>}

      <div className="card">
        {!quoteRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : quoteRes.error ? (
          <p className="error-text" role="alert">{quoteRes.error} <Button disabled={quoteRes.loading} onClick={() => void quoteRes.refetch()}>Retry quotes</Button></p>
        ) : sorted.length === 0 ? (
          <p className="muted small">{quotes.length ? "No quotes match these filters." : "No quotes."}</p>
        ) : (
          <div className="table-wrap">
            <Table aria-label="All carrier quotes">
              <thead>
                <tr>
                  <SortTh label="Account" colKey="account" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Carrier" colKey="carrier" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Premium" colKey="premium" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Effective" colKey="effective" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Offer valid through" colKey="offerExpiry" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Status" colKey="status" sortKey={sortKey} dir={dir} onToggle={toggle} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((q) => (
                  <tr
                    key={q.id}
                    className="clickable"
                    onClick={() => navigate(`/accounts/${q.accountId}?tab=quotes`)}
                  >
                    <td>
                      <strong>{accountName.get(q.accountId) ?? "—"}</strong>
                    </td>
                    <td>{q.carrierId ? carrierName.get(q.carrierId) ?? "—" : "—"}</td>
                    <td>{fmtMoney(q.premium)}{(q.brokerFee ?? 0) > 0 && <div className="small muted">+ {fmtMoney(q.brokerFee)} broker fee · {fmtMoney((q.premium ?? 0) + (q.brokerFee ?? 0))} total</div>}</td>
                    <td>{fmtDate(q.effectiveDate)}</td>
                    <td><QuoteOfferExpiry quote={q} today={today} /></td>
                    <td>
                      <Badge {...statusBadge(QUOTE_STATUS_BADGE, q.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}

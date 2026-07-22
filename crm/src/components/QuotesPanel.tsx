import { useEffect, useState } from "react";
import {
  client,
  fmtDate,
  fmtMoney,
  LINES_OF_BUSINESS,
  type Account,
  type Carrier,
  type Quote,
} from "../lib/client";

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "gray",
  SUBMITTED: "blue",
  QUOTED: "amber",
  PRESENTED: "amber",
  BOUND: "green",
  DECLINED: "red",
  LOST: "red",
};

const OPEN_STATUSES = ["DRAFT", "SUBMITTED", "QUOTED", "PRESENTED"] as const;

/**
 * Quotes for an account. Binding a quote is the conversion event: it creates
 * a Policy and flips the account LEAD → CLIENT in place.
 */
export default function QuotesPanel({
  account,
  onAccountChange,
}: {
  account: Account;
  onAccountChange: (a: Account) => void;
}) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [binding, setBinding] = useState<Quote | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    const { data } = await client.models.Quote.list({
      filter: { accountId: { eq: account.id } },
    });
    setQuotes(
      data.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    );
  }

  useEffect(() => {
    refresh();
    client.models.Carrier.list().then(({ data }) =>
      setCarriers(data.sort((a, b) => a.name.localeCompare(b.name)))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  async function setStatus(quote: Quote, status: Quote["status"]) {
    await client.models.Quote.update({ id: quote.id, status });
    refresh();
  }

  const carrierName = (id: string | null | undefined) =>
    carriers.find((c) => c.id === id)?.name ?? "—";

  return (
    <div>
      <div className="toolbar">
        <div className="grow" />
        <button className="primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "+ New quote"}
        </button>
      </div>

      {showForm && (
        <QuoteForm
          accountId={account.id}
          carriers={carriers}
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      {quotes.length === 0 ? (
        <p className="muted small">No quotes yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Carrier</th>
                <th>Lines</th>
                <th>Premium</th>
                <th>Effective</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((qt) => (
                <tr key={qt.id}>
                  <td>{carrierName(qt.carrierId)}</td>
                  <td className="small">{(qt.lines ?? []).filter(Boolean).join(", ") || "—"}</td>
                  <td>{fmtMoney(qt.premium)}</td>
                  <td>{fmtDate(qt.effectiveDate)}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[qt.status] ?? "gray"}`}>
                      {qt.status}
                    </span>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {(OPEN_STATUSES as readonly string[]).includes(qt.status) && (
                      <>
                        <select
                          className="small"
                          value={qt.status}
                          onChange={(e) =>
                            setStatus(qt, e.target.value as Quote["status"])
                          }
                        >
                          {OPEN_STATUSES.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                          <option value="DECLINED">DECLINED</option>
                          <option value="LOST">LOST</option>
                        </select>{" "}
                        <button className="link" onClick={() => setBinding(qt)}>
                          Bind
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {binding && (
        <BindForm
          quote={binding}
          account={account}
          onDone={(updated) => {
            setBinding(null);
            refresh();
            if (updated) onAccountChange(updated);
          }}
          onError={setError}
        />
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function QuoteForm({
  accountId,
  carriers,
  onSaved,
}: {
  accountId: string;
  carriers: Carrier[];
  onSaved: () => void;
}) {
  const [carrierId, setCarrierId] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [premium, setPremium] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleLine(line: string) {
    setLines((ls) =>
      ls.includes(line) ? ls.filter((l) => l !== line) : [...ls, line]
    );
  }

  async function save() {
    setSaving(true);
    await client.models.Quote.create({
      accountId,
      carrierId: carrierId || undefined,
      status: "DRAFT",
      lines,
      premium: premium ? Number(premium) : undefined,
      effectiveDate: effectiveDate || undefined,
      expirationDate: expirationDate || undefined,
      notes: notes || undefined,
    });
    setSaving(false);
    onSaved();
  }

  return (
    <div className="card" style={{ background: "#f8fafc" }}>
      <div className="form-grid">
        <div className="field">
          <label>Carrier</label>
          <select value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
            <option value="">—</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Premium ($)</label>
          <input type="number" value={premium} onChange={(e) => setPremium(e.target.value)} />
        </div>
        <div className="field">
          <label>Effective date</label>
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Expiration date</label>
          <input
            type="date"
            value={expirationDate}
            onChange={(e) => setExpirationDate(e.target.value)}
          />
        </div>
        <div className="field full">
          <label>Lines</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {LINES_OF_BUSINESS.map((l) => (
              <label key={l} className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={lines.includes(l)}
                  onChange={() => toggleLine(l)}
                />
                {l}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save quote"}
        </button>
      </div>
    </div>
  );
}

function BindForm({
  quote,
  account,
  onDone,
  onError,
}: {
  quote: Quote;
  account: Account;
  onDone: (updatedAccount: Account | null) => void;
  onError: (msg: string) => void;
}) {
  const [policyNumber, setPolicyNumber] = useState("");
  const [saving, setSaving] = useState(false);

  async function bind() {
    setSaving(true);
    onError("");
    try {
      // 1. Policy from the accepted quote
      const { data: policy, errors: pErr } = await client.models.Policy.create({
        accountId: account.id,
        quoteId: quote.id,
        carrierId: quote.carrierId ?? undefined,
        policyNumber: policyNumber.trim() || undefined,
        status: "ACTIVE",
        lines: (quote.lines ?? []).filter((l): l is string => !!l),
        premium: quote.premium ?? undefined,
        effectiveDate: quote.effectiveDate ?? undefined,
        expirationDate: quote.expirationDate ?? undefined,
      });
      if (pErr?.length || !policy) throw new Error(pErr?.[0]?.message);

      // 2. Mark the quote bound
      await client.models.Quote.update({ id: quote.id, status: "BOUND" });

      // 3. Convert the lead in place — the only path to CLIENT
      let updated: Account | null = null;
      if (account.stage === "LEAD") {
        const { data } = await client.models.Account.update({
          id: account.id,
          stage: "CLIENT",
          convertedAt: new Date().toISOString(),
        });
        updated = data;
      }
      onDone(updated);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Bind failed");
      onDone(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ background: "#f0f7ef", marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Bind quote</h3>
      <p className="small muted">
        Creates a policy{account.stage === "LEAD" ? " and converts this lead to a client" : ""}.
      </p>
      <div className="form-grid">
        <div className="field">
          <label>Policy number (can be added later)</label>
          <input
            value={policyNumber}
            onChange={(e) => setPolicyNumber(e.target.value)}
          />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={bind}>
          {saving ? "Binding…" : "Confirm bind"}
        </button>
        <button className="secondary" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";
import { client, fmtDateTime, listAllPages } from "../lib/client";
import { useAsyncResource } from "../lib/useAsyncResource";
import { useSaveStatus, SaveStatus } from "../components/SaveStatus";
import type { TriageAction } from "../lib/enums";

/**
 * Calls from numbers the CRM does not recognise.
 *
 * ## Why this page exists rather than a rule
 *
 * An inbound call from an unknown number could be auto-created as a lead. It
 * is not, because that is exactly the deduplication decision `lead-intake`
 * declined to make — and a caller-ID matcher creating accounts would be
 * making it silently, in the least reviewable place available. Every wrong
 * number, carrier, vendor and robocall would become an association.
 *
 * So the decision stays a person's, made with the account list in front of
 * them. That is the whole design: this queue is where the CRM says "somebody
 * rang and I do not know who" out loud, instead of guessing.
 *
 * ## Why it has to stay short
 *
 * A queue that fills with routine traffic stops being read, and then the
 * genuinely unidentified callers — the ones it exists for — are missed. That
 * is what "Not a customer" is for: it remembers the number so the same
 * robocaller never queues twice.
 */

interface Unmatched {
  id: string;
  channel: string;
  direction: string;
  externalNumber: string;
  contactName?: string | null;
  userName?: string | null;
  state?: string | null;
  durationSeconds?: number | null;
  body?: string | null;
  occurredAt: string;
}

interface AccountOption {
  id: string;
  name: string;
  stage: string;
}

export default function Communications() {
  const queue = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Communication.listCommunicationByMatchConfidenceAndOccurredAt(
          { matchConfidence: "UNMATCHED" },
          { sortDirection: "DESC", nextToken }
        )
      ) as Promise<Unmatched[]>,
    [],
    { initialData: [] as Unmatched[], errorMessage: "Failed to load the queue" }
  );

  // Loaded once for the whole page rather than per row: filing is a search
  // against every account, and a list per card would be one read per call.
  const accounts = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Account.list({
          nextToken,
          limit: 200,
          selectionSet: ["id", "name", "stage"],
        })
      ) as Promise<AccountOption[]>,
    [],
    { initialData: [] as AccountOption[], errorMessage: "Failed to load accounts" }
  );

  return (
    <>
      <h1>Unidentified calls</h1>
      <p className="sub">
        Calls and texts from numbers no contact matches. File one against an
        account, turn it into a lead, or say it is not a customer — which
        remembers the number so it never appears here again.
      </p>

      {!queue.loaded ? (
        <p className="muted small">Loading…</p>
      ) : queue.error ? (
        <p className="error-text">{queue.error}</p>
      ) : queue.data.length === 0 ? (
        <div className="card">
          <p className="muted small">
            Nothing waiting. Every call so far has matched a contact.
          </p>
        </div>
      ) : (
        <>
          {queue.data.map((row) => (
            <TriageCard
              key={row.id}
              call={row}
              accounts={accounts.data}
              onFiled={() => queue.refetch()}
            />
          ))}
        </>
      )}
    </>
  );
}

function TriageCard({
  call,
  accounts,
  onFiled,
}: {
  call: Unmatched;
  accounts: AccountOption[];
  onFiled: () => void;
}) {
  const status = useSaveStatus();
  const [accountId, setAccountId] = useState("");
  const [leadName, setLeadName] = useState("");
  const [remember, setRemember] = useState(true);
  const [mode, setMode] = useState<"file" | "lead">("file");

  async function act(action: TriageAction, extra: Record<string, unknown> = {}) {
    await status.run(
      async () => {
        const { data, errors } = await client.mutations.fileCommunication({
          communicationId: call.id,
          action,
          ...extra,
        });
        if (errors?.length) throw new Error(errors[0].message);
        const result =
          typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
        if (!result?.ok) throw new Error(String(result?.error ?? "Refused."));
        onFiled();
        return "Filed.";
      },
      { errorMessage: "Could not file that call." }
    );
  }

  const who = call.contactName?.trim();
  // Per-card ids, because the queue renders one of these per unidentified
  // call and a duplicated id makes every label point at the first card's
  // control. `for`-associated rather than bare, which is what lets a screen
  // reader — and a test — say which field it is asking for.
  const id = (field: string) => `triage-${field}-${call.id}`;

  return (
    <div className="card">
      <div className="card-head">
        <h3>
          {call.externalNumber}
          {/* Dialpad's own caller ID, when it has one. It is not a match —
              nothing in the CRM knows this number — but it is what a person
              works from, so it is shown as what it is. */}
          {who && <span className="muted small"> — caller ID says “{who}”</span>}
        </h3>
        <SaveStatus {...status.status} />
      </div>

      <p className="muted small">
        {call.direction === "INBOUND" ? "Inbound" : "Outbound"}{" "}
        {call.channel.toLowerCase()} · {fmtDateTime(call.occurredAt)}
        {call.userName ? ` · ${call.userName}` : " · main line"}
        {call.state === "MISSED" && " · missed"}
        {call.state === "VOICEMAIL" && " · left a voicemail"}
      </p>
      {call.body && <p className="small">{call.body}</p>}

      <div className="toolbar">
        <div className="field">
          <label htmlFor={id("mode")}>What is this?</label>
          <select
            id={id("mode")}
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="file">An existing account</option>
            <option value="lead">A new lead</option>
          </select>
        </div>

        {mode === "file" ? (
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor={id("account")}>Account</label>
            <select
              id={id("account")}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Choose…</option>
              {[...accounts]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.stage === "LEAD" ? " (lead)" : ""}
                  </option>
                ))}
            </select>
          </div>
        ) : (
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor={id("lead")}>Association name</label>
            <input
              id={id("lead")}
              value={leadName}
              onChange={(e) => setLeadName(e.target.value)}
              placeholder="e.g. Beacon Hill Condo Trust"
            />
          </div>
        )}
      </div>

      {mode === "file" && (
        <label className="small">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />{" "}
          Remember this number for that account
          {/* Offered rather than assumed: a number reached once from a shared
              management-office line is not necessarily that association's. */}
        </label>
      )}

      <div className="form-actions">
        {mode === "file" ? (
          <button
            className="primary"
            disabled={!accountId || status.busy}
            onClick={() => act("FILE", { accountId, rememberNumber: remember })}
          >
            File it
          </button>
        ) : (
          <button
            className="primary"
            disabled={!leadName.trim() || status.busy}
            onClick={() =>
              act("NEW_LEAD", { leadName: leadName.trim(), contactName: who ?? "" })
            }
          >
            Create lead
          </button>
        )}
        <button
          disabled={status.busy}
          onClick={() => act("NOT_CUSTOMER")}
          title="Remembers the number so it never appears here again"
        >
          Not a customer
        </button>
        <button
          disabled={status.busy}
          onClick={() => act("IGNORE")}
          title="Clears this one call only"
        >
          Ignore
        </button>
      </div>

      {accounts.length === 0 && (
        <p className="muted small">
          <Link to="/leads/new">Create a lead</Link> if this is new business.
        </p>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { client, fmtDateTime, listAllPages } from "../../lib/client";
import { useAsyncResource } from "../../lib/useAsyncResource";
import type { CommChannel, CommDirection } from "../../lib/enums";

/**
 * Every call, text and voicemail involving this account.
 *
 * Read-only by construction, like the Activity tab beside it: `Communication`
 * grants a signed-in user `read` and nothing else, and the rows are written
 * by `dialpad-webhook` as an IAM principal.
 *
 * ## Why a separate tab from Activity
 *
 * Activity is a field-diff log — what changed on a record, and who changed
 * it. A conversation is not a diff. It has no subject row, no before and
 * after, and belongs to a variable number of accounts. Merging them would
 * mean a timeline where half the rows answer a different question.
 *
 * ## The label that matters
 *
 * A call from a property manager who holds thirty associations appears on all
 * thirty timelines, because the CRM knows who rang and not which association
 * they rang about. Every such row says so, in the row itself — "also on 29
 * other accounts" — because a call that silently appears here reads as a call
 * about this association, and that is precisely the claim being avoided. If
 * that line is ever removed, the tab starts lying.
 */

/** One appearance row, with its conversation pulled in by the same query. */
interface Appearance {
  id: string;
  occurredAt: string;
  communication: {
    id: string;
    channel: CommChannel;
    direction: CommDirection;
    externalNumber: string;
    contactName?: string | null;
    userName?: string | null;
    state?: string | null;
    durationSeconds?: number | null;
    body?: string | null;
    recapSummary?: string | null;
    matchConfidence?: string | null;
    appearanceCount?: number | null;
  } | null;
}

const CHANNEL_LABEL = {
  CALL: "Call",
  SMS: "Text",
  VOICEMAIL: "Voicemail",
} as const satisfies Record<CommChannel, string>;

const DIRECTION_LABEL = {
  INBOUND: "In",
  OUTBOUND: "Out",
} as const satisfies Record<CommDirection, string>;

/** Seconds as a person says them: "4m 12s", "38s". */
function duration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

/** What became of a call, when that is worth saying. A connected call is not. */
function outcome(state: string | null | undefined): string | null {
  if (state === "MISSED") return "Missed";
  if (state === "ABANDONED") return "Hung up";
  if (state === "VOICEMAIL") return "Voicemail";
  return null;
}

export function CommunicationsTab({ accountId }: { accountId: string }) {
  const res = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.CommunicationAccount.listCommunicationAccountByAccountIdAndOccurredAt(
          { accountId },
          {
            // Newest first off the index, not sorted in the browser: an
            // account talked to weekly for three years is hundreds of rows.
            sortDirection: "DESC",
            nextToken,
            // The conversation comes back with its appearance. Without this
            // the tab reads the join rows and then fetches each parent — N
            // round trips to draw one screen.
            selectionSet: [
              "id",
              "occurredAt",
              "communication.id",
              "communication.channel",
              "communication.direction",
              "communication.externalNumber",
              "communication.contactName",
              "communication.userName",
              "communication.state",
              "communication.durationSeconds",
              "communication.body",
              "communication.recapSummary",
              "communication.matchConfidence",
              "communication.appearanceCount",
            ],
          }
        )
      ) as Promise<Appearance[]>,
    [accountId],
    {
      initialData: [] as Appearance[],
      errorMessage: "Failed to load communications",
    }
  );

  const [channelFilter, setChannelFilter] = useState("");

  const rows = useMemo(
    () => res.data.filter((r): r is Appearance & { communication: NonNullable<Appearance["communication"]> } =>
      Boolean(r.communication)
    ),
    [res.data]
  );
  const filtered = rows.filter(
    (r) => !channelFilter || r.communication.channel === channelFilter
  );

  return (
    <div className="card">
      <h2>
        Communications{" "}
        {res.loaded && !res.error && (
          <span className="muted small" style={{ fontWeight: 400 }}>
            — {rows.length} conversation{rows.length === 1 ? "" : "s"}
          </span>
        )}
      </h2>
      <p className="muted small">
        Calls, texts and voicemails, captured from Dialpad. A conversation is
        recorded against the person, so a call with someone who manages
        several associations appears on each of their accounts and says so.
      </p>

      {!res.loaded ? (
        <p className="muted small">Loading…</p>
      ) : res.error ? (
        <p className="error-text">{res.error}</p>
      ) : rows.length === 0 ? (
        <p className="muted small">
          Nothing recorded yet. Calls and texts will appear here as they happen.
        </p>
      ) : (
        <>
          <div className="toolbar">
            <div className="field">
              <label>Channel</label>
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
              >
                <option value="">All</option>
                {/* Derived by sorting, not re-listed: a hand-written order is
                    a second copy of the member set. */}
                {(Object.keys(CHANNEL_LABEL) as CommChannel[])
                  .sort((a, b) => CHANNEL_LABEL[a].localeCompare(CHANNEL_LABEL[b]))
                  .map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_LABEL[c]}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {filtered.length === 0 ? (
            <p className="muted small">Nothing matches that filter.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>Who</th>
                    <th>Ours</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const c = r.communication;
                    const shared = c.matchConfidence === "SHARED";
                    const others = (c.appearanceCount ?? 1) - 1;
                    const took = duration(c.durationSeconds);
                    const became = outcome(c.state);
                    return (
                      <tr key={r.id}>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {fmtDateTime(r.occurredAt)}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <span className="badge gray">
                            {DIRECTION_LABEL[c.direction]}
                          </span>{" "}
                          {CHANNEL_LABEL[c.channel]}
                        </td>
                        <td>
                          {c.contactName ?? c.externalNumber}
                          {/* The whole point of the tab. A shared call is not
                              a call about this association, and the row has
                              to say so where it is read. */}
                          {shared && others > 0 && (
                            <div className="muted small">
                              also on {others} other account{others === 1 ? "" : "s"}
                            </div>
                          )}
                        </td>
                        <td>{c.userName ?? <span className="muted">Main line</span>}</td>
                        <td className="small">
                          {[became, took].filter(Boolean).join(" · ")}
                          {c.recapSummary && (
                            <div className="muted" style={{ marginTop: 4 }}>
                              {c.recapSummary}
                            </div>
                          )}
                          {c.channel !== "CALL" && c.body && (
                            <div style={{ marginTop: 4 }}>{c.body}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

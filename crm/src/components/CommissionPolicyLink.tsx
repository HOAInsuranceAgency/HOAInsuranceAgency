import { useState, useRef, type ReactNode } from "react";
import { client } from "../lib/client";
import { useAsyncResource } from "../lib/useAsyncResource";
import { commissionAction } from "../lib/commissions";
import { communicationRequest } from "../lib/communications";
import { useUnsavedChanges } from "../lib/editProtection";
import { isAuthorizationError } from "../lib/authorizationError";
import type {
  CommissionOverview,
  CommissionAccount,
} from "../../../shared/commissions";
import CommissionPanel from "./CommissionPanel";
import CommissionPlanSettings from "./CommissionPlanSettings";

type Context = {
  accountId: string;
  accountName: string;
  classification: CommissionAccount | null;
  suggestedProducerId: string;
  boundOn: string;
  effectiveDate: string;
  expirationDate: string;
  premium: number | null;
  agencyRate: number | null;
  transaction: string;
  updatedAt: string;
};
export default function CommissionPolicyLink({
  policyNumber,
  carrierId,
  data,
  refresh,
  adopted,
  renderAccountSetup,
  denied,
}: {
  policyNumber: string;
  carrierId: string;
  data: CommissionOverview;
  refresh: () => Promise<void>;
  adopted: (id: string) => void;
  renderAccountSetup: (id: string, saved: () => Promise<void>) => ReactNode;
  denied: (error: unknown) => void;
}) {
  const [search, setSearch] = useState(policyNumber),
    [query, setQuery] = useState(policyNumber),
    [cursor, setCursor] = useState<string | undefined>(),
    [policyId, setPolicy] = useState("");
  const resource = useAsyncResource(
    async () => {
      if (query.trim().length < 2) return { data: [], nextToken: null };
      const page = await client.models.Policy.list({
        filter: {
          and: [
            { carrierId: { eq: carrierId } },
            { policyNumber: { contains: query.trim() } },
          ],
        },
        limit: 25,
        nextToken: cursor,
      });
      if (page.errors?.length) throw new Error(page.errors[0].message);
      return page;
    },
    [query, cursor, carrierId],
    { clearDataOnError: () => true },
  );
  const context = useAsyncResource(
    async () =>
      policyId
        ? commissionAction<Context>("policyIntakeContext", { policyId })
        : null,
    [policyId],
    { clearDataOnError: () => true },
  );
  return (
    <div className="intake-policy-link">
      <p className="small muted">
        Search CRM policies for this carrier. Existing account details and
        policy terms are reused. Confirm the original producer; the current
        assignment is a suggestion.
      </p>
      <div className="intake-actions">
        <label className="field">
          Policy number search
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button
          className="secondary"
          disabled={resource.loading || search.trim().length < 2}
          onClick={() => {
            setQuery(search);
            setCursor(undefined);
            setPolicy("");
            if (query === search && !cursor) void resource.refetch();
          }}
        >
          Search CRM policies
        </button>
      </div>
      {resource.error && (
        <p className="error-text" role="alert">
          {resource.error}
        </p>
      )}
      {resource.loading && <p>Searching…</p>}
      <div className="commission-scroll">
        <table>
          <thead>
            <tr>
              <th>Policy</th>
              <th>Term</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {resource.data?.data.map((p) => (
              <tr key={p.id}>
                <td>{p.policyNumber}</td>
                <td>
                  {p.effectiveDate} – {p.expirationDate}
                </td>
                <td>
                  <button
                    className="secondary"
                    onClick={() => {
                      const tracked = data.policies.find(
                        (t) => t.id === p.commissionSnapshotId || t.id === p.id,
                      );
                      if (tracked) adopted(tracked.id);
                      else setPolicy(p.id);
                    }}
                  >
                    {data.policies.some(
                      (t) => t.id === p.commissionSnapshotId || t.id === p.id,
                    )
                      ? "Use this policy"
                      : "Complete commission tracking"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {resource.data?.nextToken && (
        <button
          className="secondary"
          onClick={() => setCursor(resource.data?.nextToken ?? undefined)}
        >
          Next policy results
        </button>
      )}
      {!resource.loading && resource.data && !resource.data.data.length && (
        <p className="small muted">
          No matching policy on this page. Check the policy number or use Next
          policy results when available.
        </p>
      )}
      {context.error && (
        <p className="error-text" role="alert">
          {context.error}
        </p>
      )}
      {policyId && context.loading && <p>Loading CRM policy details…</p>}
      {policyId && context.data && (
        <PolicyTrackingForm
          key={policyId}
          context={context.data}
          policyId={policyId}
          data={data}
          refresh={refresh}
          adopted={adopted}
          renderAccountSetup={renderAccountSetup}
          reloadContext={context.refetch}
          denied={denied}
        />
      )}
    </div>
  );
}
function PolicyTrackingForm({
  context: c,
  policyId,
  data,
  refresh,
  adopted,
  renderAccountSetup,
  reloadContext,
  denied,
}: {
  context: Context;
  policyId: string;
  data: CommissionOverview;
  refresh: () => Promise<void>;
  adopted: (id: string) => void;
  renderAccountSetup: (id: string, saved: () => Promise<void>) => ReactNode;
  reloadContext: () => Promise<void>;
  denied: (e: unknown) => void;
}) {
  const [draft, setDraft] = useState({
    producerId: c.suggestedProducerId,
    boundOn: c.boundOn,
    effectiveDate: c.effectiveDate,
    expirationDate: c.expirationDate,
    premium: c.premium == null ? "" : String(c.premium),
    agencyRate: c.agencyRate == null ? "" : String(c.agencyRate),
    transaction: c.transaction,
  });
  const originalFields = useRef({ ...draft });
  const initial = useRef(JSON.stringify(draft)),
    [confirmed, setConfirmed] = useState(false),
    [correct, setCorrect] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const { markClean } = useUnsavedChanges(
    JSON.stringify(draft) !== initial.current || confirmed,
    { busy },
  );
  const team = useAsyncResource(
    () =>
      communicationRequest<{
        team: Parameters<typeof CommissionPlanSettings>[0]["team"];
      }>("team", {}),
    [],
    { clearDataOnError: () => true },
  );
  const plan = data.plans.find((p) => p.producerId === draft.producerId);
  const field = (key: keyof typeof draft, label: string, type = "text") => (
    <label className="field" key={key}>
      {label}
      {originalFields.current[key] && !correct && key !== "transaction" ? (
        <>
          <strong>{draft[key]}</strong>
          <span className="small muted">From CRM</span>
        </>
      ) : (
        <input
          type={type}
          required
          value={draft[key]}
          onChange={(e) => {
            setDraft({ ...draft, [key]: e.target.value });
            setConfirmed(false);
          }}
        />
      )}
    </label>
  );
  return (
    <div>
      <div className="commission-notice">
        <strong>{c.accountName}</strong>
        <p className="small">
          {c.classification
            ? "Saved classification: " +
              c.classification.periods
                .map((p) => p.classification + " from " + p.from)
                .join("; ")
            : "Account classification and original bind history are needed."}
        </p>
      </div>
      {!c.classification && (
        <CommissionPanel open title="Complete missing account eligibility">
          {renderAccountSetup(c.accountId, async () => {
            await reloadContext();
            await refresh();
          })}
        </CommissionPanel>
      )}
      {!plan && team.data && (
        <CommissionPanel
          title="Assign the missing employee plan"
          hint="Saved plan rates will be reused"
        >
          <CommissionPlanSettings
            definitions={data.planDefinitions ?? []}
            plans={data.plans}
            team={team.data.team.filter(
              (p) => !draft.producerId || p.userId === draft.producerId,
            )}
            refresh={refresh}
            denied={denied}
          />
        </CommissionPanel>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError("");
          void (async () => {
            try {
              await commissionAction("adoptPolicy", {
                policyId,
                ...draft,
                policyUpdatedAt: c.updatedAt,
                evidence:
                  "Owner confirmed original producer attribution and policy terms against CRM policy " +
                  policyId +
                  " as of " +
                  c.updatedAt +
                  " and the attached carrier statement.",
                confirmed,
              });
              markClean();
              await refresh();
              adopted(policyId);
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "Could not complete policy tracking.",
              );
              if (isAuthorizationError(e)) denied(e);
            } finally {
              lock.current = false;
              setBusy(false);
            }
          })();
        }}
      >
        <fieldset disabled={busy}>
          <label className="field">
            Original producer
            <select
              required
              value={draft.producerId}
              onChange={(e) => {
                setDraft({ ...draft, producerId: e.target.value });
                setConfirmed(false);
              }}
            >
              <option value="">Confirm original producer</option>
              {[
                ...new Map([
                  ...data.plans.map((p) => [p.producerId, p.name] as const),
                  ...(team.data?.team ?? []).map(
                    (p) => [p.userId, p.name] as const,
                  ),
                ]).entries(),
              ].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {plan && (
            <p className="small muted">
              The applicable saved agreement and GIM/standard rate will be
              selected using the original policy dates.
            </p>
          )}
          <div className="form-grid">
            {field("boundOn", "Original bind date", "date")}
            {field("effectiveDate", "Policy effective date", "date")}
            {field("expirationDate", "Policy expiration date", "date")}
            {field("premium", "Policy premium ($)")}
            {field("agencyRate", "Agency commission rate (%)")}
            <label className="field">
              Original transaction
              <select
                required
                value={draft.transaction}
                onChange={(e) => {
                  setDraft({ ...draft, transaction: e.target.value });
                  setConfirmed(false);
                }}
              >
                <option value="">Confirm transaction</option>
                <option value="NEW">New business</option>
                <option value="RENEWAL">Renewal</option>
              </select>
            </label>
          </div>
          <label className="commission-check">
            <input
              type="checkbox"
              checked={correct}
              onChange={(e) => setCorrect(e.target.checked)}
            />{" "}
            Correct existing policy details
          </label>
          <label className="commission-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I verified the original producer, transaction and policy terms
            against source records.
          </label>
          <button
            className="primary"
            disabled={!confirmed || !plan || !c.classification}
          >
            Save tracking & use policy
          </button>
        </fieldset>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

import { useState } from 'react';
import { useCommercial } from '../lib/commercial';
import { communicationRequest } from '../lib/communications';
import {
  fmtMoney,
  LINES_OF_BUSINESS,
  type Carrier,
  type Quote,
} from '../lib/client';
import { agencyDay } from '../../../shared/leadActionGuidance';
import {
  formatCommission,
  emptyCommercialPlan,
  packageAssessment,
  pendingCommission,
  type CommercialPlan,
  type PackageOption,
} from '../../../shared/quotePackages';
import { OpportunityEstimate } from './OpportunityEstimate';

export default function QuotePackages({
  accountId,
  quotes,
  carriers,
}: {
  accountId: string;
  quotes: Quote[];
  carriers: Carrier[];
}) {
  const resource = useCommercial([accountId], quotes),
    plan =
      resource.data.entries[accountId]?.plan ?? emptyCommercialPlan(accountId);
  const [editor, setEditor] = useState<{
    optionId?: string;
    name: string;
    quoteIds: string[];
    requiredLines: string[];
    reviewed: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const today = agencyDay(new Date().toISOString()),
    forecast = pendingCommission(plan, quotes, today);
  const update = (next: CommercialPlan) =>
    resource.setData((data) => ({
      ...data,
      entries: {
        ...data.entries,
        [accountId]: { ...data.entries[accountId], accountId, plan: next },
      },
    }));
  async function write(input: Record<string, unknown>) {
    setSaving(true);
    setError('');
    try {
      const result = await communicationRequest<{ plan: CommercialPlan }>(
        'saveCommercial',
        { accountId, version: plan.version, ...input },
        true,
      );
      update(result.plan);
      setEditor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save package');
    } finally {
      setSaving(false);
    }
  }
  function edit(option?: PackageOption) {
    setError('');
    setEditor({
      optionId: option?.id,
      name: option?.name ?? `Option ${plan.options.length + 1}`,
      quoteIds: option?.quoteIds ?? [],
      requiredLines: plan.requiredLines.length
        ? plan.requiredLines
        : [
            ...new Set(
              quotes
                .filter(
                  (q) =>
                    !q.renewalPolicyId &&
                    q.status !== 'LOST' &&
                    q.status !== 'DECLINED',
                )
                .flatMap((q) =>
                  (q.lines ?? []).filter((l): l is string => !!l),
                ),
            ),
          ],
      reviewed: false,
    });
  }
  return (
    <section className="card" aria-label="Quote packages" id="quote-packages">
      <div className="card-head">
        <h2>Package options</h2>
        <button
          className="secondary"
          disabled={
            resource.loading ||
            !!resource.error ||
            saving ||
            !!plan.selectedOptionId
          }
          onClick={() => edit()}
        >
          + Package option
        </button>
      </div>
      <p className="muted small">
        Combine whole quotes into options you can present to the client. Each
        option must cover the same insurance needs.
      </p>
      {resource.loading ? (
        <p role="status">Loading package options…</p>
      ) : resource.error ? (
        <p className="error-text" role="alert">
          {resource.error}{' '}
          <button onClick={() => void resource.refetch()}>Retry</button>
        </p>
      ) : (
        <>
          <div className="form-grid">
            <div>
              <h3>Estimated opportunity</h3>
              <OpportunityEstimate plan={plan} onSaved={update} />
            </div>
            <div>
              <h3>Pending commission</h3>
              <strong>
                {forecast.cents == null
                  ? '—'
                  : formatCommission(forecast.cents)}
              </strong>
              <p className="muted small">{forecast.label}</p>
            </div>
          </div>
          {!!plan.requiredLines.length && (
            <p className="small">
              Coverages needed: {plan.requiredLines.join(', ')}
            </p>
          )}
          {plan.options.map((option) => {
            const assessment = packageAssessment(plan, option, quotes, today),
              chosen = option.id === plan.selectedOptionId;
            return (
              <article
                key={option.id}
                style={{
                  borderTop: '1px solid var(--border)',
                  padding: '16px 0',
                }}
              >
                <h3>
                  {option.name}{' '}
                  {chosen && (
                    <span className="badge green">Client selected</span>
                  )}
                </h3>
                {option.quoteIds.map((id) => {
                  const q = quotes.find((q) => q.id === id);
                  return (
                    <p className="small" key={id}>
                      {q
                        ? `${carriers.find((c) => c.id === q.carrierId)?.name ?? 'Carrier not recorded'} · ${(q.lines ?? []).join(', ')} · ${q.status === 'BOUND' ? 'Bound' : q.status === 'PRESENTED' ? 'Presented' : q.status === 'QUOTED' ? 'Quoted' : 'Needs review'}`
                        : 'Quote unavailable'}
                    </p>
                  );
                })}
                <p>
                  Premium: {fmtMoney(assessment.premiumCents / 100)} ·
                  Commission:{' '}
                  {assessment.complete
                    ? formatCommission(assessment.commissionCents)
                    : '—'}
                </p>
                {assessment.problems.length ? (
                  <p className="muted small">
                    {assessment.problems.join('. ')}.
                  </p>
                ) : (
                  <p className="small muted">
                    {assessment.boundCount
                      ? `${assessment.boundCount} of ${assessment.quoteCount} policies bound. Remaining commission: ${formatCommission(assessment.pendingCents)}.`
                      : 'Reviewed package · complete coverage option'}
                  </p>
                )}
                <div className="form-actions">
                  {(!plan.selectedOptionId || chosen) && (
                    <>
                      <button
                        className="secondary"
                        disabled={saving}
                        onClick={() => edit(option)}
                      >
                        {chosen ? 'Review / revise option' : 'Edit option'}
                      </button>
                      {(!chosen || forecast.cents == null) && (
                        <button
                          className="primary"
                          disabled={saving || !assessment.complete}
                          onClick={() =>
                            void write({
                              action: 'SELECT',
                              optionId: option.id,
                              clientSelected: true,
                            })
                          }
                        >
                          {chosen
                            ? 'Client approved revised option'
                            : 'Client chose this option'}
                        </button>
                      )}
                      {!chosen && (
                        <button
                          className="link"
                          disabled={saving}
                          onClick={() =>
                            void write({
                              action: 'REMOVE_OPTION',
                              optionId: option.id,
                            })
                          }
                        >
                          Remove option
                        </button>
                      )}
                    </>
                  )}
                  {chosen && (
                    <>
                      <a href="#quote-list">Continue binding policies</a>
                      {!assessment.boundCount && (
                        <button
                          className="link"
                          disabled={saving}
                          onClick={() =>
                            void write({ action: 'CLEAR_SELECTION' })
                          }
                        >
                          Clear client selection
                        </button>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
          {!plan.options.length && (
            <p className="muted">
              Add a bundled quote as one option, or combine separate quotes into
              a complete option.
            </p>
          )}
          {editor && (
            <form
              aria-label="Edit package option"
              onSubmit={(e) => {
                e.preventDefault();
                void write({ action: 'SAVE_OPTION', ...editor });
              }}
              style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}
            >
              <label className="field">
                Option name
                <input
                  value={editor.name}
                  maxLength={100}
                  required
                  onChange={(e) =>
                    setEditor({ ...editor, name: e.target.value })
                  }
                />
              </label>
              <fieldset>
                <legend>Coverages needed for this account</legend>
                {[
                  ...new Set([...LINES_OF_BUSINESS, ...editor.requiredLines]),
                ].map((line) => (
                  <label
                    key={line}
                    style={{
                      display: 'inline-flex',
                      gap: 6,
                      margin: '8px 16px 8px 0',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={editor.requiredLines.includes(line)}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          reviewed: false,
                          requiredLines: e.target.checked
                            ? [...editor.requiredLines, line]
                            : editor.requiredLines.filter((l) => l !== line),
                        })
                      }
                    />
                    {line}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Quotes in this option</legend>
                {quotes
                  .filter(
                    (q) =>
                      !q.renewalPolicyId &&
                      (['QUOTED', 'PRESENTED', 'BOUND'].includes(q.status) ||
                        editor.quoteIds.includes(q.id)),
                  )
                  .map((q) => (
                    <label
                      key={q.id}
                      style={{ display: 'flex', gap: 10, padding: '10px 0' }}
                    >
                      <input
                        type="checkbox"
                        checked={editor.quoteIds.includes(q.id)}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            reviewed: false,
                            quoteIds: e.target.checked
                              ? [...editor.quoteIds, q.id]
                              : editor.quoteIds.filter((id) => id !== q.id),
                          })
                        }
                      />
                      <span>
                        {carriers.find((c) => c.id === q.carrierId)?.name ??
                          'Carrier not recorded'}{' '}
                        · {(q.lines ?? []).join(', ')}
                        <small style={{ display: 'block' }}>
                          {fmtMoney(q.premium)} premium ·{' '}
                          {q.effectiveDate ?? 'No effective date'} to{' '}
                          {q.expirationDate ?? 'No expiration date'}
                        </small>
                      </span>
                    </label>
                  ))}
              </fieldset>
              {!!packageAssessment(
                { ...plan, requiredLines: editor.requiredLines },
                { id: '', name: editor.name, quoteIds: editor.quoteIds },
                quotes,
                today,
                false,
              ).overlaps.length && (
                <p className="small">
                  Some coverage lines overlap. Check limits, layers and carrier
                  requirements before marking this option reviewed.
                </p>
              )}
              <label style={{ display: 'flex', gap: 10, padding: '16px 0' }}>
                <input
                  type="checkbox"
                  checked={editor.reviewed}
                  onChange={(e) =>
                    setEditor({ ...editor, reviewed: e.target.checked })
                  }
                />
                I reviewed these quotes together; their terms and carrier
                requirements work as a complete package.
              </label>
              <div className="form-actions">
                <button
                  className="primary"
                  disabled={saving || !editor.quoteIds.length}
                >
                  Save option
                </button>
                <button
                  className="secondary"
                  type="button"
                  disabled={saving}
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          <p className="muted small">
            Recording the client’s choice does not bind coverage. Continue the
            existing authorization and carrier confirmation steps for each
            selected policy.
          </p>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

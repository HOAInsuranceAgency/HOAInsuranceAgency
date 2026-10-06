import { useRef, useState } from 'react';
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
import './QuotePackages.css';

export default function QuotePackages(props: Parameters<typeof QuotePackagesContent>[0]) {
  return <QuotePackagesContent key={props.accountId} {...props} />;
}

function QuotePackagesContent({
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
  const writeLock = useRef(false);
  async function write(input: Record<string, unknown>) {
    if (writeLock.current) return;
    writeLock.current = true;
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
      writeLock.current = false;
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
  const selectableQuotes = quotes.filter(
    (q) =>
      !q.renewalPolicyId &&
      (['QUOTED', 'PRESENTED', 'BOUND'].includes(q.status) ||
        editor?.quoteIds.includes(q.id)),
  );
  return (
    <section
      className="card quote-packages"
      aria-label="Quote packages"
      id="quote-packages"
    >
      <div className="package-header">
        <div>
          <h2>Package options</h2>
          <p className="muted small">
            Group quotes into complete coverage options for the client.
          </p>
        </div>
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
      {!resource.loaded ? (
        <p className="package-empty" role="status">
          Loading package options…
        </p>
      ) : resource.error ? (
        <p className="error-text" role="alert">
          {resource.error}{' '}
          <button className="secondary" onClick={() => void resource.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <>
          <div className="package-summary">
            <div className="package-metric">
              <h3>Estimated opportunity</h3>
              <OpportunityEstimate plan={plan} onSaved={update} />
            </div>
            <div className="package-metric">
              <h3>Pending commission</h3>
              <strong className="package-metric-value">
                {forecast.cents == null
                  ? '—'
                  : formatCommission(forecast.cents)}
              </strong>
              <p className="muted small">{forecast.label}</p>
            </div>
          </div>
          {!!plan.requiredLines.length && (
            <div className="package-coverages">
              <span className="muted small">Coverages needed</span>
              {plan.requiredLines.map((line) => (
                <span className="package-chip" key={line}>
                  {line}
                </span>
              ))}
            </div>
          )}
          <div className="package-options">
            {plan.options.map((option) => {
              const assessment = packageAssessment(plan, option, quotes, today),
                chosen = option.id === plan.selectedOptionId;
              return (
                <article
                  key={option.id}
                  className={`package-option${chosen ? ' package-option-selected' : ''}`}
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
                  <dl className="package-totals">
                    <div>
                      <dt>Premium</dt>
                      <dd>{fmtMoney(assessment.premiumCents / 100)}</dd>
                    </div>
                    <div>
                      <dt>Commission</dt>
                      <dd>
                        {assessment.complete
                          ? formatCommission(assessment.commissionCents)
                          : '—'}
                      </dd>
                    </div>
                  </dl>
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
          </div>
          {!plan.options.length && !editor && (
            <div className="package-empty">
              <strong>No package options yet</strong>
              <p>
                Add an option using one bundled quote or several quotes with
                matching coverage needs.
              </p>
            </div>
          )}
          {editor && (
            <form
              aria-label="Edit package option"
              onSubmit={(e) => {
                e.preventDefault();
                void write({ action: 'SAVE_OPTION', ...editor });
              }}
              className="package-editor"
            >
              <h3>
                {editor.optionId ? 'Edit package option' : 'New package option'}
              </h3>
              <div className="field package-name">
                <label htmlFor="package-option-name">Option name</label>
                <input
                  id="package-option-name"
                  value={editor.name}
                  disabled={saving}
                  maxLength={100}
                  required
                  onChange={(e) =>
                    setEditor({ ...editor, name: e.target.value })
                  }
                />
              </div>
              <div className="package-editor-grid">
                <fieldset className="package-fieldset" disabled={saving}>
                  <legend>Coverages needed for this account</legend>
                  <div className="package-coverage-grid">
                    {[
                      ...new Set([
                        ...LINES_OF_BUSINESS,
                        ...editor.requiredLines,
                      ]),
                    ].map((line) => (
                      <label
                        key={line}
                        className={`package-choice${editor.requiredLines.includes(line) ? ' is-selected' : ''}`}
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
                                : editor.requiredLines.filter(
                                    (l) => l !== line,
                                  ),
                            })
                          }
                        />
                        <span>{line}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="package-fieldset" disabled={saving}>
                  <legend>Quotes in this option</legend>
                  <div className="package-quote-choices">
                    {!selectableQuotes.length && (
                      <div className="package-empty">
                        <strong>No quotes available</strong>
                        <p>
                          Add a quote and mark it Quoted or Presented to include
                          it in this option.
                        </p>
                        <a href="#quote-list">Go to quotes</a>
                      </div>
                    )}
                    {selectableQuotes.map((q) => (
                      <label
                        key={q.id}
                        className={`package-choice package-quote-choice${editor.quoteIds.includes(q.id) ? ' is-selected' : ''}`}
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
                          <small>
                            {fmtMoney(q.premium)} premium ·{' '}
                            {q.effectiveDate ?? 'No effective date'} to{' '}
                            {q.expirationDate ?? 'No expiration date'}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              {!!packageAssessment(
                { ...plan, requiredLines: editor.requiredLines },
                { id: '', name: editor.name, quoteIds: editor.quoteIds },
                quotes,
                today,
                false,
              ).overlaps.length && (
                <p className="package-notice small">
                  Some coverage lines overlap. Check limits, layers and carrier
                  requirements before marking this option reviewed.
                </p>
              )}
              <label className="package-review">
                <input
                  type="checkbox"
                  checked={editor.reviewed}
                  disabled={saving}
                  onChange={(e) =>
                    setEditor({ ...editor, reviewed: e.target.checked })
                  }
                />
                <span>
                  I reviewed these quotes together; their terms and carrier
                  requirements work as a complete package.
                </span>
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
          <p className="package-footer muted small">
            Client selection does not bind coverage. Record authorization and
            carrier confirmation for each selected policy.
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

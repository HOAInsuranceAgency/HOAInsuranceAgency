import { useEffect, useId, useMemo, useRef, useState } from "react";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { Button } from "../../components/ui/Button";
import { assertGraphqlErrors } from '../../lib/apiResponse';
import { client, friendlyError, type Account } from "../../lib/client";
import { ExtractionReviewTable } from './ExtractionReviewTable';
import { applyExtractionReview } from './applyExtractionReview';
import { ExtractedField, fieldDefsFor, isEmpty, namedContact, parseExtraction, usableBuilding, usableLoss } from './extractionModel';
import { useExtractionCandidates } from './useExtractionCandidates';

export default function ExtractionPanel(props: Parameters<typeof ExtractionPanelContent>[0]) {
  return <ExtractionPanelContent key={props.account.id} {...props} />;
}

function ExtractionPanelContent({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  const reviewId = useId();
  const [starting, setStarting] = useState(false);
  // `error` now belongs to `start()` alone; `apply()`'s whole lifecycle —
  // in-flight, applied, failed — is the one state machine below.
  const [error, setError] = useState("");
  const applyStatus = useSaveStatus();
  const applyLock = useRef(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [selectedBuildings, setSelectedBuildings] = useState<Record<number, boolean>>({});
  const [selectedContacts, setSelectedContacts] = useState<Record<number, boolean>>({});
  const [selectedLosses, setSelectedLosses] = useState<Record<number, boolean>>({});
  const [showReview, setShowReview] = useState(true);
  const startLock = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const status = account.extractionStatus;
  const extractionKey = typeof account.aiExtraction === 'string' ? account.aiExtraction : JSON.stringify(account.aiExtraction);
  const result = useMemo(() => parseExtraction(extractionKey), [extractionKey]);

  /**
   * This exact extraction has already been applied.
   *
   * `aiExtractionAppliedAt` stores the applied result's `extractedAt` — the
   * identity of a result, not the moment somebody pressed the button — so
   * this is true only until a re-run produces a different one. A result with
   * no `extractedAt` (nothing in the app writes one, but an old row might)
   * cannot be proved to be the same, so it is treated as unapplied.
   */
  const alreadyApplied = Boolean(
    result?.extractedAt && result.extractedAt === account.aiExtractionAppliedAt
  );

  const { contactsRes, lossesRes, buildingsRes, contactCandidates, lossCandidates, buildingCandidates } = useExtractionCandidates(account.id, result);

  // Poll while an extraction is in flight (30-90s typical).
  useEffect(() => {
    if (status === "PENDING" || status === "PROCESSING") {
      let active = true, pending = false;
      const timer = setInterval(async () => {
        if (pending) return;
        pending = true;
        try {
          const { data, errors } = await client.models.Account.get({ id: account.id });
          assertGraphqlErrors({ errors });
          if (!data) throw new Error(errors?.[0]?.message ?? 'Could not refresh extraction status');
          if (!active) return;
          setError('');
          if (data.extractionStatus !== status) onChange(data);
        } catch (err) {
          if (active) setError(friendlyError(err, 'Could not refresh extraction status. Retrying…'));
        } finally { pending = false; }
      }, 4000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, account.id]);

  // Pre-select high/medium confidence fields whenever a new result arrives.
  useEffect(() => {
    if (!result) return;
    const initial: Record<string, boolean> = {};
    for (const def of fieldDefsFor(account)) {
      const f = result[def.key] as ExtractedField | undefined;
      if (f && !isEmpty(f.value)) initial[def.key] = f.confidence !== "low";
    }
    setSelected(initial);
    // Selection is set from the candidate alone, never from its verdict: the
    // existing rows load asynchronously, so a verdict computed here would be
    // whatever it happened to be before the reads settled. "Identical" is
    // enforced at render and at apply instead, where the answer is current.
    const b: Record<number, boolean> = {};
    (result.buildings ?? []).forEach((bd, i) => {
      if (usableBuilding(bd)) b[i] = true;
    });
    setSelectedBuildings(b);
    const c: Record<number, boolean> = {};
    (result.contacts ?? []).forEach((ct, i) => {
      if (namedContact(ct)) c[i] = true;
    });
    setSelectedContacts(c);
    const ls: Record<number, boolean> = {};
    (result.losses ?? []).forEach((l, i) => {
      if (usableLoss(l)) ls[i] = true;
    });
    setSelectedLosses(ls);
    // A fresh extraction means the previous "Applied" no longer describes
    // what is on screen — the same event the form setters signal elsewhere.
    applyStatus.markDirty();
    setShowReview(true); // expand on a fresh extraction
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  async function start() {
    if (startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setError("");
    try {
      const { errors } = await client.mutations.startLeadExtraction({
        accountId: account.id,
      });
      assertGraphqlErrors({ errors: errors });
      const { data, errors: readErrors } = await client.models.Account.get({ id: account.id });
      if (readErrors?.length || !data) throw new Error(readErrors?.[0]?.message ?? 'Could not refresh extraction status');
      if (live.current) onChange(data);
    } catch (err) {
      setError(friendlyError(err, "Could not start extraction"));
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }

  /**
   * @param force set by "Apply again anyway", the only way past the
   *   idempotency guard. A parameter rather than a piece of state so the
   *   guard cannot be left switched off by a click three minutes ago.
   */
  async function apply(force = false) {
    if (!result || applyLock.current) return;
    if (!matchesReady) {
      applyStatus.markError('Load existing contacts, losses and buildings before applying extracted rows.');
      return;
    }
    applyLock.current = true;
    try {
      await applyStatus.run(
        () => applyExtractionReview({ account, result, alreadyApplied, force, selected, selectedContacts, selectedLosses, selectedBuildings, contactCandidates, lossCandidates, buildingCandidates, existingContacts: contactsRes.data, refreshContacts: contactsRes.refetch, refreshLosses: lossesRes.refetch, refreshBuildings: buildingsRes.refetch, onApplied: data => { if (live.current) onChange(data); } }),
        {
          savedMessage: "Applied to the account.",
          errorMessage: "Apply failed",
        }
      );
    } finally { applyLock.current = false; }
  }

  const extractedFields = result ? fieldDefsFor(account).filter(def => {
    const field = result[def.key] as ExtractedField | undefined;
    return field && !isEmpty(field.value);
  }) : [];
  const reviewCount = extractedFields.length + contactCandidates.length + lossCandidates.length + buildingCandidates.length;
  const selectedCount = extractedFields.filter(def => selected[def.key]).length
    + contactCandidates.filter(c => selectedContacts[c.i] && c.match.verdict !== "identical").length
    + lossCandidates.filter(l => selectedLosses[l.i] && l.match.verdict !== "identical").length
    + buildingCandidates.filter(b => selectedBuildings[b.i] && b.match.verdict !== "identical").length;
  const matchingReads = [
    ...(contactCandidates.length ? [{ label: 'contacts', resource: contactsRes }] : []),
    ...(lossCandidates.length ? [{ label: 'losses', resource: lossesRes }] : []),
    ...(buildingCandidates.length ? [{ label: 'buildings', resource: buildingsRes }] : []),
  ];
  const matchesReady = matchingReads.every(({ resource }) => resource.loaded && !resource.loading && !resource.error);

  return (
    <section className="card extraction-panel" aria-label="Extracted data">
      <div className="extraction-heading">
        <div>
          <h2>Extracted data</h2>
          <p>Review values from your documents before applying them to this account.</p>
        </div>
        <Button
          variant={result ? "secondary" : "primary"}
          disabled={starting || applyStatus.busy || status === "PENDING" || status === "PROCESSING"}
          onClick={start}
        >
          {status === "PENDING" || status === "PROCESSING"
            ? "Extracting… (30–90s)"
            : starting
              ? "Starting…"
              : result
                ? "Re-run extraction"
                : "Extract data"}
        </Button>
      </div>
      {status === "FAILED" && <p className="error-text extraction-feedback" role="alert">{account.extractionError ?? "Extraction failed"}</p>}
      {error && <p className="error-text extraction-feedback" role="alert">{error}</p>}
      {matchingReads.map(({ label, resource }) => resource.error && <p key={label} role="alert" className="error-text">
        Could not check existing {label}. {resource.error} <Button type="button" disabled={resource.loading} onClick={() => void resource.refetch()}>Retry {label}</Button>
      </p>)}

      {result && status === "COMPLETE" && (
        <>
          {result.summary && (
            <details className="extraction-summary extraction-disclosure">
              <summary>Extraction summary</summary>
              <p>{result.summary}</p>
            </details>
          )}

          <div className="extraction-review-heading">
            <div className="extraction-review-counts">
              <strong>{reviewCount} item{reviewCount === 1 ? "" : "s"} to review</strong>
              <span aria-live="polite">{selectedCount} selected</span>
              {alreadyApplied && <span className="badge gray">Previously applied</span>}
            </div>
            <Button variant="secondary"

              aria-expanded={showReview}
              aria-controls={reviewId}
              onClick={() => setShowReview((s) => !s)}
            >
              {showReview ? "Hide review" : "Review extracted data"}
            </Button>
          </div>

          {showReview && (
            <div id={reviewId}>
              {reviewCount === 0 ? <p className="extraction-empty">No values found to review. Add another document or re-run extraction.</p> : <div className="table-wrap extraction-table-wrap">
                <ExtractionReviewTable account={account} result={result} extractedFields={extractedFields} selected={selected} setSelected={setSelected} selectedContacts={selectedContacts} setSelectedContacts={setSelectedContacts} selectedLosses={selectedLosses} setSelectedLosses={setSelectedLosses} selectedBuildings={selectedBuildings} setSelectedBuildings={setSelectedBuildings} contactCandidates={contactCandidates} lossCandidates={lossCandidates} buildingCandidates={buildingCandidates} busy={applyStatus.busy} />
              </div>}

              <div className="form-actions extraction-actions">
                <Button variant="primary"

                  disabled={applyStatus.busy || !matchesReady}
                  onClick={() => apply()}
                >
                  {applyStatus.busy
                    ? "Applying…"
                    : `Apply selected to ${account.stage === "CLIENT" ? "client" : "lead"}`}
                </Button>
                {/* The guard is a default, not a wall. A reviewer who has since
                ticked a field they skipped the first time has a legitimate
                reason to apply the same result again, and blocking that
                outright would send them to edit the record by hand. */}
                {alreadyApplied && (
                  <Button variant="link"

                    disabled={applyStatus.busy || !matchesReady}
                    onClick={() => apply(true)}
                  >
                    Apply again anyway
                  </Button>
                )}
                <SaveStatus {...applyStatus.status} />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

import { useRef, useState } from "react";
import { uploadData } from "../../lib/scopedStorage";
import {
  client,
  fmtDate,
  friendlyError,
  listAllPages,
  TEMPLATE_MISSING_MESSAGE,
  type Account,
  type Carrier,
  type Certificate,
  type Policy,
  type UserProfile,
} from "../../lib/client";
import {
  aiFillGaps,
  fillAcord25,
  signatureFor,
  type AiFilledField,
} from "../../lib/acord";
import { downloadFile } from "../../lib/storage";
import { useSort, SortTh } from "../../lib/useSort";
import { isAuthorizationError } from "../../lib/authorizationError";
import { useAsyncResource } from "../../lib/useAsyncResource";
import AiFilledList from "../../components/AiFilledList";
import FilePreviewModal from "../../components/FilePreview";
import { SaveStatus, useSaveStatus } from "../../components/SaveStatus";
import { useFormState } from "../../lib/useFormState";

export function CertificatesTab(props: Parameters<typeof CertificatesTabContent>[0]) {
  return <CertificatesTabContent key={`${props.account.id}:${props.sourceCommunicationId ?? ""}`} {...props} />;
}

function CertificatesTabContent({
  account,
  profile,
  sourceCommunicationId,
}: {
  account: Account;
  sourceCommunicationId?: string;
  profile: UserProfile;
}) {
  const certRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Certificate.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Certificate[], errorMessage: "Failed to load certificates", clearDataOnError: isAuthorizationError }
  );
  const certs = certRes.data;
  const setCerts = certRes.setData;

  const policyRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Policy.list({
          filter: { accountId: { eq: account.id } },
          nextToken,
        })
      ),
    [account.id],
    { initialData: [] as Policy[], errorMessage: "Failed to load policies", clearDataOnError: isAuthorizationError }
  );
  const policies = policyRes.data;

  /**
   * Surfaced rather than ignored, and this one is not cosmetic: `carriers` is
   * handed to `fillAcord25`, so a failed read produces a certificate PDF with
   * the insurer block silently blank.
   */
  const carrierRes = useAsyncResource(
    () => listAllPages(nextToken => client.models.Carrier.list({ nextToken })),
    [],
    { initialData: [] as Carrier[], errorMessage: "Failed to load carriers", clearDataOnError: isAuthorizationError }
  );
  const carriers = carrierRes.data;

  const [showForm, setShowForm] = useState(!!sourceCommunicationId);
  const { form, setF, reset } = useFormState({
    holderName: "",
    holderAddress: "",
    description: "",
    selectedPolicies: [] as string[],
  });
  const issueStatus = useSaveStatus();
  const issuePending = useRef(false);
  const generationPending = useRef(false);
  const saving = issueStatus.busy;
  const referencesReady = certRes.loaded && !certRes.loading && !certRes.error &&
    policyRes.loaded && !policyRes.loading && !policyRes.error &&
    carrierRes.loaded && !carrierRes.loading && !carrierRes.error;
  // Which certificate is being filled — the button label is per row, so this
  // stays alongside the panel-level status below.
  const [generating, setGenerating] = useState<string | null>(null);
  // The amber "generated UNSIGNED" note and the red failure were two separate
  // pieces of state that could both be on screen at once, describing the same
  // run. One state machine now, with the note as `run`'s warning return.
  const genStatus = useSaveStatus();
  const [error, setError] = useState("");
  const [previewCert, setPreviewCert] = useState<Certificate | null>(null);
  // What the AI put on the certificate just generated. Cleared at the start
  // of every run, so a stale list can never sit under a fresh outcome.
  const [aiFilled, setAiFilled] = useState<AiFilledField[]>([]);

  async function issue() {
    if (!form.holderName.trim() || !referencesReady || generationPending.current || issuePending.current) return;
    issuePending.current = true;
    const submitted = form;
    await issueStatus.run(async () => {
      setError("");
      const { data: reserved, errors: reserveErrors } = await client.mutations.reserveCertificateNumber();
      if (reserveErrors?.length) throw new Error(reserveErrors[0].message);
      const body = typeof reserved === "string" ? JSON.parse(reserved) : reserved;
      const certificateNumber = body?.certificateNumber;
      if (!certificateNumber) throw new Error("Couldn't reserve a certificate number. Nothing was saved; try again.");
      const { data, errors } = await client.models.Certificate.create({
        accountId: account.id,
        sourceCommunicationId,
        certificateNumber,
        policyIds: submitted.selectedPolicies,
        holderName: submitted.holderName.trim(),
        holderAddress: submitted.holderAddress.trim() || undefined,
        descriptionOfOperations: submitted.description.trim() || undefined,
        formType: "ACORD_25",
        issuedBy: `${profile.firstName} ${profile.lastName}`,
        issuedAt: new Date().toISOString(),
      });
      if (errors?.length || !data) throw new Error(errors?.[0]?.message ?? "Couldn't record the certificate. Your entries are still here; try again.");
      setCerts(cs => [data, ...cs]);
      setShowForm(false);
      reset();
      await generatePdf(data, true);
    }, { savedMessage: "Certificate recorded.", errorMessage: "Couldn't record the certificate. Your entries are still here; try again." });
    issuePending.current = false;
  }

  async function generatePdf(cert: Certificate, fromIssue = false) {
    if (!referencesReady || generationPending.current || (issuePending.current && !fromIssue)) return;
    generationPending.current = true;
    await genStatus.run(async () => {
      setGenerating(cert.id);
      setError("");
      setAiFilled([]);
      try {
        const { bytes, missing, unsigned, pdf, empty } = await fillAcord25(
          account,
          cert,
          policies,
          carriers,
          await signatureFor(profile.id)
        );
        // Deterministic first, AI only in the gaps — and on a certificate the
        // review list below matters more than anywhere else in the app: this
        // is the document a holder relies on, and a wrong limit on it is a
        // representation the agency made.
        const ai = await aiFillGaps(pdf, bytes, empty, account.id, "acord25");
        setAiFilled(ai.applied);
        const path = `certificates/${account.id}/${cert.id}.pdf`;
        await uploadData({
          path,
          data: new Blob([ai.bytes as BlobPart], { type: "application/pdf" }),
          options: { contentType: "application/pdf" },
        }).result;
        const { data, errors } = await client.models.Certificate.update({
          id: cert.id,
          s3Key: path,
        });
        // The PDF is in S3 either way, but without the s3Key on the record
        // the Preview/Download buttons never appear — previously that failure
        // was silent and the row just kept saying "Generate PDF".
        if (errors?.length || !data) {
          throw new Error(
            errors?.[0]?.message ??
              "The PDF was created but couldn't be attached to the certificate — try Regenerate."
          );
        }
        setCerts((cs) => cs.map((c) => (c.id === cert.id ? data : c)));
        const notes: string[] = [];
        if (missing.length) {
          notes.push(
            `Generated, but these fields had no match in the template: ${missing.join(", ")}. ` +
              "Use Settings → Inspect fields to extend the mapping."
          );
        }
        if (unsigned) {
          notes.push(
            `The certificate went out UNSIGNED — ${unsigned}. Sign it by hand before sending it to the holder.`
          );
        }
        if (ai.applied.length) {
          notes.push(
            `${ai.applied.length} blank field${ai.applied.length === 1 ? " was" : "s were"} completed by AI — check the list below before sending this to the holder.`
          );
        }
        if (ai.note) notes.push(ai.note);
        // A note means the PDF exists but the user has to act on it: that is
        // `run`'s warning arm, not a second success flag.
        return notes.join(" ");
      } catch (err) {
        const msg = friendlyError(err, "unknown error");
        // A classified template failure already explains itself and says where
        // to go; anything else keeps the prefix naming what was being done.
        // `run` re-runs friendlyError over this, which is a no-op for both
        // shapes — neither matches a classifier once it has been prefixed.
        throw new Error(
          msg === TEMPLATE_MISSING_MESSAGE ? msg : `PDF generation failed: ${msg}`
        );
      } finally {
        setGenerating(null);
      }
    }, { savedMessage: "Certificate PDF generated." });
    generationPending.current = false;
  }

  async function downloadPdf(cert: Certificate) {
    if (!cert.s3Key) return;
    setError("");
    try {
      // Certificate keys are generated, so their last segment is already a
      // reasonable filename — but the number is what the row is identified by.
      await downloadFile(cert.s3Key, {
        filename: cert.certificateNumber
          ? `Certificate ${cert.certificateNumber}.pdf`
          : undefined,
      });
    } catch (err) {
      setError(
        `That certificate couldn't be downloaded — ${friendlyError(err, "unknown error")}`
      );
    }
  }

  // Most recently issued first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    certs,
    {
      number: (c) => c.certificateNumber,
      holder: (c) => c.holderName,
      form: (c) => c.formType ?? "ACORD_25",
      issued: (c) => c.issuedAt,
      by: (c) => c.issuedBy,
    },
    "issued",
    "desc"
  );

  return (
    <div className="card">
      <h2>Certificates of Insurance</h2>
      <p className="muted small">
        Issuing a certificate fills the ACORD 25 template (uploaded in
        Settings) from this account's policies and stores the PDF with the
        issuance record.
      </p>

      {account.stage !== "CLIENT" ? (
        <p className="muted small">COIs can be issued once this lead becomes a client.</p>
      ) : (
        <>
          <div className="toolbar">
            <div className="grow" />
            <button className="primary" disabled={saving} onClick={() => setShowForm(!showForm)}>
              {showForm ? "Cancel" : "+ New certificate"}
            </button>
          </div>

          {showForm && (
            <div className="card" style={{ background: "#f8fafc" }}>
              <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0 }}>
              <div className="form-grid">
                <div className="field">
                  <label>Certificate holder *</label>
                  <input value={form.holderName} onChange={(e) => setF("holderName", e.target.value)} />
                </div>
                <div className="field">
                  <label>Holder address</label>
                  <input
                    value={form.holderAddress}
                    onChange={(e) => setF("holderAddress", e.target.value)}
                  />
                </div>
                <div className="field full">
                  <label>Description of operations</label>
                  <textarea
                    rows={2}
                    value={form.description}
                    onChange={(e) => setF("description", e.target.value)}
                  />
                </div>
                <div className="field full">
                  <label>Policies on certificate</label>
                  {!policyRes.loaded ? (
                    <span className="muted small">Loading…</span>
                  ) : policyRes.error ? (
                    <span className="error-text">Policies are unavailable. Retry below before issuing.</span>
                  ) : policies.length === 0 ? (
                    <span className="muted small">No policies on this account.</span>
                  ) : (
                    policies.map((p) => (
                      <label
                        key={p.id}
                        className="small"
                        style={{ display: "flex", gap: 6, alignItems: "center" }}
                      >
                        <input
                          type="checkbox"
                          checked={form.selectedPolicies.includes(p.id)}
                          onChange={(e) =>
                            setF("selectedPolicies", (ids) =>
                              e.target.checked
                                ? [...ids, p.id]
                                : ids.filter((i) => i !== p.id)
                            )
                          }
                        />
                        {p.policyNumber || "(no number)"} —{" "}
                        {(p.lines ?? []).filter(Boolean).join(", ")}
                      </label>
                    ))
                  )}
                </div>
              </div>
              </fieldset>
              <div className="form-actions">
                <button
                  className="primary"
                  disabled={saving || genStatus.busy || !referencesReady || !form.holderName.trim()}
                  onClick={issue}
                >
                  {saving ? "Saving…" : "Record certificate"}
                </button>
              </div>
            </div>
          )}

          <SaveStatus {...issueStatus.status} />
          {genStatus.status.state !== "idle" && (
            <p style={{ margin: "10px 0" }}>
              <SaveStatus {...genStatus.status} />
            </p>
          )}
          <AiFilledList fields={aiFilled} />
          {/* `error` is the issue/generate failure; the reads have their own. */}
          {error && <p className="error-text">{error}</p>}
          {carrierRes.error && <p className="error-text">{carrierRes.error} <button disabled={carrierRes.loading} onClick={() => void carrierRes.refetch()}>Retry carriers</button></p>}
          {policyRes.error && <p className="error-text">{policyRes.error} <button disabled={policyRes.loading} onClick={() => void policyRes.refetch()}>Retry policies</button></p>}
          {certRes.error && <p className="error-text">{certRes.error} <button disabled={certRes.loading} onClick={() => void certRes.refetch()}>Retry certificates</button></p>}

          {!certRes.loaded ? (
            <p className="muted small">Loading…</p>
          ) : certs.length === 0 && !certRes.error ? (
            <p className="muted small">No certificates issued.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh label="Cert #" colKey="number" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Holder" colKey="holder" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Form" colKey="form" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="Issued" colKey="issued" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <SortTh label="By" colKey="by" sortKey={sortKey} dir={dir} onToggle={toggle} />
                    <th>PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => (
                    <tr key={c.id}>
                      <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                        {c.certificateNumber ?? "—"}
                      </td>
                      <td>{c.holderName}</td>
                      <td>
                        <span className="badge gray">{c.formType ?? "ACORD_25"}</span>
                      </td>
                      <td>{fmtDate(c.issuedAt?.slice(0, 10))}</td>
                      <td>{c.issuedBy ?? "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {c.s3Key ? (
                          <>
                            <button className="link" onClick={() => setPreviewCert(c)}>
                              Preview
                            </button>
                            <button className="link" onClick={() => downloadPdf(c)}>
                              Download
                            </button>
                            <button
                              className="link"
                              disabled={genStatus.busy || saving || !referencesReady}
                              onClick={() => generatePdf(c)}
                            >
                              {generating === c.id ? "Regenerating…" : "Regenerate"}
                            </button>
                          </>
                        ) : (
                          <button
                            className="link"
                            disabled={genStatus.busy || saving || !referencesReady}
                            onClick={() => generatePdf(c)}
                          >
                            {generating === c.id ? "Generating…" : "Generate PDF"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {previewCert?.s3Key && (
        <FilePreviewModal
          s3Key={previewCert.s3Key}
          name={`ACORD 25 — ${previewCert.holderName}.pdf`}
          onClose={() => setPreviewCert(null)}
        />
      )}
    </div>
  );
}

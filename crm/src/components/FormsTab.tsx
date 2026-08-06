import { useState } from "react";
import { uploadData } from "aws-amplify/storage";
import {
  client,
  fmtDateTime,
  friendlyError,
  listAllPages,
  TEMPLATE_MISSING_MESSAGE,
  type Account,
  type CrmDocument,
} from "../lib/client";
import {
  ACORD_FORMS,
  MAPPED_APP_FORM_KEYS,
  aiFillGaps,
  buildingPages,
  fillAcordApp,
  signatureFor,
  type AcordFormDef,
  type AiFilledField,
} from "../lib/acord";
import type { UserProfile } from "../lib/client";
import { useSort, SortTh } from "../lib/useSort";
import { useAsyncResource } from "../lib/useAsyncResource";
import AiFilledList from "./AiFilledList";
import FilePreviewModal from "./FilePreview";
import { SaveStatus, useSaveStatus } from "./SaveStatus";

const APP_FORMS = ACORD_FORMS.filter((f) => f.key !== "acord25");

/**
 * Carrier-submission forms: fill an uploaded ACORD template (125/126/140/…)
 * from this account's data, store the PDF under generated/, and track it as
 * an ACORD_FORM document.
 */
export default function FormsTab({
  account,
  profile,
}: {
  account: Account;
  profile: UserProfile;
}) {
  const genRes = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.Document.list({
          filter: {
            entityId: { eq: account.id },
            category: { eq: "ACORD_FORM" },
          },
          nextToken,
        })
      ),
    [account.id],
    {
      initialData: [] as CrmDocument[],
      // A failed read renders "Nothing generated yet.", so the user
      // regenerates a form that already exists and gets a duplicate row plus
      // a duplicate S3 object.
      errorMessage: "Failed to load generated forms",
    }
  );
  const generated = genRes.data;
  const setGenerated = genRes.setData;
  // Which row's button reads "Generating…" — per-row, so it stays. The
  // outcome is panel-level and belongs to the status machine.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Was an amber `note` for every outcome plus a separate red `error`; the
  // note is now `run`'s warning arm and a clean generation is green.
  const genStatus = useSaveStatus();
  const [preview, setPreview] = useState<CrmDocument | null>(null);
  // What the AI put on the last document generated here, per page. Cleared at
  // the start of every run so the panel can never show one form's review list
  // beside another form's outcome.
  const [aiFilled, setAiFilled] = useState<{ page: string; fields: AiFilledField[] }[]>(
    []
  );


  // Most recently generated first, as the fetch used to order them.
  const { sorted, sortKey, dir, toggle } = useSort(
    generated,
    {
      file: (d) => d.name,
      generated: (d) => d.createdAt,
    },
    "generated",
    "desc"
  );

  async function generate(form: AcordFormDef) {
    setBusyKey(form.key);
    setAiFilled([]);
    await genStatus.run(
      async () => {
        try {
          const buildings = await listAllPages((nextToken) =>
            client.models.Building.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );
          // Fills the insured phone and the 125's inspection block, which
          // were `Account.contactPhone` and `Account.inspectionContact*`
          // before W1. Read here rather than in `acordApp` so the mapping
          // stays a pure function of what it is handed.
          const contacts = await listAllPages((nextToken) =>
            client.models.Contact.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );
          // Fills the 125's prior-coverage block, one row per line. Read for
          // clients too: the tab that edits these is lead-only, but a renewal
          // submission still has to declare what the association carried.
          const priorCarriers = await listAllPages((nextToken) =>
            client.models.PriorCarrier.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );
          // Clients renew off their bound policies; the lead-only
          // currentPolicyExpiration field isn't used once an account converts.
          let renewalDate: string | null = null;
          let lines: string[] = [];
          if (account.stage === "CLIENT") {
            const pols = await listAllPages((nextToken) =>
              client.models.Policy.list({
                filter: { accountId: { eq: account.id } },
                nextToken,
              })
            );
            const active = pols.filter((p) => p.status === "ACTIVE");
            const ends = active
              .filter((p) => p.expirationDate)
              .map((p) => p.expirationDate as string)
              .sort();
            renewalDate = ends[0] ?? null;
            // What we're applying for = what's on the book today.
            lines = [
              ...new Set(active.flatMap((p) => (p.lines ?? []).filter(Boolean))),
            ] as string[];
          } else {
            renewalDate = account.currentPolicyExpiration ?? null;
            // A prospect has no policy yet — fall back to whatever's been quoted.
            const qs = await listAllPages((nextToken) =>
              client.models.Quote.list({
                filter: { accountId: { eq: account.id } },
                nextToken,
              })
            );
            lines = [
              ...new Set(qs.flatMap((q) => (q.lines ?? []).filter(Boolean))),
            ] as string[];
          }

          // The GL application supplies the 125's employee counts. A missing
          // one is not an error: most accounts have never been asked.
          const glRows = await listAllPages((nextToken) =>
            client.models.GlApplication.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );

          // The 126's classification schedule.
          const glClassCodes = await listAllPages((nextToken) =>
            client.models.GlClassCode.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );

          // The blanket schedule: the 140's summary rows, repeated on every
          // page of a multi-page set.
          const blankets = await listAllPages((nextToken) =>
            client.models.Blanket.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );

          // Loss history: the 125's three loss rows, its total, and the
          // loss-summary attachment box when there are more than three.
          const losses = await listAllPages((nextToken) =>
            client.models.Loss.list({
              filter: { accountId: { eq: account.id } },
              nextToken,
            })
          );

          // The 140 describes two buildings per PDF, so an account with five
          // of them produces three documents. Every other form is one page of
          // buildings — `buildingPages` returns a single group for them.
          const pages =
            form.key === "acord140" ? buildingPages(buildings) : [buildings];
          const signature = await signatureFor(profile.id);
          const stamp = new Date().toISOString().slice(0, 10);
          const safeName = account.name.replace(/[^\w-]+/g, "_");
          const allMissing = new Set<string>();
          let unsigned: string | undefined;
          const aiNotes: string[] = [];
          const reviewed: { page: string; fields: AiFilledField[] }[] = [];

          for (const [page, pageBuildings] of pages.entries()) {
            const filled = await fillAcordApp(
              form,
              account,
              pageBuildings,
              contacts,
              priorCarriers,
              blankets,
              losses,
              glRows[0] ?? null,
              glClassCodes,
              signature,
              renewalDate,
              lines
            );
            for (const m of filled.missing) allMissing.add(m);
            unsigned = unsigned ?? filled.unsigned;

            // Deterministic first, AI only in the gaps. A value the mapping
            // wrote is not on the table: `filled.empty` is the fields that
            // came out blank, and it is the only thing offered.
            const ai = await aiFillGaps(
              filled.pdf,
              filled.bytes,
              filled.empty,
              account.id,
              form.key
            );
            const label = pages.length > 1 ? `${page + 1} of ${pages.length}` : "";
            if (ai.applied.length) reviewed.push({ page: label, fields: ai.applied });
            if (ai.note) aiNotes.push(label ? `Page ${label}: ${ai.note}` : ai.note);

            // Numbered only when there is more than one, so the common case
            // keeps the filename it has always had.
            const suffix = pages.length > 1 ? `-${page + 1}of${pages.length}` : "";
            const filename = `${form.key}-${safeName}-${stamp}${suffix}.pdf`;
            const path = `generated/${account.id}/${Date.now()}-${filename}`;
            await uploadData({
              path,
              data: new Blob([ai.bytes as BlobPart], { type: "application/pdf" }),
              options: { contentType: "application/pdf" },
            }).result;

            const { data: doc, errors } = await client.models.Document.create({
              entityType: "ACCOUNT",
              entityId: account.id,
              category: "ACORD_FORM",
              name: filename,
              s3Key: path,
              contentType: "application/pdf",
              sizeBytes: ai.bytes.byteLength,
              ocrStatus: "SKIPPED",
            });
            // The PDF is in S3 either way, but without the Document row it
            // never appears in "Generated forms" — previously that failure was
            // silent and the panel still said "Generated".
            if (errors?.length || !doc) {
              throw new Error(
                errors?.[0]?.message ??
                  "The PDF was created but couldn't be recorded — it won't appear in the list below."
              );
            }
            setGenerated((ds) => [doc, ...ds]);
          }
          const missing = [...allMissing];
          // Set before the outcome sentence is composed, so the list is on
          // screen with the message that refers to it.
          setAiFilled(reviewed);
          const aiCount = reviewed.reduce((n, r) => n + r.fields.length, 0);

          // Same sentences as before, composed the same way. What changed is
          // severity: unmatched fields or an unsigned form are things the
          // user has to act on, so they are `run`'s warning arm; a run with
          // neither is a clean success and takes `savedMessage` instead of
          // the same amber span every outcome used to share.
          const note = [
            // Every segment here ends in a full stop, because they are joined
            // with a space into one paragraph. This one did not, and on
            // staging it read "…producerEmail, insuredPhone The AI answered
            // none of the blanks" — two sentences run together at the exact
            // point a reader is scanning for what to do next.
            missing.length
              ? `Generated${pages.length > 1 ? ` ${pages.length} pages` : ""}. Unmatched fields (extend the mapping via Settings → Inspect fields): ${missing.join(", ")}.`
              : `Generated${pages.length > 1 ? ` ${pages.length} pages` : ""} — every mapped field matched.`,
            unsigned &&
              `The form went out UNSIGNED — ${unsigned}. Sign it by hand before submitting.`,
            // A count, not a verdict: the values are below and the producer
            // is being told to go and read them.
            aiCount &&
              `${aiCount} blank field${aiCount === 1 ? " was" : "s were"} completed by AI — check the list below before submitting.`,
            ...aiNotes,
          ]
            .filter(Boolean)
            .join(" ");
          return missing.length || unsigned || aiCount || aiNotes.length ? note : "";
        } catch (err) {
          const msg = friendlyError(err, "unknown error");
          // A classified template failure already explains itself and says
          // where to go; anything else keeps the prefix naming what was being
          // done. `run` re-runs friendlyError over this, which is a no-op for
          // both shapes — neither matches a classifier once prefixed.
          throw new Error(
            msg === TEMPLATE_MISSING_MESSAGE ? msg : `Generation failed: ${msg}`
          );
        }
      },
      { savedMessage: "Generated — every mapped field matched." }
    );
    setBusyKey(null);
  }

  return (
    <>
      <div className="card">
        <h2>Generate carrier-submission forms</h2>
        <p className="muted small">
          Fills the uploaded ACORD template with this account's details
          (contacts, address, construction, buildings). The PDF stays editable
          for anything the CRM doesn't track yet.
        </p>
        <div className="table-wrap">
          <table>
            <tbody>
              {APP_FORMS.map((f) => {
                const mapped = MAPPED_APP_FORM_KEYS.has(f.key);
                return (
                  <tr key={f.key}>
                    <td>
                      <strong>{f.label}</strong>
                    </td>
                    <td style={{ width: 160 }}>
                      <button
                        className="secondary"
                        disabled={!mapped || busyKey !== null}
                        title={
                          mapped
                            ? undefined
                            : "This form has no field mapping yet — it would come out with only the producer and insured header filled in."
                        }
                        onClick={() => generate(f)}
                      >
                        {busyKey === f.key ? "Generating…" : "Generate"}
                      </button>
                      {!mapped && (
                        <div className="muted small">Mapping not built yet</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {genStatus.status.state !== "idle" && (
          <p style={{ margin: "10px 0 0" }}>
            <SaveStatus {...genStatus.status} />
          </p>
        )}
        {aiFilled.map((r) => (
          <AiFilledList key={r.page} fields={r.fields} page={r.page || undefined} />
        ))}
      </div>

      <div className="card">
        <h2>Generated forms</h2>
        {!genRes.loaded ? (
          <p className="muted small">Loading…</p>
        ) : genRes.error ? (
          <p className="error-text">{genRes.error}</p>
        ) : generated.length === 0 ? (
          <p className="muted small">Nothing generated yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortTh label="File" colKey="file" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortTh label="Generated" colKey="generated" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="small">
                      {fmtDateTime(d.createdAt)}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="link" onClick={() => setPreview(d)}>
                        Preview
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {preview && (
        <FilePreviewModal
          s3Key={preview.s3Key}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

import { useEffect, useRef } from "react";
import {
  assertNoErrors,
  client,
  listAllPages,
  unwrap,
  type DoApplication,
  type DoCoveragePart,
} from "../../lib/client";
import { bool, boolValue, inputValue, num, str } from "../../lib/formCodec";
import { useAsyncResource } from "../../lib/useAsyncResource";
import { useFormState } from "../../lib/useFormState";
import { useSingletonChild } from "../../lib/useSingletonChild";
import {
  DEFENSE_LIMIT_POSITION_OPTIONS,
  DO_COVERAGE_TYPE_OPTIONS,
  DO_PARTS,
  DO_PART_LABELS,
  type DoPart,
} from "../../lib/enums";
import { SaveStatus, useSaveStatus } from "../SaveStatus";
import { DateInput, MoneyInput, YesNoRadio } from "../inputs";

/**
 * Directors & Officers — ACORD 810 input.
 *
 * **Not an add/remove table.** The three coverage parts are fixed by the
 * form: there is no fourth to add and removing one would mean the form has a
 * blank where a question is. So this renders exactly three rows and upserts
 * them, which is why it does not use `useChildRows` despite looking like a
 * table of child rows.
 *
 * The parts are labelled "Part A/B/C" and not "Side A/B/C". See
 * `DO_PART_LABELS` — naming them after the standard D&O Side split would
 * assert a meaning nobody has confirmed, on a document that goes to a carrier.
 *
 * The 810 is in the form registry but has no deterministic mapping yet, and
 * this commit does not add one: nobody has read that template's field
 * inventory. Until someone does, these answers are stored, editable, and
 * feed W8's AI gap-filler — see docs/acord/acord-125-fields.txt for what
 * "read the inventory first" now means in this codebase.
 */

interface DoForm {
  separateDefenseLimit: string;
  defenseLimit: string;
  defenseLimitPosition: string;
  pendingPriorLitigationDate: string;
}

const BLANK_DO: DoForm = {
  separateDefenseLimit: "",
  defenseLimit: "",
  defenseLimitPosition: "",
  pendingPriorLitigationDate: "",
};

interface PartForm {
  coverageType: string;
  perClaimLimit: string;
  aggregateLimit: string;
  perClaimRetention: string;
  aggregateRetention: string;
}

const BLANK_PART: PartForm = {
  coverageType: "",
  perClaimLimit: "",
  aggregateLimit: "",
  perClaimRetention: "",
  aggregateRetention: "",
};

export default function DirectorsOfficersCard({
  accountId,
}: {
  accountId: string;
}) {
  const app = useSingletonChild<DoApplication, DoForm>(
    client.models.DoApplication,
    {
      accountId,
      noun: "D&O application",
      initialForm: BLANK_DO,
      toForm: (r) => ({
        separateDefenseLimit: boolValue(r.separateDefenseLimit),
        defenseLimit: inputValue(r.defenseLimit),
        defenseLimitPosition: inputValue(r.defenseLimitPosition),
        pendingPriorLitigationDate: inputValue(r.pendingPriorLitigationDate),
      }),
      toWrite: (f) => ({
        separateDefenseLimit: bool(f.separateDefenseLimit),
        defenseLimit: num(f.defenseLimit),
        defenseLimitPosition: str(
          f.defenseLimitPosition
        ) as DoApplication["defenseLimitPosition"],
        pendingPriorLitigationDate: str(f.pendingPriorLitigationDate),
      }),
    }
  );

  return (
    <div className="card">
      <h2>Directors &amp; officers</h2>
      <p className="muted small">
        Coverage parts and defence terms as applied for. Feeds the ACORD 810.
      </p>

      {!app.loaded ? (
        <p className="muted small">Loading…</p>
      ) : app.error ? (
        <p className="error-text">{app.error}</p>
      ) : (
        <>
          <div className="form-grid">
            <div className="field">
              <label>Separate defence limit?</label>
              <YesNoRadio
                name="do-separate-defense"
                value={app.form.form.separateDefenseLimit}
                onChange={(v) => app.form.setF("separateDefenseLimit", v)}
              />
            </div>
            <div className="field">
              <label>Defence limit ($)</label>
              <MoneyInput
                value={app.form.form.defenseLimit}
                onChange={(v) => app.form.setF("defenseLimit", v)}
              />
            </div>
            <div className="field">
              <label>Defence costs</label>
              <select
                value={app.form.form.defenseLimitPosition}
                onChange={(e) => app.form.setF("defenseLimitPosition", e.target.value)}
              >
                <option value="">—</option>
                {DEFENSE_LIMIT_POSITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Pending / prior litigation date</label>
              <DateInput
                value={app.form.form.pendingPriorLitigationDate}
                onChange={(v) => app.form.setF("pendingPriorLitigationDate", v)}
              />
            </div>
          </div>

          <div className="form-actions">
            <button className="primary" disabled={app.status.busy} onClick={app.save}>
              {app.status.busy ? "Saving…" : "Save D&O terms"}
            </button>
            <SaveStatus {...app.status.status} />
          </div>

          <CoverageParts accountId={accountId} />
        </>
      )}
    </div>
  );
}

/**
 * The three parts, saved together.
 *
 * One button for all three rather than one per part: they are three columns
 * of one table on the form, a producer fills them in one sitting, and three
 * separate save states next to three near-identical rows is more to read than
 * it is worth. A part left entirely blank is not written at all, so an
 * account that only carries Part A does not get two empty rows implying it
 * was asked about B and C.
 */
function CoverageParts({ accountId }: { accountId: string }) {
  const res = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        client.models.DoCoveragePart.list({
          filter: { accountId: { eq: accountId } },
          nextToken,
        })
      ),
    [accountId],
    { initialData: [] as DoCoveragePart[], errorMessage: "Failed to load D&O parts" }
  );

  const status = useSaveStatus();

  // One form object holding all three parts, keyed by part letter. `reset` is
  // what re-seeds it once the read lands — same pattern, and same reason, as
  // `useSingletonChild`'s.
  const form = useFormState<Record<DoPart, PartForm>>(
    () =>
      Object.fromEntries(DO_PARTS.map((p) => [p, { ...BLANK_PART }])) as Record<
        DoPart,
        PartForm
      >,
    { onEdit: status.markDirty }
  );

  const seeded = useRef(false);
  useEffect(() => {
    seeded.current = false;
  }, [accountId]);
  useEffect(() => {
    if (seeded.current || !res.loaded) return;
    seeded.current = true;
    const byPart = new Map(res.data.map((r) => [r.part, r]));
    form.reset(
      Object.fromEntries(
        DO_PARTS.map((p) => {
          const row = byPart.get(p);
          return [
            p,
            row
              ? {
                  coverageType: inputValue(row.coverageType),
                  perClaimLimit: inputValue(row.perClaimLimit),
                  aggregateLimit: inputValue(row.aggregateLimit),
                  perClaimRetention: inputValue(row.perClaimRetention),
                  aggregateRetention: inputValue(row.aggregateRetention),
                }
              : { ...BLANK_PART },
          ];
        })
      ) as Record<DoPart, PartForm>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.loaded]);

  const filled = (p: PartForm) => Object.values(p).some((v) => v.trim() !== "");

  async function save() {
    await status.run(async () => {
      const byPart = new Map(res.data.map((r) => [r.part, r]));
      const saved: DoCoveragePart[] = [];
      for (const part of DO_PARTS) {
        const values = form.form[part];
        const existing = byPart.get(part);
        if (!filled(values)) {
          // Blanked out entirely: remove the row rather than storing an empty
          // one, so "not asked" stays distinguishable from "asked, no cover".
          if (existing) assertNoErrors(await client.models.DoCoveragePart.delete({ id: existing.id }));
          continue;
        }
        const payload = {
          coverageType: str(values.coverageType) as DoCoveragePart["coverageType"],
          perClaimLimit: num(values.perClaimLimit),
          aggregateLimit: num(values.aggregateLimit),
          perClaimRetention: num(values.perClaimRetention),
          aggregateRetention: num(values.aggregateRetention),
        };
        saved.push(
          unwrap(
            existing
              ? await client.models.DoCoveragePart.update({ id: existing.id, ...payload })
              : await client.models.DoCoveragePart.create({ accountId, part, ...payload })
          )
        );
      }
      res.setData(saved);
      form.markSaved();
    }, { savedMessage: "Coverage parts saved.", errorMessage: "Couldn't save the coverage parts." });
  }

  if (!res.loaded) return <p className="muted small">Loading…</p>;
  if (res.error) return <p className="error-text">{res.error}</p>;

  return (
    <>
      <h3>Coverage parts</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Part</th>
              <th>Type</th>
              <th>Per claim limit</th>
              <th>Aggregate limit</th>
              <th>Per claim retention</th>
              <th>Aggregate retention</th>
            </tr>
          </thead>
          <tbody>
            {DO_PARTS.map((part) => {
              const values = form.form[part];
              const set = (key: keyof PartForm, v: string) =>
                form.setF(part, { ...values, [key]: v });
              return (
                <tr key={part}>
                  <td>
                    <strong>{DO_PART_LABELS[part]}</strong>
                  </td>
                  <td>
                    <select
                      value={values.coverageType}
                      onChange={(e) => set("coverageType", e.target.value)}
                    >
                      <option value="">—</option>
                      {DO_COVERAGE_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  {(
                    [
                      "perClaimLimit",
                      "aggregateLimit",
                      "perClaimRetention",
                      "aggregateRetention",
                    ] as (keyof PartForm)[]
                  ).map((key) => (
                    <td key={key}>
                      <MoneyInput value={values[key]} onChange={(v) => set(key, v)} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={status.busy} onClick={save}>
          {status.busy ? "Saving…" : "Save coverage parts"}
        </button>
        <SaveStatus {...status.status} />
      </div>
    </>
  );
}

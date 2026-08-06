import type { AiFilledField } from "../lib/acord";

/**
 * Every value the AI put on the document, with where it says the value came
 * from.
 *
 * This is not a debug panel and it is not optional. The deterministic fill is
 * a mapping somebody wrote and can be audited once; a gap-fill is a judgement
 * made per document, on a page that goes to a carrier under the agency's
 * name. Showing the value and its justification side by side is what makes
 * the feature safe to use — the producer checks it here or nobody checks it.
 */
export default function AiFilledList({
  fields,
  page,
}: {
  fields: AiFilledField[];
  /** "2 of 3" for a multi-page set; omitted when there is only one document. */
  page?: string;
}) {
  if (!fields.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <h3 style={{ margin: "0 0 4px", fontSize: "0.95rem" }}>
        AI-filled fields{page ? ` — page ${page}` : ""}{" "}
        <span className="muted small" style={{ fontWeight: 400 }}>
          ({fields.length})
        </span>
      </h3>
      <p className="muted small" style={{ margin: "0 0 6px" }}>
        These were blank after the mapping ran and were completed from this
        account's data. Check each one before the document leaves the agency.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
              <th>Where it came from</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field}>
                <td className="small">{f.field}</td>
                <td>{f.value}</td>
                <td className="small muted">{f.why || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { Input } from "../../components/ui/Input";
import {
  VERDICT_LABEL,
  type Match
} from "../../lib/extractionMatch";

/**
 * One candidate row in the review table, with its verdict.
 *
 * The verdict is not decoration. "add" and "update" are two different writes
 * and a reviewer needs to know which one they are authorising; "no change" is
 * the case that used to produce duplicates, so it is greyed, unticked and
 * cannot be selected — the row is there to say the record already agrees with
 * the documents, which is worth seeing and not worth writing.
 *
 * An "update" also shows what would change, field by field. A checkbox that
 * says only "update" asks somebody to approve an edit without telling them
 * what the edit is.
 */
export function CandidateRow<E>({
  kind,
  match,
  checked,
  disabled,
  onToggle,
  current,
  title,
  detail,
}: {
  kind: string;
  match: Match<E>;
  checked: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
  /** How the stored row reads today, or "" when there isn't one. */
  current: string;
  title: string;
  /** Sub-line bits; falsy entries are dropped here rather than at each site. */
  detail: (string | false | undefined | null)[];
}) {
  const identical = match.verdict === "identical";
  const bits = detail.filter(Boolean) as string[];
  return (
    <tr className={identical ? "ui-table-row-muted" : checked ? "ui-table-row-selected" : undefined}>
      <td className="extraction-selection">
        <Input
          type="checkbox"
          aria-label={`Select ${kind.toLowerCase()}: ${title}`}
          checked={checked && !identical}
          disabled={identical || disabled}
          title={identical ? "Already on the record — nothing to write" : undefined}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </td>
      <th scope="row">{kind}</th>
      <td className="extraction-current">{current || "—"}</td>
      <td className="extraction-value">
        <strong>{title}</strong>
        {bits.length ? <div className="small muted">{bits.join(" · ")}</div> : null}
      </td>
      <td>
        <span className={`badge ${identical ? "gray" : "blue"}`}>
          {VERDICT_LABEL[match.verdict]}
        </span>
      </td>
      <td className="extraction-evidence">
        {match.verdict === "new" ? (
          `Creates a ${kind} record`
        ) : identical ? (
          "Already matches the record — nothing will be written"
        ) : (
          <details className="extraction-disclosure">
            <summary>View changes</summary>
            <p>Updates the matching {kind.toLowerCase()}:</p>
            <ul>
              {match.changes.map((c) => (
                <li key={c.field}>
                  {fieldLabel(c.field)}: {shownValue(c.from)} → {shownValue(c.to)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
    </tr>
  );
}

/** A column name as a person reads it — the same rule the activity log uses. */
const fieldLabel = (f: string) =>
  f.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();

const shownValue = (v: unknown): string => {
  if (v == null || v === "") return "blank";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
};

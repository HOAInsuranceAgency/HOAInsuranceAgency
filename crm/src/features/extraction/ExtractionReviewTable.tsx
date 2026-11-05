import type { Dispatch, SetStateAction } from 'react';
import { CONSTRUCTION_LABELS, CONTACT_TYPE_LABELS } from "../../../../shared/enums";
import { relationshipCurrent } from "../../../../shared/relationships";
import { Input } from "../../components/ui/Input";
import { Table } from "../../components/ui/Table";
import { Badge, CONFIDENCE_BADGE, statusBadge } from "../../lib/badges";
import { fmtDate, fmtMoney, fmtNum, fmtPhone, type Account } from "../../lib/client";
import { CandidateRow } from './CandidateRow';
import type { ExtractionResult, FieldDef } from './extractionModel';
import { ExtractedField, digits, fmtVal, isEmpty, yesNo } from './extractionModel';
import type { ExtractionCandidates } from './useExtractionCandidates';
interface ExtractionReviewTableProps {
  account: Account;
  result: ExtractionResult;
  extractedFields: FieldDef[];
  busy: boolean;
  selected: Record<string, boolean>;
  setSelected: Dispatch<SetStateAction<Record<string, boolean>>>;
  selectedContacts: Record<number, boolean>;
  setSelectedContacts: Dispatch<SetStateAction<Record<number, boolean>>>;
  selectedLosses: Record<number, boolean>;
  setSelectedLosses: Dispatch<SetStateAction<Record<number, boolean>>>;
  selectedBuildings: Record<number, boolean>;
  setSelectedBuildings: Dispatch<SetStateAction<Record<number, boolean>>>;
  contactCandidates: ExtractionCandidates['contactCandidates'];
  lossCandidates: ExtractionCandidates['lossCandidates'];
  buildingCandidates: ExtractionCandidates['buildingCandidates'];
}

export function ExtractionReviewTable({
  account,
  result,
  extractedFields,
  selected,
  setSelected,
  selectedContacts,
  setSelectedContacts,
  selectedLosses,
  setSelectedLosses,
  selectedBuildings,
  setSelectedBuildings,
  contactCandidates,
  lossCandidates,
  buildingCandidates,
  busy,
}: ExtractionReviewTableProps) {
  return (
    <Table className="extraction-table" aria-label="Extracted values to review">
      <colgroup><col className="extraction-col-select" /><col className="extraction-col-field" /><col className="extraction-col-current" /><col className="extraction-col-value" /><col className="extraction-col-review" /><col className="extraction-col-evidence" /></colgroup>
      <thead>
        <tr>
          <th scope="col"><span className="extraction-sr-only">Select</span></th>
          <th>Field</th>
          <th>Current</th>
          <th>Extracted</th>
          <th>Review</th>
          <th>Source / changes</th>
        </tr>
      </thead>
      <tbody>
        {extractedFields.map((def) => {
          const f = result[def.key] as ExtractedField | undefined;
          if (!f || isEmpty(f.value)) return null;
          const cur = def.current(account);
          const extracted = def.display ? def.display(f.value) : fmtVal(f.value);
          return (
            <tr key={def.key} className={selected[def.key] ? "ui-table-row-selected" : undefined}>
              <td className="extraction-selection">
                <Input
                  type="checkbox"
                  aria-label={`Select ${def.label.toLowerCase()}`}
                  checked={!!selected[def.key]}
                  disabled={busy}
                  onChange={(e) =>
                    setSelected((s) => ({ ...s, [def.key]: e.target.checked }))
                  }
                />
              </td>
              <th scope="row">{def.label}</th>
              <td className="extraction-current">{cur || "—"}</td>
              <td className="extraction-value">
                <strong>{extracted}</strong>
              </td>
              <td>
                <Badge {...statusBadge(CONFIDENCE_BADGE, f.confidence)} />
              </td>
              <td className="extraction-evidence">
                {f.evidence || f.source ? <details className="extraction-disclosure">
                  <summary>View evidence</summary>
                  {f.evidence && <p>{f.evidence}</p>}
                  {f.source && <p className="extraction-source"><strong>Source</strong>{f.source}</p>}
                </details> : "—"}
              </td>
            </tr>
          );
        })}
        {contactCandidates.map(({ i, row: c, match }) => {
          const found = match.existing;
          const bits = [
            c.type ? CONTACT_TYPE_LABELS[c.type] ?? c.type : "",
            c.email?.trim(),
            c.phone?.trim() ? fmtPhone(c.phone) : "",
          ].filter(Boolean);
          return (
            <CandidateRow
              key={`c-${i}`}
              kind="Contact"
              match={match}
              checked={!!selectedContacts[i] && (!found || relationshipCurrent(found))}
              disabled={busy || !!found && !relationshipCurrent(found)}
              onToggle={(v) =>
                setSelectedContacts((s) => ({ ...s, [i]: v }))
              }
              current={
                found
                  ? [found.name, found.email, fmtPhone(found.phone)]
                    .filter((v) => v && v !== "—")
                    .join(" · ")
                  : ""
              }
              title={`${c.name?.trim() ?? ""}${found && !relationshipCurrent(found) ? " · Former or scheduled contact (kept in history)" : ""}`}
              detail={bits}
            />
          );
        })}
        {lossCandidates.map(({ i, row: l, match }) => {
          const found = match.existing;
          const bits = [
            l.typeOfLoss?.trim(),
            digits(l.amountPaid) != null
              ? `${fmtMoney(digits(l.amountPaid))} paid`
              : "",
            digits(l.amountReserved) != null
              ? `${fmtMoney(digits(l.amountReserved))} reserved`
              : "",
            yesNo(l.claimOpen) === true
              ? "open"
              : yesNo(l.claimOpen) === false
                ? "closed"
                : "",
          ].filter(Boolean);
          return (
            <CandidateRow
              key={`l-${i}`}
              kind="Loss"
              match={match}
              checked={!!selectedLosses[i]}
              disabled={busy}
              onToggle={(v) => setSelectedLosses((s) => ({ ...s, [i]: v }))}
              current={
                found
                  ? `${fmtDate(found.dateOfLoss)} ${found.lineOfBusiness}`
                  : ""
              }
              title={`${fmtDate(l.dateOfLoss)} · ${l.lineOfBusiness}`}
              detail={bits}
            />
          );
        })}
        {buildingCandidates.map(({ i, row: b, match }) => {
          const sqftNum = digits(b.sqft);
          const hasSqft = sqftNum != null;
          const detail = [
            b.yearBuilt && `built ${b.yearBuilt}`,
            b.stories && `${b.stories} storeys`,
            b.constructionType
              ? CONSTRUCTION_LABELS[b.constructionType] ?? b.constructionType
              : "",
            b.roofYear && `roof ${b.roofYear}`,
            b.heatingYear && `heating ${b.heatingYear}`,
            b.wiringYear && `wiring ${b.wiringYear}`,
            b.plumbingYear && `plumbing ${b.plumbingYear}`,
          ].filter(Boolean);
          const found = match.existing;
          return (
            <CandidateRow
              key={`b-${i}`}
              kind="Building"
              match={match}
              checked={!!selectedBuildings[i]}
              disabled={busy}
              onToggle={(v) =>
                setSelectedBuildings((s) => ({ ...s, [i]: v }))
              }
              current={
                found
                  ? [found.label, found.sqft ? `${fmtNum(found.sqft)} sq ft` : ""]
                    .filter(Boolean)
                    .join(" · ")
                  : ""
              }
              title={`${b.label?.trim() || `Building ${i + 1}`}${hasSqft ? ` · ${fmtNum(sqftNum)} sq ft` : ""
                }`}
              detail={detail}
            />
          );
        })}
      </tbody>
    </Table>
  );
}

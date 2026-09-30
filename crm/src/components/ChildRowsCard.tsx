import { type ReactNode } from "react";
import Modal from "./Modal";
import ConfirmButton from "./ConfirmButton";
import { SaveStatus } from "./SaveStatus";
import { SortTh, useSort } from "../lib/useSort";
import type { ChildRows } from "../lib/useChildRows";

/**
 * The shell around {@link useChildRows} — the markup half of "a table of child
 * rows belonging to one account, with add, edit and delete".
 *
 * The hook owns the data and the three save states; this owns the four render
 * states, the toolbar, the table, and where the edit form goes. Splitting them
 * is what lets a screen with an unusual layout keep the hook and write its own
 * markup, without this component growing a prop for every such case.
 *
 * The caller supplies the fields as elements (`addFields`, `editFields`) bound
 * to `child.addForm` / `child.editForm`, and the columns as data. Column cells
 * are functions rather than a key list because every one of these tables
 * renders through a formatter — `fmtMoney`, `fmtDate`, `fmtPhone`, an enum
 * label — and a `keyof T` shortcut would only work for the columns that don't.
 *
 * ## Where the edit form goes
 *
 * `editIn="inline"` replaces the row with the form, in place. `editIn="modal"`
 * opens `Modal`. The dividing line is roughly five fields: a contact or a
 * blanket fits in a row, a building's twenty-eight fields do not, and an
 * inline form that reflows the table under the user's cursor is worse than an
 * overlay. It is a prop rather than a field count because only the caller
 * knows how wide its fields are.
 *
 * ## The gate
 *
 * `!loaded → error → empty → content`, in that order, per PATTERNS. The whole
 * body is behind it, toolbar included: an add form offered before the read
 * lands is an add form whose defaults were computed from rows nobody has seen
 * yet — `BuildingsCard`'s `Building ${n + 1}` is exactly that, and would
 * number a new building over an existing one.
 */

export interface ChildColumn<T> {
  /** Sort key. Must be unique within the table. */
  key: string;
  label: string;
  cell: (row: T) => ReactNode;
  /** Omit to make the column unsortable — `SortTh` is only rendered with this. */
  sort?: (row: T) => string | number | null | undefined;
}

export interface ChildRowsCardProps<
  T extends { id: string },
  F extends object,
> {
  title: string;
  /** Optional scoped styling and supporting copy for this card. */
  className?: string;
  description?: ReactNode;
  /** Everything {@link useChildRows} returned. */
  child: ChildRows<T, F>;
  columns: ChildColumn<T>[];
  /** Add-form fields, bound to `child.addForm`. */
  addFields: ReactNode;
  /** Edit-form fields, bound to `child.editForm`. */
  editFields: ReactNode;
  editIn?: "inline" | "modal";
  /** Opt into a collapsed add form; the value labels its native disclosure. */
  addDisclosure?: string;
  loadingMessage?: string;
  tableLabel?: string;
  /** Feedback for a caller-owned action, alongside the shared CRUD statuses. */
  extraFeedback?: ReactNode;
  /** Accessible name for each row's Edit button. */
  editButtonLabel?: (row: T) => string;
  /** Shown in place of the table when there are no rows. */
  emptyMessage: ReactNode;
  /** Add-button label. */
  addLabel: string;
  /** Rendered next to the heading, and only once the read has settled. */
  summary?: ReactNode;
  /** Column key to sort by initially. Defaults to the first sortable column. */
  defaultSort?: string;
  defaultDir?: "asc" | "desc";
  /** Modal heading / inline caption for the row being edited. */
  editTitle?: (row: T) => string;
  /** Copy for the delete confirmation. */
  removeMessage?: (row: T) => string;
}

export default function ChildRowsCard<
  T extends { id: string },
  F extends object,
>({
  title,
  className,
  description,
  child,
  columns,
  addFields,
  editFields,
  editIn = "inline",
  addDisclosure,
  loadingMessage = "Loading…",
  tableLabel,
  extraFeedback,
  editButtonLabel,
  emptyMessage,
  addLabel,
  summary,
  defaultSort,
  defaultDir = "asc",
  editTitle,
  removeMessage,
}: ChildRowsCardProps<T, F>) {
  const sortable = columns.filter((c) => c.sort);
  const accessors: Record<
    string,
    (row: T) => string | number | null | undefined
  > = Object.fromEntries(sortable.map((c) => [c.key, c.sort!]));
  const { sorted, sortKey, dir, toggle } = useSort(
    child.rows,
    accessors,
    defaultSort ?? sortable[0]?.key ?? "",
    defaultDir,
  );

  const editingRow = child.rows.find((r) => r.id === child.editingId) ?? null;

  const editActions = (
    <>
      <button
        className="primary"
        disabled={child.editStatus.busy}
        onClick={child.saveEdit}
      >
        {child.editStatus.busy ? "Saving…" : "Save"}
      </button>
      <button className="secondary" onClick={child.cancelEdit}>
        Cancel
      </button>
      <SaveStatus {...child.editStatus.status} />
    </>
  );

  const addButton = (
    <button
      className={addDisclosure ? "primary" : "secondary"}
      disabled={child.addStatus.busy}
      onClick={child.add}
    >
      {addDisclosure && child.addStatus.busy ? "Adding…" : addLabel}
    </button>
  );
  const EmptyTag = typeof emptyMessage === "string" ? "p" : "div";

  return (
    <section
      className={`card child-rows-card${className ? ` ${className}` : ""}`}
      aria-label={title}
    >
      <div className="child-rows-heading">
        <h2>
          {title}
          {child.loaded && !child.error && summary ? (
            <span
              className="muted small child-rows-summary"
              style={{ fontWeight: 400 }}
            >
              {" "}
              {summary}
            </span>
          ) : null}
        </h2>
        {description ? <p>{description}</p> : null}
      </div>

      {!child.loaded ? (
        <p className="muted small child-rows-state" role="status">
          {loadingMessage}
        </p>
      ) : child.error ? (
        <p className="error-text child-rows-state" role="alert">
          {child.error}
        </p>
      ) : (
        <>
          {addDisclosure ? (
            <details className="child-rows-add">
              <summary>{addDisclosure}</summary>
              <div className="child-rows-add-body">
                <div className="form-grid child-rows-fields">{addFields}</div>
                <div className="form-actions child-rows-form-actions">
                  {addButton}
                </div>
              </div>
            </details>
          ) : (
            <div className="toolbar">
              {addFields}
              {addButton}
              <SaveStatus {...child.addStatus.status} />
            </div>
          )}
          <div className="child-rows-feedback">
            {addDisclosure ? <SaveStatus {...child.addStatus.status} /> : null}
            {/* Outside the toolbar: a delete confirmation names a row that is no
              longer in the table, so it has nowhere better to live. */}
            <SaveStatus {...child.delStatus.status} />
            {/* The editor carries its own copy of this while it is open, so a
              validation error appears beside the fields that caused it. But
              the editor closes on success, which would take the confirmation
              with it and make an edit the one write in the app that reports
              nothing — so once it is closed the message surfaces here instead.
              Exactly one of the two renders at a time. */}
            {child.editingId === null ? (
              <SaveStatus {...child.editStatus.status} />
            ) : null}
            {extraFeedback}
          </div>

          {child.rows.length === 0 ? (
            <EmptyTag className="muted small child-rows-state child-rows-empty">
              {emptyMessage}
            </EmptyTag>
          ) : (
            <div className="table-wrap child-rows-table-wrap">
              <table className="child-rows-table" aria-label={tableLabel}>
                <colgroup>
                  {columns.map((column) => (
                    <col key={column.key} />
                  ))}
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    {columns.map((c) =>
                      c.sort ? (
                        <SortTh
                          key={c.key}
                          label={c.label}
                          colKey={c.key}
                          sortKey={sortKey}
                          dir={dir}
                          onToggle={toggle}
                        />
                      ) : (
                        <th key={c.key}>{c.label}</th>
                      ),
                    )}
                    <th>{tableLabel ? "Actions" : null}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) =>
                    editIn === "inline" && row.id === child.editingId ? (
                      <tr key={row.id}>
                        <td colSpan={columns.length + 1}>
                          {editTitle ? (
                            <p className="small" style={{ margin: "0 0 8px" }}>
                              <strong>{editTitle(row)}</strong>
                            </p>
                          ) : null}
                          <div className="form-grid child-rows-fields">
                            {editFields}
                          </div>
                          <div className="form-actions child-rows-form-actions">
                            {editActions}
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.id}>
                        {columns.map((c) => (
                          <td key={c.key}>{c.cell(row)}</td>
                        ))}
                        <td>
                          <div className="child-rows-row-actions">
                            <button
                              className="secondary"
                              aria-label={editButtonLabel?.(row)}
                              onClick={() => child.startEdit(row)}
                            >
                              Edit
                            </button>{" "}
                            <ConfirmButton
                              label="Remove"
                              busyLabel="Removing…"
                              message={removeMessage?.(row)}
                              onConfirm={() => child.remove(row.id)}
                            />
                          </div>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}

          {editIn === "modal" && editingRow ? (
            <Modal
              title={editTitle?.(editingRow) ?? `Edit ${title}`}
              onClose={child.cancelEdit}
              // The `.preview-*` shell defaults to a fixed box that centres one
              // object in it — right for the file preview it grew out of, and
              // unusable for a form, which has to start at the top and grow.
              className="modal-form child-rows-editor"
            >
              <div className="form-grid child-rows-fields">{editFields}</div>
              <div className="form-actions child-rows-form-actions">
                {editActions}
              </div>
            </Modal>
          ) : null}
        </>
      )}
    </section>
  );
}

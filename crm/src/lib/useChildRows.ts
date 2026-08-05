import { useState } from "react";
import { assertNoErrors, listAllPages, unwrap } from "./client";
import { useAsyncResource } from "./useAsyncResource";
import { useFormState, type FormState } from "./useFormState";
import { useSaveStatus, type SaveStatusApi } from "../components/SaveStatus";

/**
 * One account, one table of child rows, add / edit / delete.
 *
 * Contacts, prior carriers, blankets, GL class codes, D&O coverage parts,
 * losses and buildings are all the same screen. `BuildingsCard` is the closest
 * thing the app has today and it is **add-only** — there is no edit path for a
 * child row anywhere in this codebase, so the choice was between writing the
 * first one six times and writing it once. This is once.
 *
 * What the hook owns, and therefore what the six screens cannot each get
 * wrong in their own way:
 *
 *  - **The read** — `useAsyncResource` over `listAllPages`, filtered on
 *    `accountId`. Not a bare `.list()`: DynamoDB filters *after* reading a
 *    page, so an account whose rows sit past the first page gets a silently
 *    short table (INVENTORY §1.3).
 *  - **Three separate save states.** Add, edit and delete each get their own
 *    `useSaveStatus`, because they fail independently and a shared one would
 *    let a delete failure erase an add confirmation. Delete's auto-clears
 *    after 4s and the other two are persistent — `BuildingsCard`'s existing
 *    split, for its existing reason: an add/edit confirmation names a row that
 *    is still on screen, and a delete confirmation names one that is gone, so
 *    nothing will ever come along to clear it.
 *  - **`errors` is never dropped.** Every write goes through `unwrap`.
 *  - **Optimistic local patch, never a refetch.** The row that came back from
 *    the write is the row the table shows; re-reading the whole list after
 *    each edit would cost a round trip to learn what we were just told.
 *  - **Validation runs before the write, into the right status.** A problem
 *    with the add form must not appear over the edit form.
 *
 * ## Two things the spec's sketch didn't name, and why they're here
 *
 * `toForm` — the edit form has to be *seeded* from the row being edited, and
 * only the caller knows how a `Building` becomes `{ label, sqft, … }` strings.
 * `toCreate`/`toUpdate` are the other direction and cannot be run backwards.
 *
 * `addForm` / `editForm` — the two `useFormState` instances are returned
 * rather than kept private, because the caller renders the fields. Keeping
 * them inside would mean the hook also owned the markup, which is
 * `ChildRowsCard`'s job.
 */

/**
 * The slice of an Amplify model this hook uses.
 *
 * Declared structurally, with **method syntax on purpose**: method parameters
 * are compared bivariantly, which is what lets a caller pass
 * `client.models.Building` — whose `create` takes a specific generated input
 * type — where this asks for a loose record. Rewriting these as arrow-typed
 * properties would make `strictFunctionTypes` reject every real model.
 *
 * The payloads stay untyped here and are typed at the call site instead:
 * `toCreate` and `toUpdate` are written against the concrete model, so the
 * shape is checked where it is built. Naming the generated input types here
 * is what makes `tsc` report "type instantiation is excessively deep" — the
 * same wall `pagination.ts:9-12` documents hitting.
 */
export interface ChildRowsModel<T> {
  list(input: {
    filter?: Record<string, unknown>;
    nextToken?: string;
  }): Promise<{ data: T[]; nextToken?: string | null }>;
  create(input: Record<string, unknown>): Promise<{
    data: T | null;
    errors?: { message: string }[];
  }>;
  update(input: Record<string, unknown>): Promise<{
    data: T | null;
    errors?: { message: string }[];
  }>;
  delete(input: { id: string }): Promise<{
    data: T | null;
    errors?: { message: string }[];
  }>;
}

export interface ChildRowsOptions<T, F extends object> {
  /** The account these rows hang off. Sent on every create and filters the read. */
  accountId: string;
  /**
   * Singular, lower-case, as it appears mid-sentence: `"building"`,
   * `"contact"`, `"prior carrier"`. Drives the default copy for every
   * confirmation and failure this hook produces.
   */
  noun: string;
  /** Plural for the read's error message. Defaults to `noun + "s"`. */
  nounPlural?: string;
  /** Blank values for the add form — and the shape both forms hold. */
  initialForm: F;
  /** A stored row → the strings its edit form shows. */
  toForm: (row: T) => F;
  /** Add-form values → the create payload. `accountId` is added by the hook. */
  toCreate: (form: F) => Record<string, unknown>;
  /** Edit-form values → the update payload. `id` is added by the hook. */
  toUpdate: (form: F) => Record<string, unknown>;
  /**
   * Human-readable problems with the form, empty when it is fine — the
   * `validateAccountFields` contract, so the `client.ts` validators compose
   * into it by concatenation. Runs before add and before save, and its result
   * goes to that operation's own status.
   */
  validate?: (form: F) => string[];
  /** Names a row being added or saved, for the confirmation copy. */
  describe?: (form: F) => string;
  /** Names a stored row, for the delete confirmation. */
  describeRow?: (row: T) => string;
}

export interface ChildRows<T, F extends object> {
  /** Every row for this account, in read order. */
  rows: T[];
  /** The read has settled — the one gate for "show a placeholder". */
  loaded: boolean;
  /** Read failure, empty string when there is none. */
  error: string;
  addStatus: SaveStatusApi;
  editStatus: SaveStatusApi;
  delStatus: SaveStatusApi;
  /** Add-form state. Its `onEdit` is already wired to `addStatus`. */
  addForm: FormState<F>;
  /** Edit-form state, re-seeded by `startEdit`. */
  editForm: FormState<F>;
  /** Id of the row being edited, or `null`. */
  editingId: string | null;
  add: () => Promise<void>;
  startEdit: (row: T) => void;
  cancelEdit: () => void;
  saveEdit: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useChildRows<T extends { id: string }, F extends object>(
  model: ChildRowsModel<T>,
  options: ChildRowsOptions<T, F>
): ChildRows<T, F> {
  const {
    accountId,
    noun,
    nounPlural = `${noun}s`,
    initialForm,
    toForm,
    toCreate,
    toUpdate,
    validate,
    describe,
    describeRow,
  } = options;

  const res = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        model.list({ filter: { accountId: { eq: accountId } }, nextToken })
      ),
    [accountId],
    {
      initialData: [] as T[],
      errorMessage: `Failed to load ${nounPlural}`,
    }
  );

  const addStatus = useSaveStatus();
  const editStatus = useSaveStatus();
  // The row a delete confirmation refers to is gone, so nothing on screen will
  // ever go dirty and clear it. This is the one of the three that needs a timer.
  const delStatus = useSaveStatus({ autoClearMs: 4000 });

  const addForm = useFormState<F>(initialForm, { onEdit: addStatus.markDirty });
  const editForm = useFormState<F>(initialForm, { onEdit: editStatus.markDirty });

  const [editingId, setEditingId] = useState<string | null>(null);

  const setRows = res.setData;
  const rows = res.data;

  // Plain functions rather than `useCallback`: every one of them closes over a
  // caller-supplied closure (`toCreate`, `validate`, `describe`) that is a new
  // identity each render, so memoising would recompute every render anyway and
  // only make these *look* stable to a reader. Nothing downstream is memoised.

  async function add() {
    const form = addForm.form;
    const problems = validate?.(form) ?? [];
    if (problems.length) {
      addStatus.markError(problems.join(" "));
      return;
    }
    const name = describe?.(form) ?? noun;
    await addStatus.run(
      async () => {
        const created = unwrap(
          await model.create({ accountId, ...toCreate(form) })
        );
        setRows((current) => [...current, created]);
        // Nothing here ever calls `markSaved`, so the baseline is still the
        // blanks this mounted with and `reset()` is exactly "clear the form".
        // Its `onEdit` fires while the status is still "saving", which
        // `markDirty` deliberately ignores, so it can't wipe the confirmation.
        addForm.reset();
      },
      {
        savedMessage: `${name} added.`,
        errorMessage: `Couldn't add that ${noun}.`,
      }
    );
  }

  function startEdit(row: T) {
    setEditingId(row.id);
    // `reset(next)` is the only way `useFormState` re-seeds, and it moves the
    // baseline too — so `dirty` starts false against *this* row rather than
    // against the blanks the form mounted with.
    editForm.reset(toForm(row));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit() {
    if (!editingId) return;
    const form = editForm.form;
    const problems = validate?.(form) ?? [];
    if (problems.length) {
      editStatus.markError(problems.join(" "));
      return;
    }
    const name = describe?.(form) ?? noun;
    await editStatus.run(
      async () => {
        const saved = unwrap(
          await model.update({ id: editingId, ...toUpdate(form) })
        );
        setRows((current) => current.map((r) => (r.id === editingId ? saved : r)));
        // Closed on success only: a failed save leaves the form open with the
        // user's values in it and the error beside them, which is the only
        // state from which they can fix it and try again.
        setEditingId(null);
      },
      {
        savedMessage: `${name} saved.`,
        errorMessage: `Couldn't save that ${noun}.`,
      }
    );
  }

  async function remove(id: string) {
    const row = rows.find((r) => r.id === id);
    const name = (row && describeRow?.(row)) ?? noun;
    await delStatus.run(
      async () => {
        // `assertNoErrors`, not `unwrap`: a delete of a row that is already
        // gone resolves with a null payload and no errors, and that is the
        // outcome the user asked for.
        assertNoErrors(await model.delete({ id }));
        setRows((current) => current.filter((r) => r.id !== id));
        // The row under the open editor just stopped existing.
        setEditingId((current) => (current === id ? null : current));
      },
      {
        savedMessage: `${name} removed.`,
        errorMessage: `Couldn't remove that ${noun}.`,
      }
    );
  }

  return {
    rows,
    loaded: res.loaded,
    error: res.error,
    addStatus,
    editStatus,
    delStatus,
    addForm,
    editForm,
    editingId,
    add,
    startEdit,
    cancelEdit,
    saveEdit,
    remove,
  };
}

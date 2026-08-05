import { useEffect, useRef } from "react";
import { listAllPages, unwrap } from "./client";
import { useAsyncResource } from "./useAsyncResource";
import { useFormState, type FormState } from "./useFormState";
import { useSaveStatus, type SaveStatusApi } from "../components/SaveStatus";
import type { ChildRowsModel } from "./useChildRows";

/**
 * One account, one optional child record, one form.
 *
 * `useChildRows`' sibling for the 1:1 case. `GlApplication` and
 * `DoApplication` are both "a section of an application that either has been
 * filled in or has not", which is a different shape from a table of rows:
 * there is nothing to add, nothing to delete, and no list to sort.
 *
 * ## Created lazily, on the first save
 *
 * An account that nobody has been asked about GL should not carry an empty
 * `GlApplication` row. An empty row and no row look identical on screen but
 * mean different things in the data — "every answer is blank" versus "nobody
 * has been asked" — and creating one on first *render* would quietly convert
 * every account in the system to the first. So the first save creates, and
 * every save after that updates.
 *
 * ## Seeding
 *
 * `useFormState` reads its seed once, at mount, and this record arrives from
 * a fetch afterwards — so the form is re-seeded through `reset()` when the
 * read settles. Exactly once: a `refetch` or a re-render must not overwrite
 * what the user has typed since. That is what the ref guards, and it is the
 * reason this is a hook rather than a `key`-remount at the call site — the
 * caller would need the loaded record to compute the key, which is precisely
 * what it does not have yet.
 */

export interface SingletonChildOptions<T, F extends object> {
  accountId: string;
  /** Singular, lower-case, mid-sentence: `"general liability application"`. */
  noun: string;
  /** Values for an account that has no record yet. */
  initialForm: F;
  /** A stored record → the strings its form shows. */
  toForm: (row: T) => F;
  /** Form values → the create/update payload. `accountId`/`id` are added here. */
  toWrite: (form: F) => Record<string, unknown>;
  /** Problems with the form, empty when fine — the `client.ts` validator contract. */
  validate?: (form: F) => string[];
}

export interface SingletonChild<T, F extends object> {
  /** The stored record, or `null` until one has been saved. */
  row: T | null;
  loaded: boolean;
  error: string;
  status: SaveStatusApi;
  form: FormState<F>;
  save: () => Promise<void>;
}

export function useSingletonChild<T extends { id: string }, F extends object>(
  model: ChildRowsModel<T>,
  options: SingletonChildOptions<T, F>
): SingletonChild<T, F> {
  const { accountId, noun, initialForm, toForm, toWrite, validate } = options;

  const res = useAsyncResource(
    () =>
      listAllPages((nextToken) =>
        model.list({ filter: { accountId: { eq: accountId } }, nextToken })
      ),
    [accountId],
    { initialData: [] as T[], errorMessage: `Failed to load the ${noun}` }
  );

  // First wins if two ever exist. A duplicate can only come from two tabs
  // saving an empty section at the same moment; picking deterministically
  // beats rendering whichever the list happened to return second.
  const row = res.data[0] ?? null;

  const status = useSaveStatus();
  const form = useFormState<F>(initialForm, { onEdit: status.markDirty });

  // Seeded once, when the read settles — see the note above.
  const seeded = useRef(false);
  const { reset } = form;
  useEffect(() => {
    seeded.current = false;
  }, [accountId]);
  useEffect(() => {
    if (seeded.current || !res.loaded) return;
    seeded.current = true;
    if (row) reset(toForm(row));
    // `toForm` is a fresh closure each render and `reset` is identity-stable;
    // the ref is what makes this run once, not the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.loaded, row?.id]);

  async function save() {
    const problems = validate?.(form.form) ?? [];
    if (problems.length) {
      status.markError(problems.join(" "));
      return;
    }
    const payload = toWrite(form.form);
    await status.run(
      async () => {
        const saved = unwrap(
          row
            ? await model.update({ id: row.id, ...payload })
            : await model.create({ accountId, ...payload })
        );
        res.setData([saved]);
        // Moves the baseline, so `dirty` goes false and the next edit is
        // measured against what was actually persisted.
        form.markSaved();
      },
      { errorMessage: `Couldn't save the ${noun}.` }
    );
  }

  return { row, loaded: res.loaded, error: res.error, status, form, save };
}

import { useEffect, useRef } from "react";
import { assertNoErrors, unwrap } from "./client";
import { useAsyncResource } from "./useAsyncResource";
import { useFormState, type FormState } from "./useFormState";
import { useSaveStatus, type SaveStatusApi } from "../components/SaveStatus";

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
 * ## The account is the key
 *
 * Both models declare `.identifier(["accountId"])`, so "one account, one
 * record" is enforced by the primary key rather than by this hook being
 * careful. It used to be the latter: the read listed rows and took the first,
 * and `save()` branched on whether one existed — a check-then-act with a
 * network round trip in the middle. Two people first-saving the same blank
 * section at the same moment each saw nothing and each created a row, and one
 * of them was invisible from then on, including to the ACORD 125 mapping.
 *
 * With the account as the key that race resolves in the database: the second
 * create is rejected, and `save()` folds it into an update rather than
 * reporting a failure over a section the user did fill in. It also makes the
 * read a point lookup instead of a filtered list.
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

/**
 * The slice of a generated model client this needs.
 *
 * Its own interface rather than `ChildRowsModel`, because these models have
 * no `id`: the account is the key, so `get` and `update` take `accountId` and
 * there is no `delete` (a section is emptied, not removed). Method syntax on
 * purpose — the parameter bivariance is what makes `client.models.GlApplication`
 * assignable to it; see the same note on `ChildRowsModel`.
 */
export interface SingletonChildModel<T> {
  get(input: { accountId: string }): Promise<{
    data: T | null;
    errors?: { message: string }[];
  }>;
  create(input: Record<string, unknown>): Promise<{
    data: T | null;
    errors?: { message: string }[];
  }>;
  update(input: Record<string, unknown>): Promise<{
    data: T | null;
    errors?: { message: string }[];
  }>;
}

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

export function useSingletonChild<T, F extends object>(
  model: SingletonChildModel<T>,
  options: SingletonChildOptions<T, F>
): SingletonChild<T, F> {
  const { accountId, noun, initialForm, toForm, toWrite, validate } = options;

  const res = useAsyncResource(
    async () => {
      const got = await model.get({ accountId });
      // `assertNoErrors`, not `unwrap`: a section nobody has filled in comes
      // back as `{ data: null }` with no errors, and that is the answer —
      // "nobody has been asked" — not a failed read.
      assertNoErrors(got);
      return got.data;
    },
    [accountId],
    { initialData: null as T | null, errorMessage: `Failed to load the ${noun}` }
  );

  const row = res.data;

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
  }, [res.loaded]);

  /**
   * Create the record, unless somebody else just did.
   *
   * The account is the primary key, so a second create for an account that
   * already has a record is rejected outright — which is the point, and also
   * the moment this hook has to be useful rather than merely correct. Left
   * alone it would report "couldn't save" over a section the user did fill
   * in, and pressing Save again would fail the same way until they reloaded,
   * because `row` is still null on this side.
   *
   * So a failed create is re-read before it is believed. If a record now
   * exists, the two saves are folded into one update — last write wins, the
   * same as any two people editing a saved section. If none exists, the
   * create failed for its own reasons and that error is the one reported.
   */
  async function createOrFold(): Promise<T> {
    const payload = toWrite(form.form);
    const created = await model.create({ accountId, ...payload });
    if (created.data) return created.data;

    const existing = await model.get({ accountId });
    if (existing.data) return unwrap(await model.update({ accountId, ...payload }));

    throw new Error(created.errors?.[0]?.message ?? `Couldn't save the ${noun}.`);
  }

  async function save() {
    const problems = validate?.(form.form) ?? [];
    if (problems.length) {
      status.markError(problems.join(" "));
      return;
    }
    const payload = toWrite(form.form);
    await status.run(
      async () => {
        const saved = row
          ? unwrap(await model.update({ accountId, ...payload }))
          : await createOrFold();
        res.setData(saved);
        // Moves the baseline, so `dirty` goes false and the next edit is
        // measured against what was actually persisted.
        form.markSaved();
      },
      { errorMessage: `Couldn't save the ${noun}.` }
    );
  }

  return { row, loaded: res.loaded, error: res.error, status, form, save };
}

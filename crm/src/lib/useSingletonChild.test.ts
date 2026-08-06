import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: {} }) }));
vi.mock("aws-amplify/auth", () => ({ getCurrentUser: vi.fn() }));

import { useSingletonChild, type SingletonChildModel } from "./useSingletonChild";

/**
 * One account, one application section — enforced by the primary key.
 *
 * `GlApplication` and `DoApplication` declare `.identifier(["accountId"])`,
 * so a second create for an account that already has a record is rejected by
 * DynamoDB rather than quietly producing a second row that nothing renders.
 * What is asserted here is the half that lives in the browser: that the
 * rejection is folded into an update instead of surfacing as a failure over a
 * section the user did fill in.
 */

interface Row {
  accountId: string;
  fullTimeEmployees?: number | null;
}
interface Form {
  fullTimeEmployees: string;
}

const model = {
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const options = {
  accountId: "a1",
  noun: "general liability application",
  initialForm: { fullTimeEmployees: "" } as Form,
  toForm: (r: Row) => ({ fullTimeEmployees: String(r.fullTimeEmployees ?? "") }),
  toWrite: (f: Form) => ({ fullTimeEmployees: Number(f.fullTimeEmployees) || null }),
};

const mount = async () => {
  const hook = renderHook(() =>
    useSingletonChild<Row, Form>(model as unknown as SingletonChildModel<Row>, options)
  );
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return hook;
};

/** What AppSync returns when the create loses the primary-key condition. */
const CONFLICT = {
  data: null,
  errors: [{ message: "The conditional request failed" }],
};

beforeEach(() => {
  model.get.mockReset();
  model.create.mockReset();
  model.update.mockReset();
  model.get.mockImplementation(async () => ({ data: null }));
  model.create.mockImplementation(async () => ({ data: { accountId: "a1" } }));
  model.update.mockImplementation(async () => ({ data: { accountId: "a1" } }));
});

describe("reading", () => {
  it("reads the record by account, not by listing and taking the first", async () => {
    // The account is the key, so this is a point lookup. It used to be a
    // filtered list whose first row won, which is what made two rows possible
    // to create and impossible to notice.
    await mount();
    expect(model.get).toHaveBeenCalledWith({ accountId: "a1" });
  });

  it("treats an absent record as an answer, not a failed read", async () => {
    // "Nobody has been asked about GL" is a real state and renders a blank
    // form — not an error banner.
    const { result } = await mount();
    expect(result.current.row).toBeNull();
    expect(result.current.error).toBe("");
  });

  it("surfaces a genuine read failure", async () => {
    model.get.mockImplementation(async () => ({
      data: null,
      errors: [{ message: "network down" }],
    }));
    const { result } = await mount();
    expect(result.current.error).toBeTruthy();
  });
});

describe("saving", () => {
  it("creates on the first save, keyed on the account", async () => {
    const { result } = await mount();
    await act(async () => result.current.form.setF("fullTimeEmployees", "4"));
    await act(async () => result.current.save());

    expect(model.create).toHaveBeenCalledWith({
      accountId: "a1",
      fullTimeEmployees: 4,
    });
    expect(model.update).not.toHaveBeenCalled();
  });

  it("updates by account once a record exists", async () => {
    model.get.mockImplementation(async () => ({
      data: { accountId: "a1", fullTimeEmployees: 4 },
    }));
    const { result } = await mount();
    await act(async () => result.current.save());

    expect(model.update).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "a1" })
    );
    expect(model.create).not.toHaveBeenCalled();
  });

  it("folds a create the primary key rejected into an update", async () => {
    // Two people first-saving the same blank section. The database refuses
    // the second create — that is the fix working — and the second saver must
    // not be told their answers were lost.
    const { result } = await mount();
    model.create.mockImplementation(async () => CONFLICT);
    model.get.mockImplementation(async () => ({
      data: { accountId: "a1", fullTimeEmployees: 9 },
    }));

    await act(async () => result.current.form.setF("fullTimeEmployees", "4"));
    await act(async () => result.current.save());

    expect(model.update).toHaveBeenCalledWith({
      accountId: "a1",
      fullTimeEmployees: 4,
    });
    expect(result.current.status.status.state).toBe("saved");
  });

  it("reports a create that failed for its own reasons", async () => {
    // Re-read before believing the failure, but only re-read: if no record
    // exists then nothing raced us and the error is the real one.
    const { result } = await mount();
    model.create.mockImplementation(async () => ({
      data: null,
      errors: [{ message: "Variable 'fullTimeEmployees' has an invalid value" }],
    }));

    await act(async () => result.current.save());

    expect(model.update).not.toHaveBeenCalled();
    expect(result.current.status.status.state).toBe("error");
    expect(result.current.status.status.message).toMatch(/invalid value/);
  });
});

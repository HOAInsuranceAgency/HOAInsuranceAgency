import { row } from "./store";
import type { Operation } from "./operations";
/** Include this row in the transaction that creates the corresponding work. */
export function operationRow(id: string, data: Omit<Operation, "state" | "attempts">) {
  return row<Operation>("OPERATION", id, { ...data, state: "READY", attempts: 0 }, { accountId: data.accountId, dueAt: new Date().toISOString() });
}

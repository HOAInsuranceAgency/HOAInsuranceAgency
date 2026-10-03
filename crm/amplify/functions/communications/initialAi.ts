import type { Communication } from "../../../../shared/leadWorkflow";
import { get } from "./store";
import { accountRows } from "./workflow";
import type { Operation } from "./operations";

/** Front can report delivery before the send worker has normalized its author. */
export async function isInitialAiCommunication(comm: Communication, messageUid?: string): Promise<boolean> {
  if (comm.provider !== "front" || comm.channel !== "EMAIL" || comm.direction !== "OUTBOUND" || !comm.accountId) return false;
  if (comm.actorId === "crm:initial-ai") return true;
  const matches = (op: Operation) => op.type === "EMAIL" && op.accountId === comm.accountId
    && (!!messageUid && op.uid === messageUid || !!op.messageId && op.messageId === comm.providerId);
  if (messageUid) {
    const uid = await get<{ operationId: string }>(`front-uid:${messageUid}`);
    const operation = uid?.data.operationId ? await get<Operation>(uid.data.operationId) : undefined;
    if (operation && matches(operation.data)) return true;
  }
  // The durable operation is also evidence when its UID index write was
  // interrupted, or when a replay no longer includes the provider UID.
  return (await accountRows<Operation>(comm.accountId, "OPERATION")).some(operation => matches(operation.data));
}

/** Read the exact source row so automatic cleanup can fence later normalization. */
export async function contactCleanupSource(operationId: string, op: Pick<Operation, "type" | "accountId" | "conversationId">) {
  const prefix = "op:contact-cleanup:", suffix = `:${op.conversationId}`;
  if (op.type !== "ARCHIVE" || !op.conversationId || !operationId.startsWith(prefix) || !operationId.endsWith(suffix)) return undefined;
  const source = await get<Communication>(operationId.slice(prefix.length, -suffix.length));
  return source?.kind === "COMMUNICATION" && source.accountId === op.accountId && source.data.accountId === op.accountId ? source : undefined;
}

/** Hold old queued cleanup too; an explicit manual archive still takes effect. */
export async function isInitialAiCleanup(operationId: string, op: Pick<Operation, "type" | "accountId" | "conversationId">): Promise<boolean> {
  const source = await contactCleanupSource(operationId, op);
  return !!source && await isInitialAiCommunication(source.data);
}

import { vi } from "vitest";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { TransportDependencies } from "../../../amplify/functions/transactional-mail/client";

export const now = Date.parse("2026-11-04T02:00:00Z");
export const bound = {
  HOA_MIGRATION_AUTH: "true", HOA_MIGRATION_APP_ID: "d1nuh9rw1hcuxo", HOA_MIGRATION_BRANCH: "codex-hoa-account-migration",
  HOA_MIGRATION_PREVIEW: "false", HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_MIGRATION_WORKERS_ENABLED: "true",
  HOA_TRANSACTIONAL_MAIL_PROVIDER: "ses", HOA_TRANSACTIONAL_MAIL_TABLE: "HOA-TransactionalMail",
  HOA_TRANSACTIONAL_MAIL_BUCKET: "hoa-transactional-mail-917680434255-us-east-1",
  HOA_SES_IDENTITY_ARN: "arn:aws:ses:us-east-1:917680434255:identity/protectmyhoa.com",
  HOA_SES_CONFIGURATION_SET: "hoa-transactional-main", HOA_SES_VERIFICATION_EXPIRES_AT: "2026-11-04T02:30:00.000Z", AWS_REGION: "us-east-1",
  AWS_LAMBDA_FUNCTION_NAME: "amplify-d1nuh9rw1hcuxo-main-mailVerification",
};
export const command = (to = "jake@getgim.com") => new SendEmailCommand({ FromEmailAddress: "HOA Insurance Agency <noreply@protectmyhoa.com>", Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: "SES verification" }, Body: { Text: { Data: "Synthetic only" }, Html: { Data: "<p>Synthetic only</p>" } } } } });
export type Options = { sesError?: unknown; missingReceipt?: boolean; receiptFailure?: boolean; earlyFeedback?: boolean; wrongEarlyProvider?: boolean; wrongEarlyKind?: boolean; quota?: boolean; suppression?: boolean; beforeClaim?: () => void };
export function harness(options: Options = {}) {
  const rows = new Map<string, any>(); const objects = new Map<string, string>(); const transactions: any[] = [];
  const conditional = () => Object.assign(new Error("conflict"), { name: "TransactionCanceledException" });
  const database = { send: vi.fn(async (c: any) => {
    const i = c.input;
    if (c.constructor.name === "GetCommand") return { Item: options.suppression && i.Key.pk.startsWith("SUPPRESSION#") ? { suppressed: true } : structuredClone(rows.get(i.Key.pk)) };
    if (c.constructor.name === "PutCommand") {
      if (rows.has(i.Item.pk)) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      rows.set(i.Item.pk, structuredClone(i.Item)); return {};
    }
    if (c.constructor.name === "UpdateCommand") {
      const row = rows.get(i.Key.pk); const v = i.ExpressionAttributeValues;
      if (row?.attempt === v[":attempt"] && (v[":sending"] ? row.state === "SENDING" : ["RESERVED", "DEFERRED"].includes(row.state))) Object.assign(row, { state: v[":state"], failureReason: v[":reason"], nextRetryAt: v[":retry"] });
      return {};
    }
    if (c.constructor.name === "TransactWriteCommand") {
      transactions.push(i); const op = i.TransactItems[0].Update; const v = op.ExpressionAttributeValues; const row = rows.get(op.Key.pk);
      if (v[":sending"] && !v[":accepted"]) {
        options.beforeClaim?.();
        if (options.quota || row?.retiredAt || !["RESERVED", "DEFERRED"].includes(row?.state) || row.attempt !== v[":oldAttempt"] || (row.provider && row.provider !== v[":provider"])) throw conditional();
        const counters = i.TransactItems.slice(1).map((x: any) => x.Update);
        if (counters.some((x: any) => (rows.get(x.Key.pk)?.count ?? 0) > x.ExpressionAttributeValues[":remaining"])) throw conditional();
        Object.assign(row, { state: "SENDING", attempt: v[":attempt"], provider: v[":provider"] });
        for (const counter of counters) rows.set(counter.Key.pk, { pk: counter.Key.pk, count: (rows.get(counter.Key.pk)?.count ?? 0) + counter.ExpressionAttributeValues[":cost"] });
      } else {
        if (options.receiptFailure) throw new Error("receipt failure");
        const receipt = i.TransactItems[1].Update; const rv = receipt.ExpressionAttributeValues; const prior = rows.get(receipt.Key.pk);
        if (row.state !== "SENDING" || row.provider !== v[":provider"] || (prior?.provider && prior.provider !== rv[":provider"]) || (prior?.operationHash && prior.operationHash !== rv[":operationHash"]) || (prior?.mailKind && prior.mailKind !== rv[":mailKind"])) throw conditional();
        Object.assign(row, { state: "ACCEPTED", providerId: v[":id"] });
        rows.set(receipt.Key.pk, { ...prior, kind: "RECEIPT", provider: rv[":provider"], providerId: rv[":id"], operationKey: rv[":operation"], operationHash: rv[":operationHash"], environment: rv[":environment"], mailKind: rv[":mailKind"], status: receipt.UpdateExpression.includes("#status = if_not_exists(#status, :accepted)") ? prior?.status ?? "ACCEPTED" : "ACCEPTED" });
      }
      return {};
    }
    throw new Error("Unexpected command");
  }) };
  const storage = { send: vi.fn(async (c: any) => {
    if (c.constructor.name === "GetObjectCommand") return { Body: { transformToString: async () => objects.get(c.input.Key)! }, ContentLength: objects.get(c.input.Key)?.length };
    objects.set(c.input.Key, c.input.Body); return {};
  }) };
  const sesMock = vi.fn(async (c: any) => {
    if (options.sesError) throw options.sesError;
    if (options.earlyFeedback) {
      const operationHash = c.input.EmailTags.find((t: any) => t.Name === "HOAOperation").Value;
      rows.set("RECEIPT#ses#ses-receipt-12345", { kind: "RECEIPT", provider: options.wrongEarlyProvider ? "resend" : "ses", environment: c.input.EmailTags.find((t: any) => t.Name === "HOAEnvironment").Value, operationHash, mailKind: options.wrongEarlyKind ? "invoice" : c.input.EmailTags.find((t: any) => t.Name === "HOAMailKind").Value, status: "DELIVERED", deliveredAt: "2026-11-04T02:00:00Z" });
    }
    return options.missingReceipt ? {} : { MessageId: "ses-receipt-12345" };
  });
  const deps = { database, storage, ses: { send: sesMock }, now: () => now } as unknown as TransportDependencies;
  return { rows, transactions, database, storage, sesMock, deps, objects };
}

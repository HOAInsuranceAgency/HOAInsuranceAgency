import type { Context } from "aws-lambda";
import { TransactionalMailClient } from "./client";
import type { MailKind } from "./contract";

/** No schedule/URL/AppSync route. An IAM operator reviews one exact saved mail. */
export const handler = async (event: { operationKey?: string; expectedPayloadHash?: string }, context: Context) => {
  if (!context.invokedFunctionArn.startsWith("arn:aws:lambda:us-east-1:917680434255:function:amplify-d1nuh9rw1hcuxo-")
    || process.env.HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED !== "true" || process.env.HOA_MIGRATION_PREVIEW !== "false"
    || process.env.HOA_MIGRATION_WORKERS_ENABLED !== "true" || process.env.HOA_TRANSACTIONAL_MAIL_RELEASE !== "true") throw new Error("Mail recovery is not enabled for this release.");
  const match = /^OP#hoa\/(main|staging)\/(invoice|report|accounting)\/[a-f0-9]{64}$/.exec(event.operationKey ?? "");
  if (!match || !/^[a-f0-9]{64}$/.test(event.expectedPayloadHash ?? "")) throw new Error("An exact reviewed mail operation and payload hash are required.");
  return new TransactionalMailClient(match[2] as MailKind).replay(event.operationKey!, event.expectedPayloadHash!);
};

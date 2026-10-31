import type { CustomMessageTriggerHandler } from "aws-lambda";
/** Imported users are created silently; native invitations/recovery stay off. */
export const handler: CustomMessageTriggerHandler = async event => {
  if (process.env.HOA_MIGRATION_PREVIEW === "true") {
    throw new Error("Native user email is disabled in this migration preview.");
  }
  return event;
};

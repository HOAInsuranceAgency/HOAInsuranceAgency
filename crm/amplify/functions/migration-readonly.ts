export function assertPreviewRead(allowed: boolean) {
  if (process.env.HOA_MIGRATION_PREVIEW === "true" && !allowed) {
    throw new Error("Business actions and external integrations are disabled in this migration preview.");
  }
}

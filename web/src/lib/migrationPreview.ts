export function assertWebsiteActionsEnabled() {
  if (import.meta.env.PUBLIC_HOA_MIGRATION_PREVIEW === "true") {
    throw new Error("This is a viewing-only migration preview. Requests, uploads and payments are disabled.");
  }
}

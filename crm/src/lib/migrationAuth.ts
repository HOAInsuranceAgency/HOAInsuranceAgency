export function previewSignInAvailable() {
  if (import.meta.env.VITE_HOA_MIGRATION_PREVIEW !== "true") return true;
  const deadline = Date.parse(import.meta.env.VITE_HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT ?? "");
  return import.meta.env.VITE_HOA_MIGRATION_AUTH === "true"
    && import.meta.env.VITE_HOA_PREVIEW_ADMIN_LOGIN === "true"
    && Number.isFinite(deadline) && Date.now() < deadline;
}

export const destinationSignIn = () => import.meta.env.VITE_HOA_MIGRATION_AUTH === "true";

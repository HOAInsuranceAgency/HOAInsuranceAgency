// The completed cutover is historical evidence, not a renewable deployment lease.
// Normal main builds retain the same backend, cursor generation and runtime identity.
export function assertSteadyState(env, contract) {
  const need = (ok, reason) => { if (!ok) throw new Error(`HOA steady-state deployment: ${reason}`); };
  need(contract.schema === 1 && contract.account === "917680434255" && contract.region === "us-east-1"
    && contract.crmApp === "d1nuh9rw1hcuxo" && contract.webApp === "d1x0kxb71w6nvt"
    && contract.branch === "main" && contract.backendBranch === "main"
    && contract.runtimeBranch === "codex-hoa-account-migration", "unreviewed destination contract");
  need(env.AWS_BRANCH === contract.branch && env.HOA_DEPLOY_ACCOUNT_ID === contract.account
    && [contract.crmApp, contract.webApp].includes(env.AWS_APP_ID), "wrong account, app or branch");
  need(env.HOA_DEPLOYMENT_MODE === "steady-state" && env.HOA_MIGRATION_AUTH === "true"
    && env.HOA_MIGRATION_PREVIEW === "false", "explicit production mode required");
  need(contract.pendingCutoff === new Date(contract.finalSyncCompletedAt).toISOString()
    && Date.parse(contract.pendingCutoff) <= Date.now()
    && /^[a-f0-9]{64}$/.test(contract.finalSyncReceiptSha256)
    && /^[a-f0-9]{64}$/.test(contract.pollingProofSha256), "invalid permanent final-copy boundary");
  for (const key of ["HOA_MIGRATION_PREPARE_RECEIPT", "HOA_MIGRATION_STREAM_PROBE_TOKEN",
    "HOA_MIGRATION_STREAM_PROBE_EXPIRES_AT", "HOA_MIGRATION_STREAM_PROBE_SCOPE_MANIFEST",
    "HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT", "VITE_HOA_PREVIEW_ADMIN_LOGIN_EXPIRES_AT"]) {
    need(!env[key], `temporary capability remains: ${key}`);
  }
  if (env.AWS_APP_ID === contract.webApp) {
    need(env.PUBLIC_HOA_MIGRATION_PREVIEW === "false" && env.PUBLIC_ANALYTICS_DISABLED === "false"
      && env.PUBLIC_CRM_API_URL === contract.graphqlUrl, "website production/API binding differs");
    return;
  }
  const expected = {
    HOA_MIGRATION_STREAM_PHASE: "armed", HOA_MIGRATION_WORKERS_ENABLED: "true",
    HOA_MIGRATION_STREAM_PROBE_ENABLED: "false", HOA_MIGRATION_SCHEDULES_ENABLED: "true",
    HOA_TRANSACTIONAL_MAIL_RELEASE: "true", HOA_TRANSACTIONAL_MAIL_RECOVERY_ENABLED: "false",
    HOA_PREVIEW_ADMIN_LOGIN: "false", HOA_RESEND_PREVIEW_ENABLED: "false",
    HOA_MIGRATION_PENDING_CUTOFF: contract.pendingCutoff, HOA_MIGRATION_PENDING_ACCOUNT: contract.account,
    HOA_PREVIEW_ADMIN_USER_POOL_ID: contract.pool, HOA_PREVIEW_ADMIN_CLIENT_ID: contract.client,
    VITE_HOA_MIGRATION_PREVIEW: "false", VITE_HOA_MIGRATION_AUTH: "true", VITE_HOA_PREVIEW_ADMIN_LOGIN: "false",
  };
  need(Object.entries(expected).every(([k, value]) => env[k] === value), "permanent runtime/auth/mail/schedule controls differ");
}

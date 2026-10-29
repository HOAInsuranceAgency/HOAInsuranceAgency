// Bootstrap interlock: the migration branch cannot deploy before its exact destination is bound.
if ((process.env.AWS_BRANCH ?? "").startsWith("codex-hoa-")) {
  throw new Error("HOA migration destination is not yet configured. Production remains unchanged.");
}

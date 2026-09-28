import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { assertRecipient, manualRunId, readSettings, readRun, reserveRun, settingsSnapshot, saveSettings, updateRun, conflict } from "./store";

const lambda = new LambdaClient({ maxAttempts: 1 });
interface Event { info?: { fieldName?: string }; arguments?: { operation?: string; input?: unknown }; identity?: { sub?: string; username?: string; groups?: unknown; claims?: Record<string, unknown> } }
export function requireAdmin(event: Event): string {
  const groups = event.identity?.groups ?? event.identity?.claims?.["cognito:groups"];
  const actor = event.identity?.sub ?? event.identity?.claims?.sub;
  if (!Array.isArray(groups) || !groups.includes("ADMIN") || typeof actor !== "string" || !actor) throw new Error("Administrator access is required.");
  return actor;
}
function parseInput(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid report request.");
  return parsed as Record<string, unknown>;
}
export const handler = async (event: Event) => {
  try {
    const actor = requireAdmin(event);
    if (!event.arguments?.operation && (!event.info?.fieldName || event.info.fieldName === "marketingReportSettings")) return await settingsSnapshot();
    if (event.info?.fieldName && event.info.fieldName !== "marketingReportAction") throw new Error("Unknown report action.");
    const input = parseInput(event.arguments?.input);
    if (event.arguments?.operation === "save") { await saveSettings(input); return await settingsSnapshot(); }
    if (event.arguments?.operation !== "sendNow") throw new Error("Unknown report action.");
    const id = manualRunId(typeof input.requestId === "string" ? input.requestId : "");
    const prior = await readRun(id);
    if (prior) return { ok: true, run: prior.data };
    const settings = await readSettings();
    if (!settings?.data.recipient) throw new Error("Save a recipient before sending the report.");
    await assertRecipient(settings.data.recipient);
    const worker = process.env.MARKETING_REPORT_WORKER;
    if (!worker) throw new Error("The report worker is not configured.");
    const reservation = await reserveRun(id, "manual", settings, new Date().toISOString(), actor);
    if (!reservation.created) return { ok: true, run: reservation.record.data };
    try {
      const result = await lambda.send(new InvokeCommand({ FunctionName: worker, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ trigger: "manual", runId: id })) }));
      if (result.StatusCode !== 202 || result.FunctionError) throw new Error("The worker did not accept the report.");
    } catch {
      // The invoke may have reached Lambda even if its response was lost. Fence the
      // queued record before marking it failed; an already-claimed worker wins.
      try { const failed = await updateRun(reservation.record, { status: "failed", retryable: true, error: "The report could not be queued. Review the worker before requesting another report." }); return { ok: true, run: failed.data }; }
      catch (error) { if (!conflict(error)) throw error; return { ok: true, run: (await readRun(id))!.data }; }
    }
    return { ok: true, run: reservation.record.data };
  } catch (error) {
    console.error("Marketing report API failed", error instanceof Error ? error.name : "UnknownError");
    return { ok: false, error: error instanceof Error && !error.name.endsWith("Exception") ? error.message.slice(0, 250) : "The marketing report request failed. Please try again." };
  }
};

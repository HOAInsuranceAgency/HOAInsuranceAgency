import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { buildMarketingLeadReport } from "../../../../shared/marketingLeadReport";
import { buildMarketingReportWorkbook } from "./workbook";
import { buildMimeMessage } from "../send-invoice/mime";
import { reportSnapshot } from "./snapshot";
import { assertRecipient, environment, readSettings, readRun, reserveRun, updateRun, conflict, type Run } from "./store";
import type { Row } from "../communications/store";

// Sending is never retried by the SDK: a lost SES response can still mean the
// recipient received the message. The durable ledger prevents Lambda retries.
const ses = new SESv2Client({ maxAttempts: 1 });
interface Event { trigger?: string; runId?: string; scheduleArn?: string; scheduledAt?: string }
export function easternScheduleDay(scheduledAt: string): string {
  const parsed = new Date(scheduledAt);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid report schedule time.");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(parsed).map(part => [part.type, part.value]));
  if (parts.weekday !== "Fri" || parts.hour !== "08" || parts.minute !== "00" || parts.second !== "00") throw new Error("The report is scheduled for Friday at 8:00 AM Eastern.");
  return `${parts.year}-${parts.month}-${parts.day}`;
}
async function scheduledRun(event: Event): Promise<Row<Run> | undefined> {
  if (environment() !== "main") return;
  if (!process.env.MARKETING_REPORT_SCHEDULE_ARN || event.scheduleArn !== process.env.MARKETING_REPORT_SCHEDULE_ARN || !event.scheduledAt || event.runId) throw new Error("Unrecognized report schedule invocation.");
  const day = easternScheduleDay(event.scheduledAt);
  const age = Date.now() - Date.parse(event.scheduledAt);
  if (age < -60_000 || age > 60 * 60_000) throw new Error("The report schedule invocation expired.");
  const settings = await readSettings();
  if (!settings?.data.enabled || !settings.data.recipient) return;
  await assertRecipient(settings.data.recipient);
  return (await reserveRun(`marketing-report:run:scheduled:${day}`, "scheduled", settings, new Date().toISOString())).record;
}
function safeError(error: unknown): string {
  return error instanceof Error && !error.name.endsWith("Exception") ? error.message.slice(0, 250) : "Report generation failed. Review the worker logs before requesting another report.";
}
export const handler = async (event: Event) => {
  let record: Row<Run> | undefined;
  if (event.trigger === "scheduled") record = await scheduledRun(event);
  else if (event.trigger === "manual" && typeof event.runId === "string" && /^marketing-report:run:manual:[0-9a-f]{64}$/.test(event.runId) && !event.scheduledAt && !event.scheduleArn) {
    record = await readRun(event.runId);
    if (!record || record.data.kind !== "manual" || !record.data.actor) throw new Error("The manual report has not been reserved by an administrator.");
  } else throw new Error("Unrecognized report invocation.");
  if (!record || record.data.status !== "queued") return { skipped: true };
  try { record = await updateRun(record, { status: "sending", retryable: false }); }
  catch (error) { if (conflict(error)) return { skipped: true }; throw error; }
  let sendAttempted = false;
  try {
    await assertRecipient(record.data.recipient);
    const sender = process.env.MARKETING_REPORT_FROM;
    if (!sender) throw new Error("The report sender is not configured.");
    const report = buildMarketingLeadReport(await reportSnapshot(), record.data.asOf);
    const workbook = buildMarketingReportWorkbook(report);
    if (workbook.byteLength > 7 * 1024 * 1024) throw new Error("The report exceeds the email attachment size limit. No report was sent.");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(record.data.asOf));
    const text = `Attached is the HOA lead update generated from the CRM on ${date}.\n\nIt includes ${report.rows.length} account rows, including converted clients. Blank cells indicate information not recorded in the CRM. The workbook's Report Notes tab describes the field mappings and data limitations.\n\nWeekly delivery is scheduled for Fridays at 8:00 AM Eastern.`;
    const raw = buildMimeMessage({ from: sender, to: record.data.recipient, replyTo: sender, subject: `HOA Lead Update — ${date}`, text, html: text.split("\n\n").map(paragraph => `<p>${paragraph}</p>`).join(""), attachment: { filename: `HOA_LEAD_UPDATE_${date}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: workbook } });
    record = await updateRun(record, { rowCount: report.rows.length, sendStartedAt: new Date().toISOString() });
    sendAttempted = true;
    const result = await ses.send(new SendEmailCommand({ FromEmailAddress: sender, Destination: { ToAddresses: [record.data.recipient] }, Content: { Raw: { Data: Buffer.from(raw, "utf8") } } }));
    if (!result.MessageId) throw new Error("The email service returned no delivery reference.");
    await updateRun(record, { status: "sent", sentAt: new Date().toISOString(), messageId: result.MessageId, retryable: false, error: undefined });
    return { sent: true, rowCount: report.rows.length };
  } catch (error) {
    const status = sendAttempted ? "unknown" : "failed";
    try { await updateRun(record, { status, retryable: !sendAttempted, error: sendAttempted ? "Email acceptance could not be confirmed. Check the recipient inbox and email service before sending again." : safeError(error) }); }
    catch (ledgerError) { console.error("Marketing report failure could not be recorded", ledgerError instanceof Error ? ledgerError.name : "UnknownError"); }
    console.error("Marketing report worker failed", { runId: record.id, status, error: error instanceof Error ? error.name : "UnknownError" });
    // Surface failures to the Lambda alarm; retries see a non-queued ledger.
    throw new Error(`Marketing report ${status}; review its delivery history.`);
  }
};

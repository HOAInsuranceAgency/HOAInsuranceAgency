import type { Context } from "aws-lambda";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { PDFDocument } from "pdf-lib";
import { TransactionalMailClient } from "./client";
import { assertDestination, type Attachment } from "./contract";
import { MARKETING_REPORT_HEADERS } from "../../../../shared/marketingLeadReport";
import { buildMarketingReportWorkbook } from "../marketing-report/workbook";

/** IAM-invoked synthetic transport checks. Never reads/writes business records. */
export const handler = async (event: { fixture?: string; runId?: string }, context: Context) => {
  if (process.env.HOA_MIGRATION_PREVIEW !== "true" || process.env.HOA_RESEND_PREVIEW_ENABLED !== "true"
    || !context.invokedFunctionArn.startsWith("arn:aws:lambda:us-east-1:917680434255:function:amplify-d1nuh9rw1hcuxo-")
    || !["login", "invite", "invoice", "report", "accounting"].includes(event.fixture ?? "")
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.runId ?? "")) throw new Error("Unapproved migration email check.");
  const from = "HOA Insurance Agency <noreply@protectmyhoa.com>";
  const to = ["jake@getgim.com"];
  const subject = `[Migration test] HOA ${event.fixture} email delivery`;
  const text = `Synthetic ${event.fixture} email for the HOA migration. This message contains no customer information, invitation, sign-in token, invoice, payment link, or business action.`;
  assertDestination("test", { from, to, subject, text });
  const attachments: Attachment[] = [];
  if (event.fixture === "invoice") {
    const pdf = await PDFDocument.create(); pdf.addPage().drawText("Migration test - not an invoice", { x: 40, y: 700 });
    pdf.setCreationDate(new Date("2026-10-30T00:00:00Z")); pdf.setModificationDate(new Date("2026-10-30T00:00:00Z"));
    attachments.push({ filename: "migration-test.pdf", contentType: "application/pdf", content: await pdf.save() });
  }
  if (event.fixture === "report") attachments.push({ filename: "migration-test.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: buildMarketingReportWorkbook({ headers: MARKETING_REPORT_HEADERS, rows: [], warnings: ["Migration test only; no customer information."], asOf: "2026-10-30T00:00:00Z" }) });
  const result = await new TransactionalMailClient("test").send(new SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: to }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: `<p>${text}</p>` } } } } }), { idempotencyKey: `verification:${event.runId}:${event.fixture}`, attachments });
  return { fixture: event.fixture, provider: "resend", messageId: result.MessageId, synthetic: true };
};

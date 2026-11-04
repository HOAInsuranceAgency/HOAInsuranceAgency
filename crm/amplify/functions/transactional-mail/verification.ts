import type { Context } from "aws-lambda";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { PDFDocument } from "pdf-lib";
import { TransactionalMailClient } from "./client";
import { assertDestination, assertVerificationWindow, type Attachment } from "./contract";
import { MARKETING_REPORT_HEADERS } from "../../../../shared/marketingLeadReport";
import { buildMarketingReportWorkbook } from "../marketing-report/workbook";

/** IAM-invoked synthetic transport checks. Never reads/writes business records. */
export const handler = async (event: { fixture?: string; runId?: string; sender?: string }, context: Context) => {
  const stage = process.env.HOA_MIGRATION_BRANCH === "codex-hoa-staging-migration";
  const sender = event.sender ?? "noreply";
  const permittedSenders = stage ? ["noreply", "testing"] : ["noreply", "insurance"];
  if (!permittedSenders.includes(sender)) throw new Error("Unapproved verification sender.");
  assertVerificationWindow();
  if (event.fixture !== "complete"
    || !context.invokedFunctionArn.startsWith("arn:aws:lambda:us-east-1:917680434255:function:amplify-d1nuh9rw1hcuxo-")
    || context.invokedFunctionArn.split(":")[6] !== process.env.AWS_LAMBDA_FUNCTION_NAME
    || !process.env.AWS_LAMBDA_FUNCTION_NAME?.toLowerCase().includes("mailverification")
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.runId ?? "")) throw new Error("Unapproved SES email check.");
  const mailbox = sender === "testing" ? "jake+testing" : sender;
  const from = `HOA Insurance Agency <${mailbox}@protectmyhoa.com>`;
  const to = ["jake@getgim.com"];
  const subject = "[Migration test] HOA SES email delivery";
  const text = "Synthetic complete email for the HOA migration. This message contains no customer information, invitation, sign-in token, invoice, payment link, or business action.";
  assertDestination("test", { from, to, subject, text });
  const provider = "ses";
  const attachments: Attachment[] = [];
  {
    const pdf = await PDFDocument.create(); pdf.addPage().drawText("Migration test - not an invoice", { x: 40, y: 700 });
    pdf.setCreationDate(new Date("2026-10-30T00:00:00Z")); pdf.setModificationDate(new Date("2026-10-30T00:00:00Z"));
    attachments.push({ filename: "migration-test.pdf", contentType: "application/pdf", content: await pdf.save() });
  }
  attachments.push({ filename: "migration-test.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: buildMarketingReportWorkbook({ headers: MARKETING_REPORT_HEADERS, rows: [], warnings: ["Migration test only; no customer information."], asOf: "2026-10-30T00:00:00Z" }) });
  const result = await new TransactionalMailClient("test").send(new SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: to }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: `<p>${text}</p>` } } } } }), { idempotencyKey: `verification:${event.runId}:complete${sender !== "noreply" ? `:${sender}` : ""}`, attachments });
  return { fixture: event.fixture, provider, messageId: result.MessageId, synthetic: true };
};

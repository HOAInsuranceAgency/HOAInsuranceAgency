import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
import {
  renderAgreementPdf,
  renderBoardResolutionPdf,
  type AgreementView,
} from "./agreementPdf";
import { parseScheduleJson } from "../../../src/lib/premiumFinance/quote";

/**
 * Custom mutation handler: generatePfAgreement. See resource.ts.
 *
 * Renders from the LOAN's frozen terms, never from the live policy row — the
 * paper a board signs must match the quote that was approved, whatever has
 * been edited since. The policy contributes only its identifying facts
 * (number, carrier, term), which appear on the paper as identification.
 */

type DataClient = ReturnType<typeof generateClient<Schema>>;
let dataClient: DataClient | undefined;
async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

const s3 = new S3Client();

export const handler = async (event: {
  arguments?: { loanId?: string };
  identity?: { sub?: string; claims?: Record<string, unknown>; username?: string };
}): Promise<unknown> => {
  const loanId = event.arguments?.loanId?.trim();
  if (!loanId) return { ok: false, error: "No loan given." };
  const bucket = process.env.DOCUMENTS_BUCKET;
  if (!bucket) {
    console.error("[pf-agreement] DOCUMENTS_BUCKET unset");
    return { ok: false, error: "Document storage is not configured." };
  }

  try {
    const client = await getDataClient();

    const { data: loan } = await client.models.PfLoan.get({ id: loanId });
    if (!loan) return { ok: false, error: "That loan no longer exists." };
    if (loan.status !== "QUOTED" && loan.status !== "ACCEPTED" && loan.status !== "ACTIVE") {
      return { ok: false, error: `A ${loan.status.toLowerCase()} loan has no agreement to generate.` };
    }

    // The kill switch reaches paperwork too.
    const { data: settings } = await client.models.AgencySettings.get({
      id: "AGENCY",
    });
    if (settings?.premiumFinanceEnabled !== true) {
      return { ok: false, error: "Premium finance is switched off." };
    }

    const [{ data: policy }, { data: account }] = await Promise.all([
      client.models.Policy.get({ id: loan.policyId }),
      client.models.Account.get({ id: loan.accountId }),
    ]);
    if (!account) return { ok: false, error: "That account no longer exists." };
    const carrier = policy?.carrierId
      ? (await client.models.Carrier.get({ id: policy.carrierId })).data
      : null;

    // AWSJSON arrives as a string; the loan's schedule was stringified at issue.
    const schedule = parseScheduleJson(loan.schedule);
    if (schedule.length === 0) {
      return { ok: false, error: "The loan's schedule is unreadable — regenerate the quote." };
    }

    const view: AgreementView = {
      loanId: loan.id,
      associationName: account.legalName?.trim() || account.name,
      associationAddress: [
        account.address ?? "",
        [account.city, [account.state, account.zip].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", "),
      ].filter((l) => l.trim()),
      policyNumber: policy?.policyNumber ?? null,
      carrierName: carrier?.name ?? null,
      policyTerm:
        policy?.effectiveDate && policy?.expirationDate
          ? `${policy.effectiveDate} to ${policy.expirationDate}`
          : null,
      premium: loan.premium,
      downPayment: loan.downPayment,
      amountFinanced: loan.amountFinanced,
      totalInterest: loan.totalInterest,
      totalOfPayments: Math.round((loan.amountFinanced + loan.totalInterest) * 100) / 100,
      apr: loan.apr,
      months: loan.months,
      payment: loan.payment,
      originationFee: loan.originationFee,
      effectiveDate: loan.effectiveDate,
      schedule,
    };

    const [agreement, resolution] = await Promise.all([
      renderAgreementPdf(view),
      renderBoardResolutionPdf(view),
    ]);

    /**
     * Under generated/, like the ACORD output, so the OCR upload trigger
     * never re-reads the app's own paperwork; the Document rows point there
     * with ocrStatus SKIPPED for the same reason FormsTab's do.
     */
    const docs: { key: string; name: string; category: "PF_AGREEMENT" | "PF_BOARD_RESOLUTION"; bytes: Uint8Array }[] = [
      {
        key: `generated/pf/${loan.id}/premium-finance-agreement.pdf`,
        name: `Premium finance agreement — ${view.associationName}.pdf`,
        category: "PF_AGREEMENT",
        bytes: agreement,
      },
      {
        key: `generated/pf/${loan.id}/board-resolution.pdf`,
        name: `Board resolution — ${view.associationName}.pdf`,
        category: "PF_BOARD_RESOLUTION",
        bytes: resolution,
      },
    ];
    const created: string[] = [];
    for (const d of docs) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: d.key,
          Body: d.bytes,
          ContentType: "application/pdf",
        })
      );
      const { data: row, errors } = await client.models.Document.create({
        entityType: "ACCOUNT",
        entityId: loan.accountId,
        category: d.category,
        name: d.name,
        s3Key: d.key,
        contentType: "application/pdf",
        sizeBytes: d.bytes.length,
        ocrStatus: "SKIPPED",
        lastWriteBy: "pf-agreement",
      });
      if (errors?.length || !row) throw new Error(errors?.[0]?.message);
      created.push(row.id);
    }

    console.log(`pf-agreement: rendered agreement + resolution for loan ${loan.id}`);
    return { ok: true, documentIds: created };
  } catch (err) {
    console.error("pf-agreement failed", err);
    return { ok: false, error: "Couldn't generate the agreement. Try again." };
  }
};

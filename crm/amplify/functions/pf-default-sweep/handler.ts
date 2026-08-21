import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";

/** Daily: an ACTIVE loan past its next due date is in default. See resource.ts. */

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

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

export const handler = async () => {
  const client = await getDataClient();
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const loans = await listAllPages((nextToken) =>
    client.models.PfLoan.list({
      filter: { status: { eq: "ACTIVE" } },
      limit: 200,
      nextToken,
    })
  );
  const missed = loans.filter((l) => l.nextDueAt && l.nextDueAt < today);

  const loanTable = process.env.PF_LOAN_TABLE;
  for (const loan of missed) {
    /**
     * Conditional on the state the sweep decided from: still ACTIVE, still
     * the same overdue date. The unconditional form clobbered concurrent
     * postings — worst case flipping a just-PAID loan to DEFAULTED, which
     * then admitted the statutory cancellation sequence on a fully paid
     * loan and wrote a false compliance row under it. Losing the condition
     * means the operator got there first; that is the good outcome.
     */
    if (!loanTable) {
      console.error("pf-default-sweep: PF_LOAN_TABLE unset");
      break;
    }
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: loanTable,
          Key: { id: loan.id },
          UpdateExpression: "SET #s = :d, defaultedAt = :now, updatedAt = :now",
          ConditionExpression: "#s = :active AND nextDueAt = :seen",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":d": "DEFAULTED",
            ":now": now,
            ":active": "ACTIVE",
            ":seen": loan.nextDueAt,
          },
        })
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        console.log(`pf-default-sweep: ${loan.id} was serviced mid-sweep; not marking`);
        continue;
      }
      console.error(`pf-default-sweep: could not mark ${loan.id}`, err);
      continue;
    }
    const table = process.env.PF_COMPLIANCE_LOG_TABLE;
    if (table) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: table,
            Item: {
              id: randomUUID(),
              __typename: "PfComplianceLog",
              createdAt: now,
              updatedAt: now,
              accountId: loan.accountId,
              jurisdiction: loan.state,
              rule: "default-detected",
              outcome: "BLOCK",
              reason: `Installment due ${loan.nextDueAt} not posted by ${today}.`,
              inputs: JSON.stringify({ loanId: loan.id, nextDueAt: loan.nextDueAt }),
              configSha256: PF_CONFIG_SHA256,
              actor: "pf-default-sweep",
              actorName: "pf-default-sweep",
              occurredAt: now,
            },
          })
        );
      } catch (err) {
        console.error("pf-default-sweep: log write failed", err);
      }
    }
    console.log(`pf-default-sweep: ${loan.id} defaulted (due ${loan.nextDueAt})`);
  }
  console.log(`pf-default-sweep: ${missed.length} of ${loans.length} active loans in default`);
};

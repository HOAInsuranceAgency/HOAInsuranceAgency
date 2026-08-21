import { randomUUID } from "node:crypto";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
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

  for (const loan of missed) {
    const { errors } = await client.models.PfLoan.update({
      id: loan.id,
      status: "DEFAULTED",
      defaultedAt: now,
    });
    if (errors?.length) {
      console.error(`pf-default-sweep: could not mark ${loan.id}`, errors[0].message);
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

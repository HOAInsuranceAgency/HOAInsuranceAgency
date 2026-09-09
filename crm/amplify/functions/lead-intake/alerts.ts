import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../data/resource";
import { listAllPages } from "../../../src/lib/pagination";
import { leadText, profileName, textRecipients, unreachableOptIns, type LeadSummary } from "./sms";
type DataClient = ReturnType<typeof generateClient<Schema>>;
const sns = new SNSClient();
export async function textLeadAlerts(
  client: DataClient,
  lead: LeadSummary
): Promise<{ attempted: number; sent: number; failed: number }> {
  try {
    const baseUrl = process.env.CRM_BASE_URL;
    if (!baseUrl) {
      console.error("CRM_BASE_URL unset — skipping lead texts");
      return { attempted: 0, sent: 0, failed: 1 };
    }

    const profiles = await listAllPages((nextToken) =>
      client.models.UserProfile.list({ nextToken, limit: 200 })
    );

    // Opted in with nothing to send to. Logged rather than dropped: the
    // switch is on, so this person believes they are covered.
    for (const p of unreachableOptIns(profiles)) {
      console.error(
        `${profileName(p)} has lead texts on but no usable mobile number`
      );
    }

    const recipients = textRecipients(profiles);
    if (recipients.length === 0) return { attempted: 0, sent: 0, failed: 0 };

    const Message = leadText(lead, baseUrl);
    const results = await Promise.allSettled(
      recipients.map((r) =>
        sns.send(
          new PublishCommand({
            PhoneNumber: r.phone,
            Message,
            MessageAttributes: {
              // Lead alerts are the transactional kind: they must not be
              // dropped for cost optimisation the way Promotional may be.
              "AWS.SNS.SMS.SMSType": {
                DataType: "String",
                StringValue: "Transactional",
              },
            },
          })
        )
      )
    );

    results.forEach((res, i) => {
      if (res.status === "rejected") {
        console.error(
          `Lead text to ${profileName(recipients[i].profile)} failed`,
          res.reason
        );
      }
    });
    const sent = results.filter((r) => r.status === "fulfilled").length;
    console.log(`Lead texts sent: ${sent}/${recipients.length} for ${lead.id}`);
    return { attempted: recipients.length, sent, failed: recipients.length - sent };
  } catch (err) {
    console.error("Lead texts failed entirely", err);
    return { attempted: 0, sent: 0, failed: 1 };
  }
}

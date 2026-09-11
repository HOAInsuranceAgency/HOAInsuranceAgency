import { config, credentials } from "./config";
import { front, dialpad, dialpadCallItems, verifyEmailChannel, verifySmsChannel, verifyDialpadCompany } from "./providers";
import { get } from "./store";
import { validRole } from "./workflow";
import { SNSClient, ListSubscriptionsByTopicCommand } from "@aws-sdk/client-sns";
export async function connectionChecks() {
  const c = await config(), keys = await credentials();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const tasks: [string, () => Promise<void>][] = [
    ["Independent alerts", async () => {
      const topic = process.env.COMMUNICATION_ALERT_TOPIC;
      if (!topic) throw new Error("Deploy the independent operations alert connection");
      const sns = new SNSClient(); let nextToken: string | undefined, confirmed = false;
      do { const result = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topic, NextToken: nextToken })); confirmed ||= !!result.Subscriptions?.some(s => s.SubscriptionArn?.startsWith("arn:aws:sns:")); nextToken = result.NextToken; } while (nextToken);
      if (!confirmed) throw new Error("Connect and confirm the operations recipient for the independent alert topic");
    }],
    ["Default responsibilities", async () => { const sales = c.defaultSalespersonId ?? c.defaultUserId, champion = c.defaultChampionId ?? c.defaultUserId; if (!sales || !champion) throw new Error("Choose default sales and champion owners"); await validRole(sales, "SALESPERSON"); await validRole(champion, "CHAMPION", champion !== sales); }],
    ["Team reports", async () => {
      const r = await (await import("./routing")).routing(), members = await (await import("./workflow")).team();
      if (!r.ownerId || !r.marketingManagerId || !r.reportChannelId) throw new Error("Choose the owner, marketing manager and internal report channel in Team settings");
      (await import("../../../../shared/workRouting")).validateRouting(r, members);
      if (members.some(m => m.enabled && m.salesperson && m.userId !== r.ownerId && !r.members.find(t => t.userId === m.userId)?.salesManagerId)) throw new Error("Choose a manager for every salesperson");
      await (await import("./reports")).verifyReportChannel(r.reportChannelId);
    }],
    ["Front company", async () => { if (!c.frontCompanyId) throw new Error("Enter the Front company ID"); const me = await front<{ id: string }>("/me"); if (me.id !== c.frontCompanyId) throw new Error("Front company does not match settings"); }],
    ["Front sales channel", async () => { await verifyEmailChannel(); }],
    ["Front inbox access", async () => { for (const id of [c.frontInboxId, ...c.allowedInboxIds]) { if (!id) throw new Error("Choose the sales inbox"); await front(`/inboxes/${id}`); } }],
    ["Dialpad company", async () => { await verifyDialpadCompany(); }],
    ["Dialpad call history", async () => { if (!c.dialpadNumbers.includes(c.sharedSmsNumber)) throw new Error("Include the main line in the monitored numbers"); dialpadCallItems(await dialpad(`/call?started_after=${Date.now() - 60_000}`)); }],
    ["Shared text channel", async () => { await verifySmsChannel(); }],
    ["Webhook signatures", async () => { if (!keys.frontSigningKey || !keys.dialpadSigningKey) throw new Error("Save both webhook signing secrets"); }],
  ];
  await Promise.all(tasks.map(async ([name, check]) => { try { await check(); checks.push({ name, ok: true, detail: "Verified" }); } catch(e) { checks.push({ name, ok: false, detail: e instanceof Error ? e.message : "Could not verify" }); } }));
  return checks;
}
export async function activationChecks() {
  const checks = await connectionChecks();
  for (const provider of ["front", "dialpad"]) {
    const receipt = await get<{ at: string }>(`health:webhook:${provider}`);
    checks.push({ name: `${provider} signed test event`, ok: !!receipt && Date.now() - Date.parse(receipt.data.at) < 86400_000, detail: receipt ? `Last receipt: ${receipt.data.at}` : "Send a controlled test event to the configured webhook" });
  }
  return checks;
}

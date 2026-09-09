import { config, credentials } from "./config";
import { front, dialpad, verifyEmailChannel } from "./providers";
import { get } from "./store";
import { validRole } from "./workflow";
export async function connectionChecks() {
  const c = await config(), keys = await credentials();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const tasks: [string, () => Promise<void>][] = [
    ["Default responsibilities", async () => { if (!c.defaultUserId) throw new Error("Choose Brian Cole and enable both assignment roles"); await validRole(c.defaultUserId, "SALESPERSON"); await validRole(c.defaultUserId, "CHAMPION", false); }],
    ["Front company", async () => { if (!c.frontCompanyId) throw new Error("Enter the Front company ID"); const me = await front<{ id: string }>("/me"); if (me.id !== c.frontCompanyId) throw new Error("Front company does not match settings"); }],
    ["Front sales channel", async () => { await verifyEmailChannel(); }],
    ["Front inbox access", async () => { for (const id of [c.frontInboxId, ...c.allowedInboxIds]) { if (!id) throw new Error("Choose the sales inbox"); await front(`/inboxes/${id}`); } }],
    ["Dialpad company", async () => { const me = await dialpad<{ company_id?: number }>("/users/me"); if (String(me.company_id) !== c.dialpadCompanyId) throw new Error("Dialpad company does not match settings"); }],
    ["Dialpad call history", async () => { if (!c.dialpadNumbers.includes(c.sharedSmsNumber)) throw new Error("Include the main line in the monitored numbers"); const p = await dialpad<{ items?: unknown[] }>(`/call?started_after=${Date.now() - 60_000}`); if (!Array.isArray(p.items)) throw new Error("Call history is unavailable"); }],
    ["Shared text channel", async () => { if (!c.frontSmsChannelId) throw new Error("Connect the native Dialpad shared SMS channel"); const ch = await front<{ address?: string; is_valid?: boolean }>(`/channels/${c.frontSmsChannelId}`); if (ch.address !== c.sharedSmsNumber || ch.is_valid === false) throw new Error("The text channel does not match the shared main line"); }],
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

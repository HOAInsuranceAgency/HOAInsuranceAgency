import { get, issue, row, save } from "./store";
import { config } from "./config";
import { resolveIssue } from "./routing";
/** Runs independently of the delivery worker, including when that worker stops. */
export const handler = async () => {
  const c = await config(); if (!c.activatedAt) return;
  const now = new Date(), worker = await get("health:worker");
  const errors: string[] = [];
  if (!worker || worker.data.lagging || now.getTime() - Date.parse(String(worker.data.at)) > 300_000) errors.push("Communication processing has stopped. Incoming work may be missing.");
  if (errors.length) await issue("independent-monitor", errors.join(" ")); else await resolveIssue("independent-monitor");
  const old = await get("health:monitor");
  await save(row("HEALTH", "health:monitor", { at: now.toISOString(), errors }, { previous: old }), old);
  // A metric filter/alarm watches this independent health result as well.
  console.log(JSON.stringify({ communicationMonitorFailures: errors.length }));
  if (errors.length) throw new Error("Communication processing requires intervention");
  return { errors };
};

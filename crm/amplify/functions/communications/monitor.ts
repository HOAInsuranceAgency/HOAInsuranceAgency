import { get, issue, row, save } from "./store";
import { config } from "./config";
import { resolveIssue } from "./routing";
import { businessDate, morningReminderAt } from "../../../../shared/leadWorkflow";
import { validateCompleteRouting } from "../../../../shared/workRouting";
import { routing } from "./routing";
import { team } from "./workflow";

/** Runs independently of the delivery worker, including when that worker stops. */
export const handler = async () => {
  const c = await config(); if (!c.activatedAt) return;
  const now = new Date(), worker = await get("health:worker"), census = await get("coverage:census");
  const errors: string[] = [];
  if (!c.paused) {
    try { validateCompleteRouting(await routing(), await team()); }
    catch { errors.push("Manager or owner coverage is incomplete. Repair team routing before relying on escalation delivery."); }
  }
  if (!worker || worker.data.lagging || now.getTime() - Date.parse(String(worker.data.at)) > 300_000) errors.push("Communication processing has stopped. Incoming work may be missing.");
  if (!census?.data.completedAt || now.getTime() - Date.parse(String(census.data.completedAt)) > 24 * 3600_000) errors.push("The daily account coverage check has not completed.");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(now));
  // New delivery activated after the 9am batch cannot have sent that day's
  // report. Its first eligible morning is still monitored normally.
  const reportWindowEnd = Date.parse(morningReminderAt(now.toISOString(), c.holidays)) + 10 * 60_000;
  if (businessDate(day, c.holidays) && hour >= 10 && !c.paused && Date.parse(c.activatedAt) < reportWindowEnd) {
    const reportHealth = await get("health:reports");
    if (!reportHealth || String(reportHealth.data.day) !== day || reportHealth.data.incomplete) errors.push("Morning report delivery is incomplete. Check the assigned report exceptions.");
  }
  if (errors.length) await issue("independent-monitor", errors.join(" ")); else await resolveIssue("independent-monitor");
  const old = await get("health:monitor");
  await save(row("HEALTH", "health:monitor", { at: now.toISOString(), errors }, { previous: old }), old);
  // A metric filter/alarm watches this independent health result as well.
  console.log(JSON.stringify({ communicationMonitorFailures: errors.length }));
  if (errors.length) throw new Error("Communication coverage requires intervention");
  return { errors };
};

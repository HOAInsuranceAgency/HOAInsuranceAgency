import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * The website lead auto-reply sweep.
 *
 * Runs every minute and sends at most one email per lead, once that lead's
 * upload window has closed and any documents they sent have been read.
 *
 * ── Why a sweep and not a timer ──
 * The deadline belongs to the server. A browser cannot be trusted to tell us
 * when a visitor is finished: `beforeunload` often does not fire, a laptop lid
 * closes without any event at all, and `visibilitychange` fires when someone
 * switches tabs to find the file they were about to attach. So the browser only
 * ever moves `LeadReply.dueAt` *forward in urgency* — requesting an upload
 * pushes it out, "done" pulls it in — and this function is the only thing that
 * decides anything. If every beacon is lost, the reply still goes.
 *
 * One minute is the finest EventBridge offers and is the right granularity: the
 * window is measured in minutes, so a sub-minute deadline is not a thing anyone
 * asked for, and a lead waits at most 60 seconds past their deadline.
 *
 * ── Why it may run for a while ──
 * A single tick can send several emails and each one waits on a model call, so
 * the timeout is generous. Overlapping runs are safe: claiming a row flips it
 * to SENDING first, and a second sweep skips anything not WAITING.
 */
export const leadReply = defineFunction({
  name: "lead-reply",
  entry: "./handler.ts",
  schedule: {
    // Every minute. Day-of-month `*`, day-of-week `?` — the one combination
    // Amplify's validator accepts (see task-digest for the trap here).
    cron: "* * * * ? *",
    timezone: "America/New_York",
    description: "Website lead auto-reply sweep",
  },
  timeoutSeconds: 600,
  memoryMB: 1024,
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
  resourceGroupName: "data",
});

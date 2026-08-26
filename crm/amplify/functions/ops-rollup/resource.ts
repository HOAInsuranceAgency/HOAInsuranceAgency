import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * The owner's daily operations rollup.
 *
 * One email each morning to the principal: what moved in the CRM since the
 * last edition, and what should have been addressed and wasn't. It is the only
 * surface in the system that answers the second question across the whole
 * agency — `attention.ts` answers it on a screen somebody has to open, and the
 * two outbound jobs each cover one slice (open marketing tasks, licence
 * deadlines) to the shared inbox.
 *
 * ── Why 07:20 ──
 *
 * Last in the morning queue, deliberately: `renewal-tasks` 05:00,
 * `license-alerts` 06:00, `pf-autopay` 06:15, `pf-default-sweep` 06:45,
 * `task-digest` 07:00. Every one of those either raises or clears something
 * this reports, so running behind them means the rollup describes the agency
 * as it stands after this morning's sweeps rather than yesterday's. Twenty
 * minutes behind `task-digest` also keeps two full-table readers from
 * contending, and puts the team's email in the inbox first.
 *
 * Pinned to a timezone rather than UTC so it does not drift an hour twice a
 * year — and, more importantly, because the reporting WINDOW is Eastern (see
 * `window.ts`): a rollup on UTC boundaries files Monday evening's work under
 * Tuesday.
 *
 * ── Why every day ──
 *
 * Unlike `task-digest`, which is weekdays-only because carrier submissions are
 * weekday work, some of what this watches runs on the calendar and does not
 * observe a weekend: the premium-finance cancellation clock counts calendar
 * days, policies expire on Saturdays, and a Friday-evening web lead whose
 * auto-reply failed has heard nothing by Monday. So it runs seven days and
 * `window.ts` makes the weekend editions cheap — open exposures only, and
 * silent when there are none, because a Saturday email that says "all clear"
 * every week is how a reader learns to archive the one that doesn't.
 *
 * Monday's edition covers Friday, Saturday and Sunday as one block, so no work
 * goes unreported.
 *
 * `* * ?` in the day fields, never `MON-FRI`. Amplify validates the expression
 * itself before EventBridge sees it and its day-of-week check is a plain
 * numeric range, so `Number("MON")` is NaN, the schedule is rejected, and synth
 * dies partway through asset staging with an unrelated-looking ENOENT about
 * copying `schema.graphql`. `npm run synth:check` is what catches it; `tsc`
 * cannot see it at all.
 *
 * ── Why it writes nothing, and has no ledger ──
 *
 * This report is private to one reader, and the constraint that shapes the
 * whole design is that no other signed-in user may discover it exists. Every
 * model in `data/resource.ts` becomes types and CRUD fields in the generated
 * GraphQL API, and Amplify writes a `model_introspection` block into
 * `amplify_outputs.json` that the SPA fetches — so model-level auth hides a
 * table's DATA but never its SHAPE. A dedupe ledger, a "last sent" row, a
 * settings flag: each is precisely the artifact that would publish the
 * feature to everyone.
 *
 * So this function adds no model, no field, no custom query and no mutation.
 * It reads, it sends, and it keeps nothing. What would normally be a ledger —
 * "have I already reported this?" — is answered in `detect.ts` from the age of
 * the finding itself, which needs no memory.
 *
 * The cost is `task-digest`'s cost: a duplicate EventBridge delivery sends a
 * duplicate email. The alternative is the table, and the table is the leak.
 *
 * The name is accurate and boring on purpose. A deliberately misleading one
 * would be worse than a discoverable one, because it turns ordinary curiosity
 * into evidence of concealment.
 *
 * ── Memory ──
 *
 * 1024MB rather than `task-digest`'s 512: this holds a fortnight of Activity
 * rows plus every open invoice, loan and task at once. Lambda scales CPU with
 * memory, so the larger size is also the cheaper one for a job that spends its
 * time parsing JSON.
 */
export const opsRollup = defineFunction({
  name: "ops-rollup",
  entry: "./handler.ts",
  schedule: {
    cron: "20 7 * * ? *",
    timezone: "America/New_York",
    description: "Daily operations rollup",
  },
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: "data",
  environment: {
    /**
     * The opening paragraph is written by Claude from the figures this job
     * computes. Same Amplify secret the extraction functions use — set per
     * branch in Hosting → Secrets, and via `ampx sandbox secret set` locally.
     *
     * Optional in practice: `read.ts` returns null when the key is missing, so
     * an environment without it still sends the full report, just without the
     * paragraph at the top.
     */
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
  },
});

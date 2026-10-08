# Nightly Audit Engineer

The GitHub-hosted workflow runs daily at **4:00 a.m. America/New_York**, including
daylight-saving changes, without depending on a developer's Mac. GitHub schedules
can start late during service load; they are not an exact-time guarantee. The workflow
must be on the repository's default branch (`main`) for scheduled runs to activate.

Use **Actions → Nightly Audit Engineer → Run workflow** for an on-demand run. The
default `smoke` mode checks API authentication, staging checkout, dependency installation,
and a short read-only Codex task. Select `audit` to research and propose cleanups.
Same-repository PRs changing the audit setup also run smoke mode. Fork PRs receive no key.
Only an audit running from `main` can publish.

The full prompt is in [`.github/prompts/nightly-audit.md`](../.github/prompts/nightly-audit.md).
Codex researches the website, CRM, backend, and shared logic, then proposes zero or one
worthwhile cleanup per area. It works from the exact current `staging` commit in prepared
isolated worktrees. Existing open PRs and recent audit PR history inform research, and
pending audit PRs block another proposal in the same area. Cross-cutting fixes have one
primary owner; independent proposals cannot touch the same file.

Each cleanup needs relevant local validation before handoff. Changes requiring live
credentials, deployments, data migrations, or customer messaging are deferred. The
publisher limits each patch to 20 text files and 500 changed lines and rejects hidden
control files, secrets it recognizes, generated outputs, symlinks, and submodules.

## Credentials and permissions

Configure these under **Settings → Secrets and variables → Actions**:

- Repository secret `OPENAI_API_KEY`: a project API key with Responses API write access
  and model read access. The key is passed only to the official Codex action input;
  its protected proxy supplies authentication without giving the key to the agent.
- Optional repository variable `CODEX_AUDIT_MODEL`: defaults to `gpt-6-astra`.
  Full audits use high reasoning effort; smoke checks use low effort.

Under **Settings → Actions → General → Workflow permissions**, enable
**Allow GitHub Actions to create and approve pull requests**. This workflow only creates
ready-for-review PRs so configured automated reviewers such as Greptile can start.
It never approves or merges them. Repository branch protections still apply.
The agent job has a read-only GitHub token and no network access in its sandbox. A fresh
publisher job gets scoped contents/pull-request write permission, revalidates patches,
rechecks open PRs and the staging base, and creates one ready-for-review PR per selected area.
It never executes proposed code. All action revisions and the Codex CLI are pinned.

Ready-for-review PRs target `staging`; the workflow never pushes directly to `main` or `staging`,
merges, or deploys. Audit branches use `codex/nightly-audit/<date>/<run>-<attempt>/<area>`.
Commits include `[skip-cd]`. PRs created using `GITHUB_TOKEN` may require approval before
other GitHub workflows run, so audit validation runs before publication.

## Results, failures, and cost

Read the workflow run summary for findings, validation, skipped overlaps, and PR
links. Proposed patches and the manifest are retained as an artifact for seven days;
the final Codex report is saved separately for seven days whenever it exists, including
failed runs, so coverage and blockers remain available if proposal validation fails.
Raw agent transcripts, dependency directories, and environment files are not uploaded.
Closed/merged audit PR history serves as durable context for later runs.

Overlapping runs are serialized. A changed staging base, invalid artifact, API failure,
or failed dependency installation stops the run; inspect the failed step, then rerun
manually. Enable GitHub Actions failure notifications for this repository if desired.
GitHub-hosted schedules can be delayed and inactive public repositories may have their
schedules disabled after 60 days, so an occasional check of Actions remains useful.

API usage is billed to the OpenAI API project separately from a ChatGPT subscription.
GitHub runner charges depend on repository visibility and plan. The audit job has a
65-minute timeout and the publisher has ten minutes; timeouts are not a spending cap.
Use the API project's usage reporting and budget alerts, and review the first full run
before choosing a different model or longer runtime. Do not store billing credentials
in the repository.

After this hosted workflow is enabled and smoke passes, retire the matching local Codex
automation to avoid duplicate runs. Keep it paused, rather than active, if retaining it
as a fallback.

## Local checks for workflow changes

```sh
python3 -m unittest discover -s .github/scripts -p 'test_*.py' -v
actionlint .github/workflows/nightly-audit.yml
```

These checks exercise the publishing boundary without API calls, PRs, or application
changes. A smoke workflow run verifies the actual hosted environment and API credentials.

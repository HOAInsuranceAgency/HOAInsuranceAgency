#!/usr/bin/env python3
"""Validate untrusted audit proposals and publish independent draft PRs.

Only this trusted workflow copy runs with a write token. Candidate code is never
executed here; dependency installation and tests belong to the read-only job.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

AREAS = {
    "web": ("web/",),
    "crm": ("crm/",),
    "backend": ("crm/amplify/",),
    "shared": ("shared/", "scripts/"),
}
DEPENDENCY_DIRS = ("web/node_modules", "crm/node_modules")
MAX_PATCH_BYTES = 200_000
MAX_CHANGED_LINES = 500
MAX_CHANGED_FILES = 20
SECRET = re.compile(r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[A-Z0-9]{16}")


def run(args, cwd=None, *, input=None):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0")
    return subprocess.run(args, cwd=cwd, input=input, text=True, capture_output=True,
                          check=True, env=env).stdout


def git(repo, *args):
    return run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *args], repo)


def read_text(path, limit):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError(f"Invalid or oversized artifact: {path.name}")
    value = path.read_text(encoding="utf-8")
    if SECRET.search(value):
        raise ValueError(f"Possible secret in artifact: {path.name}")
    return value


def safe_path(name):
    path = PurePosixPath(name)
    if not name or str(path) != name or path.is_absolute() or ".." in path.parts:
        raise ValueError("Patch contains an invalid path")
    if any(part.startswith(".") for part in path.parts):
        raise ValueError(f"Patch may not change hidden or control files: {name}")
    if path.name in {"AGENTS.md", "CLAUDE.md", "auth.json", "amplify_outputs.json"}:
        raise ValueError(f"Patch may not change instructions or generated credentials: {name}")
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".sqlite", ".db", ".zip", ".gz"}:
        raise ValueError(f"Patch contains a sensitive or binary file: {name}")
    if any(part in {"node_modules", "dist", "build", "coverage", "audit-output"} for part in path.parts):
        raise ValueError(f"Patch contains generated output: {name}")


def load_manifest(output, expected_base):
    manifest = json.loads(read_text(output / "manifest.json", 100_000))
    if set(manifest) != {"base_sha", "report", "areas"} or manifest["base_sha"] != expected_base:
        raise ValueError("Manifest must describe the exact researched staging commit")
    if not re.fullmatch(r"[0-9a-f]{40}", expected_base):
        raise ValueError("Invalid base commit")
    if not isinstance(manifest["report"], str) or not manifest["report"].strip():
        raise ValueError("A research/validation report is required, including when no cleanup is proposed")
    areas = manifest["areas"]
    if not isinstance(areas, list) or len(areas) > len(AREAS):
        raise ValueError("Too many area proposals")
    seen = set()
    for item in areas:
        if not isinstance(item, dict) or set(item) != {"area", "title", "body", "patch"}:
            raise ValueError("Invalid proposal fields")
        area = item["area"]
        if area not in AREAS or area in seen or item["patch"] != f"{area}.patch":
            raise ValueError("Each known area may have only one proposal and its own patch")
        seen.add(area)
        if not isinstance(item["title"], str) or not 5 <= len(item["title"]) <= 160 or "\n" in item["title"]:
            raise ValueError("Invalid PR title")
        if not isinstance(item["body"], str) or not 20 <= len(item["body"]) <= 20_000:
            raise ValueError("Invalid PR description")
        patch = read_text(output / item["patch"], MAX_PATCH_BYTES)
        if not patch.strip() or "GIT binary patch" in patch or "Binary files " in patch:
            raise ValueError("Only nonempty text patches are allowed")
    return manifest


def current_prs(repo_name):
    prs = json.loads(run(["gh", "pr", "list", "--repo", repo_name, "--state", "open", "--limit", "1000",
                          "--json", "number,title,url,headRefName,headRefOid,baseRefName,baseRefOid,files,changedFiles"]))
    if len(prs) >= 1000:
        raise ValueError("Open PR list may be truncated; review overlap manually")
    for pr in prs:
        expected = pr["changedFiles"]
        if len(pr["files"]) == expected:
            continue
        if len(pr["files"]) > expected:
            raise ValueError("PR file count changed; rerun the overlap check")
        if expected >= 3000:
            raise ValueError("PR reaches the REST API's 3000-file limit; review overlap manually")
        endpoint = f"repos/{repo_name}/pulls/{pr['number']}"
        pages = json.loads(run(["gh", "api", "--paginate", "--slurp", f"{endpoint}/files?per_page=100"]))
        files = [{"path": item["filename"]} for page in pages for item in page]
        if len(files) != expected or len({item["path"] for item in files}) != expected:
            raise ValueError("PR file list is incomplete; rerun the overlap check")
        latest = json.loads(run(["gh", "api", endpoint, "--jq",
                                 "{head: .head.sha, base: .base.sha, count: .changed_files, state: .state}"]))
        if latest != {"head": pr["headRefOid"], "base": pr["baseRefOid"],
                      "count": expected, "state": "open"}:
            raise ValueError("PR changed during pagination; rerun the overlap check")
        pr["files"] = files
    return prs


def overlapping_pr(prs, area, paths=()):
    for pr in prs:
        head = pr["headRefName"]
        if head.startswith("codex/nightly-audit/") and head.rsplit("/", 1)[-1] == area:
            return pr
        if set(paths).intersection(item["path"] for item in pr.get("files", [])):
            return pr
    return None


def prepare(args):
    repo, output = args.repo.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    base = git(repo, "rev-parse", "HEAD").strip()
    prs = current_prs(args.repository)
    history = json.loads(run(["gh", "pr", "list", "--repo", args.repository, "--state", "closed", "--limit", "100",
                              "--json", "number,title,url,headRefName,mergedAt"]))
    context = {"base_sha": base, "open_pull_requests": prs,
               "recent_audit_results": [pr for pr in history if pr["headRefName"].startswith("codex/nightly-audit/")],
               "blocked_areas": [area for area in AREAS if overlapping_pr(prs, area)]}
    (output / "context.json").write_text(json.dumps(context, indent=2) + "\n")
    # :workspace intentionally protects Git metadata. Prepare isolated worktrees
    # and reuse downloaded dependencies before the sandbox starts.
    for area in AREAS:
        worktree = repo / "audit-worktrees" / area
        git(repo, "worktree", "add", "--detach", str(worktree), base)
        for relative in DEPENDENCY_DIRS:
            installed, link = repo / relative, worktree / relative
            if installed.is_dir() and link.parent.is_dir() and not link.exists():
                link.symlink_to(installed, target_is_directory=True)
    if os.getenv("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as target:
            target.write(f"base_sha={base}\n")


def validate_patch(repo, patch, area):
    # Git checks traversal before any write. We also inspect the resulting index;
    # renames become deletion/addition pairs so neither path escapes validation.
    git(repo, "apply", "--check", "--index", str(patch))
    git(repo, "apply", "--index", str(patch))
    paths = git(repo, "diff", "--cached", "--name-only", "--no-renames", "-z").rstrip("\0").split("\0")
    if not 1 <= len(paths) <= MAX_CHANGED_FILES:
        raise ValueError("Cleanup must change between 1 and 20 files")
    for path in paths:
        safe_path(path)
    def owner(path):
        matches = [(len(prefix), key) for key, prefixes in AREAS.items() for prefix in prefixes if path.startswith(prefix)]
        return max(matches)[1] if matches else None
    if not any(owner(path) == area for path in paths):
        raise ValueError("Cleanup must include its declared area")
    lines = 0
    for row in git(repo, "diff", "--cached", "--numstat", "--no-renames").splitlines():
        added, deleted, _ = row.split("\t", 2)
        if not added.isdecimal() or not deleted.isdecimal():
            raise ValueError("Binary files are not allowed")
        lines += int(added) + int(deleted)
    if lines > MAX_CHANGED_LINES:
        raise ValueError("Cleanup exceeds 500 changed lines; defer it for human planning")
    for row in git(repo, "diff", "--cached", "--raw", "--no-renames").splitlines():
        old_mode, new_mode = row.split()[:2]
        if old_mode[1:] not in {"000000", "100644", "100755"} or new_mode not in {"000000", "100644", "100755"}:
            raise ValueError("Symlinks and submodules are not allowed")
    return paths


def export_patch(args):
    """Capture tracked and new files without writing protected Git metadata."""
    repo = args.repo.resolve()
    patch = git(repo, "diff", "--no-ext-diff", "--no-renames", "HEAD")
    for name in git(repo, "ls-files", "--others", "--exclude-standard", "-z").rstrip("\0").split("\0"):
        if not name:
            continue
        safe_path(name)
        path = repo / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Only regular new files are permitted")
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "diff", "--no-ext-diff",
                                 "--no-index", "--", "/dev/null", name], cwd=repo,
                                text=True, capture_output=True)
        if result.returncode != 1:
            raise ValueError("Could not export new file")
        patch += result.stdout
    args.output.write_text(patch)


def summary(value):
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as target:
            target.write(value + "\n\n")


def publish(args):
    repo, output = args.repo.resolve(), args.output.resolve()
    manifest = load_manifest(output, args.base)
    if git(repo, "rev-parse", "HEAD").strip() != args.base:
        raise ValueError("Staging moved during this audit; rerun against the new base")
    # Validate every proposal before publishing any. Never execute files from the
    # proposal, invoke package scripts, or use an artifact as executable code.
    proposals = []
    seen_paths = set()
    for item in manifest["areas"]:
        try:
            paths = validate_patch(repo, output / item["patch"], item["area"])
            if seen_paths.intersection(paths):
                raise ValueError("Independent area proposals may not modify the same file")
            seen_paths.update(paths)
            proposals.append((item, paths))
        finally:
            git(repo, "reset", "--hard", args.base)
            git(repo, "clean", "-fd")
    summary(manifest["report"])
    if args.validate_only:
        print(f"Validated {len(proposals)} area proposals; no branches or PRs created.")
        return
    run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    if not run_id.isdecimal() or not attempt.isdecimal():
        raise ValueError("Invalid workflow run identity")
    date = run(["date", "-u", "+%Y-%m-%d"]).strip()
    for item, paths in proposals:
        area = item["area"]
        overlap = overlapping_pr(current_prs(args.repository), area, paths)
        if overlap:
            summary(f"Skipped {area}: overlaps existing PR #{overlap['number']}.")
            continue
        latest_base = run(["gh", "api", f"repos/{args.repository}/git/ref/heads/staging", "--jq", ".object.sha"]).strip()
        if latest_base != args.base:
            raise ValueError("Staging moved before publication; rerun the audit")
        # A deterministic unique branch makes retries safe and preserves older work.
        branch = f"codex/nightly-audit/{date}/{run_id}-{attempt}/{area}"
        git(repo, "checkout", "--detach", args.base)
        validate_patch(repo, output / item["patch"], area)
        git(repo, "checkout", "-b", branch)
        title = f"Nightly audit: {area} — {item['title']}"
        git(repo, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", f"{title} [skip-cd]")
        # gh reads GH_TOKEN from this publisher step only; no token is persisted.
        git(repo, "-c", "credential.helper=!gh auth git-credential", "push", "origin", f"HEAD:refs/heads/{branch}")
        run_url = f"https://github.com/{args.repository}/actions/runs/{run_id}"
        body = f"{item['body']}\n\nBase: `{args.base}`. [Audit run]({run_url}).\n\nCreated as a draft for human review. No merge or deployment is authorized.\n<!-- nightly-audit:{area} -->\n"
        pr_url = run(["gh", "pr", "create", "--repo", args.repository, "--base", "staging", "--head", branch,
                      "--draft", "--title", title, "--body-file", "-"], input=body).strip()
        summary(f"Draft PR for {area}: {pr_url}")
        print(f"Published draft PR for {area}: {pr_url}")
    if not proposals:
        summary("No worthwhile cleanup selected. No branch or PR was created.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "publish"):
        command = sub.add_parser(name)
        command.add_argument("--repo", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
        command.add_argument("--repository", required=True)
        if name == "publish":
            command.add_argument("--base", required=True)
            command.add_argument("--validate-only", action="store_true")
    export = sub.add_parser("export")
    export.add_argument("--repo", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    {"prepare": prepare, "publish": publish, "export": export_patch}[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, OSError) as error:
        # Avoid dumping untrusted artifacts or command stderr into public logs.
        print(f"Nightly audit stopped: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)

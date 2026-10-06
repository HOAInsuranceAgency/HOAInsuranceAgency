"""Offline tests for the boundary between untrusted proposals and PR publication."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import nightly_audit as audit


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.output = self.root / "output"
        self.output.mkdir()
        audit.git(self.repo, "init", "-q")
        audit.git(self.repo, "config", "user.name", "Test")
        audit.git(self.repo, "config", "user.email", "test@example.invalid")
        for name in ("web/src/app.ts", "crm/src/app.ts", "crm/amplify/backend.ts", "shared/domain.ts"):
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("export const value = 1;\n")
        audit.git(self.repo, "add", ".")
        audit.git(self.repo, "commit", "-qm", "Initial")
        self.base = audit.git(self.repo, "rev-parse", "HEAD").strip()

    def proposal(self, area="web", name="web/src/app.ts", value="export const value = 2;\n"):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        patch_path = self.output / f"{area}.patch"
        audit.export_patch(argparse.Namespace(repo=self.repo, output=patch_path))
        audit.git(self.repo, "reset", "--hard", self.base)
        audit.git(self.repo, "clean", "-fd")
        return {"area": area, "title": "Remove redundant fallback", "body": "Removes confirmed redundant logic. Relevant existing tests pass.", "patch": patch_path.name}

    def manifest(self, areas):
        value = {"base_sha": self.base, "report": "Researched all areas; one justified cleanup selected. Local tests passed.", "areas": areas}
        (self.output / "manifest.json").write_text(json.dumps(value))
        return value

    def test_prepare_builds_isolated_worktrees_and_dependency_links(self):
        for relative in audit.DEPENDENCY_DIRS:
            (self.repo / relative).mkdir(parents=True)
        args = argparse.Namespace(repo=self.repo, output=self.output, repository="owner/repo")
        original_run = audit.run
        def fake_run(command, *a, **kw):
            return "[]" if command[0] == "gh" else original_run(command, *a, **kw)
        with patch.object(audit, "run", side_effect=fake_run):
            audit.prepare(args)
        for area in audit.AREAS:
            worktree = self.repo / "audit-worktrees" / area
            self.assertEqual(audit.git(worktree, "rev-parse", "HEAD").strip(), self.base)
            for relative in audit.DEPENDENCY_DIRS:
                self.assertTrue((worktree / relative).is_symlink())
        self.assertEqual(json.loads((self.output / "context.json").read_text())["base_sha"], self.base)

    def test_valid_patch_and_new_file_export(self):
        proposal = self.proposal(name="web/src/new.ts")
        self.manifest([proposal])
        self.assertEqual(len(audit.load_manifest(self.output, self.base)["areas"]), 1)
        self.assertEqual(audit.validate_patch(self.repo, self.output / "web.patch", "web"), ["web/src/new.ts"])

    def test_empty_run_is_valid(self):
        self.manifest([])
        self.assertEqual(audit.load_manifest(self.output, self.base)["areas"], [])

    def test_manifest_rejects_duplicate_areas_unknown_areas_wrong_base_and_path(self):
        proposal = self.proposal()
        for areas in ([proposal, proposal], [{**proposal, "area": "unknown"}], [{**proposal, "patch": "../web.patch"}]):
            self.manifest(areas)
            with self.assertRaises(ValueError):
                audit.load_manifest(self.output, self.base)
        self.manifest([proposal])
        with self.assertRaises(ValueError):
            audit.load_manifest(self.output, "0" * 40)

    def test_manifest_rejects_symlink_and_possible_secret(self):
        self.manifest([])
        original = self.output / "manifest.json"
        original.rename(self.output / "other.json")
        original.symlink_to(self.output / "other.json")
        with self.assertRaises(ValueError):
            audit.load_manifest(self.output, self.base)
        original.unlink()
        value = self.manifest([])
        value["report"] = "sk-proj-" + "x" * 40
        original.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            audit.load_manifest(self.output, self.base)

    def test_control_secret_generated_and_traversal_paths_are_rejected(self):
        for name in (".github/workflows/run.yml", "web/.env", ".git/config", "AGENTS.md", "web/node_modules/x.js", "web/dist/x.js", "crm/amplify_outputs.json", "web/key.pem", "../escape", "/absolute", "web//bad"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                audit.safe_path(name)

    def test_backend_does_not_count_as_crm_ownership(self):
        self.proposal("crm", "crm/amplify/backend.ts")
        with self.assertRaisesRegex(ValueError, "declared area"):
            audit.validate_patch(self.repo, self.output / "crm.patch", "crm")

    def test_large_changes_are_deferred(self):
        self.proposal(value="\n".join(str(i) for i in range(501)) + "\n")
        with self.assertRaisesRegex(ValueError, "500"):
            audit.validate_patch(self.repo, self.output / "web.patch", "web")

    def test_symlink_changes_are_rejected(self):
        path = self.repo / "web/src/app.ts"
        path.unlink()
        path.symlink_to("/tmp/target")
        audit.git(self.repo, "add", "web/src/app.ts")
        patch_text = audit.git(self.repo, "diff", "--cached")
        audit.git(self.repo, "reset", "--hard", self.base)
        (self.output / "web.patch").write_text(patch_text)
        with self.assertRaisesRegex(ValueError, "Symlinks"):
            audit.validate_patch(self.repo, self.output / "web.patch", "web")

    def test_truncated_pr_files_stop_overlap_check(self):
        rows = [{"files": [{"path": "web/src/app.ts"}], "changedFiles": 101}]
        with patch.object(audit, "run", return_value=json.dumps(rows)), self.assertRaisesRegex(ValueError, "truncated"):
            audit.current_prs("owner/repo")

    def test_pending_audit_area_and_any_pr_file_overlap_are_detected(self):
        prs = [{"headRefName": "codex/nightly-audit/2026-10-06/1-1/web", "files": [{"path": "web/src/other.ts"}]}]
        self.assertIsNotNone(audit.overlapping_pr(prs, "web"))
        self.assertIsNone(audit.overlapping_pr(prs, "crm", ["crm/src/app.ts"]))
        prs[0]["headRefName"] = "feature/owned-by-someone-else"
        self.assertIsNotNone(audit.overlapping_pr(prs, "crm", ["web/src/other.ts"]))

    def test_validate_only_never_calls_github_or_push(self):
        self.manifest([self.proposal()])
        args = argparse.Namespace(repo=self.repo, output=self.output, repository="owner/repo", base=self.base, validate_only=True)
        with patch.object(audit, "current_prs", side_effect=AssertionError("No network")):
            audit.publish(args)
        self.assertEqual(audit.git(self.repo, "status", "--porcelain"), "")
        self.assertEqual(audit.git(self.repo, "rev-parse", "HEAD").strip(), self.base)

    def test_stale_base_cannot_publish(self):
        self.manifest([])
        args = argparse.Namespace(repo=self.repo, output=self.output, repository="owner/repo", base="0" * 40, validate_only=False)
        with patch.object(audit, "current_prs", side_effect=AssertionError("No network")), self.assertRaises(ValueError):
            audit.publish(args)

    def test_invalid_second_proposal_publishes_nothing(self):
        first = self.proposal()
        second = self.proposal("crm", "crm/src/app.ts")
        (self.output / "crm.patch").write_text("not a patch\n")
        self.manifest([first, second])
        args = argparse.Namespace(repo=self.repo, output=self.output, repository="owner/repo", base=self.base, validate_only=False)
        with patch.object(audit, "current_prs", side_effect=AssertionError("Must validate all before network")), self.assertRaises(subprocess.CalledProcessError):
            audit.publish(args)
        self.assertEqual(audit.git(self.repo, "status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main()

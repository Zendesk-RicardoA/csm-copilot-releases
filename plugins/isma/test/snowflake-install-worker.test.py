import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("installer", Path(__file__).parents[1] / "mcp/snowflake-install-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Builder:
    def create(self, target):
        folder = target / "bin"
        folder.mkdir(exist_ok=True)
        for name in ("python3", "snow"):
            (folder / name).write_text("")
            (folder / name).chmod(0o700)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="isma-install-test-")
        self.addCleanup(self.temporary.cleanup)
        self.target = Path(self.temporary.name).resolve() / "runtime"

    def test_only_pinned_user_local_install_and_offline_checks(self):
        calls = []
        def run(args, **options):
            calls.append((args, options))
            return SimpleNamespace(returncode=0, stdout="Snowflake CLI version: 3.24.1", stderr="")
        value = worker.install(self.target, target_id='darwin-arm64', runner=run, builder=Builder())
        self.assertEqual(value["status"], "installed_verified")
        self.assertFalse(value["source_access_verified"])
        self.assertFalse(value["configuration_changed"])
        pip = calls[0][0]
        self.assertIn("--require-hashes", pip)
        self.assertIn("snowflake-cli==3.24.1", Path(pip[-1]).read_text())
        self.assertIn("--only-binary=:all:", pip)
        self.assertIn("https://pypi.org/simple", pip)
        self.assertNotIn("--user", pip)
        self.assertNotIn("--break-system-packages", pip)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.target / worker.MARKER).stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(options["stdin"] == subprocess.DEVNULL for _, options in calls))

    def test_existing_unowned_directory_is_preserved(self):
        self.target.mkdir(mode=0o700)
        existing = self.target / "keep"
        existing.write_text("invented existing file")
        with self.assertRaisesRegex(worker.InstallError, "INSTALL_RUNTIME_UNSAFE"):
            worker.install(self.target, target_id='darwin-arm64', runner=lambda *a, **k: self.fail("No process expected"), builder=Builder())
        self.assertEqual(existing.read_text(), "invented existing file")

    def test_symlinked_directory_is_preserved(self):
        destination = self.target.parent / "destination"
        destination.mkdir()
        self.target.symlink_to(destination)
        with self.assertRaisesRegex(worker.InstallError, "INSTALL_RUNTIME_UNSAFE"):
            worker.install(self.target, target_id='darwin-arm64', builder=Builder())
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(list(destination.iterdir()), [])

    def test_network_failure_has_no_raw_output_and_marked_retry_can_resume(self):
        def fail(args, **options):
            return SimpleNamespace(returncode=1, stdout="", stderr="connection failed: invented-secret")
        with self.assertRaisesRegex(worker.InstallError, "^INSTALL_NETWORK_FAILED$"):
            worker.install(self.target, target_id='darwin-arm64', runner=fail, builder=Builder())
        self.assertEqual(json.loads((self.target / worker.MARKER).read_text())["package"], worker.PACKAGE)
        def success(args, **options):
            return SimpleNamespace(returncode=0, stdout="Snowflake CLI version: 3.24.1", stderr="")
        self.assertEqual(worker.install(self.target, target_id='darwin-arm64', runner=success, builder=Builder())["status"], "installed_verified")

    def test_tls_policy_failure_never_disables_verification(self):
        def fail(args, **options):
            self.assertNotIn("--trusted-host", args)
            return SimpleNamespace(returncode=1, stdout="", stderr="CERTIFICATE_VERIFY_FAILED: invented-private-path")
        with self.assertRaisesRegex(worker.InstallError, "^INSTALL_POLICY_BLOCKED$"):
            worker.install(self.target, target_id='darwin-arm64', runner=fail, builder=Builder())

    def test_timeout_is_distinct_and_does_not_start_verification(self):
        calls = []
        def timeout(args, **options):
            calls.append(args)
            raise subprocess.TimeoutExpired(args, 240)
        with self.assertRaisesRegex(worker.InstallError, "^INSTALLATION_TIMEOUT$"):
            worker.install(self.target, target_id='darwin-arm64', runner=timeout, builder=Builder())
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()

"""Install the fixed Snowflake CLI into an owner-private venv; never read connection files."""
from __future__ import annotations

import argparse
import hashlib
import platform
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import venv

PACKAGE = "snowflake-cli==3.24.1"
MARKER = ".isma-snowflake-install.json"


class InstallError(Exception):
    pass


def classify(stderr):
    value = stderr.lower()
    if any(word in value for word in ("permission denied", "operation not permitted", "eacces")):
        return "INSTALL_PERMISSION_DENIED"
    if any(word in value for word in ("certificate_verify_failed", "certificate verify failed", "blocked", "policy", "administrator")):
        return "INSTALL_POLICY_BLOCKED"
    if any(word in value for word in ("network", "could not resolve", "connection", "failed to download", "retrying", "name resolution")):
        return "INSTALL_NETWORK_FAILED"
    return "INSTALL_VERIFICATION_FAILED"


def safe_directory(target):
    if not target.is_absolute():
        raise InstallError("INSTALL_RUNTIME_UNSAFE")
    for part in (target, *target.parents):
        if part.is_symlink():
            raise InstallError("INSTALL_RUNTIME_UNSAFE")
        if part.exists() and part.stat().st_mode & 0o002 and not part.stat().st_mode & 0o1000:
            raise InstallError("INSTALL_RUNTIME_UNSAFE")
    if target.exists() and (not target.is_dir() or target.stat().st_uid != os.getuid() or target.stat().st_mode & 0o077):
        raise InstallError("INSTALL_RUNTIME_UNSAFE")


def run_checked(args, *, runner, environment):
    try:
        result = runner(args, env=environment, stdin=subprocess.DEVNULL, capture_output=True,
                        text=True, timeout=240, check=False)
    except subprocess.TimeoutExpired:
        raise InstallError("INSTALLATION_TIMEOUT") from None
    if result.returncode != 0:
        raise InstallError(classify(result.stderr or ""))
    return result


def locked_requirements(target_id):
    if target_id not in ("darwin-arm64", "darwin-x64"):
        raise InstallError("INSTALL_UNSUPPORTED_PLATFORM")
    config = Path(__file__).parents[1] / "config"
    spec = json.loads((config / "snowflake-managed-runtime.json").read_text())
    row = spec["targets"][target_id]
    expected_name = "snowflake-runtime-lock-" + target_id + ".txt"
    if row["requirements"] != expected_name or spec["snowflake_version"] != PACKAGE.split("==")[1]:
        raise InstallError("INSTALL_RECIPE_INVALID")
    lock = config / expected_name
    if lock.is_symlink() or hashlib.sha256(lock.read_bytes()).hexdigest() != row["requirements_sha256"]:
        raise InstallError("INSTALL_RECIPE_INVALID")
    return lock


def install(target, *, runner=subprocess.run, builder=None, target_id=None):
    if sys.version_info < (3, 11):
        raise InstallError("INSTALL_VERIFICATION_FAILED")
    if target_id is None:
        target_id = "darwin-" + ("arm64" if platform.machine() in ("arm64", "aarch64") else "x64") if sys.platform == "darwin" else None
    requirements = locked_requirements(target_id)
    safe_directory(target)
    marker = target / MARKER
    expected = {"schema_version": "1.0", "package": PACKAGE, "installer": "isma-isolated-python", "target": target_id}
    if target.exists() and any(target.iterdir()):
        try:
            if marker.is_symlink() or json.loads(marker.read_text()) != expected:
                raise InstallError("INSTALL_RUNTIME_UNSAFE")
        except (OSError, ValueError):
            raise InstallError("INSTALL_RUNTIME_UNSAFE") from None
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    safe_directory(target)
    if not marker.exists():
        with marker.open("x") as output:
            os.chmod(marker, 0o600)
            json.dump(expected, output)
    # Reuse only our marked partial environment on an explicitly requested retry.
    (builder or venv.EnvBuilder(with_pip=True, symlinks=True)).create(target)
    python = target / ("Scripts/python.exe" if os.name == "nt" else "bin/python3")
    snow = target / ("Scripts/snow.exe" if os.name == "nt" else "bin/snow")
    if python.is_symlink():
        # Standard venv Python symlinks are allowed only inside our checked venv.
        if not python.resolve().is_file():
            raise InstallError("INSTALL_RUNTIME_UNSAFE")
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PIP_CONFIG_FILE=os.devnull,
                       SNOWFLAKE_CLI_LOGS_SAVE_LOGS="")
    for key in list(environment):
        if key.startswith("PIP_") and key != "PIP_CONFIG_FILE":
            del environment[key]
    run_checked([str(python), "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check",
                 "install", "--quiet", "--no-input", "--no-cache-dir", "--only-binary=:all:",
                 "--index-url", "https://pypi.org/simple", "--require-hashes", "-r", str(requirements)],
                runner=runner, environment=environment)
    if not snow.is_file() or not os.access(snow, os.X_OK):
        raise InstallError("INSTALL_VERIFICATION_FAILED")
    # No customer connection or authentication is needed for these local checks.
    with tempfile.TemporaryDirectory(prefix=".verify-", dir=target) as probe:
        verification_env = dict(environment, SNOWFLAKE_HOME=probe)
        run_checked([str(python), "-I", "-B", "-c", "import tomllib, snowflake.cli, snowflake.connector"],
                    runner=runner, environment=verification_env)
        result = run_checked([str(snow), "--version"], runner=runner, environment=verification_env)
        if "Snowflake CLI version:" not in result.stdout or PACKAGE.split("==")[1] not in result.stdout:
            raise InstallError("INSTALL_VERIFICATION_FAILED")
    return {"status": "installed_verified", "source_access_verified": False, "configuration_changed": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-directory", required=True)
    parser.add_argument("--target", required=True, choices=("darwin-arm64", "darwin-x64"))
    args = parser.parse_args()
    try:
        print(json.dumps(install(Path(args.runtime_directory), target_id=args.target)))
        return 0
    except InstallError as error:
        print(json.dumps({"status": "failed", "code": str(error)}))
    except PermissionError:
        print(json.dumps({"status": "failed", "code": "INSTALL_PERMISSION_DENIED"}))
    except Exception:
        print(json.dumps({"status": "failed", "code": "INSTALL_VERIFICATION_FAILED"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

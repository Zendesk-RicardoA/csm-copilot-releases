import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {runtimeSpec, runtimeSpecDigest} from './snowflake-managed-runtime.mjs';

export const SNOWFLAKE_INSTALL_VERSION = '3.24.1';
const BOOTSTRAP = fileURLToPath(new URL('./snowflake-runtime-bootstrap.mjs', import.meta.url));

export function snowflakeInstallationRecipe({home = os.homedir(), platform = process.platform, arch = process.arch} = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) return null;
  const spec = runtimeSpec();
  return {kind: 'managed_python', executable: process.execPath,
    args: [BOOTSTRAP, '--home', home, '--arch', arch],
    package: 'snowflake-cli==' + spec.snowflake_version,
    python_version: spec.python_version, recipe_digest: runtimeSpecDigest(),
    components: ['Python ' + spec.python_version, 'Snowflake CLI ' + spec.snowflake_version]};
}

export function installationFailureCode(output, fallback) {
  const allowed = new Set(['INSTALL_NETWORK_FAILED', 'INSTALL_PERMISSION_DENIED', 'INSTALL_POLICY_BLOCKED',
    'INSTALL_VERIFICATION_FAILED', 'INSTALL_RUNTIME_UNSAFE', 'INSTALLATION_TIMEOUT',
    'INSTALL_DOWNLOAD_INTEGRITY_FAILED', 'INSTALL_DISK_SPACE_LOW', 'INSTALL_UNSUPPORTED_PLATFORM',
    'INSTALL_ALREADY_RUNNING', 'INSTALL_RECIPE_INVALID']);
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try { const value = JSON.parse(line); if (allowed.has(value.code)) return value.code; } catch {}
  }
  return fallback;
}

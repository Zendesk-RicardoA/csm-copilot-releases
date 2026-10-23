import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { BetaError } from "./core.mjs";
import {resolveSnowflakeConfigPath, snowflakeEnvironment} from './snowflake-runtime.mjs';

const PROBE_SQL = "SELECT CURRENT_USER() AS CURRENT_USER, CURRENT_ROLE() AS CURRENT_ROLE, CURRENT_WAREHOUSE() AS CURRENT_WAREHOUSE";

function rowsFromSnowOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (_error) {
    throw new BetaError("SNOWFLAKE_PROBE_FAILED", "Snowflake returned an unreadable connection response.");
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.data)) return parsed.data;
  if (Array.isArray(parsed?.rows)) return parsed.rows;
  throw new BetaError("SNOWFLAKE_PROBE_FAILED", "Snowflake did not return a probe row.");
}

export function parseSnowflakeProbe(stdout, { connectionName, approvedReadOnlyRoles }) {
  const row = rowsFromSnowOutput(stdout)[0] || {};
  const user = row.CURRENT_USER ?? row.current_user;
  const role = row.CURRENT_ROLE ?? row.current_role;
  const warehouse = row.CURRENT_WAREHOUSE ?? row.current_warehouse;
  if (![user, role, warehouse].every((value) => typeof value === "string" && value.trim())) {
    throw new BetaError("SNOWFLAKE_PROBE_FAILED", "Snowflake identity, role, or warehouse was unavailable.");
  }
  const readOnly = (approvedReadOnlyRoles || []).map((item) => item.toUpperCase()).includes(role.toUpperCase());
  const subject = crypto.createHash("sha256").update(`${connectionName}:${user}`).digest("hex");
  return {
    identity: {
      state: "connected",
      provider: "snowflake_zdp_sso",
      subject,
      verified: true,
    },
    snowflake: {
      state: "connected",
      connection_name: connectionName,
      read_only_verified: readOnly,
      role_ref: `role_${crypto.createHash("sha256").update(role).digest("hex").slice(0, 12)}`,
      warehouse_ref: `warehouse_${crypto.createHash("sha256").update(warehouse).digest("hex").slice(0, 12)}`,
    },
  };
}

export function probeSnowflakeZdp({
  connectionName = "zdp-global",
  approvedReadOnlyRoles = [],
  runner = spawnSync,
  configFactory = createTemporarySnowflakeConfig,
}) {
  const temporary = configFactory();
  let connectionTest;
  let result;
  try {
    // `snow sql` can report a failed session without opening the identity
    // provider. Test the named connection first so external-browser SSO is
    // launched when it is needed, then probe only the minimum identity fields.
    connectionTest = runner(
      "snow",
      ["--config-file", temporary.configPath, "connection", "test", "-c", connectionName],
      { encoding: "utf8", timeout: 120000, env: temporary.env },
    );
    if (connectionTest.error || connectionTest.status !== 0) {
      throwLocalProbeFailure(connectionTest, 'connection_test');
    }
    result = runner(
      "snow",
      ["--config-file", temporary.configPath, "sql", "-c", connectionName, "-q", PROBE_SQL, "--format", "json"],
      { encoding: "utf8", timeout: 120000, env: temporary.env },
    );
  } finally {
    temporary.cleanup();
  }
  if (result.error || result.status !== 0) {
    throwLocalProbeFailure(result, 'identity_probe');
  }
  return parseSnowflakeProbe(result.stdout, { connectionName, approvedReadOnlyRoles });
}

export const SNOWFLAKE_PROBE_SQL = PROBE_SQL;

function throwLocalProbeFailure(result, stage) {
  if (result.error?.code === 'ENOENT') throw new BetaError('SNOWFLAKE_CLI_NOT_INSTALLED', 'The local Snowflake software is missing. Complete local setup before browser sign-in.', {failure_stage: 'cli_start'});
  if (['ETIMEDOUT', 'ETIME'].includes(result.error?.code) || result.signal === 'SIGTERM') throw new BetaError('SNOWFLAKE_CONNECTION_TIMEOUT', 'The Snowflake connection check reached its deadline. No customer query was started.', {failure_stage: stage});
  if (['EACCES', 'EPERM'].includes(result.error?.code)) throw new BetaError('SNOWFLAKE_CLI_BLOCKED', 'The local Snowflake software could not be started. Check the approved installation or ask IT; do not disable security protections.', {failure_stage: 'cli_start'});
  // Provider messages stay transient and never cross the diagnostic boundary.
  // Only an explicit authentication failure merits another sign-in prompt.
  const provider = (String(result.stderr || '') + '\n' + String(result.stdout || '')).slice(0, 16000);
  const details = {failure_stage: stage, exit_code: Number.isInteger(result.status) ? result.status : null};
  if (/42501|insufficient privileges|not authori[sz]ed|role[^\n]*not granted/i.test(provider)) throw new BetaError('SNOWFLAKE_ACCESS_NOT_VERIFIED', 'Snowflake did not verify the required access. Ask the owner or ZDP support to check the existing approved role; do not broaden permissions.', details);
  if (/390100|390112|390114|authentication[^\n]*(fail|expired|required)|SSO[^\n]*(fail|expired|required)|sign.?in[^\n]*(fail|expired|required)/i.test(provider)) throw new BetaError('SNOWFLAKE_SIGN_IN_REQUIRED', 'Complete normal company browser sign-in, then retry the native connection check.', details);
  throw new BetaError('SNOWFLAKE_CONNECTION_FAILED', 'The Snowflake connection check failed before access could be verified. Report this connection stage; repeating sign-in is not a verified repair.', details);
}

export function snowflakeReadEnvironment(environment = process.env) {
  // Keep the established CLI config path intact: it is where the user has
  // already authenticated the named SSO connection. This CLI's legacy logging
  // loader treats a non-empty "false" environment value as truthy. An empty
  // override disables file logs for this read only when the existing config
  // exposes the standard [cli.logs] section; no config copy is used.
  return snowflakeEnvironment(environment);
}

export function createTemporarySnowflakeConfig() {
  const sourceConfig = resolveSnowflakeConfigPath();
  if (!fs.existsSync(sourceConfig)) {
    throw new BetaError("SNOWFLAKE_CONNECTION_NOT_CONFIGURED", "The existing Snowflake connection configuration was not found.");
  }
  return {
    env: snowflakeReadEnvironment(),
    configPath: sourceConfig,
    cleanup: () => {},
  };
}

export function writeCredentialState(filePath, patch, existing = {}) {
  const next = {
    ...existing,
    ...patch,
    identity: patch.identity || existing.identity,
    snowflake: patch.snowflake || existing.snowflake,
    google: patch.google || existing.google,
    manual_renderer: patch.manual_renderer || existing.manual_renderer,
    renderer_mode: patch.renderer_mode || existing.renderer_mode,
    tester_register: existing.tester_register || { state: "not_configured", blocking: false },
    updated_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return next;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {BetaError} from './core.mjs';
import {resolveSnowflakeCommand, resolveSnowflakeConfigPath, resolveSnowflakePython, snowflakeEnvironment} from './snowflake-runtime.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snowflake-setup-worker.py');
const action = (code, title, instruction, extra = {}) => ({code, title, instruction, ...extra});

function display(state, prerequisites, code = null, changed = false) {
  let next;
  if (state === 'cli_missing') next = action('INSTALL_SNOWFLAKE_CLI', 'Install the local Snowflake software', "Ask permission to install ISMA's private Python and Snowflake CLI components. The fixed installer downloads checksum-pinned packages for this Mac, verifies them, and preserves existing connection settings. No Homebrew or preinstalled Python is required.", {
    host_install_request: {tool: 'beta_install_setup_dependency', dependency_id: 'snowflake', components: ['ISMA Python runtime', 'Snowflake CLI'], authorization_required: true, executes_automatically: false},
  });
  else if (state === 'runtime_unsupported') next = action('REPAIR_SNOWFLAKE_RUNTIME', 'Use the supported Snowflake runtime', "The installed Snowflake software does not expose the required Python environment. With approval, install a separate verified ISMA runtime. Preserve existing software and connection settings; no source permissions need changing.", {host_install_request: {tool: 'beta_install_setup_dependency', dependency_id: 'snowflake', components: ['ISMA Python runtime', 'Snowflake CLI'], authorization_required: true, executes_automatically: false}});
  else if (['configuration_missing', 'connection_missing'].includes(state)) next = action('CONFIGURE_SNOWFLAKE_ZDP', 'Set up your own Snowflake connection', 'Ask permission for the bounded local configuration step. It uses the owner-supplied connection template and the named handoff login hint, never shared credentials. It does not sign in or verify identity.');
  else if (state === 'configured') next = action('CONNECT_SNOWFLAKE_ZDP', 'Sign in to Snowflake with your company account', 'Run the native connection check and complete company browser sign-in. A local profile is not proof of identity, source access or an approved read-only role.');
  else next = action('REVIEW_SNOWFLAKE_CONFIGURATION', 'Review the local Snowflake setup', ['SETUP_TEMPLATE_MISSING', 'SETUP_TEMPLATE_INVALID', 'LOGIN_HINT_MISSING', 'PACKAGE_MISMATCH'].includes(code)
    ? 'The named handoff is missing its owner-supplied setup information. Ask the beta owner to repair the handoff; do not guess account settings or type credentials into chat.'
    : 'The existing local configuration could not be safely used. Preserve it and report this setup step to the beta owner. Do not overwrite it or repeat browser sign-in to fix a local setup problem.');
  return {state, status: 'action_required', prerequisites, next_action: next, ...(code ? {failure_code: code} : {}), configuration_changed: changed,
    identity_verified: false, source_access_verified: false, customer_data_read: false};
}

function runLocalWorker(options, configure) {
  const python = resolveSnowflakePython(options);
  const args = ['-B', WORKER, '--check-runtime', '--config-path', resolveSnowflakeConfigPath(options), '--connection-name', options.connectionName || 'zdp-global'];
  if (configure) args.push('--configure', '--template-path', options.templatePath, '--descriptor-path', options.descriptorPath,
    '--package-version', options.packageVersion, '--approved-roles', JSON.stringify(options.approvedReadOnlyRoles || []));
  const result = (options.runner || spawnSync)(python, args, {encoding: 'utf8', timeout: 10000, maxBuffer: 65536, shell: false,
    env: {...snowflakeEnvironment(options.environment || process.env, options), PYTHONDONTWRITEBYTECODE: '1'}});
  try {
    const parsed = JSON.parse(result.stdout);
    if (!result.error && ['configured', 'configuration_missing', 'configuration_incomplete', 'connection_missing', 'runtime_unsupported', 'blocked'].includes(parsed.state)) return parsed;
  } catch {}
  return {state: 'blocked', code: 'LOCAL_SETUP_CHECK_FAILED'};
}

export function inspectSnowflakeSetup(options = {}) {
  const configPath = resolveSnowflakeConfigPath(options);
  const prerequisites = {cli: resolveSnowflakeCommand(options) ? 'available' : 'missing', configuration: fs.existsSync(configPath) ? 'present' : 'missing', connection: 'not_checked'};
  if (prerequisites.cli === 'missing') return display('cli_missing', prerequisites);
  let result;
  try { result = runLocalWorker(options, false); }
  catch (error) { return error.code === 'SNOWFLAKE_RUNTIME_UNSUPPORTED' ? display('runtime_unsupported', prerequisites, error.code) : display('blocked', prerequisites, 'LOCAL_SETUP_CHECK_FAILED'); }
  prerequisites.connection = result.state === 'configured' ? 'present' : result.state === 'connection_missing' ? 'missing' : 'not_checked';
  return display(result.state, prerequisites, result.code);
}

export function configureSnowflakeSetup(options = {}) {
  if (options.configurationAuthorized !== true) throw new BetaError('SNOWFLAKE_LOCAL_SETUP_APPROVAL_REQUIRED', 'Explicit approval is required before creating a local Snowflake connection. No software or configuration was changed.');
  const prerequisites = {cli: resolveSnowflakeCommand(options) ? 'available' : 'missing', configuration: 'not_checked', connection: 'not_checked'};
  if (prerequisites.cli === 'missing') return display('cli_missing', prerequisites);
  if (![options.templatePath, options.descriptorPath, options.packageVersion].every(value => typeof value === 'string' && value)) return display('blocked', prerequisites, 'SETUP_TEMPLATE_MISSING');
  let result;
  try { result = runLocalWorker(options, true); }
  catch (error) { return error.code === 'SNOWFLAKE_RUNTIME_UNSUPPORTED' ? display('runtime_unsupported', prerequisites, error.code) : display('blocked', prerequisites, 'LOCAL_SETUP_CHECK_FAILED'); }
  return display(result.state, {...prerequisites, configuration: result.state === 'configured' ? 'present' : 'not_checked', connection: result.state === 'configured' ? 'present' : 'not_checked'}, result.code, result.changed === true);
}

export function applySnowflakeSetupStatus(result, local) {
  if (!local || local.state === 'configured') return {...result, ...(local ? {snowflake_prerequisites: local.prerequisites} : {})};
  return {...result, status: 'action_required', checks: {...result.checks, snowflake_zdp: 'setup_required'}, next_action: local.next_action, snowflake_prerequisites: local.prerequisites};
}

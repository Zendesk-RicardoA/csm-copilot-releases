import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { BetaError } from './core.mjs';
import { inspectSnowflakeSetup } from './snowflake-onboarding.mjs';

export const DEPENDENCIES = Object.freeze(JSON.parse(fs.readFileSync(new URL('../config/setup-dependencies.json', import.meta.url), 'utf8')).dependencies);
const WORKFLOWS = new Set(['all', ...DEPENDENCIES.flatMap(item => item.workflows)]);
const IDS = new Set(DEPENDENCIES.map(item => item.id));
const STATES = new Set(['verified', 'not_checked', 'sign_in_needed', 'blocked']);
function observationsById(observations) {
  if (!Array.isArray(observations) || observations.length > DEPENDENCIES.length) throw new BetaError('INVALID_DEPENDENCY_OBSERVATION', 'Use one bounded status per known dependency.');
  const result = new Map();
  for (const item of observations) {
    if (!item || Object.keys(item).some(key => !['dependency_id', 'installed', 'tools_available', 'connection_state', 'evidence_source'].includes(key))
      || !IDS.has(item.dependency_id) || result.has(item.dependency_id)
      || [item.installed, item.tools_available].some(value => value !== undefined && typeof value !== 'boolean')
      || !STATES.has(item.connection_state || 'not_checked') || !['host_inventory', 'native_probe'].includes(item.evidence_source)
      || (item.connection_state === 'verified' && (item.evidence_source !== 'native_probe' || item.tools_available !== true))) {
      throw new BetaError('INVALID_DEPENDENCY_OBSERVATION', 'Report only installation, tool availability and actual connection-check states. No account details or credentials are accepted.');
    }
    result.set(item.dependency_id, item);
  }
  return result;
}

function installationRequest(item) {
  if (item.installation === 'approved_homebrew') return { kind: 'native_installation', tool: 'beta_install_setup_dependency', dependency_id: item.id, authorization_required: true };
  if (item.installation === 'codex_marketplace') return { kind: 'native_installation', tool: 'beta_install_setup_dependency', dependency_id: item.id, authorization_required: true };
  if (item.installation === 'host_plugin') return { kind: 'host_plugin', plugin_query: item.plugin_query,
    instruction: 'Resolve this exact provider in Plugin Management, use its supported install/connect action, then refresh this same checklist. Preserve the existing approval; do not claim installation before the host confirms it.' };
  if (item.installation === 'company_connection') return { kind: 'company_connection', dependency_id: item.id,
    instruction: 'Use the company-approved connection setup for this named MCP. Each user signs in independently. If the host cannot expose the install/connect action, show that exact missing step and the owner/IT route; do not invent an endpoint, copy credentials or repeat an unavailable action.' };
  return { kind: 'private_setup', dependency_id: item.id };
}

export function buildDependencyChecklist({ workflow = 'all', observations = [], snowflake = null } = {}) {
  if (!WORKFLOWS.has(workflow)) throw new BetaError('INVALID_SETUP_WORKFLOW', 'Choose one supported workflow or all dependencies.');
  const observed = observationsById(observations);
  const rows = DEPENDENCIES.map(item => {
    const needed = workflow === 'all' || item.workflows.includes(workflow);
    const evidence = observed.get(item.id);
    let state = 'check_required', next_action = null;
    if (item.id === 'snowflake' && snowflake) {
      state = snowflake.prerequisites?.cli === 'missing' ? 'missing'
        : ['runtime_unsupported', 'blocked'].includes(snowflake.state) ? 'blocked' : 'installed_not_checked';
      next_action = snowflake.next_action || null;
      if (evidence?.connection_state === 'verified' && state === 'installed_not_checked') { state = 'ready'; next_action = null; }
      else if (evidence?.connection_state === 'sign_in_needed') state = 'sign_in_needed';
    } else if (evidence) {
      state = evidence.connection_state === 'blocked' ? 'blocked'
        : evidence.connection_state === 'sign_in_needed' ? 'sign_in_needed'
        : evidence.connection_state === 'verified' ? 'ready'
        : evidence.installed === true || evidence.tools_available === true ? 'installed_not_checked'
        : evidence.installed === false || evidence.tools_available === false ? 'missing' : 'check_required';
    }
    const observed_state = state;
    if (!needed) state = 'not_needed';
    else if (!item.required && state !== 'ready') state = 'optional';
    return { dependency_id: item.id, title: item.title, kind: item.kind,
      required: needed && item.required, state, observed_state,
      installed: evidence?.installed ?? (item.id === 'snowflake' && snowflake ? snowflake.prerequisites?.cli === 'available' : null),
      connection_checked: evidence?.connection_state === 'verified',
      next_action: needed ? next_action || (observed_state === 'ready' ? null
        : ['installed_not_checked', 'sign_in_needed'].includes(observed_state)
          ? { kind: 'connection_check', dependency_id: item.id,
            instruction: observed_state === 'sign_in_needed' ? 'Complete this provider\'s own sign-in, then resume the same checklist. Do not reinstall an installed component.'
              : 'Use a harmless native connection/profile check for this installed provider. Tool discovery alone is not verified access. Do not reinstall it.' }
          : installationRequest(item)) : null };
  });
  return { product_name: 'ISMA', workflow, rows,
    inspection_requests: rows.filter(row => row.state === 'check_required' || (row.state === 'optional' && row.observed_state === 'check_required'))
      .map(row => ({ dependency_id: row.dependency_id, kind: row.kind, source: 'host_inventory' })),
    ready_for_workflow: rows.filter(row => row.required).every(row => row.state === 'ready'),
    source_permissions_granted: false, customer_data_read: false,
    instruction: 'Installation is separate from sign-in and source access. Use actual host inventory and harmless connection probes; never infer ready from a package name. Keep optional or unrelated tools from blocking ready workflows.' };
}

function findExecutable(name, extra = []) {
  for (const directory of [...extra, ...(process.env.PATH || '').split(path.delimiter)]) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

// Only fixed installation recipes execute. Caller-provided commands, URLs,
// arguments, credentials and permission changes never enter this boundary.
export class SetupDependencyInstallations {
  constructor({ directory, packageVersion, inspect = inspectSnowflakeSetup, inspectPlugin = null, spawnProcess = spawn, resolveExecutable = findExecutable, clock = Date.now } = {}) {
    this.directory = directory; this.packageVersion = packageVersion; this.inspect = inspect;
    this.spawnProcess = spawnProcess; this.resolveExecutable = resolveExecutable; this.clock = clock; this.jobs = new Map();
    this.inspectPlugin = inspectPlugin || ((reference, executable) => {
      try { const result = spawnSync(executable, ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
        return result.status === 0 && JSON.parse(result.stdout).installed?.some(item => item.pluginId === reference && item.installed === true && item.enabled === true) === true; } catch { return false; }
    });
  }
  start({ dependencyId, installationAuthorized = false, retryFailed = false }) {
    if (typeof installationAuthorized !== 'boolean' || typeof retryFailed !== 'boolean') throw new BetaError('INVALID_INPUT', 'Installation approval and retry must be explicit boolean decisions.');
    const item = DEPENDENCIES.find(value => value.id === dependencyId);
    if (!item) throw new BetaError('UNKNOWN_SETUP_DEPENDENCY', 'Choose a dependency from the current checklist.');
    if (!['approved_homebrew', 'codex_marketplace'].includes(item.installation)) return { status: 'host_action_required', dependency_id: dependencyId,
      installation_performed: false, next_action: installationRequest(item) };
    const local = dependencyId === 'snowflake' ? this.inspect() : null;
    if (local?.prerequisites?.cli === 'available') return {
      status: local.state === 'runtime_unsupported' ? 'blocked' : 'installed_verified', dependency_id: dependencyId,
      ...(local.state === 'runtime_unsupported' ? { code: 'SNOWFLAKE_RUNTIME_UNSUPPORTED' } : {}),
      installation_performed: false, source_access_verified: false, next_action: local.next_action };
    const executable = item.installation === 'approved_homebrew'
      ? this.resolveExecutable('brew', ['/opt/homebrew/bin', '/usr/local/bin'])
      : this.resolveExecutable('codex', ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin', '/Applications/Codex.app/Contents/Resources']);
    if (!executable) return { status: 'blocked', dependency_id: dependencyId, code: 'APPROVED_INSTALLER_MISSING',
      next_action: 'The approved installer is missing. Use the company software portal or ask IT for this dependency; no package manager or security setting was changed.' };
    if (item.installation === 'codex_marketplace' && this.inspectPlugin(item.plugin_reference, executable)) return {
      status: 'installed_verified', dependency_id: dependencyId, installation_performed: false, source_access_verified: false,
      next_action: 'The plugin is installed and enabled. Check its own connection before claiming source access.' };
    const args = item.installation === 'approved_homebrew' ? ['install', 'snowflake-cli'] : ['plugin', 'add', item.plugin_reference];
    const scope = crypto.createHash('sha256').update(JSON.stringify({ packageVersion: this.packageVersion, dependencyId, executable, args })).digest('hex');
    const file = path.join(this.directory, `${dependencyId}.json`);
    let previous = null;
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new BetaError('UNSAFE_SETUP_STATE', 'The installation receipt must be a private regular file.');
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    if (previous?.scope_digest === scope) {
      if (this.jobs.get(previous.install_ref)?.state === 'running') return this.read(previous.install_ref);
      if (previous.state === 'running') return { status: 'needs_reconciliation', dependency_id: dependencyId,
        next_action: 'An earlier installation may still be running. Check its result before another installation; do not repeat the approval or launch a duplicate.' };
      if (!retryFailed && !installationAuthorized) return { ...previous, status: previous.state === 'installed_verified' ? 'verification_required' : previous.state, installation_performed: false,
        next_action: 'The previous installation finished with this result. Verify the dependency or explicitly retry this same failed installation; do not restart setup or repeat its permission request.' };
    }
    const approvalReused = previous?.scope_digest === scope && previous.installation_authorized === true;
    if (!installationAuthorized && !approvalReused) throw new BetaError('SOFTWARE_INSTALLATION_APPROVAL_REQUIRED', 'Approve installation of this named component before software changes.');
    const job = { install_ref: crypto.randomUUID(), dependency_id: dependencyId, state: 'running', scope_digest: scope,
      installation_authorized: true, approval_reused: approvalReused, started_at: new Date(this.clock()).toISOString(),
      phase: 'installing', attempts: approvalReused ? (previous.attempts || 1) + 1 : 1 };
    this.jobs.set(job.install_ref, job); this.save(file, job);
    let process;
    try { process = this.spawnProcess(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      env: { ...globalThis.process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', NONINTERACTIVE: '1' } }); }
    catch { job.state = 'failed'; job.code = 'INSTALL_START_FAILED'; this.save(file, job); return this.read(job.install_ref); }
    let output = '';
    const collect = data => { output = (output + String(data)).slice(-16000); };
    process.stdout?.on('data', collect); process.stderr?.on('data', collect);
    const timeout = setTimeout(() => { job.timed_out = true; process.kill('SIGTERM'); }, 300000); timeout.unref?.();
    let finished = false;
    const finish = (exitCode, failed = false) => {
      if (finished) return; finished = true; clearTimeout(timeout);
      const verification = dependencyId === 'snowflake' ? this.inspect() : null;
      const verified = dependencyId === 'snowflake' ? verification?.prerequisites?.cli === 'available' && verification.state !== 'runtime_unsupported'
        : this.inspectPlugin(item.plugin_reference, executable);
      job.state = !failed && exitCode === 0 && verified ? 'installed_verified'
        : !failed && exitCode === 0 && verification?.state === 'runtime_unsupported' ? 'blocked' : 'failed';
      if (job.state === 'blocked') job.code = 'SNOWFLAKE_RUNTIME_UNSUPPORTED';
      if (job.state === 'failed') job.code = job.timed_out ? 'INSTALLATION_TIMEOUT'
        : /permission denied|operation not permitted|EACCES/i.test(output) ? 'INSTALL_PERMISSION_DENIED'
        : /network|could not resolve|connection refused|failed to download/i.test(output) ? 'INSTALL_NETWORK_FAILED'
        : /not allowed|blocked|policy|administrator/i.test(output) ? 'INSTALL_POLICY_BLOCKED'
        : 'INSTALL_VERIFICATION_FAILED';
      job.phase = 'finished'; job.finished_at = new Date(this.clock()).toISOString();
      job.source_access_verified = false; job.next_action = verification?.next_action || null;
      output = ''; this.save(file, job);
    };
    process.on('error', () => finish(null, true)); process.on('close', code => finish(code));
    return this.read(job.install_ref);
  }
  save(file, job) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 }); fs.chmodSync(file, 0o600);
  }
  read(ref) {
    const job = this.jobs.get(ref);
    if (!job) throw new BetaError('SETUP_INSTALLATION_NOT_IN_MEMORY', 'Read the dependency checklist after restart. A receipt alone cannot relaunch an uncertain installation.');
    return { ...job, status: job.state, source_access_verified: false,
      continuation_request: job.state === 'running' ? { tool: 'beta_continue_setup_installation', arguments: { install_ref: ref } } : null,
      next_action: job.state === 'running' ? 'Give a progress update roughly every 20 seconds and continue this same installation. Do not ask for its approval again or start another job.' : job.next_action || 'Refresh the same dependency checklist and show the result; installation is not proof of sign-in or source access.' };
  }
}

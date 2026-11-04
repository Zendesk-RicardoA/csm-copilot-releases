import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { buildDependencyChecklist, SetupDependencyInstallations } from '../mcp/setup-dependencies.mjs';

const missing = { state: 'cli_missing', prerequisites: { cli: 'missing' } };
const installed = { state: 'configuration_missing', prerequisites: { cli: 'available' }, next_action: { code: 'CONFIGURE_SNOWFLAKE_ZDP' } };
const configurationBlocked = { state: 'blocked', prerequisites: { cli: 'available' }, next_action: { code: 'REVIEW_SNOWFLAKE_CONFIGURATION' } };
const runtimeUnsupported = { state: 'runtime_unsupported', prerequisites: { cli: 'available' }, next_action: { code: 'REPAIR_SNOWFLAKE_RUNTIME' } };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isma-invented-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let local = missing;
  const calls = [], children = [];
  const spawnProcess = (command, args, settings) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    calls.push({ command, args, settings }); children.push(child); return child;
  };
  const args = { directory, packageVersion: '0.0.0-invented', platform: 'darwin', arch: 'arm64', inspect: () => local,
    spawnProcess, resolveExecutable: name => '/invented/bin/' + name, ...options };
  return { jobs: new SetupDependencyInstallations(args), args, calls, children, directory, setLocal: value => { local = value; } };
}

test('the checklist distinguishes installation, source sign-in, blocked and optional components', () => {
  const result = buildDependencyChecklist({ workflow: 'outreach', snowflake: installed, observations: [
    { dependency_id: 'gmail', installed: true, tools_available: true, connection_state: 'sign_in_needed', evidence_source: 'native_probe' },
    { dependency_id: 'drive', installed: false, tools_available: false, connection_state: 'blocked', evidence_source: 'host_inventory' },
  ] });
  assert.equal(result.rows.find(row => row.dependency_id === 'snowflake').state, 'installed_not_checked');
  assert.equal(result.rows.find(row => row.dependency_id === 'gmail').state, 'sign_in_needed');
  assert.equal(result.rows.find(row => row.dependency_id === 'drive').state, 'blocked');
  assert.equal(result.rows.find(row => row.dependency_id === 'cerebro').state, 'not_needed');
  assert.equal(result.source_permissions_granted, false); assert.equal(result.customer_data_read, false);
  assert.equal(result.ready_for_workflow, false);
  const all = buildDependencyChecklist();
  assert.equal(all.rows.find(row => row.dependency_id === 'cerebro').state, 'optional');
});

test('inventory alone cannot claim authenticated readiness and accepts no private source content', () => {
  for (const change of [{ connection_state: 'verified', evidence_source: 'host_inventory', tools_available: true },
    { email: 'invented@example.invalid' }, { dependency_id: 'unknown' }]) {
    assert.throws(() => buildDependencyChecklist({ observations: [{ dependency_id: 'gmail', installed: true,
      connection_state: 'not_checked', evidence_source: 'host_inventory', ...change }] }), { code: 'INVALID_DEPENDENCY_OBSERVATION' });
  }
});

test('missing software executes only the fixed approved recipe and reuses the running job', t => {
  const f = fixture(t);
  assert.throws(() => f.jobs.start({ dependencyId: 'snowflake' }), { code: 'SOFTWARE_INSTALLATION_APPROVAL_REQUIRED' });
  assert.throws(() => f.jobs.start({ dependencyId: 'snowflake', installationAuthorized: 'true' }), { code: 'INVALID_INPUT' });
  assert.equal(f.calls.length, 0);
  const first = f.jobs.start({ dependencyId: 'snowflake', installationAuthorized: true });
  const repeated = f.jobs.start({ dependencyId: 'snowflake' });
  assert.equal(repeated.install_ref, first.install_ref); assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].args[0], /snowflake-runtime-bootstrap\.mjs$/);
  assert.equal(f.calls[0].command, process.execPath);
  assert.equal(f.calls[0].settings.shell, false);
  f.setLocal(installed); f.children[0].emit('close', 0);
  const completed = f.jobs.read(first.install_ref);
  assert.equal(completed.status, 'installed_verified'); assert.equal(completed.source_access_verified, false);
  assert.equal(completed.continuation_request, null);
  assert.equal(fs.statSync(path.join(f.directory, 'snowflake.json')).mode & 0o777, 0o600);
});

test('an existing supported installation needs neither approval nor another software command', t => {
  const f = fixture(t); f.setLocal(installed);
  const result = f.jobs.start({ dependencyId: 'snowflake' });
  assert.equal(result.status, 'installed_verified'); assert.equal(result.installation_performed, false);
  assert.equal(f.calls.length, 0);
});

test('an installed CLI is not reinstalled when its separate configuration check is blocked', t => {
  const f = fixture(t); f.setLocal(configurationBlocked);
  const result = f.jobs.start({ dependencyId: 'snowflake' });
  assert.equal(result.status, 'installed_verified');
  assert.equal(result.next_action.code, 'REVIEW_SNOWFLAKE_CONFIGURATION');
  assert.equal(result.installation_performed, false);
  assert.equal(f.calls.length, 0);
});

test('a shell launcher without supported Python needs approval for a separate repair', t => {
  const f = fixture(t); f.setLocal(runtimeUnsupported);
  assert.throws(() => f.jobs.start({dependencyId: 'snowflake'}), {code: 'SOFTWARE_INSTALLATION_APPROVAL_REQUIRED'});
  assert.equal(f.calls.length, 0);
  const result = f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true});
  assert.equal(result.status, 'running'); assert.equal(result.recipe, 'managed_python');
  f.setLocal(installed); f.children[0].emit('close', 0);
});

test('a completed CLI install is verified separately from a blocked configuration check', t => {
  const f = fixture(t); const first = f.jobs.start({ dependencyId: 'snowflake', installationAuthorized: true });
  f.setLocal(configurationBlocked); f.children[0].emit('close', 0);
  const result = f.jobs.read(first.install_ref);
  assert.equal(result.status, 'installed_verified');
  assert.equal(result.next_action.code, 'REVIEW_SNOWFLAKE_CONFIGURATION');
});

test('a completed install reports an unsupported runtime without a reinstall loop', t => {
  const f = fixture(t); const first = f.jobs.start({ dependencyId: 'snowflake', installationAuthorized: true });
  f.setLocal(runtimeUnsupported); f.children[0].emit('close', 0);
  const result = f.jobs.read(first.install_ref);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'SNOWFLAKE_RUNTIME_UNSUPPORTED');
  assert.equal(result.next_action.code, 'REPAIR_SNOWFLAKE_RUNTIME');
  assert.equal(f.jobs.start({ dependencyId: 'snowflake' }).installation_performed, false);
  assert.equal(f.calls.length, 1);
});

test('a failed install reports its cause and an explicit retry reuses the original exact approval', t => {
  const f = fixture(t), first = f.jobs.start({ dependencyId: 'snowflake', installationAuthorized: true });
  f.children[0].stderr.emit('data', 'failed to download: invented endpoint'); f.children[0].emit('close', 1);
  assert.equal(f.jobs.read(first.install_ref).code, 'INSTALL_NETWORK_FAILED');
  assert.equal(f.jobs.start({ dependencyId: 'snowflake' }).status, 'failed');
  assert.equal(f.calls.length, 1);
  const retry = f.jobs.start({ dependencyId: 'snowflake', retryFailed: true });
  assert.equal(retry.approval_reused, true); assert.equal(f.calls.length, 2);
  f.setLocal(installed); f.children[1].emit('close', 0);
  assert.equal(f.jobs.read(retry.install_ref).status, 'installed_verified');
  assert.doesNotMatch(fs.readFileSync(path.join(f.directory, 'snowflake.json'), 'utf8'), /invented endpoint|failed to download/);
});

test('restart or a changed installation recipe cannot silently relaunch a pending operation or inherit approval', t => {
  const f = fixture(t); f.jobs.start({ dependencyId: 'snowflake', installationAuthorized: true });
  const restart = new SetupDependencyInstallations(f.args);
  assert.equal(restart.start({ dependencyId: 'snowflake' }).status, 'needs_reconciliation');
  assert.equal(f.calls.length, 1);
  const changed = new SetupDependencyInstallations({ ...f.args, packageVersion: '0.0.1-invented' });
  assert.throws(() => changed.start({ dependencyId: 'snowflake' }), { code: 'SOFTWARE_INSTALLATION_APPROVAL_REQUIRED' });
  f.children[0].emit('close', 1);
});

test('missing approved installer or a host connection never triggers a package-manager or arbitrary-command installation', t => {
  const f = fixture(t, { resolveExecutable: () => null, platform: 'unsupported' });
  assert.equal(f.jobs.start({ dependencyId: 'snowflake', installationAuthorized: true }).code, 'INSTALL_UNSUPPORTED_PLATFORM');
  assert.equal(f.jobs.start({ dependencyId: 'gmail', installationAuthorized: true }).status, 'host_action_required');
  assert.equal(f.jobs.start({ dependencyId: 'converge', installationAuthorized: true }).status, 'host_action_required');
  assert.throws(() => f.jobs.start({ dependencyId: 'arbitrary' }), { code: 'UNKNOWN_SETUP_DEPENDENCY' });
  assert.equal(f.calls.length, 0);
});

test('Cerebro installation requires an actual installed-and-enabled readback after the Codex command', t => {
  let present = false;
  const f = fixture(t, { inspectPlugin: () => present });
  const result = f.jobs.start({ dependencyId: 'cerebro', installationAuthorized: true });
  assert.deepEqual(f.calls[0].args, ['plugin', 'add', 'cerebro@zendesk-claude-code-plugins']);
  f.children[0].emit('close', 0);
  assert.equal(f.jobs.read(result.install_ref).status, 'failed');
  const retry = f.jobs.start({ dependencyId: 'cerebro', retryFailed: true });
  present = true; f.children[1].emit('close', 0);
  assert.equal(f.jobs.read(retry.install_ref).status, 'installed_verified');
});

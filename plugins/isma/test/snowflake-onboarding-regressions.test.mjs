import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { probeSnowflakeZdp } from '../mcp/credential-bridges.mjs';

test('a missing CLI is not reported as a failed company sign-in', () => {
  assert.throws(() => probeSnowflakeZdp({
    configFactory: () => ({configPath: '/invented/config.toml', env: {}, cleanup() {}}),
    runner: () => ({error: Object.assign(new Error('not found'), {code: 'ENOENT'}), status: null}),
  }), error => error.code === 'SNOWFLAKE_CLI_NOT_INSTALLED' && error.details.failure_stage === 'cli_start');
});

test('a connection timeout is not reported as a request to sign in again', () => {
  assert.throws(() => probeSnowflakeZdp({
    configFactory: () => ({configPath: '/invented/config.toml', env: {}, cleanup() {}}),
    runner: () => ({error: Object.assign(new Error('deadline'), {code: 'ETIMEDOUT'}), status: null}),
  }), error => error.code === 'SNOWFLAKE_CONNECTION_TIMEOUT');
});

test('network and authorization failures keep distinct safe stages instead of sign-in loops', () => {
  for (const [stderr, expected] of [['Could not connect: ECONNREFUSED', 'SNOWFLAKE_CONNECTION_FAILED'],
    ['SQLSTATE 42501: insufficient privileges', 'SNOWFLAKE_ACCESS_NOT_VERIFIED']]) {
    assert.throws(() => probeSnowflakeZdp({configFactory: () => ({configPath: '/invented/config.toml', env: {}, cleanup() {}}),
      runner: () => ({status: 1, stderr})}), error => error.code === expected && error.details.failure_stage === 'connection_test'
        && !JSON.stringify(error.details).includes(stderr));
  }
});

async function setupModule() { return import('../mcp/snowflake-onboarding.mjs'); }
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-snowflake-onboarding-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const python = path.join(bin, 'python3'); fs.writeFileSync(python, '', {mode: 0o700});
  const snow = path.join(bin, 'snow'); fs.writeFileSync(snow, '#!' + python + '\n', {mode: 0o700});
  return {home, bin, snow, python, environment: {PATH: bin}, platform: 'linux', connectionName: 'zdp-global', approvedReadOnlyRoles: ['EXAMPLE_READ_ONLY']};
}

test('a clean machine receives one install action without SSO, downloads, or config writes', async t => {
  const {inspectSnowflakeSetup} = await setupModule(); const options = fixture(t);
  fs.unlinkSync(options.snow);
  const result = inspectSnowflakeSetup({...options, runner() {assert.fail('No process may start without the CLI');}});
  assert.equal(result.next_action.code, 'INSTALL_SNOWFLAKE_CLI');
  assert.equal(result.prerequisites.cli, 'missing');
  assert.equal(result.prerequisites.configuration, 'missing');
  assert.equal(fs.existsSync(path.join(options.home, '.snowflake')), false);
  assert.equal(JSON.stringify(result).includes(options.home), false);
});

test('installed software with no profile receives a configure action, not a sign-in loop', async t => {
  const {inspectSnowflakeSetup} = await setupModule(); const options = fixture(t);
  const result = inspectSnowflakeSetup({...options, runner() {return {status: 0, stdout: JSON.stringify({state: 'configuration_missing'})};}});
  assert.equal(result.next_action.code, 'CONFIGURE_SNOWFLAKE_ZDP');
  assert.equal(result.prerequisites.cli, 'available');
  assert.notEqual(result.state, 'connected');
});

test('profile presence is only ready for sign-in, never proof of verified access', async t => {
  const {inspectSnowflakeSetup} = await setupModule(); const options = fixture(t);
  const result = inspectSnowflakeSetup({...options, runner() {return {status: 0, stdout: JSON.stringify({state: 'configured'})};}});
  assert.equal(result.state, 'configured');
  assert.equal(result.next_action.code, 'CONNECT_SNOWFLAKE_ZDP');
  assert.equal(Object.hasOwn(result, 'identity'), false);
  assert.equal(Object.hasOwn(result, 'read_only_verified'), false);
});

test('local configuration needs explicit permission and does not install software', async t => {
  const {configureSnowflakeSetup} = await setupModule(); const options = fixture(t);
  assert.throws(() => configureSnowflakeSetup({...options, runner() {assert.fail('No subprocess before approval');}}),
    {code: 'SNOWFLAKE_LOCAL_SETUP_APPROVAL_REQUIRED'});
});

test('configuration passes only private file paths, not a caller-supplied identity or secret', async t => {
  const {configureSnowflakeSetup} = await setupModule(); const options = fixture(t);
  const templatePath = path.join(options.home, 'private', 'snowflake-setup-template.json');
  const descriptorPath = path.join(options.home, 'private', 'release-descriptor.json');
  const result = configureSnowflakeSetup({...options, templatePath, descriptorPath, packageVersion: '0.0.0-invented', configurationAuthorized: true,
    runner(command, args, execution) {
      assert.equal(command, options.python); assert.equal(args.includes('--configure'), true);
      assert.equal(args.includes(templatePath), true); assert.equal(args.includes(descriptorPath), true);
      assert.equal(execution.shell, false);
      return {status: 0, stdout: JSON.stringify({state: 'configured', changed: true})};
    }});
  assert.equal(result.configuration_changed, true);
  assert.equal(result.next_action.code, 'CONNECT_SNOWFLAKE_ZDP');
  assert.equal(Object.hasOwn(result, 'identity'), false);
});

test('unsafe or malformed configuration stays blocked without leaking its text', async t => {
  const {inspectSnowflakeSetup} = await setupModule(); const options = fixture(t);
  const result = inspectSnowflakeSetup({...options, runner() {
    return {status: 1, stdout: JSON.stringify({state: 'blocked', code: 'CONFIG_INVALID'}), stderr: 'invented-secret-do-not-display'};
  }});
  assert.equal(result.next_action.code, 'REVIEW_SNOWFLAKE_CONFIGURATION');
  assert.equal(JSON.stringify(result).includes('invented-secret'), false);
});

test('GUI processes can discover the same installed Homebrew CLI without editing PATH settings', async t => {
  const {resolveSnowflakeCommand} = await import('../mcp/snowflake-runtime.mjs');
  const options = fixture(t);
  const found = resolveSnowflakeCommand({...options, environment: {PATH: '/usr/bin:/bin'}, extraSearchDirectories: [options.bin]});
  assert.equal(found, options.snow);
});

test('a shell launcher is not run as Python or mistaken for damaged configuration', async t => {
  const {inspectSnowflakeSetup} = await setupModule(); const options = fixture(t);
  fs.writeFileSync(options.snow, '#!/bin/bash\n', {mode: 0o700});
  const result = inspectSnowflakeSetup({...options, runner() { assert.fail('A shell must never run the Python worker'); }});
  assert.equal(result.state, 'runtime_unsupported');
  assert.equal(result.failure_code, 'SNOWFLAKE_RUNTIME_UNSUPPORTED');
  assert.equal(result.next_action.code, 'REPAIR_SNOWFLAKE_RUNTIME');
  assert.equal(result.prerequisites.cli, 'available');
  assert.equal(result.configuration_changed, false);
});

test('an explicit runtime override cannot select a shell', async t => {
  const {resolveSnowflakePython} = await import('../mcp/snowflake-runtime.mjs'); const options = fixture(t);
  assert.throws(() => resolveSnowflakePython({...options,
    environment: {...options.environment, CSM_COPILOT_SNOWFLAKE_PYTHON: '/bin/bash'}}),
  {code: 'SNOWFLAKE_RUNTIME_UNSUPPORTED'});
});

test('a Homebrew shell launcher uses only its own formula Python environment', async t => {
  const {inspectSnowflakeSetup} = await setupModule(); const options = fixture(t);
  const {resolveSnowflakePython} = await import('../mcp/snowflake-runtime.mjs');
  const formula = path.join(options.home, 'homebrew', 'Cellar', 'snowflake-cli', '0.0.0-invented');
  const formulaBin = path.join(formula, 'bin'); const formulaPython = path.join(formula, 'libexec', 'bin', 'python3');
  fs.mkdirSync(formulaBin, {recursive: true}); fs.mkdirSync(path.dirname(formulaPython), {recursive: true});
  fs.writeFileSync(path.join(formulaBin, 'snow'), '#!/bin/bash\n', {mode: 0o700});
  fs.writeFileSync(formulaPython, '', {mode: 0o700});
  fs.unlinkSync(options.snow); fs.symlinkSync(path.join(formulaBin, 'snow'), options.snow);
  assert.equal(resolveSnowflakePython(options), fs.realpathSync(formulaPython));
  const result = inspectSnowflakeSetup({...options, runner(command) {
    assert.equal(command, fs.realpathSync(formulaPython));
    return {status: 0, stdout: JSON.stringify({state: 'configuration_missing'})};
  }});
  assert.equal(result.next_action.code, 'CONFIGURE_SNOWFLAKE_ZDP');
  assert.equal(result.prerequisites.cli, 'available');
});

test('existing system-specific macOS configuration is reused, not replaced by an empty profile', async t => {
  const {resolveSnowflakeConfigPath} = await import('../mcp/snowflake-runtime.mjs'); const options = fixture(t);
  const target = path.join(options.home, 'Library', 'Application Support', 'snowflake', 'config.toml');
  fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, '[connections.other]\n', {mode: 0o600});
  assert.equal(resolveSnowflakeConfigPath({...options, platform: 'darwin'}), target);
});

test('native setup controls are registered and cannot authenticate or mutate in invented mode', t => {
  const options = fixture(t);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixtureManifest = path.join(options.home, 'invented-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config/approved-version-manifest.json')));
  // Only the temporary, source-disabled invented fixture has this test lifetime.
  manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
  for (const relative of ['mcp/snowflake-runtime.mjs', 'mcp/snowflake-onboarding.mjs', 'mcp/setup-dependencies.mjs',
    'test/snowflake-onboarding-regressions.test.mjs', 'test/isma-dependency-installation.test.mjs']) {
    manifest.integrity.files[relative] = createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
  }
  fs.writeFileSync(fixtureManifest, JSON.stringify(manifest), {mode: 0o600});
  const requests = [
    ['tools/list', {}],
    ['tools/call', {name: 'beta_prepare_snowflake_setup', arguments: {}}],
    ['tools/call', {name: 'beta_configure_snowflake_zdp', arguments: {local_configuration_authorized: false}}],
    ['tools/call', {name: 'beta_configure_snowflake_zdp', arguments: {local_configuration_authorized: true}}],
    ['tools/call', {name: 'beta_connect_snowflake_zdp', arguments: {}}],
  ].map(([method, params], index) => ({jsonrpc: '2.0', id: index + 1, method, params}));
  const result = spawnSync(process.execPath, [path.join(root, 'mcp/server.mjs')], {cwd: root, encoding: 'utf8', timeout: 10000,
    input: requests.map(value => JSON.stringify(value)).join('\n') + '\n',
    env: {...process.env, PLUGIN_DATA: path.join(options.home, 'state'), CSM_COPILOT_BETA_STATE_NAMESPACE: 'csm-snowflake-invented',
      CSM_COPILOT_BETA_MANIFEST_PATH: fixtureManifest,
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(root, 'config/limited-beta-runtime.json')}});
  assert.equal(result.status, 0, 'Invented MCP transport must complete');
  const responses = new Map(result.stdout.trim().split('\n').map(line => {const value = JSON.parse(line); return [value.id, value];}));
  const names = responses.get(1).result.tools.map(value => value.name);
  assert.equal(names.includes('beta_prepare_snowflake_setup'), true);
  assert.equal(names.includes('beta_configure_snowflake_zdp'), true);
  const content = id => JSON.parse(responses.get(id).result.content[0].text);
  assert.equal(content(2).state, 'invented_only');
  assert.equal(content(2).local_prerequisites_checked, false);
  assert.equal(content(3).code, 'SNOWFLAKE_LOCAL_SETUP_APPROVAL_REQUIRED');
  assert.equal(content(4).code, 'SNOWFLAKE_LOCAL_SETUP_NOT_APPROVED');
  assert.equal(content(5).code, 'SNOWFLAKE_LOCAL_SETUP_NOT_APPROVED');
  assert.equal(fs.existsSync(path.join(options.home, '.snowflake')), false);
});

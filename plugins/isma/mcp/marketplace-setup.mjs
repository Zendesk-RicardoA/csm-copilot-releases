// Offline first-run setup for the Git marketplace. No connector or installer runs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BetaError, validatePackagePreflight} from './core.mjs';
import Native from './approved-native-contract.js';
import {assertInstallableReleaseDescriptor} from './release-compatibility.mjs';

export const MARKETPLACE_CONTROL_FILES = Object.freeze([
  'approved-version-manifest.json', 'limited-beta-runtime.json', 'feedback-form.json', 'snowflake-setup-template.json',
]);
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const same = (left, right) => Native.canonicalSourceJson(left) === Native.canonicalSourceJson(right);
const safeName = /^[a-z0-9][a-z0-9-]{0,63}$/;
const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const encode = value => JSON.stringify(value, null, 2) + '\n';
const fail = (code, message) => { throw new BetaError(code, message); };

function readFile(file, maximum = 2 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    fail('MARKETPLACE_SETUP_UNSAFE', 'A bounded regular setup file is required; symbolic links are not supported.');
  return fs.readFileSync(file, 'utf8');
}
function readJson(file) { return JSON.parse(readFile(file)); }

function locations(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || moduleRoot);
  const metadata = readJson(path.join(packageRoot, '.codex-plugin/plugin.json'));
  const servers = Object.values(readJson(path.join(packageRoot, '.mcp.json')).mcpServers || {});
  if (!safeName.test(metadata.name) || servers.length !== 1)
    fail('MARKETPLACE_SETUP_INVALID', 'Use the supported single-plugin marketplace package.');
  const namespace = servers[0].env?.CSM_COPILOT_BETA_STATE_NAMESPACE || metadata.name;
  if (!safeName.test(namespace)) fail('MARKETPLACE_SETUP_INVALID', 'The package has an invalid private-state namespace.');
  return {packageRoot, metadata, stateDirectory: path.resolve(options.stateDirectory || path.join(os.homedir(), '.codex', namespace))};
}

function pluginInventory(root) {
  const files = {};
  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('MARKETPLACE_SETUP_UNSAFE', 'Plugin symbolic links are not supported.');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files[path.relative(root, file).split(path.sep).join('/')] = sha(fs.readFileSync(file));
      else fail('MARKETPLACE_SETUP_UNSAFE', 'The plugin contains an unsupported file.');
    }
  }
  visit(root); return files;
}

function validateControls(files, descriptor, packageRoot, metadata) {
  if (!same(Object.keys(files).sort(), [...MARKETPLACE_CONTROL_FILES].sort()))
    fail('MARKETPLACE_SETUP_INVALID', 'Only the four release-control files may be imported; credentials and case records are never copied.');
  const values = {};
  for (const name of MARKETPLACE_CONTROL_FILES) {
    if (typeof files[name] !== 'string' || sha(files[name]) !== descriptor.artifact_files?.['private-config/' + name])
      fail('MARKETPLACE_SETUP_MISMATCH', 'The private controls differ from the frozen release.');
    values[name] = JSON.parse(files[name]);
  }
  const approval = values['approved-version-manifest.json'];
  if (approval.status !== 'approved_for_limited_beta') fail('MARKETPLACE_SETUP_NOT_APPROVED', 'An invented-only package cannot be activated for customer data.');
  validatePackagePreflight({manifest: approval, packageRoot, expectedPackageName: metadata.name, expectedPackageVersion: metadata.version});
  const runtime = values['limited-beta-runtime.json'];
  const controls = ['company_identity', 'read_only_zdp', 'transcript_secondary_processing', 'private_draft_google_scope', 'approved_renderer_execution', 'retention_policy', 'operational_support'];
  if (runtime.mode !== 'limited_beta' || runtime.renderer_mode !== 'manual_bound_script'
      || controls.some(name => runtime.organizational_controls?.[name] !== true)
      || ['identity', 'snowflake', 'google_drive_slides', 'manual_renderer', 'presenter_profile', 'tester_id', 'approvals', 'cases'].some(key => key in runtime))
    fail('MARKETPLACE_SETUP_INVALID', 'Setup must contain release policy, not another person’s connection, identity or workflow state.');
  function rejectSecrets(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(password|access_token|refresh_token|client_secret|private_key|credential_state|case_records|transcript)$/i.test(key))
        fail('MARKETPLACE_SETUP_INVALID', 'Credentials and customer content are not allowed in a setup file.');
      rejectSecrets(child);
    }
  }
  rejectSecrets(values);
  const template = values['snowflake-setup-template.json'];
  const policy = readJson(path.join(packageRoot, 'config/source-connection-policy.json')).snowflake;
  if (!same(Object.keys(template).sort(), ['schema_version', 'connection_name', 'account', 'authenticator', 'role', 'warehouse'].sort())
      || template.schema_version !== '1.0' || template.authenticator !== 'externalbrowser' || template.connection_name !== policy.connection_name
      || !policy.approved_read_only_roles.includes(template.role)
      || ['account', 'role', 'warehouse'].some(key => typeof template[key] !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(template[key])))
    fail('MARKETPLACE_SETUP_INVALID', 'Use the approved browser-sign-in template with no user, credentials or expanded source permissions.');
  const feedback = values['feedback-form.json'];
  if (feedback.enabled !== true || typeof feedback.responder_url !== 'string' || !feedback.responder_url.startsWith('https://')
      || !feedback.entries || !Object.keys(feedback.entries).length || !Object.values(feedback.entries).every(value => typeof value === 'string' && value))
    fail('MARKETPLACE_SETUP_INVALID', 'The private feedback configuration is incomplete.');
}

export function verifyMarketplaceSetup(options) {
  const {packageRoot, metadata, stateDirectory} = locations(options);
  const pack = readJson(options.setupFile);
  if (!same(Object.keys(pack).sort(), ['schema_version', 'purpose', 'release_descriptor', 'files'].sort())
      || pack.schema_version !== '1.0' || pack.purpose !== 'private_marketplace_setup')
    fail('MARKETPLACE_SETUP_INVALID', 'Use the private setup file supplied for this release, not edited or chat-generated approval data.');
  const descriptor = assertInstallableReleaseDescriptor(pack.release_descriptor);
  const expected = readJson(path.join(packageRoot, 'config/release-components.json'));
  if (descriptor.package_version !== metadata.version || !same(descriptor.components, expected))
    fail('MARKETPLACE_SETUP_MISMATCH', 'The setup file and installed plugin version or renderer contracts do not match.');
  const prefix = `marketplace/plugins/${metadata.name}/`;
  const expectedFiles = Object.fromEntries(Object.entries(descriptor.artifact_files || {}).filter(([name]) => name.startsWith(prefix)).map(([name, hash]) => [name.slice(prefix.length), hash]));
  if (!Object.keys(expectedFiles).length || !same(pluginInventory(packageRoot), expectedFiles))
    fail('MARKETPLACE_SETUP_MISMATCH', 'The installed plugin differs from the exact tested release.');
  validateControls(pack.files, descriptor, packageRoot, metadata);
  return {packageRoot, metadata, stateDirectory, pack};
}

const outcome = (metadata, state, changed = false) => ({state, package_version: metadata.version, configuration_changed: changed,
  connection_verified: false, customer_data_read: false, drafts_created: false,
  restart_required: changed, next_action: state === 'configured'
    ? changed ? 'Restart the desktop app and run the setup wizard in a fresh chat. Then verify your own company sign-in; release setup is not connection readiness.'
      : 'Continue the setup wizard and verify your own company sign-in. This check does not establish source or workflow readiness.'
    : 'Select the matching private setup file supplied by the release owner. Do not run customer workflows or edit approval files.'});

export function inspectMarketplaceSetup(options = {}) {
  const {metadata, packageRoot, stateDirectory} = locations(options);
  if (!fs.existsSync(path.join(stateDirectory, 'approved-version-manifest.json'))) return outcome(metadata, 'private_setup_required');
  try {
    assertSafeStateDirectory(stateDirectory);
    const descriptor = readJson(path.join(stateDirectory, 'release-descriptor.json'));
    assertInstallableReleaseDescriptor(descriptor);
    const files = Object.fromEntries(MARKETPLACE_CONTROL_FILES.map(name => [name, readFile(path.join(stateDirectory, name))]));
    // The only permitted local change is the per-person SSO login hint in the descriptor.
    const prefix = `marketplace/plugins/${metadata.name}/`;
    if (descriptor.package_version !== metadata.version || !same(descriptor.components, readJson(path.join(packageRoot, 'config/release-components.json')))
        || !same(pluginInventory(packageRoot), Object.fromEntries(Object.entries(descriptor.artifact_files || {}).filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name.slice(prefix.length), value]))))
      return outcome(metadata, 'private_setup_required');
    validateControls(files, descriptor, packageRoot, metadata);
    return outcome(metadata, 'configured');
  } catch { return outcome(metadata, 'private_setup_required'); }
}

function assertSafeStateDirectory(directory) {
  for (const target of [path.dirname(directory), directory]) {
    if (!fs.existsSync(target) && !fs.lstatSync(target, {throwIfNoEntry: false})) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || typeof process.getuid === 'function' && stat.uid !== process.getuid()
        || stat.mode & 0o022) fail('MARKETPLACE_SETUP_UNSAFE', 'Preserve the existing private-state directory; a safe, operator-owned directory is required.');
  }
}

export function applyMarketplaceSetup(options = {}) {
  if (options.localConfigurationAuthorized !== true)
    fail('MARKETPLACE_SETUP_APPROVAL_REQUIRED', 'Explicit local setup authorization is required. No configuration was changed.');
  if (typeof options.loginHint !== 'string' || options.loginHint.length > 254 || !email.test(options.loginHint))
    fail('MARKETPLACE_SETUP_LOGIN_REQUIRED', 'Provide your own company sign-in name as a login hint, never a password or token. It does not verify identity.');
  const {metadata, stateDirectory, pack} = verifyMarketplaceSetup(options);
  const named = pack.release_descriptor.handoff_scope?.named_tester;
  if (named && named.toLowerCase() !== options.loginHint.toLowerCase())
    fail('MARKETPLACE_SETUP_MISMATCH', 'This privately scoped setup file was supplied for a different tester.');
  assertSafeStateDirectory(stateDirectory);
  const descriptor = structuredClone(pack.release_descriptor);
  descriptor.handoff_scope = {...descriptor.handoff_scope, named_tester: options.loginHint}; // SSO hint only; authentication still derives identity.
  const updates = {...pack.files, 'release-descriptor.json': encode(descriptor)};
  const before = {};
  for (const name of Object.keys(updates)) {
    const target = path.join(stateDirectory, name);
    before[name] = fs.existsSync(target) || fs.lstatSync(target, {throwIfNoEntry: false}) ? readFile(target) : null;
  }
  if (Object.entries(updates).every(([name, data]) => data === before[name])) return outcome(metadata, 'configured');
  fs.mkdirSync(stateDirectory, {recursive: true, mode: 0o700});
  const written = [];
  try {
    for (const [name, data] of Object.entries(updates)) {
      options.beforeWrite?.(name);
      const temporary = path.join(stateDirectory, `.marketplace-${crypto.randomBytes(12).toString('hex')}`);
      try {
        fs.writeFileSync(temporary, data, {mode: 0o600, flag: 'wx'});
        fs.renameSync(temporary, path.join(stateDirectory, name)); written.push(name);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    const previous = Object.fromEntries(Object.entries(before).filter(([, value]) => value !== null));
    if (Object.keys(previous).length) fs.writeFileSync(path.join(stateDirectory, `.marketplace-recovery-${crypto.randomBytes(12).toString('hex')}.json`), encode(previous), {mode: 0o600, flag: 'wx'});
  } catch (error) {
    for (const name of written.reverse()) {
      const target = path.join(stateDirectory, name);
      if (before[name] === null) fs.unlinkSync(target);
      else fs.writeFileSync(target, before[name], {mode: 0o600});
    }
    fail('MARKETPLACE_SETUP_WRITE_FAILED', 'Setup did not complete. Earlier controls were preserved; credentials and case records were not changed.');
  }
  return outcome(metadata, 'configured', true);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    let result;
    if (command === 'inspect') result = inspectMarketplaceSetup();
    else if (command === 'apply') {
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      if (!same(Object.keys(input).sort(), ['local_configuration_authorized', 'setup_file', 'login_hint'].sort()))
        fail('MARKETPLACE_SETUP_INVALID', 'Use the supported bounded local setup request.');
      result = applyMarketplaceSetup({setupFile: input.setup_file, localConfigurationAuthorized: input.local_configuration_authorized, loginHint: input.login_hint});
    } else fail('MARKETPLACE_SETUP_INVALID', 'Choose inspect or apply. No installation or source read is performed.');
    process.stdout.write(encode(result));
  } catch (error) {
    process.stdout.write(encode({state: 'blocked', code: error instanceof BetaError ? error.code : 'MARKETPLACE_SETUP_FAILED', configuration_changed: false,
      customer_data_read: false, drafts_created: false, next_action: 'Stop and report the setup code. No credentials, case records or source permissions were changed.'}));
    process.exitCode = 1;
  }
}

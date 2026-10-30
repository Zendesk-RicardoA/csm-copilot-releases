import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Native from '../mcp/approved-native-contract.js';
import {WORKFLOW_CATALOG} from '../mcp/workflow-catalog.mjs';
import {applyMarketplaceSetup, inspectMarketplaceSetup, verifyMarketplaceSetup} from '../mcp/marketplace-setup.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const text = value => JSON.stringify(value, null, 2) + '\n';
const moduleFile = fileURLToPath(new URL('../mcp/marketplace-setup.mjs', import.meta.url));

// All identities and receipts below are invented and cannot authorize a real release.
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-marketplace-setup-'));
  try {
    const plugin = path.join(root, 'plugin'), state = path.join(root, 'operator');
    const name = 'csm-invented-marketplace', version = '0.1.0-invented.1';
    const components = {schema_version: '1.0', renderer_baseline: 'recovery-v3', native_contract: 'invented-native',
      renderers: {meeting_prep: {implementation_sha256: '1'.repeat(64), bundle_sha256: '2'.repeat(64)},
        renewal_preparation: {implementation_sha256: '3'.repeat(64), bundle_sha256: '4'.repeat(64)}}};
    const contents = {
      '.codex-plugin/plugin.json': text({name, version}),
      '.mcp.json': text({mcpServers: {[name]: {env: {CSM_COPILOT_BETA_STATE_NAMESPACE: name + '-live'}}}}),
      'config/release-components.json': text(components),
      'config/source-connection-policy.json': text({snowflake: {connection_name: 'zdp-global', approved_read_only_roles: ['EXAMPLE_READ_ONLY']}}),
      'mcp/reader.mjs': '/* invented offline reader */\n',
    };
    const integrity = Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, hash(value)]));
    const approval = {package_name: name, package_version: version, status: 'approved_for_limited_beta',
      renderer_baseline: 'recovery-v3', expires_at: '2099-01-01T00:00:00Z',
      constraints: {real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true},
      integrity: {algorithm: 'sha256', files: integrity}};
    contents['config/approved-version-manifest.json'] = text({...approval, status: 'approved_for_invented_testing',
      constraints: {real_customer_data: false, external_reads: false, external_writes: false, generated_artifacts: false}});
    for (const [relative, bytes] of Object.entries(contents)) {
      fs.mkdirSync(path.dirname(path.join(plugin, relative)), {recursive: true}); fs.writeFileSync(path.join(plugin, relative), bytes);
    }
    const files = {
      'approved-version-manifest.json': text(approval),
      'limited-beta-runtime.json': text({mode: 'limited_beta', renderer_mode: 'manual_bound_script', organizational_controls: {
        company_identity: true, read_only_zdp: true, transcript_secondary_processing: true, private_draft_google_scope: true,
        approved_renderer_execution: true, retention_policy: true, operational_support: true}}),
      'feedback-form.json': text({enabled: true, responder_url: 'https://example.invalid/form', entries: {case_id: 'entry.1'}}),
      'snowflake-setup-template.json': text({schema_version: '1.0', connection_name: 'zdp-global', account: 'invented-company',
        authenticator: 'externalbrowser', role: 'EXAMPLE_READ_ONLY', warehouse: 'EXAMPLE_WH'}),
    };
    const proof = {technical_passed: true,
      stages: Object.fromEntries(WORKFLOW_CATALOG.release_stages.map(name => [name, {status: 'passed'}])),
      workflows: Object.fromEntries(Object.keys(WORKFLOW_CATALOG.workflows).map(name => [name, 'invented_passed'])),
      source_fingerprint: 'a'.repeat(64), runtime_fingerprint: 'b'.repeat(64), renderer_fingerprint: 'c'.repeat(64)};
    const bindings = {meeting_prep: '5'.repeat(64), renewal_preparation: '6'.repeat(64)};
    const descriptor = {schema_version: '1.0', status: 'approved_to_share', candidate_kind: 'bounded_live_candidate',
      package_version: version, package_sha256: 'd'.repeat(64), components, technical_verification: proof,
      dependency_fingerprints: Object.fromEntries(Object.keys(WORKFLOW_CATALOG.workflows).map(name => [name, '7'.repeat(64)])),
      protected_regressions_sha256: 'e'.repeat(64), approved_master_bindings: bindings,
      approved_master_binding_fingerprint: hash(Native.canonicalSourceJson(bindings)),
      artifact_files: {...Object.fromEntries(Object.entries(contents).map(([key, value]) => [`marketplace/plugins/${name}/${key}`, hash(value)])),
        ...Object.fromEntries(Object.entries(files).map(([key, value]) => ['private-config/' + key, hash(value)]))}};
    descriptor.acceptance = {...Object.fromEntries(['source_fingerprint', 'runtime_fingerprint', 'renderer_fingerprint'].map(key => [key, proof[key]])),
      package_sha256: descriptor.package_sha256, components, dependency_fingerprints: descriptor.dependency_fingerprints,
      approved_to_share: true, authorized_live_checks: true, non_owner_installation: 'passed', chart_visibility: 'csm_confirmed_visible',
      live_workflows: Object.fromEntries(Object.keys(WORKFLOW_CATALOG.workflows).map(name => [name, 'passed'])),
      rendered_decks: {meeting_prep: 'human_approved', renewal_preparation: 'human_approved'},
      protected_expectations_review: 'human_approved', protected_regressions_sha256: descriptor.protected_regressions_sha256,
      approved_master_bindings: bindings, approved_master_binding_fingerprint: descriptor.approved_master_binding_fingerprint};
    const pack = {schema_version: '1.0', purpose: 'private_marketplace_setup', release_descriptor: descriptor, files};
    const file = path.join(root, 'private-setup.json');
    function save() { fs.writeFileSync(file, text(pack), {mode: 0o600}); }
    save();
    return run({root, plugin, state, pack, file, save, options: {packageRoot: plugin, stateDirectory: state}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('Git-only installation is not live readiness, and checking setup changes nothing', () => fixture(({options, state}) => {
  const result = inspectMarketplaceSetup(options);
  assert.equal(result.state, 'private_setup_required'); assert.equal(result.customer_data_read, false);
  assert.equal(result.connection_verified, false); assert.equal(fs.existsSync(state), false);
}));

test('setup requires local authorization and a self-supplied login hint, not a copied identity', () => fixture(({options, file, state}) => {
  assert.throws(() => applyMarketplaceSetup({...options, setupFile: file}), /authorization/i);
  assert.throws(() => applyMarketplaceSetup({...options, setupFile: file, localConfigurationAuthorized: true}), /login/i);
  assert.equal(fs.existsSync(state), false);
}));

test('matching approved setup writes only five private control files; repeated setup is idempotent', () => fixture(({options, file, state}) => {
  fs.mkdirSync(state, {mode: 0o700});
  for (const name of ['credential-state.json', 'presenter-profile.json', 'case.json']) fs.writeFileSync(path.join(state, name), 'invented existing state');
  const result = applyMarketplaceSetup({...options, setupFile: file, localConfigurationAuthorized: true, loginHint: 'operator@example.invalid'});
  assert.equal(result.state, 'configured'); assert.equal(result.restart_required, true); assert.equal(result.connection_verified, false);
  assert.equal(result.customer_data_read, false); assert.equal(result.drafts_created, false);
  assert.ok(!JSON.stringify(result).includes('operator@example.invalid'));
  for (const name of ['approved-version-manifest.json', 'limited-beta-runtime.json', 'feedback-form.json', 'snowflake-setup-template.json', 'release-descriptor.json'])
    assert.equal(fs.statSync(path.join(state, name)).mode & 0o777, 0o600);
  for (const name of ['credential-state.json', 'presenter-profile.json', 'case.json']) assert.equal(fs.readFileSync(path.join(state, name), 'utf8'), 'invented existing state');
  assert.equal(inspectMarketplaceSetup(options).state, 'configured');
  assert.equal(applyMarketplaceSetup({...options, setupFile: file, localConfigurationAuthorized: true, loginHint: 'operator@example.invalid'}).configuration_changed, false);
}));

test('wrong version, changed plugin, incomplete proof and changed controls fail before writes', () => fixture(({options, pack, file, save, plugin, state}) => {
  const original = structuredClone(pack);
  for (const change of [
    () => {pack.release_descriptor.package_version = '0.1.0-other';},
    () => {pack.release_descriptor.technical_verification.stages.source_tests.status = 'failed';},
    () => {pack.release_descriptor.status = 'development_candidate';},
    () => {pack.release_descriptor.acceptance.non_owner_installation = 'not_run';},
    () => {pack.files['limited-beta-runtime.json'] = '{}';},
    () => {pack.files['credential-state.json'] = '{}';},
  ]) {
    Object.assign(pack, structuredClone(original)); change(); save();
    assert.throws(() => applyMarketplaceSetup({...options, setupFile: file, localConfigurationAuthorized: true, loginHint: 'operator@example.invalid'}));
    assert.equal(fs.existsSync(state), false);
  }
  Object.assign(pack, original); save(); fs.appendFileSync(path.join(plugin, 'mcp/reader.mjs'), '// changed');
  assert.throws(() => verifyMarketplaceSetup({...options, setupFile: file}), /match|integrity|differ/i);
  assert.equal(fs.existsSync(state), false);
}));

test('extra plugin files, setup symlinks and private-state symlinks are rejected', () => fixture(({root, options, file, state, plugin}) => {
  const extra = path.join(plugin, 'mcp/extra.mjs'); fs.writeFileSync(extra, 'invented');
  assert.throws(() => verifyMarketplaceSetup({...options, setupFile: file})); fs.unlinkSync(extra);
  const linked = path.join(root, 'linked-setup.json'); fs.symlinkSync(file, linked);
  assert.throws(() => verifyMarketplaceSetup({...options, setupFile: linked}), /safe|regular|symbolic/i);
  const other = path.join(root, 'unrelated'); fs.mkdirSync(other); fs.symlinkSync(other, state);
  assert.throws(() => applyMarketplaceSetup({...options, setupFile: file, localConfigurationAuthorized: true, loginHint: 'operator@example.invalid'}));
  assert.deepEqual(fs.readdirSync(other), []);
}));

test('an interrupted setup rolls back its own writes and preserves prior controls', () => fixture(({options, file, state}) => {
  fs.mkdirSync(state, {mode: 0o700}); const original = path.join(state, 'feedback-form.json'); fs.writeFileSync(original, 'old invented feedback', {mode: 0o600});
  let count = 0;
  assert.throws(() => applyMarketplaceSetup({...options, setupFile: file, localConfigurationAuthorized: true, loginHint: 'operator@example.invalid',
    beforeWrite: () => { if (++count === 3) throw new Error('invented interrupted write'); }}));
  assert.deepEqual(fs.readdirSync(state), ['feedback-form.json']);
  assert.equal(fs.readFileSync(original, 'utf8'), 'old invented feedback');
}));

test('the CLI accepts setup metadata through stdin and never prints its values', () => {
  const result = spawnSync(process.execPath, [moduleFile, 'apply'], {encoding: 'utf8', input: JSON.stringify({local_configuration_authorized: false,
    setup_file: '/invented/private-setup.json', login_hint: 'operator@example.invalid'}), timeout: 10000});
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).customer_data_read, false);
  assert.ok(!result.stdout.includes('operator@example.invalid')); assert.ok(!result.stderr.includes('operator@example.invalid'));
});

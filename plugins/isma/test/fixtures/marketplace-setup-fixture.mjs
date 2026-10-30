import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Native from "../../mcp/approved-native-contract.js";
import {WORKFLOW_CATALOG} from "../../mcp/workflow-catalog.mjs";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const text = value => JSON.stringify(value, null, 2) + "\n";
// All identities and receipts below are invented and cannot authorize a real release.
export async function fixture(run) {
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
    return await run({root, plugin, state, pack, file, save, options: {packageRoot: plugin, stateDirectory: state}});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}


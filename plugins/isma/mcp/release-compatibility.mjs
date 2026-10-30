import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {createRequire} from 'node:module';
import { BetaError } from './core.mjs';
import { WORKFLOW_CATALOG } from './workflow-catalog.mjs';

const Native = createRequire(import.meta.url)('./approved-native-contract.js');

const same = (left,right) => Native.canonicalSourceJson(left) === Native.canonicalSourceJson(right);

export function expectedReleaseComponents(packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const file = path.join(packageRoot, 'config/release-components.json');
  if(!fs.existsSync(file)) return null;
  const components=JSON.parse(fs.readFileSync(file,'utf8'));
  const namespace=process.env.CSM_COPILOT_BETA_STATE_NAMESPACE;
  const descriptorPath=process.env.CSM_COPILOT_BETA_RELEASE_DESCRIPTOR_PATH || (/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace || '') ? path.join(os.homedir(),'.codex',namespace,'release-descriptor.json') : null);
  if(!descriptorPath || !fs.existsSync(descriptorPath)) return components; // local, not installed acceptance
  const descriptor=JSON.parse(fs.readFileSync(descriptorPath,'utf8'));
  const version=JSON.parse(fs.readFileSync(path.join(packageRoot,'.codex-plugin/plugin.json'),'utf8')).version;
  if(descriptor.package_version!==version || !same(descriptor.components,components)) throw new BetaError('RELEASE_COMPONENT_MISMATCH','The installed release descriptor differs from this plugin. Read-only source permissions are unchanged; reconcile the affected draft components before rendering.');
  return {...components,approved_master_bindings:descriptor.approved_master_bindings || {},release_status:descriptor.status};
}

export function checkRendererCompatibility(workflow, receipt, expected = expectedReleaseComponents()) {
  if (!expected) return { state: 'development_unfrozen', workflow, next_action: 'Freeze and verify the compatible candidate before any private draft.' };
  const required = expected.renderers?.[workflow];
  if (!required || receipt?.implementation_sha256 !== required.implementation_sha256
      || receipt?.native_contract !== expected.native_contract || receipt?.renderer_baseline !== expected.renderer_baseline
      || receipt?.native_fit_contract !== expected.native_fit_contract || receipt?.renewal_layout_contract !== expected.renewal_layout_contract
      || workflow==='renewal_preparation' && expected.renewal_preflight_contract && receipt?.renewal_preflight_contract!==expected.renewal_preflight_contract
      || workflow==='meeting_prep' && expected.peer_takeaway_layout_contract && receipt?.peer_takeaway_layout_contract!==expected.peer_takeaway_layout_contract
      || workflow==='meeting_prep' && expected.investigation_layout_contract && receipt?.investigation_layout_contract!==expected.investigation_layout_contract
      || workflow==='meeting_prep' && (receipt?.narrative_selection_contract!==expected.narrative_selection_contract || receipt?.metric_trend_contract!==expected.metric_trend_contract)
      || receipt?.master_contract_sha256 !== expected.master_contract_sha256) {
    return { state: 'component_mismatch', workflow, next_action: 'Use the exact tested renderer bundle and approved master binding for this package. Other read-only workflows remain available.' };
  }
  if(expected.approved_master_bindings?.[workflow] && receipt?.approved_master_binding_fingerprint!==expected.approved_master_bindings[workflow]) return {state:'component_mismatch',workflow,next_action:'The open private master differs from the approved release binding. Stop this draft; read-only workflows remain available.'};
  return { state: 'matched', workflow };
}

export function assertRendererCompatibility(workflow, receipt, expected = expectedReleaseComponents()) {
  const result = checkRendererCompatibility(workflow, receipt, expected);
  if (result.state !== 'matched') throw new BetaError('RELEASE_COMPONENT_MISMATCH', result.next_action, result);
  return result;
}

export function assertInstallableReleaseDescriptor(descriptor) {
  if (!['approved_to_share', 'authorized_live_acceptance', 'live_checked'].includes(descriptor.status)) throw new Error('This candidate has not been approved for installation or specifically authorized live acceptance.');
  if(descriptor.candidate_kind !== 'bounded_live_candidate') throw new Error('An invented-only artifact cannot be authorized for live installation.');
  if (descriptor.status !== 'approved_to_share' && descriptor.acceptance?.authorized_live_checks !== true) throw new Error('Specific live-check authorization is required.');
  const proof=descriptor.technical_verification || {}, acceptance=descriptor.acceptance || {};
  if(proof.technical_passed!==true || WORKFLOW_CATALOG.release_stages.some(stage=>proof.stages?.[stage]?.status!=='passed')
    || Object.keys(WORKFLOW_CATALOG.workflows).some(workflow=>proof.workflows?.[workflow]!=='invented_passed')
    || ['source_fingerprint','runtime_fingerprint','renderer_fingerprint'].some(key=>!/^[a-f0-9]{64}$/.test(proof[key] || '') || acceptance[key]!==proof[key])
    || acceptance.package_sha256!==descriptor.package_sha256 || !same(acceptance.components,descriptor.components)
    || !same(acceptance.dependency_fingerprints,descriptor.dependency_fingerprints)) throw new Error('Complete exact-artifact technical verification is required before installation.');
  if(descriptor.status==='approved_to_share') {
    const acceptance=descriptor.acceptance || {}, workflows=['daily_focus','book_analysis','outreach','renewal_preparation','meeting_prep'];
    if(acceptance.approved_to_share!==true || acceptance.non_owner_installation!=='passed' || acceptance.chart_visibility!=='csm_confirmed_visible'
      || workflows.some(workflow=>acceptance.live_workflows?.[workflow]!=='passed')
      || ['renewal_preparation','meeting_prep'].some(workflow=>acceptance.rendered_decks?.[workflow]!=='human_approved')
      || acceptance.protected_expectations_review!=='human_approved' || !/^[a-f0-9]{64}$/.test(descriptor.protected_regressions_sha256 || '')
      || acceptance.protected_regressions_sha256!==descriptor.protected_regressions_sha256
      || !same(acceptance.approved_master_bindings,descriptor.approved_master_bindings)
      || ['meeting_prep','renewal_preparation'].some(workflow=>!/^[a-f0-9]{64}$/.test(descriptor.approved_master_bindings?.[workflow] || ''))
      || acceptance.approved_master_binding_fingerprint!==descriptor.approved_master_binding_fingerprint
      || crypto.createHash('sha256').update(Native.canonicalSourceJson(descriptor.approved_master_bindings)).digest('hex')!==descriptor.approved_master_binding_fingerprint) throw new Error('The release lacks complete, exact-artifact human acceptance.');
  }
  if(!/^[a-f0-9]{64}$/.test(descriptor.package_sha256 || '')) throw new Error('A frozen package digest is required.');
  return descriptor;
}

export function verifyInstallableBundle(bundleRoot, descriptorPath) {
  const descriptor = assertInstallableReleaseDescriptor(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')));
  const pluginRoot = path.join(bundleRoot, 'marketplace/plugins');
  const entries = fs.readdirSync(pluginRoot);
  if (entries.length !== 1) throw new Error('Exactly one frozen plugin is required.');
  const plugin = path.join(pluginRoot, entries[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  const approvalPath=path.join(bundleRoot,'private-config/approved-version-manifest.json');
  if(!fs.existsSync(approvalPath) || JSON.parse(fs.readFileSync(approvalPath,'utf8')).status!=='approved_for_limited_beta') throw new Error('Separately approved limited-beta source controls are required.');
  const expected = JSON.parse(fs.readFileSync(path.join(plugin,'config/release-components.json'),'utf8'));
  if (manifest.version !== descriptor.package_version || !same(expected,descriptor.components)) throw new Error('Plugin and release descriptor do not match.');
  const sha = data => crypto.createHash('sha256').update(data).digest('hex');
  const actual={};
  function inventory(directory) {
    for(const name of fs.readdirSync(directory)) {
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()) throw new Error('Frozen package symlinks are not supported.');
      if(stat.isDirectory()) inventory(file);
      else if(stat.isFile()) actual[path.relative(bundleRoot,file).split(path.sep).join('/')]=sha(fs.readFileSync(file));
      else throw new Error('Unsupported frozen package entry.');
    }
  }
  inventory(bundleRoot);
  if(!same(actual,descriptor.artifact_files) || Object.keys(actual).length===0) throw new Error('The extracted frozen package differs from the tested file inventory.');
  const integrity = JSON.parse(fs.readFileSync(path.join(plugin, 'config/approved-version-manifest.json'), 'utf8')).integrity.files;
  for (const [relative, hash] of Object.entries(integrity)) {
    const file = path.resolve(plugin, relative);
    if (!file.startsWith(plugin + path.sep) || fs.lstatSync(file).isSymbolicLink() || sha(fs.readFileSync(file)) !== hash) throw new Error('Frozen plugin integrity check failed.');
  }
  for (const [workflow, component] of Object.entries(expected.renderers)) {
    const directory = path.join(bundleRoot, 'renderers', workflow);
    const hash = crypto.createHash('sha256');
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw new Error('Unsupported renderer bundle entry.');
      hash.update(name + '\0'); hash.update(crypto.createHash('sha256').update(fs.readFileSync(file)).digest());
    }
    if (hash.digest('hex') !== component.bundle_sha256) throw new Error('Renderer bundle integrity check failed.');
  }
  return { state: 'matched', package_version: manifest.version, installation_permitted: true };
}

if (typeof process !== 'undefined' && process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verifyInstallableBundle(process.argv[2], process.argv[3]); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

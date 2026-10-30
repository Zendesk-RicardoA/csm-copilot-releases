import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyMarketplaceSetup, inspectMarketplaceSetup, verifyMarketplaceSetup} from '../mcp/marketplace-setup.mjs';

const moduleFile = fileURLToPath(new URL('../mcp/marketplace-setup.mjs', import.meta.url));

import {fixture} from "./fixtures/marketplace-setup-fixture.mjs";

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

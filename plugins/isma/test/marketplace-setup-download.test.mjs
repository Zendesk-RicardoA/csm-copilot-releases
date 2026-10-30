import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {downloadMarketplaceSetup, applyMarketplaceSetup, inspectMarketplaceSetup} from '../mcp/marketplace-setup.mjs';
import {existingGitHubToken, githubSetupClient, registeredGitHubRepository, runSetupCommand} from '../mcp/marketplace-setup-download.mjs';
import {fixture} from './fixtures/marketplace-setup-fixture.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = name => ({marketplaces: [{name, marketplaceSource: {sourceType: 'git', source: 'https://github.com/invented-owner/invented-release.git'}}]});
function remote(f) {
  const metadata = JSON.parse(fs.readFileSync(path.join(f.plugin, '.codex-plugin/plugin.json')));
  const bytes = fs.readFileSync(f.file), calls = [];
  const release = {draft: false, tag_name: `${metadata.name}-setup-v${metadata.version}`, assets: [{name: 'private-setup.json',
    id: 123, state: 'uploaded', size: bytes.length, digest: 'sha256:' + sha(bytes)}]};
  const repo = {private: true, full_name: 'invented-owner/invented-release'};
  const client = {json: async route => { calls.push(route); return route.endsWith('/invented-release') ? repo : release; },
    bytes: async route => {calls.push(route); return bytes; }};
  return {metadata, release, repo, bytes, calls, client, options: {...f.options, marketplaceListing: source(metadata.name), client}};
}

test('first install downloads the exact release and applies through the unchanged strict verifier', () => fixture(async f => {
  const r = remote(f);
  const downloaded = await downloadMarketplaceSetup(r.options);
  assert.equal(downloaded.state, 'downloaded'); assert.equal(downloaded.verified, true);
  assert.deepEqual(r.calls, ['/repos/invented-owner/invented-release', '/repos/invented-owner/invented-release/releases/tags/' + r.release.tag_name,
    '/repos/invented-owner/invented-release/releases/assets/123']);
  assert.equal(fs.readFileSync(downloaded.setup_file, 'utf8'), r.bytes.toString());
  assert.equal(fs.statSync(downloaded.setup_file).mode & 0o777, 0o600);
  assert.equal(inspectMarketplaceSetup(f.options).state, 'private_setup_required');
  const applied = applyMarketplaceSetup({...f.options, setupFile: downloaded.setup_file, localConfigurationAuthorized: true, loginHint: 'operator@example.invalid'});
  assert.equal(applied.state, 'configured'); assert.equal(applied.restart_required, true);
  assert.equal(applied.customer_data_read, false); assert.equal(applied.connection_verified, false); assert.equal(applied.drafts_created, false);
  assert.equal(inspectMarketplaceSetup(f.options).state, 'configured');
}));

test('resume reuses verified private cache, and configured installations need no GitHub access', () => fixture(async f => {
  const r = remote(f), first = await downloadMarketplaceSetup(r.options); r.calls.length = 0;
  assert.equal((await downloadMarketplaceSetup(r.options)).state, 'cached'); assert.deepEqual(r.calls, []);
  applyMarketplaceSetup({...f.options, setupFile: first.setup_file, localConfigurationAuthorized: true, loginHint: 'operator@example.invalid'});
  const result = await downloadMarketplaceSetup({...f.options, command: () => { throw new Error('must stay offline'); }});
  assert.equal(result.state, 'configured'); assert.equal(result.download_required, false);
}));

test('cache tampering is reacquired without changing credentials, existing controls or cases', () => fixture(async f => {
  const r = remote(f), first = await downloadMarketplaceSetup(r.options);
  fs.writeFileSync(path.join(f.state, 'credential-state.json'), 'invented existing credential state', {mode: 0o600});
  fs.writeFileSync(path.join(f.state, 'case.json'), 'invented existing review', {mode: 0o600});
  fs.writeFileSync(first.setup_file, '{}'); r.calls.length = 0;
  assert.equal((await downloadMarketplaceSetup(r.options)).state, 'downloaded'); assert.equal(r.calls.length, 3);
  assert.equal(fs.readFileSync(path.join(f.state, 'credential-state.json'), 'utf8'), 'invented existing credential state');
  assert.equal(fs.readFileSync(path.join(f.state, 'case.json'), 'utf8'), 'invented existing review');
  assert.equal(fs.existsSync(path.join(f.state, 'approved-version-manifest.json')), false);
}));

test('only the exact GitHub marketplace registration is accepted, with HTTPS and ordinary Git SSH forms', () => {
  const metadata = {name: 'invented-plugin'};
  for (const url of ['https://github.com/invented-owner/invented-release.git', 'git@github.com:invented-owner/invented-release.git', 'ssh://git@github.com/invented-owner/invented-release.git']) {
    const listing = source(metadata.name); listing.marketplaces[0].marketplaceSource.source = url;
    assert.deepEqual(registeredGitHubRepository(metadata, listing), {owner: 'invented-owner', repository: 'invented-release'});
  }
  for (const url of ['https://other.invalid/a/b', 'https://secret@github.com/a/b', 'https://github.com/a/b?token=secret',
    'https://github.com/a/b/extra', 'https://github.com/a/..', '$(invented-command)', 'https://github.com/a/b#fragment']) {
    const listing = source(metadata.name); listing.marketplaces[0].marketplaceSource.source = url;
    assert.throws(() => registeredGitHubRepository(metadata, listing), {code: 'MARKETPLACE_SETUP_SOURCE_REQUIRED'});
  }
  assert.throws(() => registeredGitHubRepository(metadata, {marketplaces: []}));
  assert.throws(() => registeredGitHubRepository(metadata, {marketplaces: [...source(metadata.name).marketplaces, ...source(metadata.name).marketplaces]}));
});

test('missing, draft, duplicate, incomplete, oversized and checksumless release assets fail before saving', () => fixture(async f => {
  for (const modify of [r => {r.release.draft = true;}, r => {r.release.tag_name = 'wrong-version';}, r => {r.release.assets = [];},
    r => {r.release.assets.push({...r.release.assets[0]});}, r => {r.release.assets[0].state = 'starter';},
    r => {r.release.assets[0].size = 3 * 1024 * 1024;}, r => {delete r.release.assets[0].digest;}, r => {r.repo.private = false;},
    r => {r.repo.full_name = 'invented-owner/other-release';}]) {
    const r = remote(f); modify(r);
    await assert.rejects(downloadMarketplaceSetup(r.options)); assert.equal(fs.existsSync(f.state), false);
  }
}));

test('byte digest or size mismatch never reaches full verifier or private-state writes', () => fixture(async f => {
  for (const modify of [r => {r.release.assets[0].digest = 'sha256:' + '0'.repeat(64);}, r => {r.release.assets[0].size++;}]) {
    const r = remote(f); modify(r);
    await assert.rejects(downloadMarketplaceSetup(r.options), {code: 'MARKETPLACE_SETUP_DOWNLOAD_MISMATCH'});
    assert.equal(fs.existsSync(f.state), false);
  }
}));

test('valid transport hash cannot substitute wrong-version controls, changed plugin or incomplete release proof', () => fixture(async f => {
  const original = structuredClone(f.pack);
  for (const change of [() => {f.pack.release_descriptor.package_version = '0.1.0-wrong';},
    () => {f.pack.release_descriptor.technical_verification.stages.source_tests.status = 'failed';},
    () => {f.pack.files['limited-beta-runtime.json'] = '{}';}]) {
    Object.assign(f.pack, structuredClone(original)); change(); f.save();
    await assert.rejects(downloadMarketplaceSetup(remote(f).options));
    assert.equal(fs.existsSync(path.join(f.state, 'approved-version-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(f.state, '.setup-downloads', '0.1.0-invented.1', 'private-setup.json')), false);
  }
  Object.assign(f.pack, original); f.save(); fs.appendFileSync(path.join(f.plugin, 'mcp/reader.mjs'), '// changed');
  await assert.rejects(downloadMarketplaceSetup(remote(f).options));
}));

test('unsafe cache symlinks or shared file permissions are refused without following them', () => fixture(async f => {
  const r = remote(f), first = await downloadMarketplaceSetup(r.options);
  fs.chmodSync(first.setup_file, 0o644);
  await assert.rejects(downloadMarketplaceSetup(r.options), {code: 'MARKETPLACE_SETUP_UNSAFE'});
  fs.unlinkSync(first.setup_file); fs.symlinkSync(f.file, first.setup_file);
  await assert.rejects(downloadMarketplaceSetup(r.options), {code: 'MARKETPLACE_SETUP_UNSAFE'});
  assert.equal(fs.readFileSync(f.file, 'utf8'), r.bytes.toString());
}));

test('existing authentication uses captured output only and supports Git credential-helper fallback', () => {
  const repository = {owner: 'invented-owner', repository: 'invented-release'}, calls = [];
  const gh = existingGitHubToken(repository, (name, args, input) => {calls.push({name, args, input}); return 'invented-private-token\n';});
  assert.equal(gh, 'invented-private-token'); assert.equal(calls.length, 1);
  calls.length = 0;
  const git = existingGitHubToken(repository, (name, args, input) => {calls.push({name, args, input}); return name === 'gh' ? null : 'username=invented\npassword=invented-fallback-token\n';});
  assert.equal(git, 'invented-fallback-token'); assert.equal(calls[1].name, 'git');
  assert.ok(calls[1].input.includes('path=invented-owner/invented-release.git'));
  assert.ok(!JSON.stringify(calls).includes('invented-fallback-token'));
  assert.throws(() => existingGitHubToken(repository, () => null), {code: 'MARKETPLACE_SETUP_GITHUB_SIGN_IN_REQUIRED'});
  let invocation;
  assert.equal(runSetupCommand('git', ['credential', 'fill'], 'invented request', (command, args, opts) => {
    invocation = {command, args, opts}; return {status: 0, stdout: 'invented-private-output'};
  }), 'invented-private-output');
  assert.equal(invocation.opts.shell, false); assert.equal(invocation.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(invocation.opts.env.GCM_INTERACTIVE, 'never');
});

test('asset redirects strip authentication on other GitHub hosts and reject arbitrary hosts', async () => {
  const calls = [], token = 'invented-private-token';
  const client = githubSetupClient(token, async (url, options) => {
    calls.push({url, headers: options.headers});
    return calls.length === 1 ? new Response(null, {status: 302, headers: {location: 'https://release-assets.githubusercontent.com/invented-asset?signature=invented'}})
      : new Response('invented setup bytes');
  });
  assert.equal((await client.bytes('/repos/invented-owner/invented-release/releases/assets/123')).toString(), 'invented setup bytes');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + token); assert.equal(calls[1].headers.Authorization, undefined);
  for (const location of ['https://other.invalid/asset', 'http://github.com/asset', 'https://secret@github.com/asset']) {
    const blocked = githubSetupClient(token, async () => new Response(null, {status: 302, headers: {location}}));
    await assert.rejects(blocked.bytes('/repos/invented-owner/invented-release/releases/assets/123'), {code: 'MARKETPLACE_SETUP_DOWNLOAD_INVALID'});
  }
});

test('provider failures, malformed/oversized metadata, network and timeout use safe distinct errors', async () => {
  for (const [status, code] of [[401, 'MARKETPLACE_SETUP_GITHUB_SIGN_IN_REQUIRED'], [403, 'MARKETPLACE_SETUP_GITHUB_ACCESS_BLOCKED'],
    [404, 'MARKETPLACE_SETUP_RELEASE_UNAVAILABLE'], [429, 'MARKETPLACE_SETUP_GITHUB_ACCESS_BLOCKED'], [500, 'MARKETPLACE_SETUP_DOWNLOAD_FAILED']]) {
    const client = githubSetupClient('invented-token', async () => new Response('private-provider-detail', {status}));
    await assert.rejects(client.json('/repos/invented-owner/invented-release'), error => error.code === code && !error.message.includes('private-provider-detail'));
  }
  await assert.rejects(githubSetupClient('invented-token', async () => new Response('{bad json')).json('/repos/invented/release'), {code: 'MARKETPLACE_SETUP_DOWNLOAD_INVALID'});
  await assert.rejects(githubSetupClient('invented-token', async () => new Response('x', {headers: {'content-length': '3000000'}})).json('/repos/invented/release'), {code: 'MARKETPLACE_SETUP_DOWNLOAD_TOO_LARGE'});
  await assert.rejects(githubSetupClient('invented-token', async () => {throw new Error('invented-token');}).json('/repos/invented/release'), error => error.code === 'MARKETPLACE_SETUP_DOWNLOAD_FAILED' && !error.message.includes('invented-token'));
  const timeout = githubSetupClient('invented-token', async (url, {signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')))), {timeoutMs: 5});
  await assert.rejects(timeout.json('/repos/invented/release'), {code: 'MARKETPLACE_SETUP_DOWNLOAD_TIMEOUT'});
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {SetupDependencyInstallations} from '../mcp/setup-dependencies.mjs';
import {snowflakeInstallationRecipe} from '../mcp/snowflake-installation.mjs';
import {resolveSnowflakeCommand, resolveSnowflakePython} from '../mcp/snowflake-runtime.mjs';
import {runtimeSpec, runtimeBases, privateJson, readManagedRuntime, CURRENT_FILE} from '../mcp/snowflake-managed-runtime.mjs';
import {downloadRuntime, validateArchiveEntries, validateArchiveLinks} from '../mcp/snowflake-runtime-download.mjs';
import {chooseRuntimeBase, acquireInstallLock, installManagedRuntime} from '../mcp/snowflake-runtime-bootstrap.mjs';

const missing = {state: 'cli_missing', prerequisites: {cli: 'missing'}};
const ready = {state: 'configuration_missing', prerequisites: {cli: 'available'}, next_action: {code: 'CONFIGURE_SNOWFLAKE_ZDP'}};
function fixture(t, options = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isma-managed-test-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  let local = missing;
  const calls = [], children = [];
  const settings = {directory: path.join(home, 'receipts'), home, platform: 'darwin', arch: 'arm64',
    packageVersion: '0.0.0-invented', inspect: () => local,
    resolveExecutable() {assert.fail('Snowflake installation must not look for Homebrew or system Python');},
    spawnProcess(executable, args, opts) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      calls.push({executable, args, opts}); children.push(child); return child;
    }, ...options};
  return {home, calls, children, settings, jobs: new SetupDependencyInstallations(settings), setLocal: value => {local = value;}};
}
function fakeRuntime(home, {id = 'py3.12.16-snow3.24.1-arm64-OLD123', base = runtimeBases({home, platform: 'darwin'})[0]} = {}) {
  const directory = path.join(base, id);
  for (const child of ['python/bin', 'cli/bin']) fs.mkdirSync(path.join(directory, child), {recursive: true, mode: 0o700});
  const python = path.join(directory, 'python/bin/python3.12'), command = path.join(directory, 'cli/bin/snow');
  fs.writeFileSync(python, '', {mode: 0o700});
  fs.writeFileSync(command, '#!/bin/sh\n', {mode: 0o700});
  fs.symlinkSync('../../python/bin/python3.12', path.join(directory, 'cli/bin/python3'));
  const receipt = {schema_version: '1.0', owner: 'isma', runtime_id: id, recipe_digest: 'a'.repeat(64), state: 'verified'};
  privateJson(path.join(directory, 'runtime-receipt.json'), receipt);
  privateJson(path.join(base, CURRENT_FILE), {schema_version: '1.0', owner: 'isma', runtime_id: id, recipe_digest: receipt.recipe_digest});
  return {directory, python, command, base, id};
}

test('the recipe pins both Mac architectures and needs neither Homebrew nor Python', () => {
  for (const arch of ['arm64', 'x64']) {
    const recipe = snowflakeInstallationRecipe({home: '/invented/home', platform: 'darwin', arch});
    assert.equal(recipe.kind, 'managed_python'); assert.equal(recipe.executable, process.execPath);
    assert.match(recipe.args[0], /snowflake-runtime-bootstrap\.mjs$/);
    assert.deepEqual(recipe.args.slice(1), ['--home', '/invented/home', '--arch', arch]);
    assert.match(recipe.recipe_digest, /^[a-f0-9]{64}$/);
    assert.equal(recipe.python_version, runtimeSpec().python_version);
    assert.equal(recipe.components.length, 2);
  }
});
test('the approved managed job reports phases and verifies before returning to configuration', t => {
  const f = fixture(t);
  assert.throws(() => f.jobs.start({dependencyId: 'snowflake'}), {code: 'SOFTWARE_INSTALLATION_APPROVAL_REQUIRED'});
  const started = f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true});
  assert.equal(started.recipe, 'managed_python'); assert.equal(f.calls[0].opts.shell, false);
  f.children[0].stdout.emit('data', '{"phase":"downloading_python"}\n');
  assert.equal(f.jobs.read(started.install_ref).phase, 'downloading_python');
  assert.equal(f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true}).install_ref, started.install_ref);
  assert.equal(f.calls.length, 1);
  f.setLocal(ready); f.children[0].emit('close', 0);
  assert.equal(f.jobs.read(started.install_ref).status, 'installed_verified');
  assert.equal(f.jobs.read(started.install_ref).source_access_verified, false);
  assert.equal(f.jobs.read(started.install_ref).next_action.code, 'CONFIGURE_SNOWFLAKE_ZDP');
});
test('unsupported platforms receive one truthful action without an install attempt', t => {
  const f = fixture(t, {platform: 'linux'});
  const result = f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true});
  assert.equal(result.code, 'INSTALL_UNSUPPORTED_PLATFORM');
  assert.equal(result.installation_performed, false); assert.equal(f.calls.length, 0);
});
test('a broken existing CLI can receive a separate approved installation', t => {
  const f = fixture(t); f.setLocal({state: 'runtime_unsupported', prerequisites: {cli: 'available'}});
  assert.throws(() => f.jobs.start({dependencyId: 'snowflake'}), {code: 'SOFTWARE_INSTALLATION_APPROVAL_REQUIRED'});
  const job = f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true});
  assert.equal(job.recipe, 'managed_python'); assert.equal(f.calls.length, 1);
  f.setLocal(ready); f.children[0].emit('close', 0);
  assert.equal(f.jobs.read(job.install_ref).status, 'installed_verified');
});
test('failure preserves its cause and approval; resubmission cannot silently restart it', t => {
  const f = fixture(t), job = f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true});
  f.children[0].stdout.emit('data', '{"phase":"downloading_python"}\n{"status":"failed","code":"INSTALL_NETWORK_FAILED"}\n');
  f.children[0].emit('close', 1);
  assert.equal(f.jobs.read(job.install_ref).code, 'INSTALL_NETWORK_FAILED');
  assert.equal(f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true}).status, 'failed');
  assert.equal(f.calls.length, 1);
  const retry = f.jobs.start({dependencyId: 'snowflake', retryFailed: true});
  assert.equal(retry.approval_reused, true); assert.equal(f.calls.length, 2);
  f.setLocal(ready); f.children[1].emit('close', 0);
});
test('restart reconciles the same pending job instead of starting a duplicate', t => {
  const f = fixture(t); f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true});
  const restart = new SetupDependencyInstallations(f.settings);
  assert.equal(restart.start({dependencyId: 'snowflake', installationAuthorized: true}).status, 'needs_reconciliation');
  assert.equal(f.calls.length, 1); f.children[0].emit('close', 1);
});
test('GUI discovery selects a verified private runtime ahead of a broken global CLI', t => {
  const f = fixture(t), managed = fakeRuntime(f.home);
  const globalBin = path.join(f.home, 'global'); fs.mkdirSync(globalBin);
  fs.writeFileSync(path.join(globalBin, 'snow'), '#!/bin/sh\nexit 99\n', {mode: 0o700});
  const options = {home: f.home, platform: 'darwin', environment: {PATH: globalBin}, extraSearchDirectories: []};
  assert.equal(resolveSnowflakeCommand(options), managed.command);
  assert.equal(resolveSnowflakePython(options), path.join(managed.directory, 'cli/bin/python3'));
  assert.equal(fs.existsSync(path.join(f.home, '.zprofile')), false);
});
test('unrecognised conflicting files are preserved and an alternate private folder is used', t => {
  const f = fixture(t), bases = runtimeBases({home: f.home, platform: 'darwin'});
  fs.mkdirSync(bases[0], {recursive: true, mode: 0o700});
  const conflict = path.join(bases[0], CURRENT_FILE); fs.writeFileSync(conflict, 'invented existing file', {mode: 0o600});
  assert.equal(chooseRuntimeBase(f.home, 'darwin', 1, {freeBytes: () => 2}), bases[1]);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'invented existing file');
});
test('disk-space failure is caught before a download or executable starts', t => {
  const f = fixture(t);
  assert.throws(() => chooseRuntimeBase(f.home, 'darwin', 1, {freeBytes: () => 0}), /INSTALL_DISK_SPACE_LOW/);
});
test('active worker locks prevent duplicates; stale owned locks are reconciled', t => {
  const f = fixture(t), base = chooseRuntimeBase(f.home, 'darwin', 0);
  const release = acquireInstallLock(base, {pid: 123, alive: () => false});
  assert.throws(() => acquireInstallLock(base, {pid: 456, alive: () => true}), /INSTALL_ALREADY_RUNNING/);
  release();
  const releaseStale = acquireInstallLock(base, {pid: 123, alive: () => false});
  const second = acquireInstallLock(base, {pid: 456, alive: () => false});
  releaseStale(); second();
  assert.equal(fs.existsSync(path.join(base, '.snowflake-install.lock')), false);
});
test('interrupted archive downloads resume and are hash-checked before use', async t => {
  const f = fixture(t), cache = path.join(f.home, 'cache'); fs.mkdirSync(cache, {mode: 0o700});
  const bytes = Buffer.from('invented-runtime'), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const asset = {url: 'https://github.com/astral-sh/python-build-standalone/releases/download/invented/runtime.tar.gz', sha256, size: bytes.length};
  const part = path.join(cache, sha256 + '.tar.gz.partial'); fs.writeFileSync(part, bytes.subarray(0, 4), {mode: 0o600});
  const result = await downloadRuntime(asset, cache, {fetcher: async (url, options) => {
    assert.equal(options.headers.Range, 'bytes=4-');
    return new Response(bytes.subarray(4), {status: 206, headers: {'content-range': 'bytes 4-' + (bytes.length - 1) + '/' + bytes.length}});
  }});
  assert.deepEqual(fs.readFileSync(result), bytes); assert.equal(fs.existsSync(part), false);
});
test('bad hashes and redirects cannot reach runtime extraction', async t => {
  const f = fixture(t), cache = path.join(f.home, 'cache'); fs.mkdirSync(cache, {mode: 0o700});
  const asset = {url: 'https://github.com/astral-sh/python-build-standalone/releases/download/invented/runtime.tar.gz', sha256: 'a'.repeat(64), size: 3};
  await assert.rejects(downloadRuntime(asset, cache, {fetcher: async () => new Response(Buffer.from('bad'))}), /INSTALL_DOWNLOAD_INTEGRITY_FAILED/);
  await assert.rejects(downloadRuntime(asset, cache, {fetcher: async () => new Response(null, {status: 302, headers: {location: 'https://example.invalid/file'}})}), /INSTALL_DOWNLOAD_INTEGRITY_FAILED/);
});
test('archive entries and links cannot escape the private Python directory', () => {
  assert.equal(validateArchiveEntries('python/\npython/bin/python3.12\n'), 2);
  for (const bad of ['/etc/passwd', 'python/../../outside', 'other/file', 'python/..\\outside']) {
    assert.throws(() => validateArchiveEntries(bad), /INSTALL_DOWNLOAD_INTEGRITY_FAILED/);
  }
  validateArchiveLinks('lrwxr-xr-x 0 1 1 0 Jan 1 python/bin/python3 -> python3.12');
  assert.throws(() => validateArchiveLinks('lrwxr-xr-x 0 1 1 0 Jan 1 python/bin/python3 -> ../../../outside'), /INSTALL_DOWNLOAD_INTEGRITY_FAILED/);
});
test('failed replacement keeps the previous runtime active; verified replacement preserves it for recovery', async t => {
  const f = fixture(t), previous = fakeRuntime(f.home);
  const pointer = path.join(previous.base, CURRENT_FILE), before = fs.readFileSync(pointer, 'utf8');
  const spec = runtimeSpec();
  const options = {home: f.home, platform: 'darwin', arch: 'arm64', choose: () => previous.base, download: async () => '/invented/archive',
    extract: (archive, directory) => {
      for (const sub of ['python/bin', 'cli/bin']) fs.mkdirSync(path.join(directory, sub), {recursive: true, mode: 0o700});
      for (const sub of ['python/bin/python3.12', 'cli/bin/snow', 'cli/bin/python3']) fs.writeFileSync(path.join(directory, sub), '', {mode: 0o700});
    },
    run: async (executable, args) => args.some(value => value.endsWith('snowflake-install-worker.py')) ? '{"status":"installed_verified"}'
      : args.at(-1).includes('"version"') ? JSON.stringify({version: spec.python_version, machine: 'arm64'}) : '{"cli":"3.24.1"}'};
  await assert.rejects(installManagedRuntime({...options, run: async () => {throw new Error('INSTALL_VERIFICATION_FAILED');}}), /INSTALL_VERIFICATION_FAILED/);
  assert.equal(fs.readFileSync(pointer, 'utf8'), before);
  const result = await installManagedRuntime(options);
  assert.equal(result.status, 'installed_verified');
  const current = readManagedRuntime({home: f.home, platform: 'darwin'});
  assert.notEqual(current.runtime_id, previous.id);
  assert.equal(JSON.parse(fs.readFileSync(pointer, 'utf8')).previous_runtime_id, previous.id);
  assert.equal(fs.existsSync(previous.directory), true);
});

test('an interrupted known worker is reconciled and explicit retry reuses approval', t => {
  const f = fixture(t, {isProcessRunning: () => false});
  const first = f.jobs.start({dependencyId: 'snowflake', installationAuthorized: true});
  const file = path.join(f.settings.directory, 'snowflake.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')); value.worker_pid = 123;
  f.children[0].emit('close', 1);
  fs.writeFileSync(file, JSON.stringify(value), {mode: 0o600});
  const restart = new SetupDependencyInstallations(f.settings);
  assert.equal(restart.start({dependencyId: 'snowflake'}).code, 'INSTALLATION_INTERRUPTED');
  const retried = restart.start({dependencyId: 'snowflake', retryFailed: true});
  assert.equal(retried.approval_reused, true); assert.equal(f.calls.length, 2);
  f.setLocal(ready); f.children[1].emit('close', 0);
});
test('a dangling cache link is preserved and never followed', async t => {
  const f = fixture(t), cache = path.join(f.home, 'cache'); fs.mkdirSync(cache, {mode: 0o700});
  const asset = {url: 'https://github.com/astral-sh/python-build-standalone/releases/download/invented/runtime.tar.gz',
    sha256: 'a'.repeat(64), size: 3};
  const link = path.join(cache, asset.sha256 + '.tar.gz.partial');
  fs.symlinkSync(path.join(f.home, 'missing-file'), link);
  await assert.rejects(downloadRuntime(asset, cache, {fetcher: async () => {assert.fail('No download before file validation');}}), /INSTALL_RUNTIME_UNSAFE/);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runtimeSpec, runtimeSpecDigest, runtimeBases, assertPrivatePath, readManagedRuntime, privateJson, CURRENT_FILE} from './snowflake-managed-runtime.mjs';
import {downloadRuntime, extractRuntime} from './snowflake-runtime-download.mjs';

const ACTIVE_CHILDREN = new Set();
const WORKER = fileURLToPath(new URL('./snowflake-install-worker.py', import.meta.url));
const PHASES = new Set(['checking_prerequisites', 'downloading_python', 'verifying_python', 'installing_snowflake', 'verifying_snowflake', 'activating_runtime']);
const FAILURE = new Set(['INSTALL_NETWORK_FAILED', 'INSTALL_PERMISSION_DENIED', 'INSTALL_POLICY_BLOCKED', 'INSTALL_VERIFICATION_FAILED',
  'INSTALL_RUNTIME_UNSAFE', 'INSTALLATION_TIMEOUT', 'INSTALL_DOWNLOAD_INTEGRITY_FAILED', 'INSTALL_DISK_SPACE_LOW',
  'INSTALL_UNSUPPORTED_PLATFORM', 'INSTALL_ALREADY_RUNNING', 'INSTALL_RECIPE_INVALID']);

export function chooseRuntimeBase(home, platform, minimumBytes, {freeBytes = value => {
  const stat = fs.statfsSync(value); return Number(stat.bavail) * Number(stat.bsize);
}} = {}) {
  let failure = 'INSTALL_PERMISSION_DENIED';
  for (const base of runtimeBases({home, platform})) {
    try {
      assertPrivatePath(base, home, {create: true});
      fs.chmodSync(base, 0o700);
      const pointer = path.join(base, CURRENT_FILE);
      let pointerPresent = true;
      try {fs.lstatSync(pointer);} catch (error) {if (error.code === 'ENOENT') pointerPresent = false; else throw error;}
      if (pointerPresent) {
        const st = fs.lstatSync(pointer);
        const value = st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid() && !(st.mode & 0o077) && st.size < 16384
          ? JSON.parse(fs.readFileSync(pointer, 'utf8')) : null;
        if (value?.owner !== 'isma' || value.schema_version !== '1.0') throw new Error('INSTALL_RUNTIME_UNSAFE');
      }
      const probe = path.join(base, '.write-check-' + crypto.randomBytes(6).toString('hex'));
      const fd = fs.openSync(probe, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.closeSync(fd); fs.unlinkSync(probe);
      if (freeBytes(base) < minimumBytes) throw new Error('INSTALL_DISK_SPACE_LOW');
      return base;
    } catch (error) {
      if (error.message === 'INSTALL_DISK_SPACE_LOW') failure = error.message;
      else if (failure !== 'INSTALL_DISK_SPACE_LOW' && error.message === 'INSTALL_RUNTIME_UNSAFE') failure = error.message;
    }
  }
  throw new Error(failure);
}

export function acquireInstallLock(base, {pid = process.pid, alive = value => {
  try { process.kill(value, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}} = {}) {
  const file = path.join(base, '.snowflake-install.lock');
  if (fs.existsSync(file)) {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 1024) throw new Error('INSTALL_RUNTIME_UNSAFE');
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.owner !== 'isma' || !Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error('INSTALL_RUNTIME_UNSAFE');
    if (alive(old.pid)) throw new Error('INSTALL_ALREADY_RUNNING');
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  fs.writeFileSync(fd, JSON.stringify({owner: 'isma', pid}) + '\n'); fs.closeSync(fd);
  return () => {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (value.owner === 'isma' && value.pid === pid) fs.unlinkSync(file); } catch {}
  };
}

export function runPrivateProcess(executable, args, {environment = process.env, timeoutMs = 300000, spawnProcess = spawn} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, {shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...environment, PYTHONDONTWRITEBYTECODE: '1', SNOWFLAKE_CLI_LOGS_SAVE_LOGS: ''}});
    ACTIVE_CHILDREN.add(child);
    let output = '', errorOutput = '', finished = false, timedOut = false;
    child.stdout?.on('data', data => {output = (output + String(data)).slice(-16384);});
    child.stderr?.on('data', data => {errorOutput = (errorOutput + String(data)).slice(-4096);});
    const timer = setTimeout(() => {timedOut = true; try {process.kill(-child.pid, 'SIGTERM');} catch {child.kill('SIGTERM');}}, timeoutMs); timer.unref?.();
    const done = (code, failed) => {
      if (finished) return; finished = true; clearTimeout(timer); ACTIVE_CHILDREN.delete(child);
      if (timedOut) {reject(new Error('INSTALLATION_TIMEOUT')); return;}
      if (!failed && code === 0) { resolve(output); return; }
      for (const line of output.trim().split(/\r?\n/).reverse()) {
        try { const value = JSON.parse(line); if (FAILURE.has(value.code)) {reject(new Error(value.code)); return;} } catch {}
      }
      reject(new Error(/EACCES|permission denied|operation not permitted/i.test(errorOutput) ? 'INSTALL_PERMISSION_DENIED' : 'INSTALL_VERIFICATION_FAILED'));
    };
    child.on('error', () => done(null, true)); child.on('close', code => done(code, false));
  });
}

export async function installManagedRuntime({home = os.homedir(), platform = process.platform, arch = process.arch,
  progress = () => {}, download = downloadRuntime, extract = extractRuntime, run = runPrivateProcess,
  choose = chooseRuntimeBase, lock = acquireInstallLock} = {}) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('INSTALL_UNSUPPORTED_PLATFORM');
  const phase = value => {if (PHASES.has(value)) progress(value);};
  phase('checking_prerequisites');
  const spec = runtimeSpec(), digest = runtimeSpecDigest(), target = spec.targets[platform + '-' + arch];
  const base = choose(home, platform, spec.minimum_free_bytes);
  const releaseLock = lock(base);
  let generation = null;
  try {
    const cache = path.join(base, 'downloads');
    assertPrivatePath(cache, home, {create: true}); fs.chmodSync(cache, 0o700);
    phase('downloading_python');
    const archive = await download(target, cache);
    const prefix = 'py' + spec.python_version + '-snow' + spec.snowflake_version + '-' + arch + '-';
    generation = fs.mkdtempSync(path.join(base, prefix)); fs.chmodSync(generation, 0o700);
    privateJson(path.join(generation, 'runtime-receipt.json'), {schema_version: '1.0', owner: 'isma',
      runtime_id: path.basename(generation), recipe_digest: digest, state: 'preparing'});
    extract(archive, generation);
    const python = path.join(generation, 'python', 'bin', 'python3.12');
    phase('verifying_python');
    const probe = JSON.parse(await run(python, ['-I', '-B', '-c',
      'import json,sys,platform,ssl,venv,ensurepip; print(json.dumps({"version":platform.python_version(),"machine":platform.machine()}))'],
      {timeoutMs: 30000}));
    if (probe.version !== spec.python_version || (arch === 'arm64' ? !['arm64', 'aarch64'].includes(probe.machine) : probe.machine !== 'x86_64')) throw new Error('INSTALL_VERIFICATION_FAILED');
    phase('installing_snowflake');
    const installed = JSON.parse((await run(python, ['-I', '-B', WORKER, '--runtime-directory', path.join(generation, 'cli'), '--target', platform + '-' + arch])).trim());
    if (installed.status !== 'installed_verified') throw new Error('INSTALL_VERIFICATION_FAILED');
    phase('verifying_snowflake');
    const cliPython = path.join(generation, 'cli', 'bin', 'python3');
    const version = JSON.parse(await run(cliPython, ['-I', '-B', '-c',
      'import json,importlib.metadata,tomllib,snowflake.cli,snowflake.connector; print(json.dumps({"cli":importlib.metadata.version("snowflake-cli")}))'], {timeoutMs: 30000}));
    if (version.cli !== spec.snowflake_version) throw new Error('INSTALL_VERIFICATION_FAILED');
    const previous = readManagedRuntime({home, platform});
    const receipt = {schema_version: '1.0', owner: 'isma', runtime_id: path.basename(generation),
      recipe_digest: digest, python_version: spec.python_version, snowflake_version: spec.snowflake_version, state: 'verified'};
    privateJson(path.join(generation, 'runtime-receipt.json'), receipt);
    phase('activating_runtime');
    privateJson(path.join(base, CURRENT_FILE), {schema_version: '1.0', owner: 'isma',
      runtime_id: receipt.runtime_id, recipe_digest: digest, ...(previous ? {previous_runtime_id: previous.runtime_id} : {})});
    return {status: 'installed_verified', source_access_verified: false, configuration_changed: false};
  } catch (error) {
    if (generation) {
      try { privateJson(path.join(generation, 'runtime-receipt.json'), {schema_version: '1.0', owner: 'isma',
        runtime_id: path.basename(generation), recipe_digest: runtimeSpecDigest(), state: 'failed',
        code: FAILURE.has(error.message) ? error.message : 'INSTALL_VERIFICATION_FAILED'}); } catch {}
    }
    throw error;
  } finally {releaseLock();}
}

async function main() {
  process.umask(0o077);
  process.once('SIGTERM', () => {
    for (const child of ACTIVE_CHILDREN) {try {process.kill(-child.pid, 'SIGTERM');} catch {child.kill('SIGTERM');}}
    process.stdout.write(JSON.stringify({status: 'failed', code: 'INSTALLATION_TIMEOUT'}) + '\n');
    process.exit(1);
  });
  const args = process.argv.slice(2);
  const homeAt = args.indexOf('--home'), archAt = args.indexOf('--arch');
  if (args.length !== 4 || homeAt < 0 || archAt < 0 || !path.isAbsolute(args[homeAt + 1])) throw new Error('INSTALL_RECIPE_INVALID');
  const result = await installManagedRuntime({home: args[homeAt + 1], arch: args[archAt + 1],
    progress: phase => process.stdout.write(JSON.stringify({phase}) + '\n')});
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = FAILURE.has(error.message) ? error.message : ['EACCES', 'EPERM'].includes(error.code) ? 'INSTALL_PERMISSION_DENIED' : 'INSTALL_VERIFICATION_FAILED';
    process.stdout.write(JSON.stringify({status: 'failed', code}) + '\n'); process.exitCode = 1;
  });
}

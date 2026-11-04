import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const SPEC_PATH = fileURLToPath(new URL('../config/snowflake-managed-runtime.json', import.meta.url));
export const CURRENT_FILE = 'current-snowflake-runtime.json';
const ID = /^py3\.12\.\d+-snow3\.24\.1-(?:arm64|x64)-[a-zA-Z0-9_-]{6,32}$/;

export function runtimeSpec() {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  if (spec.schema_version !== '1.0' || spec.provider !== 'astral-python-build-standalone'
    || !/^3\.12\.\d+$/.test(spec.python_version) || spec.snowflake_version !== '3.24.1') throw new Error('INSTALL_RECIPE_INVALID');
  for (const key of ['darwin-arm64', 'darwin-x64']) {
    const target = spec.targets[key];
    const url = new URL(target.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com'
      || !url.pathname.startsWith('/astral-sh/python-build-standalone/releases/download/')
      || !target.archive.endsWith('-apple-darwin-install_only_stripped.tar.gz')
      || decodeURIComponent(url.pathname.split('/').pop()) !== target.archive
      || !/^[a-f0-9]{64}$/.test(target.sha256) || !Number.isSafeInteger(target.size)
      || target.size < 1000000 || target.size > 100000000
      || !/^[a-f0-9]{64}$/.test(target.requirements_sha256)
      || target.requirements !== 'snowflake-runtime-lock-' + key + '.txt') throw new Error('INSTALL_RECIPE_INVALID');
    const lock = fileURLToPath(new URL('../config/' + target.requirements, import.meta.url));
    if (crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex') !== target.requirements_sha256) throw new Error('INSTALL_RECIPE_INVALID');
  }
  return spec;
}

export function runtimeSpecDigest() {
  return crypto.createHash('sha256').update(fs.readFileSync(SPEC_PATH)).digest('hex');
}

export function runtimeBases({home = os.homedir(), platform = process.platform} = {}) {
  return platform === 'darwin'
    ? [path.join(home, 'Library', 'Application Support', 'ISMA', 'runtimes'),
      path.join(home, '.local', 'share', 'isma', 'runtimes')]
    : [path.join(home, '.local', 'share', 'isma', 'runtimes')];
}

export function assertPrivatePath(target, home, {create = false} = {}) {
  const relative = path.relative(home, target);
  if (!path.isAbsolute(home) || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('INSTALL_RUNTIME_UNSAFE');
  const pieces = [home, ...relative.split(path.sep).filter(Boolean).map((_, i, all) => path.join(home, ...all.slice(0, i + 1)))];
  for (const entry of pieces) {
    if (!fs.existsSync(entry)) {
      if (fs.lstatSync(path.dirname(entry)).isSymbolicLink()) throw new Error('INSTALL_RUNTIME_UNSAFE');
      if (create) fs.mkdirSync(entry, {mode: 0o700}); else continue;
    }
    if (!fs.existsSync(entry)) continue;
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()
      || (stat.mode & 0o022)) throw new Error('INSTALL_RUNTIME_UNSAFE');
  }
}

function safeJson(file, maximum = 16384) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) || stat.size > maximum) throw new Error('INSTALL_RUNTIME_UNSAFE');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readManagedRuntime({home = os.homedir(), platform = process.platform} = {}) {
  for (const base of runtimeBases({home, platform})) {
    try {
      assertPrivatePath(base, home);
      const value = safeJson(path.join(base, CURRENT_FILE));
      if (value.schema_version !== '1.0' || value.owner !== 'isma' || !ID.test(value.runtime_id)
        || !/^[a-f0-9]{64}$/.test(value.recipe_digest)) continue;
      const directory = path.join(base, value.runtime_id);
      assertPrivatePath(directory, home);
      const receipt = safeJson(path.join(directory, 'runtime-receipt.json'));
      if (receipt.state !== 'verified' || receipt.owner !== 'isma' || receipt.runtime_id !== value.runtime_id
        || receipt.recipe_digest !== value.recipe_digest) continue;
      const python = path.join(directory, 'python', 'bin', 'python3.12');
      const command = path.join(directory, 'cli', 'bin', 'snow');
      for (const executable of [python, command]) {
        const real = fs.realpathSync(executable);
        if (!real.startsWith(directory + path.sep) || !fs.statSync(real).isFile()) throw new Error('INSTALL_RUNTIME_UNSAFE');
        fs.accessSync(real, fs.constants.X_OK);
      }
      return {directory, python, command, base, runtime_id: value.runtime_id, recipe_digest: value.recipe_digest};
    } catch {}
  }
  return null;
}

export function privateJson(file, value) {
  let present = true;
  try {fs.lstatSync(file);} catch (error) {if (error.code === 'ENOENT') present = false; else throw error;}
  if (present) {
    const current = safeJson(file);
    if (current.owner !== 'isma' || current.schema_version !== '1.0') throw new Error('INSTALL_RUNTIME_UNSAFE');
  }
  const temporary = file + '.new-' + crypto.randomBytes(8).toString('hex');
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

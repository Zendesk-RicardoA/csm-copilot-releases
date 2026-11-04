import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BetaError} from './core.mjs';
import {readManagedRuntime} from './snowflake-managed-runtime.mjs';

function searchDirectories({home = os.homedir(), environment = process.env, platform = process.platform, extraSearchDirectories} = {}) {
  return [...new Set([
    ...(environment.PATH || '').split(path.delimiter).filter(value => path.isAbsolute(value)),
    ...(extraSearchDirectories || (platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])),
    path.join(home, '.local', 'bin'),
    path.join(home, '.local', 'share', 'isma', 'snowflake-runtime', platform === 'win32' ? 'Scripts' : 'bin'),
  ])];
}

export function resolveSnowflakeCommand(options = {}) {
  const managed = readManagedRuntime(options);
  if (managed) return managed.command;
  for (const directory of searchDirectories(options)) {
    const executable = path.join(directory, 'snow');
    try { if (fs.statSync(executable).isFile()) { fs.accessSync(executable, fs.constants.X_OK); return executable; } } catch {}
  }
  return null;
}

export function resolveSnowflakePython(options = {}) {
  const environment = options.environment || process.env;
  const override = environment.CSM_COPILOT_SNOWFLAKE_PYTHON;
  if (override) {
    if (isPythonExecutable(override)) return override;
    throw unsupportedRuntime();
  }
  const managedRuntime = readManagedRuntime(options);
  if (managedRuntime) return path.join(managedRuntime.directory, 'cli', 'bin', 'python3');
  const executable = resolveSnowflakeCommand(options);
  if (!executable) throw new BetaError('SNOWFLAKE_CLI_NOT_INSTALLED', 'The local Snowflake software is missing. Ask permission to install it before company sign-in.', {failure_stage: 'cli_start'});
  // The managed serial reader uses the same Python environment as the CLI.
  // A standalone binary must not be guessed to be a Python interpreter.
  const descriptor = fs.openSync(executable, 'r');
  let firstLine;
  try { const buffer = Buffer.alloc(1024); const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0); firstLine = buffer.subarray(0, size).toString('utf8').split(/\r?\n/, 1)[0]; }
  finally { fs.closeSync(descriptor); }
  const match = /^#!([^\s]+)$/.exec(firstLine);
  if (match && isPythonExecutable(match[1])) return match[1];
  // Homebrew may expose a shell launcher while keeping the CLI's Python
  // environment inside the same formula. Only that exact formula-owned
  // environment is eligible; never run the worker with the shell launcher.
  const formulaPython = homebrewFormulaPython(executable);
  if (formulaPython) return formulaPython;
  const managed = path.join(options.home || os.homedir(), '.local', 'share', 'isma', 'snowflake-runtime');
  if (path.resolve(executable) === path.join(managed, 'bin', 'snow') && !fs.lstatSync(managed).isSymbolicLink()) {
    const python = path.join(managed, 'bin', 'python3');
    if (isPythonExecutable(python)) return python;
  }
  throw unsupportedRuntime();
}

function unsupportedRuntime() {
  return new BetaError('SNOWFLAKE_RUNTIME_UNSUPPORTED', 'The installed Snowflake CLI does not expose a supported Python runtime. Keep the existing configuration and ask the beta owner to review this installation.', {failure_stage: 'local_runtime'});
}

function isPythonExecutable(executable) {
  if (!path.isAbsolute(executable) || !/^python(?:3(?:\.\d+)?)?$/.test(path.basename(executable))) return false;
  try { fs.accessSync(executable, fs.constants.X_OK); return fs.statSync(executable).isFile(); } catch { return false; }
}

function homebrewFormulaPython(executable) {
  let real;
  try { real = fs.realpathSync(executable); } catch { return null; }
  const match = /^(.*\/Cellar\/snowflake-cli\/[^/]+)\/(?:bin|libexec\/bin)\/snow$/.exec(real);
  if (!match) return null;
  for (const name of ['python3', 'python']) {
    const candidate = path.join(match[1], 'libexec', 'bin', name);
    if (isPythonExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveSnowflakeConfigPath({home = os.homedir(), environment = process.env, platform = process.platform} = {}) {
  if (environment.SNOWFLAKE_HOME && path.isAbsolute(environment.SNOWFLAKE_HOME)) return path.join(environment.SNOWFLAKE_HOME, 'config.toml');
  const legacy = path.join(home, '.snowflake', 'config.toml');
  if (fs.existsSync(legacy)) return legacy;
  // Do not change an existing CLI installation's system-specific configuration.
  const system = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'snowflake', 'config.toml')
    : path.join(home, '.config', 'snowflake', 'config.toml');
  return fs.existsSync(system) ? system : legacy;
}

export function snowflakeEnvironment(environment = process.env, options = {}) {
  const env = {...environment, SNOWFLAKE_CLI_LOGS_SAVE_LOGS: ''};
  delete env.NO_COLOR;
  // Desktop launches may not inherit the interactive shell's Homebrew PATH.
  // This per-child environment changes no shell profile or global setting.
  env.PATH = searchDirectories({...options, environment}).join(path.delimiter);
  return env;
}

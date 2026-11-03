// Exact-release acquisition. Public repositories need no GitHub account.
// Private repositories reuse existing authentication without exposing it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {BetaError} from './core.mjs';

const MAXIMUM = 2 * 1024 * 1024;
const TIMEOUT = 25000;
const ASSET = 'private-setup.json';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new BetaError(code, message); };
const encode = value => JSON.stringify(value, null, 2) + '\n';
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_TRACE|GCM_TRACE|GH_DEBUG|NODE_DEBUG)/i.test(key)));

function executable(name) {
  const candidates = [name, path.join(os.homedir(), '.local/bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, '/usr/bin/' + name];
  if (name === 'codex') candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex');
  return candidates;
}

// Never return command output in errors: credential helpers can include secrets.
export function runSetupCommand(name, args, input, run = spawnSync) {
  if (typeof process === 'undefined') fail('MARKETPLACE_SETUP_STANDALONE_REQUIRED', 'Run release acquisition with the existing desktop Node executable as a standalone child process.');
  for (const candidate of executable(name)) {
    let result;
    try { result = run(candidate, args, {encoding: 'utf8', input, timeout: TIMEOUT, maxBuffer: MAXIMUM,
      windowsHide: true, shell: false, env: {...cleanEnvironment(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'}}); }
    catch { continue; }
    if (result.error?.code === 'ENOENT') continue;
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout;
  }
  return null;
}

export function registeredGitHubRepository(metadata, listing) {
  const matches = listing?.marketplaces?.filter(item => item.name === metadata.name) || [];
  if (matches.length !== 1 || matches[0].marketplaceSource?.sourceType !== 'git')
    fail('MARKETPLACE_SETUP_SOURCE_REQUIRED', 'This installation is not registered through its GitHub marketplace. Preserve private settings, use the supplied repository’s exact HTTPS clone URL to replace only this marketplace registration with the supported Git source, update the same plugin, then resume setup. Do not guess a repository URL or fall back to a pasted setup file.');
  const source = matches[0].marketplaceSource.source;
  if (typeof source !== 'string') fail('MARKETPLACE_SETUP_SOURCE_REQUIRED', 'The registered marketplace has no supported GitHub source.');
  // Accept only ordinary HTTPS or Git SSH repository coordinates; no URL credentials or commands.
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99}?)\/?$/.exec(source);
  const repository = match?.[2]?.replace(/\.git$/, '');
  if (!match || !repository || repository === '.' || repository === '..')
    fail('MARKETPLACE_SETUP_SOURCE_REQUIRED', 'Use the registered GitHub repository without credentials, query strings or extra paths.');
  return {owner: match[1], repository};
}

export function existingGitHubToken(repository, command = runSetupCommand) {
  const gh = command('gh', ['auth', 'token', '--hostname', 'github.com']);
  if (typeof gh === 'string' && /^[\x21-\x7e]{8,4096}$/.test(gh.trim())) return gh.trim();
  const credential = command('git', ['-c', 'credential.interactive=false', 'credential', 'fill'],
    `protocol=https\nhost=github.com\npath=${repository.owner}/${repository.repository}.git\n\n`);
  const password = credential?.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
  if (password && /^[\x21-\x7e]{8,4096}$/.test(password)) return password;
  fail('MARKETPLACE_SETUP_GITHUB_SIGN_IN_REQUIRED', 'Sign in to GitHub for the same account used to install this private marketplace, then resume setup. Never paste a token into chat.');
}

async function boundedBody(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM))
    fail('MARKETPLACE_SETUP_DOWNLOAD_TOO_LARGE', 'The release response exceeds the bounded setup download size.');
  const chunks = []; let length = 0;
  if (!response.body) fail('MARKETPLACE_SETUP_DOWNLOAD_INVALID', 'GitHub returned an empty setup response.');
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > MAXIMUM) { await response.body.cancel?.().catch(() => {}); fail('MARKETPLACE_SETUP_DOWNLOAD_TOO_LARGE', 'The setup download exceeds its size limit.'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function githubSetupClient(token = null, fetcher = fetch, {timeoutMs = TIMEOUT} = {}) {
  async function request(route, binary = false) {
    let url = new URL('https://api.github.com' + route);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const allowed = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const headers = {Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'};
        if (token && url.origin === 'https://api.github.com') headers.Authorization = 'Bearer ' + token;
        const response = await fetcher(url.href, {method: 'GET', redirect: 'manual', signal: controller.signal, headers});
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!binary || !location) fail('MARKETPLACE_SETUP_DOWNLOAD_INVALID', 'GitHub returned an unsupported release redirect.');
          const next = new URL(location, url);
          if (next.protocol !== 'https:' || next.port || next.username || next.password || !allowed.has(next.hostname))
            fail('MARKETPLACE_SETUP_DOWNLOAD_INVALID', 'The setup download redirect is outside the supported GitHub asset hosts.');
          await response.body?.cancel(); url = next; continue;
        }
        if (response.status === 401) fail('MARKETPLACE_SETUP_GITHUB_SIGN_IN_REQUIRED', 'GitHub sign-in has expired. Sign in with the account that can read this marketplace, then resume setup.');
        if (response.status === 403 || response.status === 429) fail('MARKETPLACE_SETUP_GITHUB_ACCESS_BLOCKED', 'GitHub denied this read or temporarily rate-limited it. Check repository and company SSO access or the GitHub rate limit; do not reinstall.');
        if (response.status === 404) fail('MARKETPLACE_SETUP_RELEASE_UNAVAILABLE', 'The repository or matching release is unavailable. Check the registered repository URL and ask the release owner to verify this exact version. Private repositories also require repository access.');
        if (response.status !== 200) fail('MARKETPLACE_SETUP_DOWNLOAD_FAILED', 'GitHub could not complete this release read. Resume after the service is available.');
        const bytes = await boundedBody(response);
        if (binary) return bytes;
        try { return JSON.parse(bytes.toString('utf8')); }
        catch { fail('MARKETPLACE_SETUP_DOWNLOAD_INVALID', 'GitHub returned invalid release metadata.'); }
      }
      fail('MARKETPLACE_SETUP_DOWNLOAD_INVALID', 'The setup download exceeded its redirect limit.');
    } catch (error) {
      if (error instanceof BetaError) throw error;
      fail(controller.signal.aborted ? 'MARKETPLACE_SETUP_DOWNLOAD_TIMEOUT' : 'MARKETPLACE_SETUP_DOWNLOAD_FAILED',
        controller.signal.aborted ? 'The setup download timed out. Resume this same setup after checking connectivity.' : 'The setup download failed. Check connectivity, then resume the same setup.');
    } finally { clearTimeout(timer); }
  }
  return {json: route => request(route), bytes: route => request(route, true)};
}

function safeDirectory(directory, create = false) {
  if (!fs.existsSync(directory) && !fs.lstatSync(directory, {throwIfNoEntry: false})) {
    if (create) fs.mkdirSync(directory, {mode: 0o700});
    else return;
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || typeof process.getuid === 'function' && stat.uid !== process.getuid() || stat.mode & 0o022)
    fail('MARKETPLACE_SETUP_UNSAFE', 'Use an operator-owned private setup directory without symbolic links or shared write access.');
}
function privateFile(file) {
  const stat = fs.lstatSync(file, {throwIfNoEntry: false});
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAXIMUM || stat.mode & 0o077
      || typeof process.getuid === 'function' && stat.uid !== process.getuid())
    fail('MARKETPLACE_SETUP_UNSAFE', 'The setup cache must contain bounded, owner-only regular files.');
  return true;
}

export async function downloadMatchingSetup(options) {
  const {metadata, stateDirectory, verifySetup, inspectSetup} = options;
  const inspection = inspectSetup();
  if (inspection.state === 'configured') return {...inspection, download_required: false};
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,159}$/.test(metadata.version))
    fail('MARKETPLACE_SETUP_INVALID', 'The installed plugin version cannot select a bounded release.');
  const tag = `${metadata.name}-setup-v${metadata.version}`;
  const command = options.command || runSetupCommand;
  let listing = options.marketplaceListing;
  if (!listing) {
    try { listing = JSON.parse(command('codex', ['plugin', 'marketplace', 'list', '--json'])); }
    catch { /* a safe source error follows */ }
  }
  const repository = registeredGitHubRepository(metadata, listing);
  const sourceDigest = hash(repository.owner.toLowerCase() + '/' + repository.repository.toLowerCase());
  const directory = path.join(stateDirectory, '.setup-downloads', metadata.version);
  const setupFile = path.join(directory, ASSET), receiptFile = path.join(directory, 'receipt.json');
  const directories = [path.dirname(stateDirectory), stateDirectory, path.dirname(directory), directory];
  for (const dir of directories) safeDirectory(dir);
  const output = state => ({state, package_version: metadata.version, setup_file: setupFile, verified: true,
    configuration_changed: false, customer_data_read: false, drafts_created: false, restart_required: false,
    next_action: 'Apply this verified local setup with the user’s own company login hint under the existing local setup authorization.'});
  if (privateFile(setupFile) && privateFile(receiptFile)) {
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (receipt.package_version === metadata.version && receipt.source_digest === sourceDigest && receipt.release_tag === tag
          && receipt.sha256 === hash(fs.readFileSync(setupFile))) { verifySetup(setupFile); return output('cached'); }
    } catch { /* Reacquire a damaged cache, without importing it. */ }
  }
  const base = `/repos/${repository.owner}/${repository.repository}`;
  let client = options.client || githubSetupClient(null, options.fetcher);
  let repo;
  try { repo = await client.json(base); }
  catch (error) {
    // Discover visibility before touching a credential helper. A public install
    // never needs gh, a GitHub profile, or a stored/possibly expired token.
    // Only repository discovery can fall back to private authentication; a
    // missing public release or a rate limit must not become a sign-in loop.
    if (options.client || !['MARKETPLACE_SETUP_RELEASE_UNAVAILABLE', 'MARKETPLACE_SETUP_GITHUB_SIGN_IN_REQUIRED'].includes(error.code)) throw error;
    client = githubSetupClient(existingGitHubToken(repository, command), options.fetcher);
    repo = await client.json(base);
  }
  if (typeof repo.private !== 'boolean' || repo.full_name?.toLowerCase() !== `${repository.owner}/${repository.repository}`.toLowerCase())
    fail('MARKETPLACE_SETUP_REPOSITORY_INVALID', 'Setup controls must come from the exact registered GitHub repository.');
  const release = await client.json(base + '/releases/tags/' + encodeURIComponent(tag));
  const assets = release.assets?.filter(asset => asset.name === ASSET) || [];
  if (release.draft !== false || release.tag_name !== tag || assets.length !== 1 || assets[0].state !== 'uploaded'
      || !Number.isSafeInteger(assets[0].id) || assets[0].id <= 0 || !Number.isSafeInteger(assets[0].size)
      || assets[0].size < 1 || assets[0].size > MAXIMUM || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest))
    fail('MARKETPLACE_SETUP_RELEASE_INVALID', 'The exact published release must contain one complete matching setup asset with a SHA-256 digest.');
  const bytes = await client.bytes(base + '/releases/assets/' + assets[0].id);
  const digest = hash(bytes);
  if (bytes.length !== assets[0].size || 'sha256:' + digest !== assets[0].digest)
    fail('MARKETPLACE_SETUP_DOWNLOAD_MISMATCH', 'The downloaded setup size or SHA-256 digest does not match GitHub’s release metadata.');
  for (const dir of directories) safeDirectory(dir, true);
  const temporary = path.join(directory, '.download-' + crypto.randomBytes(12).toString('hex'));
  const temporaryReceipt = temporary + '.receipt';
  try {
    fs.writeFileSync(temporary, bytes, {mode: 0o600, flag: 'wx'});
    verifySetup(temporary); // Full installed-file inventory, release proof and control policy before import.
    fs.writeFileSync(temporaryReceipt, encode({schema_version: '1.0', package_version: metadata.version,
      release_tag: tag, source_digest: sourceDigest, sha256: digest}), {mode: 0o600, flag: 'wx'});
    privateFile(setupFile); privateFile(receiptFile);
    fs.renameSync(temporary, setupFile); fs.renameSync(temporaryReceipt, receiptFile);
  } finally {
    for (const file of [temporary, temporaryReceipt]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return output('downloaded');
}

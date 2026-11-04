import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';

const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
export function assertDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password) throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
  return url.href;
}
function privateFile(file) {
  let stat;
  try {stat = fs.lstatSync(file);} catch (error) {if (error.code === 'ENOENT') return; throw error;}
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('INSTALL_RUNTIME_UNSAFE');
}
export async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}
export async function downloadRuntime(asset, cache, {fetcher = fetch} = {}) {
  const complete = path.join(cache, asset.sha256 + '.tar.gz');
  const partial = complete + '.partial';
  privateFile(complete); privateFile(partial);
  if (fs.existsSync(complete)) {
    if (fs.statSync(complete).size === asset.size && await fileDigest(complete) === asset.sha256) return complete;
    fs.renameSync(complete, complete + '.rejected-' + crypto.randomBytes(4).toString('hex'));
    throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
  }
  let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  if (offset > asset.size) {
    fs.renameSync(partial, partial + '.rejected-' + crypto.randomBytes(4).toString('hex'));
    throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
  }
  if (offset < asset.size) {
    let url = assertDownloadUrl(asset.url), response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      try {
        response = await fetcher(url, {redirect: 'manual', signal: AbortSignal.timeout(180000),
          headers: {'accept-encoding': 'identity', ...(offset ? {Range: 'bytes=' + offset + '-'} : {})}});
      } catch { throw new Error('INSTALL_NETWORK_FAILED'); }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('INSTALL_NETWORK_FAILED');
      url = assertDownloadUrl(new URL(location, url).href);
    }
    if (response.status === 200) offset = 0;
    else if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (!range || Number(range[1]) !== offset || Number(range[3]) !== asset.size) throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
    } else throw new Error('INSTALL_NETWORK_FAILED');
    if (!response.body) throw new Error('INSTALL_NETWORK_FAILED');
    let size = offset;
    const bound = new Transform({transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(size > asset.size ? new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED') : null, chunk);
    }});
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (offset ? fs.constants.O_APPEND : fs.constants.O_TRUNC) | fs.constants.O_NOFOLLOW;
    try {
      await pipeline(Readable.fromWeb(response.body), bound, fs.createWriteStream(partial, {flags, mode: 0o600}));
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('INSTALL_PERMISSION_DENIED');
      if (error.message === 'INSTALL_DOWNLOAD_INTEGRITY_FAILED') throw error;
      throw new Error('INSTALL_NETWORK_FAILED');
    }
    if (size !== asset.size) throw new Error('INSTALL_NETWORK_FAILED');
  }
  if (await fileDigest(partial) !== asset.sha256) {
    fs.renameSync(partial, partial + '.rejected-' + crypto.randomBytes(4).toString('hex'));
    throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
  }
  fs.renameSync(partial, complete);
  return complete;
}

export function validateArchiveEntries(listing) {
  const names = listing.trim().split(/\r?\n/).filter(Boolean);
  if (!names.length || names.length > 20000) throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
  for (const name of names) {
    const parts = name.split('/');
    if (parts[0] !== 'python' || parts.includes('..') || name.includes('\\')
      || /[\u0000-\u001f]/.test(name) || path.posix.isAbsolute(name)) throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
  }
  return names.length;
}
export function validateArchiveLinks(listing) {
  for (const line of listing.trim().split(/\r?\n/)) {
    if (!line) continue;
    if (!['-', 'd', 'l', 'h'].includes(line[0])) throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
    if (line[0] !== 'l' && line[0] !== 'h') continue;
    const match = /\s(python\/.+?) (?:->|link to) (.+)$/.exec(line);
    if (!match || path.posix.isAbsolute(match[2])) throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
    const resolved = line[0] === 'h' ? path.posix.normalize(match[2])
      : path.posix.normalize(path.posix.join(path.posix.dirname(match[1]), match[2]));
    if (!resolved.startsWith('python/')) throw new Error('INSTALL_DOWNLOAD_INTEGRITY_FAILED');
  }
}
export function extractRuntime(archive, destination, {runner = spawnSync} = {}) {
  const run = args => {
    const result = runner('/usr/bin/tar', args, {encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, shell: false});
    if (result.error || result.status !== 0) throw new Error('INSTALL_VERIFICATION_FAILED');
    return result.stdout;
  };
  validateArchiveEntries(run(['-tzf', archive]));
  validateArchiveLinks(run(['-tvzf', archive]));
  run(['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', destination]);
}

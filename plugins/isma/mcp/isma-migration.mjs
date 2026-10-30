// Same-person, local-only settings migration. Never migrate cases, approvals,
// transient evidence or another person's identity into a distributable bundle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BetaError } from './core.mjs';

export const LEGACY_NAMESPACES = Object.freeze(['csm-copilot-candidate-live', 'csm-copilot-test-live']);
export const PRIVATE_SETTINGS = Object.freeze(['credential-state.json', 'presenter-profile.json',
  'gmail-signature-profile.json', 'approved-recovery-design.json', 'presentation-preferences.json',
  'google-oauth-client.json', 'google-oauth-token.json', 'google-shared-sources-oauth-token.json',
  'renderer-client.json', 'snowflake-setup-handoff.json', 'account-access-mode.json']);

function regularPrivate(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024
    || process.getuid && stat.uid !== process.getuid()) throw new BetaError('MIGRATION_UNSAFE_FILE', 'Migrate only bounded regular settings owned by this signed-in laptop user.');
  return stat;
}
function safeDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new BetaError('MIGRATION_UNSAFE_DIRECTORY', 'The private settings directory must belong to this laptop user and cannot be a symbolic link.');
}
export function planIsmaMigration({ codexDirectory = path.join(os.homedir(), '.codex'), sourceNamespace = null } = {}) {
  sourceNamespace ||= LEGACY_NAMESPACES.find(namespace => fs.existsSync(path.join(codexDirectory, namespace))) || LEGACY_NAMESPACES[0];
  if (!LEGACY_NAMESPACES.includes(sourceNamespace)) throw new BetaError('INVALID_MIGRATION_SOURCE', 'Select the installed Candidate or Test settings, not another path or person.');
  safeDirectory(codexDirectory);
  const target = path.join(codexDirectory, 'isma-live'); safeDirectory(target);
  const existing = LEGACY_NAMESPACES.filter(namespace => fs.existsSync(path.join(codexDirectory, namespace)));
  for (const namespace of existing) safeDirectory(path.join(codexDirectory, namespace));
  const source = path.join(codexDirectory, sourceNamespace);
  const files = PRIVATE_SETTINGS.filter(name => fs.existsSync(path.join(source, name)));
  for (const name of files) regularPrivate(path.join(source, name));
  const conflicts = files.filter(name => fs.existsSync(path.join(target, name))
    && (regularPrivate(path.join(target, name)), !fs.readFileSync(path.join(target, name)).equals(fs.readFileSync(path.join(source, name)))));
  return { state: conflicts.length ? 'conflict' : existing.length ? 'migration_available' : 'new_installation',
    source_namespace: sourceNamespace, settings_to_preserve: files, conflicting_settings: conflicts,
    legacy_namespaces: existing, settings_content_returned: false, cases_or_approvals_migrated: false,
    signature_handling: 'gmail_native', legacy_plugins_removed: false };
}
export function applyIsmaMigration({ migrationAuthorized = false, ...options } = {}) {
  if (migrationAuthorized !== true) throw new BetaError('MIGRATION_AUTHORIZATION_REQUIRED', 'Authorize local ISMA installation and settings migration before copying private files.');
  const plan = planIsmaMigration(options);
  if (plan.state === 'conflict') throw new BetaError('MIGRATION_SETTINGS_CONFLICT', 'ISMA already has different settings. Existing files were preserved; review the conflicting settings before changing them.', { conflicting_settings: plan.conflicting_settings });
  const root = options.codexDirectory || path.join(os.homedir(), '.codex');
  const target = path.join(root, 'isma-live');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const backupRoot = path.join(root, 'isma-migration-backups'); safeDirectory(backupRoot);
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = fs.mkdtempSync(path.join(backupRoot, 'before-isma-'));
  for (const namespace of plan.legacy_namespaces) {
    const destination = path.join(backup, namespace); fs.mkdirSync(destination, { mode: 0o700 });
    for (const name of PRIVATE_SETTINGS) {
      const file = path.join(root, namespace, name);
      if (!fs.existsSync(file)) continue;
      regularPrivate(file);
      fs.copyFileSync(file, path.join(destination, name), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(destination, name), 0o600);
    }
  }
  for (const name of plan.settings_to_preserve) {
    const file = path.join(target, name);
    if (fs.existsSync(file)) continue;
    fs.copyFileSync(path.join(root, plan.source_namespace, name), file, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file, 0o600);
  }
  return { ...plan, state: 'settings_preserved', backup_created: true, settings_content_returned: false,
    source_access_verified: false, next_action: 'Install and verify the exact ISMA package before removing either legacy plugin. Sign in as yourself if verification requests it. Old cases remain version-bound and grant no approval to ISMA.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'inspect') console.log(JSON.stringify(planIsmaMigration()));
    else if (process.argv[2] === 'apply') {
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      if (Object.keys(input).some(key => !['migration_authorized', 'source_namespace'].includes(key))) throw new BetaError('INVALID_INPUT', 'Use only local migration approval and the legacy namespace.');
      console.log(JSON.stringify(applyIsmaMigration({ migrationAuthorized: input.migration_authorized, sourceNamespace: input.source_namespace })));
    } else throw new BetaError('INVALID_INPUT', 'Use inspect or apply.');
  } catch (error) { console.error(JSON.stringify({ state: 'blocked', code: error.code || 'MIGRATION_FAILED', message: error.code ? error.message : 'Migration could not complete; previous private settings were preserved.' })); process.exitCode = 1; }
}

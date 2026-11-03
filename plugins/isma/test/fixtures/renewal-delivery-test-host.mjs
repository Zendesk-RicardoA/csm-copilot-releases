// Invented-only transport used by the coordinator regressions and blind model proxy.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function startInventedRenewalHost(directory, { scenario = 'base', collectionDelayMs = 80 } = {}) {
  const temp = path.resolve(directory);
  if (temp === plugin || temp.startsWith(plugin + path.sep) || fs.lstatSync(temp).isSymbolicLink()) throw new Error('Use an isolated invented directory.');
  const write = (name, value) => fs.writeFileSync(path.join(temp, name), JSON.stringify(value), { mode: 0o600 });
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'config/approved-version-manifest.json'), 'utf8'));
  // A disposable invented-data fixture, not a renewal of any installed approval.
  manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
  manifest.status = 'approved_for_limited_beta';
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
  write('invented-manifest.json', manifest);
  write('invented-runtime.json', { mode: 'limited_beta', renderer_mode: 'manual_bound_script',
    identity: { state: 'connected', verified: true, provider: 'invented_sso', subject: 'invented-delivery-owner' },
    snowflake: { state: 'connected', read_only_verified: true }, organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true, private_draft_google_scope: true,
      approved_renderer_execution: true, retention_policy: true, operational_support: true } });
  const child = spawn(process.execPath, ['--experimental-loader', new URL('./renewal-delivery-synthetic-loader.mjs', import.meta.url).href,
    path.join(plugin, 'mcp/server.mjs')], { cwd: plugin, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      PLUGIN_DATA: path.join(temp, 'state'), CSM_COPILOT_BETA_STATE_NAMESPACE: 'csm-invented-delivery-' + createHash('sha256').update(temp).digest('hex').slice(0, 16),
      CSM_COPILOT_BETA_MANIFEST_PATH: path.join(temp, 'invented-manifest.json'),
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(temp, 'invented-runtime.json'),
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: 'true', CSM_COPILOT_SNOWFLAKE_PYTHON: '/not-a-real-snowflake-python',
      CSM_INVENTED_RENEWAL_DELIVERY_SCENARIO: scenario, CSM_INVENTED_RENEWAL_DELIVERY_DELAY_MS: String(collectionDelayMs) } });
  let id = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', data => { stderr += String(data); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const handler = pending.get(message.id);
    if (handler) { pending.delete(message.id); clearTimeout(handler.timer); handler.resolve(message); }
  });
  child.on('exit', code => {
    for (const handler of pending.values()) { clearTimeout(handler.timer); handler.reject(new Error(`Invented host exited ${code}: ${stderr.slice(-600)}`)); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(`Invented ${method} timed out`)); }, 30_000);
    pending.set(next, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const result = (await send('tools/call', { name, arguments: args })).result;
    let value; try { value = JSON.parse(result?.content?.[0]?.text); } catch { value = result?.structuredContent; }
    return { result, value };
  };
  return { child, send, call, stop: () => { child.stdin.end(); child.kill(); } };
}

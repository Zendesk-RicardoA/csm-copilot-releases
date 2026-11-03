// Test-only MCP proxy: the actual candidate runs against invented sources.
// No connection, authorization, draft, renderer or account-wide call search is forwarded.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const runtimeDir = path.resolve(process.argv[2] || '');
const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv[2] || !fs.statSync(runtimeDir).isDirectory() || fs.lstatSync(runtimeDir).isSymbolicLink()
    || runtimeDir === plugin || runtimeDir.startsWith(plugin + path.sep) || runtimeDir === os.homedir()) {
  throw new Error('An explicit isolated invented runtime directory outside the plugin is required.');
}
const namespace = 'csm-invented-model-' + createHash('sha256').update(runtimeDir).digest('hex').slice(0, 16);
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'config/approved-version-manifest.json'), 'utf8'));
// A disposable invented-data fixture, not a renewal of any installed approval.
manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
manifest.status = 'approved_for_limited_beta';
// Match the existing approved boundary shape; the proxy below still rejects every artifact/write tool.
manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
function writeJson(name, value) { fs.writeFileSync(path.join(runtimeDir, name), JSON.stringify(value) + '\n', { mode: 0o600 }); }
writeJson('invented-manifest.json', manifest);
writeJson('invented-runtime.json', {
  mode: 'limited_beta', renderer_mode: 'manual_bound_script',
  identity: { state: 'connected', verified: true, provider: 'invented_company_sso', subject: 'invented-model-tester' },
  snowflake: { state: 'connected', read_only_verified: true },
  organizational_controls: { company_identity: true, read_only_zdp: true, transcript_secondary_processing: true,
    private_draft_google_scope: true, approved_renderer_execution: true, retention_policy: true, operational_support: true },
});
const allowed = new Set(['beta_setup_status', 'beta_connection_status', 'beta_route_workflow',
  'beta_start_meeting_prep_account_brief', 'beta_continue_meeting_prep_account_brief', 'beta_get_meeting_prep_brief_display',
  'beta_get_account_brief_chart']);
const traps = new Set(['beta_start_converge_call_lookup', 'beta_create_meeting_prep_case_from_call_selection',
  'beta_get_selected_converge_call_request', 'beta_render_private_draft', 'beta_read_owned_cta_queue']);
const child = spawn(process.execPath, ['--experimental-loader', new URL('./meeting-prep-behavior-loader.mjs', import.meta.url).href,
  path.join(plugin, 'mcp/server.mjs')], {
  cwd: plugin, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PLUGIN_DATA: path.join(runtimeDir, 'state'), CSM_COPILOT_BETA_STATE_NAMESPACE: namespace,
    CSM_COPILOT_BETA_MANIFEST_PATH: path.join(runtimeDir, 'invented-manifest.json'),
    CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(runtimeDir, 'invented-runtime.json'),
    CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: 'true', CSM_COPILOT_SNOWFLAKE_PYTHON: '/not-a-real-snowflake-python' },
});
const methods = new Map();
const requestNames = new Map();
const traceFile = path.join(runtimeDir, 'tool-trace.jsonl');
function trace(item) { fs.appendFileSync(traceFile, JSON.stringify(item) + '\n', { mode: 0o600 }); }
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
readline.createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const method = methods.get(message.id);
  if (method === 'tools/list' && message.result?.tools) message.result.tools = message.result.tools.filter(tool => allowed.has(tool.name) || traps.has(tool.name));
  if (requestNames.has(message.id)) trace({ kind: 'result', name: requestNames.get(message.id),
    is_error: message.result?.isError === true });
  try {
    const value = JSON.parse(message.result?.content?.[0]?.text || 'null');
    if (value?.account_brief_display?.display_mode === 'concise_overview') trace({ kind: 'brief_display', sections: value.account_brief_display.sections });
  } catch { /* Non-brief messages carry no display contract. */ }
  methods.delete(message.id); requestNames.delete(message.id);
  process.stdout.write(JSON.stringify(message) + '\n');
});
child.stderr.on('data', () => {}); // No provider output is needed for a fixed invented host.
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'tools/call') {
    const name = message.params?.name, args = message.params?.arguments || {};
    trace({ kind: 'call', name, arguments: args });
    const badAccount = args.account_name && args.account_name !== 'Invented Orchard';
    if (!allowed.has(name) || badAccount || args.local_file_delivery_authorized === true) {
      trace({ kind: 'boundary_violation', name });
      respond(message.id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'INVENTED_MODEL_BOUNDARY', message: 'This invented account-only request does not authorize another source, case, transcript or artifact.' }) }] });
      return;
    }
    requestNames.set(message.id, name);
  }
  methods.set(message.id, message.method);
  child.stdin.write(JSON.stringify(message) + '\n');
});
function stop() { child.stdin.end(); child.kill(); }
process.stdin.on('end', stop);
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('SIGINT', () => { stop(); process.exit(0); });
child.on('exit', code => process.exit(code || 0));

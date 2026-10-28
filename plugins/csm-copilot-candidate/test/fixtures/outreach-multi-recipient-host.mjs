import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function startMultiRecipientHost(existing = null) {
  const dir = existing || fs.mkdtempSync(path.join(os.tmpdir(), 'csm-multiple-recipients-invented-'));
  if (!existing) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config/approved-version-manifest.json')));
    manifest.status = 'approved_for_limited_beta';
    manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ mode: 'limited_beta', renderer_mode: 'manual_bound_script',
      identity: { state: 'connected', verified: true, provider: 'invented_sso', subject: 'invented-multiple-recipient-tester' },
      snowflake: { state: 'connected', read_only_verified: true }, organizational_controls: { company_identity: true, read_only_zdp: true,
        transcript_secondary_processing: true, private_draft_google_scope: true, approved_renderer_execution: true, retention_policy: true, operational_support: true } }), { mode: 0o600 });
  }
  const trace = path.join(dir, 'source-count.txt');
  const child = spawn(process.execPath, ['--experimental-loader', new URL('./outreach-multi-recipient-loader.mjs', import.meta.url).href, path.join(root, 'mcp/server.mjs')],
    { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PLUGIN_DATA: path.join(dir, 'state'),
      CSM_COPILOT_BETA_STATE_NAMESPACE: 'invented-multiple-recipient-test',
      CSM_COPILOT_BETA_MANIFEST_PATH: path.join(dir, 'manifest.json'), CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(dir, 'runtime.json'),
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: 'true', CSM_COPILOT_SNOWFLAKE_PYTHON: '/not-a-real-snowflake-python',
      CSM_CONTACT_PRIORITY_MODE: 'ready', CSM_INVENTED_RECIPIENT_QUERY_TRACE: trace } });
  let sequence = 0; const pending = new Map(), calls = [];
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try { const r = JSON.parse(line), p = pending.get(r.id); if (p) { clearTimeout(p.timer); pending.delete(r.id); p.resolve(r); } } catch {}
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Invented protocol timed out.')); }, 10000);
    pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    calls.push(name); const r = await rpc('tools/call', { name, arguments: args });
    if (!r.result?.content?.[0]?.text) throw new Error('Invented protocol returned no structured result.');
    return { ...JSON.parse(r.result.content[0].text), isError: r.result.isError === true };
  };
  return { dir, calls, rpc, call, stop: () => { child.stdin.end(); child.kill(); for (const p of pending.values()) clearTimeout(p.timer); },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    queryCount: () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').length : 0,
    record: caseId => JSON.parse(fs.readFileSync(path.join(dir, 'state', caseId + '.json'))) };
}

export async function completeMultiRecipientEvidence(s) {
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const created = await s.call('beta_create_authorized_journey_a_case', { language: 'es' });
  if (created.isError) throw new Error(JSON.stringify(created));
  const queue = await s.call('beta_read_owned_cta_queue', { case_id: created.case_id });
  if (queue.isError) throw new Error(JSON.stringify(queue));
  const started = await s.call('beta_run_journey_a_contact_evidence', { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  const args = { case_id: created.case_id, contact_evidence_run_id: started.contact_evidence_run_id };
  let final;
  for (let i = 0; i < 40; i++) {
    final = await s.call('beta_continue_journey_a_contact_evidence', args);
    if (final.relationship_context_state === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (final?.relationship_context_state !== 'completed' || final.recommended_contacts?.length !== 2) throw new Error('Invented verified contacts did not complete.');
  if (final.completion_request?.tool !== 'beta_complete_journey_a_contact_evidence') throw new Error('Native evidence completion request missing.');
  const completed = await s.call(final.completion_request.tool, final.completion_request.arguments);
  if (completed.isError) throw new Error(completed.code);
  return { args, final, completed, revision: completed.revision };
}

export async function prepareMultiRecipientCase(s) {
  const { args, final, revision } = await completeMultiRecipientEvidence(s);
  for (const gate of ['work_selection', 'account_evidence']) {
    const result = await s.call('beta_record_journey_a_approval', { case_id: args.case_id, revision, gate });
    if (result.isError) throw new Error(result.code);
  }
  return { args, final, revision };
}

export async function prepareInventedRecipientGuide(s, caseId) {
  const copy = 'Invented reviewed renewal guide: discuss current priorities and agree a useful next step.';
  let pending = await s.call('beta_resolve_renewal_sequence', { case_id: caseId, priority: 'P1', language: 'es', language_variant: 'EMEA' });
  for (let i = 0; pending.native_request && i < 20; i++) {
    const request = pending.native_request, args = request.arguments;
    let result;
    if (request.tool === 'get_profile') result = { connected: true, profile_digest: hash('invented profile') };
    else if (request.tool === 'search') result = { results: args.special_filter_query_str.includes('mimeType')
      ? [{ id: 'invented-tracker', title: 'H2 2099 Renewal Sequences | Localization Tracker', mime_type: 'application/vnd.google-apps.spreadsheet' }]
      : [{ id: 'invented-guide', title: 'Spanish | Invented Guide', mime_type: 'application/vnd.google-apps.document' }] };
    else if (request.tool === 'get_spreadsheet_metadata') result = { spreadsheetId: 'invented-tracker', sheets: [
      { properties: { sheetId: 1, title: 'Template Link', gridProperties: { rowCount: 2, columnCount: 4 } } },
      { properties: { sheetId: 2, title: 'H2 Renewal Sequences', gridProperties: { rowCount: 2, columnCount: 5 } } }] };
    else if (request.tool === 'get_spreadsheet_range') {
      const rows = args.sheet_name === 'Template Link' ? [['Clari Groove', 'Clari Groove Copy', 'Link', 'Gainsight'], ['P1: Renewal [EMEA - ES]', '', '', '']]
        : [['Language', 'Sequence', 'Localized One Pager', 'Reviewed By', 'Completed'], ['Spanish - EMEA', 'Spanish | Invented Guide', '', 'Invented reviewer', 'TRUE']];
      result = { range: `'${args.sheet_name}'!${args.range}`, majorDimension: 'ROWS', values: [rows[args.range.startsWith('A1') ? 0 : 1]] };
    } else if (request.tool === 'get_file_metadata') result = { id: 'invented-guide', name: 'Spanish | Invented Guide', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2099-01-01T00:00:00Z', trashed: false };
    else if (request.tool === 'get_document_text') result = { file_ref_digest: hash('invented-guide'), content_digest: hash(copy), character_count: copy.length, truncated: false };
    else throw new Error('The invented guide has no other source or write path.');
    pending = await s.call('beta_continue_renewal_sequence', { case_id: caseId, renewal_source_ref: pending.renewal_source_ref, tool_name: request.tool, source_status: 'ok', result });
    if (pending.isError) throw new Error(pending.code);
  }
  if (pending.status !== 'ready') throw new Error('Invented current guide not ready.');
  return pending;
}

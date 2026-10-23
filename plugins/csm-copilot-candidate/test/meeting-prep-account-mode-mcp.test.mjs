import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PersistentSnowflakeSession } from './fixtures/meeting-prep-behavior-session.mjs';
import { buildGuideKnowledgeViewMetricsSql } from '../mcp/journey-a-contact-evidence.mjs';

test('the invented selected-instance Guide query returns its fixed Guide values, not the RBA join row', async () => {
  const rows = await new PersistentSnowflakeSession().query(buildGuideKnowledgeViewMetricsSql('001000000000000AAA', { trendMonths: 12, selectMostCompleteInstance: true }));
  assert.equal(rows[0].GUIDE_KNOWLEDGE_VIEWS, 1343);
  assert.equal(rows[0].YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS, 1277);
});

test('actual MCP defaults to account preparation with no Slides setup, recording or case', { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-invented-prep-mode-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/meeting-prep-behavior-host.mjs', import.meta.url)), directory],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let nextId = 1, error = '';
  child.stderr.on('data', part => { error += part.toString(); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  t.after(() => {
    child.stdin.end(); child.kill(); lines.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function send(method, params) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Invented MCP request timed out: ' + error)), 8000);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return response;
  }
  async function call(name, args = {}) {
    const response = await send('tools/call', { name, arguments: args });
    assert.ok(response.result?.content?.[0]?.text, JSON.stringify(response));
    return { ...JSON.parse(response.result.content[0].text), isError: response.result.isError === true };
  }
  const initialized = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.match(initialized.result.instructions || '', /display_delivery_request/);
  const listed = await send('tools/list', {});
  assert.deepEqual(listed.result.tools.find(tool => tool.name === 'beta_route_workflow').inputSchema.properties.preparation_mode.enum, ['account_brief', 'selected_call']);
  const setup = await call('beta_setup_status', { workflow: 'meeting_prep' });
  assert.equal(setup.connection_setup?.state, 'ready', JSON.stringify(setup));
  assert.equal(setup.workflow_readiness.preparation_mode, 'account_brief');
  assert.equal(setup.workflow_readiness.state, 'available_unverified');
  const selected = await call('beta_setup_status', { workflow: 'meeting_prep', preparation_mode: 'selected_call' });
  assert.equal(selected.connection_setup.state, 'action_required');
  const route = await call('beta_route_workflow', { intent: 'meeting_preparation' });
  assert.equal(route.requires_case, false);
  assert.equal(route.first_tool, 'beta_start_meeting_prep_account_brief');
  const started = await call(route.first_tool, { account_name: 'Invented Orchard' });
  assert.equal(started.status, 'in_progress');
  let result;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    result = await call('beta_continue_meeting_prep_account_brief', { account_brief_ref: started.account_brief_ref, wait_seconds: 0 });
    if (result.status !== 'in_progress') break;
  }
  assert.equal(result.status, 'partial', JSON.stringify(result));
  assert.equal(result.account_brief_display.section_order.length, 12);
  assert.match(result.account_brief_display.markdown, /\| Product \| Value \|/);
  assert.match(result.account_brief_display.markdown, /\$15,000\.00/);
  assert.match(result.account_brief_display.markdown, /Invented owner will review routing/);
  assert.match(result.account_brief_display.markdown, /No recording is required/);
  assert.equal(result.account_brief_display.delivery_contract.chart_authorization_blocks_brief, false);
  assert.ok(result.account_brief_display.chart_requests.length > 0);
  assert.match(result.account_brief_display.markdown, /1,343/);
  assert.equal('account_brief' in result, false);
  assert.equal(result.display_delivery_request.tool, 'beta_get_meeting_prep_brief_display');
  const delivered = await send('tools/call', { name: result.display_delivery_request.tool, arguments: result.display_delivery_request.arguments });
  assert.equal(delivered.result.content[0].text, result.account_brief_display.markdown);
  const repeated = await send('tools/call', { name: result.display_delivery_request.tool, arguments: result.display_delivery_request.arguments });
  assert.deepEqual(repeated.result, delivered.result, 'Display-only delivery must not reread or change evidence');
  const trace = fs.readFileSync(path.join(directory, 'tool-trace.jsonl'), 'utf8');
  assert.doesNotMatch(trace, /"kind":"boundary_violation"/);
  const states = path.join(directory, 'state');
  assert.ok(!fs.existsSync(states) || fs.readdirSync(states).every(name => name === 'tester-register-events.json'));
});

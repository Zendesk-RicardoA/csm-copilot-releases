import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInventedRenewalHost } from './fixtures/renewal-delivery-test-host.mjs';
import { cleanupTemporaryChartDirectory } from '../mcp/account-brief-chart-files.mjs';

async function setup(t, scenario = 'base') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-invented-renewal-delivery-'));
  const server = startInventedRenewalHost(temp, { scenario });
  t.after(() => { server.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  const initialized = await server.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  return { server, temp, initialized };
}

async function selected(t, scenario) {
  const f = await setup(t, scenario);
  const created = await f.server.call('beta_create_authorized_journey_a_case', { language: 'en' });
  const caseId = created.value.case_id;
  const queue = await f.server.call('beta_read_owned_cta_queue', { case_id: caseId });
  const started = await f.server.call('beta_prepare_renewal_conversation_brief', { case_id: caseId, work_item_ref: queue.value.queue[0].work_item_ref });
  return { ...f, caseId, started: started.value, args: { case_id: caseId, renewal_conversation_run_id: started.value.renewal_conversation_run_id } };
}

test('the new preparation control is registered with source-only readiness and a bounded input', { timeout: 30_000 }, async t => {
  const { server } = await setup(t);
  const listed = await server.send('tools/list');
  const tool = listed.result.tools.find(item => item.name === 'beta_continue_renewal_preparation');
  assert.ok(tool, 'The supported renewal path must expose its coordinator');
  assert.equal(tool.inputSchema.properties.wait_seconds.maximum, 25);
  assert.equal(tool.inputSchema.properties.local_file_delivery_authorized.default, false);
  const status = await server.call('beta_setup_status', { workflow: 'renewal_conversation_brief' });
  assert.equal(status.value.connection_setup.state, 'ready');
  assert.equal(status.value.workflow_readiness.state, 'available_unverified');
});

test('one renewal continuation delivers the full brief and candidates with no per-chart or detail tool calls', { timeout: 30_000 }, async t => {
  const f = await selected(t, 'authorized_delay');
  assert.equal(f.started.continuation_request.tool, 'beta_continue_renewal_preparation');
  const delivered = await f.server.call('beta_continue_renewal_preparation', { ...f.args, wait_seconds: 1 });
  assert.equal(delivered.result.isError, false, JSON.stringify(delivered.value));
  assert.equal(delivered.value.status, 'evidence_ready_with_gaps');
  assert.equal(delivered.value.execution_receipt.statement_order.length, 18);
  assert.equal(delivered.value.next_action.kind, 'select_cards');
  assert.equal(delivered.value.chart_delivery.length, 6);
  assert.ok(delivered.value.chart_delivery.every(chart => chart.state === 'not_authorized'));
  const body = delivered.result.content[0].text;
  assert.match(body, /\| Plan \| Product \| Offering \| Status \| Seats \|/);
  assert.match(body, /\| Product \| Value \|/);
  assert.match(body, /\| Tickets created \| 120 \| 100 \| 20% \|/);
  assert.match(body, /\| ID \| Metric \| Customer headline \| Comparison \| Why it matters \|/);
  assert.match(body, /Linked opportunities and focus areas/);
  assert.match(body, /1,343/);
  assert.ok(!body.includes('!['));
  const state = JSON.parse(fs.readFileSync(path.join(f.temp, 'state', `${f.caseId}.json`)));
  assert.deepEqual(state.renewal_conversation.approvals, []);
  assert.equal(state.renewal_conversation.evidence_state, 'evidence_ready_with_gaps');
});

test('the default host contract explicitly preserves even opening notes, headings and next-action wording', { timeout: 30_000 }, async t => {
  const f = await selected(t, 'base');
  const delivered = await f.server.call('beta_continue_renewal_preparation', { ...f.args, wait_seconds: 1 });
  assert.match(f.initialized.result.instructions, /renewal[^.]*verbatim/i);
  assert.match(delivered.value.instruction, /verbatim/);
  assert.match(delivered.value.instruction, /opening note, headings, capitalization, punctuation and next-action wording/);
  assert.match(delivered.value.instruction, /Only the existing recent-call Summary and Next steps cells/);
});

test('authorized image delivery is same-run idempotent and does not create a draft or approval', { timeout: 30_000 }, async t => {
  const f = await selected(t, 'base');
  const first = await f.server.call('beta_continue_renewal_preparation', { ...f.args, wait_seconds: 1, local_file_delivery_authorized: true });
  assert.equal(first.result.isError, false, JSON.stringify(first.value));
  assert.ok(first.value.chart_delivery.every(chart => chart.state === 'prepared'));
  assert.equal(first.value.chart_visibility, 'unverified');
  const paths = first.value.chart_delivery.map(chart => chart.file_path);
  t.after(() => {
    for (const dir of new Set(paths.map(file => path.dirname(file)))) if (fs.existsSync(dir)) cleanupTemporaryChartDirectory(dir, Date.parse(first.value.chart_delivery[0].expires_at));
  });
  for (const file of paths) assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const statePath = path.join(f.temp, 'state', `${f.caseId}.json`), before = fs.readFileSync(statePath, 'utf8');
  const second = await f.server.call('beta_continue_renewal_preparation', f.args);
  assert.deepEqual(second.value.chart_delivery, first.value.chart_delivery);
  assert.deepEqual(second.value.execution_receipt, first.value.execution_receipt);
  assert.equal(fs.readFileSync(statePath, 'utf8'), before);
  assert.equal(second.value.next_action.kind, 'select_cards');
  assert.equal(second.value.chart_delivery.length, 6);
  assert.equal((second.result.content[0].text.match(/!\[/g) || []).length, 6);
  assert.equal(JSON.parse(before).renewal_conversation.draft_handoff_receipt, undefined);
});

test('one failed chart preserves the complete prepared brief and other images', { timeout: 30_000 }, async t => {
  const f = await selected(t, 'chart_failure');
  const delivered = await f.server.call('beta_continue_renewal_preparation', { ...f.args, wait_seconds: 1, local_file_delivery_authorized: true });
  assert.equal(delivered.result.isError, false, JSON.stringify(delivered.value));
  assert.equal(delivered.value.chart_delivery.filter(chart => chart.state === 'unavailable').length, 1);
  assert.equal(delivered.value.chart_delivery.filter(chart => chart.state === 'prepared').length, 5);
  const successful = delivered.value.chart_delivery.filter(chart => chart.state === 'prepared');
  t.after(() => { for (const dir of new Set(successful.map(chart => path.dirname(chart.file_path)))) if (fs.existsSync(dir)) cleanupTemporaryChartDirectory(dir, Date.parse(successful[0].expires_at)); });
  assert.match(delivered.result.content[0].text, /Commercial footprint/);
  assert.match(delivered.result.content[0].text, /Progress metric candidates/);
  assert.equal(delivered.value.next_action.kind, 'select_cards');
});

test('a restart, wrong case and invalid wait cannot create a new read or recover evidence', { timeout: 30_000 }, async t => {
  const f = await selected(t, 'base');
  await f.server.call('beta_continue_renewal_preparation', { ...f.args, wait_seconds: 1 });
  const invalid = await f.server.call('beta_continue_renewal_preparation', { ...f.args, wait_seconds: 26 });
  assert.equal(invalid.result.isError, true);
  f.server.stop();
  const restarted = startInventedRenewalHost(f.temp);
  t.after(() => restarted.stop());
  const unavailable = await restarted.call('beta_continue_renewal_preparation', f.args);
  assert.equal(unavailable.value.code, 'RENEWAL_EVIDENCE_RUN_EXPIRED');
});

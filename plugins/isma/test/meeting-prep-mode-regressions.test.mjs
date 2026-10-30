import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { routeWorkflowIntent } from '../mcp/journey-orchestrator.mjs';
import { WORKFLOW_CATALOG } from '../mcp/workflow-catalog.mjs';
import { summarizeWorkflowReadiness } from '../mcp/workflow-readiness.mjs';
import { buildAccountIntelligenceDisplay } from '../mcp/account-intelligence-display.mjs';

test('ordinary meeting preparation defaults to a case-free account brief, not a recording picker', () => {
  const route = routeWorkflowIntent('meeting_preparation');
  assert.equal(route.route, 'journey_b');
  assert.equal(route.preparation_mode, 'account_brief');
  assert.equal(route.requires_case, false);
  assert.equal(route.requires_call_selection, false);
  assert.equal(route.first_tool, 'beta_start_meeting_prep_account_brief');
  assert.match(route.next_action, /Do not ask for the upcoming meeting date/i);
  assert.match(route.next_action, /Do not start a separate recording search/i);
});

test('explicit selected-call analysis keeps case and call-selection requirements', () => {
  const route = routeWorkflowIntent('meeting_preparation', { preparationMode: 'selected_call' });
  assert.equal(route.preparation_mode, 'selected_call');
  assert.equal(route.requires_case, true);
  assert.equal(route.requires_call_selection, true);
  assert.equal(route.first_tool, 'beta_start_converge_call_lookup');
});

test('invalid preparation modes and modes on another workflow are rejected', () => {
  for (const preparationMode of ['today', '', null, 3]) {
    assert.throws(() => routeWorkflowIntent('meeting_preparation', { preparationMode }), { code: 'INVALID_MEETING_PREPARATION_MODE' });
  }
  assert.throws(() => routeWorkflowIntent('outreach', { preparationMode: 'account_brief' }), { code: 'INVALID_MEETING_PREPARATION_MODE' });
  assert.equal(routeWorkflowIntent('outreach').requires_case, true);
  assert.equal(routeWorkflowIntent('success_plan').requires_case, true);
  assert.equal(routeWorkflowIntent('presentation').requires_case, true);
});

test('missing transcript and Slides controls do not disable account-only preparation', () => {
  const state = summarizeWorkflowReadiness({ workflow: 'meeting_prep', preparationMode: 'account_brief',
    availableTools: ['beta_start_meeting_prep_account_brief', 'beta_continue_meeting_prep_account_brief', 'beta_get_meeting_prep_brief_display', 'beta_get_account_brief_chart'],
    setupStatus: 'ready', packageStatus: { state: 'matched' }, rendererCompatibility: { state: 'component_mismatch' } });
  assert.equal(state.state, 'available_unverified');
  assert.equal(state.preparation_mode, 'account_brief');
  assert.deepEqual(state.steps.map(item => item.step), ['account_brief']);
});

test('a failed source still degrades account-only preparation and source approval is mandatory', () => {
  const common = { workflow: 'meeting_prep', preparationMode: 'account_brief',
    availableTools: ['beta_start_meeting_prep_account_brief', 'beta_continue_meeting_prep_account_brief', 'beta_get_meeting_prep_brief_display', 'beta_get_account_brief_chart'],
    setupStatus: 'ready', packageStatus: { state: 'matched' } };
  assert.equal(summarizeWorkflowReadiness({ ...common, observations: { account_brief: { state: 'failed', error_code: 'INVENTED_READ_TIMEOUT' } } }).state, 'degraded');
  assert.equal(summarizeWorkflowReadiness({ ...common, executionApproval: 'approval_required' }).state, 'approval_required');
});

test('the workflow catalogue records both successful preparation outcomes without adding a sixth workflow', () => {
  assert.equal(Object.keys(WORKFLOW_CATALOG.workflows).length, 5);
  const modes = WORKFLOW_CATALOG.workflows.meeting_prep.preparation_modes;
  assert.deepEqual(modes.account_brief.required_steps, ['account_brief']);
  assert.equal(modes.account_brief.requires_case, false);
  assert.equal(modes.account_brief.renderer_required, false);
  assert.equal(modes.selected_call.renderer_required, true);
  assert.match(modes.account_brief.successful_ending, /brief/i);
});

test('even a partial brief publishes the exact ordered display contract and permits only the established call-cell edits', () => {
  const result = buildAccountIntelligenceDisplay({ contract: 'AccountIntelligenceCoreV1',
    account: { display_name: 'Invented Orchard', identity_state: 'authoritative' }, sections: {}, source_states: {}, source_gaps: [] });
  assert.equal(result.delivery_contract.version, 'account-brief-display-v1');
  assert.deepEqual(result.delivery_contract.required_section_order, result.section_order);
  assert.deepEqual(result.delivery_contract.editable_columns, { recent_conversations: ['Summary', 'Next steps'] });
  assert.equal(result.delivery_contract.meeting_questions_position, 'after_brief');
  assert.equal(result.delivery_contract.chart_authorization_blocks_brief, false);
  assert.match(result.markdown, /No recording is required for this account brief/);
  assert.match(result.markdown, /Data limits/);
});

test('packaged instructions distinguish upcoming meeting dates from past recording searches', () => {
  const skill = fs.readFileSync(new URL('../skills/csm-copilot-beta/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /preparation_mode: "account_brief"/);
  assert.match(skill, /upcoming meeting date is not a recording-search filter/i);
  assert.match(skill, /Do not automatically search additional recording windows/i);
  assert.match(skill, /meeting questions after the brief/i);
});

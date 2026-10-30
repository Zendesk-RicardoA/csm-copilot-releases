import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMeetingPrepBrief} from '../mcp/meeting-prep-account-brief.mjs';
import {buildRenewalConversationBrief} from '../mcp/renewal-conversation-brief.mjs';

function example() {
  const caseRecord = {case_id: '11111111-1111-4111-8111-111111111111', tester_id: 'invented-owner',
    account_ref_digest: 'a'.repeat(64), revision: 3,
    approvals: {identity: {approved: true}}, derived_evidence: {digest: 'c'.repeat(64), finding_count: 2,
      source_receipt: {account_ref_digest: 'a'.repeat(64), case_id: '11111111-1111-4111-8111-111111111111'}}};
  const result = {account_brief: buildRenewalConversationBrief({selectedCta: null}).shared_account_intelligence,
    account_intelligence_receipt: {account_ref_digest: 'a'.repeat(64), content_digest: 'b'.repeat(64)}};
  result.account_brief.source_states.goals_and_timeline = 'requires_selected_call';
  return {caseRecord, result};
}
test('a missing local marker does not assert that the host lost its already reviewed call findings', () => {
  const {caseRecord, result} = example(), before = JSON.stringify({caseRecord, result});
  const projected = projectMeetingPrepBrief(result, {caseRecord, ownerRef: 'invented-owner'});
  assert.equal(projected.case_call_context.state, 'unavailable', 'No receipt alone may make findings available.');
  assert.equal(projected.case_call_context.availability_scope, 'control_only');
  assert.match(projected.account_brief_display.markdown, /cannot confirm.*chat/i);
  assert.doesNotMatch(projected.account_brief_display.markdown, /findings are unavailable in memory|context has expired or the process restarted/);
  assert.match(projected.case_call_context.note, /without.*retriev|without.*reread/i);
  assert.equal(JSON.stringify({caseRecord, result}), before, 'No evidence, revision or approval changes.');
});
test('source details and call details use the same limited availability statement', () => {
  const {caseRecord, result} = example();
  const projected = projectMeetingPrepBrief(result, {caseRecord, ownerRef: 'invented-owner', displayDetails: ['source_states', 'call_specific_context']});
  assert.match(projected.account_brief_display.markdown, /availability.*not checked|not verified/i);
  assert.doesNotMatch(projected.account_brief_display.markdown, /Call findings not available for review|context has expired or the process restarted/);
});
test('a known current review marker still reports available findings without approving them', () => {
  const {caseRecord, result} = example();
  const projected = projectMeetingPrepBrief(result, {caseRecord, ownerRef: 'invented-owner', evidenceAvailable: true});
  assert.equal(projected.case_call_context.state, 'available');
  assert.equal(projected.case_call_context.finding_count, 2);
  assert.match(projected.account_brief_display.markdown, /does not approve/);
});
test('owner and account mismatches stop even when a review marker was present', () => {
  const {caseRecord, result} = example();
  assert.throws(() => projectMeetingPrepBrief(result, {caseRecord, ownerRef: 'other', evidenceAvailable: true}), {code: 'CASE_OWNER_MISMATCH'});
  const other = structuredClone(caseRecord); other.derived_evidence.source_receipt.account_ref_digest = 'd'.repeat(64);
  assert.throws(() => projectMeetingPrepBrief(result, {caseRecord: other, ownerRef: 'invented-owner', evidenceAvailable: true}), {code: 'SELECTED_CALL_ACCOUNT_MISMATCH'});
});

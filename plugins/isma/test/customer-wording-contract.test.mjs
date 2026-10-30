import test from 'node:test';
import assert from 'node:assert/strict';
import Native from '../mcp/approved-native-contract.js';
import { validateMeetingPrepBuildContract } from '../mcp/meeting-prep-build-contract.mjs';
import { inventedMeetingPrepDraft } from './fixtures/meeting-prep-draft-input.mjs';

const record = { revision: 1, account_ref_digest: 'a'.repeat(64),
  account_intelligence_core: { content_digest: 'b'.repeat(64), account_ref_digest: 'a'.repeat(64) },
  derived_evidence: { digest: 'c'.repeat(64) } };

test('customer implications reject the reproduced data-only and CSM-checklist wording', () => {
  for (const wording of [
    'First reply time rose from 7.2 to 11.5 hours.',
    'July is 3.4 hours above the peer average.',
    'Speed: first reply is 3.7h slower than average.',
    'Capacity: 113 more solved tickets per agent than average.',
    'Quality: CSAT is 3.5 points below average.',
    'Action: prioritize high-volume slow segments.',
    'Review: track FRT, CSAT, and throughput monthly.',
  ]) assert.equal(Native.customerImplicationIssue(wording), 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED', wording);
  for (const wording of [
    'Longer waits leave customers without an early answer.',
    'Speed improvements need to protect the quality of each answer.',
    'First replies take longer, leaving customers waiting for reassurance.',
    'Una respuesta más rápida reduce la espera al iniciar una consulta.',
  ]) assert.equal(Native.customerImplicationIssue(wording), null);
});

test('wording is checked before approval in both raw chart inputs and native field projections', () => {
  for (const compiled of [false, true]) {
    const input = inventedMeetingPrepDraft(record);
    input.metricSlidePlan.speed_quality_trend = { include: true };
    const bad = 'First reply time rose from 7.2 to 11.5 hours.';
    if (compiled) input.projection.templateFields.speed_quality_trend = {
      frt_series: { updates: { insight_1: { text: bad } } },
    };
    else input.projection.runtimeTrendData = { frt: { periods: ['2026-08', '2026-09'], values: [7.2, 11.5], unit: 'hours', insights: [bad] } };
    assert.throws(() => validateMeetingPrepBuildContract(input), { code: 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED' });
  }
});

test('unavailable metrics remain optional and wording checks never rewrite approved text', () => {
  const input = inventedMeetingPrepDraft(record);
  input.projection.templateFields.peer_comparison = { peer_insight_1: 'Speed: first reply is 3.7h slower than average.' };
  const before = structuredClone(input);
  assert.equal(validateMeetingPrepBuildContract(input), true);
  assert.deepEqual(input, before);
});

test('renewal focus admits only the reviewed benefit, not four planning fields', () => {
  const focus = { number: 1, focus_area: 'A faster first reply',
    customer_benefit: 'Less waiting for a first reply, supported by clearer routing with Admin Copilot.' };
  assert.equal(Native.renewalFocusIssue(focus), null);
  assert.equal(Native.renewalFocusIssue({ ...focus, practical_next_step: 'Review routing.' }), 'RENEWAL_FOCUS_CARD_INVALID');
  assert.equal(Native.renewalFocusIssue({ ...focus, customer_benefit: 'Use Admin Copilot to review routing rules.' }), 'RENEWAL_CUSTOMER_BENEFIT_REQUIRED');
  assert.equal(Native.renewalFocusIssue({ ...focus, customer_benefit: 'If confirmed, this could help customers.' }), 'RENEWAL_CUSTOMER_BENEFIT_REQUIRED');
});

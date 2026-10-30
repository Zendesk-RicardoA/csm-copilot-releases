import test from 'node:test';
import assert from 'node:assert/strict';
import {renewalCtaDeadlineStatus} from '../mcp/renewal-conversation-brief.mjs';

const now = new Date('2026-02-15T12:00:00Z');
for (const status of ['New', 'In Progress', 'Waiting on customer']) {
  test(`a past action deadline is overdue for an open ${status} CTA`, () => {
    const cta = {status, action_deadline: '2026-02-14T12:00:00Z', due_date: '2026-03-01'};
    const before = structuredClone(cta);
    assert.equal(renewalCtaDeadlineStatus(cta, now), 'Overdue');
    assert.deepEqual(cta, before);
  });
}
test('the action deadline boundary matches queue policy and is independent of the CTA due date', () => {
  assert.equal(renewalCtaDeadlineStatus({status: 'In Progress', action_deadline: '2026-02-15T12:00:00Z'}, now), 'Overdue');
  assert.equal(renewalCtaDeadlineStatus({status: 'In Progress', action_deadline: '2026-02-15T13:00:00Z', due_date: '2026-01-01'}, now), 'Not overdue');
  assert.equal(renewalCtaDeadlineStatus({status: 'New', action_deadline: '2026-02-15T13:00:00+01:00'}, now), 'Overdue');
});
test('a missing or invalid action deadline is unknown, not a claim that the CTA is on time', () => {
  for (const action_deadline of [undefined, null, '', 'not-a-date']) {
    assert.equal(renewalCtaDeadlineStatus({status: 'In Progress', action_deadline}, now), 'Not established');
  }
});

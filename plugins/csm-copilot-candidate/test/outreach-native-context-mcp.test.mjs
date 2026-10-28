import assert from 'node:assert/strict';
import test from 'node:test';
import { startMultiRecipientHost, completeMultiRecipientEvidence } from './fixtures/outreach-multi-recipient-host.mjs';

function start(t) {
  const host = startMultiRecipientHost();
  t.after(() => { host.stop(); host.cleanup(); });
  return host;
}

test('completed native evidence binds its own account context without a caller-created digest or approval', { timeout: 15000 }, async t => {
  const s = start(t), run = await completeMultiRecipientEvidence(s), record = s.record(run.args.case_id);
  assert.ok(record.journey_state.contexts.journey_a.context, 'completed native evidence must bind the outreach context');
  assert.deepEqual(record.journey_state.contexts.journey_a.approvals, []);
  assert.equal(s.calls.includes('beta_bind_journey_context'), false);
  assert.equal(run.final.completion_request.tool, 'beta_complete_journey_a_contact_evidence');
  const notReviewed = await s.call('beta_prepare_outreach_email', { ...run.args, revision: run.revision, contact_ref: run.final.recommended_contacts[0].contact_ref });
  assert.equal(notReviewed.isError, true);
  assert.equal(notReviewed.code, 'REVIEW_INCOMPLETE');
  for (const gate of ['work_selection', 'account_evidence']) {
    const reviewed = await s.call('beta_record_journey_a_approval', { case_id: run.args.case_id, revision: run.revision, gate });
    assert.equal(reviewed.isError, false, JSON.stringify(reviewed));
  }
  const email = await s.call('beta_prepare_outreach_email', { ...run.args, revision: run.revision, contact_ref: run.final.recommended_contacts[0].contact_ref });
  assert.equal(email.isError, false, JSON.stringify(email));
  assert.equal(email.to, 'recent@example.invalid');
  assert.equal(email.chat_preview_allowed, true);
});

test('an explicit address request reads the same verified evidence without preparing an email or recording approval', { timeout: 15000 }, async t => {
  const s = start(t), run = await completeMultiRecipientEvidence(s), before = s.record(run.args.case_id), queries = s.queryCount();
  const result = await s.call('beta_read_verified_contact_email', { ...run.args, revision: run.revision,
    contact_ref: run.final.recommended_contacts[0].contact_ref, explicit_email_request: true });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.email, 'recent@example.invalid');
  assert.equal(result.approval_recorded, false);
  assert.equal(result.gmail_draft_created, false);
  assert.deepEqual(s.record(run.args.case_id), before);
  assert.equal(s.queryCount(), queries);
  const injected = await s.call('beta_read_verified_contact_email', { ...run.args, revision: run.revision,
    contact_ref: run.final.recommended_contacts[0].contact_ref, explicit_email_request: true, email: 'unverified@example.invalid' });
  assert.equal(injected.code, 'INVALID_INPUT');
  const denied = await s.call('beta_read_verified_contact_email', { ...run.args, revision: run.revision,
    contact_ref: run.final.recommended_contacts[0].contact_ref, explicit_email_request: false });
  assert.equal(denied.code, 'EMAIL_DISCLOSURE_NOT_AUTHORIZED');
  assert.deepEqual(s.record(run.args.case_id), before);
});

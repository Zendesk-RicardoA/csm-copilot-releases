import assert from 'node:assert/strict';
import test from 'node:test';
import { startMultiRecipientHost, prepareMultiRecipientCase, prepareInventedRecipientGuide, hash } from './fixtures/outreach-multi-recipient-host.mjs';

function start(t, existing) {
  const s = startMultiRecipientHost(existing);
  t.after(() => { s.stop(); if (!existing) s.cleanup(); });
  return s;
}
const prepare = (s, run, contact, revision = run.revision) => s.call('beta_prepare_outreach_email', {
  ...run.args, revision, contact_ref: contact,
});
const target = email => ({ case_id: email.case_id, revision: email.revision, email_ref: email.email_ref, email_revision: email.email_revision });
async function reviewed(s, email, copy) {
  for (const gate of ['contact_selection', 'template_preview']) {
    const result = await s.call('beta_record_journey_a_approval', { ...target(email), gate,
      ...(gate === 'template_preview' ? { renewal_source_mode: 'current_sequence' } : {}) });
    assert.equal(result.isError, false, JSON.stringify(result));
  }
  const proof = { ...target(email), recipient_ref: email.recipient_ref, to_digest: email.address_digest, content_digest: hash(JSON.stringify(copy)) };
  const bound = await s.call('beta_bind_outreach_draft_review', proof);
  assert.equal(bound.isError, false, JSON.stringify(bound));
  proof.email_revision = bound.email_revision;
  const approved = await s.call('beta_record_journey_a_approval', { ...target({ ...email, email_revision: bound.email_revision }), gate: 'outreach_draft' });
  assert.equal(approved.isError, false, JSON.stringify(approved));
  return proof;
}

test('a verified individual target immediately requests a complete unapproved chat preview before email reviews', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), queries = s.queryCount();
  const email = await prepare(s, run, run.final.recommended_contacts[0].contact_ref);
  assert.equal(email.isError, false, JSON.stringify(email));
  assert.equal(email.chat_preview_allowed, true);
  assert.equal(email.copy_preparation, 'conversation_host');
  assert.equal(email.next_step.kind, 'display_complete_chat_email');
  assert.deepEqual(email.next_step.required_fields, ['to', 'subject', 'body', 'signature']);
  assert.equal(email.next_gate, 'contact_selection');
  assert.deepEqual(email.completed_gates, ['work_selection', 'account_evidence']);
  assert.match(email.next_action, /show.*complete.*unapproved.*email.*now/i);
  assert.equal(s.queryCount(), queries);
  assert.equal(s.record(run.args.case_id).outreach_emails[0].outreach_delivery, undefined);
});

test('a second contact receives a separate email using the same account, contacts and guide', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), refs = run.final.recommended_contacts.map(x => x.contact_ref);
  await prepareInventedRecipientGuide(s, run.args.case_id);
  const first = await prepare(s, run, refs[0]);
  assert.equal(first.isError, false, JSON.stringify(first));
  const firstCopy = { to: first.to, subject: 'Invented priorities', body: 'Hello first contact. Invented signature.' };
  await reviewed(s, first, firstCopy);
  const before = s.record(run.args.case_id), queries = s.queryCount(), calls = [...s.calls];
  const second = await prepare(s, run, refs[1]);
  assert.equal(second.isError, false, JSON.stringify(second));
  assert.notEqual(first.email_ref, second.email_ref);
  assert.equal(first.to, 'recent@example.invalid'); assert.equal(second.to, 'older@example.invalid');
  assert.equal(first.recipient_count, 1); assert.equal(second.recipient_count, 1);
  assert.equal(second.revision, first.revision);
  assert.deepEqual(second.completed_gates, ['work_selection', 'account_evidence']);
  const after = s.record(run.args.case_id);
  assert.deepEqual(after.outreach_emails[0], before.outreach_emails[0]);
  assert.deepEqual(after.journey_state, before.journey_state);
  assert.deepEqual(after.renewal_source_receipt, before.renewal_source_receipt);
  assert.equal(s.queryCount(), queries);
  assert.deepEqual(s.calls.slice(calls.length), ['beta_prepare_outreach_email']);
  assert.doesNotMatch(JSON.stringify(after), /@example|Hello first|Invented signature|Invented Recent|Invented Older/);
});

test('two separately reviewed messages create two independent unsent drafts and each repeated request is idempotent', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), refs = run.final.recommended_contacts.map(x => x.contact_ref);
  await prepareInventedRecipientGuide(s, run.args.case_id);
  const queries = s.queryCount(), drafts = [], gmail = { create_draft: async copy => { drafts.push(structuredClone(copy)); } };
  for (const [index, ref] of refs.entries()) {
    const email = await prepare(s, run, ref);
    assert.equal(email.isError, false, JSON.stringify(email));
    const copy = { to: email.to, subject: `Invented priorities ${index + 1}`, body: `Invented individual message ${index + 1}` };
    const proof = await reviewed(s, email, copy);
    const claimed = await s.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
    assert.equal(claimed.invoke_gmail, true, JSON.stringify(claimed));
    await gmail.create_draft(copy);
    const completed = await s.call('beta_complete_outreach_draft', { ...target({ ...email, email_revision: proof.email_revision }), draft_request_ref: claimed.draft_request_ref, provider_draft_created: true });
    assert.equal(completed.status, 'draft_created', JSON.stringify(completed));
    const duplicate = await s.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
    assert.equal(duplicate.invoke_gmail, false); assert.equal(duplicate.status, 'already_created');
    const repeated = await prepare(s, run, ref);
    assert.equal(repeated.email_ref, email.email_ref); assert.equal(repeated.status, 'already_created');
  }
  assert.deepEqual(drafts, [
    { to: 'recent@example.invalid', subject: 'Invented priorities 1', body: 'Invented individual message 1' },
    { to: 'older@example.invalid', subject: 'Invented priorities 2', body: 'Invented individual message 2' },
  ]);
  assert.equal(s.queryCount(), queries);
  const status = await s.call('beta_workflow_status', { case_id: run.args.case_id });
  assert.equal(status.separate_emails.state, 'drafts_created');
  assert.equal(status.separate_emails.email_count, 2); assert.equal(status.separate_emails.drafts_created, 2);
  assert.equal(status.workflows.outreach.review_scope, 'per_email');
  assert.equal(status.workflows.outreach.draft_delivery, 'drafts_created');
  assert.equal(status.workflows.outreach.status, 'drafts_created');
  assert.equal(status.workflows.outreach.next_gate, null);
});

test('a separate email cannot borrow another message approval, recipient, content or provider receipt', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), refs = run.final.recommended_contacts.map(x => x.contact_ref);
  await prepareInventedRecipientGuide(s, run.args.case_id);
  const first = await prepare(s, run, refs[0]), second = await prepare(s, run, refs[1]);
  assert.equal(first.isError, false, JSON.stringify(first)); assert.equal(second.isError, false, JSON.stringify(second));
  const copy = { to: first.to, subject: 'Invented first email', body: 'Invented body' }, proof = await reviewed(s, first, copy);
  const cross = await s.call('beta_claim_outreach_draft', { ...proof, ...target(second), private_draft_authorized: true });
  assert.equal(cross.isError, true);
  const noReview = await s.call('beta_claim_outreach_draft', { ...target(second), recipient_ref: second.recipient_ref, to_digest: second.address_digest, content_digest: hash('different email'), private_draft_authorized: true });
  assert.equal(noReview.isError, true);
  const before = s.record(run.args.case_id);
  const noRevision = await s.call('beta_record_journey_a_approval', { ...target(second), email_revision: undefined, gate: 'contact_selection' });
  assert.equal(noRevision.code, 'OUTREACH_EMAIL_REFERENCE_REQUIRED');
  const extra = await s.call('beta_prepare_outreach_email', { ...run.args, revision: run.revision, contact_ref: refs[1], email: 'unverified@example.invalid' });
  assert.equal(extra.isError, true);
  assert.deepEqual(s.record(run.args.case_id), before);
  const claimed = await s.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
  const wrongCompletion = await s.call('beta_complete_outreach_draft', { ...target(second), draft_request_ref: claimed.draft_request_ref, provider_draft_created: true });
  assert.equal(wrongCompletion.code, 'DRAFT_RECEIPT_MISMATCH');
  const other = await s.call('beta_prepare_outreach_email', { ...run.args, revision: run.revision, contact_ref: refs[0] });
  assert.equal(other.status, 'needs_reconciliation'); assert.equal(other.email_ref, first.email_ref);
});

test('a first legacy draft keeps its recipient and receipt while a second contact reuses still-valid native evidence', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), refs = run.final.recommended_contacts.map(x => x.contact_ref);
  await prepareInventedRecipientGuide(s, run.args.case_id);
  const first = await s.call('beta_get_verified_outreach_recipient', { ...run.args, revision: run.revision, contact_ref: refs[0] });
  for (const gate of ['contact_selection', 'template_preview']) assert.equal((await s.call('beta_record_journey_a_approval', { case_id: run.args.case_id, revision: run.revision, gate, ...(gate === 'template_preview' ? { renewal_source_mode: 'current_sequence' } : {}) })).isError, false);
  const proof = { case_id: run.args.case_id, revision: run.revision, recipient_ref: first.recipient_ref, to_digest: first.address_digest, content_digest: hash('Invented legacy email') };
  assert.equal((await s.call('beta_bind_outreach_draft_review', proof)).isError, false);
  assert.equal((await s.call('beta_record_journey_a_approval', { case_id: run.args.case_id, revision: run.revision, gate: 'outreach_draft' })).isError, false);
  const claim = await s.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
  assert.equal((await s.call('beta_complete_outreach_draft', { case_id: run.args.case_id, revision: run.revision, draft_request_ref: claim.draft_request_ref, provider_draft_created: true })).status, 'draft_created');
  const before = s.record(run.args.case_id), queries = s.queryCount(), second = await prepare(s, run, refs[1]);
  assert.equal(second.isError, false, JSON.stringify(second)); assert.equal(second.to, 'older@example.invalid');
  const after = s.record(run.args.case_id);
  assert.deepEqual(after.outreach_delivery, before.outreach_delivery);
  assert.deepEqual(after.outreach_identity_receipt, before.outreach_identity_receipt);
  assert.deepEqual(after.journey_state, before.journey_state); assert.equal(s.queryCount(), queries);
  const status = await s.call('beta_workflow_status', { case_id: run.args.case_id });
  assert.equal(status.separate_emails.email_count, 2); assert.equal(status.separate_emails.drafts_created, 1);
  assert.equal(status.workflows.outreach.status, 'in_review');
  assert.equal(status.separate_emails.emails.find(e => e.email_ref === second.email_ref).next_gate, 'contact_selection');
});

test('restart cannot restore an uncreated email from its stored digest', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), email = await prepare(s, run, run.final.recommended_contacts[0].contact_ref);
  assert.equal(email.isError, false, JSON.stringify(email));
  const restarted = start(t, s.dir); await restarted.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const approved = await restarted.call('beta_record_journey_a_approval', { ...target(email), gate: 'contact_selection' });
  assert.equal(approved.code, 'OUTREACH_RECIPIENT_EXPIRED');
  assert.equal(restarted.record(run.args.case_id).outreach_emails[0].approvals.length, 2);
});

test('email-scoped approval rejects caller-supplied addresses instead of silently approving a different target', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), email = await prepare(s, run, run.final.recommended_contacts[0].contact_ref);
  const before = s.record(run.args.case_id);
  const invalid = await s.call('beta_record_journey_a_approval', { ...target(email), gate: 'contact_selection', email: 'unverified@example.invalid' });
  assert.equal(invalid.code, 'INVALID_INPUT');
  assert.deepEqual(s.record(run.args.case_id), before);
});

test('restart preserves per-email reconciliation and confirmed idempotency without restoring addresses', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s);
  await prepareInventedRecipientGuide(s, run.args.case_id);
  const email = await prepare(s, run, run.final.recommended_contacts[0].contact_ref);
  const proof = await reviewed(s, email, { to: email.to, subject: 'Invented reviewed email', body: 'Invented exact copy' });
  const claim = await s.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
  const restarted = start(t, s.dir); await restarted.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const retry = await restarted.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
  assert.equal(retry.code, 'DRAFT_RECONCILIATION_REQUIRED');
  const completed = await restarted.call('beta_complete_outreach_draft', { ...target(email), draft_request_ref: claim.draft_request_ref, provider_draft_created: true });
  assert.equal(completed.status, 'draft_created');
  const duplicate = await restarted.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
  assert.equal(duplicate.status, 'already_created'); assert.equal(duplicate.invoke_gmail, false);
  assert.doesNotMatch(JSON.stringify(restarted.record(run.args.case_id)), /@example|Invented exact copy|Invented reviewed email/);
});

test('a pending individual draft protects the shared context from replacement while another contact remains preparable', { timeout: 15000 }, async t => {
  for (const action of ['beta_resolve_renewal_sequence', 'beta_run_journey_a_contact_evidence', 'beta_bind_journey_context', 'beta_start_journey', 'beta_handoff_journey']) {
    const s = start(t), run = await prepareMultiRecipientCase(s);
    await prepareInventedRecipientGuide(s, run.args.case_id);
    const email = await prepare(s, run, run.final.recommended_contacts[0].contact_ref);
    const proof = await reviewed(s, email, { to: email.to, subject: 'Invented pending email', body: 'Invented current copy' });
    const claim = await s.call('beta_claim_outreach_draft', { ...proof, private_draft_authorized: true });
    assert.equal(claim.invoke_gmail, true);
    const before = s.record(run.args.case_id), queries = s.queryCount();
    const changed = await s.call(action, { case_id: run.args.case_id, revision: run.revision, priority: 'P1', language: 'es', language_variant: 'EMEA',
      work_item_ref: 'invented-old-selection', journey: action === 'beta_bind_journey_context' ? 'journey_a' : 'journey_b',
      context_digest: hash('invented-replacement-context'), account_ref_digest: before.journey_state.account_ref_digest,
      context_version: '1.0.0', item_count: 3, from_journey: 'journey_a', to_journey: 'journey_b', reason: 'meeting_preparation' });
    // This source-only fixture has no private Slides setup. Starting the other
    // workflow stops at that earlier prerequisite; neither safe stop may alter
    // the pending lease, account evidence or guide, or block a second email.
    assert.equal(changed.code, action === 'beta_start_journey' ? 'SETUP_REQUIRED' : 'DRAFT_RECONCILIATION_REQUIRED', action);
    assert.deepEqual(s.record(run.args.case_id), before); assert.equal(s.queryCount(), queries);
    const second = await prepare(s, run, run.final.recommended_contacts[1].contact_ref);
    assert.equal(second.to, 'older@example.invalid');
    assert.deepEqual(s.record(run.args.case_id).outreach_emails[0], before.outreach_emails[0]);
  }
});

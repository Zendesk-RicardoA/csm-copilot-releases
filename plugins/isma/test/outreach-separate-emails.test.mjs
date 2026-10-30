import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { OutreachRecipientHandoffs } from '../mcp/outreach-recipient-handoff.mjs';
import { prepareOutreachEmail, projectOutreachEmail, saveOutreachEmail } from '../mcp/outreach-email-preparation.mjs';
import { approveJourneyAGate } from '../mcp/journey-orchestrator.mjs';
import { bindOutreachDraftReview } from '../mcp/outreach-draft-delivery.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const epoch = Date.parse('2026-01-01T12:00:00Z'), owner = 'invented-email-owner', run = 'invented-completed-run';
const refs = ['a'.repeat(64), 'b'.repeat(64)];
function fixture(addresses = ['first@example.invalid', 'second@example.invalid']) {
  let time = epoch;
  const handoffs = new OutreachRecipientHandoffs({ clock: () => time });
  handoffs.retain({ caseId: 'invented-case', ownerRef: owner, evidenceRunRef: run, accountRefDigest: 'c'.repeat(64), expiresAt: epoch + 900000,
    contacts: refs.map((contact_ref, i) => ({ contact_ref, display_name: `Invented contact ${i + 1}`, role: 'Invented role', identity_status: 'eligible', recipient_eligible: true })),
    emails: new Map(refs.map((ref, i) => [ref, addresses[i]])) });
  const record = { case_id: 'invented-case', tester_id: owner, package_version: 'invented-package', revision: 4,
    renewal_source_receipt: { evidence_digest: 'd'.repeat(64) },
    journey_state: { active_journey: 'journey_a', account_ref_digest: 'c'.repeat(64), contexts: { journey_a: { context: { digest: 'e'.repeat(64) },
      contact_verification: { completed_evidence_digest: hash(run), eligible_recipient_count: 2 },
      approvals: ['work_selection', 'account_evidence'].map(gate => ({ gate, revision: 4, tester_id: owner })), status: 'in_review' } } } };
  const options = { ownerRef: owner, revision: 4, evidenceRunRef: run, handoffs };
  return { record, options, handoffs, prepare: (r = record, contactRef = refs[0], extra = {}) => prepareOutreachEmail(r, { ...options, contactRef, ...extra }), advance: ms => { time += ms; } };
}
const scope = (record, email, extra = {}) => ({ ownerRef: owner, revision: record.revision, emailRef: email.email_ref, emailRevision: email.email_revision, ...extra });

test('separate messages share account review but never share recipient or wording approvals', () => {
  const f = fixture(), first = f.prepare(), second = f.prepare(first.record, refs[1]);
  assert.equal(first.email.to, 'first@example.invalid'); assert.equal(second.email.to, 'second@example.invalid');
  assert.notEqual(first.email.recipient_ref, second.email.recipient_ref);
  assert.notEqual(first.email.email_ref, second.email.email_ref);
  assert.deepEqual(second.record.outreach_emails[0], first.record.outreach_emails[0]);
  assert.deepEqual(second.record.journey_state, f.record.journey_state);
  assert.deepEqual(second.record.renewal_source_receipt, f.record.renewal_source_receipt);
  assert.deepEqual(second.email.completed_gates, ['work_selection', 'account_evidence']);
  assert.equal(second.record.revision, 4); assert.equal(second.email.email_revision, 1);
  assert.doesNotMatch(JSON.stringify(second.record), /@example|Invented contact|Invented role/);
});

test('repeating an individual email returns its original receipt and expiry without another message', () => {
  const f = fixture(), first = f.prepare(); f.advance(60000);
  const again = f.prepare(first.record);
  assert.equal(again.email.email_ref, first.email.email_ref);
  assert.equal(again.email.recipient_ref, first.email.recipient_ref);
  assert.equal(again.email.expires_at, first.email.expires_at);
  assert.equal(again.record.outreach_emails.length, 1);
});

test('only the edited email gets a new wording revision and loses its wording approval', () => {
  const f = fixture(), first = f.prepare(), second = f.prepare(first.record, refs[1]), args = scope(second.record, second.email);
  let view = projectOutreachEmail(second.record, args);
  for (const gate of ['contact_selection', 'template_preview']) view = approveJourneyAGate(view, { testerId: owner, revision: view.revision, gate });
  view = bindOutreachDraftReview(view, { testerId: owner, revision: view.revision, contentDigest: hash('Invented second email'), now: new Date(epoch) });
  view = approveJourneyAGate(view, { testerId: owner, revision: view.revision, gate: 'outreach_draft' });
  const reviewed = saveOutreachEmail(second.record, view, args), before = structuredClone(reviewed.outreach_emails[0]);
  const changed = bindOutreachDraftReview(view, { testerId: owner, revision: view.revision, contentDigest: hash('Invented revised second email'), now: new Date(epoch + 1000) });
  const saved = saveOutreachEmail(reviewed, changed, args);
  assert.equal(saved.revision, 4); assert.equal(saved.outreach_emails[1].revision, 2);
  assert.deepEqual(saved.outreach_emails[0], before);
  assert.deepEqual(saved.outreach_emails[1].approvals.map(a => a.gate), ['work_selection', 'account_evidence', 'contact_selection', 'template_preview']);
  assert.throws(() => projectOutreachEmail(saved, args), { code: 'STALE_OUTREACH_EMAIL_REVISION' });
});

test('owner, case, package, context, account and completed evidence must still match', () => {
  const f = fixture(), first = f.prepare(), args = scope(first.record, first.email);
  for (const mutate of [r => { r.case_id = 'another-case'; }, r => { r.package_version = 'another-package'; },
    r => { r.journey_state.account_ref_digest = 'f'.repeat(64); }, r => { r.journey_state.contexts.journey_a.context.digest = 'f'.repeat(64); },
    r => { r.journey_state.contexts.journey_a.contact_verification.completed_evidence_digest = 'f'.repeat(64); }]) {
    const changed = structuredClone(first.record); mutate(changed);
    assert.throws(() => projectOutreachEmail(changed, args), { code: 'OUTREACH_EMAIL_EVIDENCE_MISMATCH' });
  }
  assert.throws(() => projectOutreachEmail(first.record, { ...args, ownerRef: 'someone-else' }), { code: 'CASE_OWNER_MISMATCH' });
  assert.throws(() => projectOutreachEmail(first.record, { ...args, revision: 3 }), { code: 'STALE_CASE_REVISION' });
  assert.throws(() => projectOutreachEmail(first.record, { ...args, emailRef: undefined }), { code: 'OUTREACH_EMAIL_REFERENCE_REQUIRED' });
});

test('an unknown or malformed contact cannot change another prepared email', () => {
  const f = fixture(), first = f.prepare(), before = JSON.stringify(first.record);
  for (const contactRef of ['short', 'f'.repeat(64), null]) assert.throws(() => f.prepare(first.record, contactRef));
  assert.throws(() => f.prepare(first.record, refs[1], { evidenceRunRef: 'another-read' }), { code: 'OUTREACH_RECIPIENT_MISMATCH' });
  assert.equal(JSON.stringify(first.record), before);
});

test('shared account approval is required once and is never inferred from a contact selection', () => {
  const f = fixture(); f.record.journey_state.contexts.journey_a.approvals.pop();
  assert.throws(() => f.prepare(), { code: 'REVIEW_INCOMPLETE' });
  assert.equal(f.record.outreach_emails, undefined);
});

test('a different contact can be prepared while the first draft awaits reconciliation', () => {
  const f = fixture(), first = f.prepare(), record = structuredClone(first.record);
  record.outreach_emails[0].outreach_delivery = { state: 'needs_reconciliation', request_ref: 'invented-provider-receipt' };
  const again = f.prepare(record);
  assert.equal(again.email.status, 'needs_reconciliation'); assert.equal(again.email.invoke_gmail, false);
  const second = f.prepare(record, refs[1]); assert.equal(second.email.to, 'second@example.invalid');
  assert.deepEqual(second.record.outreach_emails[0], record.outreach_emails[0]);
});

test('the original absolute contact expiry blocks a second email and cannot restore the first', () => {
  const f = fixture(), first = f.prepare(); f.advance(900001);
  assert.throws(() => f.prepare(first.record, refs[1]), { code: 'OUTREACH_RECIPIENT_EXPIRED' });
  assert.throws(() => f.prepare(first.record), { code: 'OUTREACH_RECIPIENT_EXPIRED' });
  assert.equal(first.record.outreach_emails.length, 1);
});

test('restarting contact memory never restores an uncreated email but a confirmed draft stays idempotent', () => {
  const f = fixture(), first = f.prepare(), restarted = { handoffs: new OutreachRecipientHandoffs() };
  assert.throws(() => f.prepare(first.record, refs[0], restarted), { code: 'OUTREACH_RECIPIENT_EXPIRED' });
  const completed = structuredClone(first.record); completed.outreach_emails[0].outreach_delivery = { state: 'draft_created' };
  const repeat = f.prepare(completed, refs[0], restarted);
  assert.equal(repeat.email.status, 'already_created'); assert.equal(repeat.email.invoke_gmail, false);
  assert.equal(repeat.email.to, undefined);
});

test('different contact identities with the same address cannot produce duplicate emails', () => {
  const f = fixture(['shared@example.invalid', 'shared@example.invalid']), first = f.prepare();
  assert.throws(() => f.prepare(first.record, refs[1]), { code: 'OUTREACH_EMAIL_DUPLICATE_ADDRESS' });
  assert.equal(first.record.outreach_emails.length, 1);
});

test('a prior single-email draft or review is reused rather than replaced for the same contact', () => {
  const f = fixture(), selected = f.handoffs.select(f.record, { ownerRef: owner, revision: 4, evidenceRunRef: run, contactRef: refs[0] });
  const same = f.prepare(selected.record);
  assert.equal(same.email.legacy_email, true); assert.equal(same.email.recipient_ref, selected.handoff.recipient_ref);
  assert.equal(same.record.outreach_emails, undefined);
  selected.record.outreach_delivery = { state: 'draft_created' };
  f.advance(900001);
  assert.equal(f.prepare(selected.record).email.status, 'already_created');
});

test('all 100 verified contacts remain selectable, with a visible limit and no silent truncation', () => {
  const f = fixture(), contacts = Array.from({ length: 100 }, (_, i) => ({ contact_ref: hash('invented-contact-' + i), display_name: 'Invented individual', identity_status: 'eligible', recipient_eligible: true }));
  f.handoffs.retain({ caseId: 'invented-case', ownerRef: owner, evidenceRunRef: run, accountRefDigest: 'c'.repeat(64), expiresAt: epoch + 900000,
    contacts, emails: new Map(contacts.map((c, i) => [c.contact_ref, `individual${i}@example.invalid`])) });
  let record = f.record;
  for (const [i, contact] of contacts.entries()) { const prepared = f.prepare(record, contact.contact_ref); record = prepared.record; assert.equal(prepared.email.to, `individual${i}@example.invalid`); }
  assert.equal(record.outreach_emails.length, 100);
  assert.throws(() => f.prepare(record, 'f'.repeat(64)), { code: 'OUTREACH_EMAIL_LIMIT' });
});

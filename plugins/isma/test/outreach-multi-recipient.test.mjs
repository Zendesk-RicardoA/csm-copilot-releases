import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { OutreachRecipientHandoffs } from '../mcp/outreach-recipient-handoff.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const epoch = Date.parse('2026-01-01T12:00:00Z');
const owner = 'invented-owner', run = 'invented-source-run';
const refs = ['a', 'b', 'c'].map(x => x.repeat(64));
function fixture(emails = ['first@example.invalid', 'second@example.invalid', null]) {
  let now = epoch;
  const handoffs = new OutreachRecipientHandoffs({ clock: () => now });
  handoffs.retain({ caseId: 'invented-case', ownerRef: owner, accountRefDigest: 'd'.repeat(64), evidenceRunRef: run,
    expiresAt: epoch + 900000, contacts: refs.map((contact_ref, i) => ({ contact_ref, display_name: `Invented person ${i + 1}`,
      identity_status: 'eligible', recipient_eligible: i < 2 })), emails: new Map(refs.map((ref, i) => [ref, emails[i]])) });
  const record = { case_id: 'invented-case', tester_id: owner, revision: 3, package_version: 'invented-version',
    renewal_source_mode: 'current_sequence', renewal_source_receipt: { evidence_digest: 'e'.repeat(64), expires_at: new Date(epoch + 900000).toISOString() },
    journey_state: { active_journey: 'journey_a', account_ref_digest: 'd'.repeat(64), contexts: { journey_a: {
      context: { digest: 'f'.repeat(64) }, approvals: ['work_selection', 'account_evidence'].map(gate => ({ gate, revision: 3 })),
      contact_verification: { completed_evidence_digest: hash(run), eligible_recipient_count: 2 } } } } };
  const select = (r = record, contactRefs = refs.slice(0, 2), extra = {}) => handoffs.select(r,
    { ownerRef: owner, revision: r.revision, evidenceRunRef: run, contactRefs, ...extra });
  return { record, handoffs, select, advance: ms => { now += ms; } };
}

test('one atomic recipient group returns the complete exact Gmail To header and no persisted identities', () => {
  const f = fixture(), before = JSON.stringify(f.record), selected = f.select();
  assert.equal(selected.handoff.status, 'verified_recipients_for_review');
  assert.equal(selected.handoff.to, 'first@example.invalid, second@example.invalid');
  assert.equal(selected.handoff.address_digest, hash('first@example.invalid, second@example.invalid'));
  assert.equal(selected.handoff.recipient_count, 2);
  assert.deepEqual(selected.handoff.recipients.map(r => r.contact_ref), refs.slice(0, 2));
  assert.equal(selected.record.revision, 3);
  assert.equal(JSON.stringify(f.record), before);
  assert.doesNotMatch(JSON.stringify(selected.record), /@|Invented person|first|second/);
  assert.deepEqual(selected.record.renewal_source_receipt, f.record.renewal_source_receipt);
});

test('adding a person retains work, account, contact evidence and guide, while clearing recipient-dependent reviews', () => {
  const f = fixture();
  const first = f.handoffs.select(f.record, { ownerRef: owner, revision: 3, evidenceRunRef: run, contactRef: refs[0] });
  const reviewed = structuredClone(first.record);
  reviewed.journey_state.contexts.journey_a.approvals.push(...['contact_selection', 'template_preview', 'outreach_draft'].map(gate => ({ gate, revision: 3 })));
  reviewed.outreach_delivery = { state: 'review_ready', content_digest: '1'.repeat(64) };
  const changed = f.select(reviewed);
  assert.equal(changed.record.case_id, reviewed.case_id);
  assert.equal(changed.record.revision, 4);
  assert.deepEqual(changed.record.journey_state.contexts.journey_a.approvals.map(a => [a.gate, a.revision]), [['work_selection', 4], ['account_evidence', 4]]);
  assert.deepEqual(changed.record.journey_state.contexts.journey_a.context, reviewed.journey_state.contexts.journey_a.context);
  assert.deepEqual(changed.record.journey_state.contexts.journey_a.contact_verification, reviewed.journey_state.contexts.journey_a.contact_verification);
  assert.deepEqual(changed.record.renewal_source_receipt, reviewed.renewal_source_receipt);
  assert.equal(changed.record.renewal_source_mode, 'current_sequence');
  assert.equal(changed.record.outreach_delivery, undefined);
  assert.throws(() => f.handoffs.assert(changed.record, { ownerRef: owner, revision: 4,
    recipientRef: first.handoff.recipient_ref, toDigest: first.handoff.address_digest }), { code: 'OUTREACH_RECIPIENT_MISMATCH' });
});

test('repeating a group reuses its receipt, revision and original expiry', () => {
  const f = fixture(), first = f.select(); f.advance(60000);
  const repeated = f.select(first.record);
  assert.equal(repeated.handoff.recipient_ref, first.handoff.recipient_ref);
  assert.equal(repeated.handoff.expires_at, first.handoff.expires_at);
  assert.equal(repeated.record.revision, first.record.revision);
  assert.deepEqual(repeated.handoff.recipients, first.handoff.recipients);
});

test('removing a person uses the same source and returns a backward-compatible single-address handoff', () => {
  const f = fixture(), group = f.select(), single = f.select(group.record, [refs[0]]);
  assert.equal(single.handoff.status, 'verified_recipient_for_review');
  assert.equal(single.handoff.recipient.email, 'first@example.invalid');
  assert.equal(single.handoff.to, 'first@example.invalid');
  assert.equal(single.handoff.address_digest, hash('first@example.invalid'));
  assert.equal(single.record.revision, group.record.revision + 1);
});

test('invalid, duplicated, missing and excessive selections are rejected atomically without truncation', () => {
  for (const list of [[], [refs[0], refs[0]], 'not-a-list', [null], Array.from({ length: 101 }, (_, i) => String(i))]) {
    const f = fixture(), before = JSON.stringify(f.record);
    assert.throws(() => f.select(f.record, list), { code: 'INVALID_OUTREACH_RECIPIENT_SELECTION' });
    assert.equal(JSON.stringify(f.record), before);
  }
  const f = fixture();
  assert.throws(() => f.select(f.record, [refs[0]], { contactRef: refs[1] }), { code: 'INVALID_OUTREACH_RECIPIENT_SELECTION' });
  assert.throws(() => f.handoffs.select(f.record, { ownerRef: owner, revision: 3, evidenceRunRef: run }), { code: 'INVALID_OUTREACH_RECIPIENT_SELECTION' });
});

test('the complete 100-contact source limit is retained rather than reduced to a smaller shortlist', () => {
  const f = fixture(), contacts = Array.from({ length: 100 }, (_, i) => ({ contact_ref: hash('invented-person-' + i),
    display_name: 'Invented selected person', identity_status: 'eligible', recipient_eligible: true }));
  f.handoffs.retain({ caseId: 'invented-case', ownerRef: owner, accountRefDigest: 'd'.repeat(64), evidenceRunRef: run,
    expiresAt: epoch + 900000, contacts, emails: new Map(contacts.map((c, i) => [c.contact_ref, `person${i + 1}@example.invalid`])) });
  f.record.journey_state.contexts.journey_a.contact_verification.eligible_recipient_count = 100;
  const selected = f.select(f.record, contacts.map(c => c.contact_ref));
  assert.equal(selected.handoff.recipient_count, 100);
  assert.equal(selected.handoff.recipients.length, 100);
  const addresses = selected.handoff.to.split(', ');
  assert.equal(addresses.length, 100); assert.equal(addresses[0], 'person1@example.invalid');
  assert.equal(addresses[99], 'person100@example.invalid');
  assert.doesNotMatch(JSON.stringify(selected.record), /@example/);
});

test('one unverified or foreign contact rejects the whole group without replacing the existing selection', () => {
  const f = fixture(), old = f.select(f.record, [refs[0]]), scope = { ownerRef: owner, revision: 3,
    recipientRef: old.handoff.recipient_ref, toDigest: old.handoff.address_digest };
  for (const ref of [refs[2], '9'.repeat(64)]) assert.throws(() => f.select(old.record, [refs[0], ref]), { code: 'CONTACT_RECIPIENT_NOT_VERIFIED' });
  f.handoffs.assert(old.record, scope);
  assert.equal(old.record.revision, 3);
});

test('two contact identities cannot silently add the same email address twice', () => {
  const f = fixture(['same@example.invalid', 'SAME@example.invalid', null]);
  assert.throws(() => f.select(), { code: 'OUTREACH_RECIPIENT_DUPLICATE_ADDRESS' });
  assert.equal(f.record.revision, 3);
});

test('every group is owner, case, account, context, evidence and revision bound', () => {
  const f = fixture(), selected = f.select(), bound = { ownerRef: owner, revision: 3,
    recipientRef: selected.handoff.recipient_ref, toDigest: selected.handoff.address_digest };
  for (const change of [r => { r.tester_id = 'another-owner'; }, r => { r.case_id = 'other-case'; },
    r => { r.journey_state.account_ref_digest = '1'.repeat(64); }, r => { r.revision++; },
    r => { r.journey_state.contexts.journey_a.context.digest = '2'.repeat(64); },
    r => { r.journey_state.contexts.journey_a.contact_verification.completed_evidence_digest = '3'.repeat(64); }]) {
    const r = structuredClone(selected.record); change(r);
    assert.throws(() => f.handoffs.assert(r, bound));
  }
  assert.throws(() => f.handoffs.assert(selected.record, { ...bound, toDigest: hash('first@example.invalid') }), { code: 'OUTREACH_RECIPIENT_MISMATCH' });
  assert.throws(() => f.select(f.record, refs.slice(0, 2), { ownerRef: 'another-owner' }), { code: 'CASE_OWNER_MISMATCH' });
});

test('changed wording carries the same group to the new revision without extending contact retention', () => {
  const f = fixture(), group = f.select(), updated = structuredClone(group.record); updated.revision++;
  f.advance(120000); f.handoffs.advanceReview(group.record, updated, { ownerRef: owner });
  f.handoffs.assert(updated, { ownerRef: owner, revision: 4, recipientRef: group.handoff.recipient_ref, toDigest: group.handoff.address_digest });
  const repeated = f.select(updated);
  assert.equal(repeated.handoff.recipient_ref, group.handoff.recipient_ref);
  assert.equal(repeated.handoff.expires_at, group.handoff.expires_at);
});

test('expiry, source cleanup and restart never restore a recipient group from stored digests', () => {
  const f = fixture(), group = f.select(), scope = { ownerRef: owner, revision: 3,
    recipientRef: group.handoff.recipient_ref, toDigest: group.handoff.address_digest };
  assert.throws(() => new OutreachRecipientHandoffs({ clock: () => epoch }).assert(group.record, scope), { code: 'OUTREACH_RECIPIENT_EXPIRED' });
  f.advance(900000);
  assert.throws(() => f.handoffs.assert(group.record, scope), { code: 'OUTREACH_RECIPIENT_EXPIRED' });
  assert.throws(() => f.select(group.record), { code: 'OUTREACH_RECIPIENT_EXPIRED' });
});

test('a pending, uncertain or confirmed Gmail create prevents recipient replacement', () => {
  for (const state of ['create_requested', 'needs_reconciliation', 'draft_created']) {
    const f = fixture(), group = f.select(), r = structuredClone(group.record); r.outreach_delivery = { state };
    assert.throws(() => f.select(r, [refs[0]]), { code: 'DRAFT_RECONCILIATION_REQUIRED' });
    assert.equal(r.revision, 3);
  }
});

test('a persisted draft lease requires reconciliation even after contact expiry or process restart', () => {
  for (const state of ['create_requested', 'needs_reconciliation', 'draft_created']) {
    const f = fixture(), group = f.select(), r = structuredClone(group.record); r.outreach_delivery = { state };
    f.advance(900001);
    assert.throws(() => f.select(r, [refs[0]]), { code: 'DRAFT_RECONCILIATION_REQUIRED' });
    assert.throws(() => new OutreachRecipientHandoffs({ clock: () => epoch }).select(r,
      { ownerRef: owner, revision: 3, evidenceRunRef: run, contactRefs: [refs[0]] }), { code: 'DRAFT_RECONCILIATION_REQUIRED' });
  }
});

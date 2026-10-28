import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { bindNativeOutreachEvidence } from '../mcp/outreach-evidence-context.mjs';
import { OutreachRecipientHandoffs } from '../mcp/outreach-recipient-handoff.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const run = '00000000-0000-4000-8000-000000000001';
const account = hash('invented account'), contact = hash('invented contact');
const now = new Date('2026-10-28T10:00:00Z');
function fixture() {
  const record = { tester_id: 'invented-owner', case_id: 'invented-case', revision: 1, approvals: [],
    journey_state: { active_journey: 'journey_a', account_ref_digest: account, contexts: { journey_a: {
      context: null, approvals: [], contact_verification: { candidate_count: 1, completed_evidence_digest: hash(run) },
    } } } };
  const args = { accountRefDigest: account, evidenceRunRef: run, testerId: record.tester_id, now,
    workItemRef: hash('invented CTA'), brief: { account_ref: account, account_name: 'Invented Example',
      product_performance_metrics: { rows: [{ metric: 'Invented metric', value: 42 }] } },
    contacts: [{ contact_ref: contact, display_name: 'Invented Person', identity_status: 'eligible', recipient_eligible: true }],
    sourceStates: { contact_snapshot: 'checked', salesforce_identity: 'checked', gong_metadata: 'timed_out' },
    sourceGaps: ['GONG_METADATA_TIMEOUT'] };
  return { record, args, bind: overrides => bindNativeOutreachEvidence(record, { ...args, ...overrides }) };
}

test('the native receipt binds actual evidence and gaps while retaining only digests, counts and provenance', () => {
  const f = fixture(), updated = f.bind(), context = updated.journey_state.contexts.journey_a.context;
  assert.equal(updated.revision, 2);
  assert.equal(context.binding_kind, 'native_outreach_evidence');
  assert.equal(context.origin_contract, 'NativeJourneyAContactEvidenceV1');
  assert.deepEqual(context.warning_codes, ['GONG_METADATA_TIMEOUT']);
  assert.equal(context.item_count, 3);
  assert.equal(context.raw_customer_content_retained, false);
  assert.deepEqual(updated.journey_state.contexts.journey_a.approvals, []);
  assert.doesNotMatch(JSON.stringify(updated), /Invented Example|Invented Person|Invented metric|"value":42/);
  assert.equal(f.record.journey_state.contexts.journey_a.context, null);
});

test('changed account evidence, selected work, contacts and source gaps cannot inherit the old context digest', () => {
  const f = fixture(), digest = f.bind().journey_state.contexts.journey_a.context.digest;
  for (const change of [{ brief: { ...f.args.brief, account_name: 'Invented Changed' } },
    { workItemRef: hash('another invented CTA') }, { contacts: [{ ...f.args.contacts[0], display_name: 'Invented Changed' }] },
    { sourceGaps: ['GONG_METADATA_UNAVAILABLE'] }, { sourceStates: { ...f.args.sourceStates, gong_metadata: 'unavailable' } }]) {
    assert.notEqual(f.bind(change).journey_state.contexts.journey_a.context.digest, digest);
  }
});

test('native context binding rejects another owner, account, run, unverified snapshot or incomplete contacts', () => {
  const f = fixture();
  for (const [change, code] of [[{ testerId: 'another-owner' }, 'CASE_OWNER_MISMATCH'],
    [{ brief: { ...f.args.brief, account_ref: hash('another account') } }, 'CROSS_JOURNEY_ACCOUNT_MISMATCH'],
    [{ evidenceRunRef: 'another-run' }, 'CONTACT_VERIFICATION_REQUIRED'],
    [{ sourceStates: { contact_snapshot: 'unavailable' } }, 'CONTACT_VERIFICATION_REQUIRED'],
    [{ contacts: [] }, 'CONTACT_VERIFICATION_REQUIRED']]) {
    assert.throws(() => f.bind(change), { code });
  }
  assert.equal(f.record.revision, 1);
});

test('new native evidence clears previous reviews instead of granting or transferring approval', () => {
  const f = fixture();
  f.record.journey_state.contexts.journey_a.approvals = [{ gate: 'account_evidence', revision: 1 }];
  f.record.approvals = [{ gate: 'identity', revision: 1 }];
  const updated = f.bind();
  assert.deepEqual(updated.approvals, []);
  assert.deepEqual(updated.journey_state.contexts.journey_a.approvals, []);
});

function addresses() {
  const f = fixture(), record = f.bind();
  let time = now.getTime();
  const handoffs = new OutreachRecipientHandoffs({ clock: () => time });
  handoffs.retain({ caseId: record.case_id, ownerRef: record.tester_id, accountRefDigest: account,
    evidenceRunRef: run, expiresAt: time + 900000, contacts: f.args.contacts, emails: new Map([[contact, 'invented@example.invalid']]) });
  const options = { ownerRef: record.tester_id, revision: record.revision, evidenceRunRef: run, contactRef: contact, explicitEmailRequest: true };
  return { record, options, handoffs, advance: ms => { time += ms; } };
}

test('reading a verified address needs an explicit request and changes no case, approval, recipient or expiry', () => {
  const f = addresses(), before = structuredClone(f.record);
  assert.throws(() => f.handoffs.readContactEmail(f.record, { ...f.options, explicitEmailRequest: false }), { code: 'EMAIL_DISCLOSURE_NOT_AUTHORIZED' });
  const first = f.handoffs.readContactEmail(f.record, f.options);
  f.advance(60000);
  assert.equal(f.handoffs.readContactEmail(f.record, f.options).expires_at, first.expires_at);
  assert.deepEqual(f.record, before);
  assert.equal(f.record.outreach_identity_receipt, undefined);
  assert.equal(f.record.outreach_emails, undefined);
});

test('address disclosure rejects foreign contacts, case, owner, account, evidence and stale revision', () => {
  const f = addresses();
  for (const [options, code] of [[{ contactRef: hash('foreign contact') }, 'CONTACT_RECIPIENT_NOT_VERIFIED'],
    [{ ownerRef: 'foreign-owner' }, 'CASE_OWNER_MISMATCH'], [{ revision: 1 }, 'STALE_CASE_REVISION']]) {
    assert.throws(() => f.handoffs.readContactEmail(f.record, { ...f.options, ...options }), { code });
  }
  for (const change of [record => { record.case_id = 'another-case'; },
    record => { record.journey_state.account_ref_digest = hash('foreign account'); },
    record => { record.journey_state.contexts.journey_a.contact_verification.completed_evidence_digest = hash('foreign run'); }]) {
    const record = structuredClone(f.record); change(record);
    assert.throws(() => f.handoffs.readContactEmail(record, f.options), { code: 'OUTREACH_RECIPIENT_MISMATCH' });
  }
});

test('expiry, cleanup and restart never restore an address from the native context receipt', () => {
  for (const action of ['expiry', 'cleanup', 'restart']) {
    const f = addresses();
    if (action === 'expiry') f.advance(900000);
    if (action === 'cleanup') f.handoffs.forgetCase(f.record.case_id);
    if (action === 'restart') f.handoffs = new OutreachRecipientHandoffs({ clock: () => now.getTime() });
    assert.throws(() => f.handoffs.readContactEmail(f.record, f.options), { code: 'OUTREACH_RECIPIENT_EXPIRED' });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { startMultiRecipientHost, prepareMultiRecipientCase, prepareInventedRecipientGuide, hash } from './fixtures/outreach-multi-recipient-host.mjs';

function start(t, existing) {
  const s = startMultiRecipientHost(existing);
  t.after(() => { s.stop(); if (!existing) s.cleanup(); });
  return s;
}
const choose = (s, run, refs, revision = run.revision) => s.call('beta_get_verified_outreach_recipient', { ...run.args, revision, contact_refs: refs });
const binding = (run, group, email) => ({ case_id: run.args.case_id, revision: group.revision,
  recipient_ref: group.recipient_ref, to_digest: group.address_digest, content_digest: hash(JSON.stringify(email)) });
async function review(s, run, group, email) {
  for (const gate of ['contact_selection', 'template_preview']) {
    const approved = await s.call('beta_record_journey_a_approval', { case_id: run.args.case_id, revision: group.revision, gate,
      ...(gate === 'template_preview' ? { renewal_source_mode: 'current_sequence' } : {}) });
    assert.equal(approved.isError, false, JSON.stringify(approved));
  }
  const bound = binding(run, group, email);
  assert.equal((await s.call('beta_bind_outreach_draft_review', bound)).isError, false);
  assert.equal((await s.call('beta_record_journey_a_approval', { case_id: run.args.case_id, revision: group.revision, gate: 'outreach_draft' })).isError, false);
  return bound;
}

test('native handoff accepts one bounded selected-contact list without caller-supplied addresses', { timeout: 10000 }, async t => {
  const s = start(t), tools = await s.rpc('tools/list');
  const schema = tools.result.tools.find(x => x.name === 'beta_get_verified_outreach_recipient').inputSchema;
  assert.equal(schema.properties.contact_refs.maxItems, 100);
  assert.equal(schema.properties.contact_refs.uniqueItems, true);
  assert.equal(schema.properties.email, undefined);
  assert.equal(schema.additionalProperties, false);
});

test('the tool contract requires a native receipt update even when only removing a known recipient', { timeout: 10000 }, async t => {
  const s = start(t), tools = await s.rpc('tools/list');
  const tool = tools.result.tools.find(x => x.name === 'beta_get_verified_outreach_recipient');
  assert.match(tool.description, /updates the case's selected recipients/);
  assert.match(tool.description, /including removal/);
  assert.match(tool.description, /even when the remaining addresses are already known/);
  assert.match(tool.description, /complete 64-character contact_ref exactly/);
  assert.match(tool.description, /without source rereads/);
});

test('adding a second recipient retains the case, native account/contact reads and current guide through one unsent draft', { timeout: 15000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), refs = run.final.recommended_contacts.map(x => x.contact_ref);
  await prepareInventedRecipientGuide(s, run.args.case_id);
  const first = await s.call('beta_get_verified_outreach_recipient', { ...run.args, revision: run.revision, contact_ref: refs[0] });
  const email = { to: first.recipient.email, subject: 'Invented next priorities', payload: { mime_type: 'text/html', body: { content: '<p>Revisemos vuestras prioridades.</p><p>Invented signature</p>' } } };
  const old = await review(s, run, first, email), before = s.record(run.args.case_id), queries = s.queryCount();
  const guideCalls = s.calls.filter(x => ['beta_resolve_renewal_sequence', 'beta_continue_renewal_sequence'].includes(x)).length;
  const group = await choose(s, run, refs);
  assert.equal(group.isError, false, JSON.stringify(group));
  assert.equal(group.revision, run.revision + 1);
  assert.equal(group.to, 'recent@example.invalid, older@example.invalid');
  assert.equal(group.address_digest, hash('recent@example.invalid, older@example.invalid'));
  assert.equal(group.recipient_count, 2);
  const after = s.record(run.args.case_id);
  assert.deepEqual(after.journey_state.contexts.journey_a.context, before.journey_state.contexts.journey_a.context);
  assert.deepEqual(after.journey_state.contexts.journey_a.contact_verification, before.journey_state.contexts.journey_a.contact_verification);
  assert.deepEqual(after.renewal_source_receipt, before.renewal_source_receipt);
  assert.deepEqual(after.journey_state.contexts.journey_a.approvals.map(x => x.gate), ['work_selection', 'account_evidence']);
  assert.equal(after.outreach_delivery, undefined);
  assert.equal(s.queryCount(), queries);
  assert.equal((await s.call('beta_claim_outreach_draft', { ...old, private_draft_authorized: true })).code, 'STALE_CASE_REVISION');
  const repeated = await choose(s, run, refs, group.revision);
  assert.equal(repeated.recipient_ref, group.recipient_ref); assert.equal(repeated.expires_at, group.expires_at);
  const revised = { ...email, to: group.to }, next = await review(s, run, group, revised);
  const claim = await s.call('beta_claim_outreach_draft', { ...next, private_draft_authorized: true });
  assert.equal(claim.invoke_gmail, true);
  const drafts = [], gmail = { create_draft: async args => { drafts.push(structuredClone(args)); return { id: 'invented-draft' }; } };
  if (claim.invoke_gmail) await gmail.create_draft(revised);
  assert.equal(drafts.length, 1); assert.equal(drafts[0].to, 'recent@example.invalid, older@example.invalid');
  assert.equal((await s.call('beta_complete_outreach_draft', { case_id: run.args.case_id, revision: group.revision,
    draft_request_ref: claim.draft_request_ref, provider_draft_created: true })).status, 'draft_created');
  const duplicate = await s.call('beta_claim_outreach_draft', { ...next, private_draft_authorized: true });
  assert.equal(duplicate.invoke_gmail, false); assert.equal(duplicate.status, 'already_created');
  assert.equal(s.queryCount(), queries);
  assert.equal(s.calls.filter(x => x === 'beta_create_authorized_journey_a_case').length, 1);
  assert.equal(s.calls.filter(x => ['beta_resolve_renewal_sequence', 'beta_continue_renewal_sequence'].includes(x)).length, guideCalls);
  assert.doesNotMatch(JSON.stringify(s.record(run.args.case_id)), /@example|Invented Recent|Invented Older|Invented next priorities|Invented signature|invented-draft|003000000000/);
});

test('partial invalid groups cannot replace a valid selection or cause new source reads', { timeout: 10000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), refs = run.final.recommended_contacts.map(x => x.contact_ref);
  const valid = await choose(s, run, refs), queries = s.queryCount(), before = s.record(run.args.case_id);
  assert.equal(valid.isError, false);
  for (const contacts of [[], [refs[0], refs[0]], [refs[0], 'f'.repeat(64)], Array.from({ length: 101 }, (_, i) => hash(String(i)))]) {
    assert.equal((await choose(s, run, contacts)).isError, true);
    assert.deepEqual(s.record(run.args.case_id), before);
  }
  const unsupported = await s.call('beta_get_verified_outreach_recipient', { ...run.args, revision: run.revision, contact_refs: refs, email: 'unverified@example.invalid' });
  assert.equal(unsupported.isError, true);
  const ambiguous = await s.call('beta_get_verified_outreach_recipient', { ...run.args, revision: run.revision, contact_refs: refs, contact_ref: refs[0] });
  assert.equal(ambiguous.isError, true);
  const repeat = await choose(s, run, refs); assert.equal(repeat.recipient_ref, valid.recipient_ref);
  assert.equal(s.queryCount(), queries);
});

test('a shortened contact reference is a correctable request error, without claiming addresses are unavailable', { timeout: 10000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), refs = run.final.recommended_contacts.map(x => x.contact_ref);
  const first = await choose(s, run, [refs[0]]), before = s.record(run.args.case_id), queries = s.queryCount();
  for (const selection of [{ contact_refs: [refs[0], refs[1].slice(0, -3)] }, { contact_ref: refs[1].slice(0, -3) }]) {
    const invalid = await s.call('beta_get_verified_outreach_recipient', { ...run.args, revision: first.revision, ...selection });
    assert.equal(invalid.code, 'INVALID_OUTREACH_RECIPIENT_REFERENCE');
    assert.match(invalid.message, /copy.*complete.*contact_ref/i);
    assert.match(invalid.message, /selection is unchanged/i);
    assert.doesNotMatch(invalid.message, /address.*unavailable|read fresh evidence/i);
    assert.deepEqual(s.record(run.args.case_id), before);
  }
  const corrected = await choose(s, run, refs, first.revision);
  assert.equal(corrected.isError, false);
  assert.equal(corrected.to, 'recent@example.invalid, older@example.invalid');
  assert.equal(s.queryCount(), queries);
});

test('a group still needs review and cannot survive process restart or changed To wording', { timeout: 10000 }, async t => {
  const s = start(t), run = await prepareMultiRecipientCase(s), group = await choose(s, run, run.final.recommended_contacts.map(x => x.contact_ref));
  assert.equal(group.isError, false);
  const email = { to: group.to, subject: 'Invented subject', payload: { mime_type: 'text/html', body: { content: '<p>Invented email</p>' } } };
  const args = binding(run, group, email);
  assert.equal((await s.call('beta_bind_outreach_draft_review', args)).code, 'REVIEW_INCOMPLETE');
  assert.equal((await s.call('beta_claim_outreach_draft', { ...args, to_digest: hash('recent@example.invalid'), private_draft_authorized: true })).code, 'OUTREACH_RECIPIENT_MISMATCH');
  const restarted = start(t, s.dir); await restarted.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal((await choose(restarted, run, run.final.recommended_contacts.map(x => x.contact_ref))).code, 'OUTREACH_RECIPIENT_EXPIRED');
});

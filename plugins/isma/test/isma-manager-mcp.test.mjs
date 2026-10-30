import assert from 'node:assert/strict';
import test from 'node:test';
import { startMultiRecipientHost, hash } from './fixtures/outreach-multi-recipient-host.mjs';

const options = { managerEnabled: true, identitySubject: hash('zdp-global:manager@example.invalid'), loader: './isma-manager-loader.mjs' };
async function search(s) {
  let result = await s.call('beta_search_manager_accounts', { query: 'Invented' });
  for (let i = 0; result.status === 'in_progress' && i < 20; i++) {
    result = await s.call('beta_continue_manager_account_search', { manager_search_ref: result.manager_search_ref, wait_seconds: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.status, 'ready', JSON.stringify(result));
  return result.accounts[0].manager_account_selection_ref;
}

test('native manager search hands an exact account into existing contact evidence without a fake owned CTA', async t => {
  const s = startMultiRecipientHost(null, options); t.after(() => { s.stop(); s.cleanup(); });
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal((await s.call('beta_set_account_access_mode', { mode: 'manager_account_search' })).source_permissions_granted, false);
  const ref = await search(s);
  const bad = await s.call('beta_start_meeting_prep_account_brief', { manager_account_selection_ref: ref, account_runtime_id: '001000000000001AAA' });
  assert.equal(bad.code, 'INVALID_INPUT');
  let brief = await s.call('beta_start_meeting_prep_account_brief', { manager_account_selection_ref: ref });
  for (let i = 0; brief.status === 'in_progress' && i < 30; i++) {
    brief = await s.call('beta_continue_meeting_prep_account_brief', { account_brief_ref: brief.account_brief_ref, wait_seconds: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(['ready', 'partial'].includes(brief.status), JSON.stringify(brief));
  let callLookup = await s.call('beta_start_converge_call_lookup', { manager_account_selection_ref: ref, start_date: '2026-10-01', end_date: '2026-10-02' });
  for (let i = 0; callLookup.status === 'in_progress' && i < 20; i++) {
    callLookup = await s.call('beta_continue_meeting_prep_call_lookup', { call_lookup_ref: callLookup.call_lookup_ref, wait_seconds: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(callLookup.status, 'converge_lookup_required', JSON.stringify(callLookup));
  assert.equal(callLookup.native_request.arguments.identifier, '001000000000000AAA');
  const created = await s.call('beta_create_authorized_journey_a_case', { language: 'en' });
  const evidence = await s.call('beta_run_journey_a_contact_evidence', { case_id: created.case_id, manager_account_selection_ref: ref });
  assert.equal(evidence.isError, false, JSON.stringify(evidence));
  const record = s.record(created.case_id);
  assert.equal(record.account_scope, 'manager_selected_account');
  assert.deepEqual(record.journey_a_approvals || [], []);
  assert.equal(JSON.stringify(record).includes('manager@example.invalid'), false);
  assert.equal(s.calls.includes('beta_read_owned_cta_queue'), false);
});

test('a fresh private profile can inspect setup without source reads or a signature-capture step', async t => {
  const s = startMultiRecipientHost(); t.after(() => { s.stop(); s.cleanup(); });
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const result = await s.call('beta_start_setup_wizard', { workflow: 'portfolio_analytics' });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.dependency_checklist.rows.length, 10);
  assert.equal(result.signature_handling.mode, 'gmail_native');
  assert.equal(result.steps.gmail_signature, undefined);
  assert.equal(result.steps.private_master.blocking, false);
  assert.equal(result.dependency_checklist.customer_data_read, false);
  assert.equal(s.queryCount(), 0);
});

test('manager mode cannot grant its own release capability or impersonate a different source identity', async t => {
  for (const settings of [{ ...options, managerEnabled: false }, { ...options, identitySubject: hash('other') }]) {
    const s = startMultiRecipientHost(null, settings); t.after(() => { s.stop(); s.cleanup(); });
    await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    let result = await s.call('beta_search_manager_accounts', { query: 'Invented' });
    if (settings.managerEnabled) {
      for (let i = 0; result.status === 'in_progress' && i < 20; i++) result = await s.call('beta_continue_manager_account_search', { manager_search_ref: result.manager_search_ref, wait_seconds: 0 });
      assert.equal(result.status, 'source_gap'); assert.equal(result.code, 'MANAGER_SOURCE_IDENTITY_MISMATCH');
    } else assert.equal(result.code, 'MANAGER_SEARCH_NOT_ENABLED');
  }
});

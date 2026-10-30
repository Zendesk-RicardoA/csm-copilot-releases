import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readMeetingPrepAccountBriefWithSession } from '../mcp/meeting-prep-account-brief.mjs';

test('an explicitly selected manager account reads the full brief without pretending the manager owns a CSM book', async () => {
  const queries = [], accountId = '001000000000001';
  const identitySubject = createHash('sha256').update('zdp-global:manager@example.invalid').digest('hex');
  const result = await readMeetingPrepAccountBriefWithSession({
    managerSelection: { accountId, accountRefDigest: createHash('sha256').update('account:' + accountId).digest('hex') },
    managerAuthority: { identitySubject, connectionName: 'zdp-global', approvedReadOnlyRoles: ['INVENTED_READ_ONLY'] },
    session: { query: async sql => { queries.push(sql); return [
      { ROW_TYPE: 'scope', CURRENT_USER: 'manager@example.invalid', CURRENT_ROLE: 'INVENTED_READ_ONLY', CURRENT_WAREHOUSE: 'INVENTED_WH' },
      { ROW_TYPE: 'account', ACCOUNT_ID: accountId, ACCOUNT_NAME: 'Invented Managed Account' },
    ]; } },
    readAccountEvidence: async ({ accountId: selected }) => {
      assert.equal(selected, accountId);
      return { review_package: { shared_account_intelligence: { contract: 'AccountIntelligenceCoreV1', account: { identity_state: 'authoritative' }, sections: { account_header: {} } } },
        account_intelligence_receipt: { content_digest: 'a'.repeat(64) }, source_durations_ms: {} };
    },
  });
  assert.equal(result.account_scope, 'manager_selected_account');
  assert.equal(result.account_brief.contract, 'AccountIntelligenceCoreV1');
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0], /SUCCESS_OWNER_C_GC|current_user_candidates/);
});

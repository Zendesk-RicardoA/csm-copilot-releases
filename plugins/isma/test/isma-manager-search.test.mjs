import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ManagerAccountSearches, buildManagerAccountSearchSql, verifyManagerSelectedAccountWithSession } from '../mcp/manager-account-search.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const authority = { identitySubject: hash('zdp-global:manager@example.invalid'), connectionName: 'zdp-global', approvedReadOnlyRoles: ['PUBLIC'] };
const scope = { ROW_TYPE: 'scope', CURRENT_USER: 'manager@example.invalid', CURRENT_ROLE: 'PUBLIC', CURRENT_WAREHOUSE: 'INVENTED_WH' };
const account = { ROW_TYPE: 'account', ACCOUNT_ID: '001000000000000AAA', ACCOUNT_NAME: 'Invented Managed Company' };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('manager name search is literal, bounded and never uses assigned-book rules', () => {
  const sql = buildManagerAccountSearchSql({ query: "Name'_%", limit: 2 });
  assert.match(sql, /POSITION\(LOWER\('Name''_%'\)/);
  assert.match(sql, /LIMIT 3/);
  assert.doesNotMatch(sql, /SUCCESS_OWNER|LIKE|current_user_candidates/);
  for (const value of [{ query: 'ab' }, { query: 'abc', limit: 26 }, { query: 'abc\n' }]) assert.throws(() => buildManagerAccountSearchSql(value));
});

test('search shows overflow, seals selection and preserves owner and original expiry', async () => {
  let now = 1000, calls = 0;
  const searches = new ManagerAccountSearches({ clock: () => now });
  const started = searches.start({ ownerRef: 'manager', query: 'Invented', limit: 1, authority,
    read: async () => { calls++; return [scope, account, { ...account, ACCOUNT_ID: '001000000000001AAA' }]; } });
  await settle();
  const result = searches.poll({ ownerRef: 'manager', searchRef: started.manager_search_ref });
  assert.equal(result.source_limit_reached, true); assert.match(result.warning, /More accounts/);
  assert.equal(JSON.stringify(result).includes(account.ACCOUNT_ID), false);
  const ref = result.accounts[0].manager_account_selection_ref;
  assert.equal(searches.select({ ownerRef: 'manager', selectionRef: ref }).accountId, account.ACCOUNT_ID);
  assert.throws(() => searches.select({ ownerRef: 'other', selectionRef: ref }), /fresh bounded search/);
  now += 14 * 60000; searches.poll({ ownerRef: 'manager', searchRef: started.manager_search_ref });
  now += 60001; assert.throws(() => searches.select({ ownerRef: 'manager', selectionRef: ref }));
  assert.equal(calls, 1);
});

test('identity, current read-only role, duplicate identities and malformed source responses fail closed', async () => {
  for (const rows of [[{ ...scope, CURRENT_USER: 'other@example.invalid' }, account], [{ ...scope, CURRENT_ROLE: 'ADMIN' }, account], [scope, account, account], null]) {
    const searches = new ManagerAccountSearches();
    const started = searches.start({ ownerRef: 'manager', query: 'Invented', authority, read: async () => rows });
    await settle();
    const result = searches.poll({ ownerRef: 'manager', searchRef: started.manager_search_ref });
    assert.equal(result.status, 'source_gap'); assert.equal(result.accounts, undefined);
  }
  await assert.rejects(() => verifyManagerSelectedAccountWithSession({ selection: { accountId: account.ACCOUNT_ID },
    authority, session: { query: async () => [scope] } }), /no longer uniquely available/);
});

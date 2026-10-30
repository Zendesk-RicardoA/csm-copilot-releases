// Bounded account search under the caller's actual source role. This is not a
// manager privilege grant, a portfolio, a customer database or a saved export.
import crypto from 'node:crypto';
import { BetaError } from './core.mjs';
import { parseSnowflakeProbe, SNOWFLAKE_PROBE_SQL } from './credential-bridges.mjs';

const ACCOUNT = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const field = (row, key) => row?.[key] ?? row?.[key.toLowerCase()] ?? null;
const literal = value => "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
export const MANAGER_ACCOUNT_SEARCH_TIMEOUT_MS = 120000;
const TTL = 15 * 60000;

export function buildManagerAccountSearchSql({ query, limit = 25, exact = false }) {
  if (typeof query !== 'string' || query.trim().length < 3 || query.length > 160 || /[\u0000-\u001f]/.test(query)) {
    throw new BetaError('MANAGER_SEARCH_QUERY_REQUIRED', 'Use at least three characters of an account name, up to 160 characters.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || typeof exact !== 'boolean') throw new BetaError('INVALID_MANAGER_SEARCH_LIMIT', 'Search returns at most 25 candidate accounts.');
  const match = exact ? `LOWER(account.NAME) = LOWER(${literal(query.trim())})`
    : `POSITION(LOWER(${literal(query.trim())}) IN LOWER(account.NAME)) > 0`;
  return managerSql(`${match}\n  ORDER BY LOWER(account.NAME), account.ID\n  LIMIT ${limit + 1}`);
}

function managerSql(predicate) {
  return `WITH matched AS (
  SELECT account.ID AS account_id, account.NAME AS account_name
  FROM CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS account
  WHERE ${predicate}
)
SELECT 'scope' AS row_type, CURRENT_USER() AS current_user, CURRENT_ROLE() AS current_role,
  CURRENT_WAREHOUSE() AS current_warehouse, NULL::STRING AS account_id, NULL::STRING AS account_name
UNION ALL
SELECT 'account' AS row_type, NULL, NULL, NULL, account_id, account_name FROM matched`.trim();
}

function verifySource(rows, { identitySubject, connectionName, approvedReadOnlyRoles } = {}) {
  const scopes = Array.isArray(rows) ? rows.filter(row => field(row, 'ROW_TYPE') === 'scope') : [];
  if (scopes.length !== 1 || !DIGEST.test(identitySubject || '')) throw new BetaError('MANAGER_SOURCE_IDENTITY_REQUIRED', 'Verify the signed-in source identity before account search.');
  const probe = parseSnowflakeProbe(JSON.stringify([scopes[0]]), { connectionName, approvedReadOnlyRoles });
  if (probe.identity.subject !== identitySubject) throw new BetaError('MANAGER_SOURCE_IDENTITY_MISMATCH', 'The source identity changed. Verify your own company connection before continuing.');
  if (probe.snowflake.read_only_verified !== true) throw new BetaError('MANAGER_READ_ONLY_ROLE_REQUIRED', 'The current source role is not approved for read-only account lookup. Ask the owner or IT; do not broaden permissions.');
}

function accountsFrom(rows) {
  const accounts = [], ids = new Set();
  for (const row of rows.filter(value => field(value, 'ROW_TYPE') === 'account')) {
    const accountId = field(row, 'ACCOUNT_ID'), accountName = field(row, 'ACCOUNT_NAME');
    if (!ACCOUNT.test(accountId || '') || typeof accountName !== 'string' || !accountName.trim() || ids.has(accountId)) {
      throw new BetaError('MANAGER_ACCOUNT_IDENTITY_UNRESOLVED', 'The account candidates contain missing or conflicting identities. No account was selected.');
    }
    ids.add(accountId); accounts.push({ accountId, accountName, accountRefDigest: hash('account:' + accountId) });
  }
  return accounts;
}

export async function verifyManagerReadOnlySession({ session, authority }) {
  const rows = await session.query(SNOWFLAKE_PROBE_SQL, { timeoutMs: MANAGER_ACCOUNT_SEARCH_TIMEOUT_MS });
  verifySource(Array.isArray(rows) ? rows.map(row => ({ ...row, ROW_TYPE: 'scope' })).filter(row => field(row, 'CURRENT_USER')) : null, authority);
}

export async function verifyManagerSelectedAccountWithSession({ session, selection, authority, onProgress = null }) {
  const { accountId, accountRefDigest } = selection || {};
  if ((!ACCOUNT.test(accountId || '') && !DIGEST.test(accountRefDigest || ''))
      || accountId && accountRefDigest && hash('account:' + accountId) !== accountRefDigest) {
    throw new BetaError('MANAGER_ACCOUNT_SELECTION_REQUIRED', 'Use an exact account selected from the current bounded search.');
  }
  const predicate = accountId ? `account.ID = ${literal(accountId)}`
    : `LOWER(SHA2(CONCAT('account:', account.ID), 256)) = ${literal(accountRefDigest)}`;
  onProgress?.({ stage: 'selected_account_scope', stage_deadline_seconds: 120 });
  await verifyManagerReadOnlySession({ session, authority });
  const rows = await session.query(managerSql(predicate), { timeoutMs: MANAGER_ACCOUNT_SEARCH_TIMEOUT_MS });
  verifySource(rows, authority);
  const accounts = accountsFrom(rows);
  if (accounts.length !== 1 || accounts[0].accountRefDigest !== (accountRefDigest || hash('account:' + accountId))) {
    throw new BetaError('MANAGER_SELECTED_ACCOUNT_UNAVAILABLE', 'The selected account is no longer uniquely available under the current source permissions. Select it again; no broader account read was performed.');
  }
  return { ...accounts[0], account_scope: 'manager_selected_account' };
}

export class ManagerAccountSearches {
  constructor({ clock = Date.now } = {}) { this.clock = clock; this.runs = new Map(); this.selections = new Map(); }
  prune() {
    for (const [ref, run] of this.runs) if (run.expiresAt <= this.clock()) this.runs.delete(ref);
    for (const [ref, selection] of this.selections) if (selection.expiresAt <= this.clock()) this.selections.delete(ref);
  }
  start({ ownerRef, query, limit = 25, exact = false, read, authority }) {
    const sql = buildManagerAccountSearchSql({ query, limit, exact });
    this.prune();
    const ref = crypto.randomUUID(), run = { ownerRef, expiresAt: this.clock() + TTL, state: 'in_progress' };
    this.runs.set(ref, run);
    Promise.resolve().then(() => read(sql)).then(rows => {
      if (this.runs.get(ref) !== run || run.expiresAt <= this.clock()) return;
      verifySource(rows, authority);
      const accounts = accountsFrom(rows), hasMore = accounts.length > limit;
      run.state = 'ready'; run.hasMore = hasMore;
      run.accounts = accounts.slice(0, limit).map(account => {
        const selectionRef = crypto.randomUUID();
        this.selections.set(selectionRef, { ...account, ownerRef, searchRef: ref, expiresAt: run.expiresAt });
        return { account_display_name: account.accountName, account_ref: account.accountRefDigest, manager_account_selection_ref: selectionRef };
      });
    }).catch(error => {
      if (this.runs.get(ref) !== run) return;
      run.state = 'failed'; run.code = /^[A-Z][A-Z0-9_]{2,63}$/.test(error?.code || '') ? error.code : 'MANAGER_ACCOUNT_SEARCH_FAILED';
    });
    return this.poll({ ownerRef, searchRef: ref });
  }
  poll({ ownerRef, searchRef }) {
    this.prune(); const run = this.runs.get(searchRef);
    if (!run || run.ownerRef !== ownerRef) throw new BetaError('MANAGER_SEARCH_UNAVAILABLE', 'The account search expired, restarted or belongs to another user.');
    if (run.state === 'in_progress') return { status: 'in_progress', manager_search_ref: searchRef,
      continuation_request: { tool: 'beta_continue_manager_account_search', arguments: { manager_search_ref: searchRef } },
      next_action: 'Give progress roughly every 20 seconds and continue the same bounded account search. No approval or second search is needed.' };
    if (run.state === 'failed') return { status: 'source_gap', code: run.code, manager_search_ref: searchRef,
      next_action: 'The bounded account search did not complete. Report the source gap; do not infer that no accounts exist or substitute an unrestricted query.' };
    return { status: 'ready', manager_search_ref: searchRef, account_scope: 'manager_account_search', accounts: run.accounts,
      returned_accounts: run.accounts.length, source_limit_reached: run.hasMore,
      warning: run.hasMore ? 'More accounts match than can be shown. Refine the account name; no full portfolio was read or inferred.' : null,
      expires_at: new Date(run.expiresAt).toISOString(), source_permissions_granted: false,
      next_action: run.accounts.length ? 'Choose the exact account from these candidates and use its manager_account_selection_ref for the existing account brief or outreach flow. A search records no approval and does not make this account part of your assigned book.'
        : 'No account matched this bounded name search under the current source role. Refine the name; this does not establish that the account is absent from other authorized sources.' };
  }
  select({ ownerRef, selectionRef }) {
    this.prune(); const selection = this.selections.get(selectionRef);
    if (!selection || selection.ownerRef !== ownerRef) throw new BetaError('MANAGER_ACCOUNT_SELECTION_EXPIRED', 'Choose an exact account from a fresh bounded search owned by this user.');
    return { ...selection };
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {bookOfBusinessPortfolioQueryCapabilities} from '../mcp/book-of-business-portfolio-query.mjs';

const root = new URL('../', import.meta.url);
const skill = () => fs.readFileSync(new URL('skills/csm-copilot-beta/SKILL.md', root), 'utf8');
const guide = () => fs.readFileSync(new URL('skills/csm-copilot-beta/references/read-only-analysis.md', root), 'utf8');

test('a missing built-in report routes analysis to the existing read-only source', () => {
  const capability = bookOfBusinessPortfolioQueryCapabilities();
  assert.equal(capability.read_only_analysis?.execution_owner, 'authenticated_desktop_host');
  assert.equal(capability.read_only_analysis?.same_verified_connection, true);
  assert.equal(capability.read_only_analysis?.request_authorizes_read, true);
  assert.equal(capability.read_only_analysis?.typed_catalog_is_exhaustive, false);
  assert.match(skill(), /references\/read-only-analysis\.md/);
  assert.doesNotMatch(skill(), /beta adapter is the sole runtime data path|never construct or call raw SQL|Never use raw SQL,/);
});

function queryFixture(ambiguousIdentity = false) {
  const fence = String.fromCharCode(96).repeat(3);
  const sql = guide().match(new RegExp(fence + 'sql\\n([\\s\\S]*?)\\n' + fence))[1];
  const result = spawnSync(process.env.CSM_COPILOT_TEST_PYTHON || 'python3', ['-B',
    new URL('./fixtures/read-only-analysis-sqlite.py', import.meta.url).pathname], {
    input: JSON.stringify({sql, ambiguous_identity: ambiguousIdentity}), encoding: 'utf8', shell: false, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || 'The invented SQLite fixture must run.');
  return JSON.parse(result.stdout);
}

test('the bundled ownership query includes other owners across all statuses only inside the current book', () => {
  const rows = queryFixture();
  assert.deepEqual(rows.map(x => x.cta_title).sort(), ['Invented Closed Work', 'Invented Open Work', 'Invented Status Gap']);
  assert.ok(rows.every(x => x.account_name === 'Invented Bay'));
  assert.ok(rows.every(x => x.total_matching_ctas === 3));
  assert.deepEqual(rows.map(x => x.cta_status_is_open).sort(), [null, 0, 1].sort());
  assert.equal(rows.find(x => x.cta_title === 'Invented Status Gap').cta_owner, 'Owner name unavailable');
});

test('the bundled ownership query does not return data for ambiguous authenticated identity', () => {
  assert.deepEqual(queryFixture(true), []);
});

test('read-only analysis keeps source permissions, transient results and workflow approvals', () => {
  const text = guide();
  assert.match(text, /CURRENT_ROLE\(\)/);
  assert.match(text, /approved_read_only_roles/);
  assert.match(text, /shell: false/);
  assert.match(text, /Do not use this path to fetch transcripts, expose contact addresses, record approvals/);
  assert.match(text, /Do not save customer rows/);
  assert.match(text, /source failure.*not.*switch/i);
});

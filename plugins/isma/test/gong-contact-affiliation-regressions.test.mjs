import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGongContactMetadataSql, buildContactEvidenceSql } from '../mcp/journey-a-contact-evidence.mjs';

const ACCOUNT = '001000000000000AAA';

// Source contract: current external participants are non_company; External is
// the existing legacy spelling. Company and unknown participants stay excluded.
// These invented categories and expected counts are fixed independently of the
// query builder. The live diagnostic is never copied into this fixture.
function acceptedAffiliations(query) {
  const clause = /participant\.AFFILIATION\s*(?:=\s*('[^']*')|IN\s*\(([^)]*)\))/i.exec(query);
  assert.ok(clause, 'The external-participant boundary must be explicit.');
  return new Set([...(clause[1] || clause[2]).matchAll(/'([^']*)'/g)].map(match => match[1]));
}

for (const [label, build, countAlias] of [['independent', buildGongContactMetadataSql, 'gong_meeting_count'], ['compatibility', buildContactEvidenceSql, 'meeting_count']]) {
  test(`${label} contact metadata includes current external Gong categories and excludes internal or unknown rows`, () => {
    const query = build(ACCOUNT);
    const allowed = acceptedAffiliations(query);
    const invented = ['non_company', 'non_company', 'External', 'company', 'unknown', null];
    assert.equal(invented.filter(value => allowed.has(value)).length, 3);
    assert.deepEqual([...allowed].sort(), ['External', 'non_company']);
    assert.match(query, /participant\.ASSOCIATED_OBJECT_ID = contact\.ID/);
    assert.match(query, /GONG_CALL_EFFECTIVE_START_DATETIME >= DATEADD\(day, -180/);
    assert.match(query, /SALESFORCE_CONTACT_FORMULA_BCV/);
    assert.ok(query.includes(ACCOUNT));
    assert.doesNotMatch(query, /TRANSCRIPT|CALL_URL|EMAIL_ADDRESS/i);
  });
  test(`${label} meeting counts represent distinct calls even when participant rows repeat`, () => {
    const query = build(ACCOUNT);
    const aggregate = new RegExp(`COUNT\\((DISTINCT call\\.GONG_CONVERSATION_KEY|\\*)\\) AS ${countAlias}`).exec(query);
    assert.ok(aggregate, 'The meeting-count aggregation must be identifiable.');
    const inventedRows = [{ call: 'invented-first' }, { call: 'invented-first' }, { call: 'invented-second' }];
    const observedCount = aggregate[1] === '*' ? inventedRows.length : new Set(inventedRows.map(row => row.call)).size;
    assert.equal(observedCount, 2);
  });
}

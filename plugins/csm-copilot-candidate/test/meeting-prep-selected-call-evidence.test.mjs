import assert from "node:assert/strict";
import test from "node:test";

import {
  SelectedCallEvidenceJobs,
  buildSelectedCallFindingsSql,
  buildSelectedCallPresenceSql,
  buildSelectedCallSafetySql,
  readSelectedCallEvidenceWithSession,
  validateSelectedCallFindings,
  validateSelectedCallSafety,
} from "../mcp/meeting-prep-selected-call-evidence.mjs";
import { authorizeSelectedCallProcessing, createAuthorizedCase } from "../mcp/real-beta.mjs";
import { bindDerivedEvidence } from "../mcp/real-beta.mjs";
import { ACCOUNT_INTELLIGENCE_CORE_CONTRACT, ACCOUNT_INTELLIGENCE_CORE_SECTIONS, ACCOUNT_INTELLIGENCE_CORE_VERSION, RECOMMENDATION_REVIEW_SECTIONS, approveGate, bindAccountIntelligenceCore, bindRecommendationReviewPackage } from "../mcp/core.mjs";

const CALL = { conversationKey: "invented_key_123", accountId: "001000000000000", callAt: "2026-08-11T09:30:00Z" };
const DIGEST = "a".repeat(64);
const manifest = { package_version: "invented-test", renderer_baseline: "recovery-v3" };

test("selected call case does not claim metadata proves transcript safety", () => {
  const record = createAuthorizedCase({
    input: { source_locator_digest: DIGEST, language: "en", recording_present: true, selected_call_only: true },
    testerId: "invented-owner", manifest,
  });
  assert.equal(record.transcript_eligibility.secondary_processing_authorized, false);
  assert.equal(record.transcript_eligibility.service_data_absent, false);
  assert.throws(() => authorizeSelectedCallProcessing(record, {
    revision: record.revision, testerId: "invented-owner", transcriptProcessingAuthorized: true,
    noServiceData: true, noSensitivePersonalData: false, noSuspectedL5: true,
  }), { code: "CALL_NOT_ELIGIBLE" });
  const authorized = authorizeSelectedCallProcessing(record, {
    revision: record.revision, testerId: "invented-owner", transcriptProcessingAuthorized: true,
    noServiceData: true, noSensitivePersonalData: true, noSuspectedL5: true,
  });
  assert.equal(authorized.revision, 2);
  assert.equal(authorized.transcript_eligibility.secondary_processing_authorized, true);
});

test("selected transcript SQL stays source-side, bounded, and redacted", () => {
  const presence = buildSelectedCallPresenceSql(CALL);
  const safety = buildSelectedCallSafetySql({ call: CALL, model: "llama3.1-8b" });
  const findings = buildSelectedCallFindingsSql({ call: CALL, model: "llama3.1-8b" });
  assert.match(presence, /GONG_CALL_TRANSCRIPTS_BCV/);
  assert.match(presence, /DATEADD\(day, -1/);
  assert.match(presence, /LIMIT 1/);
  assert.match(safety, /AI_REDACT\(TO_VARCHAR\(transcript_body\)\)/);
  assert.match(safety, /SPLIT_TEXT_RECURSIVE_CHARACTER/);
  assert.match(findings, /AI_COMPLETE\(/);
  assert.match(findings, /AI_REDACT\(finding.VALUE:paraphrase/);
  assert.doesNotMatch(findings.split("SELECT derived.chunk_index")[1], /transcript_body|chunk_text/);
});

test("full transcript coverage and restricted-content uncertainty stop findings", () => {
  assert.equal(validateSelectedCallSafety([
    { CHUNK_INDEX: 0, CHUNK_COUNT: 2, SAFETY_STATE: "clear" },
    { CHUNK_INDEX: 1, CHUNK_COUNT: 2, SAFETY_STATE: "clear" },
  ]), 2);
  assert.throws(() => validateSelectedCallSafety([
    { CHUNK_INDEX: 0, CHUNK_COUNT: 2, SAFETY_STATE: "clear" },
  ]), { code: "SELECTED_CALL_COVERAGE_UNAVAILABLE" });
  assert.throws(() => validateSelectedCallSafety([
    { CHUNK_INDEX: 0, CHUNK_COUNT: 1, SAFETY_STATE: "uncertain" },
  ]), { code: "SELECTED_CALL_CONTENT_SAFETY_BLOCKED" });
  assert.throws(() => validateSelectedCallFindings([
    { CHUNK_INDEX: 0, CHUNK_COUNT: 1, FINDING_INDEX: 0, CATEGORY: "goal", PARAPHRASE: "Contact person@example.invalid", TOPIC_REFERENCE: "00:03:00", CONFIDENCE: "high" },
  ], 1, DIGEST), { code: "SELECTED_CALL_FINDINGS_INVALID" });
});

test("managed read returns only derived findings and a server-issued receipt", async () => {
  const statements = [];
  const session = { query: async (sql) => {
    statements.push(sql);
    if (statements.length === 1) return [{ TRANSCRIPT_COUNT: 1, SOURCE_UPDATED_AT: "2026-08-12T00:00:00Z" }];
    if (statements.length === 2) return [{ CHUNK_INDEX: 0, CHUNK_COUNT: 1, SAFETY_STATE: "clear" }];
    return [{ CHUNK_INDEX: 0, CHUNK_COUNT: 1, FINDING_INDEX: 0, CATEGORY: "goal", PARAPHRASE: "The team wants fewer manual routing steps.", TOPIC_REFERENCE: "00:03:00", CONFIDENCE: "medium" }];
  } };
  const result = await readSelectedCallEvidenceWithSession({ session, call: CALL, model: "llama3.1-8b", sourceDigest: DIGEST });
  assert.equal(result.status, "ready");
  assert.equal(result.receipt.finding_count, 1);
  assert.equal(result.findings[0].source_ref_digest, DIGEST);
  assert.equal(statements.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /invented_key_123|TRANSCRIPT/);
});

test("owner-bound evidence jobs expire and never reselect a call", async () => {
  let now = 1000;
  const jobs = new SelectedCallEvidenceJobs({ now: () => now, randomBytes: () => Buffer.alloc(18, 1) });
  const started = jobs.start({ ownerRef: "owner-a", caseId: "case-a", read: async () => ({ status: "ready", findings: [] }) });
  assert.throws(() => jobs.poll({ ref: started.evidence_ref, ownerRef: "owner-b" }), { code: "SELECTED_CALL_EVIDENCE_UNAVAILABLE" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.poll({ ref: started.evidence_ref, ownerRef: "owner-a" }).status, "ready");
  now += 31 * 60_000;
  assert.throws(() => jobs.poll({ ref: started.evidence_ref, ownerRef: "owner-a" }), { code: "SELECTED_CALL_EVIDENCE_UNAVAILABLE" });
});

test("invented meeting prep binds the same account and transcript before review", () => {
  let record = createAuthorizedCase({
    input: { source_locator_digest: DIGEST, language: "en", recording_present: true, selected_call_only: true },
    testerId: "invented-owner", manifest,
  });
  record.account_ref_digest = "b".repeat(64);
  const identityOnly = approveGate(record, { gate: "identity", revision: 1, testerId: "invented-owner" });
  assert.throws(() => approveGate(identityOnly, { gate: "evidence", revision: 1, testerId: "invented-owner" }), { code: "MEETING_PREP_EVIDENCE_INCOMPLETE" });
  const sectionStates = Object.fromEntries(ACCOUNT_INTELLIGENCE_CORE_SECTIONS.map((section) => [section, "checked"]));
  assert.throws(() => bindAccountIntelligenceCore(record, {
    contract: ACCOUNT_INTELLIGENCE_CORE_CONTRACT, schemaVersion: ACCOUNT_INTELLIGENCE_CORE_VERSION,
    contentDigest: "c".repeat(64), briefState: "complete", sectionStates,
    accountRefDigest: "d".repeat(64), revision: record.revision, testerId: "invented-owner",
  }), { code: "CROSS_JOURNEY_ACCOUNT_MISMATCH" });
  record = bindAccountIntelligenceCore(record, {
    contract: ACCOUNT_INTELLIGENCE_CORE_CONTRACT, schemaVersion: ACCOUNT_INTELLIGENCE_CORE_VERSION,
    contentDigest: "c".repeat(64), briefState: "complete", sectionStates,
    accountRefDigest: record.account_ref_digest, revision: record.revision, testerId: "invented-owner",
  });
  record = bindDerivedEvidence(record, { digest: "e".repeat(64), findingCount: 2, testerId: "invented-owner" });
  record = approveGate(record, { gate: "identity", revision: record.revision, testerId: "invented-owner" });
  record = approveGate(record, { gate: "evidence", revision: record.revision, testerId: "invented-owner" });
  record = bindRecommendationReviewPackage(record, { reviewPackageDigest: "f".repeat(64), sections: RECOMMENDATION_REVIEW_SECTIONS,
    recommendationRefs: ["recommendation:1"], revision: record.revision, testerId: "invented-owner" });
  record = approveGate(record, { gate: "recommendations", revision: record.revision, testerId: "invented-owner" });
  assert.equal(record.approvals.length, 3);
  assert.equal(record.recommendation_review_package.account_intelligence_core_digest, "c".repeat(64));
  assert.doesNotMatch(JSON.stringify(record), /invented_key_123|The team wants fewer manual routing steps/);
});

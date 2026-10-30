import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  buildMeetingPrepCaseAccountScopeSql,
  MeetingPrepAccountBriefJobs,
  readMeetingPrepAccountBriefWithSession,
  projectMeetingPrepBrief,
  resolveMeetingPrepBriefAccount,
} from "../mcp/meeting-prep-account-brief.mjs";
import { buildRenewalConversationBrief } from "../mcp/renewal-conversation-brief.mjs";

const accountId = "001000000000001";
const scope = { ROW_TYPE: "scope", SCOPE_COUNT: 1, ACCOUNT_MATCH_COUNT: 1 };
const account = { ROW_TYPE: "account", ACCOUNT_ID: accountId, ACCOUNT_NAME: "Invented Account" };

test("active-case account digest resolves only through current in-book ownership", () => {
  const digest = crypto.createHash("sha256").update(`account:${accountId}`).digest("hex");
  const sql = buildMeetingPrepCaseAccountScopeSql(digest);
  assert.match(sql, /SUCCESS_OWNER_C_GC = csm\.GSID/);
  assert.match(sql, /LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)/);
  assert.match(sql, /SHA2\(CONCAT\('account:', company\.SFDC_ACCOUNT_ID\), 256\)/);
  assert.ok(!sql.includes(accountId));
  assert.throws(() => buildMeetingPrepCaseAccountScopeSql(accountId), { code: "MEETING_PREP_ACCOUNT_DIGEST_INVALID" });
});

test("account resolver fails closed on missing or ambiguous book identity", () => {
  assert.deepEqual(resolveMeetingPrepBriefAccount([scope, account]), { status: "selected", accountId });
  assert.equal(resolveMeetingPrepBriefAccount([{ ...scope, ACCOUNT_MATCH_COUNT: 0 }]).status, "account_not_found");
  assert.equal(resolveMeetingPrepBriefAccount([{ ...scope, ACCOUNT_MATCH_COUNT: 2 }, account, { ...account, ACCOUNT_ID: "001000000000002" }]).status, "account_selection_required");
  assert.throws(() => resolveMeetingPrepBriefAccount([{ ...scope, SCOPE_COUNT: 2 }, account]), { code: "MEETING_PREP_SCOPE_UNAVAILABLE" });
});

test("meeting prep reads full account core without a CTA or call transcript", async () => {
  const queries = [];
  const session = { query: async (sql, options) => { queries.push({ sql, options }); return [scope, account]; } };
  const progress = [];
  const result = await readMeetingPrepAccountBriefWithSession({
    session,
    accountName: "Invented",
    onProgress: (event) => progress.push(event.stage),
    readAccountEvidence: async ({ accountId: selected, selectedCta, session: selectedSession }) => {
      assert.equal(selected, accountId);
      assert.equal(selectedCta, null);
      assert.equal(selectedSession, session);
      return {
        review_package: { shared_account_intelligence: { contract: "AccountIntelligenceCoreV1", account: { identity_state: "authoritative" }, sections: { account_header: {} } } },
        account_intelligence_receipt: { content_digest: "a".repeat(64) },
        source_durations_ms: {},
        read_at: "2026-01-01T00:00:00.000Z",
      };
    },
  });
  assert.equal(result.status, "partial", "Identity alone must not make an incomplete brief ready");
  assert.equal(result.account_brief.contract, "AccountIntelligenceCoreV1");
  assert.match(result.account_brief_display.markdown, /Company profile/);
  assert.match(result.account_brief_display.markdown, /Not returned/);
  assert.equal(result.account_brief_completeness.state, "partial");
  assert.equal(result.account_brief_read_state, "failed");
  assert.match(result.account_brief_read_summary, /Source reads did not complete/);
  assert.match(result.next_action, /display_details/);
  assert.deepEqual(progress, ["account_scope", "account_evidence"]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /Salesforce|SALESFORCE_ACCOUNT_BCV/);
  assert.equal(queries[0].options.timeoutMs, 120_000);
  const limits = [];
  await readMeetingPrepAccountBriefWithSession({ session, accountName: "Invented", onProgress: (event) => limits.push(event),
    readAccountEvidence: async () => ({ review_package: { shared_account_intelligence: result.account_brief },
      account_intelligence_receipt: result.account_intelligence_receipt, source_durations_ms: {} }) });
  assert.deepEqual(limits.map((event) => event.stage_deadline_seconds), [120, 300]);
});

test("temporary account brief job is owner-bound and shows progress", async () => {
  const jobs = new MeetingPrepAccountBriefJobs();
  let finish;
  const started = jobs.start({ ownerRef: "owner", read: () => new Promise((resolve) => { finish = resolve; }) });
  assert.equal(started.status, "in_progress");
  assert.throws(() => jobs.poll({ ref: started.account_brief_ref, ownerRef: "other" }), { code: "MEETING_PREP_BRIEF_UNAVAILABLE" });
  await Promise.resolve();
  finish({ status: "ready", account_brief: { contract: "AccountIntelligenceCoreV1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.poll({ ref: started.account_brief_ref, ownerRef: "owner" }).status, "ready");
});

test("stage timing is distinct from total source duration and a restart cannot restore temporary data", async () => {
  let clock = 0, progress, finish;
  const jobs = new MeetingPrepAccountBriefJobs({ now: () => clock });
  const started = jobs.start({ ownerRef: "owner", read: (update) => { progress = update; return new Promise((resolve) => { finish = resolve; }); } });
  await Promise.resolve();
  progress({ stage: "account_scope", stage_deadline_seconds: 120 });
  clock = 89_000;
  progress({ stage: "account_evidence", stage_deadline_seconds: 300 });
  clock = 129_000;
  const pending = jobs.poll({ ref: started.account_brief_ref, ownerRef: "owner" });
  assert.equal(pending.elapsed_seconds, 129);
  assert.equal(pending.stage_elapsed_seconds, 40);
  assert.equal(pending.stage_deadline_seconds, 300);
  clock = 171_000;
  finish({ status: "partial" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.poll({ ref: started.account_brief_ref, ownerRef: "owner" }).source_elapsed_ms, 171_000);
  assert.throws(() => new MeetingPrepAccountBriefJobs().poll({ ref: started.account_brief_ref, ownerRef: "owner" }), { code: "MEETING_PREP_BRIEF_UNAVAILABLE" });
  clock = 901_000;
  assert.throws(() => jobs.poll({ ref: started.account_brief_ref, ownerRef: "owner" }), { code: "MEETING_PREP_BRIEF_UNAVAILABLE" });
});

test("a long account read keeps source and bounded recovery progress visible without another CSM prompt", async () => {
  let clock = 0, update, finish;
  const jobs = new MeetingPrepAccountBriefJobs({ now: () => clock });
  const start = jobs.start({ ownerRef: "invented-owner", read: progress => {
    update = progress; return new Promise(resolve => { finish = resolve; });
  } });
  await Promise.resolve();
  update({ stage: "account_evidence", stage_deadline_seconds: 300, source: "company_profile", attempt: 1, completed_sources: 1, total_sources: 17 });
  for (const elapsed of [20, 40, 80, 119]) {
    clock = elapsed * 1000;
    const progress = jobs.poll({ ref: start.account_brief_ref, ownerRef: "invented-owner" });
    assert.equal(progress.status, "in_progress");
    assert.equal(progress.source, "company_profile");
    assert.equal(progress.attempt, 1);
    assert.equal(progress.stage_elapsed_seconds, elapsed);
    assert.equal(progress.next_check_after_seconds, 20);
  }
  clock = 300_000;
  update({ stage: "account_evidence_recovery", stage_deadline_seconds: 300, source: "company_profile", attempt: 2, completed_sources: 17, total_sources: 17 });
  clock = 340_000;
  const recovery = jobs.poll({ ref: start.account_brief_ref, ownerRef: "invented-owner" });
  assert.equal(recovery.stage, "account_evidence_recovery");
  assert.equal(recovery.stage_deadline_seconds, 300);
  assert.equal(recovery.stage_elapsed_seconds, 40);
  assert.equal(recovery.elapsed_seconds, 340);
  assert.equal(recovery.attempt, 2);
  finish({ status: "partial" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.poll({ ref: start.account_brief_ref, ownerRef: "invented-owner" }).status, "partial");
});

test("shared account brief marks absent selected CTA as not applicable", () => {
  const packageResult = buildRenewalConversationBrief({
    selectedCta: null,
    fullBriefSources: { selected_cta: "not_applicable", cta_monitor_link: "not_applicable", related_account_ctas: "checked" },
  });
  const brief = packageResult.shared_account_intelligence;
  assert.equal(brief.sections.cta_context.state, "checked");
  assert.equal(brief.sections.cta_context.facts.selected_cta, null);
  assert.equal(brief.source_states.selected_cta, "not_applicable");
  assert.equal(brief.sections.cta_context.facts.monitor_link.state, "not_applicable");
  assert.equal(brief.sections.cta_context.facts.related_account_ctas.state, "checked");
  assert.ok(!brief.source_gaps.some((gap) => gap.includes("selected_cta") || gap.includes("cta_monitor_link")));
});

function inventedCaseBrief() {
  const accountDigest = "a".repeat(64);
  const brief = buildRenewalConversationBrief({ selectedCta: null }).shared_account_intelligence;
  const result = { account_brief: brief, account_intelligence_receipt: { account_ref_digest: accountDigest, content_digest: "b".repeat(64) } };
  const caseRecord = { case_id: "11111111-1111-4111-8111-111111111111", tester_id: "invented-owner", account_ref_digest: accountDigest };
  return { result, caseRecord };
}

test("selected-call presentation follows pending, bound, failed and expired state without changing account evidence", () => {
  const { result, caseRecord } = inventedCaseBrief();
  const original = JSON.stringify(result);
  const project = (record = caseRecord, options = {}) => projectMeetingPrepBrief(result, { caseRecord: record, ownerRef: "invented-owner", ...options });
  const pending = project(caseRecord, { selection: { processingAuthorized: true } });
  assert.equal(pending.case_call_context.state, "selected_pending");
  assert.match(pending.account_brief_display.markdown, /A call is selected and authorized/);
  assert.doesNotMatch(pending.account_brief_display.markdown, /A selected and authorized call or reviewed CSM notes is required/);
  const derived = { ...caseRecord, derived_evidence: { finding_count: 2, source_receipt: { account_ref_digest: caseRecord.account_ref_digest, case_id: caseRecord.case_id } } };
  const bound = project(derived, { evidenceAvailable: true });
  assert.equal(bound.case_call_context.state, "available");
  assert.equal(bound.case_call_context.finding_count, 2);
  assert.match(bound.account_brief_display.markdown, /Selected-call findings are available for review/);
  assert.doesNotMatch(bound.account_brief_display.markdown, /A selected and authorized call or reviewed CSM notes is required/);
  const expired = project(derived);
  assert.equal(expired.case_call_context.state, "unavailable");
  assert.match(expired.account_brief_display.markdown, /receipt cannot restore expired findings/);
  assert.doesNotMatch(expired.account_brief_display.markdown, /findings are available for review/);
  const failed = project(caseRecord, { selection: { sourceGap: "CONVERGE_CALL_SOURCE_GAP" } });
  assert.equal(failed.case_call_context.source_gap, "CONVERGE_CALL_SOURCE_GAP");
  assert.match(failed.account_brief_display.markdown, /selected call could not be analyzed/);
  assert.match(project().account_brief_display.markdown, /findings are unavailable in memory/);
  const zero = project({ ...derived, derived_evidence: { ...derived.derived_evidence, finding_count: 0 } }, { evidenceAvailable: true });
  assert.match(zero.account_brief_display.markdown, /returned no findings/);
  assert.equal(JSON.stringify(result), original, "Display projection must not change the canonical account brief or its receipt");
  assert.equal(bound.account_brief, result.account_brief);
  assert.equal(bound.account_intelligence_receipt, result.account_intelligence_receipt);
});

test("selected-call presentation stops on owner, account or case receipt mismatch", () => {
  const { result, caseRecord } = inventedCaseBrief();
  assert.throws(() => projectMeetingPrepBrief(result, { caseRecord, ownerRef: "other-owner" }), { code: "CASE_OWNER_MISMATCH" });
  assert.throws(() => projectMeetingPrepBrief(result, { caseRecord: { ...caseRecord, account_ref_digest: "c".repeat(64) }, ownerRef: caseRecord.tester_id }), { code: "CROSS_JOURNEY_ACCOUNT_MISMATCH" });
  for (const bad of [{ account_ref_digest: "c".repeat(64), case_id: caseRecord.case_id }, { account_ref_digest: caseRecord.account_ref_digest, case_id: "other-case" }]) {
    assert.throws(() => projectMeetingPrepBrief(result, { caseRecord: { ...caseRecord, derived_evidence: { finding_count: 2, source_receipt: bad } }, ownerRef: caseRecord.tester_id, evidenceAvailable: true }), { code: "SELECTED_CALL_ACCOUNT_MISMATCH" });
  }
});

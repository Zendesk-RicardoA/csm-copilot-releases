import test from "node:test";
import assert from "node:assert/strict";
import { prepareMeetingPrepDraftReview, requireFrozenMeetingPrepDraft, reopenMeetingPrepRecommendationReview, meetingPrepDraftReviewPrompt } from "../mcp/meeting-prep-draft-review.mjs";
import { approveGate } from "../mcp/core.mjs";
import { inventedMeetingPrepDraft, INVENTED_MASTER_INVENTORY } from "./fixtures/meeting-prep-draft-input.mjs";

const record = { tester_id: "invented-owner", case_id: "invented-case", revision: 3, account_ref_digest: "a".repeat(64),
  account_intelligence_core: { content_digest: "b".repeat(64), account_ref_digest: "a".repeat(64) }, derived_evidence: { digest: "c".repeat(64) },
  recommendation_review_package: { revision: 3, recommendation_refs: [1, 2, 3, 4].map((n) => `recommendation:${n}`) },
  approvals: ["identity", "evidence", "recommendations"].map((gate) => ({ gate, revision: 3 })), status: "in_review" };
const prepare = (input = inventedMeetingPrepDraft(record), inventory = INVENTED_MASTER_INVENTORY, source = record) => prepareMeetingPrepDraftReview(source, input, inventory, "invented-owner");

test("no CSAT, benchmarks or other metrics still produces a full ordered review plan", () => {
  const input = inventedMeetingPrepDraft(record), reviewed = prepare(input);
  assert.equal(reviewed.draft_review.slide_order.length, 17);
  assert.equal(reviewed.draft_review.slide_order.at(-1), "close");
  assert.ok(reviewed.draft_review.slide_order.indexOf("phase_detail:phase_4") < reviewed.draft_review.slide_order.indexOf("next_steps"));
  assert.doesNotMatch(JSON.stringify(reviewed), /Invented Orchard|invented-library-revision|invented-master-revision|Reduce avoidable effort/);
  requireFrozenMeetingPrepDraft(JSON.parse(JSON.stringify(reviewed)), input); // restart preserves only the receipt
  assert.throws(() => approveGate(record, { gate: "customer_content", revision: 3, testerId: "invented-owner" }), { code: "DRAFT_REVIEW_REQUIRED" });
});

test("changed exact copy, phase order, rendering values or selected source cannot reuse approval", () => {
  const input = inventedMeetingPrepDraft(record), reviewed = prepare(input);
  for (const change of [
    (copy) => { copy.customerContent.phases[0].objective = "Changed objective"; },
    (copy) => { copy.customerContent.phases.reverse(); },
    (copy) => { copy.projection.templateFields.what_was_heard.main_goal = "Changed goal"; },
    (copy) => { copy.maintainedSlideBindings["library:invented:1"].nativeSlideId = "other-slide"; },
  ]) { const changed = structuredClone(input); change(changed); assert.throws(() => requireFrozenMeetingPrepDraft(reviewed, changed), { code: "APPROVED_DRAFT_CHANGED" }); }
  const approved = { ...reviewed, artifact: { digest: "d".repeat(64) }, approvals: [...reviewed.approvals, { gate: "customer_content", revision: 3 }, { gate: "maintained_slides", revision: 3 }] };
  input.projection.templateFields.what_was_heard.main_goal = "Revised goal wording";
  const revised = prepare(input, INVENTED_MASTER_INVENTORY, approved);
  assert.equal(revised.revision, 4);
  assert.deepEqual(revised.approvals.map((item) => item.gate), ["identity", "evidence", "recommendations", "maintained_slides"]);
  assert.equal(revised.artifact, undefined);
});

test("dropped recommendations, incompatible master, unresolved library selections and missing included fields stop before approval", () => {
  assert.throws(() => prepare(undefined, { ...INVENTED_MASTER_INVENTORY, slide_count: 20 }), { code: "MASTER_INVENTORY_INCOMPATIBLE" });
  for (const [change, code] of [
    [(input) => input.customerContent.recommendations.pop(), "RECOMMENDATION_SET_CHANGED"],
    [(input) => { input.customerContent.phases[0].provenance.meaningRefIds = []; }, "RECOMMENDATION_NOT_IN_PLAN"],
    [(input) => { input.slideSelectionReview.proposals.pop(); }, "MAINTAINED_SELECTION_REQUIRED"],
    [(input) => { input.slideSelectionReview.proposals[0].sourceEligibility.audience = "internal"; }, "MAINTAINED_SOURCE_MISMATCH"],
    [(input) => { input.slideSelectionReview.proposals[0].warnings = [{ severity: "blocking" }]; }, "MAINTAINED_SOURCE_MISMATCH"],
    [(input) => { input.metricSlidePlan.speed_quality_trend = { include: true, reason: "available_relevant" }; }, "DRAFT_PROJECTION_INCOMPLETE"],
  ]) { const input = inventedMeetingPrepDraft(record); change(input); assert.throws(() => prepare(input), { code }); }
});

test("requested recommendation edits retain evidence but reset recommendation and later approvals", () => {
  const reviewed = prepare();
  assert.throws(() => reopenMeetingPrepRecommendationReview(reviewed, { testerId: "invented-owner", revision: 3, requested: false }), { code: "REVIEW_REVISION_NOT_REQUESTED" });
  assert.throws(() => reopenMeetingPrepRecommendationReview(reviewed, { testerId: "other-owner", revision: 3, requested: true }), { code: "CASE_OWNER_MISMATCH" });
  const updated = reopenMeetingPrepRecommendationReview(reviewed, { testerId: "invented-owner", revision: 3, requested: true });
  assert.equal(updated.revision, 4);
  assert.deepEqual(updated.approvals.map((item) => item.gate), ["identity", "evidence"]);
  assert.deepEqual(updated.derived_evidence, reviewed.derived_evidence);
  assert.deepEqual(updated.account_intelligence_core, reviewed.account_intelligence_core);
  assert.equal(updated.recommendation_review_package, undefined);
  assert.equal(updated.draft_review, undefined);
});

test("source or phase applicability changes reset both content and library approvals", () => {
  for (const change of [
    input => { const ref = "library:invented:1"; input.maintainedSlideBindings[ref].providerRevision = "invented-new-revision"; input.slideSelectionReview.proposals[0].sourceSnapshot.providerRevision = "invented-new-revision"; },
    input => { input.customerContent.phases[0].objective = "A materially different workflow."; },
  ]) {
    const input = inventedMeetingPrepDraft(record), reviewed = prepare(input);
    const approved = { ...reviewed, approvals: [...reviewed.approvals, ...["customer_content","maintained_slides"].map(gate=>({gate,revision:3}))] };
    change(input); const revised = prepare(input,INVENTED_MASTER_INVENTORY,approved);
    assert.deepEqual(revised.approvals.map(a=>a.gate),["identity","evidence","recommendations"]);
  }
});

test("a technical draft-name correction retains exact approvals without granting render authorization", () => {
  const input = inventedMeetingPrepDraft(record), reviewed = prepare(input);
  const approved = { ...reviewed, approvals: [...reviewed.approvals, ...["customer_content","maintained_slides"].map(gate=>({gate,revision:3}))] };
  input.output.name = "Invented corrected private name";
  const same = prepare(input,INVENTED_MASTER_INVENTORY,approved);
  assert.equal(same.revision,3); assert.deepEqual(same.approvals,approved.approvals);
  assert.equal(same.private_draft_authorization,undefined); requireFrozenMeetingPrepDraft(same,input);
});

test("review prompts ask once for displayed decisions, never re-ask unchanged approvals or grant draft permission", () => {
  const reviewed = prepare(), before = structuredClone(reviewed);
  let prompt = meetingPrepDraftReviewPrompt(reviewed);
  assert.deepEqual(prompt.decisions.map(item => item.gate), ["customer_content", "maintained_slides"]);
  assert.equal(prompt.suggested_reply, "Approve the customer wording and slide choices.");
  assert.equal(prompt.separate_draft_authorization_required, true);
  assert.equal(prompt.rendered_human_review_required, true);
  assert.deepEqual(reviewed, before);
  // An old revision's approval cannot satisfy the current prompt.
  reviewed.approvals.push({ gate: "customer_content", revision: 2 });
  assert.equal(meetingPrepDraftReviewPrompt(reviewed).decisions.length, 2);
  reviewed.approvals.push({ gate: "maintained_slides", revision: 3 });
  prompt = meetingPrepDraftReviewPrompt(reviewed);
  assert.deepEqual(prompt.decisions.map(item => item.gate), ["customer_content"]);
  assert.equal(prompt.suggested_reply, "Approve the customer wording.");
  reviewed.approvals.push({ gate: "customer_content", revision: 3 });
  prompt = meetingPrepDraftReviewPrompt(reviewed);
  assert.deepEqual(prompt.decisions, []);
  assert.equal(prompt.suggested_reply, null);
  assert.equal(reviewed.private_draft_authorization, undefined);
  assert.equal(reviewed.artifact, undefined);
});

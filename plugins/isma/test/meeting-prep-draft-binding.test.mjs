import test from "node:test";
import assert from "node:assert/strict";
import { bindMeetingPrepDraftInput, meetingPrepDraftEvidenceRefs } from "../mcp/meeting-prep-draft-binding.mjs";

const record = {
  case_id: "case:invented",
  revision: 3,
  account_ref_digest: "a".repeat(64),
  account_intelligence_core: { content_digest: "b".repeat(64), account_ref_digest: "a".repeat(64) },
  derived_evidence: { digest: "c".repeat(64) },
  recommendation_review_package: { digest: "d".repeat(64), revision: 3 },
};
const refs = meetingPrepDraftEvidenceRefs(record);
const citation = (id) => ({ evidenceIds: [id], meaningRefIds: [] });
const input = {
  customerContent: {
    status: "content_approved",
    approval: { decision: "approved" },
    alignmentCheck: {
      mainGoal: { provenance: citation(refs.selected_call) },
      painPoints: [{ provenance: citation(refs.selected_call) }],
    },
    recommendations: [{ provenance: citation(refs.account_brief) }],
    phases: [{ provenance: citation(refs.selected_call) }],
  },
  reviewedCaseEvidence: { case_id: "case:spoofed" },
};

test("reviewed account and call receipts populate the private bridge request", () => {
  const bound = bindMeetingPrepDraftInput(record, input, { preparingReview: true });
  assert.equal(bound.reviewedCaseEvidence.case_id, record.case_id);
  assert.equal(bound.reviewedCaseEvidence.account_brief_digest, record.account_intelligence_core.content_digest);
  assert.equal(bound.reviewedCaseEvidence.selected_call_evidence_digest, record.derived_evidence.digest);
  assert.deepEqual(bound.reviewedCaseEvidence.content_evidence_refs, refs);
  assert.equal(input.reviewedCaseEvidence.case_id, "case:spoofed");
});

test("another case's source refs cannot support the reviewed customer content", () => {
  const changed = { ...record, derived_evidence: { digest: "e".repeat(64) } };
  assert.throws(() => bindMeetingPrepDraftInput(changed, input), { code: "MEETING_PREP_DRAFT_SOURCE_MISMATCH" });
  assert.throws(() => bindMeetingPrepDraftInput({ ...record, account_ref_digest: "f".repeat(64) }, input), { code: "MEETING_PREP_EVIDENCE_INCOMPLETE" });
});

test("approval and exact revision remain separate pre-render gates", () => {
  assert.throws(() => bindMeetingPrepDraftInput({ ...record, recommendation_review_package: null }, input), { code: "RECOMMENDATION_REVIEW_REQUIRED" });
  assert.throws(() => bindMeetingPrepDraftInput({ ...record, revision: 4 }, input), { code: "RECOMMENDATION_REVIEW_REQUIRED" });
  assert.throws(() => bindMeetingPrepDraftInput(record, { customerContent: { ...input.customerContent, status: "draft" } }), { code: "CUSTOMER_CONTENT_REVIEW_REQUIRED" });
  assert.throws(() => bindMeetingPrepDraftInput(record, input), { code: "DRAFT_REVIEW_REQUIRED" });
});

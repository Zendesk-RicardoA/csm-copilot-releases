import assert from "node:assert/strict";
import test from "node:test";
import { renewalRunDigest, createRenewalDraftHandoff, completeRenewalConversationRecord } from "../mcp/renewal-completion.mjs";

const runId = "00000000-0000-4000-8000-000000000001";
const receiptRef = "00000000-0000-4000-8000-000000000002";
const now = Date.parse("2026-01-01T00:00:00Z");
function reviewedRecord() {
  const record = {
    case_id: "00000000-0000-4000-8000-000000000003", tester_id: "invented-owner",
    package_version: "invented-package", revision: 3,
    renewal_conversation: {
      account_ref_digest: "a".repeat(64), run_ref_digest: renewalRunDigest(runId),
      deck_content_digest: "b".repeat(64), deck_content_revision: 3,
      evidence_state: "draft_action_pending",
      approvals: ["identity", "evidence", "renewal_hypotheses", "renewal_content"].map((gate) => ({ gate, revision: 3 })),
    },
  };
  record.renewal_conversation.draft_handoff_receipt = createRenewalDraftHandoff(record, { now, receiptRef });
  return record;
}
function completion(overrides = {}) {
  return { runId, outcome: "draft_created", revision: 3, draftReceiptRef: receiptRef, createdConfirmed: true, reviewed: true, now: now + 30 * 60_000, ...overrides };
}

test("completion works after evidence expiry and JSON-only process restart, without retaining customer content", () => {
  const restarted = JSON.parse(JSON.stringify(reviewedRecord()));
  const result = completeRenewalConversationRecord(restarted, completion());
  assert.equal(result.record.renewal_conversation.completion_outcome, "draft_created");
  assert.equal(result.record.renewal_conversation.completion_basis, "csm_confirmed_created_and_rendered_reviewed");
  assert.equal(result.alreadyCompleted, false);
  assert.doesNotMatch(JSON.stringify(result.record), /customer_slides|transcript|presentation_id|account_name/);
  assert.equal(completeRenewalConversationRecord(result.record, completion()).alreadyCompleted, true);
  assert.equal(createRenewalDraftHandoff(restarted, { now: now + 1000 }).receipt_ref, receiptRef);
});

test("completion never infers draft success or rendered human review from a handoff", () => {
  for (const override of [{ createdConfirmed: false }, { reviewed: false }, { createdConfirmed: undefined, reviewed: undefined }]) {
    assert.throws(() => completeRenewalConversationRecord(reviewedRecord(), completion(override)), { code: "RENEWAL_RENDERED_REVIEW_REQUIRED" });
  }
  const record = reviewedRecord();
  delete record.renewal_conversation.draft_handoff_receipt;
  assert.throws(() => completeRenewalConversationRecord(record, completion()), { code: "RENEWAL_DRAFT_HANDOFF_REQUIRED" });
});

test("handoff and completion reject account, owner, package, run, revision, wording and approval mismatch", () => {
  for (const [field, value] of Object.entries({ owner_ref: "another-owner", package_version: "another-package", revision: 2, case_id: "another-case", account_ref_digest: "c".repeat(64), content_digest: "c".repeat(64), run_ref_digest: "c".repeat(64), private_draft_authorized: false })) {
    const record = reviewedRecord();
    record.renewal_conversation.draft_handoff_receipt[field] = value;
    assert.throws(() => completeRenewalConversationRecord(record, completion()), { code: "RENEWAL_DRAFT_HANDOFF_REQUIRED" });
  }
  assert.throws(() => completeRenewalConversationRecord(reviewedRecord(), completion({ revision: 2 })), { code: "STALE_CASE_REVISION" });
  assert.throws(() => completeRenewalConversationRecord(reviewedRecord(), completion({ runId: "other-run" })), { code: "RENEWAL_COMPLETION_RUN_MISMATCH" });
  const record = reviewedRecord();
  record.renewal_conversation.approvals.pop();
  assert.throws(() => completeRenewalConversationRecord(record, completion()), { code: "RENEWAL_DRAFT_HANDOFF_REQUIRED" });
  assert.throws(() => createRenewalDraftHandoff(record), { code: "REVIEW_INCOMPLETE" });
});

test("handoff expires, but cannot change an already recorded outcome", () => {
  assert.throws(() => completeRenewalConversationRecord(reviewedRecord(), completion({ now: now + 8 * 24 * 60 * 60_000 })), { code: "RENEWAL_DRAFT_HANDOFF_EXPIRED" });
  const record = completeRenewalConversationRecord(reviewedRecord(), completion()).record;
  assert.throws(() => completeRenewalConversationRecord(record, completion({ outcome: "not_drafted" })), { code: "RENEWAL_COMPLETION_CONFLICT" });
  assert.equal(completeRenewalConversationRecord(record, completion({ now: now + 8 * 24 * 60 * 60_000 })).alreadyCompleted, true);
});

test("a decision not to draft can close an expired evidence run without implying delivery", () => {
  const result = completeRenewalConversationRecord(reviewedRecord(), { runId, outcome: "not_drafted", now });
  assert.equal(result.record.renewal_conversation.completion_basis, "csm_decision");
  assert.equal(result.record.renewal_conversation.evidence_state, "not_drafted");
});

import crypto from "node:crypto";
import { BetaError } from "./core.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const GATES = ["identity", "evidence", "renewal_hypotheses", "renewal_content"];
const HANDOFF_TTL_MS = 7 * 24 * 60 * 60_000;

export function renewalRunDigest(runId) {
  return hash(`renewal-run:${runId}`);
}

/** No wording, account identifiers, or artifact identifiers enter this receipt.
 * It records authorization to hand off a reviewed revision, NOT renderer success. */
export function createRenewalDraftHandoff(record, { now = Date.now(), receiptRef = crypto.randomUUID() } = {}) {
  const renewal = record.renewal_conversation;
  if (!renewal?.deck_content_digest || renewal.deck_content_revision !== record.revision
      || GATES.some((gate) => !renewal.approvals?.some((approval) => approval.gate === gate && approval.revision === record.revision))) {
    throw new BetaError("REVIEW_INCOMPLETE", "Review the exact current renewal wording before authorizing its private draft.");
  }
  const existing = renewal.draft_handoff_receipt;
  if (existing?.case_id === record.case_id && existing.owner_ref === record.tester_id
      && existing.package_version === record.package_version && existing.revision === record.revision
      && existing.account_ref_digest === renewal.account_ref_digest && existing.run_ref_digest === renewal.run_ref_digest
      && existing.content_digest === renewal.deck_content_digest && existing.private_draft_authorized === true
      && Date.parse(existing.expires_at) > now) return structuredClone(existing);
  return {
    schema_version: "1.0", receipt_ref: receiptRef, case_id: record.case_id,
    owner_ref: record.tester_id, package_version: record.package_version,
    revision: record.revision, account_ref_digest: renewal.account_ref_digest,
    run_ref_digest: renewal.run_ref_digest, content_digest: renewal.deck_content_digest,
    private_draft_authorized: true, issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + HANDOFF_TTL_MS).toISOString(),
  };
}

/** Finish using the minimal persisted handoff, even after evidence memory expires
 * or the process restarts. A CSM confirmation is never called renderer verification. */
export function completeRenewalConversationRecord(record, { runId, outcome, revision, draftReceiptRef, createdConfirmed, reviewed, now = Date.now() }) {
  if (!["draft_created", "not_drafted", "retry_later", "skipped"].includes(outcome)) {
    throw new BetaError("RENEWAL_COMPLETION_INVALID", "Choose an explicit renewal completion outcome.");
  }
  const renewal = record.renewal_conversation;
  if (!renewal || renewal.run_ref_digest !== renewalRunDigest(runId)) {
    throw new BetaError("RENEWAL_COMPLETION_RUN_MISMATCH", "Use the renewal run reference issued for this account and revision.");
  }
  if (revision != null && revision !== record.revision) {
    throw new BetaError("STALE_CASE_REVISION", "Complete only the current reviewed renewal revision.");
  }
  if (outcome === "draft_created") {
    const receipt = renewal.draft_handoff_receipt;
    if (!receipt || receipt.receipt_ref !== draftReceiptRef || receipt.case_id !== record.case_id
        || receipt.owner_ref !== record.tester_id || receipt.package_version !== record.package_version
        || receipt.revision !== revision || receipt.revision !== record.revision
        || receipt.account_ref_digest !== renewal.account_ref_digest
        || receipt.run_ref_digest !== renewal.run_ref_digest
        || receipt.content_digest !== renewal.deck_content_digest || receipt.private_draft_authorized !== true
        || GATES.some((gate) => !renewal.approvals?.some((approval) => approval.gate === gate && approval.revision === revision))) {
      throw new BetaError("RENEWAL_DRAFT_HANDOFF_REQUIRED", "Use the private-draft handoff receipt for the approved current revision. An expired evidence run alone cannot prove a draft was created.");
    }
    if (createdConfirmed !== true || reviewed !== true) {
      throw new BetaError("RENEWAL_RENDERED_REVIEW_REQUIRED", "Confirm that this private draft was created and that you reviewed its rendered slides before closing the renewal workflow.");
    }
    if (!renewal.completion_outcome && Date.parse(receipt.expires_at) <= now) {
      throw new BetaError("RENEWAL_DRAFT_HANDOFF_EXPIRED", "The draft handoff receipt expired. Re-prepare and review this account before recording completion.");
    }
  }
  if (renewal.completion_outcome) {
    if (renewal.completion_outcome !== outcome) {
      throw new BetaError("RENEWAL_COMPLETION_CONFLICT", "This renewal revision was already closed with a different outcome.");
    }
    return { record, alreadyCompleted: true };
  }
  if (!["draft_action_pending", "draft_created", "review_ready", "needs_csm_decision", "evidence_ready", "evidence_ready_with_gaps"].includes(renewal.evidence_state)) {
    throw new BetaError("RENEWAL_COMPLETION_NOT_AVAILABLE", "This renewal account is still preparing or has already been closed.");
  }
  const updated = structuredClone(record);
  Object.assign(updated.renewal_conversation, {
    evidence_state: outcome, completion_outcome: outcome, completed_at: new Date(now).toISOString(),
    completion_basis: outcome === "draft_created" ? "csm_confirmed_created_and_rendered_reviewed" : "csm_decision",
  });
  updated.updated_at = updated.renewal_conversation.completed_at;
  return { record: updated, alreadyCompleted: false };
}

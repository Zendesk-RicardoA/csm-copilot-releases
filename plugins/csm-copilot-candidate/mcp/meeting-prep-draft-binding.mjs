import { BetaError } from "./core.mjs";
import { requireFrozenMeetingPrepDraft } from "./meeting-prep-draft-review.mjs";

export function meetingPrepDraftEvidenceRefs(record) {
  const accountDigest = record?.account_intelligence_core?.content_digest;
  const callDigest = record?.derived_evidence?.digest;
  if (!record?.account_ref_digest
    || record.account_intelligence_core?.account_ref_digest !== record.account_ref_digest
    || !/^[a-f0-9]{64}$/.test(accountDigest || "")
    || !/^[a-f0-9]{64}$/.test(callDigest || "")) {
    throw new BetaError("MEETING_PREP_EVIDENCE_INCOMPLETE", "The selected account brief and call findings must be bound before drafting.");
  }
  return {
    account_brief: `evidence:account:${accountDigest.slice(0, 32)}`,
    selected_call: `evidence:call:${callDigest.slice(0, 32)}`,
  };
}

function provenanceRefs(item) {
  return Array.isArray(item?.provenance?.evidenceIds) ? item.provenance.evidenceIds : [];
}

export function bindMeetingPrepDraftInput(record, suppliedInput, { preparingReview = false } = {}) {
  const refs = meetingPrepDraftEvidenceRefs(record);
  if (!record.recommendation_review_package || record.recommendation_review_package.revision !== record.revision) {
    throw new BetaError("RECOMMENDATION_REVIEW_REQUIRED", "Review the recommendations for this case revision before preparing the private draft.");
  }
  const content = suppliedInput?.customerContent;
  if (!content || (!preparingReview && (content.status !== "content_approved" || content.approval?.decision !== "approved"))) {
    throw new BetaError("CUSTOMER_CONTENT_REVIEW_REQUIRED", "Approve the exact customer content before preparing the private draft.");
  }
  const goalRefs = provenanceRefs(content.alignmentCheck?.mainGoal);
  const painPoints = content.alignmentCheck?.painPoints || [];
  const recommendations = content.recommendations || [];
  const phases = content.phases || [];
  if (!goalRefs.includes(refs.selected_call)
    || !painPoints.some((item) => provenanceRefs(item).includes(refs.selected_call))
    || !recommendations.length || !phases.length
    || recommendations.some((item) => !provenanceRefs(item).some((ref) => Object.values(refs).includes(ref)))
    || phases.some((item) => !provenanceRefs(item).some((ref) => Object.values(refs).includes(ref)))
    || ![...recommendations, ...phases].some((item) => provenanceRefs(item).includes(refs.account_brief))) {
    throw new BetaError("MEETING_PREP_DRAFT_SOURCE_MISMATCH", "The reviewed customer content must cite this case's selected-call findings and account brief.");
  }
  if (!preparingReview) requireFrozenMeetingPrepDraft(record, suppliedInput);
  return {
    ...structuredClone(suppliedInput),
    reviewedCaseEvidence: {
      case_id: record.case_id,
      case_revision: record.revision,
      account_ref_digest: record.account_ref_digest,
      account_brief_digest: record.account_intelligence_core.content_digest,
      selected_call_evidence_digest: record.derived_evidence.digest,
      recommendation_review_digest: record.recommendation_review_package.digest,
      content_evidence_refs: refs,
    },
  };
}

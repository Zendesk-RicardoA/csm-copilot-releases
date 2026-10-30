// Bind the native evidence that actually ran. This is an internal native receipt,
// not a reconstructed CrossJourneyContextV1 or a host-supplied provenance claim.
import crypto from 'node:crypto';
import { BetaError } from './core.mjs';
import { bindJourneyContext } from './journey-orchestrator.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export function bindNativeOutreachEvidence(record, {
  accountRefDigest, evidenceRunRef, brief, contacts, sourceStates, sourceGaps,
  workItemRef = null, testerId, now = new Date(),
}) {
  if (record.tester_id !== testerId) throw new BetaError('CASE_OWNER_MISMATCH', 'This account evidence belongs to another CSM.');
  if (record.journey_state?.active_journey !== 'journey_a') {
    throw new BetaError('JOURNEY_NOT_ACTIVE', 'Keep the selected outreach account active before completing its evidence.');
  }
  const evidenceDigest = hash(evidenceRunRef);
  const verification = record.journey_state.contexts.journey_a.contact_verification;
  if (record.journey_state.account_ref_digest !== accountRefDigest || brief?.account_ref !== accountRefDigest) {
    throw new BetaError('CROSS_JOURNEY_ACCOUNT_MISMATCH', 'The native account brief does not match this selected account.');
  }
  if (verification?.completed_evidence_digest !== evidenceDigest || sourceStates?.contact_snapshot !== 'checked'
    || !Array.isArray(contacts) || contacts.length !== verification.candidate_count) {
    throw new BetaError('CONTACT_VERIFICATION_REQUIRED', 'Complete the same native contact evidence before attaching its account context.');
  }
  const receiptContent = { contract: 'NativeJourneyAContactEvidenceV1', account_digest: accountRefDigest,
    evidence_digest: evidenceDigest, work_item_ref: workItemRef, brief, contacts,
    source_states: sourceStates, source_gaps: sourceGaps };
  const updated = bindJourneyContext(record, {
    journey: 'journey_a', accountRefDigest, contextDigest: hash(JSON.stringify(receiptContent)),
    contextVersion: '1.0.0', itemCount: 1 + contacts.length + (brief.product_performance_metrics?.rows?.length || 0),
    warningCodes: sourceGaps, testerId, now,
  });
  updated.journey_state.contexts.journey_a.context.binding_kind = 'native_outreach_evidence';
  updated.journey_state.contexts.journey_a.context.origin_contract = receiptContent.contract;
  return updated;
}

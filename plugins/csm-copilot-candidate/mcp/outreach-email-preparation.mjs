// Each individual email owns its recipient, review and draft lease. Account
// evidence and the current guide remain shared; no email content is persisted.
import crypto from 'node:crypto';
import { BetaError } from './core.mjs';
import { JOURNEY_A_GATES } from './journey-orchestrator.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const REF = /^[a-f0-9]{64}$/;
const EMAIL_REF = /^[a-f0-9-]{36}$/;
const SHARED = JOURNEY_A_GATES.slice(0, 2);
const previewAction = 'Show the complete unapproved chat email now: one verified To address, subject, body and signature. The conversation host composes this copy from the existing evidence, current guide and requested wording already in chat; this tool returns the verified target and review scope, not the email body. Pending contact, template and wording reviews must not block this preview. They remain required before an explicitly authorized Gmail draft. Keep other emails and their receipts unchanged.';
function chatPreview() {
  return { chat_preview_allowed: true, copy_preparation: 'conversation_host',
    next_step: { kind: 'display_complete_chat_email', required_fields: ['to', 'subject', 'body', 'signature'] } };
}
function account(record, ownerRef, revision) {
  if (record.tester_id !== ownerRef) throw new BetaError('CASE_OWNER_MISMATCH', 'This account preparation belongs to another CSM.');
  if (record.revision !== revision) throw new BetaError('STALE_CASE_REVISION', 'Use the current shared account preparation.');
  const current = record.journey_state?.contexts?.journey_a;
  if (record.journey_state?.active_journey !== 'journey_a' || !current?.context) throw new BetaError('JOURNEY_CONTEXT_REQUIRED', 'Bind the selected account evidence before preparing an email.');
  return current;
}
function savedEmail(record, emailRef) {
  const email = record.outreach_emails?.find(item => item.email_ref === emailRef);
  if (!email) throw new BetaError('OUTREACH_EMAIL_NOT_FOUND', 'Use the email reference returned for this case; do not create another case.');
  return email;
}
export function projectOutreachEmail(record, { ownerRef, revision, emailRef, emailRevision }) {
  const current = account(record, ownerRef, revision);
  if (!EMAIL_REF.test(emailRef || '') || !Number.isInteger(emailRevision) || emailRevision < 1) throw new BetaError('OUTREACH_EMAIL_REFERENCE_REQUIRED', 'Supply both email_ref and its email_revision, together with the current case revision.');
  const email = savedEmail(record, emailRef);
  if (email.revision !== emailRevision) throw new BetaError('STALE_OUTREACH_EMAIL_REVISION', 'Use this email\'s current wording review; other emails are unchanged.');
  if (email.case_id !== record.case_id || email.owner_ref !== ownerRef || email.package_version !== record.package_version
      || email.case_revision !== revision || email.account_digest !== record.journey_state.account_ref_digest
      || email.context_digest !== current.context.digest || email.evidence_digest !== current.contact_verification?.completed_evidence_digest) {
    throw new BetaError('OUTREACH_EMAIL_EVIDENCE_MISMATCH', 'This email no longer matches the current account evidence or package. Earlier approvals cannot authorize changed evidence.');
  }
  const view = structuredClone(record);
  view.revision = email.revision;
  view.journey_state.contexts.journey_a.approvals = structuredClone(email.approvals);
  view.journey_state.contexts.journey_a.status = email.status;
  view.outreach_identity_receipt = structuredClone(email.outreach_identity_receipt);
  if (email.outreach_delivery) view.outreach_delivery = structuredClone(email.outreach_delivery);
  else delete view.outreach_delivery;
  if (email.renewal_source_mode) view.renewal_source_mode = email.renewal_source_mode;
  else delete view.renewal_source_mode;
  return view;
}
export function saveOutreachEmail(record, view, scope) {
  projectOutreachEmail(record, scope);
  const old = savedEmail(record, scope.emailRef);
  if (![old.revision, old.revision + 1].includes(view.revision) || view.case_id !== record.case_id || view.tester_id !== record.tester_id
      || view.package_version !== record.package_version || view.journey_state.account_ref_digest !== old.account_digest
      || view.journey_state.contexts.journey_a.context.digest !== old.context_digest) throw new BetaError('OUTREACH_EMAIL_EVIDENCE_MISMATCH', 'Only this email\'s review can change; keep the shared account preparation.');
  const updated = structuredClone(record), email = updated.outreach_emails.find(item => item.email_ref === scope.emailRef);
  email.revision = view.revision;
  email.approvals = structuredClone(view.journey_state.contexts.journey_a.approvals);
  email.status = view.journey_state.contexts.journey_a.status;
  email.outreach_identity_receipt = structuredClone(view.outreach_identity_receipt);
  if (view.outreach_delivery) email.outreach_delivery = structuredClone(view.outreach_delivery);
  else delete email.outreach_delivery;
  if (view.renewal_source_mode) email.renewal_source_mode = view.renewal_source_mode;
  else delete email.renewal_source_mode;
  return updated;
}
export function outreachEmailReviewStatus(record, emailRef) {
  const email = savedEmail(record, emailRef), completed = email.approvals.map(item => item.gate);
  return { case_id: record.case_id, revision: record.revision, email_ref: email.email_ref, email_revision: email.revision,
    status: email.outreach_delivery?.state || 'email_for_review', completed_gates: completed,
    next_gate: JOURNEY_A_GATES[completed.length] || null,
    recipient_ref: email.outreach_identity_receipt.receipt_ref, address_digest: email.outreach_identity_receipt.address_digest,
    expires_at: email.outreach_identity_receipt.expires_at, recipient_count: 1 };
}
export function prepareOutreachEmail(record, { ownerRef, revision, evidenceRunRef, contactRef, handoffs }) {
  const current = account(record, ownerRef, revision);
  if (!REF.test(contactRef || '')) throw new BetaError('INVALID_OUTREACH_RECIPIENT_REFERENCE', 'Copy the complete contact_ref exactly from the existing verified shortlist. Do not restart account research.');
  if (current.contact_verification?.completed_evidence_digest !== hash(evidenceRunRef || '')) throw new BetaError('OUTREACH_RECIPIENT_MISMATCH', 'Use the completed contact evidence for this same account.');
  if (SHARED.some(gate => !current.approvals?.some(item => item.gate === gate && item.revision === revision))) throw new BetaError('REVIEW_INCOMPLETE', 'Review the shared work selection and account evidence once before preparing individual emails.');
  const contactDigest = hash(contactRef);
  const existing = record.outreach_emails?.find(item => item.contact_digest === contactDigest);
  if (existing) {
    const view = projectOutreachEmail(record, { ownerRef, revision, emailRef: existing.email_ref, emailRevision: existing.revision });
    const status = outreachEmailReviewStatus(record, existing.email_ref), delivery = existing.outreach_delivery;
    if (delivery && delivery.state !== 'review_ready') return { record, email: { ...status,
      status: delivery.state === 'draft_created' ? 'already_created' : 'needs_reconciliation', invoke_gmail: false,
      next_action: 'Keep the original email and draft receipt. Reconcile a pending result; do not create a duplicate or restart the account.' } };
    const recipient = handoffs.read(view, { ownerRef, revision: view.revision, recipientRef: existing.outreach_identity_receipt.receipt_ref, toDigest: existing.outreach_identity_receipt.address_digest });
    return { record, email: { ...recipient, ...status, ...chatPreview(), next_action: previewAction } };
  }
  if (record.outreach_identity_receipt?.contact_digest === contactDigest) {
    const delivery = record.outreach_delivery;
    if (delivery && delivery.state !== 'review_ready') return { record, email: { case_id: record.case_id, revision,
      status: delivery.state === 'draft_created' ? 'already_created' : 'needs_reconciliation', invoke_gmail: false,
      legacy_email: true, next_action: 'Keep the existing email receipt; do not create a second draft to the same selected contact.' } };
    const recipient = handoffs.read(record, { ownerRef, revision, recipientRef: record.outreach_identity_receipt.receipt_ref, toDigest: record.outreach_identity_receipt.address_digest });
    return { record, email: { ...recipient, case_id: record.case_id, revision, legacy_email: true, ...chatPreview(),
      next_action: previewAction + ' Continue this existing email with its original controls.' } };
  }
  if ((record.outreach_emails?.length || 0) >= 100) throw new BetaError('OUTREACH_EMAIL_LIMIT', 'This account has reached the 100-contact preparation limit. No email was silently omitted.');
  const view = structuredClone(record);
  view.revision = 1;
  view.journey_state.contexts.journey_a.approvals = current.approvals.filter(item => SHARED.includes(item.gate)).map(item => ({ ...item, revision: 1, shared_case_revision: revision }));
  delete view.outreach_identity_receipt; delete view.outreach_delivery; delete view.renewal_source_mode;
  const selected = handoffs.select(view, { ownerRef, revision: 1, evidenceRunRef, contactRef });
  if ((record.outreach_emails || []).some(item => item.outreach_identity_receipt.address_digest === selected.handoff.address_digest)
      || record.outreach_identity_receipt?.address_digest === selected.handoff.address_digest) throw new BetaError('OUTREACH_EMAIL_DUPLICATE_ADDRESS', 'An email already exists for this verified address. Review its original receipt instead of creating a duplicate.');
  const updated = structuredClone(record), emailRef = crypto.randomUUID();
  (updated.outreach_emails ||= []).push({ schema_version: '1.0', email_ref: emailRef, case_id: record.case_id, owner_ref: ownerRef,
    package_version: record.package_version, case_revision: revision, revision: 1, status: 'in_review',
    contact_digest: contactDigest, account_digest: record.journey_state.account_ref_digest, context_digest: current.context.digest,
    evidence_digest: current.contact_verification.completed_evidence_digest,
    approvals: selected.record.journey_state.contexts.journey_a.approvals, outreach_identity_receipt: selected.record.outreach_identity_receipt });
  return { record: updated, email: { ...selected.handoff, ...outreachEmailReviewStatus(updated, emailRef), ...chatPreview(),
    next_action: previewAction + ' Use email_ref and email_revision with every review or draft control.' } };
}

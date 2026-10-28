// A complete selected To list can cross the host draft boundary. Source identities and
// addresses stay in expiring memory; durable case receipts contain digests only.
import crypto from "node:crypto";
import { BetaError } from "./core.mjs";

const TTL_MS = 15 * 60 * 1000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const validEmail = email => typeof email === "string" && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email);
function selectionRefs(contactRef, contactRefs) {
  if ((contactRef === undefined) === (contactRefs === undefined)) {
    throw new BetaError("INVALID_OUTREACH_RECIPIENT_SELECTION", "Supply one contact reference or the complete selected contact list, not both.");
  }
  const refs = contactRefs === undefined ? [contactRef] : contactRefs;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 100
      || refs.some(ref => typeof ref !== "string" || !ref || ref.length > 128) || new Set(refs).size !== refs.length) {
    throw new BetaError("INVALID_OUTREACH_RECIPIENT_SELECTION", "Choose one to 100 distinct contacts from the current verified account evidence. No recipient is silently omitted.");
  }
  return [...refs];
}
function context(record, ownerRef, revision) {
  if (record.tester_id !== ownerRef) throw new BetaError("CASE_OWNER_MISMATCH", "This contact review belongs to another CSM.");
  if (record.revision !== revision) throw new BetaError("STALE_CASE_REVISION", "Use the current contact and email review.");
  const current = record.journey_state?.contexts?.journey_a;
  if (record.journey_state?.active_journey !== "journey_a" || !current?.context) {
    throw new BetaError("JOURNEY_CONTEXT_REQUIRED", "Bind the current account evidence before selecting the email recipient.");
  }
  return current;
}

export class OutreachRecipientHandoffs {
  #sources = new Map();
  #selected = new Map();
  #clock;
  constructor({ clock = Date.now } = {}) { this.#clock = clock; }

  prune() {
    const now = this.#clock();
    for (const [ref, source] of this.#sources) if (source.expiresAt <= now) this.#deleteSource(ref);
    for (const [ref, selected] of this.#selected) if (selected.expiresAt <= now) this.#selected.delete(ref);
  }
  #deleteSource(ref) {
    const source = this.#sources.get(ref);
    if (source) { clearTimeout(source.cleanup); source.contacts.clear(); }
    this.#sources.delete(ref);
    for (const [key, selected] of this.#selected) if (selected.evidenceRunRef === ref) this.#selected.delete(key);
  }
  forgetCase(caseId) {
    for (const [ref, source] of this.#sources) if (source.caseId === caseId) this.#deleteSource(ref);
  }
  retain({ caseId, ownerRef, accountRefDigest, evidenceRunRef, expiresAt, contacts, emails }) {
    this.prune();
    this.#deleteSource(evidenceRunRef);
    const expiry = Math.min(expiresAt, this.#clock() + TTL_MS);
    if (!Number.isFinite(expiry) || expiry <= this.#clock()) return;
    const verified = new Map();
    for (const contact of contacts) {
      const email = emails?.get(contact.contact_ref);
      if (contact.identity_status === "eligible" && contact.recipient_eligible === true && validEmail(email)) {
        if (verified.has(contact.contact_ref)) throw new BetaError("CONTACT_DETAIL_IDENTITY_AMBIGUOUS", "More than one current identity matched this contact.");
        verified.set(contact.contact_ref, { contact_ref: contact.contact_ref, display_name: contact.display_name, role: contact.role || null, email });
      }
    }
    const source = { caseId, ownerRef, accountRefDigest, evidenceRunRef, expiresAt: expiry, contacts: verified };
    source.cleanup = setTimeout(() => this.#deleteSource(evidenceRunRef), Math.max(1, expiry - this.#clock()));
    source.cleanup.unref?.();
    this.#sources.set(evidenceRunRef, source);
  }
  select(record, { ownerRef, revision, evidenceRunRef, contactRef, contactRefs }) {
    const current = context(record, ownerRef, revision);
    const refs = selectionRefs(contactRef, contactRefs);
    this.prune();
    // A saved draft lease remains authoritative after transient contact data is lost.
    if (record.outreach_delivery && record.outreach_delivery.state !== "review_ready") {
      throw new BetaError("DRAFT_RECONCILIATION_REQUIRED", "A draft request already started. Check its result before choosing a new recipient.");
    }
    const source = this.#sources.get(evidenceRunRef);
    if (!source) throw new BetaError("OUTREACH_RECIPIENT_EXPIRED", "The verified contact details expired or the process restarted. Read fresh evidence before reviewing a recipient.");
    if (source.ownerRef !== ownerRef || source.caseId !== record.case_id || source.accountRefDigest !== record.journey_state.account_ref_digest
      || current.contact_verification?.completed_evidence_digest !== hash(evidenceRunRef)) {
      throw new BetaError("OUTREACH_RECIPIENT_MISMATCH", "These contact details do not belong to the current account evidence.");
    }
    const recipients = refs.map(ref => source.contacts.get(ref));
    if (recipients.some(recipient => !recipient)) throw new BetaError("CONTACT_RECIPIENT_NOT_VERIFIED", "Every selected contact must have a verified usable address in this account read. Keep the existing selection; do not guess or silently omit a recipient.");
    if (new Set(recipients.map(recipient => recipient.email.toLowerCase())).size !== recipients.length) {
      throw new BetaError("OUTREACH_RECIPIENT_DUPLICATE_ADDRESS", "More than one selected contact has the same email address. Review the selection; no address was silently removed.");
    }
    const old = record.outreach_identity_receipt;
    const selected = old && this.#selected.get(old.receipt_ref);
    const same = selected && JSON.stringify(selected.contactRefs) === JSON.stringify(refs) && selected.evidenceRunRef === evidenceRunRef
      && old.context_digest === current.context.digest && old.revision === revision;
    if (same) return { record, handoff: this.#view(selected, recipients) };
    const updated = structuredClone(record);
    if (old || current.approvals.some(a => ["contact_selection", "template_preview", "outreach_draft"].includes(a.gate))) {
      updated.revision++;
      updated.journey_state.contexts.journey_a.approvals = current.approvals.filter(a => ["work_selection", "account_evidence"].includes(a.gate))
        .map(a => ({ ...a, revision: updated.revision }));
      updated.journey_state.contexts.journey_a.status = "in_review";
      delete updated.outreach_delivery;
    }
    if (old) this.#selected.delete(old.receipt_ref);
    const ref = crypto.randomUUID();
    const to = recipients.map(recipient => recipient.email).join(", ");
    const binding = { receipt_ref: ref, revision: updated.revision,
      contact_digest: hash(refs.length === 1 ? refs[0] : JSON.stringify(refs)), recipient_count: refs.length, evidence_digest: hash(evidenceRunRef),
      account_digest: source.accountRefDigest, context_digest: current.context.digest, address_digest: hash(to),
      expires_at: new Date(source.expiresAt).toISOString() };
    updated.outreach_identity_receipt = binding;
    updated.updated_at = new Date(this.#clock()).toISOString();
    const entry = { ...source, contacts: undefined, cleanup: undefined, contactRefs: refs, binding, revision: updated.revision };
    this.#selected.set(ref, entry);
    return { record: updated, handoff: this.#view(entry, recipients) };
  }
  #view(selected, recipients) {
    return { status: recipients.length === 1 ? "verified_recipient_for_review" : "verified_recipients_for_review",
      revision: selected.binding.revision, recipient_ref: selected.binding.receipt_ref,
      address_digest: selected.binding.address_digest, to: recipients.map(recipient => recipient.email).join(", "),
      recipient_count: recipients.length, recipients: recipients.map(recipient => ({ ...recipient })),
      ...(recipients.length === 1 ? { recipient: { ...recipients[0] } } : {}), expires_at: selected.binding.expires_at,
      source: "Current selected-account native contact evidence", approval_recorded: false, gmail_draft_created: false,
      next_action: "Use the exact returned To field and show every selected recipient with the email for review. Keep this case, valid account/contact evidence and current guide; do not restart their reads to add a recipient. Recipient-dependent reviews still require explicit approval. This handoff does not authorize a Gmail draft." };
  }
  assert(record, { ownerRef, revision, recipientRef, toDigest }) {
    const current = context(record, ownerRef, revision);
    const receipt = record.outreach_identity_receipt;
    if (!receipt) throw new BetaError("OUTREACH_RECIPIENT_REQUIRED", "Select the verified contact or complete recipient list through the native handoff before reviewing the email.");
    if (receipt.receipt_ref !== recipientRef || receipt.address_digest !== toDigest || receipt.revision !== revision
      || receipt.account_digest !== record.journey_state.account_ref_digest || receipt.context_digest !== current.context.digest
      || receipt.evidence_digest !== current.contact_verification?.completed_evidence_digest) {
      throw new BetaError("OUTREACH_RECIPIENT_MISMATCH", "The selected recipient, email address or account evidence changed. Review them again before a draft.");
    }
    this.prune();
    const selected = this.#selected.get(recipientRef);
    if (!selected || !this.#sources.has(selected.evidenceRunRef)) {
      throw new BetaError("OUTREACH_RECIPIENT_EXPIRED", "The selected email is no longer in memory. A receipt cannot restore it after expiry or restart.");
    }
    if (selected.ownerRef !== ownerRef || selected.caseId !== record.case_id || selected.revision !== revision
      || selected.binding.address_digest !== toDigest || selected.binding.context_digest !== current.context.digest
      || selected.binding.contact_digest !== receipt.contact_digest || selected.binding.recipient_count !== receipt.recipient_count) {
      throw new BetaError("OUTREACH_RECIPIENT_MISMATCH", "The email handoff does not match this case review.");
    }
  }
  read(record, options) {
    this.assert(record, options);
    const selected = this.#selected.get(options.recipientRef), source = this.#sources.get(selected.evidenceRunRef);
    const recipients = selected.contactRefs.map(ref => source.contacts.get(ref));
    if (recipients.some(recipient => !recipient)) throw new BetaError('CONTACT_RECIPIENT_NOT_VERIFIED', 'The original verified contact is no longer available. Do not restore it from a saved digest.');
    return this.#view(selected, recipients);
  }
  advanceReview(record, updated, { ownerRef }) {
    const receipt = record.outreach_identity_receipt;
    this.assert(record, { ownerRef, revision: record.revision, recipientRef: receipt?.receipt_ref, toDigest: receipt?.address_digest });
    const selected = this.#selected.get(receipt.receipt_ref);
    selected.revision = updated.revision;
    selected.binding = { ...receipt, revision: updated.revision };
    updated.outreach_identity_receipt = { ...selected.binding };
  }
}

// One selected address can cross the host draft boundary. Source identities and
// addresses stay in expiring memory; durable case receipts contain digests only.
import crypto from "node:crypto";
import { BetaError } from "./core.mjs";

const TTL_MS = 15 * 60 * 1000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const validEmail = email => typeof email === "string" && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(email);
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
  select(record, { ownerRef, revision, evidenceRunRef, contactRef }) {
    const current = context(record, ownerRef, revision);
    this.prune();
    const source = this.#sources.get(evidenceRunRef);
    if (!source) throw new BetaError("OUTREACH_RECIPIENT_EXPIRED", "The verified contact details expired or the process restarted. Read fresh evidence before reviewing a recipient.");
    if (source.ownerRef !== ownerRef || source.caseId !== record.case_id || source.accountRefDigest !== record.journey_state.account_ref_digest
      || current.contact_verification?.completed_evidence_digest !== hash(evidenceRunRef)) {
      throw new BetaError("OUTREACH_RECIPIENT_MISMATCH", "These contact details do not belong to the current account evidence.");
    }
    if (record.outreach_delivery && record.outreach_delivery.state !== "review_ready") {
      throw new BetaError("DRAFT_RECONCILIATION_REQUIRED", "A draft request already started. Check its result before choosing a new recipient.");
    }
    const recipient = source.contacts.get(contactRef);
    if (!recipient) throw new BetaError("CONTACT_RECIPIENT_NOT_VERIFIED", "This contact has no verified usable address in the selected account read. Do not guess an address.");
    const old = record.outreach_identity_receipt;
    const selected = old && this.#selected.get(old.receipt_ref);
    const same = selected && selected.contactRef === contactRef && selected.evidenceRunRef === evidenceRunRef
      && old.context_digest === current.context.digest && old.revision === revision;
    if (same) return { record, handoff: this.#view(selected, recipient) };
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
    const binding = { receipt_ref: ref, revision: updated.revision, contact_digest: hash(contactRef), evidence_digest: hash(evidenceRunRef),
      account_digest: source.accountRefDigest, context_digest: current.context.digest, address_digest: hash(recipient.email),
      expires_at: new Date(source.expiresAt).toISOString() };
    updated.outreach_identity_receipt = binding;
    updated.updated_at = new Date(this.#clock()).toISOString();
    const entry = { ...source, contacts: undefined, cleanup: undefined, contactRef, binding, revision: updated.revision };
    this.#selected.set(ref, entry);
    return { record: updated, handoff: this.#view(entry, recipient) };
  }
  #view(selected, recipient) {
    return { status: "verified_recipient_for_review", revision: selected.binding.revision, recipient_ref: selected.binding.receipt_ref,
      address_digest: selected.binding.address_digest, recipient: { ...recipient }, expires_at: selected.binding.expires_at,
      source: "Current selected-account native contact evidence", approval_recorded: false, gmail_draft_created: false,
      next_action: "Show this exact address with the email for review. This handoff is not contact approval or permission to create a Gmail draft." };
  }
  assert(record, { ownerRef, revision, recipientRef, toDigest }) {
    const current = context(record, ownerRef, revision);
    const receipt = record.outreach_identity_receipt;
    if (!receipt) throw new BetaError("OUTREACH_RECIPIENT_REQUIRED", "Select one verified contact through the native recipient handoff before reviewing the email.");
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
      || selected.binding.address_digest !== toDigest || selected.binding.context_digest !== current.context.digest) {
      throw new BetaError("OUTREACH_RECIPIENT_MISMATCH", "The email handoff does not match this case review.");
    }
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

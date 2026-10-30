import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { OutreachRecipientHandoffs } from "../mcp/outreach-recipient-handoff.mjs";
import { WORKFLOW_CATALOG, validateWorkflowRegistration } from "../mcp/workflow-catalog.mjs";
import { summarizeWorkflowReadiness } from "../mcp/workflow-readiness.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const start = Date.parse("2026-10-13T10:00:00Z");
const run = "00000000-0000-4000-8000-000000000001";
const contact = "contact:" + "c".repeat(64);
const record = () => ({ case_id: "invented-case", tester_id: "invented-owner", revision: 3,
  journey_state: { active_journey: "journey_a", account_ref_digest: "a".repeat(64), contexts: { journey_a: {
    context: { digest: "b".repeat(64) }, approvals: [{ gate: "work_selection", revision: 3 }, { gate: "account_evidence", revision: 3 }],
    contact_verification: { completed_evidence_digest: hash(run) } } } } });
function fixture() {
  let now = start;
  const handoffs = new OutreachRecipientHandoffs({ clock: () => now });
  handoffs.retain({ caseId: "invented-case", ownerRef: "invented-owner", accountRefDigest: "a".repeat(64), evidenceRunRef: run,
    expiresAt: start + 15 * 60 * 1000, contacts: [{ contact_ref: contact, display_name: "Invented Operator", role: "Operations",
      identity_status: "eligible", recipient_eligible: true }], emails: new Map([[contact, "operator@example.invalid"]]) });
  const select = (r = record(), overrides = {}) => handoffs.select(r, { ownerRef: "invented-owner", revision: r.revision, evidenceRunRef: run, contactRef: contact, ...overrides });
  return { handoffs, select, advance: ms => { now += ms; } };
}
test("one native address is transient and repeated disclosure does not extend its expiry", () => {
  const f = fixture(), selected = f.select();
  assert.equal(selected.handoff.recipient.email, "operator@example.invalid");
  assert.equal(selected.handoff.address_digest, hash("operator@example.invalid"));
  assert.doesNotMatch(JSON.stringify(selected.record), /@|Invented Operator|Operations/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.handoffs)), {});
  f.advance(60_000);
  const repeated = f.select(selected.record);
  assert.equal(repeated.handoff.recipient_ref, selected.handoff.recipient_ref);
  assert.equal(repeated.handoff.expires_at, selected.handoff.expires_at);
});
test("absolute 15-minute expiry erases the usable email even if the case receipt is retained", () => {
  const f = fixture(), selected = f.select();
  f.advance(15 * 60 * 1000);
  assert.throws(() => f.handoffs.assert(selected.record, { ownerRef: "invented-owner", revision: 3,
    recipientRef: selected.handoff.recipient_ref, toDigest: selected.handoff.address_digest }), { code: "OUTREACH_RECIPIENT_EXPIRED" });
  assert.throws(() => f.select(selected.record), { code: "OUTREACH_RECIPIENT_EXPIRED" });
});
test("source and selected receipt cannot move to another owner, account, case, context or revision", () => {
  const f = fixture();
  assert.throws(() => f.select(record(), { ownerRef: "another-owner" }), { code: "CASE_OWNER_MISMATCH" });
  const foreign = record(); foreign.case_id = "other-case";
  assert.throws(() => f.select(foreign), { code: "OUTREACH_RECIPIENT_MISMATCH" });
  const account = record(); account.journey_state.account_ref_digest = "d".repeat(64);
  assert.throws(() => f.select(account), { code: "OUTREACH_RECIPIENT_MISMATCH" });
  const selected = f.select(), bound = { ownerRef: "invented-owner", revision: 3, recipientRef: selected.handoff.recipient_ref, toDigest: selected.handoff.address_digest };
  const changed = structuredClone(selected.record); changed.journey_state.contexts.journey_a.context.digest = "e".repeat(64);
  assert.throws(() => f.handoffs.assert(changed, bound), { code: "OUTREACH_RECIPIENT_MISMATCH" });
  assert.throws(() => f.handoffs.assert(selected.record, { ...bound, revision: 2 }), { code: "STALE_CASE_REVISION" });
});
test("unverified, shared, invalid and missing addresses cannot become recipients", () => {
  for (const [email, identity, eligible] of [[null, "eligible", true], ["bad\n@example.invalid", "eligible", true],
    ["support@example.invalid", "role_mailbox", false], ["good@example.invalid", "identity_unresolved", false]]) {
    const f = fixture();
    f.handoffs.retain({ caseId: "invented-case", ownerRef: "invented-owner", accountRefDigest: "a".repeat(64), evidenceRunRef: run,
      expiresAt: start + 900000, contacts: [{ contact_ref: contact, display_name: "Invented Operator", identity_status: identity, recipient_eligible: eligible }],
      emails: new Map([[contact, email]]) });
    assert.throws(() => f.select(), { code: "CONTACT_RECIPIENT_NOT_VERIFIED" });
  }
});
test("a new completed evidence receipt invalidates the previous handoff, even for the same contact", () => {
  const f = fixture(), selected = f.select();
  selected.record.journey_state.contexts.journey_a.contact_verification.completed_evidence_digest = "f".repeat(64);
  assert.throws(() => f.handoffs.assert(selected.record, { ownerRef: "invented-owner", revision: 3,
    recipientRef: selected.handoff.recipient_ref, toDigest: selected.handoff.address_digest }), { code: "OUTREACH_RECIPIENT_MISMATCH" });
});
test("wording-only review revision keeps the same recipient without extending its lifetime", () => {
  const f = fixture(), selected = f.select(), updated = structuredClone(selected.record);
  updated.revision++;
  f.advance(120000);
  f.handoffs.advanceReview(selected.record, updated, { ownerRef: "invented-owner" });
  f.handoffs.assert(updated, { ownerRef: "invented-owner", revision: 4, recipientRef: selected.handoff.recipient_ref, toDigest: selected.handoff.address_digest });
  assert.equal(updated.outreach_identity_receipt.expires_at, selected.handoff.expires_at);
});
test("process restart and explicit cleanup cannot reconstruct raw email from the case receipt", () => {
  const f = fixture(), selected = f.select(), scope = { ownerRef: "invented-owner", revision: 3,
    recipientRef: selected.handoff.recipient_ref, toDigest: selected.handoff.address_digest };
  assert.throws(() => new OutreachRecipientHandoffs({ clock: () => start }).assert(selected.record, scope), { code: "OUTREACH_RECIPIENT_EXPIRED" });
  f.handoffs.forgetCase("invented-case");
  assert.throws(() => f.handoffs.assert(selected.record, scope), { code: "OUTREACH_RECIPIENT_EXPIRED" });
});
test("a package missing the recipient handoff blocks outreach only, without disabling book analysis", () => {
  const names = [...new Set(Object.values(WORKFLOW_CATALOG.workflows).flatMap(w => w.steps.flatMap(s => s.tools)))];
  const availableTools = names.filter(name => name !== "beta_get_verified_outreach_recipient");
  assert.deepEqual(validateWorkflowRegistration(availableTools), [{ workflow: "outreach", step: "verified_recipient_handoff", missing_tool: "beta_get_verified_outreach_recipient" }]);
  const common = { availableTools, setupStatus: "ready", packageStatus: { state: "matched" } };
  assert.equal(summarizeWorkflowReadiness({ ...common, workflow: "outreach" }).state, "blocked");
  assert.equal(summarizeWorkflowReadiness({ ...common, workflow: "portfolio_analytics" }).state, "available_unverified");
});

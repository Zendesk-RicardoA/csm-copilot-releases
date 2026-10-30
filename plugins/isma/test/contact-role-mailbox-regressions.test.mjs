import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  applyContactDetailLookup,
  presentBulkContactResearch,
  readCoreContactEvidenceWithSession,
  recommendContacts,
  verifyBulkContactDetailsWithSession,
} from "../mcp/journey-a-contact-evidence.mjs";
import { OutreachRecipientHandoffs } from "../mcp/outreach-recipient-handoff.mjs";

const now = new Date("2026-10-15T10:00:00Z");
const accountId = n => `001${String(n).padStart(12, "0")}AAA`;
const contactId = n => `003${String(n).padStart(12, "0")}AAA`;
const selected = n => ({ accountId: accountId(n), accountName: `Invented Workshop ${n}`,
  workItemRef: createHash("sha256").update(`invented-work-${n}`).digest("hex") });
const snapshot = (account, id, email = null, touch = "2026-10-14T10:00:00Z") => ({
  ACCOUNT_ID: account.accountId, CONTACT_ID: contactId(id),
  CONTACT_NAME: `Invented Contact ${id}`, CONTACT_TITLE: "Operations",
  CONTACT_EMAIL: email, LATEST_SALES_TOUCH_AT: touch, CANDIDATE_COUNT: 5,
});

test("shared administration addresses never become people even when the source has a person's name", () => {
  const account = selected(11);
  for (const local of ["admin", "administracion", "administración", "administracio\u0301n",
    "ADMINISTRACION", "administracao", "administração", "administration", "administrative",
    "administracion.billing", "administracion-es", "administration_team", "administracion+notifications",
    "support", "billing", "info"]) {
    const result = presentBulkContactResearch([snapshot(account, 11, `${local}@example.invalid`)],
      [account], { now, includeContactEmails: true });
    assert.equal(result.recipient_export.status, "no_verified_recipients", local);
    assert.equal(result.recipient_export.recipient_count, 0, local);
    assert.equal(result.accounts[0].suggested_contacts.length, 0, local);
  }
});

test("recognising department names does not reject a longer personal local part or a surname suffix", () => {
  const account = selected(12);
  for (const local of ["adminson.person", "administracionista.person", "itamar.person", "person.admin", "person.administracion"]) {
    const result = presentBulkContactResearch([snapshot(account, 12, `${local}@example.invalid`)],
      [account], { now, includeContactEmails: true });
    assert.equal(result.recipient_export.recipient_count, 1, local);
    assert.equal(result.accounts[0].suggested_contacts[0].email_address, `${local}@example.invalid`);
  }
});

test("single-account Salesforce verification keeps a shared contact visible but cannot issue its recipient handoff", async () => {
  const account = selected(13), row = snapshot(account, 13);
  const core = await readCoreContactEvidenceWithSession({ accountId: account.accountId,
    accountName: account.accountName, now, session: { query: async () => [row] } });
  const resolved = applyContactDetailLookup(core, [{ ...row, CONTACT_EMAIL: "administracion@example.invalid" }],
    { accountId: account.accountId, state: "checked", now });
  const recommendations = recommendContacts(resolved.contacts, resolved.source_states, 3, now);
  assert.equal(recommendations.prioritized_contacts.length, 1);
  assert.equal(recommendations.prioritized_contacts[0].identity_status, "role_mailbox");
  assert.equal(recommendations.prioritized_contacts[0].recipient_eligible, false);
  assert.equal(recommendations.contacts.length, 0);
  assert.equal(recommendations.rejection_summary.role_mailbox, 1);
  assert.equal(resolved.runtimeContactEmails.size, 0);

  const run = "00000000-0000-4000-8000-000000000013";
  const record = { case_id: "invented-role-case", tester_id: "invented-owner", revision: 3,
    journey_state: { active_journey: "journey_a", account_ref_digest: "a".repeat(64), contexts: { journey_a: {
      context: { digest: "b".repeat(64) },
      approvals: [{ gate: "work_selection", revision: 3 }, { gate: "account_evidence", revision: 3 }],
      contact_verification: { completed_evidence_digest: createHash("sha256").update(run).digest("hex") },
    } } } };
  const handoffs = new OutreachRecipientHandoffs({ clock: () => now.getTime() });
  handoffs.retain({ caseId: record.case_id, ownerRef: record.tester_id, accountRefDigest: "a".repeat(64),
    evidenceRunRef: run, expiresAt: now.getTime() + 900000,
    contacts: resolved.contacts, emails: resolved.runtimeContactEmails });
  assert.throws(() => handoffs.select(record, { ownerRef: record.tester_id, revision: 3,
    evidenceRunRef: run, contactRef: resolved.contacts[0].contact_ref }), { code: "CONTACT_RECIPIENT_NOT_VERIFIED" });
});

test("one five-account batch excludes shared addresses, labels the reason and fills all three people slots", async () => {
  const selections = [21, 22, 23, 24, 25].map(selected);
  const locals = ["administracion", "administración", "administração", "administration", "support"];
  const rows = selections.flatMap((account, index) => [
    snapshot(account, (index + 1) * 10, null, "2026-10-14T10:00:00Z"),
    snapshot(account, (index + 1) * 10 + 1, null, "2026-10-13T10:00:00Z"),
    snapshot(account, (index + 1) * 10 + 2, null, "2026-10-12T10:00:00Z"),
    snapshot(account, (index + 1) * 10 + 3, null, "2026-10-11T10:00:00Z"),
    snapshot(account, (index + 1) * 10 + 4, null, "2026-10-10T10:00:00Z"),
  ]);
  const details = rows.map((row, index) => ({ ...row, CONTACT_EMAIL: index % 5 === 0
    ? `${locals[Math.floor(index / 5)]}@example.invalid`
    : index % 5 === 4 ? "billing@example.invalid" : `person${index}@example.invalid` }));
  const calls = [];
  const result = await verifyBulkContactDetailsWithSession({ snapshotRows: rows, selections, now,
    includeContactEmails: true, session: { async query(sql, options) { calls.push({ sql, options }); return details; } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeoutMs, 120000);
  assert.equal(result.recipient_export.recipient_count, 15);
  assert.equal(result.recipient_export.status, "ready");
  for (const [index, account] of result.accounts.entries()) {
    assert.deepEqual(account.suggested_contacts.map(contact => contact.email_address),
      [1, 2, 3].map(offset => `person${index * 5 + offset}@example.invalid`));
    assert.equal(account.contact_verification_warnings.filter(warning => warning.reason === "role_mailbox").length, 2);
    assert.equal(account.prioritized_contacts.every(contact => contact.identity_status !== "role_mailbox"), true);
  }
  assert.doesNotMatch(result.recipient_export.one_email_per_line, /administr|billing|support/i);
  assert.doesNotMatch(result.recipient_export.comma_separated, /administr|billing|support/i);
});

test("a source containing only shared addresses is not a ready or copyable people list", async () => {
  const selections = [31, 32].map(selected);
  const rows = selections.map((account, index) => snapshot(account, 31 + index));
  const result = await verifyBulkContactDetailsWithSession({ snapshotRows: rows, selections, now,
    includeContactEmails: true,
    session: { query: async () => rows.map(row => ({ ...row, CONTACT_EMAIL: "administracion@example.invalid" })) } });
  assert.equal(result.recipient_export.status, "no_verified_recipients");
  assert.equal(result.recipient_export.recipient_count, 0);
  assert.equal(result.recipient_export.one_email_per_line, "");
  assert.equal(result.recipient_export.comma_separated, "");
  for (const account of result.accounts) {
    assert.equal(account.suggested_contacts.length, 0);
    assert.equal(account.contact_verification_warnings[0].reason, "role_mailbox");
    assert.equal(account.contact_counts.eligible, 0);
  }
});

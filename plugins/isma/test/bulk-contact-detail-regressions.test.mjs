import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBulkContactDetailLookupSql,
  verifyBulkContactDetailsWithSession,
} from "../mcp/journey-a-contact-evidence.mjs";

const accountId = (n) => `001${String(n).padStart(12, "0")}AAA`;
const contactId = (n) => `003${String(n).padStart(12, "0")}AAA`;
const selections = Array.from({ length: 5 }, (_, n) => ({
  accountId: accountId(n + 1), accountName: `Invented ${n + 1}`,
  workItemRef: String(n + 1).repeat(64), priority: "P0", ctaTitle: "P0: Invented task",
}));
const snapshotRows = selections.map((selection, n) => ({
  ACCOUNT_ID: selection.accountId, CONTACT_ID: contactId(n + 1),
  CONTACT_NAME: `Person ${n + 1}`, CONTACT_EMAIL: null,
  CONTACT_TITLE: "Support Lead", LATEST_SALES_TOUCH_AT: "2026-09-10T12:00:00Z",
  CANDIDATE_COUNT: 1,
}));

test("five-account contact export verifies exact snapshot contacts in one Salesforce batch", async () => {
  const calls = [];
  const session = { async query(sql, options) {
    calls.push({ sql, options });
    return snapshotRows.map((row, n) => ({
      ACCOUNT_ID: row.ACCOUNT_ID, CONTACT_ID: row.CONTACT_ID,
      CONTACT_NAME: row.CONTACT_NAME, CONTACT_TITLE: row.CONTACT_TITLE,
      CONTACT_EMAIL: `person${n + 1}@example.invalid`,
    }));
  } };
  const result = await verifyBulkContactDetailsWithSession({
    snapshotRows, selections, session, includeContactEmails: true,
    now: new Date("2026-09-21T12:00:00Z"),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeoutMs, 120_000);
  assert.match(calls[0].sql, /CLEANSED\.SALESFORCE\.SALESFORCE_CONTACT_FORMULA_BCV/);
  assert.equal(result.accounts.length, 5);
  assert.equal(result.recipient_export.recipient_count, 5);
  assert.equal(result.accounts.every((account) => account.suggested_contacts.length === 1), true);
  assert.equal(result.accounts[0].suggested_contacts[0].email_address, "person1@example.invalid");
});

test("bulk detail rejects a wrong-account row and duplicate contact identity", async () => {
  const wrong = { ...snapshotRows[0], ACCOUNT_ID: selections[1].accountId, CONTACT_EMAIL: "wrong@example.invalid" };
  await assert.rejects(verifyBulkContactDetailsWithSession({
    snapshotRows, selections, session: { query: async () => [wrong] }, includeContactEmails: true,
  }), { code: "BULK_CONTACT_DETAIL_ACCOUNT_MISMATCH" });
  const matching = { ...snapshotRows[0], CONTACT_EMAIL: "same@example.invalid" };
  await assert.rejects(verifyBulkContactDetailsWithSession({
    snapshotRows, selections, session: { query: async () => [matching, matching] }, includeContactEmails: true,
  }), { code: "BULK_CONTACT_DETAIL_IDENTITY_AMBIGUOUS" });
});

test("unmatched and invalid addresses are visible and never marked copy-ready", async () => {
  const result = await verifyBulkContactDetailsWithSession({
    snapshotRows, selections, session: { query: async () => [
      { ...snapshotRows[0], CONTACT_EMAIL: "bad-address" },
    ] }, includeContactEmails: true,
  });
  assert.equal(result.recipient_export.status, "no_verified_recipients");
  assert.equal(result.recipient_export.recipient_count, 0);
  assert.equal(result.accounts[0].contact_verification_warnings[0].reason, "invalid_email");
  assert.equal(result.accounts[1].contact_verification_warnings[0].reason, "unmatched_contact");
});

test("bulk details preserve the per-account 100 candidate cap and safe timeout state", async () => {
  const cappedRows = [{ ...snapshotRows[0], CANDIDATE_COUNT: 101 }, snapshotRows[1]];
  const selected = selections.slice(0, 2);
  const sql = buildBulkContactDetailLookupSql(cappedRows, selected);
  assert.match(sql, /native_bulk_contact_details/);
  const result = await verifyBulkContactDetailsWithSession({ snapshotRows: cappedRows, selections: selected,
    session: { query: async () => [] }, includeContactEmails: true });
  assert.equal(result.accounts[0].candidate_limit_reached, true);
  await assert.rejects(verifyBulkContactDetailsWithSession({ snapshotRows: cappedRows, selections: selected,
    session: { query: async () => { const error = new Error("hidden source text"); error.code = "SNOWFLAKE_SESSION_TIMEOUT"; throw error; } },
    includeContactEmails: true }), (error) => error.code === "BULK_CONTACT_DETAILS_TIMEOUT"
      && !JSON.stringify(error).includes("hidden source text"));
});

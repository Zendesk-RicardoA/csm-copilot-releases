import assert from "node:assert/strict";
import test from "node:test";
import * as evidence from "../mcp/journey-a-contact-evidence.mjs";
import { BetaError } from "../mcp/core.mjs";

const ACCOUNT = "001000000000000AAA";
const OTHER = "001000000000001AAA";
const NOW = new Date("2026-10-13T12:00:00Z");
const IDS = ["003000000000001AAA", "003000000000002AAA", "003000000000003AAA"];
const snapshots = [
  { CONTACT_ID: IDS[0], CONTACT_NAME: "Invented Older Support Lead", CONTACT_TITLE: "Support Director", CONTACT_EMAIL: null, LATEST_SALES_TOUCH_AT: "2026-10-01T12:00:00Z" },
  { CONTACT_ID: IDS[1], CONTACT_NAME: "Invented Recent Operator", CONTACT_TITLE: "Operations", CONTACT_EMAIL: null, LATEST_SALES_TOUCH_AT: "2026-10-12T12:00:00Z" },
  { CONTACT_ID: IDS[2], CONTACT_NAME: "Invented No Touch", CONTACT_TITLE: "Director", CONTACT_EMAIL: null, LATEST_SALES_TOUCH_AT: null },
];
async function core() {
  return evidence.readCoreContactEvidenceWithSession({ accountId: ACCOUNT, accountName: "Invented Orchard", now: NOW,
    session: { async query(sql, options) { assert.match(sql, /current_contact_snapshot/); assert.equal(options.timeoutMs, 25000); return snapshots; } } });
}
const identities = [
  { ACCOUNT_ID: ACCOUNT, CONTACT_ID: IDS[0], CONTACT_NAME: "Invented Older Support Lead", CONTACT_TITLE: "Support Director", CONTACT_EMAIL: "older@example.invalid" },
  { ACCOUNT_ID: ACCOUNT, CONTACT_ID: IDS[1], CONTACT_NAME: "Invented Recent Operator", CONTACT_TITLE: "Operations", CONTACT_EMAIL: "recent@example.invalid" },
];

test("blank snapshot emails preserve exact sales-touch priority without making a recipient ready", async () => {
  const first = await core();
  const result = evidence.recommendContacts(first.contacts, first.source_states, 3, NOW);
  assert.deepEqual(result.prioritized_contacts.map(c => c.display_name), ["Invented Recent Operator", "Invented Older Support Lead", "Invented No Touch"]);
  assert.deepEqual(result.prioritized_contacts.map(c => c.sales_touch_age_days), [1, 12, null]);
  assert.equal(result.contacts.length, 0);
  assert.equal(result.prioritized_contact_count, 3);
  assert.equal(first.source_states.salesforce_identity, "not_requested");
  assert.doesNotMatch(JSON.stringify(first), /00300000000000/);
});

test("contact-detail SQL is bound to the same account and exact contact IDs, not names", () => {
  const sql = evidence.buildContactDetailLookupSql(ACCOUNT, IDS);
  assert.match(sql, /CLEANSED\.SALESFORCE\.SALESFORCE_CONTACT_FORMULA_BCV/);
  assert.match(sql, /ACCOUNT_ID = '001000000000000AAA'/);
  assert.match(sql, /ID IN \('003000000000001AAA', '003000000000002AAA', '003000000000003AAA'\)/);
  assert.match(sql, /LIMIT 4/);
  assert.doesNotMatch(sql, /ILIKE|GONG|TRANSCRIPT|UPDATE|INSERT/);
  assert.throws(() => evidence.buildContactDetailLookupSql(ACCOUNT, ["bad' OR 1=1"]), { code: "CONTACT_DETAIL_BINDING_INVALID" });
});

test("same-account identity resolution preserves every priority and exposes unmatched contact as unresolved", async () => {
  const resolved = evidence.applyContactDetailLookup(await core(), identities, { accountId: ACCOUNT, state: "checked", now: NOW });
  const result = evidence.recommendContacts(resolved.contacts, resolved.source_states, 3, NOW);
  assert.deepEqual(result.prioritized_contacts.map(c => c.display_name), ["Invented Recent Operator", "Invented Older Support Lead", "Invented No Touch"]);
  assert.deepEqual(result.contacts.map(c => c.display_name), ["Invented Recent Operator", "Invented Older Support Lead"]);
  assert.equal(result.prioritized_contacts[2].contact_detail_state, "unmatched");
  assert.equal(result.prioritized_contacts[2].recipient_eligible, false);
  assert.equal(resolved.source_states.contact_details, "checked");
  assert.doesNotMatch(JSON.stringify(result), /@|00300000000000/);
  assert.match(resolved.gmail_metadata_request.query, /recent@example\.invalid/);
});

test("cross-account contact details cannot overwrite the snapshot or leak into recipient evidence", async () => {
  const first = await core();
  assert.throws(() => evidence.applyContactDetailLookup(first, [{ ...identities[0], ACCOUNT_ID: OTHER }],
    { accountId: ACCOUNT, state: "checked", now: NOW }), { code: "CONTACT_DETAIL_ACCOUNT_MISMATCH" });
  assert.equal(first.contacts[0].email_availability, "missing");
});

test("duplicate or unrequested contact identity is a safe stop, never a guessed match", async () => {
  const first = await core();
  assert.throws(() => evidence.applyContactDetailLookup(first, [identities[0], identities[0]],
    { accountId: ACCOUNT, state: "checked", now: NOW }), { code: "CONTACT_DETAIL_IDENTITY_AMBIGUOUS" });
  assert.throws(() => evidence.applyContactDetailLookup(first, [{ ...identities[0], CONTACT_ID: "003000000000099AAA" }],
    { accountId: ACCOUNT, state: "checked", now: NOW }), { code: "CONTACT_DETAIL_ACCOUNT_MISMATCH" });
});

test("invalid email and a failed identity source remain visible but never become recipients", async () => {
  const first = await core();
  const invalid = evidence.applyContactDetailLookup(first, [{ ...identities[0], CONTACT_EMAIL: "not-an-address" }],
    { accountId: ACCOUNT, state: "checked", now: NOW });
  assert.equal(evidence.recommendContacts(invalid.contacts, invalid.source_states, 3, NOW).contacts.length, 0);
  const failed = evidence.applyContactDetailLookup(first, [], { accountId: ACCOUNT, state: "timed_out", now: NOW });
  const ranked = evidence.recommendContacts(failed.contacts, failed.source_states, 3, NOW);
  assert.equal(ranked.prioritized_contacts.length, 3);
  assert.equal(ranked.contacts.length, 0);
  assert.ok(ranked.prioritized_contacts.every(c => c.contact_detail_state === "timed_out"));
  assert.ok(failed.source_gap_codes.includes("CONTACT_DETAILS_TIMEOUT"));
});

test("managed contact lookup returns its result before slower context and retries only a timeout", async () => {
  const first = await core(); const calls = [], callbacks = [], progress = []; let clock = 0;
  const source = sql => sql.includes("native_contact_details") ? "contact_details"
    : sql.includes("account_brief") ? "account_context" : sql.includes("SALESFORCE_TASK_FORMULA_BCV") ? "salesforce_activity" : "gong_metadata";
  const result = await evidence.readSlowJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: first,
    fastEvidence: { source_durations_ms: {}, monthly_metric_source_results: { rba: { state: "checked", rows: [] }, guide: { state: "checked", rows: [] } } },
    now: NOW, nowMs: () => clock, onProgress: p => progress.push(p), onContactDetails: value => callbacks.push(value),
    session: { async query(sql, options) {
      const name = source(sql); calls.push(name); assert.ok(options.timeoutMs <= 120000);
      if (name === "contact_details" && calls.filter(s => s === name).length === 1) { clock += options.timeoutMs; throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented timeout."); }
      clock += 1000;
      return name === "contact_details" ? identities : name === "account_context" ? [{ ACCOUNT_ID: ACCOUNT, ACCOUNT_NAME: "Invented Orchard" }] : [];
    } } });
  assert.deepEqual(calls, ["contact_details", "account_context", "salesforce_activity", "gong_metadata", "contact_details"]);
  assert.equal(result.source_states.contact_details, "checked");
  assert.equal(evidence.recommendContacts(result.contacts, result.source_states, 3, NOW).contacts.length, 2);
  assert.equal(callbacks.at(-1).contacts.filter(c => c.recipient_eligible).length, 2);
  assert.equal(progress[0].source, "contact_details");
  assert.ok(clock <= 600000);
});

test("future and missing sales-touch dates are unknown, not invented zero-day engagement", () => {
  const result = evidence.recommendContacts([
    { contact_ref: "a", display_name: "Invented Future", identity_status: "email_missing", latest_recorded_sales_touch_at: "2027-01-01" },
    { contact_ref: "b", display_name: "Invented Known", identity_status: "email_missing", latest_recorded_sales_touch_at: "2026-10-12T12:00:00Z" },
  ], { contact_snapshot: "checked" }, 3, NOW);
  assert.equal(result.prioritized_contacts[0].display_name, "Invented Known");
  assert.equal(result.prioritized_contacts[1].sales_touch_age_days, null);
});

test("bulk snapshot research also keeps named missing-email priorities visible", () => {
  const rows = snapshots.map(row => ({ ...row, ACCOUNT_ID: ACCOUNT }));
  const result = evidence.presentBulkContactResearch(rows, [{ accountId: ACCOUNT, accountName: "Invented Orchard" }], { now: NOW });
  assert.equal(result[0].prioritized_contacts.length, 3);
  assert.equal(result[0].prioritized_contacts[0].display_name, "Invented Recent Operator");
  assert.equal(result[0].suggested_contacts.length, 0);
});

test("identity enrichment cannot reorder equal-touch priorities when current names or titles differ", async () => {
  const rows = snapshots.slice(0, 2).map(row => ({ ...row, LATEST_SALES_TOUCH_AT: "2026-10-12T12:00:00Z" }));
  const first = await evidence.readCoreContactEvidenceWithSession({ accountId: ACCOUNT, accountName: "Invented Orchard", now: NOW,
    session: { async query() { return rows; } } });
  const before = evidence.recommendContacts(first.contacts, first.source_states, 3, NOW).prioritized_contacts.map(c => c.contact_ref);
  const resolved = evidence.applyContactDetailLookup(first, identities.map((row, i) => ({ ...row, CONTACT_TITLE: i ? "Support Director" : "Operations" })),
    { accountId: ACCOUNT, state: "checked", now: NOW });
  assert.deepEqual(evidence.recommendContacts(resolved.contacts, resolved.source_states, 3, NOW).prioritized_contacts.map(c => c.contact_ref), before);
});

test("unusable current identity does not erase a named snapshot priority or authorize an email", async () => {
  const first = await core();
  for (const [identity, state] of [[{ ...identities[1], CONTACT_NAME: "Unknown" }, "identity_unusable"],
    [{ ...identities[1], CONTACT_EMAIL: "support@example.invalid" }, "email_unavailable"]]) {
    const resolved = evidence.applyContactDetailLookup(first, [identity], { accountId: ACCOUNT, state: "checked", now: NOW });
    const result = evidence.recommendContacts(resolved.contacts, resolved.source_states, 3, NOW);
    assert.equal(result.prioritized_contacts.length, 3);
    assert.equal(result.prioritized_contacts[0].display_name, "Invented Recent Operator");
    assert.equal(result.prioritized_contacts[0].contact_detail_state, state);
    assert.equal(result.contacts.length, 0);
  }
});

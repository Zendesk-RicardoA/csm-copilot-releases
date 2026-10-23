import assert from "node:assert/strict";
import test from "node:test";
import { BetaError } from "../mcp/core.mjs";
import {
  presentCoreContactEvidence, recommendContacts,
  readFastJourneyAContactEvidenceWithSession, readSlowJourneyAContactEvidenceWithSession,
  CORE_CONTACT_IDENTITY_READ_TIMEOUT_MS,
} from "../mcp/journey-a-contact-evidence.mjs";
import { CTA_QUEUE_READ_TIMEOUT_MS } from "../mcp/journey-a-cta-queue.mjs";

const ACCOUNT = "001000000000000AAA";
const date = new Date("2026-10-01T12:00:00Z");
const contact = (id, name, email) => ({ ACCOUNT_ID: ACCOUNT, ACCOUNT_NAME: "Invented Orchard",
  CONTACT_ID: id, CONTACT_NAME: name, CONTACT_EMAIL: email, CONTACT_TITLE: "Support Lead" });
const context = [{ ACCOUNT_ID: ACCOUNT, ACCOUNT_NAME: "Invented Orchard", CSM_NAME: "Invented CSM",
  NET_ARR_USD: 12000, CS_SEGMENT: "Scaled", COMPANY_INDUSTRY: "Invented industry" }];
const timeout = () => new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented statement timeout.");
const sourceFor = sql => sql.includes("account_brief") ? "account_context"
  : sql.includes("SALESFORCE_TASK_FORMULA_BCV") ? "salesforce_activity" : "gong_metadata";

async function seed() {
  const core = presentCoreContactEvidence([contact("invented-contact", "Invented Person", "person@example.invalid")], { now: date });
  const fast = await readFastJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: core, now: date,
    session: { async query(sql) { return sql.includes("FACT_GUIDE_ARTICLE_VIEWS")
      ? [{ GUIDE_KNOWLEDGE_VIEWS_MONTH: 202609, GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 125 }]
      : [{ RBA_METRICS_MONTH: 202609, CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 240,
        SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 230, FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 2 }]; } } });
  return { core, fast };
}

test("outreach gives a 95-second context statement time to finish, without changing the CTA or contact limits", async () => {
  const { core, fast } = await seed(); let clock = 0; const limits = [];
  const result = await readSlowJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: core, fastEvidence: fast,
    now: date, nowMs: () => clock, session: { async query(sql, options) {
      limits.push(options.timeoutMs); const source = sourceFor(sql);
      const needed = source === "account_context" ? 95000 : 1000;
      clock += Math.min(needed, options.timeoutMs);
      if (needed > options.timeoutMs) throw timeout();
      return source === "account_context" ? context : [];
    } } });
  assert.equal(result.source_states.account_context, "checked");
  assert.deepEqual(limits, [120000, 120000, 120000]);
  assert.equal(CTA_QUEUE_READ_TIMEOUT_MS, 25000);
  assert.equal(CORE_CONTACT_IDENTITY_READ_TIMEOUT_MS, 25000);
});

test("outreach tries each independent background source before one bounded timeout recovery", async () => {
  const { core, fast } = await seed(); let clock = 0; const calls = [], progress = [];
  const result = await readSlowJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: core, fastEvidence: fast,
    now: date, nowMs: () => clock, onProgress: value => progress.push(value), session: { async query(sql, options) {
      const source = sourceFor(sql); calls.push(source);
      if (source === "account_context" && calls.filter(v => v === source).length === 1) {
        clock += options.timeoutMs; throw timeout();
      }
      clock += 1000; return source === "account_context" ? context : [];
    } } });
  assert.deepEqual(calls, ["account_context", "salesforce_activity", "gong_metadata", "account_context"]);
  assert.equal(result.source_states.account_context, "checked");
  assert.deepEqual(result.source_gap_codes, []);
  assert.equal(progress.at(-1).stage, "account_evidence_recovery");
  assert.equal(progress.at(-1).attempt, 2);
  assert.equal(progress.at(-1).stage_deadline_seconds, 300);
  assert.ok(clock <= 600000);
});

test("outreach exhausts at most two attempts and two five-minute windows", async () => {
  const { core, fast } = await seed(); let clock = 0; const calls = [];
  const result = await readSlowJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: core, fastEvidence: fast,
    now: date, nowMs: () => clock, session: { async query(sql, options) {
      calls.push(sourceFor(sql)); assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 120000);
      clock += options.timeoutMs; throw timeout();
    } } });
  assert.deepEqual(calls, ["account_context", "salesforce_activity", "gong_metadata", "account_context", "salesforce_activity", "gong_metadata"]);
  assert.ok(clock <= 600000);
  assert.equal(result.source_states.account_context, "timed_out");
  assert.ok(result.source_gap_codes.includes("ACCOUNT_CONTEXT_TIMEOUT"));
});

test("a final context failure preserves already-verified monthly metrics and contacts", async () => {
  const { core, fast } = await seed(); const calls = [];
  const result = await readSlowJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: core, fastEvidence: fast,
    now: date, session: { async query(sql) { const source = sourceFor(sql); calls.push(source);
      if (source === "account_context") throw new BetaError("SOURCE_PERMISSION_DENIED", "Invented source failure.");
      return []; } } });
  assert.deepEqual(calls, ["account_context", "salesforce_activity", "gong_metadata"]);
  assert.equal(result.source_states.account_context, "unavailable");
  assert.deepEqual(result.source_gap_codes, ["ACCOUNT_CONTEXT_UNAVAILABLE"]);
  assert.deepEqual(result.contacts, core.contacts.map(c => ({ ...c, salesforce_activity_state: "checked", gong_metadata_state: "checked" })));
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, 240);
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Knowledge views").value, 125);
  assert.equal(result.source_states.rba_monthly_metrics, "checked");
});

test("contact diagnostics explain every exclusion without exposing source IDs or email addresses", () => {
  const core = presentCoreContactEvidence([
    contact("invented-unknown", "Unknown", "placeholder@example.invalid"),
    contact("invented-no-email", "Invented Missing Address", null),
    contact("invented-role", "Invented Shared Inbox", "support@example.invalid"),
    contact("invented-person", "Invented Person", "person@example.invalid"),
  ], { now: date });
  const result = recommendContacts(core.contacts, core.source_states, 3, date);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].display_name, "Invented Person");
  assert.deepEqual(result.rejection_summary, { placeholder: 1, email_missing: 1, role_mailbox: 1 });
  assert.deepEqual(result.excluded_contacts.map(c => c.reason_code), ["placeholder", "email_missing", "role_mailbox"]);
  assert.ok(result.excluded_contacts.every(c => /^[a-f0-9]{64}$/.test(c.contact_ref) && c.explanation));
  assert.doesNotMatch(JSON.stringify(result.excluded_contacts), /@|invented-unknown|invented-no-email|invented-role/);
});

test("no eligible contact is not described as a ranked shortlist or proof that no customer contacts exist", () => {
  const core = presentCoreContactEvidence([contact("invented-missing", "Invented Person", null)], { now: date });
  const result = recommendContacts(core.contacts, core.source_states, 3, date);
  assert.equal(result.state, "no_eligible_contacts");
  assert.match(result.message, /No contact is recommended/);
  assert.doesNotMatch(result.message, /^Ranked/);
  assert.deepEqual(result.rejection_summary, { email_missing: 1 });
});

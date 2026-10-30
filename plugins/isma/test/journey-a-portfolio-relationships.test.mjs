import assert from "node:assert/strict";
import test from "node:test";
import { BetaError } from "../mcp/core.mjs";

import {
  buildPortfolioRelationshipSql,
  presentPortfolioRelationships,
  readPortfolioRelationships,
  PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS,
  PortfolioRelationshipReadJobs,
} from "../mcp/journey-a-portfolio-relationships.mjs";

test("the portfolio relationship query is scoped to owned in-book CTAs and uses Salesforce, not Gong", () => {
  const query = buildPortfolioRelationshipSql(60);
  assert.match(query, /LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)/);
  assert.match(query, /cta\.OWNER_ID = authenticated_csm\.GSID/);
  assert.match(query, /company\.SUCCESS_OWNER_C_GC = authenticated_csm\.GSID/);
  assert.match(query, /SALESFORCE_TASK_FORMULA_BCV/);
  assert.match(query, /task\.ACCOUNT_ID IN \(SELECT account_id FROM owned_accounts\)/);
  assert.match(query, /SELECT DISTINCT account_id FROM owned_open_ctas/);
  assert.match(query, /status_pl\.IS_OPEN_STATUS = TRUE/);
  assert.match(query, /task\.ACTIVITY_DATE >= DATEADD\(day, -60/);
  assert.equal(query.includes("SALESFORCE_CONTACT_FORMULA_BCV"), false);
  assert.equal(query.includes("GONG_"), false);
  assert.equal(query.includes("TRANSCRIPT"), false);
});

test("recent Salesforce activity confirms relationship history and otherwise asks for Gmail metadata", () => {
  const result = presentPortfolioRelationships([
    { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
    { ROW_TYPE: "account", CTA_ID: "cta-1", ACCOUNT_ID: "001000000000000AAA", ACCOUNT_NAME: "Invented One", CTA_NAME: "P0: Non-Monthly Renewal", SALESFORCE_ACTIVITY_COUNT: 2, LATEST_SALESFORCE_ACTIVITY_AT: "2026-09-13" },
    { ROW_TYPE: "account", CTA_ID: "cta-2", ACCOUNT_ID: "001000000000001AAA", ACCOUNT_NAME: "Invented Two", CTA_NAME: "P1: Non-Monthly Renewal", SALESFORCE_ACTIVITY_COUNT: 0, LATEST_SALESFORCE_ACTIVITY_AT: null },
  ], 60, new Date("2026-09-14T10:00:00Z"));
  assert.equal(result.accounts[0].recent_relationship_in_past_days.state, "confirmed_in_salesforce");
  assert.equal(result.accounts[0].source_states.gmail_metadata, "not_needed");
  assert.equal(result.accounts[1].recent_relationship_in_past_days.state, "needs_gmail_metadata_check");
  assert.equal(result.accounts[1].source_states.gmail_metadata, "required_before_negative_claim");
  assert.equal(JSON.stringify(result.accounts).includes("001000000000000AAA"), false);
});

test("the managed relationship read separates connection progress and source execution without raw diagnostics", async () => {
  const progress = [], calls = [];
  let closed = 0;
  const session = { query: async (sql, options) => {
    calls.push(sql);
    assert.equal(options.timeoutMs, 60_000);
    options.onStarted({ queue_wait_ms: 4000, connection_name: "do not expose" });
    options.onDiagnostics({ statement_started: true, statement_execution_ms: 31_000, fetch_results_ms: 5,
      query_text: "do not expose", account_id: "do not expose" });
    return [{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }];
  }, close() { closed++; } };
  const result = await readPortfolioRelationships({ session, onProgress: event => progress.push(event) });
  assert.equal(PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS, 60_000);
  assert.equal(closed, 0, "A supplied session remains caller-owned");
  assert.equal(calls.length, 1);
  assert.deepEqual(progress.map(event => event.stage), ["connection_start", "recent_salesforce_activity"]);
  assert.deepEqual(progress.map(event => event.stage_deadline_seconds), [25, 60]);
  assert.equal(result.source_read_diagnostics.connection_start_ms, 4000);
  assert.equal(result.source_read_diagnostics.statement_execution_ms, 31_000);
  assert.equal(result.read_deadline_seconds, 60);
  assert.doesNotMatch(JSON.stringify(result), /do not expose|runtimeSelectionByWorkItem/);
});

test("a Salesforce timeout tells the host to use Gmail instead of retrying", async () => {
  let attempts = 0;
  await assert.rejects(readPortfolioRelationships({ session: { query: async () => {
    attempts++;
    throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Private failure", { statement_started: true, failure_stage: "statement_execution",
      statement_execution_ms: 60_000, query_text: "do not expose", account_id: "do not expose" });
  } } }), (error) => (
    error.code === "PORTFOLIO_RELATIONSHIP_READ_TIMEOUT"
    && error.message.includes("Do not retry")
    && error.message.includes("Gmail metadata")
    && error.details.failed_stage === "recent_salesforce_activity"
    && Number.isInteger(error.details.elapsed_ms)
    && error.details.statement_started === true
    && error.details.failure_stage === "statement_execution"
    && !JSON.stringify(error).includes("do not expose")
  ));
  assert.equal(attempts, 1);
});

test("connection failure is distinct from a slow relationship statement and cannot become no-contact evidence", async () => {
  await assert.rejects(readPortfolioRelationships({ session: { query: async () => {
    throw new BetaError("SNOWFLAKE_SESSION_START_TIMEOUT", "Private error", { statement_started: false, failure_stage: "connection_start" });
  } } }), error => error.code === "PORTFOLIO_RELATIONSHIP_CONNECTION_UNAVAILABLE"
    && error.details.statement_started === false && /not start/.test(error.message));
});

test("relationship progress is temporary, owner-and-case bound, reusable without rereads, and cleared on restart", async () => {
  let clock = 0, update, finish, attempts = 0;
  const jobs = new PortfolioRelationshipReadJobs({ now: () => clock });
  const started = jobs.start({ ownerRef: "invented-owner", caseId: "invented-case", read: progress => {
    attempts++; update = progress; return new Promise(resolve => { finish = resolve; });
  } });
  await Promise.resolve();
  update({ stage: "recent_salesforce_activity", stage_deadline_seconds: 60 });
  clock = 35_000;
  const pending = jobs.poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "invented-case" });
  assert.equal(pending.status, "in_progress");
  assert.equal(pending.stage_elapsed_seconds, 35);
  assert.equal(pending.stage_deadline_seconds, 60);
  assert.equal(pending.next_check_after_seconds, 20);
  const expiry = pending.expires_at;
  assert.throws(() => jobs.poll({ ref: started.relationship_read_ref, ownerRef: "other", caseId: "invented-case" }), { code: "PORTFOLIO_RELATIONSHIP_RUN_UNAVAILABLE" });
  assert.throws(() => jobs.poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "other" }), { code: "PORTFOLIO_RELATIONSHIP_RUN_UNAVAILABLE" });
  assert.throws(() => jobs.start({ ownerRef: "invented-owner", caseId: "invented-case", read: async () => ({}) }), { code: "PORTFOLIO_RELATIONSHIP_IN_PROGRESS" });
  const result = presentPortfolioRelationships([{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }]);
  Object.defineProperty(result, "runtimeSelectionByWorkItem", { enumerable: false, value: result.runtimeSelectionByWorkItem });
  finish(result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "invented-case" }).status, "ready");
  assert.equal(jobs.poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "invented-case" }).expires_at, expiry);
  assert.equal(jobs.poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "invented-case" }).runtimeSelectionByWorkItem.size, 0);
  assert.equal(attempts, 1);
  assert.throws(() => new PortfolioRelationshipReadJobs().poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "invented-case" }), { code: "PORTFOLIO_RELATIONSHIP_RUN_UNAVAILABLE" });
  clock = 901_000;
  assert.throws(() => jobs.poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "invented-case" }), { code: "PORTFOLIO_RELATIONSHIP_RUN_UNAVAILABLE" });
});

test("a timed-out relationship job stays failed; polling cannot trigger another source read", async () => {
  let attempts = 0;
  const jobs = new PortfolioRelationshipReadJobs();
  const started = jobs.start({ ownerRef: "invented-owner", caseId: "invented-case", read: async () => {
    attempts++; throw new BetaError("PORTFOLIO_RELATIONSHIP_READ_TIMEOUT", "Do not retry; use Gmail metadata.", { failed_stage: "recent_salesforce_activity" });
  } });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 3; i++) {
    const result = jobs.poll({ ref: started.relationship_read_ref, ownerRef: "invented-owner", caseId: "invented-case" });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PORTFOLIO_RELATIONSHIP_READ_TIMEOUT");
    assert.match(result.message, /Do not retry/);
  }
  assert.equal(attempts, 1);
});

test("an invalid relationship count is a source-response failure, not a verified zero", () => {
  for (const value of [null, "", false, -1, "not a count", Infinity]) assert.throws(() => presentPortfolioRelationships([
    { ROW_TYPE: "scope", SCOPE_COUNT: 1 }, { ROW_TYPE: "account", CTA_ID: "invented-cta", ACCOUNT_ID: "invented-account", SALESFORCE_ACTIVITY_COUNT: value },
  ]), { code: "PORTFOLIO_RELATIONSHIP_RESPONSE_INVALID" });
});

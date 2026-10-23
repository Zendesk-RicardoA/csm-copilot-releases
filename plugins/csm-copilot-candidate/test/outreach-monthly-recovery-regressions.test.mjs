import assert from "node:assert/strict";
import test from "node:test";
import { BetaError } from "../mcp/core.mjs";
import { readAccountEvidencePlan } from "../mcp/account-evidence-read-plan.mjs";
import { presentCoreContactEvidence, readFastJourneyAContactEvidenceWithSession,
  readSlowJourneyAContactEvidenceWithSession } from "../mcp/journey-a-contact-evidence.mjs";

const ACCOUNT = "001000000000000AAA";
const NOW = new Date("2026-10-13T12:00:00Z");
const RBA = [{ RBA_METRICS_MONTH: 202609, CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 240,
  SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 230, FIRST_REPLY_VALUE_COUNT: 1,
  MEDIAN_FIRST_REPLY_HOURS: 2, RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 20,
  ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 14, ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 22 }];
const GUIDE = [{ GUIDE_KNOWLEDGE_VIEWS_MONTH: 202609, GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 125 }];
const CONTEXT = [{ ACCOUNT_ID: ACCOUNT, ACCOUNT_NAME: "Invented Orchard", CSM_NAME: "Invented CSM", NET_ARR_USD: 12000 }];
const sourceFor = sql => sql.includes("FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW") ? "rba_monthly_metrics"
  : sql.includes("FACT_GUIDE_ARTICLE_VIEWS") ? "guide_knowledge_views"
  : sql.includes("account_brief") ? "account_context"
  : sql.includes("SALESFORCE_TASK_FORMULA_BCV") ? "salesforce_activity" : "gong_metadata";
const timeout = () => new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented timeout.");

async function run({ failures = {}, retryFailures = {}, slowContext = false } = {}) {
  const core = presentCoreContactEvidence([{ ACCOUNT_ID: ACCOUNT, ACCOUNT_NAME: "Invented Orchard", CONTACT_ID: "invented-contact", CONTACT_NAME: "Invented Person",
    CONTACT_EMAIL: "person@example.invalid", CONTACT_TITLE: "Support Lead", LATEST_SALES_TOUCH_AT: "2026-10-12T12:00:00Z" }], { now: NOW });
  const calls = [], progress = []; let clock = 0;
  const session = { async query(sql, options) {
    assert.ok(sql.includes(ACCOUNT));
    const source = sourceFor(sql); const attempt = calls.filter(c => c.source === source).length + 1;
    calls.push({ source, attempt, sql, ...options });
    const failure = attempt === 1 ? failures[source] : retryFailures[source];
    if (failure) { clock += options.timeoutMs; throw failure(); }
    clock += slowContext && source === "account_context" ? 95000 : 1000;
    return source === "rba_monthly_metrics" ? RBA : source === "guide_knowledge_views" ? GUIDE
      : source === "account_context" ? CONTEXT : [];
  } };
  const fast = await readFastJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: core, session, now: NOW });
  const result = await readSlowJourneyAContactEvidenceWithSession({ accountId: ACCOUNT, coreEvidence: core,
    fastEvidence: fast, session, now: NOW, nowMs: () => clock, onProgress: p => progress.push(p) });
  return { core, fast, result, calls, progress, clock };
}

test("native slow path recovers the identical fast RBA timeout once, after independent first reads", async () => {
  const { fast, result, calls, progress } = await run({ failures: { rba_monthly_metrics: timeout } });
  assert.equal(fast.source_states.rba_monthly_metrics, "timed_out");
  assert.deepEqual(calls.map(c => c.source), ["rba_monthly_metrics", "guide_knowledge_views", "account_context",
    "salesforce_activity", "gong_metadata", "rba_monthly_metrics"]);
  const attempts = calls.filter(c => c.source === "rba_monthly_metrics");
  assert.equal(attempts[0].sql, attempts[1].sql);
  assert.deepEqual(attempts.map(c => c.timeoutMs), [25000, 120000]);
  assert.equal(progress.at(-1).stage, "account_evidence_recovery");
  assert.equal(progress.at(-1).attempt, 2);
  assert.equal(progress.at(-1).stage_deadline_seconds, 300);
  assert.equal(result.source_states.rba_monthly_metrics, "checked");
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, 240);
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Knowledge views").value, 125);
  assert.deepEqual(result.source_gap_codes, []);
  assert.equal(calls.filter(c => c.source === "guide_knowledge_views").length, 1);
  assert.equal(result.contacts[0].contact_ref, fast.contacts[0].contact_ref);
});

test("Guide timeout also gets one exact governed recovery without rereading successful RBA", async () => {
  const { result, calls } = await run({ failures: { guide_knowledge_views: timeout } });
  assert.deepEqual(calls.filter(c => c.source === "guide_knowledge_views").map(c => c.timeoutMs), [25000, 120000]);
  assert.equal(calls.filter(c => c.source === "rba_monthly_metrics").length, 1);
  assert.equal(result.source_states.guide_knowledge_views, "checked");
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Knowledge views").value, 125);
  assert.deepEqual(result.source_gap_codes, []);
});

test("two fast metric timeouts recover serially with at most two source attempts", async () => {
  const { result, calls, clock } = await run({ failures: { rba_monthly_metrics: timeout, guide_knowledge_views: timeout }, slowContext: true });
  assert.deepEqual(calls.map(c => c.source), ["rba_monthly_metrics", "guide_knowledge_views", "account_context",
    "salesforce_activity", "gong_metadata", "rba_monthly_metrics", "guide_knowledge_views"]);
  assert.equal(result.brief.source_states.product_performance_metrics, "checked");
  assert.ok(clock <= 650000, "The fast attempts and two bounded windows are not an unbounded retry loop.");
  assert.deepEqual(result.source_gap_codes, []);
});

test("failed metric recovery stays a visible timeout, preserves contacts and Guide, and never makes a third attempt", async () => {
  const { result, calls } = await run({ failures: { rba_monthly_metrics: timeout }, retryFailures: { rba_monthly_metrics: timeout } });
  assert.equal(calls.filter(c => c.source === "rba_monthly_metrics").length, 2);
  assert.equal(result.source_states.rba_monthly_metrics, "timed_out");
  assert.ok(result.source_gap_codes.includes("RBA_MONTHLY_METRICS_TIMEOUT"));
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, null);
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Knowledge views").value, 125);
  assert.equal(result.contacts[0].display_name, "Invented Person");
});

test("a bounded recovery-window timeout remains a timeout rather than an empty or permission result", async () => {
  const { result, calls } = await run({ failures: { rba_monthly_metrics: timeout },
    retryFailures: { rba_monthly_metrics: () => new BetaError("SNOWFLAKE_SESSION_WINDOW_TIMEOUT", "Invented window exhaustion.") } });
  assert.equal(calls.filter(c => c.source === "rba_monthly_metrics").length, 2);
  assert.equal(result.source_states.rba_monthly_metrics, "timed_out");
  assert.deepEqual(result.source_gap_codes, ["RBA_MONTHLY_METRICS_TIMEOUT"]);
});

test("query and permission failures are not expanded into metric retries", async () => {
  for (const code of ["SNOWFLAKE_SESSION_QUERY_FAILED", "SOURCE_PERMISSION_DENIED"]) {
    const { result, calls } = await run({ failures: { rba_monthly_metrics: () => new BetaError(code, "Invented source rejection.") } });
    assert.equal(calls.filter(c => c.source === "rba_monthly_metrics").length, 1);
    assert.equal(result.source_states.rba_monthly_metrics, "unavailable");
    assert.ok(result.source_gap_codes.includes("RBA_MONTHLY_METRICS_UNAVAILABLE"));
  }
});

test("successful fast metric reads are not repeated while account context recovers", async () => {
  const { result, calls } = await run({ failures: { account_context: timeout } });
  assert.equal(calls.filter(c => c.source === "rba_monthly_metrics").length, 1);
  assert.equal(calls.filter(c => c.source === "guide_knowledge_views").length, 1);
  assert.equal(result.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, 240);
  assert.equal(result.source_states.account_context, "checked");
});

test("shared evidence scheduling counts a seeded fast timeout as attempt one, not a new retry budget", async () => {
  let clock = 0; const calls = [], progress = [];
  const result = await readAccountEvidencePlan({ sources: [{ source: "context" }, { source: "metric" }],
    initialResults: { metric: { state: "timed_out", rows: [] } }, nowMs: () => clock,
    onProgress: p => progress.push(p), read: async ({ source }, options) => {
      calls.push([source, options.attempt]); clock += options.timeoutMs;
      return { state: "timed_out", rows: [] };
    } });
  assert.deepEqual(calls, [["context", 1], ["context", 2], ["metric", 2]]);
  assert.equal(result.metric.state, "timed_out");
  assert.equal(progress.find(p => p.source === "metric").stage, "account_evidence_recovery");
  assert.ok(clock <= 600000);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_EVIDENCE_FIRST_PASS_MS, ACCOUNT_EVIDENCE_RECOVERY_MS, ACCOUNT_EVIDENCE_STATEMENT_MS, readAccountEvidencePlan } from "../mcp/account-evidence-read-plan.mjs";
import { CTA_QUEUE_READ_TIMEOUT_MS } from "../mcp/journey-a-cta-queue.mjs";
import { BOOK_OF_BUSINESS_READ_TIMEOUT_MS, BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS } from "../mcp/book-of-business-read-session.mjs";
import { MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS, MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS } from "../mcp/meeting-prep-call-selection.mjs";
import { MEETING_PREP_ACCOUNT_SCOPE_TIMEOUT_MS } from "../mcp/meeting-prep-account-brief.mjs";

test("brief timeout expansion does not become an umbrella rule for CTA, portfolio or call search", () => {
  assert.equal(CTA_QUEUE_READ_TIMEOUT_MS, 25_000);
  assert.equal(BOOK_OF_BUSINESS_READ_TIMEOUT_MS, 120_000);
  assert.equal(BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS, 300_000);
  assert.equal(MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS, 90_000);
  assert.equal(MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS, 100_000);
  assert.equal(MEETING_PREP_ACCOUNT_SCOPE_TIMEOUT_MS, 120_000);
});

test("shared full briefs allow a slow first attempt without changing other capability deadlines", async () => {
  assert.equal(ACCOUNT_EVIDENCE_STATEMENT_MS, 120_000);
  assert.equal(ACCOUNT_EVIDENCE_FIRST_PASS_MS, 300_000);
  assert.equal(ACCOUNT_EVIDENCE_RECOVERY_MS, 300_000);
  let clock = 0;
  const calls = [], progress = [];
  const result = await readAccountEvidencePlan({ sources: [{ source: "profile" }, { source: "peers" }], nowMs: () => clock,
    onProgress: (value) => progress.push(value), read: async ({ source }, options) => {
      calls.push([source, options.attempt]);
      assert.equal(options.timeoutMs, 120_000);
      clock += source === "profile" ? 95_000 : 1_000;
      return { state: "checked", rows: [{ invented: true }] };
    } });
  assert.deepEqual(calls, [["profile", 1], ["peers", 1]]);
  assert.equal(result.profile.state, "checked");
  assert.ok(progress.every((value) => value.stage_deadline_seconds === 300));
});

test("a slow early source is retried only after independent sources received a first attempt", async () => {
  let clock = 0;
  const calls = [], progress = [];
  const sources = ["profile", "subscriptions", "knowledge", "peers", "metadata"].map((source) => ({ source }));
  const result = await readAccountEvidencePlan({ sources, nowMs: () => clock, onProgress: (value) => progress.push(value),
    read: async ({ source }, options) => {
      calls.push([source, options.attempt]);
      if (source === "profile" && options.attempt === 1) { clock += options.timeoutMs; return { state: "timed_out", rows: [] }; }
      clock += 1_000;
      return { state: "checked", rows: [{ invented: true }] };
    } });
  assert.deepEqual(calls, [["profile", 1], ["subscriptions", 1], ["knowledge", 1], ["peers", 1], ["metadata", 1], ["profile", 2]]);
  assert.equal(result.peers.state, "checked");
  assert.equal(result.profile.state, "checked");
  assert.equal(progress.at(-1).stage, "account_evidence_recovery");
  assert.equal(progress.at(-1).stage_deadline_seconds, 300);
});

test("even multiple timeouts reserve first-read opportunities and recovery is capped", async () => {
  let clock = 0;
  const calls = [], limits = [];
  const sources = Array.from({ length: 17 }, (_, index) => ({ source: `invented_${index}` }));
  const result = await readAccountEvidencePlan({ sources, nowMs: () => clock, read: async ({ source }, options) => {
    calls.push([source, options.attempt]); limits.push(options);
    clock = Math.min(clock + options.timeoutMs, options.deadlineAtMs);
    return { state: "timed_out", rows: [] };
  } });
  assert.deepEqual(calls.filter(([, attempt]) => attempt === 1).map(([source]) => source), sources.map(({ source }) => source));
  assert.ok(limits.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 120_000));
  assert.ok(clock <= 600_000);
  assert.ok(calls.every(([, attempt]) => attempt <= 2));
  assert.equal(result.invented_16.state, "timed_out", "A missed retry does not erase a real timeout");
});

test("a recovered metadata parent enables its dependent read without inventing a result", async () => {
  const calls = [];
  const result = await readAccountEvidencePlan({ sources: [{ source: "metadata" }, { source: "spotlight", dependsOn: "metadata" }],
    read: async ({ source }, { attempt }) => { calls.push([source, attempt]); return source === "metadata" && attempt === 1
      ? { state: "timed_out", rows: [] } : { state: "checked", rows: [{ invented: true }] }; } });
  assert.deepEqual(calls, [["metadata", 1], ["metadata", 2], ["spotlight", 1]]);
  assert.equal(result.spotlight.state, "checked");
});

test("query and authorization failures are not automatically retried", async () => {
  let count = 0;
  const result = await readAccountEvidencePlan({ sources: [{ source: "invented" }], read: async () => {
    count++; return { state: "query_failed", rows: [], failure_code: "SOURCE_QUERY_FAILED" };
  } });
  assert.equal(count, 1); assert.equal(result.invented.state, "query_failed");
});

test("an unstarted dependent read is not falsely reported as an empty source result", async () => {
  const calls = [];
  const result = await readAccountEvidencePlan({ sources: [{ source: "metadata" }, { source: "spotlight", dependsOn: "metadata" }],
    read: async ({ source }) => { calls.push(source); return { state: "no_data", rows: [] }; } });
  assert.deepEqual(calls, ["metadata"]);
  assert.equal(result.spotlight.state, "not_run");
  assert.equal(result.spotlight.failure_code, "DEPENDENCY_NOT_CHECKED");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildOwnedCtaQueueSql,
  buildOwnedCtaScopeSql,
  interpretRenewalCta,
  presentOwnedCtaQueue,
  readOwnedCtaQueue,
  readOwnedCtaQueueWithSession,
  renderOwnedCtaQueue,
} from "../mcp/journey-a-cta-queue.mjs";
import { getRenewalSequenceGuidance } from "../mcp/renewal-sequence-guidance.mjs";

const now = new Date("2026-09-12T12:00:00Z");

test("the queue keeps only owned in-book CTAs and puts P0 before P1", () => {
  const result = presentOwnedCtaQueue([
    { CTA_ID: "cta-p1", ACCOUNT_ID: "account-1", ACCOUNT_NAME: "Invented One", CTA_NAME: "P1: Non-Monthly Renewal", CTA_STATUS: "New", CTA_CREATED_AT: "2026-08-20T12:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
    { CTA_ID: "cta-p0", ACCOUNT_ID: "account-2", ACCOUNT_NAME: "Invented Two", CTA_NAME: "P0: Non-Monthly Renewal", CTA_STATUS: "In progress", CTA_CREATED_AT: "2026-09-08T12:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
    { CTA_ID: "cta-moved", ACCOUNT_ID: "account-3", ACCOUNT_NAME: "Invented Three", CTA_NAME: "P0: Non-Monthly Renewal", CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-01T12:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "ownership_alert" },
  ], now);
  assert.deepEqual(result.queue.map((item) => item.priority), ["P0", "P1"]);
  assert.equal(result.queue[0].action_deadline, "2026-09-15T12:00:00.000Z");
  assert.equal(result.queue[1].action_deadline, "2026-09-03T12:00:00.000Z");
  assert.equal(result.queue[0].cta_status, "In progress");
  assert.equal(result.ownership_alerts.length, 1);
  assert.equal(result.source_limit_reached, false);
  assert.match(result.ownership_alerts[0].warning, /no longer in your book/);
  assert.equal(JSON.stringify(result).includes("cta-p0"), false);
  assert.equal(JSON.stringify(result).includes("account-2"), false);
});

test("P0 and P1 deadlines use CTA creation time and stop when it is missing", () => {
  assert.equal(interpretRenewalCta("P0: Non-Monthly Renewal", "2026-09-01T09:00:00Z", now).actionDeadline, "2026-09-08T09:00:00.000Z");
  const missing = interpretRenewalCta("P1: Non-Monthly Renewal", null, now);
  assert.equal(missing.actionState, "missing_created_at");
  assert.deepEqual(missing.warnings, ["RENEWAL_PRIORITY_CREATED_AT_MISSING"]);
});

test("non-renewal P0 and P1 CTAs keep their priority and action deadlines without renewal sequences", () => {
  const result = presentOwnedCtaQueue([
    { CTA_ID: "ordinary-p1", ACCOUNT_ID: "account-p1", ACCOUNT_NAME: "Invented One", CTA_NAME: "P1: Knowledge Health Assessment- Wave 2- CS", CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-01T00:00:00Z", CTA_DUE_AT: "2026-10-01T00:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
    { CTA_ID: "ordinary-p0", ACCOUNT_ID: "account-p0", ACCOUNT_NAME: "Invented Two", CTA_NAME: "P0: Copilot Adoption: Not Activated", CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-02T00:00:00Z", CTA_DUE_AT: "2026-10-02T00:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
  ], now);
  assert.deepEqual(result.queue.map((item) => item.priority), ["P0", "P1"]);
  assert.deepEqual(result.queue.map((item) => item.action_deadline), ["2026-09-09T00:00:00.000Z", "2026-09-15T00:00:00.000Z"]);
  assert.deepEqual(result.queue.map((item) => item.sequence_days), [[], []]);
  assert.deepEqual(result.queue.map((item) => item.renewal_motion), [null, null]);
  assert.equal(result.queue[0].cta_due_at, "2026-10-02T00:00:00.000Z");
  const table = renderOwnedCtaQueue(result.queue);
  assert.match(table, /### P0[\s\S]*Copilot Adoption/);
  assert.match(table, /### P1[\s\S]*Knowledge Health Assessment/);
});

test("the source query ranks any leading P0 or P1 before the row cap", () => {
  const query = buildOwnedCtaQueueSql();
  assert.ok(query.includes("REGEXP_LIKE(cta.NAME, '^[[:space:]]*P0[[:space:]]*:.*', 'i')"));
  assert.ok(query.includes("REGEXP_LIKE(cta.NAME, '^[[:space:]]*P1[[:space:]]*:.*', 'i')"));
  assert.equal(query.includes("LIKE 'P0: NON-MONTHLY RENEWAL%'"), false);
});

test("a source limit is visible rather than silently hiding a large queue", () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    CTA_ID: `cta-${index}`,
    ACCOUNT_ID: `account-${index}`,
    ACCOUNT_NAME: "Invented account",
    CTA_NAME: "P2: Non-Monthly Renewal",
    CTA_STATUS: "New",
    CTA_CREATED_AT: "2026-09-01T00:00:00Z",
    CTA_STATUS_IS_OPEN: true,
    CTA_DISPOSITION: "queue",
  }));
  const result = presentOwnedCtaQueue(rows, now);
  assert.equal(result.source_limit_reached, true);
  assert.match(result.source_limit_warning, /More than 100 open owned CTAs matched/);
});

test("the default CTA display is a complete grouped table, not a newest-item summary", () => {
  const queue = presentOwnedCtaQueue([
    { CTA_ID: "cta-p1", ACCOUNT_ID: "account-p1", ACCOUNT_NAME: "Invented P1", CTA_NAME: "P1: Non-Monthly Renewal", CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-02T00:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
    { CTA_ID: "cta-other", ACCOUNT_ID: "account-other", ACCOUNT_NAME: "Invented Other", CTA_NAME: "Guide Adoption", CTA_STATUS: "Working", CTA_CREATED_AT: "2026-09-03T00:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
    { CTA_ID: "cta-p0", ACCOUNT_ID: "account-p0", ACCOUNT_NAME: "Invented P0", CTA_NAME: "P0: Non-Monthly Renewal", CTA_STATUS: "In progress", CTA_CREATED_AT: "2026-09-08T00:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
  ], now);
  const table = renderOwnedCtaQueue(queue.queue);
  assert.match(table, /### P0/);
  assert.match(table, /### P1/);
  assert.match(table, /### Other open CTAs/);
  assert.match(table, /Invented P0/);
  assert.match(table, /Invented P1/);
  assert.match(table, /Invented Other/);
  assert.equal(table.includes("and others"), false);
  assert.ok(table.indexOf("### P0") < table.indexOf("### P1"));
  assert.ok(table.indexOf("### P1") < table.indexOf("### Other open CTAs"));
  assert.match(table, /\| P0 \| Invented P0 \| P0: Non-Monthly Renewal \| In progress \| 2026-09-08 \| 2026-09-15 \| Due soon \|/);
  assert.equal(table.includes("| P0 | Invented P0 | P0: Non-Monthly Renewal | In progress | 2026-09-08 | 2026-09-15 | No action deadline |"), false);
});

test("the Snowflake query derives the signed-in CSM and applies one CTA-owner filter", () => {
  const scopeQuery = buildOwnedCtaScopeSql();
  const query = buildOwnedCtaQueueSql();
  assert.match(scopeQuery, /COUNT\(\*\) AS scope_count/);
  assert.match(scopeQuery, /LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)/);
  assert.match(query, /LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)/);
  assert.match(query, /cta\.OWNER_ID = authenticated_csm\.GSID/);
  assert.match(query, /company\.SUCCESS_OWNER_C_GC = authenticated_csm\.GSID/);
  assert.match(query, /cta\.COMPANY_ID = company\.GSID/);
  assert.match(query, /cta\.CREATED_DATE AS cta_created_at/);
  assert.match(query, /cta\.MONITOR_LINK_GC AS cta_monitor_link/);
  assert.match(query, /cta\.cta_monitor_link/);
  assert.match(query, /cta\.STATUS_ID = status_pl\.GSID/);
  assert.match(query, /status_pl\.IS_OPEN_STATUS = TRUE/);
  assert.match(query, /company\.NAME AS account_name/);
  assert.equal(query.includes("SALESFORCE_ACCOUNT_BCV"), false);
  assert.equal(query.includes("{{CSM_GSID}}"), false);
});

test("the managed queue validates CSM scope and CTAs in one 25-second statement", async () => {
  const calls = [];
  const session = {
    async query(sql, { timeoutMs }) {
      calls.push({ sql, timeoutMs });
      return [{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }, {
        ROW_TYPE: "cta",
        CTA_ID: "cta-1",
        ACCOUNT_ID: "account-1",
        ACCOUNT_NAME: "Invented One",
        CTA_NAME: "P0: Non-Monthly Renewal",
        CTA_STATUS: "New",
        CTA_CREATED_AT: "2026-09-08T00:00:00Z",
        CTA_MONITOR_LINK: "https://monitor.example.invalid/cta",
        CTA_STATUS_IS_OPEN: true,
        CTA_DISPOSITION: "queue",
      }];
    },
  };
  const result = await readOwnedCtaQueueWithSession({ session, now });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /COUNT\(\*\) AS scope_count/);
  assert.match(calls[0].sql, /FROM CLEANSED\.GAINSIGHT\.GAINSIGHT_CALL_TO_ACTION_BCV/);
  assert.ok(calls[0].timeoutMs <= 25_000);
  assert.equal(result.queue.length, 1);
  assert.match(result.display_table, /Invented One/);
  assert.equal([...result.runtimeSelectionByWorkItem.values()][0].monitorLink, "https://monitor.example.invalid/cta");
});

test("queue failures expose only safe stage and timing diagnostics", async () => {
  const session = { query: async () => { throw new Error("invented sensitive SQL text"); } };
  await assert.rejects(readOwnedCtaQueueWithSession({ session }), (error) => (
    error.code === "CTA_QUEUE_READ_FAILED"
    && error.details.failed_stage === "owned_cta_scope_and_rows"
    && Number.isInteger(error.details.elapsed_ms)
    && !JSON.stringify(error.details).includes("invented sensitive")
  ));
});

test("the reader preserves the existing Snowflake configuration and disables file logs", () => {
  let receivedEnvironment;
  let receivedArgs;
  assert.throws(() => readOwnedCtaQueue({ runner: (_command, args, options) => {
    receivedEnvironment = options.env;
    receivedArgs = args;
    return { status: 1, stdout: "" };
  }, now }), { code: "CTA_QUEUE_READ_FAILED" });
  assert.equal(receivedArgs[0], "--config-file");
  assert.match(receivedArgs[1], /\.snowflake\/config\.toml$/);
  assert.equal(receivedEnvironment.NO_COLOR, undefined);
  assert.equal(receivedEnvironment.SNOWFLAKE_CLI_LOGS_SAVE_LOGS, "");
});

test("sequence guidance reminds the CSM about AE alignment without blocking the work", () => {
  const guidance = getRenewalSequenceGuidance("P1");
  assert.equal(guidance.action_window_days, 14);
  assert.equal(guidance.ae_alignment_reminder, true);
  assert.equal(guidance.progress_blocked_by_ae_alignment, false);
  assert.match(guidance.csm_reminders[0], /does not block/i);
  assert.equal(guidance.send_state, "not_sent");
  assert.equal(guidance.review_required, true);
  assert.match(guidance.source_use, /current source at draft time/);
});

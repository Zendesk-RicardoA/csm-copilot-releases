import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { BetaError } from "./core.mjs";
import { safeSnowflakeReadDiagnostics } from "./source-read-diagnostics.mjs";
import { createTemporarySnowflakeConfig } from "./credential-bridges.mjs";

const MAX_ROWS = 100;
const READ_TIMEOUT_MS = 25_000;

const POLICIES = {
  P0: { motion: "renewal_readiness", actionWindowDays: 7, sequenceDays: [1, 3, 6, 8] },
  P1: { motion: "renewal_recovery", actionWindowDays: 14, sequenceDays: [1, 3, 6, 10] },
  P2: { motion: "adoption_focused", actionWindowDays: null, sequenceDays: [1, 3, 6, 10, 12] },
  P3: { motion: "expansion_focused", actionWindowDays: null, sequenceDays: [1, 4, 8, 12] },
};

function isOpenCta(row) {
  return field(row, "CTA_STATUS_IS_OPEN") === true;
}

function field(row, name) {
  return row[name] ?? row[name.toLowerCase()] ?? null;
}

function opaqueRef(prefix, value) {
  return crypto.createHash("sha256").update(`${prefix}:${value}`).digest("hex");
}

function asDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function iso(value) {
  const parsed = asDate(value);
  return parsed ? parsed.toISOString() : null;
}

function renewalPriorityFrom(title) {
  const matched = typeof title === "string" ? /^\s*(P[0-4])\s*:\s*Non-Monthly Renewal\b(.*)$/i.exec(title) : null;
  if (!matched) return { priority: null, partner: false };
  return { priority: matched[1].toUpperCase(), partner: /\(\s*Partner\s*\)\s*$/i.test(matched[2]) };
}

function titlePriority(title) {
  return typeof title === "string" ? /^\s*(P[0-4])\s*:/.exec(title.toUpperCase())?.[1] ?? null : null;
}

function interpretPriorityCta(title, createdAt, now) {
  const renewal = interpretRenewalCta(title, createdAt, now);
  if (renewal.priority) return renewal;
  const priority = titlePriority(title);
  if (!priority) return renewal;
  const windowDays = priority === "P0" ? 7 : priority === "P1" ? 14 : null;
  if (windowDays === null) return {
    priority, partner: false, motion: null, actionDeadline: null,
    actionState: "no_action_window", sequenceDays: [], warnings: [],
  };
  const created = asDate(createdAt);
  if (!created) return {
    priority, partner: false, motion: null, actionDeadline: null,
    actionState: "missing_created_at", sequenceDays: [], warnings: ["PRIORITY_CTA_CREATED_AT_MISSING"],
  };
  const deadline = new Date(created.getTime() + windowDays * 24 * 60 * 60 * 1000);
  return {
    priority, partner: false, motion: null, actionDeadline: deadline.toISOString(),
    actionState: deadline.getTime() <= now.getTime() ? "overdue" : "upcoming",
    sequenceDays: [], warnings: [],
  };
}

export function interpretRenewalCta(title, createdAt, now = new Date()) {
  const { priority, partner } = renewalPriorityFrom(title);
  if (!priority) return {
    priority: null, partner: false, motion: null, actionDeadline: null,
    actionState: "not_priority_cta", sequenceDays: [], warnings: [],
  };
  const policy = POLICIES[priority];
  if (!policy) return {
    priority, partner, motion: null, actionDeadline: null, actionState: "policy_not_defined",
    sequenceDays: [], warnings: ["RENEWAL_PRIORITY_POLICY_NOT_DEFINED"],
  };
  const created = asDate(createdAt);
  if (policy.actionWindowDays === null) return {
    priority, partner, motion: policy.motion, actionDeadline: null, actionState: "no_action_window",
    sequenceDays: policy.sequenceDays, warnings: [],
  };
  if (!created) return {
    priority, partner, motion: policy.motion, actionDeadline: null, actionState: "missing_created_at",
    sequenceDays: policy.sequenceDays, warnings: ["RENEWAL_PRIORITY_CREATED_AT_MISSING"],
  };
  const actionDeadline = new Date(created.getTime() + policy.actionWindowDays * 24 * 60 * 60 * 1000);
  return {
    priority, partner, motion: policy.motion, actionDeadline: actionDeadline.toISOString(),
    actionState: actionDeadline.getTime() <= now.getTime() ? "overdue" : "upcoming",
    sequenceDays: policy.sequenceDays, warnings: [],
  };
}

function priorityRank(priority) {
  return priority ? Number(priority.slice(1)) : 5;
}

function actionRank(item) {
  return item.action_state === "overdue" ? 0 : item.action_state === "upcoming" ? 1 : 2;
}

function displayDate(value) {
  const parsed = asDate(value);
  return parsed ? parsed.toISOString().slice(0, 10) : "—";
}

function displayUrgency(item) {
  if (item.action_state === "overdue") return "Overdue";
  if (item.action_state === "upcoming") return "Due soon";
  if (item.action_state === "missing_created_at") return "Creation date missing";
  if (item.action_state === "policy_not_defined") return "No action rule";
  return "No action deadline";
}

function markdownCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

/**
 * Produces the exact complete, bounded queue display for a general CTA request.
 * Keeping this presentation in the source layer prevents a caller from replacing
 * later priority groups with a prose summary or a newest-items preview.
 */
export function renderOwnedCtaQueue(items) {
  const groups = [
    ["P0", "P0"],
    ["P1", "P1"],
    ["P2", "P2"],
    ["P3", "P3"],
    ["P4", "P4"],
    ["Other open CTAs", null],
  ];
  const lines = [];
  for (const [heading, priority] of groups) {
    const rows = items.filter((item) => item.priority === priority);
    if (rows.length === 0) continue;
    lines.push(`### ${heading}`);
    lines.push("| Priority | Account | CTA | Status | Created | Action deadline | Urgency |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const item of rows) {
      lines.push(`| ${markdownCell(item.priority || "Other")} | ${markdownCell(item.account_display_name)} | ${markdownCell(item.cta_title)} | ${markdownCell(item.cta_status)} | ${displayDate(item.created_at)} | ${displayDate(item.action_deadline)} | ${displayUrgency(item)} |`);
    }
  }
  return lines.join("\n").trim();
}

export function presentOwnedCtaQueue(rows, now = new Date()) {
  const queue = [];
  const ownershipAlerts = [];
  for (const row of rows) {
    if (!isOpenCta(row)) continue;
    const ctaId = field(row, "CTA_ID");
    const accountId = field(row, "ACCOUNT_ID");
    const title = field(row, "CTA_NAME");
    const status = field(row, "CTA_STATUS");
    if (typeof ctaId !== "string" || typeof accountId !== "string" || typeof title !== "string" || typeof status !== "string") {
      throw new BetaError("CTA_QUEUE_RESPONSE_INVALID", "The CTA queue response was missing a required field.");
    }
    const policy = interpretPriorityCta(title, field(row, "CTA_CREATED_AT"), now);
    const item = {
      work_item_ref: opaqueRef("cta", ctaId),
      account_ref: opaqueRef("account", accountId),
      account_display_name: field(row, "ACCOUNT_NAME") || "Unnamed account",
      cta_title: title,
      cta_status: status,
      created_at: iso(field(row, "CTA_CREATED_AT")),
      cta_due_at: iso(field(row, "CTA_DUE_AT")),
      priority: policy.priority,
      renewal_motion: policy.motion,
      partner_renewal: policy.partner,
      action_deadline: policy.actionDeadline,
      action_state: policy.actionState,
      sequence_days: policy.sequenceDays,
      warnings: policy.warnings,
    };
    if (field(row, "CTA_DISPOSITION") === "queue") {
      item.why_this_is_here = "You own this open CTA and the account is in your current book.";
      queue.push(item);
    } else if (field(row, "CTA_DISPOSITION") === "ownership_alert") {
      ownershipAlerts.push({
        ...item,
        warning: "You still own this open CTA, but the account is no longer in your book.",
      });
    } else {
      throw new BetaError("CTA_QUEUE_RESPONSE_INVALID", "The CTA queue response had an unknown ownership state.");
    }
  }
  queue.sort((left, right) => (
    priorityRank(left.priority) - priorityRank(right.priority)
    || actionRank(left) - actionRank(right)
    || (left.action_deadline || "9999-12-31T23:59:59.999Z").localeCompare(right.action_deadline || "9999-12-31T23:59:59.999Z")
    || (left.cta_due_at || "9999-12-31T23:59:59.999Z").localeCompare(right.cta_due_at || "9999-12-31T23:59:59.999Z")
    || left.work_item_ref.localeCompare(right.work_item_ref)
  ));
  return {
    queue: queue.map((item, index) => ({ ...item, priority_rank: index + 1 })),
    ownership_alerts: ownershipAlerts,
    source_limit_reached: rows.filter((row) => field(row, "ROW_TYPE") !== "scope").length > MAX_ROWS,
    source_limit_warning: rows.filter((row) => field(row, "ROW_TYPE") !== "scope").length > MAX_ROWS
      ? "More than 100 open owned CTAs matched. The queue is limited to the highest-priority 101 items; narrow the request before making a decision beyond those items."
      : null,
  };
}

export function buildOwnedCtaScopeSql() {
  return `
SELECT COUNT(*) AS scope_count
FROM CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV
WHERE LOWER(EMAIL) = LOWER(CURRENT_USER())
`.trim();
}

export function buildOwnedCtaQueueSql() {
  return `
WITH authenticated_csm AS (
  SELECT GSID
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV
  WHERE LOWER(EMAIL) = LOWER(CURRENT_USER())
), scope AS (
  SELECT COUNT(*) AS scope_count FROM authenticated_csm
), owned_open_ctas AS (
  SELECT
    cta.GSID AS cta_id,
    company.SFDC_ACCOUNT_ID AS account_id,
    company.NAME AS account_name,
    cta.NAME AS cta_name,
    cta.CREATED_DATE AS cta_created_at,
    cta.DUE_DATE AS cta_due_at,
    cta.MONITOR_LINK_GC AS cta_monitor_link,
    status_pl.NAME AS cta_status,
    status_pl.IS_OPEN_STATUS AS cta_status_is_open,
    CASE WHEN company.SUCCESS_OWNER_C_GC = authenticated_csm.GSID THEN 'queue' ELSE 'ownership_alert' END AS cta_disposition
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_CALL_TO_ACTION_BCV AS cta
  JOIN authenticated_csm ON cta.OWNER_ID = authenticated_csm.GSID
  CROSS JOIN scope
  JOIN CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company ON cta.COMPANY_ID = company.GSID
  JOIN CLEANSED.GAINSIGHT.GAINSIGHT_DA_PICKLIST_BCV AS status_pl
    ON cta.STATUS_ID = status_pl.GSID
    AND status_pl.CATEGORY = 'CTA_STATUS'
    AND status_pl.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
  WHERE cta.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
    AND scope.scope_count = 1
    AND status_pl.IS_OPEN_STATUS = TRUE
  ORDER BY
    CASE
      WHEN REGEXP_LIKE(cta.NAME, '^[[:space:]]*P0[[:space:]]*:.*', 'i') THEN 0
      WHEN REGEXP_LIKE(cta.NAME, '^[[:space:]]*P1[[:space:]]*:.*', 'i') THEN 1
      WHEN REGEXP_LIKE(cta.NAME, '^[[:space:]]*P2[[:space:]]*:.*', 'i') THEN 2
      WHEN REGEXP_LIKE(cta.NAME, '^[[:space:]]*P3[[:space:]]*:.*', 'i') THEN 3
      WHEN REGEXP_LIKE(cta.NAME, '^[[:space:]]*P4[[:space:]]*:.*', 'i') THEN 4
      ELSE 5
    END,
    cta.CREATED_DATE ASC NULLS LAST,
    cta.GSID
  LIMIT ${MAX_ROWS + 1}
)
SELECT 'scope' AS row_type, scope.scope_count,
  NULL::STRING AS cta_id, NULL::STRING AS account_id, NULL::STRING AS account_name,
  NULL::STRING AS cta_name, NULL::TIMESTAMP_NTZ AS cta_created_at,
  NULL::TIMESTAMP_NTZ AS cta_due_at, NULL::STRING AS cta_monitor_link,
  NULL::STRING AS cta_status, NULL::BOOLEAN AS cta_status_is_open,
  NULL::STRING AS cta_disposition
FROM scope
UNION ALL
SELECT 'cta' AS row_type, 1 AS scope_count,
  cta.cta_id, cta.account_id, cta.account_name, cta.cta_name, cta.cta_created_at, cta.cta_due_at,
  cta.cta_monitor_link, cta.cta_status, cta.cta_status_is_open, cta.cta_disposition
FROM owned_open_ctas AS cta
`.trim();
}

function parseRows(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.data)) return parsed.data;
    if (Array.isArray(parsed?.rows)) return parsed.rows;
  } catch (_error) {
    // The public error below deliberately does not echo a source response.
  }
  throw new BetaError("CTA_QUEUE_RESPONSE_INVALID", "The CTA queue response could not be read safely.");
}

export function readOwnedCtaQueue({ connectionName = "zdp-global", runner = spawnSync, now = new Date() } = {}) {
  // The Snowflake CLI receives a temporary copy of the user's connection
  // settings with file logs disabled. It is cleared after every read attempt.
  const temporary = createTemporarySnowflakeConfig();
  try {
    const result = runner(
      "snow",
      ["--config-file", temporary.configPath, "sql", "-c", connectionName, "-q", buildOwnedCtaQueueSql(), "--format", "json"],
      { encoding: "utf8", timeout: READ_TIMEOUT_MS, env: temporary.env },
    );
    if (result.error?.code === "ETIMEDOUT") {
      throw new BetaError("CTA_QUEUE_READ_TIMEOUT", "The CTA queue did not return within 25 seconds. Nothing was saved. Try again.");
    }
    if (result.error || result.status !== 0) {
      throw new BetaError("CTA_QUEUE_READ_FAILED", "The CTA queue could not be read. Check the existing Snowflake connection and try again.");
    }
    const ctaRows = parseRows(result.stdout);
    const scope = ctaRows.find((row) => field(row, "ROW_TYPE") === "scope");
    if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
      throw new BetaError("CTA_QUEUE_SCOPE_UNAVAILABLE", "The signed-in Snowflake user does not map to one CSM profile, so no CTA queue was shown.");
    }
    const queue = presentOwnedCtaQueue(ctaRows, now);
    queue.display_table = renderOwnedCtaQueue(queue.queue);
    // The MCP returns only opaque work-item references. Keep the matching source account ID in
    // process memory so a later selected-account read can use the exact item without asking the
    // CSM to paste an account ID or persisting it in a case file.
    const runtimeSelectionByWorkItem = new Map();
    for (const row of ctaRows) {
      if (field(row, "CTA_DISPOSITION") !== "queue") continue;
      const ctaId = field(row, "CTA_ID");
      const accountId = field(row, "ACCOUNT_ID");
      if (typeof ctaId === "string" && typeof accountId === "string") {
        runtimeSelectionByWorkItem.set(opaqueRef("cta", ctaId), {
          accountId,
          ctaId,
          accountName: field(row, "ACCOUNT_NAME") || "Selected account",
          // This is a short-lived selection binding only. It is not returned
          // in the queue and is never written to a case file.
          monitorLink: field(row, "CTA_MONITOR_LINK"),
        });
      }
    }
    Object.defineProperty(queue, "runtimeSelectionByWorkItem", {
      value: runtimeSelectionByWorkItem,
      enumerable: false,
      writable: false,
    });
    queue.read_deadline_seconds = READ_TIMEOUT_MS / 1000;
    queue.source = "Gainsight CTA queue and current account ownership";
    queue.read_at = now.toISOString();
    return queue;
  } finally {
    temporary.cleanup();
  }
}

/** Uses the one temporary authenticated session created for the active case. */
export async function readOwnedCtaQueueWithSession({ session, now = new Date() } = {}) {
  const startedAt = Date.now();
  let workerStart = null;
  let ctaRows;
  try {
    ctaRows = await session.query(buildOwnedCtaQueueSql(), {
      timeoutMs: READ_TIMEOUT_MS,
      onStarted: (event) => { workerStart = event; },
    });
    const scope = ctaRows.find((row) => field(row, "ROW_TYPE") === "scope");
    if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
      throw new BetaError("CTA_QUEUE_SCOPE_UNAVAILABLE", "The signed-in Snowflake user does not map to one CSM profile, so no CTA queue was shown.");
    }
  } catch (error) {
    const diagnostic = {
      failed_stage: "owned_cta_scope_and_rows",
      elapsed_ms: Date.now() - startedAt,
      statement_started: workerStart != null || error?.details?.statement_started === true,
      worker_queue_wait_ms: workerStart?.queue_wait_ms ?? null,
      ...safeSnowflakeReadDiagnostics(error),
    };
    if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") {
      throw new BetaError("CTA_QUEUE_READ_TIMEOUT", "The CTA queue did not return within 25 seconds. Nothing was saved. Try again.", diagnostic);
    }
    if (error instanceof BetaError && ["SNOWFLAKE_SESSION_START_TIMEOUT", "SNOWFLAKE_SIGN_IN_REQUIRED"].includes(error.code)) {
      throw new BetaError("SNOWFLAKE_SIGN_IN_REQUIRED", "Snowflake/ZDP did not start this read. Complete browser sign-in, then try again.", diagnostic);
    }
    if (error instanceof BetaError && error.code === "CTA_QUEUE_SCOPE_UNAVAILABLE") throw error;
    throw new BetaError("CTA_QUEUE_READ_FAILED", "The CTA queue could not be read. Check the existing Snowflake connection and try again.", diagnostic);
  }
  const queue = presentOwnedCtaQueue(ctaRows, now);
  queue.display_table = renderOwnedCtaQueue(queue.queue);
  const runtimeSelectionByWorkItem = new Map();
  for (const row of ctaRows) {
    if (field(row, "CTA_DISPOSITION") !== "queue") continue;
    const ctaId = field(row, "CTA_ID");
    const accountId = field(row, "ACCOUNT_ID");
    if (typeof ctaId === "string" && typeof accountId === "string") {
      runtimeSelectionByWorkItem.set(opaqueRef("cta", ctaId), {
        accountId,
        ctaId,
        accountName: field(row, "ACCOUNT_NAME") || "Selected account",
        // This is a short-lived selection binding only. It is not returned
        // in the queue and is never written to a case file.
        monitorLink: field(row, "CTA_MONITOR_LINK"),
      });
    }
  }
  Object.defineProperty(queue, "runtimeSelectionByWorkItem", { value: runtimeSelectionByWorkItem, enumerable: false });
  queue.read_deadline_seconds = READ_TIMEOUT_MS / 1000;
  queue.source = "Gainsight CTA queue and current account ownership";
  queue.read_at = now.toISOString();
  queue.source_durations_ms = { gainsight_cta_queue: Date.now() - startedAt, worker_queue_wait_ms: workerStart?.queue_wait_ms ?? null };
  return queue;
}

export const CTA_QUEUE_READ_TIMEOUT_MS = READ_TIMEOUT_MS;

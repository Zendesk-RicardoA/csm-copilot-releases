import crypto from "node:crypto";
import { BetaError } from "./core.mjs";
import { PersistentSnowflakeSession } from "./persistent-snowflake-session.mjs";

const MAX_PORTFOLIO_ITEMS = 100;
// The governed 60-day statement measured 30.7s on 2026-10-08. Its 60s
// execution limit is separate from connection startup and the CTA queue's 25s.
export const PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS = 60_000;
const RELATIONSHIP_RUN_TTL_MS = 15 * 60_000;

function field(row, name) {
  return row[name] ?? row[name.toLowerCase()] ?? null;
}

function opaqueRef(prefix, value) {
  return crypto.createHash("sha256").update(`${prefix}:${value}`).digest("hex");
}

function validateLookbackDays(lookbackDays) {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 180) {
    throw new BetaError("INVALID_RELATIONSHIP_LOOKBACK", "The recent-relationship lookback must be from 1 to 180 days.");
  }
}

export function buildPortfolioRelationshipSql(lookbackDays = 60) {
  validateLookbackDays(lookbackDays);
  return `
WITH current_user_candidates AS (
  SELECT GSID
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV
  WHERE LOWER(EMAIL) = LOWER(CURRENT_USER())
), scope AS (
  SELECT COUNT(*) AS scope_count FROM current_user_candidates
), authenticated_csm AS (
  SELECT candidate.GSID
  FROM current_user_candidates AS candidate
  CROSS JOIN scope
  WHERE scope.scope_count = 1
), owned_open_ctas AS (
  SELECT
    cta.GSID AS cta_id,
    company.SFDC_ACCOUNT_ID AS account_id,
    company.NAME AS account_name,
    cta.NAME AS cta_name
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_CALL_TO_ACTION_BCV AS cta
  JOIN authenticated_csm ON cta.OWNER_ID = authenticated_csm.GSID
  JOIN CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company ON cta.COMPANY_ID = company.GSID
  JOIN CLEANSED.GAINSIGHT.GAINSIGHT_DA_PICKLIST_BCV AS status_pl
    ON cta.STATUS_ID = status_pl.GSID
    AND status_pl.CATEGORY = 'CTA_STATUS'
    AND status_pl.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
  WHERE cta.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
    AND status_pl.IS_OPEN_STATUS = TRUE
    AND company.SUCCESS_OWNER_C_GC = authenticated_csm.GSID
  ORDER BY
    CASE
      WHEN UPPER(cta.NAME) LIKE 'P0: NON-MONTHLY RENEWAL%' THEN 0
      WHEN UPPER(cta.NAME) LIKE 'P1: NON-MONTHLY RENEWAL%' THEN 1
      WHEN UPPER(cta.NAME) LIKE 'P2: NON-MONTHLY RENEWAL%' THEN 2
      WHEN UPPER(cta.NAME) LIKE 'P3: NON-MONTHLY RENEWAL%' THEN 3
      WHEN UPPER(cta.NAME) LIKE 'P4: NON-MONTHLY RENEWAL%' THEN 4
      ELSE 5
    END,
    cta.CREATED_DATE ASC NULLS LAST,
    cta.GSID
  LIMIT ${MAX_PORTFOLIO_ITEMS}
), owned_accounts AS (
  SELECT DISTINCT account_id FROM owned_open_ctas WHERE account_id IS NOT NULL
), salesforce_relationships AS (
  SELECT
    task.ACCOUNT_ID AS account_id,
    COUNT(task.ID) AS activity_count,
    MAX(task.ACTIVITY_DATE) AS latest_activity_at
  FROM CLEANSED.SALESFORCE.SALESFORCE_TASK_FORMULA_BCV AS task
  WHERE task.ACTIVITY_DATE >= DATEADD(day, -${lookbackDays}, CURRENT_DATE())
    AND task.ACCOUNT_ID IN (SELECT account_id FROM owned_accounts)
  GROUP BY task.ACCOUNT_ID
)
SELECT
  'scope' AS row_type,
  scope.scope_count,
  NULL::STRING AS cta_id, NULL::STRING AS account_id, NULL::STRING AS account_name, NULL::STRING AS cta_name,
  NULL::NUMBER AS salesforce_activity_count, NULL::DATE AS latest_salesforce_activity_at
FROM scope
UNION ALL
SELECT
  'account' AS row_type,
  1 AS scope_count,
  owned.cta_id, owned.account_id, owned.account_name, owned.cta_name,
  COALESCE(relationship.activity_count, 0) AS salesforce_activity_count,
  relationship.latest_activity_at
FROM owned_open_ctas AS owned
LEFT JOIN salesforce_relationships AS relationship ON owned.account_id = relationship.account_id
ORDER BY row_type, cta_id
`.trim();
}

export function presentPortfolioRelationships(rows, lookbackDays = 60, now = new Date()) {
  validateLookbackDays(lookbackDays);
  const scope = rows.find((row) => field(row, "ROW_TYPE") === "scope");
  if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
    throw new BetaError("PORTFOLIO_RELATIONSHIP_SCOPE_UNAVAILABLE", "The signed-in Snowflake user does not map to one CSM profile, so no portfolio relationship check was shown.");
  }
  const runtimeSelectionByWorkItem = new Map();
  const accounts = rows.filter((row) => field(row, "ROW_TYPE") === "account").map((row) => {
    const ctaId = field(row, "CTA_ID");
    const accountId = field(row, "ACCOUNT_ID");
    if (typeof ctaId !== "string" || typeof accountId !== "string") {
      throw new BetaError("PORTFOLIO_RELATIONSHIP_RESPONSE_INVALID", "The portfolio relationship check was missing an account reference.");
    }
    const workItemRef = opaqueRef("cta", ctaId);
    runtimeSelectionByWorkItem.set(workItemRef, { accountId, ctaId });
    const rawCount = field(row, "SALESFORCE_ACTIVITY_COUNT");
    const activityCount = Number(rawCount);
    if (rawCount == null || typeof rawCount === "boolean" || String(rawCount).trim() === "" || !Number.isSafeInteger(activityCount) || activityCount < 0) {
      throw new BetaError("PORTFOLIO_RELATIONSHIP_RESPONSE_INVALID", "The relationship activity count could not be verified. Do not infer no recent contact.");
    }
    return {
      work_item_ref: workItemRef,
      account_ref: opaqueRef("account", accountId),
      account_display_name: field(row, "ACCOUNT_NAME") || "Unnamed account",
      cta_title: field(row, "CTA_NAME") || "Open CTA",
      recent_relationship_in_past_days: {
        days: lookbackDays,
        state: activityCount > 0 ? "confirmed_in_salesforce" : "needs_gmail_metadata_check",
      },
      salesforce_activity_count_in_window: activityCount,
      latest_salesforce_activity_at: field(row, "LATEST_SALESFORCE_ACTIVITY_AT"),
      source_states: {
        salesforce_activity: "checked",
        gmail_metadata: activityCount > 0 ? "not_needed" : "required_before_negative_claim",
      },
    };
  });
  const result = {
    accounts,
    lookback_days: lookbackDays,
    source: "Salesforce relationship activity for the signed-in CSM's owned CTA portfolio",
    read_at: now.toISOString(),
    runtimeSelectionByWorkItem,
    source_limit_reached: accounts.length >= MAX_PORTFOLIO_ITEMS,
    source_limit_warning: accounts.length >= MAX_PORTFOLIO_ITEMS
      ? "This relationship read covers the highest-priority 100 owned in-book CTA items. Additional items may exist; do not treat this as a full-portfolio result."
      : null,
  };
  Object.defineProperty(result, "runtimeSelectionByWorkItem", { enumerable: false, value: runtimeSelectionByWorkItem });
  return result;
}

function safeDiagnostics(details = {}) {
  const result = {};
  for (const key of ["connection_start_ms", "statement_execution_ms", "fetch_results_ms", "serialization_ms", "execution_duration_ms", "worker_start_timeout_ms"]) {
    if (Number.isFinite(details[key]) && details[key] >= 0) result[key] = Math.round(details[key]);
  }
  if (typeof details.statement_started === "boolean") result.statement_started = details.statement_started;
  if (["connection_start", "worker_bootstrap", "statement_execution", "fetch_results", "serialization"].includes(details.failure_stage)) result.failure_stage = details.failure_stage;
  if (["ProgrammingError", "OperationalError", "DatabaseError", "InterfaceError", "ModuleNotFoundError", "ImportError", "PermissionError", "OSError", "BootstrapError"].includes(details.source_error_type)) result.source_error_type = details.source_error_type;
  if (Number.isInteger(details.source_error_number)) result.source_error_number = details.source_error_number;
  if (/^[A-Z0-9]{5}$/.test(details.source_sqlstate || "")) result.source_sqlstate = details.source_sqlstate;
  return result;
}

export async function readPortfolioRelationships({ connectionName = "zdp-global", lookbackDays = 60, session = null, onProgress = null, now = new Date() } = {}) {
  validateLookbackDays(lookbackDays);
  const startedAt = Date.now();
  const managed = session || new PersistentSnowflakeSession({ connectionName });
  let diagnostics = { statement_started: false };
  const progress = (event) => { try { onProgress?.(event); } catch { /* observers cannot change a read */ } };
  progress({ stage: "connection_start", stage_deadline_seconds: 25 });
  try {
    const rows = await managed.query(buildPortfolioRelationshipSql(lookbackDays), {
      timeoutMs: PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS,
      onStarted: event => {
        diagnostics = { ...diagnostics, ...safeDiagnostics({ connection_start_ms: event.queue_wait_ms }), statement_started: true };
        progress({ stage: "recent_salesforce_activity", stage_deadline_seconds: PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS / 1000 });
      },
      onDiagnostics: event => { diagnostics = { ...diagnostics, ...safeDiagnostics(event) }; },
    });
    const resultSet = presentPortfolioRelationships(rows, lookbackDays, now);
    resultSet.read_deadline_seconds = PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS / 1000;
    resultSet.source_durations_ms = { recent_salesforce_activity: Date.now() - startedAt };
    resultSet.source_read_diagnostics = diagnostics;
    return resultSet;
  } catch (error) {
    if (error instanceof BetaError && /^(PORTFOLIO_RELATIONSHIP_|INVALID_RELATIONSHIP_)/.test(error.code)) throw error;
    const details = { ...diagnostics, ...safeDiagnostics(error?.details), failed_stage: "recent_salesforce_activity",
      elapsed_ms: Date.now() - startedAt, deadline_ms: PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS };
    if (["SNOWFLAKE_SESSION_TIMEOUT", "SNOWFLAKE_SESSION_WINDOW_TIMEOUT"].includes(error?.code)) {
      throw new BetaError("PORTFOLIO_RELATIONSHIP_READ_TIMEOUT", "The Salesforce relationship check did not return within 60 seconds of execution. Nothing was saved. Do not retry this read; continue with Gmail metadata and show Salesforce as unavailable for this run.", details);
    }
    if (details.statement_started === false) {
      throw new BetaError("PORTFOLIO_RELATIONSHIP_CONNECTION_UNAVAILABLE", "The Snowflake connection did not start the relationship read. Show Salesforce as unavailable, not as no recent contact. Complete connection setup before another requested read.", details);
    }
    throw new BetaError("PORTFOLIO_RELATIONSHIP_READ_FAILED", "The governed relationship read failed. Show Salesforce as unavailable and continue only with separately verified Gmail metadata. No relationship result was saved.", details);
  } finally {
    if (!session) managed.close();
  }
}

/** One temporary read, bound to its tester and case. Polling never retries. */
export class PortfolioRelationshipReadJobs {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.jobs = new Map(); }
  prune() { for (const [ref, job] of this.jobs) if (job.expiresAt <= this.now()) this.jobs.delete(ref); }
  start({ ownerRef, caseId, read }) {
    this.prune();
    if (!ownerRef || !caseId || typeof read !== "function") throw new BetaError("PORTFOLIO_RELATIONSHIP_SCOPE_UNAVAILABLE", "A scoped, owner-bound relationship read is required.");
    const current = [...this.jobs.values()].find(job => job.ownerRef === ownerRef && job.caseId === caseId && job.status === "in_progress");
    if (current) throw new BetaError("PORTFOLIO_RELATIONSHIP_IN_PROGRESS", "Continue the active relationship read; do not start another.", { relationship_read_ref: current.ref });
    const ref = crypto.randomBytes(18).toString("base64url");
    const job = { ref, ownerRef, caseId, status: "in_progress", startedAt: this.now(), stageStartedAt: this.now(),
      stage: "connection_start", stageDeadlineSeconds: 25, expiresAt: this.now() + RELATIONSHIP_RUN_TTL_MS, result: null, error: null };
    this.jobs.set(ref, job);
    const timer = setTimeout(() => this.prune(), RELATIONSHIP_RUN_TTL_MS + 1); timer.unref?.();
    void Promise.resolve().then(() => read(event => {
      if (!["connection_start", "recent_salesforce_activity"].includes(event.stage)) return;
      if (job.stage !== event.stage) job.stageStartedAt = this.now();
      job.stage = event.stage;
      job.stageDeadlineSeconds = event.stage === "connection_start" ? 25 : PORTFOLIO_RELATIONSHIP_READ_TIMEOUT_MS / 1000;
    })).then(result => { job.status = "ready"; job.result = result; }, error => {
      job.status = "failed";
      job.error = error instanceof BetaError ? error : new BetaError("PORTFOLIO_RELATIONSHIP_READ_FAILED", "The governed relationship read failed. No result was saved.");
    });
    return this.poll({ ref, ownerRef, caseId });
  }
  poll({ ref, ownerRef, caseId }) {
    this.prune();
    const job = this.jobs.get(ref);
    if (!job || job.ownerRef !== ownerRef || job.caseId !== caseId) throw new BetaError("PORTFOLIO_RELATIONSHIP_RUN_UNAVAILABLE", "The temporary relationship read is unavailable for this tester and case; it may have expired or the process restarted.");
    const context = { status: job.status, relationship_read_ref: ref, expires_at: new Date(job.expiresAt).toISOString(),
      elapsed_seconds: Math.floor((this.now() - job.startedAt) / 1000) };
    if (job.status === "failed") return { ...context, code: job.error.code, message: job.error.message, diagnostics: job.error.details || {},
      next_action: "Show the source failure and do not retry this read automatically or infer no recent contact. Continue only with separately verified Gmail metadata." };
    if (job.status === "ready") {
      const result = { ...job.result, ...context, source_elapsed_ms: job.result.source_durations_ms?.recent_salesforce_activity,
        next_action: "Use the returned relationship evidence and show any source-limit warning. No CTA selection or approval was recorded by this read." };
      Object.defineProperty(result, "runtimeSelectionByWorkItem", { enumerable: false, value: job.result.runtimeSelectionByWorkItem });
      return result;
    }
    return { ...context, stage: job.stage, stage_elapsed_seconds: Math.floor((this.now() - job.stageStartedAt) / 1000),
      stage_deadline_seconds: job.stageDeadlineSeconds, next_check_after_seconds: 20,
      next_action: "Tell the CSM the relationship read is still running, then continue this same read in about 20 seconds. Do not ask for another prompt or start another read." };
  }
}

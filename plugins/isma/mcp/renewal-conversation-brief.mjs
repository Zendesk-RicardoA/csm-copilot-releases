import crypto from "node:crypto";
import Native from "./approved-native-contract.js";

import { BetaError } from "./core.mjs";
import { assessAccountIntelligenceCompleteness } from "./account-intelligence-display.mjs";
import { buildAccountPeerBenchmarksSql, buildPeerBenchmarkEvidence } from "./account-peer-benchmarks.mjs";
import { performanceCoverage } from "./meeting-prep-build-contract.mjs";
import { ACCOUNT_EVIDENCE_FIRST_PASS_MS, ACCOUNT_EVIDENCE_STATEMENT_MS, readAccountEvidencePlan } from "./account-evidence-read-plan.mjs";
import { PRODUCT_ANALYTICS_SOURCES, buildHistoricalSlaPolicyCtes, historicalSlaPolicyColumns, historicalSlaPolicyEvidence, sourceSnapshotDateRange } from "./product-analytics-sources.mjs";
import {
  buildAccountContextSql,
  buildPerformanceMetricTable,
  buildGuideKnowledgeViewMetricsSql,
  buildRbaPerformanceMetricsSql,
} from "./journey-a-contact-evidence.mjs";

export const RENEWAL_CONVERSATION_BRIEF_VERSION = "2.0.0";
export const RENEWAL_DECK_CONTENT_VERSION = "2.0.0";
export const RENEWAL_CUSTOMER_COPY_CONTRACT = Native.renewalCopyContract;
export const ACCOUNT_INTELLIGENCE_CORE_VERSION = "1.0.0";
export const ACCOUNT_INTELLIGENCE_CORE_CONTRACT = "AccountIntelligenceCoreV1";
// The persistent worker has one Snowflake connection and serializes cursors.
// Keep this aligned with the managed enrichment retry window so a timer covers
// one executing statement rather than time spent waiting behind another read.
export const RENEWAL_CONVERSATION_EVIDENCE_TIMEOUT_MS = ACCOUNT_EVIDENCE_STATEMENT_MS;
export const RENEWAL_CONVERSATION_EVIDENCE_MAX_MS = ACCOUNT_EVIDENCE_FIRST_PASS_MS;
export const RENEWAL_CONVERSATION_ROLES = ["progress", "opportunities", "focus"];
export const MAX_RELATED_ACCOUNT_CTAS = 50;
export const RENEWAL_CONVERSATION_REVIEW_GATES = [
  "identity",
  "evidence",
  "renewal_hypotheses",
  "renewal_content",
];

const RENEWAL_CTA = /^P[0-4]\s*:\s*.*\brenewal\b/i;
const TICKET_CHANNEL_LOOKBACK_MONTHS = 24;
const TICKET_CHANNEL_SCOPE_NOTE = "Ticket share in the latest complete calendar month, grouped with the QBR ticket-via mapping. This includes all recorded ticket sources; it is not the same scope as the human-support performance trends.";
const POSITIVE_DIRECTION = new Map([
  ["CSAT score", "higher"],
  ["Median first reply time", "lower"],
  ["Median resolution time", "lower"],
  ["Zero-touch ticket ratio", "higher"],
  ["One-touch ticket ratio", "higher"],
  ["Knowledge views", "higher"],
]);

function field(row, name) {
  return row?.[name] ?? row?.[name.toLowerCase()] ?? null;
}

function number(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (value === 1 || value === 0) return Boolean(value);
  return null;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCommercialSubscriptions(value) {
  const parsed = typeof value === "string"
    ? (() => { try { return JSON.parse(value); } catch (_error) { return []; } })()
    : value;
  return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
}

function parseStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim());
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
  } catch (_error) {
    return value.trim() ? [value.trim()] : [];
  }
}

function parseObjectArray(value) {
  const parsed = typeof value === "string"
    ? (() => { try { return JSON.parse(value); } catch (_error) { return []; } })()
    : value;
  return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
}

function sourceValueState(source, value) {
  if (!source || source.state !== "checked") return source?.state || "not_assessed";
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return "no_data";
  return "checked";
}

function subscriptionIsCurrent(subscription, today = new Date()) {
  const status = String(subscription.status || "").toLowerCase();
  const termEnd = subscription.term_end ? new Date(subscription.term_end) : null;
  if (!/cancel/.test(status)) return !/expired|terminated/.test(status);
  return Boolean(termEnd && !Number.isNaN(termEnd.valueOf()) && termEnd >= today);
}

function subscriptionText(subscription) {
  return [subscription.product_plan, subscription.product_line, subscription.offering, subscription.offering_group]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function lifecycleState({ available, activated, adopted, availabilityLabel }) {
  if (adopted === true) return "Adopted";
  if (activated === true) return "Activated but not adopted";
  if (available === true) return `${availabilityLabel} but not activated`;
  if (available === false) return "Not established";
  return "Unavailable in the current snapshot";
}

function currentSubscriptionSummary(subscriptions) {
  return subscriptions.map((subscription) => ({
    plan: text(subscription.product_plan),
    product_line: text(subscription.product_line),
    offering: text(subscription.offering),
    offering_group: text(subscription.offering_group),
    status: text(subscription.status),
    seats: number(subscription.seats),
    arr_band: text(subscription.arr_band),
    term_end: subscription.term_end || null,
  }));
}

/**
 * Growth Engine reports active agents separately from the account owner. When
 * the current commercial seat count is exactly one greater than that agent
 * count, the difference is the single owner seat. This is a bounded
 * calculation, not a user-level allocation or identity lookup.
 */
function calculatedSeatAllocation({ subscriptions, activeAgentCount, commercialState, teamState }) {
  if (commercialState !== "checked" || teamState !== "checked" || activeAgentCount == null) {
    return { state: "not_assessed", value: null, note: "Seat use requires both current commercial seats and active-agent data." };
  }
  const contractedSeats = subscriptions
    .map((subscription) => number(subscription.seats))
    .filter((seatCount) => seatCount != null)
    .reduce((total, seatCount) => total + seatCount, 0);
  if (contractedSeats !== activeAgentCount + 1) {
    return {
      state: "not_established",
      value: null,
      note: "The available sources do not establish a seat allocation for this account.",
    };
  }
  return {
    state: "calculated",
    value: `${contractedSeats} of ${contractedSeats} seats used — 1 owner, ${activeAgentCount} agents`,
    note: "Calculated from current contracted seats and active agents. It distinguishes the account owner from agents without identifying individual users.",
  };
}

function capabilityEligibility({
  subscriptions,
  guideEligible,
  guideActivated,
  guideExternalConnectorCount,
  copilotPaidPenetrated,
  aiAgentsPaidPenetrated,
}) {
  const current = subscriptions.filter((subscription) => subscriptionIsCurrent(subscription));
  const plans = current.map(subscriptionText);
  const hasSupportOrSuiteProfessionalPlan = plans.some((value) => /(?:support|suite)/.test(value) && /professional|enterprise/.test(value));
  const hasCopilotAddOn = copilotPaidPenetrated === true && plans.some((value) => /copilot/.test(value));
  const hasAiAgents = aiAgentsPaidPenetrated === true && plans.some((value) => /ai\s*agents?/.test(value));
  return {
    admin_copilot: hasSupportOrSuiteProfessionalPlan,
    intelligent_triage: hasCopilotAddOn,
    auto_assist: hasCopilotAddOn,
    knowledge_copilot: hasSupportOrSuiteProfessionalPlan,
    knowledge_connectors: number(guideExternalConnectorCount) > 0,
    knowledge_builder: guideEligible === true && guideActivated === false,
    ai_agents: hasAiAgents,
    workflow_automation: hasSupportOrSuiteProfessionalPlan,
  };
}

function observedAdoptionState(adopted) {
  if (adopted === true) return "Adopted";
  if (adopted === false) return "Not adopted in the current snapshot";
  return "Unavailable in the current snapshot";
}

function earliestCurrentTermEnd(subscriptions) {
  const dates = subscriptions
    .map((subscription) => subscription.term_end)
    .filter((termEnd) => typeof termEnd === "string" && !Number.isNaN(new Date(termEnd).valueOf()))
    .sort((left, right) => new Date(left) - new Date(right));
  return dates[0] || null;
}

function calendarDaysUntil(dateValue, now = new Date()) {
  const target = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateValue || ""));
  if (!target || Number.isNaN(now.valueOf())) return null;
  const targetDay = Date.UTC(Number(target[1]), Number(target[2]) - 1, Number(target[3]));
  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((targetDay - currentDay) / 86_400_000);
}

function resolvedRenewalTiming({ account, sourceStates, now = new Date() }) {
  const crmRenewalDate = account?.csm_account_context?.renewal_date || null;
  if (crmRenewalDate) {
    return {
      state: sourceStates.renewal_timing || "checked",
      date: crmRenewalDate,
      days_remaining: calendarDaysUntil(crmRenewalDate, now),
      basis: "CRM renewal date",
    };
  }
  const termEnd = earliestCurrentTermEnd(account?.product_context?.current_subscriptions || []);
  if (termEnd && sourceStates.commercial_subscriptions === "checked") {
    return {
      state: "checked",
      date: termEnd,
      days_remaining: calendarDaysUntil(termEnd, now),
      basis: "Current active subscription term end (CRM renewal date not available)",
    };
  }
  return {
    state: sourceStates.renewal_timing || "not_assessed",
    date: null,
    days_remaining: null,
    basis: null,
  };
}

function safeQueryFailureCategory(error) {
  const sourceType = String(error instanceof BetaError ? error.details?.source_error_type || "" : "").toLowerCase();
  if (/(authorization|authentication|permission|access)/.test(sourceType)) return "source_access";
  if (/(data|conversion|cast|type)/.test(sourceType)) return "data_type";
  if (/(programming|compilation|syntax|identifier|schema)/.test(sourceType)) return "schema_or_query";
  return "unknown_query_failure";
}

function sourceResult(session, source, query, sourceDurationsMs, statementExecutions, {
  retryState = "not_retried",
  attempt = 1,
  timeoutMs = RENEWAL_CONVERSATION_EVIDENCE_TIMEOUT_MS,
  deadlineAtMs = null,
  phase = "account_evidence",
  nowMs = Date.now,
} = {}) {
  const requestedAt = nowMs();
  let executionStartedAt = null;
  let safeOutcome = null;
  let safeFailureCategory = null;
  let diagnostics = {};
  const recordOutcome = (state, failureCategory = null) => {
    safeOutcome = state;
    safeFailureCategory = failureCategory;
    const execution = [...statementExecutions].reverse().find((entry) => entry.source === source && entry.attempt === attempt);
    if (execution) {
      execution.safe_outcome = state;
      if (failureCategory) execution.safe_failure_category = failureCategory;
    }
  };
  return session.query(query, {
    timeoutMs,
    deadlineAtMs,
    onDiagnostics: (value) => { diagnostics = value; },
    onStarted: ({ started_at, queue_wait_ms }) => {
      executionStartedAt = nowMs();
      statementExecutions.push({
        source,
        statement_order: statementExecutions.length + 1,
        attempt,
        started_at,
        queue_wait_ms,
        retry_state: retryState,
        phase,
        execution_timeout_ms: timeoutMs,
      });
    },
  })
    .then((rows) => {
      const result = rows.length
        ? { state: "checked", rows, failure_code: null }
        : { state: "no_data", rows, failure_code: "NO_ROWS_RETURNED" };
      recordOutcome(result.state);
      return result;
    })
    .catch((error) => {
      diagnostics = { ...diagnostics, ...error.details };
      if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_WINDOW_TIMEOUT") {
        const result = { state: error.details?.statement_started ? "timed_out" : "not_run", rows: [], failure_code: "EVIDENCE_WINDOW_EXHAUSTED" };
        recordOutcome(result.state);
        return result;
      }
      if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") {
        const result = { state: "timed_out", rows: [], failure_code: "SOURCE_TIMEOUT" };
        recordOutcome(result.state);
        return result;
      }
      if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_START_TIMEOUT") {
        const result = { state: "unavailable", rows: [], failure_code: "SOURCE_SESSION_START_TIMEOUT" };
        recordOutcome(result.state);
        return result;
      }
      const result = {
        state: "query_failed",
        rows: [],
        failure_code: "SOURCE_QUERY_FAILED",
        safe_failure_category: safeQueryFailureCategory(error),
      };
      recordOutcome(result.state, result.safe_failure_category);
      return result;
    })
    .finally(() => {
      const finishedAt = nowMs();
      sourceDurationsMs[source] = executionStartedAt == null ? null : finishedAt - executionStartedAt;
      const execution = [...statementExecutions].reverse().find((entry) => entry.source === source && entry.attempt === attempt);
      if (execution) {
        execution.finished_at = new Date(finishedAt).toISOString();
        execution.execution_duration_ms = sourceDurationsMs[source];
      } else {
        statementExecutions.push({
          source,
          statement_order: statementExecutions.length + 1,
          attempt,
          started_at: null,
          finished_at: new Date(finishedAt).toISOString(),
          queue_wait_ms: null,
          execution_duration_ms: null,
          retry_state: retryState,
          phase,
          execution_timeout_ms: timeoutMs,
          safe_outcome: safeOutcome || "worker_unavailable_before_start",
          ...(safeFailureCategory ? { safe_failure_category: safeFailureCategory } : {}),
          requested_at: new Date(requestedAt).toISOString(),
        });
      }
      const diagnostic = [...statementExecutions].reverse().find((entry) => entry.source === source && entry.attempt === attempt);
      for (const key of ["failure_stage", "statement_started", "statement_execution_ms", "fetch_results_ms", "serialization_ms", "window_exhausted"]) {
        if (diagnostics[key] != null) diagnostic[key] = diagnostics[key];
      }
    });
}

/**
 * Both preparation options use one account-intelligence source. The renewal
 * option changes only how that evidence is presented: three focused renewal
 * slides instead of a full customer plan. This alias preserves the renewal
 * interface without creating a second version of account truth.
 */
export function buildRenewalAccountContextSql(accountId) {
  return buildAccountContextSql(accountId);
}

/**
 * CSM-owned account context is intentionally separate from the commercial and
 * product snapshots. Gainsight owns this operational view; Salesforce remains
 * the account-identity authority. Keeping it small avoids reintroducing the
 * wide account query that previously stalled an interactive renewal run.
 */
export function buildRenewalGainsightAccountContextSql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
SELECT company.SFDC_ACCOUNT_ID AS account_id,
  company.NAME AS account_name,
  company.ACCOUNT_HEALTH_STATUS_GC AS account_health,
  company.DYNAMIC_SEGMENTATION_ENGAGEMENT_GC AS cs_segment,
  company.MARKET_SEGMENT_GC AS market_segment,
  company.NET_ARR_USD_GC AS net_arr_usd,
  csm.NAME AS csm_name
FROM CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
LEFT JOIN CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV AS csm
  ON company.SUCCESS_OWNER_C_GC = csm.GSID
WHERE company.SFDC_ACCOUNT_ID = '${accountId}'
LIMIT 1
`.trim();
}

/**
 * Account-scoped CTA context comes from the Gainsight system of record. The
 * native CTA monitor URL is deliberately not constructed: no approved source
 * field or URL contract exists for it yet.
 */
export function buildRenewalRelatedAccountCtasSql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
SELECT cta.NAME AS cta_title,
  status.NAME AS cta_status,
  cta.CREATED_DATE AS created_at,
  cta.DUE_DATE AS due_at
FROM CLEANSED.GAINSIGHT.GAINSIGHT_CALL_TO_ACTION_BCV AS cta
JOIN CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
  ON cta.COMPANY_ID = company.GSID
JOIN CLEANSED.GAINSIGHT.GAINSIGHT_DA_PICKLIST_BCV AS status
  ON cta.STATUS_ID = status.GSID
  AND status.CATEGORY = 'CTA_STATUS'
  AND status.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
WHERE company.SFDC_ACCOUNT_ID = '${accountId}'
  AND cta.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
  AND status.IS_OPEN_STATUS = TRUE
ORDER BY cta.DUE_DATE ASC NULLS LAST, cta.CREATED_DATE DESC, cta.GSID
LIMIT ${MAX_RELATED_ACCOUNT_CTAS + 1}
`.trim();
}

function assertRenewalAccountId(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
}

/**
 * The account-intelligence contract is deliberately read as small,
 * independently attributable statements. The managed renewal operation still
 * owns every read and keeps them serial on its one Snowflake worker. This
 * means a changed adoption snapshot cannot hide company, subscription, or the
 * other verified product facts.
 */
export function buildRenewalCompanyProfileSql(accountId) {
  assertRenewalAccountId(accountId);
  return `
SELECT salesforce.ID AS account_id, salesforce.NAME AS account_name,
  salesforce.BILLING_COUNTRY AS billing_country,
  salesforce.INDUSTRY AS company_industry, salesforce.TYPE AS company_type,
  salesforce.DESCRIPTION AS company_summary,
  salesforce.NUMBER_OF_EMPLOYEES AS company_employee_count,
  salesforce.BILLING_CITY AS company_hq_city, salesforce.BILLING_STATE AS company_hq_state,
  salesforce.BILLING_COUNTRY AS company_hq_country, salesforce.WEBSITE AS company_website
FROM CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS salesforce
WHERE salesforce.ID = '${accountId}'
LIMIT 1
`.trim();
}

function buildLatestAdoptionSnapshotSql(accountId, table, fields) {
  assertRenewalAccountId(accountId);
  return `
SELECT SOURCE_SNAPSHOT_DATE, ${fields.join(", ")}
FROM ${table}
WHERE CRM_ACCOUNT_ID = '${accountId}'
QUALIFY ROW_NUMBER() OVER (ORDER BY SOURCE_SNAPSHOT_DATE DESC) = 1
`.trim();
}

export function buildRenewalGuideAdoptionSql(accountId) {
  return buildLatestAdoptionSnapshotSql(accountId, PRODUCT_ANALYTICS_SOURCES.guide, [
    "SOURCE_SNAPSHOT_DATE AS guide_snapshot_date",
    "CRM_IS_KNOWLEDGE_ELIGIBLE AS guide_eligible",
    "CRM_IS_KNOWLEDGE_ACTIVATED AS guide_activated",
    "CRM_IS_KNOWLEDGE_ADOPTED AS guide_adopted",
  ]);
}

export function buildRenewalCopilotAdoptionSql(accountId) {
  return buildLatestAdoptionSnapshotSql(accountId, PRODUCT_ANALYTICS_SOURCES.copilot, [
    "SOURCE_SNAPSHOT_DATE AS copilot_snapshot_date",
    "CRM_IS_COPILOT_PAID_PENETRATED AS copilot_paid_penetrated",
    "CRM_IS_COPILOT_PAID_ACTIVATED AS copilot_paid_activated",
    "CRM_IS_COPILOT_PAID_ADOPTED AS copilot_paid_adopted",
    "CRM_IS_COPILOT_UNPAID_PENETRATED AS copilot_unpaid_penetrated",
    "CRM_IS_COPILOT_UNPAID_ACTIVATED AS copilot_unpaid_activated",
    "CRM_IS_COPILOT_UNPAID_ADOPTED AS copilot_unpaid_adopted",
  ]);
}

export function buildRenewalAiAgentsAdoptionSql(accountId) {
  return buildLatestAdoptionSnapshotSql(accountId, PRODUCT_ANALYTICS_SOURCES.ai_agents, [
    "SOURCE_SNAPSHOT_DATE AS ai_agents_snapshot_date",
    "CRM_IS_AI_AGENTS_PAID_PENETRATED AS ai_agents_paid_penetrated",
    "CRM_IS_AI_AGENTS_PAID_ACTIVATED AS ai_agents_paid_activated",
    "CRM_IS_AI_AGENTS_PAID_ADOPTED AS ai_agents_paid_adopted",
    "CRM_IS_AI_AGENTS_UNPAID_PENETRATED AS ai_agents_unpaid_penetrated",
    "CRM_IS_AI_AGENTS_UNPAID_ACTIVATED AS ai_agents_unpaid_activated",
    "CRM_IS_AI_AGENTS_UNPAID_ADOPTED AS ai_agents_unpaid_adopted",
  ]);
}

export function buildRenewalSuiteAdoptionSql(accountId) {
  return buildLatestAdoptionSnapshotSql(accountId, PRODUCT_ANALYTICS_SOURCES.suite, [
    "SOURCE_SNAPSHOT_DATE AS suite_snapshot_date",
    "CRM_IS_ZENDESK_SUITE_ELIGIBLE AS suite_eligible",
    "CRM_IS_ZENDESK_SUITE_PENETRATED AS suite_penetrated",
    "CRM_IS_ZENDESK_SUITE_ACTIVATED AS suite_activated",
    "CRM_IS_ZENDESK_SUITE_ADOPTED AS suite_adopted",
  ]);
}

export function buildRenewalBasicToolsAdoptionSql(accountId) {
  return buildLatestAdoptionSnapshotSql(accountId, PRODUCT_ANALYTICS_SOURCES.basic_tools, [
    "SOURCE_SNAPSHOT_DATE AS basic_tools_snapshot_date",
    "CRM_IS_BASIC_TOOLS_AND_RULES_ADOPTED AS basic_tools_adopted",
  ]);
}

export function buildRenewalCommercialSubscriptionsSql(accountId) {
  assertRenewalAccountId(accountId);
  return `
SELECT TO_JSON(ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(
  'product_plan', PRODUCT_PLAN,
  'product_line', PRODUCT_LINE,
  'offering', PRODUCT_OFFERING,
  'offering_group', PRODUCT_OFFERING_GROUPED,
  'status', SUBSCRIPTION_STATUS,
  'seats', SEATS,
  'arr_band', SIMPLIFIED_ARR_BANDS_CALC,
  'term_end', SUBSCRIPTION_TERM_END_DATE
))) AS commercial_subscriptions_json
FROM (
  SELECT PRODUCT_PLAN, PRODUCT_LINE, PRODUCT_OFFERING, PRODUCT_OFFERING_GROUPED,
    SUBSCRIPTION_STATUS, SEATS, SIMPLIFIED_ARR_BANDS_CALC, SUBSCRIPTION_TERM_END_DATE
  FROM PRESENTATION.EDA_FINANCE.PRICING_COMM_SUBSCRIPTION
  WHERE CRM_ACCOUNT_ID = '${accountId}'
  LIMIT 50
)
`.trim();
}

/**
 * Bullseye Pro already exposes the account's CRM owner, renewal timing, and
 * CRM region at the CRM-account grain. Keep it separate from subscriptions
 * and adoption so a changed source cannot suppress the rest of the shared
 * account brief.
 */
export function buildRenewalAccountTimingSql(accountId) {
  assertRenewalAccountId(accountId);
  return `
SELECT CRM_OWNER_NAME AS account_executive,
  CRM_REGION AS account_region,
  CRM_SUB_REGION AS account_sub_region,
  CRM_NEXT_RENEWAL_DATE AS renewal_date,
  CRM_DAYS_TO_RENEWAL AS renewal_days_remaining,
  CRM_RENEWAL_TERM AS renewal_term,
  CRM_RENEWAL_OWNER_NAME AS renewal_manager
FROM PRESENTATION.BULLSEYE_PRO.CUSTOMERS
WHERE CRM_ACCOUNT_ID = '${accountId}'
LIMIT 1
`.trim();
}

/**
 * This is the QBR channel taxonomy, reduced to the selected account and its
 * latest complete month. The QBR history is 24 months; the brief retains that
 * bounded source window while presenting only the most recent complete month.
 */
export function buildRenewalTicketsByChannelSql(accountId) {
  assertRenewalAccountId(accountId);
  return `
WITH account_instances AS (
  SELECT DISTINCT ZENDESK_ACCOUNT_ID
  FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS
  WHERE CRM_ACCOUNT_ID = '${accountId}'
    AND ZENDESK_ACCOUNT_ID IS NOT NULL
), channel_history AS (
  SELECT DATE_TRUNC('MONTH', ticket.SOURCE_SNAPSHOT_DATE) AS date_month,
    CASE
      WHEN ticket.TICKET_VIA_ID IN (5, 66) THEN 'API'
      WHEN ticket.TICKET_VIA_ID IN (46, 44, 45, 34, 33, 35) THEN 'Phone'
      WHEN ticket.TICKET_VIA_ID IN (67, 0, 48) THEN 'Web'
      WHEN ticket.TICKET_VIA_ID = 29 THEN 'Chat'
      WHEN ticket.TICKET_VIA_ID = 49 THEN 'Mobile SDK'
      WHEN ticket.TICKET_VIA_ID = 4 THEN 'Email'
      WHEN ticket.TICKET_VIA_ID IN (75, 72, 83, 85, 88, 79, 82, 84, 74, 78, 80, 73,
        91, 77, 87, 86, 81, 76, 23, 26, 38, 55, 41, 30) THEN 'Messaging'
      WHEN ticket.TICKET_VIA_ID IN (65, 69, 56, 57, 27, 70, 1, 9, 62, 51, 37, 63, 2, 31, 25, 22, 39,
        17, 15, 14, 11, 18, 8, 7, 6, 50, 32, 36, 20, 10, 90, 42, 71, 54,
        19, 95, 47, 16, 93, 21, 24, 53, 60, 64, 40, 89, 3, 13, 12, 28,
        43, 58, 61, 92, 96, 59, 52, 68, 97, 94) THEN 'Other'
      ELSE 'Unknown'
    END AS ticket_channel,
    SUM(ticket.COUNT_CREATED_TICKETS) AS tickets_created
  FROM PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_DATA_DAILY_SNAPSHOT AS ticket
  JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE ticket.SOURCE_SNAPSHOT_DATE >= DATE_TRUNC('MONTH', DATEADD(MONTH, -${TICKET_CHANNEL_LOOKBACK_MONTHS}, CURRENT_DATE()))
    AND ticket.SOURCE_SNAPSHOT_DATE < DATE_TRUNC('MONTH', CURRENT_DATE())
  GROUP BY 1, 2
), latest_complete_month AS (
  SELECT MAX(date_month) AS date_month
  FROM channel_history
), selected_month AS (
  SELECT ticket_channel,
    SUM(tickets_created) AS tickets_created,
    DIV0(SUM(tickets_created), SUM(SUM(tickets_created)) OVER ()) AS ticket_share
  FROM channel_history
  WHERE date_month = (SELECT date_month FROM latest_complete_month)
  GROUP BY ticket_channel
)
SELECT
  (SELECT date_month FROM latest_complete_month) AS ticket_channels_month,
  (SELECT TO_JSON(ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(
    'channel', ticket_channel,
    'tickets_created', tickets_created,
    'ticket_share', ticket_share
  )) WITHIN GROUP (ORDER BY tickets_created DESC, ticket_channel ASC))
  FROM selected_month) AS ticket_channels_json
`.trim();
}

export function buildRenewalTeamAndTechContextSql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
WITH account_instances AS (
  SELECT ZENDESK_ACCOUNT_ID AS instance_account_id, MAX(NUM_ACTIVE_AGENTS) AS active_agent_count
  FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS
  WHERE CRM_ACCOUNT_ID = '${accountId}'
    AND ZENDESK_ACCOUNT_ID IS NOT NULL
  GROUP BY ZENDESK_ACCOUNT_ID
), security_current AS (
  SELECT security.INSTANCE_ACCOUNT_HAS_CUSTOM_ROLES, security.INSTANCE_ACCOUNT_HAS_SINGLE_SIGN_ON,
    security.SOURCE_SNAPSHOT_DATE
  FROM ${PRODUCT_ANALYTICS_SOURCES.security_instances} AS security
  JOIN account_instances AS instance ON security.INSTANCE_ACCOUNT_ID = instance.instance_account_id
  QUALIFY ROW_NUMBER() OVER (PARTITION BY security.INSTANCE_ACCOUNT_ID ORDER BY security.SOURCE_SNAPSHOT_DATE DESC) = 1
), security_setup AS (
  SELECT COUNT(*) AS security_instance_count,
    MIN(SOURCE_SNAPSHOT_DATE) AS security_oldest_snapshot_date,
    MAX(SOURCE_SNAPSHOT_DATE) AS security_newest_snapshot_date,
    CASE WHEN COUNT(INSTANCE_ACCOUNT_HAS_CUSTOM_ROLES) = (SELECT COUNT(*) FROM account_instances) AND COUNT(*) > 0
      THEN SUM(CASE WHEN INSTANCE_ACCOUNT_HAS_CUSTOM_ROLES THEN 1 ELSE 0 END) ELSE NULL END AS custom_role_instance_count,
    CASE WHEN COUNT(INSTANCE_ACCOUNT_HAS_SINGLE_SIGN_ON) = (SELECT COUNT(*) FROM account_instances) AND COUNT(*) > 0
      THEN SUM(CASE WHEN INSTANCE_ACCOUNT_HAS_SINGLE_SIGN_ON THEN 1 ELSE 0 END) ELSE NULL END AS sso_enabled_instance_count
  FROM security_current
), basic_tools_current AS (
  SELECT tools.NUM_ADOPTED_BASIC_RULE_TYPES_INSTANCE, tools.SOURCE_SNAPSHOT_DATE
  FROM ${PRODUCT_ANALYTICS_SOURCES.basic_tools_instances} AS tools
  JOIN account_instances AS instance ON tools.INSTANCE_ACCOUNT_ID = instance.instance_account_id
  QUALIFY ROW_NUMBER() OVER (PARTITION BY tools.INSTANCE_ACCOUNT_ID ORDER BY tools.SOURCE_SNAPSHOT_DATE DESC) = 1
), basic_tools_setup AS (
  SELECT CASE WHEN COUNT(NUM_ADOPTED_BASIC_RULE_TYPES_INSTANCE) = (SELECT COUNT(*) FROM account_instances) AND COUNT(*) > 0
    THEN MAX(NUM_ADOPTED_BASIC_RULE_TYPES_INSTANCE) ELSE NULL END AS basic_rule_types_adopted_max,
    MIN(SOURCE_SNAPSHOT_DATE) AS basic_tools_oldest_snapshot_date,
    MAX(SOURCE_SNAPSHOT_DATE) AS basic_tools_newest_snapshot_date
  FROM basic_tools_current
), guide_connector_current AS (
  SELECT guide.HAS_EXTERNAL_CONNECTOR, guide.SOURCE_SNAPSHOT_DATE
  FROM ${PRODUCT_ANALYTICS_SOURCES.guide_instances} AS guide
  JOIN account_instances AS instance ON guide.INSTANCE_ACCOUNT_ID = instance.instance_account_id
  WHERE guide.CRM_ACCOUNT_ID = '${accountId}'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY guide.INSTANCE_ACCOUNT_ID ORDER BY guide.SOURCE_SNAPSHOT_DATE DESC) = 1
), guide_connector_context AS (
  SELECT CASE WHEN COUNT(HAS_EXTERNAL_CONNECTOR) = (SELECT COUNT(*) FROM account_instances) AND COUNT(*) > 0
    THEN SUM(CASE WHEN HAS_EXTERNAL_CONNECTOR THEN 1 ELSE 0 END) ELSE NULL END AS guide_external_connector_instance_count,
    MIN(SOURCE_SNAPSHOT_DATE) AS guide_connector_oldest_snapshot_date,
    MAX(SOURCE_SNAPSHOT_DATE) AS guide_connector_newest_snapshot_date
  FROM guide_connector_current
), marketplace_current AS (
  SELECT app.APPS_APP_NAME
  FROM PRESENTATION.TECHNOLOGY_ALLIANCES.INSTALLED_APPS_SOURCE_DASHBOARD AS app
  WHERE app.CRM_ACCOUNT_ID = '${accountId}'
  QUALIFY app.RUN_AT = MAX(app.RUN_AT) OVER ()
), marketplace_apps AS (
  SELECT ARRAY_SORT(ARRAY_AGG(DISTINCT APPS_APP_NAME)) AS marketplace_app_names
  FROM marketplace_current
), integration_current AS (
  SELECT integration.NUM_ACTIVE_WEBHOOKS_INSTANCE,
    integration.INSTANCE_HAS_WEBHOOKS_ACTIVE_USAGE,
    integration.INSTANCE_HAS_API_ACTIVE_USAGE,
    integration.PERC_API_TICKETS_INSTANCE,
    integration.NUM_PRIVATE_APPS_INSTANCE
  FROM PRESENTATION.PRODUCT_ANALYTICS.INTEGRATIONS_AND_FLEXIBILITY_INSTANCE AS integration
  WHERE integration.CRM_ACCOUNT_ID = '${accountId}'
  QUALIFY integration.SOURCE_SNAPSHOT_DATE = MAX(integration.SOURCE_SNAPSHOT_DATE) OVER ()
), integration_context AS (
  SELECT MAX(NUM_ACTIVE_WEBHOOKS_INSTANCE) AS max_active_webhook_count,
    COUNT_IF(COALESCE(INSTANCE_HAS_WEBHOOKS_ACTIVE_USAGE, 0) <> 0) AS webhook_active_usage_instance_count,
    COUNT_IF(COALESCE(INSTANCE_HAS_API_ACTIVE_USAGE, 0) <> 0) AS api_active_usage_instance_count,
    MAX(PERC_API_TICKETS_INSTANCE) AS max_api_ticket_percent,
    MAX(NUM_PRIVATE_APPS_INSTANCE) AS max_private_app_count
  FROM integration_current
)
SELECT
  (SELECT COUNT(*) FROM account_instances) AS team_setup_instance_count,
  (SELECT SUM(active_agent_count) FROM account_instances) AS team_setup_active_agent_count,
  NULL::BOOLEAN AS team_setup_sla_active,
  security.security_instance_count AS team_setup_security_covered_instance_count,
  security.custom_role_instance_count AS team_setup_custom_role_instance_count,
  security.security_oldest_snapshot_date AS team_setup_security_oldest_snapshot_date,
  security.security_newest_snapshot_date AS team_setup_security_newest_snapshot_date,
  basic.basic_rule_types_adopted_max AS team_setup_basic_rule_types_adopted_max,
  basic.basic_tools_oldest_snapshot_date AS team_setup_basic_tools_oldest_snapshot_date,
  basic.basic_tools_newest_snapshot_date AS team_setup_basic_tools_newest_snapshot_date,
  security.sso_enabled_instance_count AS tech_stack_sso_enabled_instance_count,
  guide_context.guide_external_connector_instance_count AS tech_stack_guide_external_connector_instance_count,
  guide_context.guide_connector_oldest_snapshot_date AS tech_stack_guide_connector_oldest_snapshot_date,
  guide_context.guide_connector_newest_snapshot_date AS tech_stack_guide_connector_newest_snapshot_date,
  apps.marketplace_app_names AS tech_stack_marketplace_app_names,
  integration.max_active_webhook_count AS tech_stack_max_active_webhook_count,
  integration.webhook_active_usage_instance_count AS tech_stack_webhook_active_usage_instance_count,
  integration.api_active_usage_instance_count AS tech_stack_api_active_usage_instance_count,
  integration.max_api_ticket_percent AS tech_stack_max_api_ticket_percent,
  integration.max_private_app_count AS tech_stack_max_private_app_count
FROM (SELECT 1 AS context_row) AS root
LEFT JOIN security_setup AS security ON TRUE
LEFT JOIN basic_tools_setup AS basic ON TRUE
LEFT JOIN guide_connector_context AS guide_context ON TRUE
LEFT JOIN marketplace_apps AS apps ON TRUE
LEFT JOIN integration_context AS integration ON TRUE
`.trim();
}

/** Historical policy configuration, independent of current setup evidence. */
export function buildRenewalHistoricalSlaPolicySql(accountId) {
  assertRenewalAccountId(accountId);
  return `
WITH account_instances AS (
  SELECT DISTINCT ZENDESK_ACCOUNT_ID AS instance_account_id
  FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS
  WHERE CRM_ACCOUNT_ID = '${accountId}' AND ZENDESK_ACCOUNT_ID IS NOT NULL
), ${buildHistoricalSlaPolicyCtes(accountId)}
SELECT (SELECT COUNT(*) FROM account_instances) AS team_setup_historical_sla_expected_instance_count,
  ${historicalSlaPolicyColumns()}
FROM support_setup AS support
`.trim();
}

/**
 * Bullseye's account-level Gong projection is the approved source for a
 * renewal brief. It is already keyed by CRM account through Gong conversation
 * contexts, so the beta must not fall back to a contact or email join that can
 * miss valid customer calls. This remains metadata-only navigation context:
 * it excludes URLs, participant identities, transcript content, and outcomes.
 */
export function buildRenewalAccountGongDigestSql(accountId) {
  assertRenewalAccountId(accountId);
  return `
WITH matched_calls AS (
  SELECT TO_VARCHAR(GONG_CONVERSATION_KEY) AS conversation_key,
    ACTIVITY_DATETIME AS call_at,
    TO_VARCHAR(ACTIVITY_SUBJECT) AS call_title
  FROM PRESENTATION.BULLSEYE_PRO.SALES_ACTIVITY
  WHERE CRM_ACCOUNT_ID = '${accountId}'
    AND GONG_CONVERSATION_KEY IS NOT NULL
    AND ACTIVITY_DATETIME >= DATEADD(day, -180, CURRENT_TIMESTAMP())
), recent_calls AS (
  SELECT *
  FROM matched_calls
  QUALIFY ROW_NUMBER() OVER (ORDER BY call_at DESC, conversation_key DESC) <= 3
)
SELECT
  (SELECT COUNT(*) FROM matched_calls) AS reliably_matched_call_count,
  (SELECT MAX(call_at) FROM matched_calls) AS latest_reliably_matched_call_at,
  TO_JSON(ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(
    'call_at', call_at,
    'title', call_title,
    'conversation_key', conversation_key,
    'match_strength', 'account_spotlight'
  )) WITHIN GROUP (ORDER BY call_at DESC, conversation_key DESC)) AS recent_calls_json
FROM recent_calls
`.trim();
}

/**
 * Spotlight fields are optional conversation navigation context. Keep them in
 * a second bounded statement so a changed semi-structured field can never
 * erase the verified call list from the account brief.
 */
export function buildRenewalAccountGongSpotlightSql(accountId) {
  assertRenewalAccountId(accountId);
  return `
WITH recent_calls AS (
  SELECT TO_VARCHAR(GONG_CONVERSATION_KEY) AS conversation_key,
    ACTIVITY_DATETIME AS call_at,
    ACTIVITY_DESCRIPTION,
    GONG_SPOTLIGHT_KEY_POINTS,
    GONG_SPOTLIGHT_NEXT_STEPS
  FROM PRESENTATION.BULLSEYE_PRO.SALES_ACTIVITY
  WHERE CRM_ACCOUNT_ID = '${accountId}'
    AND GONG_CONVERSATION_KEY IS NOT NULL
    AND ACTIVITY_DATETIME >= DATEADD(day, -180, CURRENT_TIMESTAMP())
  QUALIFY ROW_NUMBER() OVER (ORDER BY call_at DESC, conversation_key DESC) <= 3
)
SELECT TO_JSON(ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(
  'conversation_key', conversation_key,
  'spotlight_brief', COALESCE(
    NULLIF(TRIM(TO_VARCHAR(ACTIVITY_DESCRIPTION)), ''),
    NULLIF(TRIM(TO_VARCHAR(GONG_SPOTLIGHT_KEY_POINTS)), ''),
    NULLIF(TRIM(TO_VARCHAR(GONG_SPOTLIGHT_NEXT_STEPS)), '')
  ),
  'spotlight_key_points', TO_VARCHAR(GONG_SPOTLIGHT_KEY_POINTS),
  'spotlight_next_steps', TO_VARCHAR(GONG_SPOTLIGHT_NEXT_STEPS)
)) WITHIN GROUP (ORDER BY call_at DESC, conversation_key DESC)) AS recent_gong_spotlights_json
FROM recent_calls
`.trim();
}

export function isRenewalCta(item) {
  return Boolean(item && /^P[0-4]$/.test(item.priority || "") && RENEWAL_CTA.test(item.cta_title || ""));
}

export function renewalPreparationChoice(item, { explicitlyRequested = false } = {}) {
  if (!isRenewalCta(item)) return { applies: false, preparation_mode: "full_customer_plan" };
  if (explicitlyRequested) return { applies: true, preparation_mode: "renewal_conversation_brief", choice_required: false };
  return {
    applies: true,
    choice_required: true,
    options: [
      { mode: "renewal_conversation_brief", label: "Renewal Conversation Brief", description: "A focused three-slide renewal-call draft." },
      { mode: "full_customer_plan", label: "Full customer plan", description: "The existing in-depth Customer Planning and Meeting Prep path." },
    ],
  };
}

function customerSafeAccountContext(row) {
  if (!row) return null;
  const guideEligible = boolean(field(row, "GUIDE_ELIGIBLE"));
  const guideActivated = boolean(field(row, "GUIDE_ACTIVATED"));
  const guideAdopted = boolean(field(row, "GUIDE_ADOPTED"));
  const copilotPaidPenetrated = boolean(field(row, "COPILOT_PAID_PENETRATED"));
  const copilotPaidActivated = boolean(field(row, "COPILOT_PAID_ACTIVATED"));
  const copilotPaidAdopted = boolean(field(row, "COPILOT_PAID_ADOPTED"));
  const aiAgentsPaidPenetrated = boolean(field(row, "AI_AGENTS_PAID_PENETRATED"));
  const aiAgentsPaidActivated = boolean(field(row, "AI_AGENTS_PAID_ACTIVATED"));
  const aiAgentsPaidAdopted = boolean(field(row, "AI_AGENTS_PAID_ADOPTED"));
  const aiAgentsUnpaidPenetrated = boolean(field(row, "AI_AGENTS_UNPAID_PENETRATED"));
  const aiAgentsUnpaidActivated = boolean(field(row, "AI_AGENTS_UNPAID_ACTIVATED"));
  const aiAgentsUnpaidAdopted = boolean(field(row, "AI_AGENTS_UNPAID_ADOPTED"));
  const suiteEligible = boolean(field(row, "SUITE_ELIGIBLE"));
  const suiteActivated = boolean(field(row, "SUITE_ACTIVATED"));
  const suiteAdopted = boolean(field(row, "SUITE_ADOPTED"));
  const basicToolsAdopted = boolean(field(row, "BASIC_TOOLS_ADOPTED"));
  const subscriptions = parseCommercialSubscriptions(field(row, "COMMERCIAL_SUBSCRIPTIONS_JSON"));
  const guideExternalConnectorCount = number(field(row, "TECH_STACK_GUIDE_EXTERNAL_CONNECTOR_INSTANCE_COUNT"));
  const currentSubscriptions = subscriptions.filter((subscription) => subscriptionIsCurrent(subscription));
  const planNames = [...new Set(currentSubscriptions.map((subscription) => text(subscription.product_plan)).filter(Boolean))];
  const offerings = [...new Set(currentSubscriptions.flatMap((subscription) => [text(subscription.product_line), text(subscription.offering), text(subscription.offering_group)]).filter(Boolean))];
  const guideLifecycle = lifecycleState({
    available: guideEligible,
    activated: guideActivated,
    adopted: guideAdopted,
    availabilityLabel: "Available",
  });
  const copilotPaidLifecycle = lifecycleState({
    available: copilotPaidPenetrated,
    activated: copilotPaidActivated,
    adopted: copilotPaidAdopted,
    availabilityLabel: "Paid access confirmed",
  });
  const aiAgentsPaidLifecycle = lifecycleState({
    available: aiAgentsPaidPenetrated,
    activated: aiAgentsPaidActivated,
    adopted: aiAgentsPaidAdopted,
    availabilityLabel: "Paid access confirmed",
  });
  const aiAgentsUnpaidLifecycle = lifecycleState({
    available: aiAgentsUnpaidPenetrated,
    activated: aiAgentsUnpaidActivated,
    adopted: aiAgentsUnpaidAdopted,
    availabilityLabel: "Available",
  });
  const suiteLifecycle = lifecycleState({
    available: suiteEligible,
    activated: suiteActivated,
    adopted: suiteAdopted,
    availabilityLabel: "Available",
  });
  return {
    account_name: text(field(row, "ACCOUNT_NAME")),
    csm_account_context: {
      current_csm_name: text(field(row, "CSM_NAME")),
      account_health: text(field(row, "ACCOUNT_HEALTH")),
      cs_segment: text(field(row, "CS_SEGMENT")),
      market_segment: text(field(row, "MARKET_SEGMENT")),
      net_arr_usd: number(field(row, "NET_ARR_USD")),
      account_executive: text(field(row, "ACCOUNT_EXECUTIVE")),
      region: text(field(row, "ACCOUNT_REGION")),
      sub_region: text(field(row, "ACCOUNT_SUB_REGION")),
      renewal_date: field(row, "RENEWAL_DATE") || null,
      renewal_days_remaining: number(field(row, "RENEWAL_DAYS_REMAINING")),
      renewal_term: text(field(row, "RENEWAL_TERM")),
      renewal_manager: text(field(row, "RENEWAL_MANAGER")),
    },
    company_profile: {
      industry: field(row, "COMPANY_INDUSTRY"),
      type: field(row, "COMPANY_TYPE"),
      summary: text(field(row, "COMPANY_SUMMARY")),
      employee_count: number(field(row, "COMPANY_EMPLOYEE_COUNT")),
      hq_city: field(row, "COMPANY_HQ_CITY"),
      hq_state: field(row, "COMPANY_HQ_STATE"),
      hq_country: field(row, "COMPANY_HQ_COUNTRY"),
      website: field(row, "COMPANY_WEBSITE"),
    },
    product_context: {
      current_subscriptions: currentSubscriptionSummary(currentSubscriptions),
      guide_eligible: guideEligible,
      guide_activated: guideActivated,
      guide_adopted: guideAdopted,
      guide_lifecycle: guideLifecycle,
      copilot_paid_penetrated: copilotPaidPenetrated,
      copilot_paid_activated: copilotPaidActivated,
      copilot_paid_adopted: copilotPaidAdopted,
      copilot_paid_lifecycle: copilotPaidLifecycle,
      copilot_unpaid_penetrated: boolean(field(row, "COPILOT_UNPAID_PENETRATED")),
      copilot_unpaid_activated: boolean(field(row, "COPILOT_UNPAID_ACTIVATED")),
      copilot_unpaid_adopted: boolean(field(row, "COPILOT_UNPAID_ADOPTED")),
      ai_agents_paid_penetrated: aiAgentsPaidPenetrated,
      ai_agents_paid_activated: aiAgentsPaidActivated,
      ai_agents_paid_adopted: aiAgentsPaidAdopted,
      ai_agents_paid_lifecycle: aiAgentsPaidLifecycle,
      ai_agents_unpaid_penetrated: aiAgentsUnpaidPenetrated,
      ai_agents_unpaid_activated: aiAgentsUnpaidActivated,
      ai_agents_unpaid_adopted: aiAgentsUnpaidAdopted,
      ai_agents_unpaid_lifecycle: aiAgentsUnpaidLifecycle,
      suite_eligible: suiteEligible,
      suite_penetrated: boolean(field(row, "SUITE_PENETRATED")),
      suite_activated: suiteActivated,
      suite_adopted: suiteAdopted,
      suite_lifecycle: suiteLifecycle,
      basic_tools_adopted: basicToolsAdopted,
      basic_tools_lifecycle: observedAdoptionState(basicToolsAdopted),
      source_snapshot_dates: {
        guide: field(row, "GUIDE_SNAPSHOT_DATE"), copilot_paid: field(row, "COPILOT_SNAPSHOT_DATE"),
        copilot_unpaid: field(row, "COPILOT_SNAPSHOT_DATE"), ai_agents_paid: field(row, "AI_AGENTS_SNAPSHOT_DATE"),
        ai_agents_unpaid: field(row, "AI_AGENTS_SNAPSHOT_DATE"), zendesk_suite: field(row, "SUITE_SNAPSHOT_DATE"),
        basic_tools_and_rules: field(row, "BASIC_TOOLS_SNAPSHOT_DATE"),
      },
      verified_plan_names: planNames,
      verified_product_offerings: offerings,
      adoption_gaps: [
        ...(guideEligible === true && guideAdopted !== true ? [{ product: "Guide", current_state: guideLifecycle }] : []),
        ...(copilotPaidPenetrated === true && copilotPaidAdopted !== true ? [{ product: "Copilot paid add-on", current_state: copilotPaidLifecycle }] : []),
        ...(aiAgentsPaidPenetrated === true && aiAgentsPaidAdopted !== true ? [{ product: "AI Agents paid access", current_state: aiAgentsPaidLifecycle }] : []),
        ...(suiteEligible === true && suiteAdopted !== true ? [{ product: "Zendesk Suite", current_state: suiteLifecycle }] : []),
      ],
      capability_eligibility: capabilityEligibility({
        subscriptions: currentSubscriptions,
        guideEligible,
        guideActivated,
        guideExternalConnectorCount,
        copilotPaidPenetrated,
        aiAgentsPaidPenetrated,
      }),
    },
    team_setup: {
      active_agents: number(field(row, "TEAM_SETUP_ACTIVE_AGENT_COUNT")),
      instance_count: number(field(row, "TEAM_SETUP_INSTANCE_COUNT")),
      sla_active: boolean(field(row, "TEAM_SETUP_SLA_ACTIVE")),
      ...(historicalSlaPolicyEvidence(row) ? { historical_sla_policies: historicalSlaPolicyEvidence(row) } : {}),
      custom_role_instance_count: number(field(row, "TEAM_SETUP_CUSTOM_ROLE_INSTANCE_COUNT")),
      basic_rule_types_adopted: number(field(row, "TEAM_SETUP_BASIC_RULE_TYPES_ADOPTED_MAX")),
      configuration_snapshot_dates: {
        security: sourceSnapshotDateRange(row, "TEAM_SETUP_SECURITY"),
        basic_tools: sourceSnapshotDateRange(row, "TEAM_SETUP_BASIC_TOOLS"),
        guide_connectors: sourceSnapshotDateRange(row, "TECH_STACK_GUIDE_CONNECTOR"),
      },
    },
    tech_stack: {
      sso_enabled_instance_count: number(field(row, "TECH_STACK_SSO_ENABLED_INSTANCE_COUNT")),
      guide_external_connector_instance_count: guideExternalConnectorCount,
      marketplace_app_names: parseStringArray(field(row, "TECH_STACK_MARKETPLACE_APP_NAMES")),
      active_webhook_count: number(field(row, "TECH_STACK_MAX_ACTIVE_WEBHOOK_COUNT")),
      webhook_active_usage_instance_count: number(field(row, "TECH_STACK_WEBHOOK_ACTIVE_USAGE_INSTANCE_COUNT")),
      api_active_usage_instance_count: number(field(row, "TECH_STACK_API_ACTIVE_USAGE_INSTANCE_COUNT")),
      max_api_ticket_percent: number(field(row, "TECH_STACK_MAX_API_TICKET_PERCENT")),
      private_app_count: number(field(row, "TECH_STACK_MAX_PRIVATE_APP_COUNT")),
    },
  };
}

function omitUnavailable(value) {
  if (Array.isArray(value)) return value.map(omitUnavailable).filter((item) => item != null);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, omitUnavailable(item)])
      .filter(([, item]) => item != null && (!Array.isArray(item) || item.length > 0) && (typeof item !== "object" || Array.isArray(item) || Object.keys(item).length > 0)));
  }
  return value == null ? null : value;
}

function selectedCtaBrief(selectedCta) {
  if (!selectedCta) return null;
  return {
    priority: selectedCta.priority || null,
    title: selectedCta.title || null,
    status: selectedCta.status || null,
    created_at: selectedCta.created_at || null,
    action_deadline: selectedCta.action_deadline || null,
    urgency: selectedCta.urgency || null,
    monitor_link: selectedCta.monitor_link || null,
    monitor_link_state: selectedCta.monitor_link ? "checked" : "no_data",
    monitor_link_note: selectedCta.monitor_link
      ? "The selected CTA includes its native monitor link."
      : "The selected CTA source returned no monitor link.",
  };
}

function relatedAccountCtaContext(rows, sourceState) {
  const related = Array.isArray(rows) ? rows : [];
  const visibleItems = related.slice(0, MAX_RELATED_ACCOUNT_CTAS).map((row) => ({
    title: text(field(row, "CTA_TITLE")),
    status: text(field(row, "CTA_STATUS")),
    created_at: field(row, "CREATED_AT"),
    due_at: field(row, "DUE_AT"),
  }));
  return {
    state: sourceState,
    items: visibleItems,
    source_limit_reached: related.length > MAX_RELATED_ACCOUNT_CTAS,
    note: sourceState === "checked"
      ? (related.length > MAX_RELATED_ACCOUNT_CTAS
        ? `The first ${MAX_RELATED_ACCOUNT_CTAS} open CTAs are shown. Additional open CTAs exist for this account.`
        : related.length ? "Open CTAs for the selected account from Gainsight." : "No open CTAs were returned for this account by this read.")
      : "Related account CTAs were not available in this run.",
  };
}

function ticketChannelsContext(row, sourceState) {
  if (sourceState !== "checked") {
    return {
      state: sourceState,
      period: null,
      items: [],
      note: "Ticket-channel data was not available in this run.",
    };
  }
  const period = field(row, "TICKET_CHANNELS_MONTH");
  const items = parseObjectArray(field(row, "TICKET_CHANNELS_JSON"))
    .map((item) => omitUnavailable({
      channel: text(item.channel) || "Unknown",
      tickets_created: number(item.tickets_created),
      ticket_share: number(item.ticket_share),
    }));
  return {
    state: period && items.length ? "checked" : "no_data",
    period,
    items,
    note: TICKET_CHANNEL_SCOPE_NOTE,
  };
}

function accountConversationDigest(row, sourceState) {
  if (sourceState !== "checked") {
    return {
      state: sourceState,
      note: "The account-level Gong metadata digest was not available in this run. It was not used to create any recommendation.",
      recent_calls: [],
    };
  }
  const count = number(field(row, "RELIABLY_MATCHED_CALL_COUNT")) || 0;
  const calls = parseObjectArray(field(row, "RECENT_CALLS_JSON"));
  if (count === 0) {
    return {
      state: "checked",
      reliably_matched_call_count: 0,
      latest_reliably_matched_call_at: null,
      recent_calls: [],
      note: "No reliably matched calls were found in the bounded 180-day metadata read. This does not establish that no meeting occurred.",
    };
  }
  return {
    state: "checked",
    reliably_matched_call_count: count,
    latest_reliably_matched_call_at: field(row, "LATEST_RELIABLY_MATCHED_CALL_AT"),
    recent_calls: calls.map((call) => ({
      call_at: call.call_at || null,
      title: text(call.title),
      gong_summary: text(call.spotlight_brief),
      key_points: call.spotlight_key_points ?? null,
      next_steps: call.spotlight_next_steps ?? null,
      match_strength: text(call.match_strength),
    })),
    note: "Gong-provided summaries are navigation context only. They are not evidence for a customer need, recommendation, action, or commitment.",
  };
}

function mergeGongMetadataAndSpotlight(metadata, spotlight) {
  if (metadata.state !== "checked" || !metadata.rows?.[0]) return metadata;
  const metadataRow = metadata.rows[0];
  const spotlightRow = spotlight.state === "checked" ? spotlight.rows?.[0] : null;
  const spotlights = new Map(parseObjectArray(field(spotlightRow, "RECENT_GONG_SPOTLIGHTS_JSON"))
    .filter((item) => item?.conversation_key)
    .map((item) => [String(item.conversation_key), item]));
  const calls = parseObjectArray(field(metadataRow, "RECENT_CALLS_JSON")).map((call) => {
    const detail = spotlights.get(String(call.conversation_key));
    return omitUnavailable({
      ...call,
      spotlight_brief: detail?.spotlight_brief || null,
      spotlight_key_points: detail?.spotlight_key_points || null,
      spotlight_next_steps: detail?.spotlight_next_steps || null,
    });
  });
  return {
    ...metadata,
    rows: [{ ...metadataRow, RECENT_CALLS_JSON: JSON.stringify(calls) }],
  };
}

function goalsAndTimelineContext() {
  return {
    state: "requires_selected_call",
    note: "Goals, timeline, and customer-confirmed priorities require an explicitly selected and authorized call or reviewed CSM notes. They are not inferred from Gong metadata.",
  };
}

function accountCoreState(accountContext) {
  const parts = [
    accountContext.company_profile,
    accountContext.commercial_subscriptions,
    accountContext.guide_adoption,
    accountContext.copilot_adoption,
    accountContext.ai_agents_adoption,
    accountContext.suite_adoption,
    accountContext.basic_tools_adoption,
  ];
  if (accountContext.company_profile.state !== "checked") return accountContext.company_profile.state;
  return parts.every((part) => part.state === "checked") ? "checked" : "partially_checked";
}

function observedProductUsageCoverageState(accountContext) {
  const adoptionSources = [
    accountContext.guide_adoption,
    accountContext.copilot_adoption,
    accountContext.ai_agents_adoption,
    accountContext.suite_adoption,
    accountContext.basic_tools_adoption,
  ];
  // Even when every named snapshot is available, observed use is deliberately
  // only a subset of the commercial footprint, so its coverage remains partial.
  if (adoptionSources.some((source) => source.state === "checked")) return "partially_checked";
  return adoptionSources.find((source) => source.state && source.state !== "no_data")?.state || "not_assessed";
}

function fullBriefSourceStates({
  accountContext,
  rbaMetrics,
  guideKnowledgeViews,
  ticketChannels = { state: "not_assessed" },
  gongDigest,
  gongSpotlight = { state: "not_assessed" },
  relatedCtas = { state: "not_assessed" },
  selectedCta = null,
}) {
  const selectedCtaMonitorState = selectedCta?.monitor_link ? "checked" : "no_data";
  const renewalTiming = accountContext.renewal_timing;
  const renewalDate = field(renewalTiming.rows?.[0], "RENEWAL_DATE");
  const renewalTerm = field(renewalTiming.rows?.[0], "RENEWAL_TERM");
  const subscriptions = parseCommercialSubscriptions(accountContext.commercial_subscriptions.rows?.[0]?.COMMERCIAL_SUBSCRIPTIONS_JSON
    ?? accountContext.commercial_subscriptions.rows?.[0]?.commercial_subscriptions_json);
  const currentTermEnd = earliestCurrentTermEnd(subscriptions.filter((subscription) => subscriptionIsCurrent(subscription)));
  const renewalTimingState = renewalDate || renewalTerm
    ? sourceValueState(renewalTiming, renewalDate || renewalTerm)
    : sourceValueState(accountContext.commercial_subscriptions, currentTermEnd);
  return {
    csm_account_context: accountContext.gainsight.state,
    company_profile_products_adoption: accountCoreState(accountContext),
    company_profile: accountContext.company_profile.state,
    account_executive: sourceValueState(renewalTiming, field(renewalTiming.rows?.[0], "ACCOUNT_EXECUTIVE")),
    commercial_subscriptions: accountContext.commercial_subscriptions.state,
    guide_adoption: accountContext.guide_adoption.state,
    copilot_adoption: accountContext.copilot_adoption.state,
    ai_agents_adoption: accountContext.ai_agents_adoption.state,
    suite_adoption: accountContext.suite_adoption.state,
    basic_tools_adoption: accountContext.basic_tools_adoption.state,
    team_setup_and_tech_stack: accountContext.team_and_tech.state,
    historical_sla_policies: accountContext.historical_sla_policies?.state || "not_assessed",
    support_operations_monthly_rba_trends: rbaMetrics.state,
    guide_knowledge_view_trends: guideKnowledgeViews.state,
    ticket_channels: ticketChannels.state,
    selected_cta: selectedCta ? "checked" : "not_applicable",
    related_account_ctas: relatedCtas.state,
    cta_monitor_link: selectedCta ? selectedCtaMonitorState : "not_applicable",
    account_region: sourceValueState(renewalTiming, field(renewalTiming.rows?.[0], "ACCOUNT_REGION")),
    // A standalone zero in CRM_DAYS_TO_RENEWAL is not a renewal date. Do not
    // turn a default-like value into a false "due now" signal.
    renewal_timing: renewalTimingState,
    account_arr_band: sourceValueState(accountContext.commercial_subscriptions, subscriptions.map((subscription) => subscription.arr_band).filter(Boolean)),
    subscription_seats: sourceValueState(accountContext.commercial_subscriptions, subscriptions.map((subscription) => subscription.seats).filter((value) => value != null)),
    observed_product_usage_coverage: observedProductUsageCoverageState(accountContext),
    account_gong_metadata: gongDigest.state,
    account_gong_spotlight: gongDigest.state === "checked" ? gongSpotlight.state : gongDigest.state,
    goals_and_timeline: "requires_selected_call",
  };
}

function section(state, facts, note = null) {
  return { state, facts, note };
}

/**
 * The account brief is shared account truth, not a renewal-only substitute.
 * This projection makes the required sections and every currently unavailable
 * field explicit. Full planning later adds selected-call evidence; it does not
 * replace this object with a second account brief.
 */
function buildAccountIntelligenceCore({
  account,
  selectedCta,
  metricRows,
  peerEvidence = { state: "not_assessed", operating_snapshot: [], comparisons: [], note: "Snapshot and peer comparison were not read." },
  ticketChannels = { state: "not_assessed", period: null, items: [], note: null },
  conversationDigest,
  relatedCtaRows = [],
  fullBriefSources,
  now = new Date(),
}) {
  const sources = {
    ...(fullBriefSources || {}),
    related_account_ctas: fullBriefSources?.related_account_ctas || "not_assessed",
    observed_product_usage_coverage: fullBriefSources?.observed_product_usage_coverage
      || (["checked", "partially_checked"].includes(fullBriefSources?.company_profile_products_adoption)
        ? "partially_checked"
        : "not_assessed"),
  };
  const accountContextState = sources.csm_account_context || "not_assessed";
  const coreState = sources.company_profile_products_adoption || "not_assessed";
  const companyProfileState = sources.company_profile || coreState;
  const commercialState = sources.commercial_subscriptions || coreState;
  const productState = [
    sources.guide_adoption,
    sources.copilot_adoption,
    sources.ai_agents_adoption,
    sources.suite_adoption,
    sources.basic_tools_adoption,
  ].every((state) => state === "checked") ? "checked" : coreState;
  const teamAndTechState = sources.team_setup_and_tech_stack || "not_assessed";
  const rbaState = sources.support_operations_monthly_rba_trends || "not_assessed";
  const guideViewsState = sources.guide_knowledge_view_trends || "not_assessed";
  const ticketChannelsState = sources.ticket_channels || "not_assessed";
  const subscriptions = account?.product_context?.current_subscriptions || [];
  const currentTermEnd = earliestCurrentTermEnd(subscriptions);
  const renewalTiming = resolvedRenewalTiming({ account, sourceStates: sources, now });
  const arrBands = [...new Set(subscriptions.map((subscription) => subscription.arr_band).filter(Boolean))];
  const subscriptionSeats = subscriptions
    .filter((subscription) => subscription.seats != null)
    .map((subscription) => ({
      plan: subscription.plan || null,
      offering: subscription.offering || null,
      seats: subscription.seats,
    }));
  const seatAllocation = calculatedSeatAllocation({
    subscriptions,
    activeAgentCount: account?.team_setup?.active_agents ?? null,
    commercialState,
    teamState: teamAndTechState,
  });
  const supportState = rbaState !== "checked"
    ? rbaState
    : (guideViewsState === "checked" || guideViewsState === "no_data") && ticketChannelsState === "checked"
      ? "checked"
      : "partially_checked";
  const sourceGaps = Object.entries(sources)
    .filter(([key, state]) => !["checked", "not_applicable"].includes(state) && key !== "goals_and_timeline")
    .map(([key, state]) => `${key}:${state}`);

  const brief = {
    schema_version: ACCOUNT_INTELLIGENCE_CORE_VERSION,
    contract: ACCOUNT_INTELLIGENCE_CORE_CONTRACT,
    // Product ownership is complete for the returned commercial subscriptions.
    // Observed use remains deliberately limited to named product snapshots.
    brief_state: "needs_evidence",
    account: {
      display_name: account?.account_name || null,
      identity_state: account ? "authoritative" : "missing",
    },
    sections: {
      account_header: section(accountContextState, {
        csm: account?.csm_account_context?.current_csm_name || null,
        net_arr_usd: account?.csm_account_context?.net_arr_usd ?? null,
        health: account?.csm_account_context?.account_health || null,
        cs_segment: account?.csm_account_context?.cs_segment || null,
        market_segment: account?.csm_account_context?.market_segment || null,
        region: { state: sources.account_region || "not_assessed", value: account?.csm_account_context?.region || null },
        sub_region: { state: sources.account_region || "not_assessed", value: account?.csm_account_context?.sub_region || null },
        account_executive: { state: sources.account_executive || "not_assessed", value: account?.csm_account_context?.account_executive || null },
        arr_band: { state: sources.account_arr_band || "not_assessed", value: arrBands.length === 1 ? arrBands[0] : arrBands },
        renewal_date: { state: renewalTiming.state, value: renewalTiming.date },
        renewal_date_basis: { state: renewalTiming.state, value: renewalTiming.basis },
        renewal_days_remaining: {
          state: renewalTiming.state,
          value: renewalTiming.days_remaining,
        },
        renewal_term: { state: sources.renewal_timing || "not_assessed", value: account?.csm_account_context?.renewal_term || null },
        renewal_manager: { state: sources.renewal_timing || "not_assessed", value: account?.csm_account_context?.renewal_manager || null },
        current_subscription_term_end: {
          state: currentTermEnd ? "checked" : "no_data",
          value: currentTermEnd,
          note: "Current subscription term context. The contract renewal date is shown separately when the approved renewal source returns it.",
        },
      }, null),
      cta_context: section(selectedCta ? sources.selected_cta : sources.related_account_ctas, {
        selected_cta: selectedCtaBrief(selectedCta),
        related_account_ctas: relatedAccountCtaContext(relatedCtaRows, sources.related_account_ctas),
        monitor_link: {
          state: sources.cta_monitor_link || "not_assessed",
          value: selectedCta?.monitor_link || null,
        },
      }, null),
      company_profile: section(companyProfileState, account?.company_profile || {}, null),
      commercial_footprint: section(commercialState, {
        subscriptions,
        seats: {
          state: sources.subscription_seats || "not_assessed",
          value: subscriptionSeats,
          note: "Contracted seats are shown for each returned current subscription; they are not inferred from active-agent usage.",
        },
        current_term_summary: subscriptions.map((subscription) => ({
          plan: subscription.plan || null,
          status: subscription.status || null,
          term_end: subscription.term_end || null,
        })),
      }, null),
      product_footprint: section(productState, {
        owned: subscriptions,
        observed_use: {
          guide: account?.product_context?.guide_lifecycle || null,
          copilot_paid: account?.product_context?.copilot_paid_lifecycle || null,
          copilot_unpaid: account?.product_context?.copilot_unpaid_adopted == null
            ? null
            : lifecycleState({
              available: account.product_context.copilot_unpaid_penetrated,
              activated: account.product_context.copilot_unpaid_activated,
              adopted: account.product_context.copilot_unpaid_adopted,
              availabilityLabel: "Available",
            }),
          ai_agents_paid: account?.product_context?.ai_agents_paid_lifecycle || null,
          ai_agents_unpaid: account?.product_context?.ai_agents_unpaid_lifecycle || null,
          zendesk_suite: account?.product_context?.suite_lifecycle || null,
          basic_tools_and_rules: account?.product_context?.basic_tools_lifecycle || null,
        },
        observed_use_ladders: {
          guide: { eligible: account?.product_context?.guide_eligible ?? null, activated: account?.product_context?.guide_activated ?? null, adopted: account?.product_context?.guide_adopted ?? null },
          copilot_paid: { paid_product_state: account?.product_context?.copilot_paid_penetrated ?? null, activated: account?.product_context?.copilot_paid_activated ?? null, adopted: account?.product_context?.copilot_paid_adopted ?? null },
          copilot_unpaid: { available_product_state: account?.product_context?.copilot_unpaid_penetrated ?? null, activated: account?.product_context?.copilot_unpaid_activated ?? null, adopted: account?.product_context?.copilot_unpaid_adopted ?? null },
          ai_agents_paid: { paid_product_state: account?.product_context?.ai_agents_paid_penetrated ?? null, activated: account?.product_context?.ai_agents_paid_activated ?? null, adopted: account?.product_context?.ai_agents_paid_adopted ?? null },
          ai_agents_unpaid: { available_product_state: account?.product_context?.ai_agents_unpaid_penetrated ?? null, activated: account?.product_context?.ai_agents_unpaid_activated ?? null, adopted: account?.product_context?.ai_agents_unpaid_adopted ?? null },
          zendesk_suite: { eligible: account?.product_context?.suite_eligible ?? null, present_in_usage_footprint: account?.product_context?.suite_penetrated ?? null, activated: account?.product_context?.suite_activated ?? null, adopted: account?.product_context?.suite_adopted ?? null },
          basic_tools_and_rules: { adopted: account?.product_context?.basic_tools_adopted ?? null },
        },
        source_snapshot_dates: account?.product_context?.source_snapshot_dates || {},
        observed_product_usage_coverage: {
          state: sources.observed_product_usage_coverage,
          note: "Observed use is measured for Guide, Copilot, AI Agents, Zendesk Suite, and Basic Tools and Rules. Other owned products remain ownership-only until a product-specific usage source is added.",
        },
        verified_capability_eligibility: account?.product_context?.capability_eligibility || {},
      }, "Commercial subscriptions establish what the customer owns. Observed use is shown only for the named product snapshots. Paid/unpaid ladder flags are product-state signals, not commercial-entitlement proof."),
      adoption_gaps: section(productState, { items: account?.product_context?.adoption_gaps || [] }, null),
      team_and_setup: section(teamAndTechState, {
        ...(account?.team_setup || {}),
        seat_allocation: seatAllocation,
      }, seatAllocation.note),
      tech_stack: section(teamAndTechState, account?.tech_stack || {}, "These are observed published-snapshot signals, not a complete configuration export."),
      support_operations: section(supportState, {
        metric_table: metricRows,
        ticket_channels: ticketChannels,
        peer_benchmarks: peerEvidence,
      }, "Monthly RBA trends use human-support tickets. Knowledge views are Guide-content engagement, not proof that content prevented a ticket. Neither measure proves a product caused the result."),
      recent_conversations: section(sources.account_gong_metadata || "not_assessed", conversationDigest || {}, "Metadata-only navigation context. It never establishes customer needs, goals, or commitments."),
    },
    source_states: sources,
    source_gaps: sourceGaps,
    call_specific_context: {
      state: "requires_selected_call",
      fields: ["goals", "timeline", "pain_points", "workarounds", "stakeholders", "priorities", "commitments"],
      note: "A selected and authorized call or reviewed CSM notes is required before these are treated as customer facts.",
    },
  };
  const completeness = assessAccountIntelligenceCompleteness(brief);
  brief.brief_state = completeness.state;
  brief.source_gaps = completeness.gaps;
  return brief;
}

function displayEvidenceValue(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map(displayEvidenceValue).join("; ") : "—";
  return displayBriefDateTime(value) || String(value);
}

/**
 * Source timestamps are kept verbatim in the evidence object. The CSM view
 * needs the useful precision only: minute plus an explicit UTC marker when
 * one was supplied. This avoids both a false sense of precision and an
 * implicit timezone conversion in the host.
 */
function displayBriefDateTime(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const [, date, hour, minute, timezone] = match;
  return `${date} ${hour}:${minute}${timezone === "Z" ? " UTC" : timezone ? ` ${timezone}` : ""}`;
}

function displayWholeNumber(value) {
  const numericValue = number(value);
  return numericValue == null
    ? displayEvidenceValue(value)
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(numericValue);
}

function displayTicketShare(value) {
  const numericValue = number(value);
  return numericValue == null
    ? displayEvidenceValue(value)
    : `${(numericValue * 100).toFixed(1)}%`;
}

function displayCommercialProduct(product) {
  const plan = typeof product?.plan === "string" && !/^n\/?a$/i.test(product.plan.trim())
    ? product.plan
    : null;
  return displayEvidenceValue(plan || product?.offering);
}

function commercialProductContext(product) {
  if (typeof product?.plan === "string" && /^n\/?a$/i.test(product.plan.trim())) {
    return "Plan not recorded. The offering is a commercial source label; no product-catalog description is connected.";
  }
  return "—";
}

function adoptionStatus(value) {
  const state = displayEvidenceValue(value);
  if (state === "—" || state === "Not established") return state;
  return state === "Adopted" ? "Adopted" : `Not adopted — ${state}`;
}

function sharedMetricPeriodLabel(metricRows, key, fallback) {
  const labels = [...new Set((metricRows || [])
    .map((metric) => displayMetricPeriod(metric?.[key]))
    .filter(Boolean))];
  return labels.length === 1 ? labels[0] : fallback;
}

function displayMetricPeriod(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(\d{4})-(\d{2})(?!\d)/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

export function renewalCtaDeadlineStatus(selectedCta, now = new Date()) {
  const deadline = selectedCta?.action_deadline ? new Date(selectedCta.action_deadline) : null;
  if (!deadline || Number.isNaN(deadline.valueOf()) || Number.isNaN(now.valueOf())) return "Not established";
  // Starting work does not move its action deadline. Match the queue's <=
  // boundary; the separate CTA due date never determines this label.
  return deadline <= now ? "Overdue" : "Not overdue";
}

function valueAndState(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && "state" in value) {
    return { value: displayEvidenceValue(value.value), state: value.state };
  }
  return { value: displayEvidenceValue(value), state: "checked" };
}

function sectionFactRows(section, labels) {
  return labels.map(([key, label]) => {
    const item = valueAndState(section?.facts?.[key]);
    const sourceState = section?.state || "not_assessed";
    const state = item.state === "checked" && item.value === "—"
      ? (sourceState === "checked" ? "no_data" : sourceState)
      : item.state === "checked" ? sourceState : item.state;
    return { field: label, value: item.value, state };
  });
}

function sourceGapDetail(source) {
  if (source === "observed_product_usage_coverage") {
    return "Checked: adoption snapshots for Guide, Copilot, AI Agents, Zendesk Suite, and Basic Tools and Rules. Not measured: observed use of commercial offerings outside those snapshots.";
  }
  if (source === "ticket_channels") {
    return "The QBR ticket-via channel aggregation did not return in this run.";
  }
  return "—";
}

/**
 * This is the sole CSM display contract for renewal evidence. It keeps the
 * internal core structured for downstream work while giving the host only
 * grouped tables to show to a CSM. No data-bearing prose summary is emitted.
 */
export function buildRenewalCsmEvidenceTables({ accountIntelligence, metricTable }) {
  const sections = accountIntelligence?.sections || {};
  const selectedCta = sections.cta_context?.facts?.selected_cta || {};
  const relatedCtas = sections.cta_context?.facts?.related_account_ctas?.items || [];
  const subscriptions = sections.commercial_footprint?.facts?.subscriptions || [];
  const ownedProducts = sections.product_footprint?.facts?.owned || [];
  const observedUse = sections.product_footprint?.facts?.observed_use || {};
  const adoptionGaps = sections.adoption_gaps?.facts?.items || [];
  const ticketChannels = sections.support_operations?.facts?.ticket_channels || {};
  const recentCalls = sections.recent_conversations?.facts?.recent_calls || [];
  const deadlineStatus = renewalCtaDeadlineStatus(selectedCta);
  const currentMetricPeriod = sharedMetricPeriodLabel(metricTable?.rows, "period", "Current period");
  const yearAgoMetricPeriod = sharedMetricPeriodLabel(metricTable?.rows, "year_ago_period", "Prior-year period");
  const sourceGaps = Object.entries(accountIntelligence?.source_states || {})
    .filter(([source, state]) => state !== "checked" && source !== "goals_and_timeline")
    .map(([source, state]) => ({
      source: source.replaceAll("_", " "),
      state,
      details: sourceGapDetail(source),
    }));

  return [
    {
      id: "account_and_renewal",
      title: "Account and renewal",
      columns: ["Field", "Value", "State"],
      rows: sectionFactRows(sections.account_header, [
        ["csm", "CSM"], ["net_arr_usd", "Net ARR (USD)"], ["health", "Health"],
        ["cs_segment", "CS segment"], ["market_segment", "Market segment"],
        ["region", "Region"], ["sub_region", "CRM sub-region"], ["account_executive", "Account Executive"], ["arr_band", "ARR band"],
        ["renewal_date", "Renewal date"], ["renewal_date_basis", "Renewal date basis"], ["renewal_days_remaining", "Days to renewal"],
        ["renewal_term", "CRM renewal term"], ["renewal_manager", "Renewal manager"], ["current_subscription_term_end", "Current subscription term end"],
      ]).map((row) => row.field === "Net ARR (USD)" && row.value !== "—"
        ? { ...row, value: displayWholeNumber(row.value) }
        : row),
    },
    {
      id: "cta_context",
      title: "CTA context",
      columns: ["Field", "Value", "State"],
      rows: [
        ["priority", "Priority"], ["title", "CTA"], ["status", "Status"], ["created_at", "Created"],
        ["action_deadline", "Action deadline"], ["monitor_link", "Monitor link"],
      ].map(([key, label]) => ({
        field: label,
        value: displayEvidenceValue(selectedCta[key]),
        state: key === "monitor_link" ? selectedCta.monitor_link_state || "no_data" : "checked",
      })).concat([{
        field: "Deadline status",
        value: deadlineStatus,
        state: "checked",
      }]),
    },
    {
      id: "related_ctas",
      title: "Related open CTAs",
      columns: ["CTA", "Status", "Created", "Due"],
      rows: relatedCtas.map((cta) => ({
        cta: displayEvidenceValue(cta.title), status: displayEvidenceValue(cta.status),
        created: displayEvidenceValue(cta.created_at), due: displayEvidenceValue(cta.due_at),
      })),
    },
    {
      id: "company_profile",
      title: "Company profile",
      columns: ["Field", "Value", "State"],
      rows: sectionFactRows(sections.company_profile, [
        ["summary", "Company summary"], ["industry", "Industry"], ["employee_count", "Employees"],
        ["hq_city", "Headquarters city"], ["hq_state", "Headquarters state"],
        ["hq_country", "Headquarters country"], ["website", "CRM website"],
      ]),
      footnote: "Company summary is the raw Salesforce Account.Description value; CRM website is the raw Salesforce Account.Website value. Neither is verified against the public web.",
    },
    {
      id: "commercial_footprint",
      title: "Commercial footprint",
      columns: ["Plan", "Product line", "Offering", "Product context", "Status", "Seats", "ARR band", "Term end"],
      rows: subscriptions.map((subscription) => ({
        plan: displayEvidenceValue(subscription.plan), product_line: displayEvidenceValue(subscription.product_line),
        offering: displayEvidenceValue(subscription.offering), product_context: commercialProductContext(subscription),
        status: displayEvidenceValue(subscription.status), seats: displayWholeNumber(subscription.seats), arr_band: displayEvidenceValue(subscription.arr_band),
        term_end: displayEvidenceValue(subscription.term_end),
      })),
    },
    {
      id: "product_and_adoption",
      title: "Product and adoption",
      columns: ["Product", "Evidence", "Adoption status", "State"],
      footnote: "“Adopted” is the state reported by the product's approved adoption snapshot. Coverage: Guide, Copilot, AI Agents, Zendesk Suite, and Basic Tools and Rules.",
      rows: [
        ...ownedProducts.map((product) => ({
          product: displayCommercialProduct(product),
          observed_state: "Commercial ownership", adoption_gap: "Not measured for this offering", state: "checked",
        })),
        ...Object.entries(observedUse).map(([product, state]) => ({
          product: product.replaceAll("_", " "), observed_state: "Approved product-adoption snapshot", adoption_gap: adoptionStatus(state), state: "checked",
        })),
        ...adoptionGaps.map((gap) => ({
          product: displayEvidenceValue(gap.product), observed_state: "Adoption-gap source", adoption_gap: adoptionStatus(gap.current_state), state: "checked",
        })),
      ],
    },
    {
      id: "team_and_tech",
      title: "Team, setup, and tech stack",
      columns: ["Field", "Value", "State"],
      rows: [
        ...sectionFactRows(sections.team_and_setup, [
          ["seat_allocation", "Seat allocation"], ["instance_count", "Instances"], ["sla_active", "SLA active"],
          ["custom_role_instance_count", "Instances with custom roles"], ["basic_rule_types_adopted", "Basic rule types adopted"],
        ]),
        ...sectionFactRows(sections.tech_stack, [
          ["sso_enabled_instance_count", "Instances with SSO"], ["guide_external_connector_instance_count", "Guide external connectors"],
          ["marketplace_app_names", "Marketplace apps"], ["active_webhook_count", "Active webhooks"],
          ["webhook_active_usage_instance_count", "Webhook active-use instances"], ["api_active_usage_instance_count", "API active-use instances"],
          ["max_api_ticket_percent", "Highest API ticket share"], ["private_app_count", "Private apps"],
        ]),
      ],
      footnote: sections.team_and_setup?.note || undefined,
    },
    {
      id: "performance_trends",
      title: "Performance trends",
      columns: ["Metric", currentMetricPeriod, yearAgoMetricPeriod, "Change", "Definition", "Source", "State"],
      rows: (metricTable?.rows || []).map((metric) => ({
        metric: metric.metric, current: decimal(metric.current_value, metric.unit),
        same_month_last_year: decimal(metric.year_ago_value, metric.unit),
        change: metricDisplayChange(metric),
        definition: displayEvidenceValue(metric.definition), source: displayEvidenceValue(metric.source), state: metric.evidence_state,
      })),
    },
    {
      id: "tickets_by_channel",
      title: "Tickets created by channel",
      columns: [displayMetricPeriod(ticketChannels.period) || "Latest complete month", "Share of tickets", "State"],
      rows: ticketChannels.items?.length
        ? ticketChannels.items.map((item) => ({
          channel: displayEvidenceValue(item.channel),
          ticket_share: displayTicketShare(item.ticket_share),
          state: "checked",
        }))
        : [{ channel: "—", ticket_share: "—", state: ticketChannels.state || "not_assessed" }],
      footnote: ticketChannels.note || TICKET_CHANNEL_SCOPE_NOTE,
    },
    {
      id: "recent_conversations",
      title: "Recent conversations",
      columns: ["Date", "Call", "Gong summary", "Key points", "Next steps", "Match"],
      rows: recentCalls.map((call) => ({
        date: displayEvidenceValue(call.call_at), call: displayEvidenceValue(call.title),
        gong_summary: displayEvidenceValue(call.gong_summary), key_points: displayEvidenceValue(call.key_points),
        next_steps: displayEvidenceValue(call.next_steps), match: displayEvidenceValue(call.match_strength),
      })),
    },
    {
      id: "source_gaps",
      title: "Source gaps and call-specific context",
      columns: ["Field", "State", "Coverage or reason"],
      rows: [
        ...sourceGaps.map((gap) => ({ field: gap.source, state: gap.state, details: gap.details })),
        {
          field: "Goals, timeline, pain points, stakeholders, priorities, and commitments",
          state: accountIntelligence?.call_specific_context?.state || "requires_selected_call",
          details: accountIntelligence?.call_specific_context?.note || "—",
        },
      ],
    },
  ];
}

function metricDisplayChange(metric) {
  if (metric?.evidence_state !== "measured" || metric?.comparison_state !== "comparable") return "—";
  const value = number(metric.unit === "percent" ? metric.percentage_point_change : metric.year_over_year_change_pct);
  if (value == null) return "—";
  const signed = `${value >= 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}`;
  return metric.unit === "percent" ? `${signed} pp` : `${signed}%`;
}

function decimal(value, unit) {
  if (value == null) return "—";
  if (unit === "percent") return `${Number(value).toFixed(1)}%`;
  if (unit === "hours") return `${Number(value).toFixed(1)} hours`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function comparisonText(metric) {
  return `${decimal(metric.current_value, metric.unit)} now, compared with ${decimal(metric.year_ago_value, metric.unit)} a year earlier`;
}

function metricId(metric) {
  return `metric:${String(metric.metric || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function percentageChangeText(metric) {
  if (metric.unit === "percent") {
    const change = number(metric.percentage_point_change ?? metric.year_over_year_change);
    if (change == null) return null;
    return `${change >= 0 ? "+" : ""}${change.toFixed(1)} percentage points`;
  }
  const change = number(metric.year_over_year_change_pct);
  if (change == null) return null;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function exactComparisonText(metric) {
  const change = percentageChangeText(metric);
  return `${decimal(metric.current_value, metric.unit)} now vs ${decimal(metric.year_ago_value, metric.unit)} a year earlier${change ? ` (${change})` : ""}`;
}

function direction(metric) {
  const expected = POSITIVE_DIRECTION.get(metric.metric);
  if (!expected || metric.comparison_state !== "comparable" || metric.year_over_year_change == null) return null;
  if (metric.year_over_year_change === 0) return "flat";
  const improved = (expected === "higher" && metric.year_over_year_change > 0)
    || (expected === "lower" && metric.year_over_year_change < 0);
  return improved ? "improved" : "needs_attention";
}

const METRIC_LANGUAGE = Object.freeze({
  "CSAT score": {
    improved: { headline: "Customer feedback improved", why: "Better feedback gives you a stronger starting point for improving the journeys customers value most." },
    needs_attention: { headline: "Protect the customer experience as feedback changes", opportunity: "Improving the journeys behind lower feedback can make support clearer and more dependable for customers.", question: "Which customer journeys or request types are most affecting feedback today?" },
  },
  "Median first reply time": {
    improved: { headline: "Customers received a first reply sooner", why: "A faster first response reduces the time customers wait before they know help is underway." },
    needs_attention: { headline: "Help customers receive a first reply sooner", opportunity: "Shorter first waits give customers an earlier update and help the team clarify requests sooner.", question: "Which request types wait longest for a first reply, and what gets in their way?" },
  },
  "Median resolution time": {
    improved: { headline: "Customers reached a resolution sooner", why: "A shorter path to resolution gives customers answers sooner and less time waiting for support." },
    needs_attention: { headline: "Help customers reach a resolution sooner", opportunity: "Shortening long resolution paths gives customers answers sooner and reduces the time they spend waiting for support.", question: "Which request types take longest to resolve, and where does the work slow down?" },
  },
  "Zero-touch ticket ratio": {
    improved: { headline: "A higher share of requests were resolved without an agent", why: "Resolving suitable requests without an agent gives customers a direct route to answers and leaves agents available for complex issues." },
    needs_attention: { headline: "Expand the requests customers can resolve without agent help", opportunity: "Improving self-service for suitable requests gives customers more direct answers and keeps agents focused on issues that need a person.", question: "Which repeat requests could customers resolve more easily on their own?" },
  },
  "One-touch ticket ratio": {
    improved: { headline: "A higher share of requests were resolved in one touch", why: "A complete answer in one exchange means less back-and-forth for those customers." },
    needs_attention: { headline: "Reduce back-and-forth on repeat requests", opportunity: "A more complete first answer means less back-and-forth for customers and less rework for agents.", question: "Which repeat requests most often need a second exchange before they are resolved?" },
  },
  "Knowledge views": {
    improved: { headline: "Help Center content received more views", why: "More article views give you more chances to help customers self-serve and reserve agent time for complex work." },
    needs_attention: { headline: "Make Help Center content easier to find and use", opportunity: "Easier-to-find answers give customers a more direct route to help and reduce avoidable contacts.", question: "Which common questions should customers be able to answer more easily through the Help Center?" },
  },
});

function semanticMetric(metric) {
  const trend = direction(metric);
  const language = METRIC_LANGUAGE[metric.metric];
  if (!language || !trend || metric.evidence_state !== "measured" || metric.comparison_state !== "comparable") return null;
  return {
    id: metricId(metric),
    metric: metric.metric,
    direction: trend,
    definition: metric.definition || null,
    evidence_root: metricId(metric),
    comparison: exactComparisonText(metric),
    trend_context: Array.isArray(metric.trend) ? metric.trend : [],
    ...language[trend],
  };
}

function metricCandidate(metric) {
  const semantic = semanticMetric(metric);
  if (!semantic || semantic.direction !== "improved") return null;
  return {
    id: semantic.id,
    rank: null,
    metric: semantic.metric,
    outcome_headline: semantic.headline,
    metric_comparison: semantic.comparison,
    why_it_matters: semantic.why,
    evidence_roots: [semantic.evidence_root],
    metric_definition: semantic.definition,
  };
}

const CAPABILITY_DETAILS = Object.freeze({
  admin_copilot: {
    label: "Admin Copilot",
    benefit_support: "clearer workflow configuration with Admin Copilot",
    support: "Use Admin Copilot to review routing, triggers, automations, views, and workflow configuration.",
  },
  intelligent_triage: {
    label: "Intelligent Triage",
    benefit_support: "request classification and routing with Intelligent Triage",
    support: "Use Intelligent Triage to classify, prioritise, and route the relevant requests.",
  },
  auto_assist: {
    label: "Auto Assist",
    benefit_support: "guided agent procedures with Auto Assist",
    support: "Use Auto Assist to guide agents through repeatable procedures.",
  },
  knowledge_copilot: {
    label: "Knowledge Copilot",
    benefit_support: "clearer, more complete answers with Knowledge Copilot",
    support: "Use Knowledge Copilot to find and improve answers agents rely on.",
  },
  knowledge_connectors: {
    label: "Knowledge Connectors",
    benefit_support: "trusted answers in Help Center search with Knowledge Connectors",
    support: "Use Knowledge Connectors to bring approved external answers into Help Center search.",
  },
  knowledge_builder: {
    label: "Knowledge Builder",
    benefit_support: "reviewed answers to recurring questions with Knowledge Builder",
    support: "Use Knowledge Builder to create a reviewed knowledge foundation for recurring requests.",
  },
  ai_agents: {
    label: "AI agents",
    benefit_support: "trusted answers and agent handoffs with AI agents",
    support: "Evaluate an AI agent on one repeatable request with trusted knowledge and a clear handoff.",
  },
  workflow_automation: {
    label: "Workflow automation",
    benefit_support: "clearer Zendesk workflow automation",
    support: "Simplify the relevant views, macros, triggers, and automations.",
  },
});

const CAPABILITY_PREFERENCES = Object.freeze({
  "CSAT score": ["auto_assist", "knowledge_copilot", "workflow_automation"],
  "Median first reply time": ["intelligent_triage", "admin_copilot", "workflow_automation"],
  "Median resolution time": ["auto_assist", "knowledge_copilot", "workflow_automation"],
  "Zero-touch ticket ratio": ["ai_agents", "knowledge_builder", "knowledge_connectors", "workflow_automation"],
  "One-touch ticket ratio": ["auto_assist", "knowledge_copilot", "workflow_automation"],
  "Tickets created": ["ai_agents", "knowledge_builder", "workflow_automation"],
  "Tickets solved": ["auto_assist", "workflow_automation"],
});

const METRIC_FOCUS_LANGUAGE = Object.freeze({
  "CSAT score": {
    focus_area: "Strengthen the support experience on the journeys that matter most",
    next_step: "Review the request types with the lowest customer feedback and agree where the experience needs to be clearer or more consistent.",
    outcome: "A clearer, more consistent support experience on the journeys customers value most.",
  },
  "Median first reply time": {
    focus_area: "A faster first reply",
    next_step: "Review the request types that wait longest and agree a clear routing path for them.",
    outcome: "Shorter first-response waits, so customers know sooner that help is underway.",
  },
  "Median resolution time": {
    focus_area: "Quicker resolutions",
    next_step: "Review the request types that take longest to resolve and identify where agents need a clearer next step.",
    outcome: "Faster answers and less time waiting for a resolution.",
  },
  "Zero-touch ticket ratio": {
    focus_area: "Easier self-service",
    next_step: "Review the highest-volume repeat requests and identify which ones have a clear self-service path.",
    outcome: "More suitable requests resolved through self-service, leaving agents free for complex issues.",
  },
  "One-touch ticket ratio": {
    focus_area: "Help customers get an answer without extra back-and-forth",
    next_step: "Review the repeat requests that need follow-up and agree what information or guidance is missing in the first response.",
    outcome: "More complete answers in one exchange, with less follow-up for customers.",
  },
});

// Owner-reviewed examples apply only to the matching evidence/capability pair.
// Other combinations retain their own proposed outcome and require CSM review.
const REVIEWED_METRIC_BENEFITS = Object.freeze({
  "Median first reply time": {
    intelligent_triage: "Give customers a quicker first reply through smarter routing with Intelligent Triage.",
  },
  "Median resolution time": {
    auto_assist: "Resolve requests faster with Auto Assist guiding your agents through support procedures.",
  },
  "Zero-touch ticket ratio": {
    knowledge_connectors: "Make trusted answers easier to find in Help Center search with Knowledge Connectors, so customers can help themselves.",
  },
});

function firstAvailableCapability(preferences, eligibility, usedCapabilities) {
  return preferences.find((candidate) => eligibility?.[candidate] === true && !usedCapabilities.has(candidate)) || null;
}

// Domain copy is frozen for CSM review, never composed by the renderer.
// This is a proposed benefit, not a promise or a claim that a product caused
// the measured trend. Capability eligibility is checked before pair selection.
function customerBenefit(outcome, capabilityKey) {
  return `${outcome.replace(/\.$/, "")} through ${CAPABILITY_DETAILS[capabilityKey].benefit_support}.`;
}

function metricOpportunityPair(metric, capabilityKey, rank) {
  const semantic = semanticMetric(metric);
  const capability = CAPABILITY_DETAILS[capabilityKey];
  const focus = METRIC_FOCUS_LANGUAGE[metric.metric];
  if (!semantic || semantic.direction !== "needs_attention" || !capability || !focus) return null;
  const connectedSelfService = metric.metric === "Zero-touch ticket ratio" && capabilityKey === "knowledge_connectors";
  return {
    id: `pair:${semantic.id}`,
    rank,
    evidence_roots: [semantic.evidence_root],
    verified_capability: { key: capabilityKey, label: capability.label },
    opportunity: {
      headline: semantic.headline,
      what_the_data_shows: semantic.comparison,
      customer_impact_opportunity: semantic.opportunity,
      question_to_validate: connectedSelfService
        ? "Which repeat requests have answers in connected sources, and are those answers available to customers through Help Center search?"
        : semantic.question,
    },
    focus: {
      focus_area: focus.focus_area,
      customer_benefit: REVIEWED_METRIC_BENEFITS[metric.metric]?.[capabilityKey] || customerBenefit(focus.outcome, capabilityKey),
      why_it_matters_now: semantic.comparison,
      practical_next_step: connectedSelfService
        ? "Choose common repeat requests and check whether their answers appear in Help Center search."
        : focus.next_step,
      how_zendesk_can_help: capability.support,
      expected_outcome_if_confirmed: focus.outcome,
    },
  };
}

function adoptionOpportunityPairs(account, eligibility, usedCapabilities, rankStart) {
  const pairs = [];
  const guideGap = account?.product_context?.adoption_gaps?.find((gap) => gap.product === "Guide" && gap.current_state === "Activated but not adopted");
  const guideCapability = firstAvailableCapability(["knowledge_copilot", "knowledge_connectors"], eligibility, usedCapabilities);
  if (guideGap && guideCapability) {
    usedCapabilities.add(guideCapability);
    pairs.push({
      id: "pair:adoption:guide",
      rank: rankStart + pairs.length,
      evidence_roots: ["adoption:guide"],
      verified_capability: { key: guideCapability, label: CAPABILITY_DETAILS[guideCapability].label },
      opportunity: {
        headline: "Make self-service easier for customers to use",
        what_the_data_shows: "Guide is activated, but regular use is not yet established.",
        customer_impact_opportunity: "A clearer self-service path can help customers find answers before they need to contact support.",
        question_to_validate: "Which repeat requests would customers benefit from resolving through self-service?",
      },
      focus: {
        focus_area: "Strengthen self-service for repeat requests",
        customer_benefit: customerBenefit("Easier access to clear answers before customers need to contact support", guideCapability),
        why_it_matters_now: "Guide is available but is not yet regularly adopted.",
        practical_next_step: "Review the repeat requests that create the most customer effort and choose one useful self-service journey to improve first.",
        how_zendesk_can_help: CAPABILITY_DETAILS[guideCapability].support,
        expected_outcome_if_confirmed: "Easier access to clear answers before customers need to contact support.",
      },
    });
  }
  const copilotGap = account?.product_context?.adoption_gaps?.find((gap) => gap.product === "Copilot paid add-on" && gap.current_state !== "Adopted");
  const copilotCapability = firstAvailableCapability(["auto_assist", "intelligent_triage"], eligibility, usedCapabilities);
  if (copilotGap && copilotCapability) {
    usedCapabilities.add(copilotCapability);
    pairs.push({
      id: "pair:adoption:copilot",
      rank: rankStart + pairs.length,
      evidence_roots: ["adoption:copilot_paid"],
      verified_capability: { key: copilotCapability, label: CAPABILITY_DETAILS[copilotCapability].label },
      opportunity: {
        headline: "Turn existing Copilot access into everyday value",
        what_the_data_shows: `The Copilot paid add-on is ${String(copilotGap.current_state).toLowerCase()}.`,
        customer_impact_opportunity: "A focused first use case can help the team learn where Copilot is most useful in their day-to-day work.",
        question_to_validate: "Which repeatable task would be the best place to start using Copilot?",
      },
      focus: {
        focus_area: "Start with one repeatable agent workflow",
        customer_benefit: customerBenefit("Less repetitive agent work on the chosen task", copilotCapability),
        why_it_matters_now: "Copilot access is in place, but regular use is not yet established.",
        practical_next_step: "Choose one repeatable procedure and agree what a useful assisted workflow would look like for agents.",
        how_zendesk_can_help: CAPABILITY_DETAILS[copilotCapability].support,
        expected_outcome_if_confirmed: "A practical Copilot workflow that reduces repetitive agent work on the chosen task.",
      },
    });
  }
  const slaInactive = account?.team_setup?.sla_active === false;
  const workflowCapability = firstAvailableCapability(["admin_copilot", "workflow_automation"], eligibility, usedCapabilities);
  if (slaInactive && workflowCapability) {
    usedCapabilities.add(workflowCapability);
    pairs.push({
      id: "pair:setup:sla-inactive",
      rank: rankStart + pairs.length,
      evidence_roots: ["setup:sla_active:false"],
      verified_capability: { key: workflowCapability, label: CAPABILITY_DETAILS[workflowCapability].label },
      opportunity: {
        headline: "Create a clearer response-time operating rhythm",
        what_the_data_shows: "SLA use is not active in the current support setup.",
        customer_impact_opportunity: "A shared response-time framework can make the team’s timing expectations easier to manage.",
        question_to_validate: "Would clearer response-time targets help the team manage its most important customer requests?",
      },
      focus: {
        focus_area: "Make response-time expectations easier to manage",
        customer_benefit: customerBenefit("Clearer response expectations for customers and the team", workflowCapability),
        why_it_matters_now: "SLA use is not active in the current setup.",
        practical_next_step: "Review the highest-priority request types and agree where response-time targets would be useful.",
        how_zendesk_can_help: CAPABILITY_DETAILS[workflowCapability].support,
        expected_outcome_if_confirmed: "Clearer response expectations for customers and the team.",
      },
    });
  }
  return pairs;
}

function opportunityAndFocusPairs(metrics, account) {
  const usedCapabilities = new Set();
  const eligibility = account?.product_context?.capability_eligibility || {};
  const metricPairs = metrics
    .filter((metric) => semanticMetric(metric)?.direction === "needs_attention")
    .flatMap((metric) => {
      const capabilityKey = firstAvailableCapability(CAPABILITY_PREFERENCES[metric.metric] || [], eligibility, usedCapabilities);
      if (!capabilityKey) return [];
      usedCapabilities.add(capabilityKey);
      const pair = metricOpportunityPair(metric, capabilityKey, 0);
      return pair ? [pair] : [];
    });
  const adoptionPairs = adoptionOpportunityPairs(account, eligibility, usedCapabilities, metricPairs.length + 1);
  return [...metricPairs, ...adoptionPairs]
    .slice(0, 5)
    .map((pair, index) => ({ ...pair, rank: index + 1 }));
}

function contentDataNote(sourceStates, { metricCandidateCount, pairCount } = {}) {
  const incomplete = Object.entries(sourceStates)
    .filter(([source, state]) => state !== "checked" && source !== "goals_and_timeline")
    .map(([source]) => source);
  if (sourceStates.account_context !== "checked") return "Account context could not be verified. No product or capability recommendation is included until that source succeeds.";
  if (incomplete.length) return "Some account data was incomplete when this draft was prepared. The content shows only the evidence available now.";
  if (metricCandidateCount === 0) return "No positive or clearly resilient year-over-year metric was available for the progress slide.";
  if (pairCount === 0) return "No evidence-led opportunity is available for the customer draft yet. Review the source gaps and any CSM-provided context before deciding what to do next.";
  return null;
}

function normaliseSelectionIds(ids) {
  return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === "string" && id.trim()))] : [];
}

function annualPointOfView(metrics) {
  const headlines = metrics.map((metric) => metric.outcome_headline.toLowerCase());
  if (headlines.length === 0) return null;
  if (headlines.length === 1) return `Over the past year, the measured results show one clear strength: ${headlines[0]}.`;
  const finalHeadline = headlines.pop();
  return `Over the past year, the measured results show several strengths: ${headlines.join(", ")}, and ${finalHeadline}.`;
}

/**
 * This is the complete CSM review handoff for the customer story. It is kept
 * separate from the evidence tables so the host cannot reduce the proposed
 * cards to generic headings or a paragraph before the CSM selects them.
 */
function buildRenewalCsmContentReviewTables({ metricCandidates, opportunityFocusPairs, csmContext = null }) {
  return {
    format: "tables_only",
    instruction: "Show every table in order and verbatim. Do not replace a row with a summary, label, or generic suggestion. The CSM selects IDs from these exact rows.",
    tables: [
      {
        id: "annual_point_of_view",
        title: "Annual point of view for review",
        columns: ["Draft point of view", "State"],
        rows: [{
          draft_point_of_view: annualPointOfView(metricCandidates.slice(0, 3)) || "—",
          state: metricCandidates.length ? "supported metric candidates" : "no supported strength available",
        }],
      },
      {
        id: "progress_metric_candidates",
        title: "Progress metric candidates",
        columns: ["ID", "Metric", "Customer headline", "Comparison", "Why it matters"],
        rows: metricCandidates.map((candidate) => ({
          id: candidate.id,
          metric: candidate.metric,
          customer_headline: candidate.outcome_headline,
          comparison: candidate.metric_comparison,
          why_it_matters: candidate.why_it_matters,
        })),
      },
      {
        id: "linked_opportunities_and_focus",
        title: "Linked opportunities and focus areas",
        columns: ["#", "ID", "Opportunity", "What the data shows", "Customer impact", "Question to validate", "Focus area", "Why now", "Practical next step", "How Zendesk can help", "Expected outcome"],
        rows: opportunityFocusPairs.map((pair) => ({
          number: pair.rank,
          id: pair.id,
          opportunity: pair.opportunity.headline,
          what_the_data_shows: pair.opportunity.what_the_data_shows,
          customer_impact: pair.opportunity.customer_impact_opportunity,
          question_to_validate: pair.opportunity.question_to_validate,
          focus_area: pair.focus.focus_area,
          why_now: pair.focus.why_it_matters_now,
          practical_next_step: pair.focus.practical_next_step,
          how_zendesk_can_help: pair.focus.how_zendesk_can_help,
          expected_outcome: pair.focus.expected_outcome_if_confirmed,
        })),
      },
      ...(csmContext ? [{
        id: "csm_provided_context",
        title: "CSM-provided context for review",
        columns: ["Statement", "Basis", "Source status", "Commercial access"],
        rows: [{
          statement: "AI Agents are not currently in use",
          basis: "Provided by the CSM for this renewal review; confirm with the customer",
          source_status: csmContext.source_status,
          commercial_access: "Not verified; confirm before proposing adoption",
        }],
      }] : []),
    ],
  };
}

/** Add a CSM statement to the transient review without changing source facts. */
export function addRenewalCsmContext({ reviewPackage, metricRows = [], context } = {}) {
  if (context !== "ai_agents_not_in_use") {
    throw new BetaError("RENEWAL_CSM_CONTEXT_UNSUPPORTED", "This CSM context is not supported by the renewal review.");
  }
  const accountContextChecked = reviewPackage?.shared_account_intelligence?.sections?.account_header?.state === "checked"
    || reviewPackage?.csm_account_brief?.source_states?.account_context === "checked";
  if (!reviewPackage?.csm_account_brief || !accountContextChecked) {
    throw new BetaError("RENEWAL_ACCOUNT_CONTEXT_REQUIRED", "Verified account context is required before adding a renewal opportunity.");
  }
  const productContext = reviewPackage.csm_account_brief.product_context || {};
  if (productContext.ai_agents_paid_adopted === true || productContext.ai_agents_unpaid_adopted === true) {
    throw new BetaError("RENEWAL_CSM_SOURCE_CONFLICT", "The current source snapshot reports AI Agents as adopted. Review that difference before using a CSM non-use statement.");
  }
  const snapshotState = productContext.ai_agents_paid_adopted === false || productContext.ai_agents_unpaid_adopted === false
    ? "The snapshot reports not adopted; confirm current use with the customer"
    : "The approved adoption snapshot does not establish use or non-use";
  const tickets = metricRows.find((metric) => metric.metric === "Tickets created" && metric.evidence_state === "measured" && number(metric.current_value) != null);
  if (!tickets) {
    throw new BetaError("RENEWAL_TICKET_EVIDENCE_REQUIRED", "Measured ticket volume is required to ground this AI Agents review option.");
  }
  const ticketCount = number(tickets.current_value).toLocaleString("en-US");
  const measuredVolume = `${ticketCount} human-support tickets were created in the measured month.`;
  const pair = {
    id: "pair:csm:ai-agents-evaluation",
    rank: 0,
    evidence_roots: ["csm:ai-agents-not-in-use", "metric:tickets-created"],
    verified_capability: { key: "ai_agents", label: "AI agents", account_access: "not_verified" },
    opportunity: {
      headline: "Find routine requests that could receive an immediate answer",
      what_the_data_shows: measuredVolume,
      customer_impact_opportunity: "Some repeat requests may be suitable for a faster answer if a useful journey is confirmed.",
      question_to_validate: "Are AI Agents currently in use, and which repeat requests could benefit from them? Confirm commercial access before proposing adoption.",
    },
    focus: {
      focus_area: "Evaluate one AI agent use case for routine questions",
      customer_benefit: "A proposed AI agents use case for faster answers to routine questions, with a clear path to an agent when needed.",
      why_it_matters_now: measuredVolume,
      practical_next_step: "Choose one frequent, well-defined request and check its answer source and escalation path.",
      how_zendesk_can_help: CAPABILITY_DETAILS.ai_agents.support,
      expected_outcome_if_confirmed: "Faster answers to suitable routine questions, with a clear path to an agent when needed.",
    },
  };
  const existingPairs = reviewPackage.opportunity_and_focus_pairs || [];
  const pairs = [
    ...existingPairs,
    ...(existingPairs.some((candidate) => candidate.verified_capability?.key === "ai_agents") ? [] : [pair]),
  ].slice(0, 5).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const metricCandidates = reviewPackage.metric_candidates || [];
  const csmContext = { kind: context, source_status: snapshotState };
  return {
    ...reviewPackage,
    csm_provided_context: { kind: context, provenance: "csm_statement", snapshot_state: snapshotState, customer_validation_required: true, commercial_access: "not_verified" },
    opportunity_and_focus_pairs: pairs,
    csm_recommendation_options: pairs,
    content_readiness: {
      ...reviewPackage.content_readiness,
      state: metricCandidates.length > 0 && pairs.length > 0 ? "ready_for_csm_selection" : "needs_csm_decision",
    },
    csm_content_review_display: buildRenewalCsmContentReviewTables({ metricCandidates, opportunityFocusPairs: pairs, csmContext }),
  };
}

function renewalEvidenceStatus({ complete, fullBriefSources }) {
  if (!complete) return "needs_csm_decision";
  // A usable customer story can still have a visible source gap. Keep the
  // selection route open, but never label the evidence "review ready" before
  // the CSM has reviewed and frozen the exact customer wording.
  const hasVisibleGap = Object.entries(fullBriefSources || {})
    .some(([source, state]) => source !== "goals_and_timeline" && state !== "checked");
  return hasVisibleGap ? "evidence_ready_with_gaps" : "evidence_ready";
}

function customerSlideNotes({ role, cards }) {
  if (role === "progress") {
    const includesKnowledgeViews = cards.some((card) => card.evidence_roots?.includes("metric:knowledge-views"));
    return {
      audience: "CSM only",
      talk_track: `Start with the customer outcome. Describe the measured comparison accurately and do not claim what caused it.${includesKnowledgeViews ? " Help Center views measure engagement, not unique customers, answered questions, or avoided contacts." : ""}`,
      validation_questions: [
        "Does this progress reflect your team’s experience over the past year?",
        "What made the biggest difference?",
        ...(includesKnowledgeViews ? ["Did the additional Help Center views help customers find answers, or did they still contact support?"] : []),
      ],
      evidence_roots: cards.flatMap((card) => card.evidence_roots || []),
    };
  }
  if (role === "opportunities") {
    return { audience: "CSM only", talk_track: "Use each opportunity as a question to validate. Do not present the likely cause as a fact.", validation_questions: cards.map((card) => card.question_to_validate), evidence_roots: cards.flatMap((card) => card.evidence_roots || []) };
  }
  return { audience: "CSM only", talk_track: "Present the benefit as a proposal. Confirm the customer’s context, product access and next step before committing to an action or outcome.",
    validation_questions: cards.map((card) => `Would ${card.focus_area.toLowerCase()} be useful to explore together?`),
    recommendation_details: cards.map((card) => card.recommendation_details),
    evidence_roots: cards.flatMap((card) => card.evidence_roots || []) };
}

function ensureNarrativeQuality({ metrics, pairs }) {
  const capabilityKeys = pairs.map((pair) => pair.verified_capability?.key);
  if (pairs.length < 1 || pairs.length > 3) throw new BetaError("RENEWAL_PAIR_SELECTION_REQUIRED", "Select one to three distinct opportunity-and-focus pairs for a renewal draft.");
  if (new Set(capabilityKeys).size !== pairs.length || capabilityKeys.some((key) => !key)) throw new BetaError("RENEWAL_CAPABILITY_DUPLICATED", "Each selected opportunity needs a distinct Zendesk capability.");
  if (pairs.some((pair) => Native.renewalFocusIssue({ focus_area: pair.focus?.focus_area, customer_benefit: pair.focus?.customer_benefit })
    || !pair.verified_capability?.label || !pair.focus.customer_benefit.toLowerCase().includes(pair.verified_capability.label.toLowerCase()))) {
    throw new BetaError("RENEWAL_CUSTOMER_BENEFIT_REQUIRED", "Review one customer benefit supported by the selected Zendesk capability before approving wording.");
  }
  const roots = pairs.flatMap((pair) => pair.evidence_roots || []);
  if (new Set(roots).size !== roots.length) throw new BetaError("RENEWAL_EVIDENCE_STORY_DUPLICATED", "Each selected opportunity must tell a different customer story with its own evidence root.");
  if (/\b(?:hypothesis|data-led|source state|Gainsight|CTA|owner|ARR|health)\b/i.test(JSON.stringify({ metrics, pairs }))) {
    throw new BetaError("RENEWAL_CUSTOMER_WORDING_UNSAFE", "Customer wording cannot expose internal labels, source mechanics, or confidence language.");
  }
}

/** Freeze the CSM selection before approval; the renderer cannot rewrite it. */
export function buildRenewalDeckContent({ reviewPackage, selectedMetricIds, selectedPairIds } = {}) {
  const metricIds = normaliseSelectionIds(selectedMetricIds);
  const pairIds = normaliseSelectionIds(selectedPairIds);
  if (metricIds.length < 1 || metricIds.length > 3) throw new BetaError("RENEWAL_METRIC_SELECTION_REQUIRED", "Select one to three positive or clearly resilient metric snapshots for the progress slide.");
  if (pairIds.length < 1 || pairIds.length > 3) throw new BetaError("RENEWAL_PAIR_SELECTION_REQUIRED", "Select one to three distinct opportunity-and-focus pairs for a renewal draft.");
  const metricCandidates = reviewPackage?.metric_candidates || [];
  const pairCandidates = reviewPackage?.opportunity_and_focus_pairs || [];
  const metrics = metricIds.map((id) => metricCandidates.find((candidate) => candidate.id === id));
  const pairs = pairIds.map((id) => pairCandidates.find((candidate) => candidate.id === id));
  if (metrics.some((metric) => !metric) || pairs.some((pair) => !pair)) throw new BetaError("RENEWAL_CONTENT_SELECTION_INVALID", "One or more selected renewal cards are not in the current reviewed evidence package.");
  ensureNarrativeQuality({ metrics, pairs });
  const numberedPairs = pairs.map((pair, index) => ({ ...pair, number: index + 1 }));
  const slideDefinitions = [
    {
      // The long annual review context belongs in CSM guidance. It must not
      // be concatenated into the native, single-subtitle header field.
      role: "progress", title: "Your progress over the past year", annual_point_of_view: "The strengths your results highlight",
      cards: metrics.map((metric) => ({ headline: metric.outcome_headline, metric_comparison: metric.metric_comparison, why_it_matters: metric.why_it_matters, evidence_roots: metric.evidence_roots })),
    },
    {
      role: "opportunities", title: "Opportunities to build on",
      cards: numberedPairs.map((pair) => ({ number: pair.number, headline: pair.opportunity.headline, what_the_data_shows: pair.opportunity.what_the_data_shows, customer_impact_opportunity: pair.opportunity.customer_impact_opportunity, question_to_validate: pair.opportunity.question_to_validate, evidence_roots: pair.evidence_roots })),
    },
    {
      role: "focus", title: "Where to focus next",
      cards: numberedPairs.map((pair) => ({ number: pair.number, focus_area: pair.focus.focus_area, customer_benefit: pair.focus.customer_benefit,
        recommendation_details: { number: pair.number, verified_capability: pair.verified_capability,
          why_it_matters_now: pair.focus.why_it_matters_now, practical_next_step: pair.focus.practical_next_step,
          how_zendesk_can_help: pair.focus.how_zendesk_can_help, expected_outcome_if_confirmed: pair.focus.expected_outcome_if_confirmed },
        evidence_roots: pair.evidence_roots })),
    },
  ];
  return {
    schema_version: RENEWAL_DECK_CONTENT_VERSION,
    artifact_kind: "renewal_deck_content",
    customer_copy_contract: RENEWAL_CUSTOMER_COPY_CONTRACT,
    content_status: "frozen_for_review",
    annual_point_of_view: annualPointOfView(metrics),
    selected_metric_ids: metricIds,
    selected_pair_ids: pairIds,
    customer_slides: slideDefinitions.map((slide) => ({ ...slide, cards: slide.cards.map(({ evidence_roots: _roots, question_to_validate: _question, recommendation_details: _details, ...card }) => card) })),
    private_speaker_notes: slideDefinitions.map((slide, index) => ({ ...customerSlideNotes(slide),
      ...(index === 0 ? { annual_review_context: annualPointOfView(metrics) } : {}) })),
  };
}

/**
 * Produces the customer-facing three-slide review package. It intentionally
 * never contains CTA ownership, ARR, health, contacts, emails, calls, or raw
 * source payloads. The caller retains those only in short-lived memory.
 */
export function buildRenewalConversationBrief({
  accountContextRow,
  metricRows = [],
  peerEvidence,
  sourceStates = {},
  selectedCta = null,
  ticketChannels = { state: "not_assessed", period: null, items: [], note: null },
  gongDigestRow = null,
  relatedCtaRows = [],
  fullBriefSources = null,
  now = new Date(),
} = {}) {
  const account = customerSafeAccountContext(accountContextRow);
  const gongSourceState = fullBriefSources?.account_gong_metadata || "not_run";
  const conversationDigest = accountConversationDigest(gongDigestRow, gongSourceState);
  const csmAccountBrief = account
    ? omitUnavailable({
      ...account,
      selected_cta: selectedCtaBrief(selectedCta),
      support_operations: {
        metric_table: metricRows,
        ticket_channels: ticketChannels,
        note: "Direct support-operation trends. They do not prove that a product caused the result.",
      },
      recent_gong_conversations: conversationDigest,
      goals_and_timeline: goalsAndTimelineContext(),
      source_states: fullBriefSources || sourceStates,
    })
    : null;
  const sharedAccountIntelligence = buildAccountIntelligenceCore({
    account,
    selectedCta,
    metricRows,
    peerEvidence,
    ticketChannels,
    conversationDigest,
    relatedCtaRows,
    fullBriefSources: fullBriefSources || sourceStates,
    now,
  });
  const supported = metricRows.filter((metric) => metric.evidence_state === "measured" && metric.comparison_state === "comparable");
  const metricCandidates = supported
    .map(metricCandidate)
    .filter(Boolean)
    .slice(0, 5)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const recommendationContext = sourceStates.account_context === "checked"
    && Object.values(account?.product_context?.capability_eligibility || {}).some(Boolean);
  const opportunityFocusPairs = recommendationContext ? opportunityAndFocusPairs(supported, account) : [];
  const reviewSourceStates = { ...sourceStates, ...(fullBriefSources || {}) };
  const note = contentDataNote(reviewSourceStates, { metricCandidateCount: metricCandidates.length, pairCount: opportunityFocusPairs.length });
  const csmContentReviewDisplay = buildRenewalCsmContentReviewTables({ metricCandidates, opportunityFocusPairs });
  const slides = [
    { role: "progress", title: "Your progress over the past year", cards: [], data_note: note },
    { role: "opportunities", title: "Opportunities to build on", cards: [], data_note: note },
    { role: "focus", title: "Where to focus next", cards: [], data_note: note },
  ];
  const customerSlides = slides.map(({ speaker_notes: _notes, ...slide }) => slide);
  return {
    schema_version: RENEWAL_CONVERSATION_BRIEF_VERSION,
    artifact_kind: "renewal_conversation_brief",
    account_name: account?.account_name || null,
    account_context: csmAccountBrief,
    csm_account_brief: csmAccountBrief,
    shared_account_intelligence: sharedAccountIntelligence,
    comparison: "Latest complete month compared with the same month a year earlier. A 12-month trend is included only as supporting context.",
    content_contract: "RenewalDeckContentV1",
    content_readiness: {
      state: recommendationContext && metricCandidates.length > 0 && opportunityFocusPairs.length > 0
        ? "ready_for_csm_selection"
        : "needs_csm_decision",
      normal_deck_requirements: {
        metric_candidates: "one to three selected positive or clearly resilient metrics",
        opportunity_focus_pairs: "one to three selected pairs with distinct evidence roots; account access must be confirmed for prospective capabilities",
      },
      data_note: note,
    },
    metric_candidates: metricCandidates,
    opportunity_and_focus_pairs: opportunityFocusPairs,
    csm_content_review_display: csmContentReviewDisplay,
    slides,
    customer_slides: customerSlides,
    csm_recommendation_options: opportunityFocusPairs,
    recommendation_context_verified: recommendationContext,
    source_gaps: [
      ...Object.entries(reviewSourceStates)
        .filter(([source, state]) => state !== "checked" && source !== "goals_and_timeline")
        .map(([source, state]) => `${source.toUpperCase()}_${String(state).toUpperCase()}`),
      ...(recommendationContext ? [] : ["CURRENT_CAPABILITY_ACCESS_UNAVAILABLE"]),
    ].filter((code, index, codes) => codes.indexOf(code) === index),
    review_gates: RENEWAL_CONVERSATION_REVIEW_GATES,
  };
}

/** One managed, account-only evidence operation for the renewal brief. */
export async function readRenewalConversationEvidenceWithSession({ accountId, selectedCta = null, session, now = new Date(), nowMs = Date.now, onProgress = null } = {}) {
  const sourceDurationsMs = {};
  const statementExecutions = [];
  const sources = [
    ["gainsight_account_context", buildRenewalGainsightAccountContextSql(accountId)],
    ["company_profile", buildRenewalCompanyProfileSql(accountId)],
    ["renewal_timing", buildRenewalAccountTimingSql(accountId)],
    ["commercial_subscriptions", buildRenewalCommercialSubscriptionsSql(accountId)],
    ["guide_adoption", buildRenewalGuideAdoptionSql(accountId)],
    ["copilot_adoption", buildRenewalCopilotAdoptionSql(accountId)],
    ["ai_agents_adoption", buildRenewalAiAgentsAdoptionSql(accountId)],
    ["suite_adoption", buildRenewalSuiteAdoptionSql(accountId)],
    ["basic_tools_adoption", buildRenewalBasicToolsAdoptionSql(accountId)],
    ["team_and_tech_context", buildRenewalTeamAndTechContextSql(accountId)],
    ["related_account_ctas", buildRenewalRelatedAccountCtasSql(accountId)],
    ["rba_metrics", buildRbaPerformanceMetricsSql(accountId, { trendMonths: 12, selectMostCompleteInstance: true })],
    ["ticket_channels", buildRenewalTicketsByChannelSql(accountId)],
    ["guide_knowledge_views", buildGuideKnowledgeViewMetricsSql(accountId, { trendMonths: 12, selectMostCompleteInstance: true })],
    ["peer_benchmarks", buildAccountPeerBenchmarksSql(accountId)],
    ["account_gong_metadata", buildRenewalAccountGongDigestSql(accountId)],
    ["account_gong_spotlight", buildRenewalAccountGongSpotlightSql(accountId), "account_gong_metadata"],
    ["historical_sla_policies", buildRenewalHistoricalSlaPolicySql(accountId)],
  ].map(([source, query, dependsOn]) => ({ source, query, dependsOn }));
  const read = ({ source, query }, options) => sourceResult(session, source, query, sourceDurationsMs, statementExecutions, { ...options, nowMs });
  read.skipped = (source, phase, reason = "EVIDENCE_WINDOW_EXHAUSTED") => statementExecutions.push({ source, phase, attempt: 0,
    statement_order: statementExecutions.length + 1, statement_started: false,
    retry_state: "not_started", safe_outcome: "not_run", failure_stage: reason === "DEPENDENCY_NOT_CHECKED" ? "evidence_dependency" : "evidence_window",
    ...(reason === "EVIDENCE_WINDOW_EXHAUSTED" ? { window_exhausted: true } : {}) });
  const results = await readAccountEvidencePlan({ sources, read, nowMs, onProgress });
  const { gainsight_account_context: gainsightAccount, company_profile: companyProfile, renewal_timing: renewalTiming,
    commercial_subscriptions: commercialSubscriptions, guide_adoption: guideAdoption, copilot_adoption: copilotAdoption,
    ai_agents_adoption: aiAgentsAdoption, suite_adoption: suiteAdoption, basic_tools_adoption: basicToolsAdoption,
    team_and_tech_context: teamAndTech, historical_sla_policies: historicalSlaPolicies,
    related_account_ctas: relatedCtas, rba_metrics: rbaMetrics,
    ticket_channels: ticketChannels, guide_knowledge_views: guideKnowledgeViews, peer_benchmarks: peerRead,
    account_gong_metadata: gongMetadata, account_gong_spotlight: gongSpotlight } = results;
  // A successful empty account-scoped CTA read is a verified empty result.
  if (relatedCtas.state === "no_data") {
    relatedCtas.state = "checked";
    relatedCtas.failure_code = null;
  }
  // A company profile plus the authenticated Gainsight record establishes the
  // account identity. Product and commercial reads fill only their own
  // sections. They must not remove the company brief when one source changes
  // or is unavailable.
  // Gainsight and Salesforce are independently attributable. A failure in
  // either one is a visible section-level gap, not a reason to discard the
  // other verified account, renewal, product, or adoption facts.
  const accountContextState = gainsightAccount.state === "checked" || companyProfile.state === "checked"
    ? "checked"
    : gainsightAccount.state !== "no_data"
      ? gainsightAccount.state
      : companyProfile.state;
  const accountContext = {
    state: accountContextState,
    rows: accountContextState === "checked"
      ? [{
        ...(gainsightAccount.rows[0] || {}),
        ...(companyProfile.rows[0] || {}),
        ...(renewalTiming.rows[0] || {}),
        ...(commercialSubscriptions.rows[0] || {}),
        ...(guideAdoption.rows[0] || {}),
        ...(copilotAdoption.rows[0] || {}),
        ...(aiAgentsAdoption.rows[0] || {}),
        ...(suiteAdoption.rows[0] || {}),
        ...(basicToolsAdoption.rows[0] || {}),
        ...(teamAndTech.rows[0] || {}),
        ...(historicalSlaPolicies.state === "checked" ? historicalSlaPolicies.rows[0] || {} : {}),
      }]
      : [],
    failure_code: gainsightAccount.failure_code || companyProfile.failure_code || null,
    gainsight: gainsightAccount,
    company_profile: companyProfile,
    account_executive: renewalTiming,
    renewal_timing: renewalTiming,
    commercial_subscriptions: commercialSubscriptions,
    guide_adoption: guideAdoption,
    copilot_adoption: copilotAdoption,
    ai_agents_adoption: aiAgentsAdoption,
    suite_adoption: suiteAdoption,
    basic_tools_adoption: basicToolsAdoption,
    team_and_tech: teamAndTech,
    historical_sla_policies: historicalSlaPolicies,
  };
  const peerEvidence = buildPeerBenchmarkEvidence(peerRead.rows, peerRead.state);
  // This metadata-only digest improves the CSM's full brief, but never blocks
  // the evidence-led renewal hypotheses or replaces selected-call discovery.
  const gongDigest = mergeGongMetadataAndSpotlight(gongMetadata, gongSpotlight);
  const ticketChannelContext = ticketChannelsContext(ticketChannels.rows[0], ticketChannels.state);
  const metricTable = buildPerformanceMetricTable({
    ...(rbaMetrics.rows[0] || {}),
    ...(guideKnowledgeViews.rows[0] || {}),
  }, { trendWindowMonths: 12 });
  const sourceStates = {
    account_context: accountContext.state,
    rba_metrics: rbaMetrics.state,
    ticket_channels: ticketChannels.state,
    guide_knowledge_views: guideKnowledgeViews.state,
  };
  const briefSources = fullBriefSourceStates({
    accountContext,
    rbaMetrics,
    guideKnowledgeViews,
    ticketChannels,
    gongDigest,
    gongSpotlight,
    relatedCtas,
    selectedCta,
  });
  briefSources.peer_benchmarks = peerEvidence.state;
  const reviewPackage = buildRenewalConversationBrief({
    accountContextRow: accountContext.rows[0],
    metricRows: metricTable.rows,
    peerEvidence,
    sourceStates,
    selectedCta,
    ticketChannels: ticketChannelContext,
    gongDigestRow: gongDigest.rows[0],
    relatedCtaRows: relatedCtas.rows,
    fullBriefSources: briefSources,
    now,
  });
  const complete = accountContext.state === "checked"
    && rbaMetrics.state === "checked"
    && ["checked", "no_data"].includes(guideKnowledgeViews.state)
    && reviewPackage.recommendation_context_verified
    && reviewPackage.content_readiness.state === "ready_for_csm_selection";
  return {
    status: renewalEvidenceStatus({ complete, fullBriefSources: briefSources }),
    evidence_receipt: crypto.createHash("sha256").update(JSON.stringify({
      accountId,
      sourceStates,
      metric_candidates: reviewPackage.metric_candidates,
      opportunity_and_focus_pairs: reviewPackage.opportunity_and_focus_pairs,
    })).digest("hex"),
    account_intelligence_receipt: {
      contract: ACCOUNT_INTELLIGENCE_CORE_CONTRACT,
      schema_version: ACCOUNT_INTELLIGENCE_CORE_VERSION,
      content_digest: crypto.createHash("sha256").update(JSON.stringify(reviewPackage.shared_account_intelligence)).digest("hex"),
      performance_coverage: performanceCoverage(reviewPackage.shared_account_intelligence),
      brief_state: reviewPackage.shared_account_intelligence.brief_state === "ready" ? "complete" : reviewPackage.shared_account_intelligence.brief_state,
      section_states: Object.fromEntries(Object.entries(reviewPackage.shared_account_intelligence.sections)
        .map(([name, value]) => [name, value.state])),
      source_gap_codes: reviewPackage.shared_account_intelligence.source_gaps,
      account_ref_digest: crypto.createHash("sha256").update(`account:${accountId}`).digest("hex"),
      raw_customer_content_retained: false,
    },
    review_package: reviewPackage,
    metric_table: metricTable,
    source_states: sourceStates,
    full_brief_source_states: briefSources,
    source_durations_ms: sourceDurationsMs,
    statement_executions: statementExecutions.map((entry) => ({
      ...entry,
      safe_outcome: entry.safe_outcome || sourceStates[entry.source] || "unknown",
    })),
    read_at: now.toISOString(),
  };
}

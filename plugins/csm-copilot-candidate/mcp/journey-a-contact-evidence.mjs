import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { BetaError } from "./core.mjs";
import { createTemporarySnowflakeConfig } from "./credential-bridges.mjs";
import { readAccountEvidencePlan } from "./account-evidence-read-plan.mjs";
import { safeSnowflakeReadDiagnostics } from "./source-read-diagnostics.mjs";
import { PRODUCT_ANALYTICS_SOURCES, sourceSnapshotDateRange } from "./product-analytics-sources.mjs";

export const CONTACT_EVIDENCE_READ_TIMEOUT_MS = 25_000;
export const CORE_CONTACT_IDENTITY_READ_TIMEOUT_MS = 25_000;
// The first useful result includes the account identity plus direct
// support-performance metrics. It never invokes QBR Express or creates a deck.
// It has the same 25-second budget as the product response contract. Slower
// relationship evidence continues in the same active case afterwards.
export const FAST_BRIEF_READ_TIMEOUT_MS = 25_000;
export const CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS = 60_000;
export const CONTACT_ENRICHMENT_EXTENDED_RETRY_TIMEOUT_MS = 120_000;
const MAX_CONTACTS = 100;
export const MAX_BULK_CONTACT_RESEARCH_ACCOUNTS = 50;
const MAX_BULK_CONTACTS_PER_ACCOUNT = 100;
const SALESFORCE_ACTIVITY_LOOKBACK_DAYS = 90;
const GONG_LOOKBACK_DAYS = 180;
// The RBA view separates tickets classified upstream as AI Agent/pre-agent
// tickets. Operational support metrics use the non-pre-agent cohort only;
// an explicitly requested AI Agent metric is a separate, labelled view.
const RBA_HUMAN_SUPPORT_TICKET_FILTER = "COALESCE(rba.TICKET_IS_PREAGENT, FALSE) = FALSE";

function opaqueRef(prefix, value) {
  return crypto.createHash("sha256").update(`${prefix}:${value}`).digest("hex");
}

function field(row, name) {
  return row[name] ?? row[name.toLowerCase()] ?? null;
}

function numberField(row, name) {
  const value = field(row, name);
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function arrayField(row, name) {
  const value = field(row, name);
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function metricEvidenceState(value, { sourceAvailable, conflicting = false } = {}) {
  if (conflicting) return "conflicting";
  if (!sourceAvailable || value == null) return "missing";
  return "measured";
}

function recommendedOutreachLanguage(billingCountry) {
  if (typeof billingCountry === "string" && /^(spain|españa)$/i.test(billingCountry.trim())) {
    return { code: "es", basis: "The current account record lists Spain as the billing country." };
  }
  return { code: null, basis: "No customer-facing language was verified from the current account record." };
}

function periodEnding(value, fallback) {
  if (typeof value === "string" && value.trim()) return `${fallback} ${value.slice(0, 10)}`;
  if (typeof value === "number" && Number.isInteger(value) && String(value).length === 6) {
    const compact = String(value);
    return `${fallback} ${compact.slice(0, 4)}-${compact.slice(4, 6)}`;
  }
  return `${fallback} unavailable`;
}

export function buildPerformanceMetricTable(row, { trendWindowMonths = 6 } = {}) {
  if (!Number.isInteger(trendWindowMonths) || trendWindowMonths < 1 || trendWindowMonths > 12) {
    throw new BetaError("INVALID_TREND_WINDOW", "trendWindowMonths must be an integer from 1 to 12.");
  }
  const rbaTrend = trendSeries(row, "RBA_TREND_SERIES");
  const guideTrend = trendSeries(row, "GUIDE_KNOWLEDGE_VIEW_TREND_SERIES");
  const rbaMetric = (fieldName, countName, yearAgoFieldName, yearAgoCountName, trendKey, percentage = false) => {
    const value = numberField(row, fieldName);
    const yearAgoValue = numberField(row, yearAgoFieldName);
    const distinctValueCount = numberField(row, countName);
    const yearAgoDistinctValueCount = numberField(row, yearAgoCountName);
    return trendMetric({
      value,
      yearAgoValue,
      sourceAvailable: distinctValueCount != null && distinctValueCount > 0,
      yearAgoSourceAvailable: yearAgoDistinctValueCount != null && yearAgoDistinctValueCount > 0,
      conflicting: distinctValueCount != null && distinctValueCount > 1,
      yearAgoConflicting: yearAgoDistinctValueCount != null && yearAgoDistinctValueCount > 1,
      trend: metricTrend(rbaTrend, trendKey),
      percentage,
    });
  };
  const ticketsCreated = rbaMetric("RBA_CREATED_TICKETS", "CREATED_TICKET_VALUE_COUNT", "YEAR_AGO_RBA_CREATED_TICKETS", "YEAR_AGO_CREATED_TICKET_VALUE_COUNT", "tickets_created");
  const ticketsClosed = rbaMetric("RBA_SOLVED_TICKETS", "SOLVED_TICKET_VALUE_COUNT", "YEAR_AGO_RBA_SOLVED_TICKETS", "YEAR_AGO_SOLVED_TICKET_VALUE_COUNT", "tickets_solved");
  const firstReply = rbaMetric("MEDIAN_FIRST_REPLY_HOURS", "FIRST_REPLY_VALUE_COUNT", "YEAR_AGO_MEDIAN_FIRST_REPLY_HOURS", "YEAR_AGO_FIRST_REPLY_VALUE_COUNT", "median_first_reply_hours");
  const resolution = rbaMetric("MEDIAN_RESOLUTION_HOURS", "RESOLUTION_VALUE_COUNT", "YEAR_AGO_MEDIAN_RESOLUTION_HOURS", "YEAR_AGO_RESOLUTION_VALUE_COUNT", "median_resolution_hours");
  const zeroTouch = rbaMetric("ZERO_TOUCH_TICKET_RATIO", "ZERO_TOUCH_VALUE_COUNT", "YEAR_AGO_ZERO_TOUCH_TICKET_RATIO", "YEAR_AGO_ZERO_TOUCH_VALUE_COUNT", "zero_touch_ticket_ratio", true);
  const oneTouch = rbaMetric("ONE_TOUCH_TICKET_RATIO", "ONE_TOUCH_VALUE_COUNT", "YEAR_AGO_ONE_TOUCH_TICKET_RATIO", "YEAR_AGO_ONE_TOUCH_VALUE_COUNT", "one_touch_ticket_ratio", true);
  const knowledgeViews = trendMetric({
    value: numberField(row, "GUIDE_KNOWLEDGE_VIEWS"),
    yearAgoValue: numberField(row, "YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS"),
    sourceAvailable: numberField(row, "GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT") > 0,
    yearAgoSourceAvailable: numberField(row, "YEAR_AGO_GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT") > 0,
    trend: metricTrend(guideTrend, "knowledge_views"),
  });
  const rbaPeriod = periodEnding(field(row, "RBA_METRICS_MONTH"), "Month ending");
  const yearAgoRbaPeriod = periodEnding(field(row, "YEAR_AGO_RBA_METRICS_MONTH"), "Year-ago month ending");
  const guidePeriod = periodEnding(field(row, "GUIDE_KNOWLEDGE_VIEWS_MONTH"), "Month ending");
  const yearAgoGuidePeriod = periodEnding(field(row, "YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS_MONTH"), "Year-ago month ending");
  const rowFor = ({ metric, definition, period, yearAgoPeriod, trend, unit, source, percentage = false }) => ({
    metric, product_or_area: "Support operations", definition, period, year_ago_period: yearAgoPeriod,
    current_value: trend.value, year_ago_value: trend.year_ago_value,
    year_over_year_change: trend.year_over_year_change, year_over_year_change_pct: trend.year_over_year_change_pct,
    percentage_point_change: percentage ? trend.year_over_year_change : null,
    trend_window: trendWindowMonths === 6 ? "Last six complete monthly snapshots" : `Last ${trendWindowMonths} complete monthly snapshots`, trend: trend.trend,
    comparison_state: trend.comparison_state,
    value: trend.value, unit, source, evidence_state: trend.evidence_state,
  });
  return {
    scope_note: "Support-operation metrics come from the monthly RBA aggregate and exclude tickets classified as AI Agent/pre-agent. Knowledge views are all recorded Guide article views, regardless of viewer role. Neither source proves a product caused the result or that a view prevented a ticket.",
    rows: [
      rowFor({ metric: "Tickets created", definition: "Tickets created in the measured calendar month, excluding tickets classified as AI Agent/pre-agent.", period: rbaPeriod, yearAgoPeriod: yearAgoRbaPeriod, trend: ticketsCreated, unit: "tickets", source: "Monthly RBA aggregate — human-agent scope" }),
      rowFor({ metric: "Tickets solved", definition: "Tickets solved in the measured calendar month, excluding tickets classified as AI Agent/pre-agent.", period: rbaPeriod, yearAgoPeriod: yearAgoRbaPeriod, trend: ticketsClosed, unit: "tickets", source: "Monthly RBA aggregate — human-agent scope" }),
      rowFor({ metric: "Median first reply time", definition: "Median time to first reply for tickets not classified as AI Agent/pre-agent.", period: rbaPeriod, yearAgoPeriod: yearAgoRbaPeriod, trend: firstReply, unit: "hours", source: "Monthly RBA aggregate — human-agent scope" }),
      rowFor({ metric: "Median resolution time", definition: "Median time to resolution for tickets not classified as AI Agent/pre-agent.", period: rbaPeriod, yearAgoPeriod: yearAgoRbaPeriod, trend: resolution, unit: "hours", source: "Monthly RBA aggregate — human-agent scope" }),
      rowFor({ metric: "Zero-touch ticket ratio", definition: "Share of tickets resolved with zero touches, excluding tickets classified as AI Agent/pre-agent.", period: rbaPeriod, yearAgoPeriod: yearAgoRbaPeriod, trend: zeroTouch, unit: "percent", source: "Monthly RBA aggregate — human-agent scope", percentage: true }),
      rowFor({ metric: "One-touch ticket ratio", definition: "Share of tickets resolved with one touch, excluding tickets classified as AI Agent/pre-agent.", period: rbaPeriod, yearAgoPeriod: yearAgoRbaPeriod, trend: oneTouch, unit: "percent", source: "Monthly RBA aggregate — human-agent scope", percentage: true }),
      rowFor({ metric: "Knowledge views", definition: "All recorded Guide article views in the measured calendar month, regardless of viewer role. This is engagement, not proof of ticket deflection.", period: guidePeriod, yearAgoPeriod: yearAgoGuidePeriod, trend: knowledgeViews, unit: "views", source: "Monthly Guide article-view aggregate" }),
    ],
  };
}

function trendSeries(row, name) {
  const value = field(row, name);
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function metricTrend(series, valueKey) {
  return series.map((point) => ({
    period: point?.period ?? null,
    value: numberField(point || {}, valueKey.toUpperCase()),
  })).filter((point) => point.period != null);
}

function trendMetric({ value, yearAgoValue, sourceAvailable, yearAgoSourceAvailable, conflicting = false, yearAgoConflicting = false, trend = [] }) {
  const evidenceState = metricEvidenceState(value, { sourceAvailable, conflicting });
  const comparable = evidenceState === "measured" && yearAgoValue != null && yearAgoSourceAvailable && !yearAgoConflicting;
  const comparisonState = conflicting || yearAgoConflicting
    ? "conflicting"
    : evidenceState !== "measured"
      ? "missing"
      : comparable
        ? "comparable"
        : "not_comparable";
  const yearOverYearChange = comparable ? value - yearAgoValue : null;
  return {
    value,
    year_ago_value: yearAgoValue,
    year_over_year_change: yearOverYearChange,
    year_over_year_change_pct: comparable && yearAgoValue !== 0 ? (100 * yearOverYearChange) / Math.abs(yearAgoValue) : null,
    evidence_state: evidenceState,
    comparison_state: comparisonState,
    trend,
  };
}

function parseRows(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.data)) return parsed.data;
    if (Array.isArray(parsed?.rows)) return parsed.rows;
  } catch (_error) {
    // Do not expose a source response, which can contain customer data.
  }
  throw new BetaError("CONTACT_EVIDENCE_RESPONSE_INVALID", "The contact-evidence response could not be read safely.");
}

/**
 * This is intentionally the first selected-account read. It contains only
 * Salesforce account and contact identity. The account has already been
 * bounded to the signed-in CSM's book by the governed queue or portfolio
 * selection, so this read must not repeat a costly Gainsight correlation.
 * Engagement, product adoption, and performance metrics must never prevent
 * this bounded result from surviving a later source timeout.
 */
export function buildCoreContactIdentitySql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
WITH current_contact_snapshot AS (
  -- This is the only contact-prioritization source for a new CTA. Restrict
  -- before choosing the latest snapshot so no broad contact-directory scan is
  -- needed. The touch date is an indicator, not proof that this CSM spoke
  -- with the person.
  SELECT CONTACT_ID, NAME, EMAIL, TITLE, LAST_SALES_TOUCH_DATE_TIME
  FROM FOUNDATIONAL.CUSTOMER.DIM_CRM_CONTACTS_DAILY_SNAPSHOT
  WHERE CRM_ACCOUNT_ID = '${accountId}'
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY CONTACT_ID
    ORDER BY SOURCE_SNAPSHOT_DATE DESC, RUN_DATE DESC
  ) = 1
)
SELECT CONTACT_ID AS contact_id, NAME AS contact_name, EMAIL AS contact_email,
  TITLE AS contact_title, LAST_SALES_TOUCH_DATE_TIME AS latest_sales_touch_at
FROM current_contact_snapshot
ORDER BY latest_sales_touch_at DESC NULLS LAST, contact_name ASC
LIMIT ${MAX_CONTACTS}
`.trim();
}

/** Current identity for snapshot-selected people only; never a name search or masking override. */
export function buildContactDetailLookupSql(accountId, contactIds) {
  const ids = [...new Set(Array.isArray(contactIds) ? contactIds : [])];
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "") || !ids.length || ids.length > MAX_CONTACTS
    || ids.some(id => !/^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || ""))) {
    throw new BetaError("CONTACT_DETAIL_BINDING_INVALID", "Contact details require the selected account and its exact contact references.");
  }
  return `/* native_contact_details */
SELECT ACCOUNT_ID AS account_id, ID AS contact_id, NAME AS contact_name,
  EMAIL AS contact_email, TITLE AS contact_title
FROM CLEANSED.SALESFORCE.SALESFORCE_CONTACT_FORMULA_BCV
WHERE ACCOUNT_ID = '${accountId}'
  AND ID IN (${ids.map(id => `'${id}'`).join(", ")})
ORDER BY ID
LIMIT ${ids.length + 1}`;
}

/**
 * One bounded snapshot read for a CSM-selected batch of current CTA accounts.
 * It is deliberately contact-only: no Salesforce activity, Gong, Gmail, or
 * account-metric query may delay or reshape the bulk shortlist.
 */
export function buildBulkCoreContactIdentitySql(accountIds) {
  const uniqueAccountIds = [...new Set(Array.isArray(accountIds) ? accountIds : [])];
  if (uniqueAccountIds.length < 2 || uniqueAccountIds.length > MAX_BULK_CONTACT_RESEARCH_ACCOUNTS
    || uniqueAccountIds.some((accountId) => !/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || ""))) {
    throw new BetaError(
      "INVALID_BULK_ACCOUNT_SELECTION",
      `Select between 2 and ${MAX_BULK_CONTACT_RESEARCH_ACCOUNTS} current CTA accounts for bulk contact research.`,
    );
  }
  const accountList = uniqueAccountIds.map((accountId) => `'${accountId}'`).join(", ");
  return `
WITH current_contact_snapshot AS (
  SELECT CRM_ACCOUNT_ID, CONTACT_ID, NAME, EMAIL, TITLE, LAST_SALES_TOUCH_DATE_TIME
  FROM FOUNDATIONAL.CUSTOMER.DIM_CRM_CONTACTS_DAILY_SNAPSHOT
  WHERE CRM_ACCOUNT_ID IN (${accountList})
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY CRM_ACCOUNT_ID, CONTACT_ID
    ORDER BY SOURCE_SNAPSHOT_DATE DESC, RUN_DATE DESC
  ) = 1
), bounded_contacts AS (
  SELECT *, COUNT(*) OVER (PARTITION BY CRM_ACCOUNT_ID) AS candidate_count
  FROM current_contact_snapshot
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY CRM_ACCOUNT_ID
    ORDER BY LAST_SALES_TOUCH_DATE_TIME DESC NULLS LAST, NAME ASC
  ) <= ${MAX_BULK_CONTACTS_PER_ACCOUNT}
)
SELECT CRM_ACCOUNT_ID AS account_id, CONTACT_ID AS contact_id, NAME AS contact_name,
  EMAIL AS contact_email, TITLE AS contact_title,
  LAST_SALES_TOUCH_DATE_TIME AS latest_sales_touch_at, candidate_count
FROM bounded_contacts
ORDER BY account_id ASC, latest_sales_touch_at DESC NULLS LAST, contact_name ASC
`.trim();
}

/** One exact-account, exact-contact Salesforce read for the snapshot-selected batch. */
export function buildBulkContactDetailLookupSql(snapshotRows, selections) {
  const selectedAccounts = new Set((selections || []).map((selection) => selection.accountId));
  if (selectedAccounts.size < 2 || selectedAccounts.size > MAX_BULK_CONTACT_RESEARCH_ACCOUNTS
    || [...selectedAccounts].some((id) => !/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || ""))
    || !Array.isArray(snapshotRows)) {
    throw new BetaError("BULK_CONTACT_DETAIL_BINDING_INVALID", "Contact details require the selected CTA accounts and their snapshot contact references.");
  }
  const pairs = new Set();
  const counts = new Map();
  for (const row of snapshotRows) {
    const accountId = field(row, "ACCOUNT_ID");
    const contactId = field(row, "CONTACT_ID");
    if (!selectedAccounts.has(accountId) || !/^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(contactId || "")) {
      throw new BetaError("BULK_CONTACT_DETAIL_BINDING_INVALID", "A snapshot contact did not match the selected account batch.");
    }
    const pair = `${accountId}:${contactId}`;
    if (pairs.has(pair)) throw new BetaError("BULK_CONTACT_DETAIL_BINDING_INVALID", "The snapshot repeated a contact reference.");
    pairs.add(pair);
    counts.set(accountId, (counts.get(accountId) || 0) + 1);
    if (counts.get(accountId) > MAX_BULK_CONTACTS_PER_ACCOUNT) {
      throw new BetaError("BULK_CONTACT_DETAIL_BINDING_INVALID", "The snapshot exceeded the contact cap for an account.");
    }
  }
  if (!pairs.size) return null;
  const values = [...pairs].map((pair) => {
    const [accountId, contactId] = pair.split(":");
    return `('${accountId}', '${contactId}')`;
  }).join(", ");
  return `/* native_bulk_contact_details */
WITH selected_contacts (account_id, contact_id) AS (
  SELECT column1, column2 FROM VALUES ${values}
)
SELECT sf.ACCOUNT_ID AS account_id, sf.ID AS contact_id, sf.NAME AS contact_name,
  sf.EMAIL AS contact_email, sf.TITLE AS contact_title
FROM CLEANSED.SALESFORCE.SALESFORCE_CONTACT_FORMULA_BCV AS sf
JOIN selected_contacts AS selected ON sf.ACCOUNT_ID = selected.account_id AND sf.ID = selected.contact_id
ORDER BY sf.ACCOUNT_ID, sf.ID
LIMIT ${pairs.size + 1}`;
}

/** Independent selected-account context read. It deliberately excludes contact activity and Gong. */
export function buildAccountContextSql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
WITH account_brief AS (
  SELECT company.GSID AS company_gsid, company.SFDC_ACCOUNT_ID AS account_id, company.NAME AS account_name,
    company.ACCOUNT_HEALTH_STATUS_GC AS account_health,
    company.DYNAMIC_SEGMENTATION_ENGAGEMENT_GC AS cs_segment,
    company.MARKET_SEGMENT_GC AS market_segment,
    company.NET_ARR_USD_GC AS net_arr_usd, salesforce.BILLING_COUNTRY AS billing_country,
    salesforce.INDUSTRY AS company_industry, salesforce.TYPE AS company_type,
    salesforce.NUMBER_OF_EMPLOYEES AS company_employee_count,
    salesforce.BILLING_CITY AS company_hq_city, salesforce.BILLING_STATE AS company_hq_state,
    salesforce.BILLING_COUNTRY AS company_hq_country, salesforce.WEBSITE AS company_website,
    csm.NAME AS csm_name
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
  LEFT JOIN CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV AS csm ON company.SUCCESS_OWNER_C_GC = csm.GSID
  LEFT JOIN CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS salesforce ON company.SFDC_ACCOUNT_ID = salesforce.ID
  WHERE company.SFDC_ACCOUNT_ID = '${accountId}'
), open_cta_context AS (
  SELECT COUNT(*) AS open_cta_count, MIN(cta.DUE_DATE) AS earliest_open_cta_due_at
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_CALL_TO_ACTION_BCV AS cta
  WHERE cta.COMPANY_ID = (SELECT company_gsid FROM account_brief)
    AND cta.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
    AND cta.IS_CLOSED = FALSE
), guide_adoption AS (
  SELECT SOURCE_SNAPSHOT_DATE, CRM_IS_KNOWLEDGE_ELIGIBLE, CRM_IS_KNOWLEDGE_ACTIVATED, CRM_IS_KNOWLEDGE_ADOPTED
  FROM ${PRODUCT_ANALYTICS_SOURCES.guide}
  WHERE CRM_ACCOUNT_ID = '${accountId}'
  QUALIFY ROW_NUMBER() OVER (ORDER BY SOURCE_SNAPSHOT_DATE DESC) = 1
), copilot_adoption AS (
  SELECT SOURCE_SNAPSHOT_DATE, CRM_IS_COPILOT_PAID_PENETRATED, CRM_IS_COPILOT_PAID_ACTIVATED,
    CRM_IS_COPILOT_PAID_ADOPTED, CRM_IS_COPILOT_UNPAID_PENETRATED,
    CRM_IS_COPILOT_UNPAID_ACTIVATED, CRM_IS_COPILOT_UNPAID_ADOPTED
  FROM ${PRODUCT_ANALYTICS_SOURCES.copilot}
  WHERE CRM_ACCOUNT_ID = '${accountId}'
  QUALIFY ROW_NUMBER() OVER (ORDER BY SOURCE_SNAPSHOT_DATE DESC) = 1
), account_instances AS (
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
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY security.INSTANCE_ACCOUNT_ID
    ORDER BY security.SOURCE_SNAPSHOT_DATE DESC
  ) = 1
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
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY tools.INSTANCE_ACCOUNT_ID
    ORDER BY tools.SOURCE_SNAPSHOT_DATE DESC
  ) = 1
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
), commercial_subscriptions AS (
  SELECT TO_JSON(ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(
    'product_plan', PRODUCT_PLAN,
    'product_line', PRODUCT_LINE,
    'offering', PRODUCT_OFFERING,
    'offering_group', PRODUCT_OFFERING_GROUPED,
    'status', SUBSCRIPTION_STATUS,
    'term_end', SUBSCRIPTION_TERM_END_DATE
  ))) AS commercial_subscriptions_json
  FROM (
    SELECT PRODUCT_PLAN, PRODUCT_LINE, PRODUCT_OFFERING, PRODUCT_OFFERING_GROUPED,
      SUBSCRIPTION_STATUS, SUBSCRIPTION_TERM_END_DATE
    FROM PRESENTATION.EDA_FINANCE.PRICING_COMM_SUBSCRIPTION
    WHERE CRM_ACCOUNT_ID = '${accountId}'
    LIMIT 50
  )
)
SELECT account.account_id, account.account_name, account.account_health, account.cs_segment,
  account.market_segment, account.net_arr_usd, account.billing_country, account.csm_name,
  account.company_industry, account.company_type, account.company_employee_count,
  account.company_hq_city, account.company_hq_state, account.company_hq_country, account.company_website,
  COALESCE(cta.open_cta_count, 0) AS open_cta_count, cta.earliest_open_cta_due_at,
  guide.SOURCE_SNAPSHOT_DATE AS guide_snapshot_date,
  guide.CRM_IS_KNOWLEDGE_ELIGIBLE AS guide_eligible,
  guide.CRM_IS_KNOWLEDGE_ACTIVATED AS guide_activated,
  guide.CRM_IS_KNOWLEDGE_ADOPTED AS guide_adopted,
  copilot.SOURCE_SNAPSHOT_DATE AS copilot_snapshot_date,
  copilot.CRM_IS_COPILOT_PAID_PENETRATED AS copilot_paid_penetrated,
  copilot.CRM_IS_COPILOT_PAID_ACTIVATED AS copilot_paid_activated,
  copilot.CRM_IS_COPILOT_PAID_ADOPTED AS copilot_paid_adopted,
  copilot.CRM_IS_COPILOT_UNPAID_PENETRATED AS copilot_unpaid_penetrated,
  copilot.CRM_IS_COPILOT_UNPAID_ACTIVATED AS copilot_unpaid_activated,
  copilot.CRM_IS_COPILOT_UNPAID_ADOPTED AS copilot_unpaid_adopted,
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
  integration.max_private_app_count AS tech_stack_max_private_app_count,
  commercial.commercial_subscriptions_json
FROM account_brief AS account
LEFT JOIN open_cta_context AS cta ON TRUE
LEFT JOIN guide_adoption AS guide ON TRUE
LEFT JOIN copilot_adoption AS copilot ON TRUE
LEFT JOIN security_setup AS security ON TRUE
LEFT JOIN basic_tools_setup AS basic ON TRUE
LEFT JOIN guide_connector_context AS guide_context ON TRUE
LEFT JOIN marketplace_apps AS apps ON TRUE
LEFT JOIN integration_context AS integration ON TRUE
LEFT JOIN commercial_subscriptions AS commercial ON TRUE
`.trim();
}

/** Independent 90-day Salesforce activity read for contacts on one selected account. */
export function buildSalesforceContactActivitySql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
WITH selected_contacts AS (
  SELECT ID FROM CLEANSED.SALESFORCE.SALESFORCE_CONTACT_FORMULA_BCV
  WHERE ACCOUNT_ID = '${accountId}' LIMIT ${MAX_CONTACTS}
)
SELECT task.WHO_ID AS contact_id, COUNT(*) AS salesforce_activity_count,
  MAX(task.ACTIVITY_DATE) AS latest_activity_at
FROM CLEANSED.SALESFORCE.SALESFORCE_TASK_FORMULA_BCV AS task
JOIN selected_contacts AS contact ON task.WHO_ID = contact.ID
WHERE task.ACTIVITY_DATE >= DATEADD(day, -${SALESFORCE_ACTIVITY_LOOKBACK_DAYS}, CURRENT_DATE())
  AND (task.ACCOUNT_ID = '${accountId}' OR task.ACCOUNT_ID IS NULL)
GROUP BY task.WHO_ID
`.trim();
}

/** Independent metadata-only 180-day Gong read for contacts on one selected account. */
export function buildGongContactMetadataSql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
WITH selected_contacts AS (
  SELECT ID FROM CLEANSED.SALESFORCE.SALESFORCE_CONTACT_FORMULA_BCV
  WHERE ACCOUNT_ID = '${accountId}' LIMIT ${MAX_CONTACTS}
)
SELECT participant.ASSOCIATED_OBJECT_ID AS contact_id, COUNT(DISTINCT call.GONG_CONVERSATION_KEY) AS gong_meeting_count,
  MAX(call.GONG_CALL_EFFECTIVE_START_DATETIME) AS latest_meeting_at
FROM FOUNDATIONAL.ENTERPRISE_MART.MART_GONG_CALLS_BCV AS call
JOIN CLEANSED.GONG.GONG_CONVERSATION_PARTICIPANTS_BCV AS participant
  ON call.GONG_CONVERSATION_KEY = participant.CONVERSATION_KEY
JOIN selected_contacts AS contact ON participant.ASSOCIATED_OBJECT_ID = contact.ID
WHERE participant.AFFILIATION IN ('External', 'non_company')
  AND call.GONG_CALL_EFFECTIVE_START_DATETIME >= DATEADD(day, -${GONG_LOOKBACK_DAYS}, CURRENT_TIMESTAMP())
GROUP BY participant.ASSOCIATED_OBJECT_ID
`.trim();
}

export function buildContactEvidenceSql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
WITH current_csm AS (
  SELECT GSID
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV
  WHERE LOWER(EMAIL) = LOWER(CURRENT_USER())
), account_brief AS (
  SELECT company.SFDC_ACCOUNT_ID AS account_id,
    company.NAME AS account_name,
    company.ACCOUNT_HEALTH_STATUS_GC AS account_health,
    company.DYNAMIC_SEGMENTATION_ENGAGEMENT_GC AS cs_segment,
    company.MARKET_SEGMENT_GC AS market_segment,
    company.NET_ARR_USD_GC AS net_arr_usd,
    csm.NAME AS csm_name
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
  JOIN current_csm ON company.SUCCESS_OWNER_C_GC = current_csm.GSID
  LEFT JOIN CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV AS csm ON company.SUCCESS_OWNER_C_GC = csm.GSID
  LEFT JOIN CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS salesforce ON company.SFDC_ACCOUNT_ID = salesforce.ID
  WHERE company.SFDC_ACCOUNT_ID = '${accountId}'
), open_cta_context AS (
  SELECT cta.COMPANY_ID AS company_id,
    COUNT(*) AS open_cta_count,
    MIN(cta.DUE_DATE) AS earliest_open_cta_due_at
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_CALL_TO_ACTION_BCV AS cta
  JOIN CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company ON cta.COMPANY_ID = company.GSID
  JOIN account_brief AS account ON company.SFDC_ACCOUNT_ID = account.account_id
  WHERE cta.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
    AND cta.IS_CLOSED = FALSE
  GROUP BY cta.COMPANY_ID
), guide_adoption AS (
  SELECT SOURCE_SNAPSHOT_DATE,
    CRM_IS_KNOWLEDGE_ELIGIBLE,
    CRM_IS_KNOWLEDGE_ACTIVATED,
    CRM_IS_KNOWLEDGE_ADOPTED
  FROM ${PRODUCT_ANALYTICS_SOURCES.guide}
  WHERE CRM_ACCOUNT_ID = (SELECT account_id FROM account_brief)
  QUALIFY ROW_NUMBER() OVER (ORDER BY SOURCE_SNAPSHOT_DATE DESC) = 1
), copilot_adoption AS (
  SELECT SOURCE_SNAPSHOT_DATE,
    CRM_IS_COPILOT_PAID_PENETRATED,
    CRM_IS_COPILOT_PAID_ACTIVATED,
    CRM_IS_COPILOT_PAID_ADOPTED,
    CRM_IS_COPILOT_UNPAID_PENETRATED,
    CRM_IS_COPILOT_UNPAID_ACTIVATED,
    CRM_IS_COPILOT_UNPAID_ADOPTED
  FROM ${PRODUCT_ANALYTICS_SOURCES.copilot}
  WHERE CRM_ACCOUNT_ID = (SELECT account_id FROM account_brief)
  QUALIFY ROW_NUMBER() OVER (ORDER BY SOURCE_SNAPSHOT_DATE DESC) = 1
), selected_contacts AS (
  SELECT ID, NAME, EMAIL, TITLE
  FROM CLEANSED.SALESFORCE.SALESFORCE_CONTACT_FORMULA_BCV
  WHERE ACCOUNT_ID = (SELECT account_id FROM account_brief)
  ORDER BY NAME ASC
  LIMIT ${MAX_CONTACTS}
), salesforce_activity AS (
  SELECT task.WHO_ID AS contact_id,
    COUNT(*) AS activity_count,
    MAX(task.ACTIVITY_DATE) AS latest_activity_at
  FROM CLEANSED.SALESFORCE.SALESFORCE_TASK_FORMULA_BCV AS task
  JOIN selected_contacts AS contact ON task.WHO_ID = contact.ID
  WHERE task.ACTIVITY_DATE >= DATEADD(day, -${SALESFORCE_ACTIVITY_LOOKBACK_DAYS}, CURRENT_DATE())
    AND (task.ACCOUNT_ID = '${accountId}' OR task.ACCOUNT_ID IS NULL)
  GROUP BY task.WHO_ID
), gong_meetings AS (
  SELECT participant.ASSOCIATED_OBJECT_ID AS contact_id,
    COUNT(DISTINCT call.GONG_CONVERSATION_KEY) AS meeting_count,
    MAX(call.GONG_CALL_EFFECTIVE_START_DATETIME) AS latest_meeting_at
  FROM FOUNDATIONAL.ENTERPRISE_MART.MART_GONG_CALLS_BCV AS call
  JOIN CLEANSED.GONG.GONG_CONVERSATION_PARTICIPANTS_BCV AS participant
    ON call.GONG_CONVERSATION_KEY = participant.CONVERSATION_KEY
  JOIN selected_contacts AS contact ON participant.ASSOCIATED_OBJECT_ID = contact.ID
  WHERE participant.AFFILIATION IN ('External', 'non_company')
    AND call.GONG_CALL_EFFECTIVE_START_DATETIME >= DATEADD(day, -${GONG_LOOKBACK_DAYS}, CURRENT_TIMESTAMP())
  GROUP BY participant.ASSOCIATED_OBJECT_ID
)
SELECT account.account_id,
  account.account_name,
  account.account_health,
  account.cs_segment,
  account.market_segment,
  account.net_arr_usd,
  account.csm_name,
  COALESCE(cta.open_cta_count, 0) AS open_cta_count,
  cta.earliest_open_cta_due_at,
  guide.SOURCE_SNAPSHOT_DATE AS guide_snapshot_date,
  guide.CRM_IS_KNOWLEDGE_ELIGIBLE AS guide_eligible,
  guide.CRM_IS_KNOWLEDGE_ACTIVATED AS guide_activated,
  guide.CRM_IS_KNOWLEDGE_ADOPTED AS guide_adopted,
  copilot.SOURCE_SNAPSHOT_DATE AS copilot_snapshot_date,
  copilot.CRM_IS_COPILOT_PAID_PENETRATED AS copilot_paid_penetrated,
  copilot.CRM_IS_COPILOT_PAID_ACTIVATED AS copilot_paid_activated,
  copilot.CRM_IS_COPILOT_PAID_ADOPTED AS copilot_paid_adopted,
  copilot.CRM_IS_COPILOT_UNPAID_PENETRATED AS copilot_unpaid_penetrated,
  copilot.CRM_IS_COPILOT_UNPAID_ACTIVATED AS copilot_unpaid_activated,
  copilot.CRM_IS_COPILOT_UNPAID_ADOPTED AS copilot_unpaid_adopted,
  contact.ID AS contact_id,
  contact.NAME AS contact_name,
  contact.EMAIL AS contact_email,
  contact.TITLE AS contact_title,
  COALESCE(activity.activity_count, 0) AS salesforce_activity_count,
  activity.latest_activity_at,
  COALESCE(gong.meeting_count, 0) AS gong_meeting_count,
  gong.latest_meeting_at
FROM account_brief AS account
LEFT JOIN open_cta_context AS cta ON TRUE
LEFT JOIN guide_adoption AS guide ON TRUE
LEFT JOIN copilot_adoption AS copilot ON TRUE
LEFT JOIN selected_contacts AS contact ON TRUE
LEFT JOIN salesforce_activity AS activity ON contact.ID = activity.contact_id
LEFT JOIN gong_meetings AS gong ON contact.ID = gong.contact_id
ORDER BY contact.NAME ASC
LIMIT ${MAX_CONTACTS}
`.trim();
}

export function buildAccountPerformanceMetricsSql(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `
WITH account_instances AS (
  SELECT DISTINCT ZENDESK_ACCOUNT_ID
  FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS
  WHERE CRM_ACCOUNT_ID = '${accountId}'
    AND ZENDESK_ACCOUNT_ID IS NOT NULL
), latest_complete_ticket_snapshot AS (
  SELECT MAX(ticket.SOURCE_SNAPSHOT_DATE) AS snapshot_date
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
  JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE ticket.SOURCE_SNAPSHOT_DATE < DATE_TRUNC('MONTH', CURRENT_DATE())
), latest_complete_rba_month AS (
  SELECT MAX(rba.MONTH_YEAR) AS month_year
  FROM PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW AS rba
  JOIN account_instances AS instance ON rba.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE rba.MONTH_YEAR < (YEAR(CURRENT_DATE()) * 100 + MONTH(CURRENT_DATE()))
)
SELECT
  'ticket' AS metric_source,
  (SELECT snapshot_date FROM latest_complete_ticket_snapshot) AS ticket_metrics_snapshot_date,
  CAST(COUNT(DISTINCT ticket.INSTANCE_ACCOUNT_ID) AS DOUBLE) AS ticket_metrics_instance_count,
  CAST(SUM(ticket.COUNT_CREATED_TICKETS_28D) AS DOUBLE) AS tickets_created_28d,
  CAST(SUM(ticket.COUNT_CLOSED_TICKETS_28D) AS DOUBLE) AS tickets_closed_28d,
  CAST(SUM(ticket.COUNT_CSAT_GOOD_28D) AS DOUBLE) AS csat_good_28d,
  CAST(SUM(ticket.COUNT_CSAT_RESPONDED_28D) AS DOUBLE) AS csat_responded_28d,
  CAST(SUM(ticket.COUNT_CSAT_OFFERED_28D) AS DOUBLE) AS csat_offered_28d,
  IFF(SUM(ticket.COUNT_CSAT_RESPONDED_28D) > 0, CAST(ROUND(100 * SUM(ticket.COUNT_CSAT_GOOD_28D) / SUM(ticket.COUNT_CSAT_RESPONDED_28D), 1) AS DOUBLE), NULL) AS csat_score_pct,
  CAST(NULL AS NUMBER) AS rba_metrics_month,
  CAST(NULL AS TEXT) AS rba_ticket_scope,
  CAST(NULL AS DOUBLE) AS first_reply_value_count,
  CAST(NULL AS DOUBLE) AS median_first_reply_hours,
  CAST(NULL AS DOUBLE) AS resolution_value_count,
  CAST(NULL AS DOUBLE) AS median_resolution_hours,
  CAST(NULL AS DOUBLE) AS zero_touch_value_count,
  CAST(NULL AS DOUBLE) AS zero_touch_ticket_ratio,
  CAST(NULL AS DOUBLE) AS one_touch_value_count,
  CAST(NULL AS DOUBLE) AS one_touch_ticket_ratio
FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
WHERE ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot)
UNION ALL
SELECT
  'rba' AS metric_source,
  CAST(NULL AS DATE) AS ticket_metrics_snapshot_date,
  CAST(NULL AS DOUBLE) AS ticket_metrics_instance_count,
  CAST(NULL AS DOUBLE) AS tickets_created_28d,
  CAST(NULL AS DOUBLE) AS tickets_closed_28d,
  CAST(NULL AS DOUBLE) AS csat_good_28d,
  CAST(NULL AS DOUBLE) AS csat_responded_28d,
  CAST(NULL AS DOUBLE) AS csat_offered_28d,
  CAST(NULL AS DOUBLE) AS csat_score_pct,
  (SELECT month_year FROM latest_complete_rba_month) AS rba_metrics_month,
  CAST('human_support' AS TEXT) AS rba_ticket_scope,
  CAST(COUNT(DISTINCT rba.RBA_FRT_MEDIAN_HOURS) AS DOUBLE) AS first_reply_value_count,
  IFF(COUNT(DISTINCT rba.RBA_FRT_MEDIAN_HOURS) = 1, CAST(MAX(rba.RBA_FRT_MEDIAN_HOURS) AS DOUBLE), NULL) AS median_first_reply_hours,
  CAST(COUNT(DISTINCT rba.RBA_TTC_MEDIAN_HOURS) AS DOUBLE) AS resolution_value_count,
  IFF(COUNT(DISTINCT rba.RBA_TTC_MEDIAN_HOURS) = 1, CAST(MAX(rba.RBA_TTC_MEDIAN_HOURS) AS DOUBLE), NULL) AS median_resolution_hours,
  CAST(COUNT(DISTINCT rba.RBA_ZERO_TOUCH_TICKET_RATIO) AS DOUBLE) AS zero_touch_value_count,
  IFF(COUNT(DISTINCT rba.RBA_ZERO_TOUCH_TICKET_RATIO) = 1, CAST(MAX(rba.RBA_ZERO_TOUCH_TICKET_RATIO) AS DOUBLE), NULL) AS zero_touch_ticket_ratio,
  CAST(COUNT(DISTINCT rba.RBA_ONE_TOUCH_TICKET_RATIO) AS DOUBLE) AS one_touch_value_count,
  IFF(COUNT(DISTINCT rba.RBA_ONE_TOUCH_TICKET_RATIO) = 1, CAST(MAX(rba.RBA_ONE_TOUCH_TICKET_RATIO) AS DOUBLE), NULL) AS one_touch_ticket_ratio
FROM PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW AS rba
JOIN account_instances AS instance ON rba.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
WHERE rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month)
  AND ${RBA_HUMAN_SUPPORT_TICKET_FILTER}
`.trim();
}

function mergePerformanceMetricRows(rows) {
  const ticket = rows.find((row) => field(row, "METRIC_SOURCE") === "ticket");
  const rba = rows.find((row) => field(row, "METRIC_SOURCE") === "rba");
  if (!ticket || !rba) {
    throw new BetaError("PERFORMANCE_METRICS_RESPONSE_INVALID", "The QBR performance-metrics response could not be read safely.");
  }
  const merged = {};
  for (const row of [ticket, rba]) {
    for (const [key, value] of Object.entries(row)) {
      if (value != null) merged[key] = value;
    }
  }
  return merged;
}

export function buildTicketPerformanceMetricsSql(accountId, { trendMonths = 6, selectMostCompleteInstance = false } = {}) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  if (!Number.isInteger(trendMonths) || trendMonths < 1 || trendMonths > 12) {
    throw new BetaError("INVALID_TREND_WINDOW", "trendMonths must be an integer from 1 to 12.");
  }
  const accountInstances = selectMostCompleteInstance
    ? `SELECT account.ZENDESK_ACCOUNT_ID
       FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS AS account
       JOIN FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
         ON ticket.INSTANCE_ACCOUNT_ID = account.ZENDESK_ACCOUNT_ID
       WHERE account.CRM_ACCOUNT_ID = '${accountId}'
         AND account.ZENDESK_ACCOUNT_ID IS NOT NULL
         AND ticket.SOURCE_SNAPSHOT_DATE < DATE_TRUNC('MONTH', CURRENT_DATE())
       GROUP BY account.ZENDESK_ACCOUNT_ID
       QUALIFY ROW_NUMBER() OVER (
         ORDER BY COUNT(DISTINCT DATE_TRUNC('MONTH', ticket.SOURCE_SNAPSHOT_DATE)) DESC,
           MAX(ticket.SOURCE_SNAPSHOT_DATE) DESC, account.ZENDESK_ACCOUNT_ID
       ) = 1`
    : `SELECT DISTINCT ZENDESK_ACCOUNT_ID
       FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS
       WHERE CRM_ACCOUNT_ID = '${accountId}'
         AND ZENDESK_ACCOUNT_ID IS NOT NULL`;
  return `
WITH account_instances AS (
  ${accountInstances}
), latest_complete_ticket_snapshot AS (
  SELECT MAX(ticket.SOURCE_SNAPSHOT_DATE) AS snapshot_date
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
  JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE ticket.SOURCE_SNAPSHOT_DATE < DATE_TRUNC('MONTH', CURRENT_DATE())
), ticket_month_ends AS (
  SELECT ticket.SOURCE_SNAPSHOT_DATE AS snapshot_date,
    DATE_TRUNC('MONTH', ticket.SOURCE_SNAPSHOT_DATE) AS metric_month
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
  JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE ticket.SOURCE_SNAPSHOT_DATE < DATE_TRUNC('MONTH', CURRENT_DATE())
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY DATE_TRUNC('MONTH', ticket.SOURCE_SNAPSHOT_DATE)
    ORDER BY ticket.SOURCE_SNAPSHOT_DATE DESC
  ) = 1
), ticket_trend_dates AS (
  SELECT snapshot_date, metric_month
  FROM ticket_month_ends
  QUALIFY ROW_NUMBER() OVER (ORDER BY metric_month DESC) <= ${trendMonths}
), year_ago_ticket_snapshot AS (
  SELECT MAX(ticket.SOURCE_SNAPSHOT_DATE) AS snapshot_date
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
  JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE ticket.SOURCE_SNAPSHOT_DATE BETWEEN
    DATEADD(day, -7, DATEADD(year, -1, (SELECT snapshot_date FROM latest_complete_ticket_snapshot))) AND
    DATEADD(day, 7, DATEADD(year, -1, (SELECT snapshot_date FROM latest_complete_ticket_snapshot)))
), ticket_trend_metrics AS (
  SELECT ticket.SOURCE_SNAPSHOT_DATE AS snapshot_date,
    CAST(SUM(ticket.COUNT_CREATED_TICKETS_28D) AS DOUBLE) AS tickets_created,
    CAST(SUM(ticket.COUNT_CLOSED_TICKETS_28D) AS DOUBLE) AS tickets_closed,
    IFF(SUM(ticket.COUNT_CSAT_RESPONDED_28D) > 0,
      CAST(ROUND(100 * SUM(ticket.COUNT_CSAT_GOOD_28D) / SUM(ticket.COUNT_CSAT_RESPONDED_28D), 1) AS DOUBLE), NULL
    ) AS csat_score_pct
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
  JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE ticket.SOURCE_SNAPSHOT_DATE IN (SELECT snapshot_date FROM ticket_trend_dates)
  GROUP BY ticket.SOURCE_SNAPSHOT_DATE
)
SELECT
  (SELECT snapshot_date FROM latest_complete_ticket_snapshot) AS ticket_metrics_snapshot_date,
  (SELECT snapshot_date FROM year_ago_ticket_snapshot) AS year_ago_ticket_metrics_snapshot_date,
  (
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
      'period', TO_VARCHAR(snapshot_date),
      'tickets_created', tickets_created,
      'tickets_closed', tickets_closed,
      'csat_score_pct', csat_score_pct
    )) WITHIN GROUP (ORDER BY snapshot_date)
    FROM ticket_trend_metrics
  ) AS ticket_trend_series,
  CAST(COUNT(DISTINCT IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.INSTANCE_ACCOUNT_ID, NULL)) AS DOUBLE) AS ticket_metrics_instance_count,
  CAST(COUNT(DISTINCT IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.INSTANCE_ACCOUNT_ID, NULL)) AS DOUBLE) AS year_ago_ticket_metrics_instance_count,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CREATED_TICKETS_28D, NULL)) AS DOUBLE) AS tickets_created_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CREATED_TICKETS_28D, NULL)) AS DOUBLE) AS year_ago_tickets_created_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CLOSED_TICKETS_28D, NULL)) AS DOUBLE) AS tickets_closed_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CLOSED_TICKETS_28D, NULL)) AS DOUBLE) AS year_ago_tickets_closed_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CSAT_GOOD_28D, NULL)) AS DOUBLE) AS csat_good_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CSAT_RESPONDED_28D, NULL)) AS DOUBLE) AS csat_responded_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CSAT_OFFERED_28D, NULL)) AS DOUBLE) AS csat_offered_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CSAT_GOOD_28D, NULL)) AS DOUBLE) AS year_ago_csat_good_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CSAT_RESPONDED_28D, NULL)) AS DOUBLE) AS year_ago_csat_responded_28d,
  CAST(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CSAT_OFFERED_28D, NULL)) AS DOUBLE) AS year_ago_csat_offered_28d,
  IFF(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CSAT_RESPONDED_28D, NULL)) > 0, CAST(ROUND(100 * SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CSAT_GOOD_28D, NULL)) / SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM latest_complete_ticket_snapshot), ticket.COUNT_CSAT_RESPONDED_28D, NULL)), 1) AS DOUBLE), NULL) AS csat_score_pct,
  IFF(SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CSAT_RESPONDED_28D, NULL)) > 0, CAST(ROUND(100 * SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CSAT_GOOD_28D, NULL)) / SUM(IFF(ticket.SOURCE_SNAPSHOT_DATE = (SELECT snapshot_date FROM year_ago_ticket_snapshot), ticket.COUNT_CSAT_RESPONDED_28D, NULL)), 1) AS DOUBLE), NULL) AS year_ago_csat_score_pct
FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT AS ticket
JOIN account_instances AS instance ON ticket.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
WHERE ticket.SOURCE_SNAPSHOT_DATE IN (
  (SELECT snapshot_date FROM latest_complete_ticket_snapshot),
  (SELECT snapshot_date FROM year_ago_ticket_snapshot)
)
`.trim();
}

export function buildRbaAccountInstancesSql(accountId, selectMostCompleteInstance) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return selectMostCompleteInstance
    ? `SELECT account.ZENDESK_ACCOUNT_ID
       FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS AS account
       JOIN PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW AS rba
         ON rba.INSTANCE_ACCOUNT_ID = account.ZENDESK_ACCOUNT_ID
       WHERE account.CRM_ACCOUNT_ID = '${accountId}'
         AND account.ZENDESK_ACCOUNT_ID IS NOT NULL
         AND rba.MONTH_YEAR < (YEAR(CURRENT_DATE()) * 100 + MONTH(CURRENT_DATE()))
         AND ${RBA_HUMAN_SUPPORT_TICKET_FILTER}
       GROUP BY account.ZENDESK_ACCOUNT_ID
       QUALIFY ROW_NUMBER() OVER (
         ORDER BY COUNT(DISTINCT rba.MONTH_YEAR) DESC, MAX(rba.MONTH_YEAR) DESC, account.ZENDESK_ACCOUNT_ID
       ) = 1`
    : `SELECT DISTINCT ZENDESK_ACCOUNT_ID
       FROM FUNCTIONAL.GROWTH_ENGINE.DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS
       WHERE CRM_ACCOUNT_ID = '${accountId}'
         AND ZENDESK_ACCOUNT_ID IS NOT NULL`;
}

export function buildRbaPerformanceMetricsSql(accountId, { trendMonths = 6, selectMostCompleteInstance = false } = {}) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  if (!Number.isInteger(trendMonths) || trendMonths < 1 || trendMonths > 12) {
    throw new BetaError("INVALID_TREND_WINDOW", "trendMonths must be an integer from 1 to 12.");
  }
  const accountInstances = buildRbaAccountInstancesSql(accountId, selectMostCompleteInstance);
  return `
WITH account_instances AS (
  ${accountInstances}
), latest_complete_rba_month AS (
  SELECT MAX(rba.MONTH_YEAR) AS month_year
  FROM PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW AS rba
  JOIN account_instances AS instance ON rba.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE rba.MONTH_YEAR < (YEAR(CURRENT_DATE()) * 100 + MONTH(CURRENT_DATE()))
    AND ${RBA_HUMAN_SUPPORT_TICKET_FILTER}
), rba_available_months AS (
  SELECT DISTINCT rba.MONTH_YEAR AS month_year
  FROM PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW AS rba
  JOIN account_instances AS instance ON rba.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE rba.MONTH_YEAR < (YEAR(CURRENT_DATE()) * 100 + MONTH(CURRENT_DATE()))
    AND ${RBA_HUMAN_SUPPORT_TICKET_FILTER}
), rba_trend_months AS (
  SELECT month_year
  FROM rba_available_months
  QUALIFY ROW_NUMBER() OVER (ORDER BY month_year DESC) <= ${trendMonths}
), year_ago_rba_month AS (
  SELECT TO_NUMBER(TO_CHAR(DATEADD(year, -1, TO_DATE(TO_VARCHAR(month_year) || '01', 'YYYYMMDD')), 'YYYYMM')) AS month_year
  FROM latest_complete_rba_month
), rba_trend_metrics AS (
  SELECT rba.MONTH_YEAR AS month_year,
    CAST(SUM(rba.RBA_CREATED_TICKETS) AS DOUBLE) AS tickets_created,
    CAST(SUM(rba.RBA_SOLVED_TICKETS) AS DOUBLE) AS tickets_solved,
    IFF(COUNT(DISTINCT rba.RBA_FRT_MEDIAN_HOURS) = 1, CAST(MAX(rba.RBA_FRT_MEDIAN_HOURS) AS DOUBLE), NULL) AS median_first_reply_hours,
    IFF(COUNT(DISTINCT rba.RBA_TTC_MEDIAN_HOURS) = 1, CAST(MAX(rba.RBA_TTC_MEDIAN_HOURS) AS DOUBLE), NULL) AS median_resolution_hours,
    IFF(COUNT(DISTINCT rba.RBA_ZERO_TOUCH_TICKET_RATIO) = 1, CAST(MAX(rba.RBA_ZERO_TOUCH_TICKET_RATIO) AS DOUBLE), NULL) AS zero_touch_ticket_ratio,
    IFF(COUNT(DISTINCT rba.RBA_ONE_TOUCH_TICKET_RATIO) = 1, CAST(MAX(rba.RBA_ONE_TOUCH_TICKET_RATIO) AS DOUBLE), NULL) AS one_touch_ticket_ratio
  FROM PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW AS rba
  JOIN account_instances AS instance ON rba.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE rba.MONTH_YEAR IN (SELECT month_year FROM rba_trend_months)
    AND ${RBA_HUMAN_SUPPORT_TICKET_FILTER}
  GROUP BY rba.MONTH_YEAR
)
SELECT
  (SELECT month_year FROM latest_complete_rba_month) AS rba_metrics_month,
  (SELECT month_year FROM year_ago_rba_month) AS year_ago_rba_metrics_month,
  'human_support' AS rba_ticket_scope,
  (
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
      'period', TO_VARCHAR(month_year),
      'tickets_created', tickets_created,
      'tickets_solved', tickets_solved,
      'median_first_reply_hours', median_first_reply_hours,
      'median_resolution_hours', median_resolution_hours,
      'zero_touch_ticket_ratio', zero_touch_ticket_ratio,
      'one_touch_ticket_ratio', one_touch_ticket_ratio
    )) WITHIN GROUP (ORDER BY month_year)
    FROM rba_trend_metrics
  ) AS rba_trend_series,
  CAST(COUNT(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_CREATED_TICKETS, NULL)) AS DOUBLE) AS created_ticket_value_count,
  CAST(SUM(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_CREATED_TICKETS, NULL)) AS DOUBLE) AS rba_created_tickets,
  CAST(COUNT(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_CREATED_TICKETS, NULL)) AS DOUBLE) AS year_ago_created_ticket_value_count,
  CAST(SUM(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_CREATED_TICKETS, NULL)) AS DOUBLE) AS year_ago_rba_created_tickets,
  CAST(COUNT(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_SOLVED_TICKETS, NULL)) AS DOUBLE) AS solved_ticket_value_count,
  CAST(SUM(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_SOLVED_TICKETS, NULL)) AS DOUBLE) AS rba_solved_tickets,
  CAST(COUNT(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_SOLVED_TICKETS, NULL)) AS DOUBLE) AS year_ago_solved_ticket_value_count,
  CAST(SUM(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_SOLVED_TICKETS, NULL)) AS DOUBLE) AS year_ago_rba_solved_tickets,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_FRT_MEDIAN_HOURS, NULL)) AS DOUBLE) AS first_reply_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_FRT_MEDIAN_HOURS, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_FRT_MEDIAN_HOURS, NULL)) AS DOUBLE), NULL) AS median_first_reply_hours,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_FRT_MEDIAN_HOURS, NULL)) AS DOUBLE) AS year_ago_first_reply_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_FRT_MEDIAN_HOURS, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_FRT_MEDIAN_HOURS, NULL)) AS DOUBLE), NULL) AS year_ago_median_first_reply_hours,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_TTC_MEDIAN_HOURS, NULL)) AS DOUBLE) AS resolution_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_TTC_MEDIAN_HOURS, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_TTC_MEDIAN_HOURS, NULL)) AS DOUBLE), NULL) AS median_resolution_hours,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_TTC_MEDIAN_HOURS, NULL)) AS DOUBLE) AS year_ago_resolution_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_TTC_MEDIAN_HOURS, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_TTC_MEDIAN_HOURS, NULL)) AS DOUBLE), NULL) AS year_ago_median_resolution_hours,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_ZERO_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE) AS zero_touch_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_ZERO_TOUCH_TICKET_RATIO, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_ZERO_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE), NULL) AS zero_touch_ticket_ratio,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_ZERO_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE) AS year_ago_zero_touch_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_ZERO_TOUCH_TICKET_RATIO, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_ZERO_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE), NULL) AS year_ago_zero_touch_ticket_ratio,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_ONE_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE) AS one_touch_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_ONE_TOUCH_TICKET_RATIO, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM latest_complete_rba_month), rba.RBA_ONE_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE), NULL) AS one_touch_ticket_ratio,
  CAST(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_ONE_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE) AS year_ago_one_touch_value_count,
  IFF(COUNT(DISTINCT IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_ONE_TOUCH_TICKET_RATIO, NULL)) = 1, CAST(MAX(IFF(rba.MONTH_YEAR = (SELECT month_year FROM year_ago_rba_month), rba.RBA_ONE_TOUCH_TICKET_RATIO, NULL)) AS DOUBLE), NULL) AS year_ago_one_touch_ticket_ratio
FROM PROPAGATED_FUNCTIONAL.PRODUCT_ANALYTICS.FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW AS rba
JOIN account_instances AS instance ON rba.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
WHERE rba.MONTH_YEAR IN (
  (SELECT month_year FROM latest_complete_rba_month),
  (SELECT month_year FROM year_ago_rba_month)
)
  AND ${RBA_HUMAN_SUPPORT_TICKET_FILTER}
`.trim();
}

/**
 * Guide views are a separate engagement metric. This query deliberately uses
 * the same RBA-selected instance as the support-operation table, so a
 * multi-instance account is never silently compared across different
 * instances. Views include every recorded viewer role and are not a
 * self-service-deflection measure.
 */
export function buildGuideKnowledgeViewMetricsSql(accountId, { trendMonths = 6, selectMostCompleteInstance = false } = {}) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  if (!Number.isInteger(trendMonths) || trendMonths < 1 || trendMonths > 12) {
    throw new BetaError("INVALID_TREND_WINDOW", "trendMonths must be an integer from 1 to 12.");
  }
  const accountInstances = buildRbaAccountInstancesSql(accountId, selectMostCompleteInstance);
  return `
WITH account_instances AS (
  ${accountInstances}
), latest_complete_guide_month AS (
  SELECT MAX(DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE)) AS month_start
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT AS guide
  JOIN account_instances AS instance ON guide.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE guide.SOURCE_SNAPSHOT_DATE < DATE_TRUNC('MONTH', CURRENT_DATE())
), guide_available_months AS (
  SELECT DISTINCT DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) AS month_start
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT AS guide
  JOIN account_instances AS instance ON guide.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE guide.SOURCE_SNAPSHOT_DATE < DATE_TRUNC('MONTH', CURRENT_DATE())
), guide_trend_months AS (
  SELECT month_start
  FROM guide_available_months
  QUALIFY ROW_NUMBER() OVER (ORDER BY month_start DESC) <= ${trendMonths}
), year_ago_guide_month AS (
  SELECT DATEADD(YEAR, -1, month_start) AS month_start
  FROM latest_complete_guide_month
), guide_trend_metrics AS (
  SELECT DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) AS month_start,
    CAST(SUM(guide.COUNT_GUIDE_ARTICLE_VIEWS) AS DOUBLE) AS knowledge_views
  FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT AS guide
  JOIN account_instances AS instance ON guide.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) IN (SELECT month_start FROM guide_trend_months)
  GROUP BY DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE)
)
SELECT
  TO_NUMBER(TO_CHAR((SELECT month_start FROM latest_complete_guide_month), 'YYYYMM')) AS guide_knowledge_views_month,
  TO_NUMBER(TO_CHAR((SELECT month_start FROM year_ago_guide_month), 'YYYYMM')) AS year_ago_guide_knowledge_views_month,
  (
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
      'period', TO_CHAR(month_start, 'YYYYMM'),
      'knowledge_views', knowledge_views
    )) WITHIN GROUP (ORDER BY month_start)
    FROM guide_trend_metrics
  ) AS guide_knowledge_view_trend_series,
  CAST(COUNT(DISTINCT IFF(DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) = (SELECT month_start FROM latest_complete_guide_month), guide.SOURCE_SNAPSHOT_DATE, NULL)) AS DOUBLE) AS guide_knowledge_view_value_count,
  CAST(SUM(IFF(DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) = (SELECT month_start FROM latest_complete_guide_month), guide.COUNT_GUIDE_ARTICLE_VIEWS, NULL)) AS DOUBLE) AS guide_knowledge_views,
  CAST(COUNT(DISTINCT IFF(DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) = (SELECT month_start FROM year_ago_guide_month), guide.SOURCE_SNAPSHOT_DATE, NULL)) AS DOUBLE) AS year_ago_guide_knowledge_view_value_count,
  CAST(SUM(IFF(DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) = (SELECT month_start FROM year_ago_guide_month), guide.COUNT_GUIDE_ARTICLE_VIEWS, NULL)) AS DOUBLE) AS year_ago_guide_knowledge_views
FROM FUNCTIONAL.PRODUCT_ANALYTICS.FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT AS guide
JOIN account_instances AS instance ON guide.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
WHERE DATE_TRUNC('MONTH', guide.SOURCE_SNAPSHOT_DATE) IN (
  (SELECT month_start FROM latest_complete_guide_month),
  (SELECT month_start FROM year_ago_guide_month)
)
`.trim();
}

function normalizeContacts(rows, performanceMetricRow, sourceStates = {}) {
  const resolvedSourceStates = {
    account_identity: "checked",
    gainsight_operational_context: "checked",
    salesforce_contact_identity: "checked",
    contact_snapshot: "checked",
    salesforce_activity: "checked",
    gong_metadata_180_days: "checked",
    product_performance_metrics: "checked",
    rba_monthly_metrics: "checked",
    guide_knowledge_views: "checked",
    company_profile: "checked",
    team_setup: "checked",
    tech_stack: "checked",
    ...sourceStates,
  };
  const contacts = [];
  const gmailAddresses = [];
  let brief = null;
  for (const row of rows) {
    const accountId = field(row, "ACCOUNT_ID");
    const accountName = field(row, "ACCOUNT_NAME");
    if (typeof accountId !== "string" || !accountId || typeof accountName !== "string" || !accountName) {
      throw new BetaError("ACCOUNT_NOT_IN_CURRENT_BOOK", "The selected account is not available in the signed-in CSM's current book.");
    }
    if (!brief) {
      brief = {
        account_ref: opaqueRef("account", accountId),
        account_name: accountName,
        current_csm_name: field(row, "CSM_NAME"),
        account_health: field(row, "ACCOUNT_HEALTH"),
        cs_segment: field(row, "CS_SEGMENT"),
        market_segment: field(row, "MARKET_SEGMENT"),
        net_arr_usd: field(row, "NET_ARR_USD"),
        billing_country: field(row, "BILLING_COUNTRY"),
        outreach_language: recommendedOutreachLanguage(field(row, "BILLING_COUNTRY")),
        open_cta_count: Number(field(row, "OPEN_CTA_COUNT") || 0),
        earliest_open_cta_due_at: field(row, "EARLIEST_OPEN_CTA_DUE_AT"),
        company_profile: {
          industry: field(row, "COMPANY_INDUSTRY"),
          type: field(row, "COMPANY_TYPE"),
          employee_count: numberField(row, "COMPANY_EMPLOYEE_COUNT"),
          headquarters: {
            city: field(row, "COMPANY_HQ_CITY"),
            state: field(row, "COMPANY_HQ_STATE"),
            country: field(row, "COMPANY_HQ_COUNTRY"),
          },
          website: field(row, "COMPANY_WEBSITE"),
        },
        team_setup: {
          instance_count: numberField(row, "TEAM_SETUP_INSTANCE_COUNT"),
          active_agent_count: numberField(row, "TEAM_SETUP_ACTIVE_AGENT_COUNT"),
          sla_active: field(row, "TEAM_SETUP_SLA_ACTIVE"),
          security_covered_instance_count: numberField(row, "TEAM_SETUP_SECURITY_COVERED_INSTANCE_COUNT"),
          custom_role_instance_count: numberField(row, "TEAM_SETUP_CUSTOM_ROLE_INSTANCE_COUNT"),
          basic_rule_types_adopted_max: numberField(row, "TEAM_SETUP_BASIC_RULE_TYPES_ADOPTED_MAX"),
          configuration_snapshot_dates: {
            security: sourceSnapshotDateRange(row, "TEAM_SETUP_SECURITY"),
            basic_tools: sourceSnapshotDateRange(row, "TEAM_SETUP_BASIC_TOOLS"),
            guide_connectors: sourceSnapshotDateRange(row, "TECH_STACK_GUIDE_CONNECTOR"),
          },
        },
        tech_stack: {
          sso_enabled_instance_count: numberField(row, "TECH_STACK_SSO_ENABLED_INSTANCE_COUNT"),
          guide_external_connector_instance_count: numberField(row, "TECH_STACK_GUIDE_EXTERNAL_CONNECTOR_INSTANCE_COUNT"),
          marketplace_app_names: arrayField(row, "TECH_STACK_MARKETPLACE_APP_NAMES"),
          max_active_webhook_count: numberField(row, "TECH_STACK_MAX_ACTIVE_WEBHOOK_COUNT"),
          webhook_active_usage_instance_count: numberField(row, "TECH_STACK_WEBHOOK_ACTIVE_USAGE_INSTANCE_COUNT"),
          api_active_usage_instance_count: numberField(row, "TECH_STACK_API_ACTIVE_USAGE_INSTANCE_COUNT"),
          max_api_ticket_percent: numberField(row, "TECH_STACK_MAX_API_TICKET_PERCENT"),
          max_private_app_count: numberField(row, "TECH_STACK_MAX_PRIVATE_APP_COUNT"),
        },
        product_adoption: {
          guide: {
            snapshot_date: field(row, "GUIDE_SNAPSHOT_DATE"),
            eligible: field(row, "GUIDE_ELIGIBLE"),
            activated: field(row, "GUIDE_ACTIVATED"),
            adopted: field(row, "GUIDE_ADOPTED"),
          },
          copilot_paid: {
            snapshot_date: field(row, "COPILOT_SNAPSHOT_DATE"),
            penetrated: field(row, "COPILOT_PAID_PENETRATED"),
            activated: field(row, "COPILOT_PAID_ACTIVATED"),
            adopted: field(row, "COPILOT_PAID_ADOPTED"),
          },
          copilot_unpaid: {
            snapshot_date: field(row, "COPILOT_SNAPSHOT_DATE"),
            penetrated: field(row, "COPILOT_UNPAID_PENETRATED"),
            activated: field(row, "COPILOT_UNPAID_ACTIVATED"),
            adopted: field(row, "COPILOT_UNPAID_ADOPTED"),
          },
        },
        product_performance_metrics: buildPerformanceMetricTable(performanceMetricRow || {}),
        source_states: resolvedSourceStates,
      };
    }
    const contactId = field(row, "CONTACT_ID");
    const name = field(row, "CONTACT_NAME");
    if (contactId == null && name == null) continue;
    if (typeof contactId !== "string" || !contactId || typeof name !== "string" || !name) {
      throw new BetaError("CONTACT_EVIDENCE_RESPONSE_INVALID", "The contact-evidence response was missing a contact identity.");
    }
    const email = field(row, "CONTACT_EMAIL");
    if (typeof email === "string" && email.trim()) gmailAddresses.push(email.trim());
    contacts.push({
      contact_ref: opaqueRef("contact", contactId),
      display_name: name,
      role: field(row, "CONTACT_TITLE"),
      email_availability: typeof email === "string" && email.trim() ? "available" : "missing",
      identity_status: contactIdentityStatus({ name, email }),
      recipient_eligible: contactIdentityStatus({ name, email }) === "eligible" && copyReadyEmail(email) != null,
      salesforce_activity_count: Number(field(row, "SALESFORCE_ACTIVITY_COUNT") || 0),
      latest_salesforce_activity_at: field(row, "LATEST_ACTIVITY_AT"),
      gong_meeting_count: Number(field(row, "GONG_MEETING_COUNT") || 0),
      latest_gong_meeting_at: field(row, "LATEST_MEETING_AT"),
      salesforce_activity_state: resolvedSourceStates.salesforce_activity,
      gong_metadata_state: resolvedSourceStates.gong_metadata_180_days,
      latest_recorded_sales_touch_at: field(row, "LATEST_SALES_TOUCH_AT"),
      sales_touch_state: resolvedSourceStates.contact_snapshot,
    });
  }
  return { brief, contacts, gmailAddresses: [...new Set(gmailAddresses)] };
}

const CONTACT_TITLE_TIERS = [
  {
    score: 100,
    label: "support or service role",
    words: ["support", "soporte", "suporte", "atencion", "atención", "customer service", "customer success", "helpdesk", "help desk", "service desk", "cx", "servicio"],
  },
  {
    score: 70,
    label: "IT or operations role",
    words: ["operations", "operaciones", "it ", "sistemas", "technical", "técnico", "tecnico", "admin", "quality", "calidad"],
  },
  {
    score: 50,
    label: "executive role",
    words: ["ceo", "cto", "coo", "cio", "cfo", "chief", "founder", "director", "head of", "vp ", "vice president", "owner", "partner", "general manager"],
  },
];
const CONTACT_TITLE_OTHER_SCORE = 30;
const CONTACT_TITLE_BLANK_SCORE = 10;
const GONG_PARTNER_PENALTY = 70;
const ROLE_MAILBOX_LOCAL_RE = /^(info|support|soporte|suporte|helpdesk|help|sat|atencion|admin|administracion|administracao|administration|administrative|zendesk|contact|contacto|hello|hola|ventas|sales|noreply|no-reply|facturacion|billing|rrhh|hr|it|sistemas|tech|team|equipo|gestion|general|office|mail|email)([.\-_+]|$)/i;
const PLACEHOLDER_NAME_RE = /^(unknown|n\/?a|not available|placeholder)$/i;
const COPY_READY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRoleMailbox(email) {
  // Match whole department tokens, including accent variants, without treating
  // longer personal local parts or a person's surname suffix as a shared inbox.
  const local = typeof email === "string"
    ? email.trim().split("@", 1)[0].normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase() : "";
  return Boolean(local) && (local.includes("zendesk") || ROLE_MAILBOX_LOCAL_RE.test(local));
}

function contactIdentityStatus({ name, email }) {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName || PLACEHOLDER_NAME_RE.test(normalizedName) || /\bunknown\b/i.test(normalizedName)) return "placeholder";
  if (typeof email !== "string" || !email.trim()) return "email_missing";
  if (isRoleMailbox(email)) return "role_mailbox";
  return "eligible";
}

function copyReadyEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim();
  return COPY_READY_EMAIL_RE.test(normalized) ? normalized : null;
}

/** Raw bindings remain owner-bound memory inside the existing evidence run, never its public projection. */
function bindRuntimeContactDetails(evidence, rows, accountId) {
  const ids = new Map();
  const emails = new Map();
  for (const row of rows) {
    const id = field(row, "CONTACT_ID");
    if (typeof id !== "string" || !id) continue;
    const ref = opaqueRef("contact", id);
    if (ids.has(ref)) throw new BetaError("CONTACT_DETAIL_IDENTITY_AMBIGUOUS", "The contact snapshot returned a repeated contact reference.");
    ids.set(ref, id);
    const email = copyReadyEmail(field(row, "CONTACT_EMAIL"));
    if (email && contactIdentityStatus({ name: field(row, "CONTACT_NAME"), email }) === "eligible") emails.set(ref, email);
  }
  const needsLookup = evidence.contacts.some(c => c.identity_status === "email_missing"
    || (c.identity_status === "eligible" && c.recipient_eligible === false));
  const priority = new Map(prioritizedContacts(evidence.contacts, MAX_CONTACTS, new Date(evidence.read_at))
    .map((contact, index) => [contact.contact_ref, index + 1]));
  evidence.contacts = evidence.contacts.map(c => ({ ...c, ...(priority.has(c.contact_ref) ? { snapshot_priority_rank: priority.get(c.contact_ref) } : {}) }));
  if (needsLookup) {
    evidence.contacts = evidence.contacts.map(c => c.identity_status === "email_missing" || (c.identity_status === "eligible" && c.recipient_eligible === false)
      ? { ...c, recipient_eligible: false, contact_detail_state: "pending" } : c);
    evidence.source_states.salesforce_identity = "not_requested";
    evidence.source_states.contact_details = "pending";
    evidence.brief.source_states.salesforce_contact_identity = "not_requested";
  }
  Object.defineProperties(evidence, {
    runtimeContactIds: { value: ids, enumerable: false },
    runtimeContactEmails: { value: emails, enumerable: false },
    runtimeContactAccountId: { value: accountId, enumerable: false },
  });
  evidence.gmail_metadata_request = buildGmailMetadataRequest([...emails.values()]);
  return evidence;
}

function pendingContactIds(evidence) {
  return evidence.contacts.filter(c => c.identity_status !== "placeholder" && c.identity_status !== "role_mailbox"
    && (c.contact_detail_state === "pending" || (c.identity_status === "eligible" && c.recipient_eligible === false)))
    .map(c => evidence.runtimeContactIds?.get(c.contact_ref)).filter(Boolean);
}

/** Validate the whole source response before allowing any matched email into recipient evidence. */
export function applyContactDetailLookup(coreEvidence, rows, { accountId, state, now = new Date() } = {}) {
  if (!["checked", "timed_out", "unavailable", "not_run"].includes(state)) {
    throw new BetaError("INVALID_CONTACT_SOURCE_STATE", "Contact detail verification returned an unsupported source state.");
  }
  if (coreEvidence.runtimeContactAccountId !== accountId || !coreEvidence.runtimeContactIds || !Array.isArray(rows)) {
    throw new BetaError("CONTACT_DETAIL_ACCOUNT_MISMATCH", "Contact details do not match this account's in-memory selection.");
  }
  const requested = new Set(pendingContactIds(coreEvidence));
  const byId = new Map();
  if (state === "checked") for (const row of rows) {
    const id = field(row, "CONTACT_ID");
    if (field(row, "ACCOUNT_ID") !== accountId || !requested.has(id)) {
      throw new BetaError("CONTACT_DETAIL_ACCOUNT_MISMATCH", "The source returned a contact outside the selected account and contact references.");
    }
    if (byId.has(id)) throw new BetaError("CONTACT_DETAIL_IDENTITY_AMBIGUOUS", "The current identity source returned more than one record for a contact.");
    byId.set(id, row);
  }
  const emails = new Map(coreEvidence.runtimeContactEmails || []);
  const contacts = coreEvidence.contacts.map(contact => {
    const id = coreEvidence.runtimeContactIds.get(contact.contact_ref);
    if (!requested.has(id)) return contact;
    const row = byId.get(id);
    const email = row && copyReadyEmail(field(row, "CONTACT_EMAIL"));
    const name = row ? field(row, "CONTACT_NAME") : contact.display_name;
    const sourceStatus = row ? (contactIdentityStatus({ name, email: field(row, "CONTACT_EMAIL") }) === "eligible" && !email
      ? "email_invalid" : contactIdentityStatus({ name, email: field(row, "CONTACT_EMAIL") })) : "identity_unresolved";
    const status = sourceStatus === "placeholder" ? "identity_unresolved" : sourceStatus;
    if (status === "eligible" && email) emails.set(contact.contact_ref, email);
    else emails.delete(contact.contact_ref);
    return { ...contact, display_name: sourceStatus === "placeholder" ? contact.display_name : name || contact.display_name, role: row ? field(row, "CONTACT_TITLE") : contact.role,
      email_availability: email ? "available" : "missing", identity_status: status, recipient_eligible: status === "eligible" && Boolean(email),
      contact_detail_state: state !== "checked" ? state : !row ? "unmatched" : sourceStatus === "placeholder" ? "identity_unusable" : status === "eligible" ? "verified" : "email_unavailable",
      contact_detail_source: row ? "Salesforce contact formula view" : null };
  });
  const resolved = { ...coreEvidence, contacts,
    brief: { ...coreEvidence.brief, source_states: { ...coreEvidence.brief.source_states, salesforce_contact_identity: state } },
    source_states: { ...coreEvidence.source_states, salesforce_identity: state, contact_details: state },
    source_gap_codes: [...new Set([...(coreEvidence.source_gap_codes || []), ...(state === "checked" ? [] : [state === "timed_out" ? "CONTACT_DETAILS_TIMEOUT" : "CONTACT_DETAILS_UNAVAILABLE"])])],
    gmail_metadata_request: buildGmailMetadataRequest([...emails.values()]), read_at: now.toISOString() };
  Object.defineProperties(resolved, {
    runtimeContactIds: { value: coreEvidence.runtimeContactIds, enumerable: false },
    runtimeContactEmails: { value: emails, enumerable: false },
    runtimeContactAccountId: { value: accountId, enumerable: false },
  });
  return resolved;
}

function touchTime(contact, now) {
  const value = contact.latest_recorded_sales_touch_at;
  const timestamp = typeof value === "string" || value instanceof Date ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp <= now.getTime() ? timestamp : null;
}

function hasContactPriority(contact) {
  return contact.identity_status !== "placeholder" && (contact.identity_status !== "role_mailbox" || Number.isInteger(contact.snapshot_priority_rank));
}

/** Priority is independent of contactability. Unknown touch dates sort last and never mean no engagement. */
function prioritizedContacts(contacts, maxResults, now) {
  return contacts.filter(hasContactPriority)
    .map(c => ({ ...c, sales_touch_age_days: touchTime(c, now) == null ? null : Math.floor((now.getTime() - touchTime(c, now)) / 86400000),
      recipient_eligible: c.recipient_eligible !== false && (c.identity_status || "eligible") === "eligible" }))
    .sort((a, b) => (Number.isInteger(a.snapshot_priority_rank) && Number.isInteger(b.snapshot_priority_rank) ? a.snapshot_priority_rank - b.snapshot_priority_rank : 0)
      || (touchTime(b, now) ?? -Infinity) - (touchTime(a, now) ?? -Infinity)
      || titleTier(b.role).score - titleTier(a.role).score || a.display_name.localeCompare(b.display_name))
    .slice(0, maxResults);
}

function titleTier(role) {
  const title = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!title || title === "unknown") return { score: CONTACT_TITLE_BLANK_SCORE, label: "no recorded title" };
  const paddedTitle = ` ${title} `;
  const tier = CONTACT_TITLE_TIERS.find((candidate) => candidate.words.some((word) => paddedTitle.includes(word)));
  return tier ? { score: tier.score, label: tier.label } : { score: CONTACT_TITLE_OTHER_SCORE, label: "recorded title" };
}

/**
 * Returns a small, explainable shortlist, never the raw contact directory.
 * A recent recorded sales touch takes priority among usable contacts. Role is
 * then used to decide between similarly recent people. A materially stale
 * executive remains visible as a separate re-engagement option, not the
 * default outreach recipient. The touch does not claim the requesting CSM had
 * that interaction. Salesforce activity, Gong, and Gmail are optional later
 * context, not prerequisites.
 */
export function recommendContacts(contacts, sourceStates, maxResults = 3, now = new Date()) {
  const snapshotAvailable = sourceStates?.contact_snapshot !== "unavailable" && sourceStates?.contact_snapshot !== "timed_out";
  const touchRecencyScore = (value) => {
    const timestamp = typeof value === "string" || value instanceof Date ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp > now.getTime()) return { score: 0, band: 0, ageDays: null, label: "sales-touch date not established" };
    const ageDays = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
    if (ageDays <= 30) return { score: 500, band: 5, ageDays, label: "sales touch recorded in the last 30 days" };
    if (ageDays <= 90) return { score: 400, band: 4, ageDays, label: "sales touch recorded in the last 90 days" };
    if (ageDays <= 180) return { score: 300, band: 3, ageDays, label: "sales touch recorded in the last 180 days" };
    if (ageDays <= 365) return { score: 200, band: 2, ageDays, label: "sales touch recorded in the last year" };
    if (ageDays <= 730) return { score: 100, band: 1, ageDays, label: "sales touch recorded more than a year ago" };
    return { score: 0, band: 0, ageDays, label: "sales touch recorded more than two years ago" };
  };
  const eligible = contacts.filter((contact) => (contact.identity_status || "eligible") === "eligible" && contact.recipient_eligible !== false);
  const exclusionExplanations = {
    placeholder: "The source returned an unusable or placeholder name.",
    email_missing: "No email address was returned.",
    role_mailbox: "A shared mailbox was returned, not a named person's address.",
    email_invalid: "The returned address could not be verified as a usable email.",
    identity_unresolved: "Current contact details could not be verified for this account. The sales-touch priority is still visible.",
  };
  const excludedContacts = contacts.filter(contact => (contact.identity_status || "eligible") !== "eligible" || contact.recipient_eligible === false)
    .map(contact => ({
      ...(/^[a-f0-9]{64}$/.test(contact.contact_ref || "") ? { contact_ref: contact.contact_ref } : {}),
      display_name: contact.display_name || "Name not returned",
      reason_code: Object.hasOwn(exclusionExplanations, contact.identity_status) ? contact.identity_status : "identity_not_verified",
      explanation: exclusionExplanations[contact.identity_status] || "The source did not establish a usable contact identity.",
    }));
  const rejectionSummary = {};
  for (const contact of excludedContacts) rejectionSummary[contact.reason_code] = (rejectionSummary[contact.reason_code] || 0) + 1;
  const scored = eligible.map((contact) => {
    const tier = titleTier(contact.role);
    const salesTouch = touchRecencyScore(contact.latest_recorded_sales_touch_at);
    const partnerPenalty = contact.partner_affiliation === "partner" ? GONG_PARTNER_PENALTY : 0;
    const reasons = [tier.label, salesTouch.label];
    if (contact.partner_affiliation === "partner") reasons.push("partner contact, ranked below customer contacts where possible");
    return {
      ...contact,
      recommendation_score: salesTouch.score + tier.score - partnerPenalty,
      contact_recency_band: salesTouch.band,
      sales_touch_age_days: salesTouch.ageDays,
      contact_strategy: salesTouch.ageDays != null && salesTouch.ageDays > 365 && tier.label === "executive role"
        ? "executive_reengagement"
        : "primary_outreach",
      recommendation_reasons: reasons,
    };
  });
  const hasContactWithinLastYear = scored.some((contact) => contact.contact_recency_band >= 2);
  const primaryCandidates = hasContactWithinLastYear
    ? scored.filter((contact) => contact.contact_strategy !== "executive_reengagement")
    : scored;
  const sortContacts = (left, right) => (Number.isInteger(left.snapshot_priority_rank) && Number.isInteger(right.snapshot_priority_rank) ? left.snapshot_priority_rank - right.snapshot_priority_rank : 0)
    || (touchTime(right, now) ?? -Infinity) - (touchTime(left, now) ?? -Infinity)
    || right.recommendation_score - left.recommendation_score
    || left.display_name.localeCompare(right.display_name)
    || left.contact_ref.localeCompare(right.contact_ref);
  const ranked = primaryCandidates.sort(sortContacts);
  const secondaryExecutiveContacts = hasContactWithinLastYear
    ? scored.filter((contact) => contact.contact_strategy === "executive_reengagement").sort(sortContacts).slice(0, maxResults)
    : [];
  const state = ranked.length ? (snapshotAvailable ? "ranked" : "ranked_with_source_gaps") : "no_eligible_contacts";
  return {
    state,
    contacts: ranked.slice(0, maxResults),
    prioritized_contacts: prioritizedContacts(contacts, maxResults, now),
    prioritized_contact_count: contacts.filter(hasContactPriority).length,
    secondary_executive_contacts: secondaryExecutiveContacts,
    total_contact_count: contacts.length,
    eligible_contact_count: eligible.length,
    excluded_contact_count: contacts.length - eligible.length,
    rejection_summary: rejectionSummary,
    excluded_contacts: excludedContacts,
    message: !ranked.length && contacts.some(c => c.contact_detail_state)
      ? "Contact priorities are available, but no verified recipient is ready. Review each contact's detail-lookup state; unavailable email does not establish that the customer has no contacts."
      : !ranked.length
      ? "No contact is recommended from the returned records. Review the rejection reasons; this does not establish that the customer has no contacts."
      : snapshotAvailable
      ? "Ranked first by latest recorded sales touch, then by role relevance. A stale executive is shown separately as an executive re-engagement option when more recently engaged contacts are available. That touch is an indicator, not proof that you spoke with the person."
      : "Ranked by role relevance because the current contact snapshot was unavailable, so no sales-touch recency was used.",
  };
}

/** Turns one batch snapshot result into a compact shortlist per selected CTA account. */
export function presentBulkContactResearch(rows, selections, { now = new Date(), includeContactEmails = false } = {}) {
  if (!Array.isArray(rows) || !Array.isArray(selections)) {
    throw new BetaError("BULK_CONTACT_RESPONSE_INVALID", "Bulk contact research returned an invalid response.");
  }
  const selectionByAccountId = new Map(selections.map((selection) => [selection.accountId, selection]));
  const contactsByAccountId = new Map([...selectionByAccountId.keys()].map((accountId) => [accountId, []]));
  const candidateCounts = new Map();
  for (const row of rows) {
    const accountId = field(row, "ACCOUNT_ID");
    const contactId = field(row, "CONTACT_ID");
    const name = field(row, "CONTACT_NAME");
    if (!selectionByAccountId.has(accountId) || !contactId || !name) continue;
    const email = field(row, "CONTACT_EMAIL");
    contactsByAccountId.get(accountId).push({
      contact_ref: opaqueRef("contact", contactId),
      display_name: name,
      role: field(row, "CONTACT_TITLE"),
      email_availability: typeof email === "string" && email.trim() ? "available" : "missing",
      copy_ready_email: copyReadyEmail(email),
      identity_status: field(row, "CONTACT_VERIFICATION_REASON") === "role_mailbox"
        ? "role_mailbox" : contactIdentityStatus({ name, email }),
      latest_recorded_sales_touch_at: field(row, "LATEST_SALES_TOUCH_AT"),
      sales_touch_state: "checked",
    });
    candidateCounts.set(accountId, Number(field(row, "CANDIDATE_COUNT") || 0));
  }
  const recipientsByNormalizedEmail = new Map();
  const accounts = selections.map((selection) => {
    const contacts = contactsByAccountId.get(selection.accountId) || [];
    const shortlist = recommendContacts(contacts, { contact_snapshot: "checked" }, 3, now);
    const copyReadyEmailWarnings = includeContactEmails
      ? contacts
        .filter((contact) => contact.identity_status === "email_missing"
          || (contact.identity_status === "eligible" && !contact.copy_ready_email))
        .map((contact) => ({
          contact_ref: contact.contact_ref,
          display_name: contact.display_name,
          role: contact.role,
          reason: "missing_or_invalid_email",
        }))
      : [];
    const suggestedContacts = shortlist.contacts.map(({ copy_ready_email: email, ...contact }) => {
      if (!includeContactEmails) return contact;
      const normalizedEmail = email?.toLowerCase() || null;
      let copyReadyEmailState = "missing_or_invalid";
      if (normalizedEmail) {
        copyReadyEmailState = recipientsByNormalizedEmail.has(normalizedEmail) ? "duplicate_omitted" : "included";
        if (copyReadyEmailState === "included") {
          recipientsByNormalizedEmail.set(normalizedEmail, {
            email,
            account_display_name: selection.accountName,
            contact_display_name: contact.display_name,
            contact_ref: contact.contact_ref,
          });
        }
      }
      return {
        ...contact,
        email_address: email,
        copy_ready_email_state: copyReadyEmailState,
      };
    });
    return {
      work_item_ref: selection.workItemRef,
      account_display_name: selection.accountName,
      cta_priority: selection.priority || null,
      cta_title: selection.ctaTitle || null,
      candidate_count: candidateCounts.get(selection.accountId) || contacts.length,
      candidate_limit_reached: (candidateCounts.get(selection.accountId) || 0) > MAX_BULK_CONTACTS_PER_ACCOUNT,
      suggested_contacts: suggestedContacts,
      prioritized_contacts: shortlist.prioritized_contacts.map(({ copy_ready_email: _email, ...contact }) => contact),
      secondary_executive_contacts: shortlist.secondary_executive_contacts,
      copy_ready_email_warnings: copyReadyEmailWarnings,
      contact_recommendation_state: shortlist.state,
      contact_recommendation_message: shortlist.message,
      contact_counts: {
        total: shortlist.total_contact_count,
        eligible: shortlist.eligible_contact_count,
        excluded: shortlist.excluded_contact_count,
        shown: shortlist.contacts.length,
        prioritized: shortlist.prioritized_contact_count,
      },
      detail_lookup_next_action: !shortlist.contacts.length && shortlist.prioritized_contacts.length
        ? "Select this account for the managed same-contact detail lookup before using an email address. Do not infer that it has no contacts." : null,
    };
  });
  if (!includeContactEmails) return accounts;
  const recipients = [...recipientsByNormalizedEmail.values()];
  return {
    accounts,
    recipient_export: {
      status: recipients.length ? "ready" : "no_verified_recipients",
      scope: "primary_suggested_contacts_only",
      recipient_count: recipients.length,
      one_email_per_line: recipients.map((recipient) => recipient.email).join("\n"),
      comma_separated: recipients.map((recipient) => recipient.email).join(", "),
      omitted_contact_count: accounts.flatMap((account) => account.suggested_contacts)
        .filter((contact) => contact.copy_ready_email_state !== "included").length,
      user_notice: "These addresses are shown only for this review. Copy them into Clari Groove manually; no enrollment or message was created.",
    },
  };
}

export async function readBulkCoreContactEvidenceWithSession({ selections, session, now = new Date(), timeoutMs = CORE_CONTACT_IDENTITY_READ_TIMEOUT_MS, includeContactEmails = false } = {}) {
  const uniqueSelections = [...new Map((selections || []).map((selection) => [selection.accountId, selection])).values()];
  const startedAt = Date.now();
  let rows;
  try {
    rows = await session.query(buildBulkCoreContactIdentitySql(uniqueSelections.map((selection) => selection.accountId)), { timeoutMs });
  } catch (error) {
    if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") {
      throw new BetaError(
        "BULK_CONTACT_RESEARCH_TIMEOUT",
        `The contact snapshot did not return within ${timeoutMs / 1000} seconds for this batch. Nothing was saved. Narrow the batch and try again.`,
        { source: "contact_snapshot", deadline_seconds: timeoutMs / 1000 },
      );
    }
    throw new BetaError("BULK_CONTACT_RESEARCH_FAILED", "Bulk contact research could not be completed from the current contact snapshot.");
  }
  // Snapshot email fields are not an address-verification source. Keep the
  // selected rows in short-lived server memory for the separate Salesforce read.
  const presentation = presentBulkContactResearch(rows, uniqueSelections, { now, includeContactEmails: false });
  const result = {
    accounts: Array.isArray(presentation) ? presentation : presentation.accounts,
    recipient_export: null,
    email_verification_required: includeContactEmails === true,
    source: "FOUNDATIONAL.CUSTOMER.DIM_CRM_CONTACTS_DAILY_SNAPSHOT",
    source_states: { contact_snapshot: "checked", salesforce_activity: "not_requested", gong_metadata: "not_requested", gmail_metadata: "not_requested" },
    source_durations_ms: { contact_snapshot: Date.now() - startedAt },
    read_at: now.toISOString(),
  };
  Object.defineProperties(result, {
    runtimeSnapshotRows: { value: rows, enumerable: false },
    runtimeSelections: { value: uniqueSelections, enumerable: false },
  });
  return result;
}

/** Verify all snapshot-selected contacts once, then return at most three usable addresses per account. */
export async function verifyBulkContactDetailsWithSession({ snapshotRows, selections, session,
  includeContactEmails = false, now = new Date(), timeoutMs = 120_000 } = {}) {
  const sql = buildBulkContactDetailLookupSql(snapshotRows, selections);
  let detailRows = [];
  if (sql) try {
    detailRows = await session.query(sql, { timeoutMs });
  } catch (error) {
    const code = error?.code === "SNOWFLAKE_SESSION_TIMEOUT" ? "BULK_CONTACT_DETAILS_TIMEOUT" : "BULK_CONTACT_DETAILS_FAILED";
    throw new BetaError(code, code === "BULK_CONTACT_DETAILS_TIMEOUT"
      ? "The same-account Salesforce contact check timed out. The snapshot shortlist remains available; no address is verified."
      : "The same-account Salesforce contact check failed. The snapshot shortlist remains available; no address is verified.",
    { source: "salesforce_contact_details", deadline_seconds: timeoutMs / 1000 });
  }
  if (!Array.isArray(detailRows)) throw new BetaError("BULK_CONTACT_DETAILS_RESPONSE_INVALID", "The contact detail response was not a row list.");
  const expected = new Set(snapshotRows.map((row) => `${field(row, "ACCOUNT_ID")}:${field(row, "CONTACT_ID")}`));
  const details = new Map();
  for (const row of detailRows) {
    const pair = `${field(row, "ACCOUNT_ID")}:${field(row, "CONTACT_ID")}`;
    if (!expected.has(pair)) throw new BetaError("BULK_CONTACT_DETAIL_ACCOUNT_MISMATCH", "A contact detail did not match the selected account and contact.");
    if (details.has(pair)) throw new BetaError("BULK_CONTACT_DETAIL_IDENTITY_AMBIGUOUS", "The Salesforce contact view returned a repeated account/contact identity.");
    details.set(pair, row);
  }
  const warningsByAccount = new Map(selections.map((selection) => [selection.accountId, []]));
  const verifiedRows = snapshotRows.map((row) => {
    const accountId = field(row, "ACCOUNT_ID");
    const contactId = field(row, "CONTACT_ID");
    const detail = details.get(`${accountId}:${contactId}`);
    const email = detail ? copyReadyEmail(field(detail, "CONTACT_EMAIL")) : null;
    const sourceEmail = detail && field(detail, "CONTACT_EMAIL");
    const name = detail ? field(detail, "CONTACT_NAME") : field(row, "CONTACT_NAME");
    const identityStatus = detail ? contactIdentityStatus({ name, email: sourceEmail }) : null;
    const reason = !detail ? "unmatched_contact" : !email ? (sourceEmail ? "invalid_email" : "unavailable_email")
      : identityStatus === "role_mailbox" ? "role_mailbox" : identityStatus !== "eligible" ? "unusable_identity" : null;
    if (reason) warningsByAccount.get(accountId).push({
      contact_ref: opaqueRef("contact", contactId), display_name: field(row, "CONTACT_NAME"), reason,
    });
    return {
      ...row,
      CONTACT_NAME: name || field(row, "CONTACT_NAME"),
      CONTACT_TITLE: detail ? field(detail, "CONTACT_TITLE") : field(row, "CONTACT_TITLE"),
      CONTACT_EMAIL: reason ? null : email,
      CONTACT_VERIFICATION_REASON: reason,
    };
  });
  const presentation = presentBulkContactResearch(verifiedRows, selections, { now, includeContactEmails });
  const accounts = Array.isArray(presentation) ? presentation : presentation.accounts;
  for (const account of accounts) {
    const selection = selections.find((item) => item.workItemRef === account.work_item_ref);
    account.contact_verification_warnings = warningsByAccount.get(selection.accountId) || [];
    for (const contact of account.suggested_contacts) {
      if (contact.copy_ready_email_state === "duplicate_omitted") account.contact_verification_warnings.push({
        contact_ref: contact.contact_ref, display_name: contact.display_name, reason: "duplicate_email",
      });
    }
  }
  return {
    accounts,
    recipient_export: Array.isArray(presentation) ? null : presentation.recipient_export,
    source_states: { contact_snapshot: "checked", salesforce_contact_details: "checked" },
    read_at: now.toISOString(),
  };
}

/**
 * Combines the fast monthly metric reads with the authoritative selected-account
 * contact snapshot. Slower activity and Gong metadata can improve account
 * context, but they are never allowed to withhold the ranked shortlist.
 */
export function composeShortlistEvidence({ coreEvidence, fastEvidence = null, secondarySourceState = "pending" } = {}) {
  if (!coreEvidence?.brief || !Array.isArray(coreEvidence.contacts)) {
    throw new BetaError("CONTACT_IDENTITY_REQUIRED", "A Salesforce contact identity read is required before a contact shortlist can be prepared.");
  }
  if (!["pending", "timed_out", "unavailable"].includes(secondarySourceState)) {
    throw new BetaError("INVALID_CONTACT_SOURCE_STATE", "A slower contact source must be pending, timed out, or unavailable.");
  }
  const fastStates = fastEvidence?.source_states || {};
  const rbaState = fastStates.rba_monthly_metrics || "pending";
  const guideState = fastStates.guide_knowledge_views || "pending";
  const metricState = fastEvidence?.brief?.source_states?.product_performance_metrics || "pending";
  const secondarySourceGaps = secondarySourceState === "pending"
    ? []
    : [
      `SALESFORCE_ACTIVITY_${secondarySourceState.toUpperCase()}`,
      `GONG_METADATA_${secondarySourceState.toUpperCase()}`,
    ];
  const detailState = coreEvidence.source_states?.contact_details === "pending" && secondarySourceState !== "pending"
    ? secondarySourceState : coreEvidence.source_states?.contact_details;
  const detailIncomplete = detailState && detailState !== "checked" && detailState !== "pending";
  return {
    brief: {
      ...coreEvidence.brief,
      product_performance_metrics: fastEvidence?.brief?.product_performance_metrics || buildPerformanceMetricTable({}),
      source_states: {
        ...coreEvidence.brief.source_states,
        account_identity: "checked",
        gainsight_operational_context: secondarySourceState,
        salesforce_contact_identity: detailIncomplete ? detailState : coreEvidence.source_states?.salesforce_identity || "checked",
        contact_snapshot: coreEvidence.brief.source_states?.contact_snapshot || "checked",
        salesforce_activity: secondarySourceState,
        gong_metadata_180_days: secondarySourceState,
        product_performance_metrics: metricState,
        rba_monthly_metrics: rbaState,
        guide_knowledge_views: guideState,
      },
    },
    contacts: detailIncomplete ? coreEvidence.contacts.map(c => c.contact_detail_state === "pending"
      ? { ...c, contact_detail_state: detailState, recipient_eligible: false } : c) : coreEvidence.contacts,
    gmail_metadata_request: coreEvidence.gmail_metadata_request,
    source_states: {
      salesforce_identity: detailIncomplete ? detailState : coreEvidence.source_states?.salesforce_identity || "checked",
      ...(detailState ? { contact_details: detailState } : {}),
      contact_snapshot: coreEvidence.brief.source_states?.contact_snapshot || "checked",
      account_context: secondarySourceState,
      salesforce_activity: secondarySourceState,
      gong_metadata: secondarySourceState,
      rba_monthly_metrics: rbaState,
      guide_knowledge_views: guideState,
    },
    source_gap_codes: [...new Set([...(coreEvidence.source_gap_codes || []), ...(fastEvidence?.source_gap_codes || []), ...secondarySourceGaps,
      ...(detailIncomplete ? [detailState === "timed_out" ? "CONTACT_DETAILS_TIMEOUT" : "CONTACT_DETAILS_UNAVAILABLE"] : [])])],
    source_durations_ms: {
      ...(coreEvidence.source_durations_ms || {}),
      ...(fastEvidence?.source_durations_ms || {}),
    },
    gong_lookback_days: GONG_LOOKBACK_DAYS,
    read_at: fastEvidence?.read_at || coreEvidence.read_at,
  };
}

export function buildGmailMetadataRequest(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return null;
  }
  return {
    action: "gmail_search_email_ids",
    query: `(${addresses.map((address) => `from:${address} OR to:${address}`).join(" OR ")}) -in:spam -in:trash`,
    max_results: 25,
    required_follow_up: { action: "gmail_read_email", format: "metadata", max_messages: 25 },
    retention: "metadata_only",
  };
}

/** Preserve the evidence reader's private lookup requests; the server only projects reviewed facts. */
export function mergeFastContactDetails(fastEvidence, resolved) {
  const merged = { ...fastEvidence, contacts: resolved.contacts,
    gmail_metadata_request: resolved.gmail_metadata_request,
    brief: { ...fastEvidence.brief, source_states: { ...fastEvidence.brief.source_states,
      salesforce_contact_identity: resolved.source_states.salesforce_identity } },
    source_states: { ...fastEvidence.source_states, salesforce_identity: resolved.source_states.salesforce_identity,
      contact_details: resolved.source_states.contact_details },
    source_gap_codes: [...new Set([...(fastEvidence.source_gap_codes || []).filter(code => !code.startsWith("CONTACT_DETAILS_")), ...resolved.source_gap_codes])],
  };
  if (fastEvidence.monthly_metric_source_results) Object.defineProperty(merged, "monthly_metric_source_results",
    { value: fastEvidence.monthly_metric_source_results, enumerable: false });
  return merged;
}

function sourceRunner({ temporary, connectionName, runner, sourceDurationsMs }) {
  return (source, query, timeout) => {
    const sourceStartedAt = Date.now();
    const result = runner(
      "snow",
      ["--config-file", temporary.configPath, "sql", "-c", connectionName, "-q", query, "--format", "json"],
      { encoding: "utf8", timeout, env: temporary.env },
    );
    sourceDurationsMs[source] = Date.now() - sourceStartedAt;
    return result;
  };
}

function failedEnrichmentResult(coreEvidence, state, sourceDurationsMs) {
  const combinedState = state === "timed_out"
    ? "not_run_after_combined_enrichment_timeout"
    : "not_run_after_combined_enrichment_failure";
  const normalized = {
    ...coreEvidence,
    brief: {
      ...coreEvidence.brief,
      source_states: {
        ...coreEvidence.brief.source_states,
        salesforce_activity: combinedState,
        gong_metadata_180_days: combinedState,
        product_performance_metrics: "not_completed_after_enrichment_failure",
        rba_monthly_metrics: "not_started_after_enrichment_failure",
        guide_knowledge_views: "not_started_after_enrichment_failure",
      },
    },
    contacts: coreEvidence.contacts.map((contact) => ({ ...contact, salesforce_activity_state: combinedState, gong_metadata_state: combinedState })),
  };
  return {
    ...normalized,
    source_states: {
      salesforce_identity: "checked", salesforce_activity: combinedState, gong_metadata: combinedState,
      rba_monthly_metrics: "not_started_after_enrichment_failure", guide_knowledge_views: "not_started_after_enrichment_failure",
    },
    source_gap_codes: [state === "timed_out" ? "COMBINED_CONTACT_ENRICHMENT_TIMEOUT" : "COMBINED_CONTACT_ENRICHMENT_FAILED"],
    source_durations_ms: sourceDurationsMs,
  };
}

function sourceGapCode(source, state) {
  const suffix = state === "timed_out" ? "TIMEOUT" : "UNAVAILABLE";
  return `${source}_${suffix}`;
}

/** Combines independent source results without turning a missing result into zero. */
function mergeIndependentEnrichment(coreEvidence, results, sourceDurationsMs, now) {
  const context = results.account_context;
  const activity = results.salesforce_activity;
  const gong = results.gong_metadata;
  const rba = results.rba_monthly_metrics;
  const guide = results.guide_knowledge_views;
  const sourceStates = {
    salesforce_identity: coreEvidence.source_states?.salesforce_identity || "checked",
    contact_snapshot: coreEvidence.source_states?.contact_snapshot || "checked",
    ...(coreEvidence.source_states?.contact_details ? { contact_details: coreEvidence.source_states.contact_details } : {}),
    account_context: context.state,
    salesforce_activity: activity.state,
    gong_metadata: gong.state,
    rba_monthly_metrics: rba.state,
    guide_knowledge_views: guide.state,
  };
  const productMetricState = performanceMetricState(rba, guide);
  const normalizedContext = context.rows.length ? normalizeContacts(context.rows, {
    ...(rba.rows[0] || {}), ...(guide.rows[0] || {}),
  }, {
    account_identity: context.state,
    gainsight_operational_context: context.state,
    salesforce_contact_identity: coreEvidence.source_states?.salesforce_identity || "checked",
    salesforce_activity: activity.state,
    gong_metadata_180_days: gong.state,
    product_performance_metrics: productMetricState,
    rba_monthly_metrics: rba.state,
    guide_knowledge_views: guide.state,
  }) : null;
  const activityByContact = new Map(activity.rows.map((row) => [opaqueRef("contact", field(row, "CONTACT_ID")), row]));
  const gongByContact = new Map(gong.rows.map((row) => [opaqueRef("contact", field(row, "CONTACT_ID")), row]));
  const contacts = coreEvidence.contacts.map((contact) => {
    const activityRow = activityByContact.get(contact.contact_ref);
    const gongRow = gongByContact.get(contact.contact_ref);
    return {
      ...contact,
      salesforce_activity_count: activityRow ? Number(field(activityRow, "SALESFORCE_ACTIVITY_COUNT") || 0) : 0,
      latest_salesforce_activity_at: activityRow ? field(activityRow, "LATEST_ACTIVITY_AT") : null,
      gong_meeting_count: gongRow ? Number(field(gongRow, "GONG_MEETING_COUNT") || 0) : gong.state === "checked" ? 0 : null,
      latest_gong_meeting_at: gongRow ? field(gongRow, "LATEST_MEETING_AT") : null,
      ...(gong.state !== "checked" ? { gong_match_state: "source_unavailable" }
        : context.state === "checked" ? { gong_match_state: gongRow
          ? "matching_metadata_in_bounded_read" : "no_matching_metadata_in_bounded_read" } : {}),
      salesforce_activity_state: activity.state,
      gong_metadata_state: gong.state,
    };
  });
  const incompleteSources = Object.entries(results).filter(([, result]) => result.state !== "checked");
  return {
    brief: normalizedContext?.brief || {
      ...coreEvidence.brief,
      product_performance_metrics: buildPerformanceMetricTable({ ...(rba.rows[0] || {}), ...(guide.rows[0] || {}) }),
      source_states: {
        ...coreEvidence.brief.source_states,
        account_identity: context.state,
        gainsight_operational_context: context.state,
        salesforce_activity: activity.state,
        gong_metadata_180_days: gong.state,
        product_performance_metrics: productMetricState,
        rba_monthly_metrics: rba.state,
        guide_knowledge_views: guide.state,
      },
    },
    contacts,
    gmail_metadata_request: coreEvidence.gmail_metadata_request,
    source_states: sourceStates,
    source_gap_codes: [...new Set([...(coreEvidence.source_gap_codes || []), ...incompleteSources.map(([source, result]) => sourceGapCode(source.toUpperCase(), result.state))])],
    source_durations_ms: sourceDurationsMs,
    source_diagnostics: Object.fromEntries(Object.entries(results)
      .filter(([, result]) => result?.diagnostics)
      .map(([source, result]) => [source, result.diagnostics])),
    gong_lookback_days: GONG_LOOKBACK_DAYS,
    read_at: now.toISOString(),
  };
}

export function readCoreContactEvidence({ accountId, connectionName = "zdp-global", runner = spawnSync, now = new Date() } = {}) {
  const temporary = createTemporarySnowflakeConfig();
  const sourceDurationsMs = {};
  try {
    const runRead = sourceRunner({ temporary, connectionName, runner, sourceDurationsMs });
    const result = runRead("salesforce_contact_identity", buildCoreContactIdentitySql(accountId), CORE_CONTACT_IDENTITY_READ_TIMEOUT_MS);
    if (result.error?.code === "ETIMEDOUT") {
      throw new BetaError(
        "CONTACT_IDENTITY_READ_TIMEOUT",
        "The account and Salesforce-contact identity read did not return within 25 seconds. Nothing was saved. Do not retry this account in the same run; the Snowflake connection is verified but this source did not respond within the first-response budget.",
        { source: "salesforce_contact_identity", deadline_seconds: CORE_CONTACT_IDENTITY_READ_TIMEOUT_MS / 1000, retry_same_run: false },
      );
    }
    if (result.error || result.status !== 0) {
      throw new BetaError("CONTACT_IDENTITY_READ_FAILED", "The account and Salesforce-contact identity read could not be completed. Check the approved source and try again in a new run.");
    }
    const rows = parseRows(result.stdout);
    if (rows.length === 0) {
      throw new BetaError("ACCOUNT_NOT_IN_CURRENT_BOOK", "The selected account is not available in the signed-in CSM's current book.");
    }
    const normalized = normalizeContacts(rows, {}, {
      gainsight_operational_context: "scope_checked_pending_enrichment",
      salesforce_activity: "pending",
      gong_metadata_180_days: "pending",
      product_performance_metrics: "pending",
      rba_monthly_metrics: "pending",
      guide_knowledge_views: "pending",
    });
    return {
      brief: normalized.brief,
      contacts: normalized.contacts,
      gmail_metadata_request: buildGmailMetadataRequest(normalized.gmailAddresses, now),
      source_states: {
        salesforce_identity: "checked",
        salesforce_activity: "pending",
        gong_metadata: "pending",
        rba_monthly_metrics: "pending",
        guide_knowledge_views: "pending",
      },
      source_gap_codes: [],
      source_durations_ms: sourceDurationsMs,
      gong_lookback_days: GONG_LOOKBACK_DAYS,
      read_at: now.toISOString(),
    };
  } finally {
    temporary.cleanup();
  }
}

export function presentCoreContactEvidence(rows, { now = new Date(), sourceDurationMs } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new BetaError("ACCOUNT_NOT_IN_CURRENT_BOOK", "The selected account is not available in the signed-in CSM's current book.");
  }
  const normalized = normalizeContacts(rows, {}, {
    gainsight_operational_context: "scope_checked_pending_enrichment",
    salesforce_activity: "pending", gong_metadata_180_days: "pending",
    product_performance_metrics: "pending", rba_monthly_metrics: "pending", guide_knowledge_views: "pending",
  });
  return {
    brief: normalized.brief, contacts: normalized.contacts,
    gmail_metadata_request: buildGmailMetadataRequest(normalized.gmailAddresses, now),
    source_states: { salesforce_identity: "checked", salesforce_activity: "pending", gong_metadata: "pending", rba_monthly_metrics: "pending", guide_knowledge_views: "pending" },
    source_gap_codes: [],
    source_durations_ms: { salesforce_contact_identity: sourceDurationMs },
    gong_lookback_days: GONG_LOOKBACK_DAYS, read_at: now.toISOString(),
  };
}

/** Reads only account/contact identity through the authenticated active-case session. */
export async function readCoreContactEvidenceWithSession({ accountId, accountName = "Selected account", session, now = new Date(), timeoutMs = CORE_CONTACT_IDENTITY_READ_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  let rows;
  try {
    rows = await session.query(buildCoreContactIdentitySql(accountId), { timeoutMs });
  } catch (error) {
    if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") {
      throw new BetaError(
        "CONTACT_IDENTITY_READ_TIMEOUT",
        `The account and Salesforce-contact identity read did not return within ${timeoutMs / 1000} seconds. Nothing was saved. The same active case can retry once after the Snowflake session is refreshed.`,
        { source: "salesforce_contact_identity", deadline_seconds: timeoutMs / 1000, retry_same_run: true },
      );
    }
    throw new BetaError("CONTACT_IDENTITY_READ_FAILED", "The account and Salesforce-contact identity read could not be completed. Check the approved source and try again in a new run.");
  }
  const normalizedRows = (rows.length ? rows : [{}]).map((row) => ({
    ...row,
    ACCOUNT_ID: accountId,
    ACCOUNT_NAME: accountName,
    ACCOUNT_HEALTH: null,
    CS_SEGMENT: null,
    MARKET_SEGMENT: null,
    NET_ARR_USD: null,
    CSM_NAME: null,
  }));
  const normalized = normalizeContacts(normalizedRows, {}, {
    gainsight_operational_context: "scope_checked_pending_enrichment",
    salesforce_activity: "pending",
    gong_metadata_180_days: "pending",
    product_performance_metrics: "pending",
    rba_monthly_metrics: "pending",
    guide_knowledge_views: "pending",
  });
  const evidence = {
    brief: normalized.brief,
    contacts: normalized.contacts,
    gmail_metadata_request: buildGmailMetadataRequest(normalized.gmailAddresses, now),
    source_states: {
      salesforce_identity: "checked", contact_snapshot: "checked", salesforce_activity: "pending", gong_metadata: "pending",
      rba_monthly_metrics: "pending", guide_knowledge_views: "pending",
    },
    source_gap_codes: [],
    source_durations_ms: { salesforce_contact_identity: Date.now() - startedAt },
    gong_lookback_days: GONG_LOOKBACK_DAYS,
    read_at: now.toISOString(),
  };
  if (rows.length >= MAX_CONTACTS) {
    evidence.source_limit_reached = true;
    evidence.source_gap_codes.push("CONTACT_SNAPSHOT_LIMIT_REACHED");
    evidence.brief.contact_limit_notice = "The read reached its 100-contact limit. Priorities cover only the returned records, not a complete contact directory.";
  }
  return bindRuntimeContactDetails(evidence, rows, accountId);
}

function performanceMetricState(rba, guide) {
  if (rba.state === "checked" && ["checked", "no_data"].includes(guide.state)) return "checked";
  if (rba.state === "checked" || guide.state === "checked") return "partial";
  return "unavailable";
}

async function readSessionSource({ session, source, query, timeoutMs, deadlineAtMs, requireRow = false, sourceDurationsMs }) {
  const sourceStartedAt = Date.now();
  let workerStart = null;
  try {
    const rows = await session.query(query, { timeoutMs, ...(deadlineAtMs == null ? {} : { deadlineAtMs }),
      onStarted: (event) => { workerStart = event; } });
    return { state: !requireRow || rows.length ? "checked" : "unavailable", rows };
  } catch (error) {
    const windowExhausted = error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_WINDOW_TIMEOUT";
    const safe = safeSnowflakeReadDiagnostics(error);
    return {
      state: windowExhausted || (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") ? "timed_out" : "unavailable",
      rows: [],
      diagnostics: {
        ...safe,
        failed_stage: safe.failure_stage === "unknown" && error?.code === "SNOWFLAKE_SESSION_TIMEOUT" ? "statement_execution" : safe.failure_stage,
        statement_started: workerStart != null || error?.details?.statement_started === true,
        worker_queue_wait_ms: Number.isFinite(workerStart?.queue_wait_ms) ? Math.round(workerStart.queue_wait_ms) : null,
        elapsed_ms: Date.now() - sourceStartedAt,
      },
      ...(windowExhausted ? { failure_code: "EVIDENCE_WINDOW_EXHAUSTED" } : {}),
    };
  } finally {
    sourceDurationsMs[source] = (sourceDurationsMs[source] || 0) + Date.now() - sourceStartedAt;
  }
}

/**
 * A warehouse timeout is a delay signal, not evidence that the source has no
 * data. Retry only the same timed-out selected-account statement once with a
 * larger background budget. The first useful brief has already been returned.
 */
async function readSessionSourceWithExtendedRetry(options) {
  const first = await readSessionSource(options);
  if (first.state !== "timed_out") return first;
  return {
    ...(await readSessionSource({
      ...options,
      timeoutMs: CONTACT_ENRICHMENT_EXTENDED_RETRY_TIMEOUT_MS,
    })),
    retried_after_timeout: true,
  };
}

/**
 * Builds the first useful account result inside the 25-second product budget.
 * It deliberately starts only the two small monthly evidence reads. Account context and
 * relationship checks are not allowed to make measured performance metrics
 * wait behind a slower warehouse statement.
 */
export async function readFastJourneyAContactEvidenceWithSession({ accountId, coreEvidence, session, now = new Date() } = {}) {
  const sourceDurationsMs = { ...(coreEvidence?.source_durations_ms || {}) };
  // One active statement per managed session. The session now enforces this
  // too, but keeping callers serial prevents a future scheduler change from
  // turning queue wait into apparent source failure.
  const rba = await readSessionSource({
    session, source: "rba_monthly_metrics", query: buildRbaPerformanceMetricsSql(accountId),
    timeoutMs: FAST_BRIEF_READ_TIMEOUT_MS, requireRow: true, sourceDurationsMs,
  });
  const guide = await readSessionSource({
    session, source: "guide_knowledge_views", query: buildGuideKnowledgeViewMetricsSql(accountId),
    timeoutMs: FAST_BRIEF_READ_TIMEOUT_MS, requireRow: true, sourceDurationsMs,
  });
  const productMetricState = performanceMetricState(rba, guide);
  const identityState = coreEvidence?.source_states?.salesforce_identity || "checked";
  const result = {
    brief: {
      ...coreEvidence.brief,
      product_performance_metrics: buildPerformanceMetricTable({ ...(rba.rows[0] || {}), ...(guide.rows[0] || {}) }),
      source_states: {
        ...coreEvidence.brief.source_states,
        account_identity: coreEvidence.brief.source_states?.account_identity || "checked",
        gainsight_operational_context: "pending",
        salesforce_activity: "pending",
        gong_metadata_180_days: "pending",
        product_performance_metrics: productMetricState,
        rba_monthly_metrics: rba.state,
        guide_knowledge_views: guide.state,
      },
    },
    contacts: coreEvidence.contacts,
    gmail_metadata_request: coreEvidence.gmail_metadata_request,
    source_states: {
      salesforce_identity: identityState,
      contact_snapshot: coreEvidence.source_states?.contact_snapshot || "checked",
      ...(coreEvidence.source_states?.contact_details ? { contact_details: coreEvidence.source_states.contact_details } : {}),
      account_context: "pending",
      salesforce_activity: "pending",
      gong_metadata: "pending",
      rba_monthly_metrics: rba.state,
      guide_knowledge_views: guide.state,
    },
    source_gap_codes: [
      ...(rba.state === "checked" ? [] : [sourceGapCode("RBA_MONTHLY_METRICS", rba.state)]),
      ...(["checked", "no_data"].includes(guide.state) ? [] : [sourceGapCode("GUIDE_KNOWLEDGE_VIEWS", guide.state)]),
    ],
    source_durations_ms: sourceDurationsMs,
    gong_lookback_days: GONG_LOOKBACK_DAYS,
    read_at: now.toISOString(),
  };
  // Keep raw rows only in the short-lived in-memory run. The public response
  // exposes the normalized metric table, never an internal source payload.
  Object.defineProperty(result, "monthly_metric_source_results", { value: { rba, guide }, enumerable: false });
  return result;
}

/**
 * Completes the slow relationship and operational context reads after the
 * first useful brief has already been returned. Each source owns one started
 * statement and one execution budget.
 */
export async function readSlowJourneyAContactEvidenceWithSession({ accountId, coreEvidence, fastEvidence, session, now = new Date(), nowMs = Date.now, onProgress = null, onContactDetails = null } = {}) {
  const sourceDurationsMs = { ...(fastEvidence?.source_durations_ms || coreEvidence?.source_durations_ms || {}) };
  let resolvedCore = coreEvidence;
  const contactIds = pendingContactIds(coreEvidence);
  const monthlyMetrics = fastEvidence?.monthly_metric_source_results || {
    rba: { state: "unavailable", rows: [] }, guide: { state: "unavailable", rows: [] },
  };
  const metricRecovery = [
    { source: "rba_monthly_metrics", result: monthlyMetrics.rba, query: () => buildRbaPerformanceMetricsSql(accountId) },
    { source: "guide_knowledge_views", result: monthlyMetrics.guide, query: () => buildGuideKnowledgeViewMetricsSql(accountId) },
  ].filter(({ result }) => result.state === "timed_out");
  const sources = [
    ...(contactIds.length ? [{ source: "contact_details", query: buildContactDetailLookupSql(accountId, contactIds), requireRow: false }] : []),
    { source: "account_context", query: buildAccountContextSql(accountId), requireRow: true },
    { source: "salesforce_activity", query: buildSalesforceContactActivitySql(accountId), requireRow: false },
    { source: "gong_metadata", query: buildGongContactMetadataSql(accountId), requireRow: false },
    ...metricRecovery.map(({ source, query }) => ({ source, query: query(), requireRow: true })),
  ];
  const results = await readAccountEvidencePlan({ sources, nowMs, onProgress,
    initialResults: Object.fromEntries(metricRecovery.map(({ source, result }) => [source, result])),
    read: async (definition, scheduling) => {
      const result = await readSessionSource({ session, ...definition,
        timeoutMs: scheduling.timeoutMs, deadlineAtMs: scheduling.deadlineAtMs, sourceDurationsMs });
      if (definition.source === "contact_details") {
        // Always resolve against the original selection, including a timeout
        // recovery. An earlier failed result cannot erase its private IDs.
        resolvedCore = applyContactDetailLookup(coreEvidence, result.rows, { accountId, state: result.state, now });
        onContactDetails?.(resolvedCore);
      }
      return result;
    } });
  return mergeIndependentEnrichment(resolvedCore, {
    account_context: results.account_context,
    salesforce_activity: results.salesforce_activity,
    gong_metadata: results.gong_metadata,
    rba_monthly_metrics: results.rba_monthly_metrics || monthlyMetrics.rba,
    guide_knowledge_views: results.guide_knowledge_views || monthlyMetrics.guide,
  }, sourceDurationsMs, now);
}

/**
 * Runs every remaining selected-account read through one shared serial
 * scheduler. In particular, contact identity is not retried while its first
 * timed-out warehouse statement may still be running. The monthly result has
 * already been delivered, so this function can spend its time only on the
 * verified shortlist and the richer account context.
 */
export async function readBackgroundJourneyAContactEvidenceWithSession({ accountId, fastEvidence, session, now = new Date() } = {}) {
  const sourceDurationsMs = { ...(fastEvidence?.source_durations_ms || {}) };
  const sources = [
    { source: "account_context", query: buildAccountContextSql(accountId), requireRow: true },
    { source: "salesforce_activity", query: buildSalesforceContactActivitySql(accountId), requireRow: false },
    { source: "gong_metadata", query: buildGongContactMetadataSql(accountId), requireRow: false },
  ];
  if (fastEvidence?.source_states?.rba_monthly_metrics !== "checked") {
    sources.push({ source: "rba_monthly_metrics", query: buildRbaPerformanceMetricsSql(accountId), requireRow: true });
  }
  if (!(["checked", "no_data"].includes(fastEvidence?.source_states?.guide_knowledge_views))) {
    sources.push({ source: "guide_knowledge_views", query: buildGuideKnowledgeViewMetricsSql(accountId), requireRow: false });
  }
  const results = {};
  for (const definition of sources) {
    results[definition.source] = await readSessionSourceWithExtendedRetry({
      session, source: definition.source, query: definition.query,
      timeoutMs: CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS, requireRow: definition.requireRow,
      sourceDurationsMs,
    });
  }
  const monthlyMetrics = {
    rba: results.rba_monthly_metrics || fastEvidence?.monthly_metric_source_results?.rba || { state: "unavailable", rows: [] },
    guide: results.guide_knowledge_views || fastEvidence?.monthly_metric_source_results?.guide || { state: "unavailable", rows: [] },
  };
  const result = {
    ...fastEvidence,
    source_states: {
      ...fastEvidence.source_states,
      account_context: results.account_context?.state || "unavailable",
      salesforce_activity: results.salesforce_activity?.state || "unavailable",
      gong_metadata: results.gong_metadata?.state || "unavailable",
    },
    source_durations_ms: sourceDurationsMs,
    identity_available: true,
    read_at: now.toISOString(),
  };
  Object.defineProperty(result, "monthly_metric_source_results", { value: monthlyMetrics, enumerable: false });
  return result;
}

export function retryJourneyAContactEnrichment({ accountId, coreEvidence, connectionName = "zdp-global", runner = spawnSync, now = new Date() } = {}) {
  const temporary = createTemporarySnowflakeConfig();
  const sourceDurationsMs = { ...(coreEvidence?.source_durations_ms || {}) };
  const startedAt = Date.now();
  try {
    const runRead = sourceRunner({ temporary, connectionName, runner, sourceDurationsMs });
    const enrichment = runRead("account_enrichment_retry", buildContactEvidenceSql(accountId), CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS);
    if (enrichment.error || enrichment.status !== 0) {
      const state = enrichment.error?.code === "ETIMEDOUT" ? "timed_out" : "unavailable";
      return failedEnrichmentResult(coreEvidence, state, sourceDurationsMs);
    }
    const rows = parseRows(enrichment.stdout);
    const runMetric = (source, query) => {
      const remaining = CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) return { row: {}, state: "timed_out" };
      const result = runRead(source, query, remaining);
      if (result.error?.code === "ETIMEDOUT") return { row: {}, state: "timed_out" };
      if (result.error || result.status !== 0) return { row: {}, state: "unavailable" };
      const metricRows = parseRows(result.stdout);
      return metricRows.length === 1 ? { row: metricRows[0], state: "checked" } : { row: {}, state: "unavailable" };
    };
    const rba = runMetric("rba_monthly_metrics", buildRbaPerformanceMetricsSql(accountId));
    const guide = runMetric("guide_knowledge_views", buildGuideKnowledgeViewMetricsSql(accountId));
    const normalized = normalizeContacts(rows, { ...rba.row, ...guide.row }, {
      product_performance_metrics: performanceMetricState(rba, guide),
      rba_monthly_metrics: rba.state,
      guide_knowledge_views: guide.state,
    });
    return {
      brief: normalized.brief,
      contacts: normalized.contacts,
      gmail_metadata_request: buildGmailMetadataRequest(normalized.gmailAddresses, now),
      source_states: {
        salesforce_identity: "checked", salesforce_activity: "checked", gong_metadata: "checked",
        rba_monthly_metrics: rba.state, guide_knowledge_views: guide.state,
      },
      source_gap_codes: [
        ...(rba.state === "checked" ? [] : ["RBA_MONTHLY_METRICS_UNAVAILABLE"]),
        ...(["checked", "no_data"].includes(guide.state) ? [] : ["GUIDE_KNOWLEDGE_VIEWS_UNAVAILABLE"]),
      ],
      source_durations_ms: sourceDurationsMs,
      gong_lookback_days: GONG_LOOKBACK_DAYS,
      read_at: now.toISOString(),
    };
  } finally {
    temporary.cleanup();
  }
}

/** Reuses the active session for slow evidence. A failure preserves core identity. */
export async function retryJourneyAContactEnrichmentWithSession({ accountId, coreEvidence, session, now = new Date() } = {}) {
  const sourceDurationsMs = { ...(coreEvidence?.source_durations_ms || {}) };
  const runQuery = (source, query, requireRow = false) => readSessionSource({
    session, source, query, requireRow, timeoutMs: CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS, sourceDurationsMs,
  });
  // Keep one query timeout tied to one active warehouse statement. Submitting
  // more statements than the interactive warehouse can execute made queued
  // reads look like source timeouts even though Snowflake had not started them.
  const sources = [
    ["account_context", buildAccountContextSql(accountId), true],
    ["rba_monthly_metrics", buildRbaPerformanceMetricsSql(accountId), true],
    ["guide_knowledge_views", buildGuideKnowledgeViewMetricsSql(accountId), false],
    ["salesforce_activity", buildSalesforceContactActivitySql(accountId)],
    ["gong_metadata", buildGongContactMetadataSql(accountId)],
  ];
  const results = {};
  for (const [source, query, requireRow] of sources) {
    results[source] = await runQuery(source, query, requireRow);
  }
  const accountContext = results.account_context;
  const activity = results.salesforce_activity;
  const gong = results.gong_metadata;
  const rba = results.rba_monthly_metrics;
  const guide = results.guide_knowledge_views;
  return mergeIndependentEnrichment(coreEvidence, {
    account_context: accountContext,
    salesforce_activity: activity,
    gong_metadata: gong,
    rba_monthly_metrics: rba,
    guide_knowledge_views: guide,
  }, sourceDurationsMs, now);
}

export function readJourneyAContactEvidence({ accountId, connectionName = "zdp-global", runner = spawnSync, now = new Date() } = {}) {
  // Compatibility helper for direct callers. The MCP server uses the two
  // explicit stages so it can tell the CSM when slower evidence is delayed.
  const coreEvidence = readCoreContactEvidence({ accountId, connectionName, runner, now });
  return retryJourneyAContactEnrichment({ accountId, coreEvidence, connectionName, runner, now });
}

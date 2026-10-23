import { BetaError } from "./core.mjs";
import { BOOK_OF_BUSINESS_READ_TIMEOUT_MS, BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS, runBookOfBusinessStatement } from "./book-of-business-read-session.mjs";

export const BOOK_OF_BUSINESS_ANALYTICS_READ_TIMEOUT_MS = BOOK_OF_BUSINESS_READ_TIMEOUT_MS;

const DIMENSION_DEFINITIONS = Object.freeze({
  account_executive: {
    label: "Account Executive",
    source: "Salesforce Account owner joined to Salesforce User",
    expression: "COALESCE(NULLIF(TRIM(account_executive.NAME), ''), 'Unassigned / unavailable')",
  },
  industry: {
    label: "Industry",
    source: "Salesforce Account INDUSTRY",
    expression: "COALESCE(NULLIF(TRIM(salesforce_account.INDUSTRY), ''), 'Not mapped / unavailable')",
  },
  crm_region: {
    label: "CRM region",
    source: "Bullseye Pro Customers CRM_REGION",
    expression: "CASE WHEN territory.mapping_conflict THEN 'Conflicting mapping' WHEN territory.CRM_REGION IS NULL OR TRIM(territory.CRM_REGION) = '' THEN 'Not mapped / unavailable' ELSE territory.CRM_REGION END",
  },
  crm_sub_region: {
    label: "CRM sub-region",
    source: "Bullseye Pro Customers CRM_SUB_REGION",
    expression: "CASE WHEN territory.mapping_conflict THEN 'Conflicting mapping' WHEN territory.CRM_SUB_REGION IS NULL OR TRIM(territory.CRM_SUB_REGION) = '' THEN 'Not mapped / unavailable' ELSE territory.CRM_SUB_REGION END",
  },
  cs_segment: {
    label: "CS segment",
    source: "Gainsight Company DYNAMIC_SEGMENTATION_ENGAGEMENT_GC",
    expression: "CASE WHEN book.mapping_conflict THEN 'Conflicting mapping' WHEN book.cs_segment IS NULL OR TRIM(book.cs_segment) = '' THEN 'Not mapped / unavailable' ELSE book.cs_segment END",
  },
  market_segment: {
    label: "Market segment",
    source: "Gainsight Company MARKET_SEGMENT_GC",
    expression: "CASE WHEN book.mapping_conflict THEN 'Conflicting mapping' WHEN book.market_segment IS NULL OR TRIM(book.market_segment) = '' THEN 'Not mapped / unavailable' ELSE book.market_segment END",
  },
  account_health: {
    label: "Account health",
    source: "Gainsight Company ACCOUNT_HEALTH_STATUS_GC",
    expression: "CASE WHEN book.mapping_conflict THEN 'Conflicting mapping' WHEN book.account_health IS NULL OR TRIM(book.account_health) = '' THEN 'Not mapped / unavailable' ELSE book.account_health END",
  },
  renewal_manager: {
    label: "Renewal manager",
    source: "Bullseye Pro Customers CRM_RENEWAL_OWNER_NAME",
    expression: "CASE WHEN renewal_manager.mapping_conflict THEN 'Conflicting mapping' WHEN renewal_manager.CRM_RENEWAL_OWNER_NAME IS NULL OR TRIM(renewal_manager.CRM_RENEWAL_OWNER_NAME) = '' THEN 'Not mapped / unavailable' ELSE renewal_manager.CRM_RENEWAL_OWNER_NAME END",
  },
});

const UNAVAILABLE_DIMENSIONS = Object.freeze([]);

function field(row, name) {
  return row[name] ?? row[name.toLowerCase()] ?? null;
}

function finiteNumber(value, name) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new BetaError("BOOK_OF_BUSINESS_ANALYSIS_RESPONSE_INVALID", `The book-of-business read returned an invalid ${name}.`);
  }
  return number;
}

function assertDimensions(dimensions) {
  if (!Array.isArray(dimensions) || dimensions.length > 2 || new Set(dimensions).size !== dimensions.length) {
    throw new BetaError("INVALID_BOOK_OF_BUSINESS_DIMENSIONS", "Choose up to two distinct supported book-of-business dimensions.");
  }
  for (const dimension of dimensions) {
    if (!Object.hasOwn(DIMENSION_DEFINITIONS, dimension)) {
      throw new BetaError("INVALID_BOOK_OF_BUSINESS_DIMENSIONS", "Choose supported book-of-business dimensions only.");
    }
  }
}

function dimensionProjection(dimensions) {
  return dimensions.map((dimension, index) => `${DIMENSION_DEFINITIONS[dimension].expression} AS dimension_${index + 1}`);
}

function dimensionGroupBy(dimensions) {
  return dimensions.map((_dimension, index) => `dimension_${index + 1}`).join(", ");
}

export function bookOfBusinessAnalyticsCapabilities() {
  return {
    scope: {
      label: "Current book of business",
      definition: "Accounts where the authenticated CSM is the current Gainsight Success Owner. CTA ownership is not required.",
    },
    measures: [
      { key: "account_count", label: "Accounts", source: "Distinct Salesforce account IDs in the current Gainsight book" },
      { key: "net_arr_usd", label: "Net ARR (USD)", source: "Gainsight Company NET_ARR_USD_GC", null_handling: "Missing values remain missing and are counted separately." },
    ],
    supported_dimensions: Object.entries(DIMENSION_DEFINITIONS).map(([key, definition]) => ({
      key,
      label: definition.label,
      source: definition.source,
      state: "ready",
    })),
    unavailable_dimensions: UNAVAILABLE_DIMENSIONS,
    limits: {
      maximum_dimensions: 2,
      output: "Aggregate-only rows; this read does not return account, contact, CTA, or raw source identifiers.",
      writes: "None. Source results remain transient and are not saved to the beta case state.",
    },
  };
}

/**
 * Builds one fixed-shape aggregate query. Dimension names are selected from a
 * closed catalog above; no caller-provided field name, filter, or SQL fragment
 * reaches this statement.
 */
export function buildBookOfBusinessSummarySql(dimensions = []) {
  assertDimensions(dimensions);
  const projections = dimensionProjection(dimensions);
  const needsSalesforce = dimensions.some((dimension) => dimension === "account_executive" || dimension === "industry");
  const needsTerritory = dimensions.some((dimension) => dimension === "crm_region" || dimension === "crm_sub_region");
  const needsRenewalManager = dimensions.includes("renewal_manager");
  const groupedResult = dimensions.length === 0 ? "" : `
UNION ALL
SELECT
  'group' AS row_type,
  1 AS scope_count,
  ${dimensions.map((_dimension, index) => `dimension_${index + 1}`).join(", ")},
  COUNT(DISTINCT account_id) AS account_count,
  SUM(net_arr_usd) AS net_arr_usd,
  COUNT_IF(net_arr_usd IS NULL) AS accounts_missing_net_arr,
  COUNT_IF(mapping_conflict) AS accounts_with_gainsight_mapping_conflicts
FROM resolved_book
GROUP BY ${dimensionGroupBy(dimensions)}
`;
  const summaryDimensionColumns = dimensions.map((_dimension, index) => `NULL::STRING AS dimension_${index + 1}`).join(",\n  ");
  const selectDimensionColumns = dimensions.length ? `${summaryDimensionColumns},\n  ` : "";
  const territoryCtes = needsTerritory ? `, territory_values AS (
  SELECT DISTINCT CRM_ACCOUNT_ID, CRM_REGION, CRM_SUB_REGION
  FROM PRESENTATION.BULLSEYE_PRO.CUSTOMERS
  WHERE CRM_ACCOUNT_ID IS NOT NULL
), territory AS (
  SELECT
    CRM_ACCOUNT_ID,
    CASE WHEN COUNT(*) = 1 THEN MAX(CRM_REGION) ELSE NULL END AS CRM_REGION,
    CASE WHEN COUNT(*) = 1 THEN MAX(CRM_SUB_REGION) ELSE NULL END AS CRM_SUB_REGION,
    COUNT(*) > 1 AS mapping_conflict
  FROM territory_values
  GROUP BY CRM_ACCOUNT_ID
)` : "";
  const renewalManagerCtes = needsRenewalManager ? `, renewal_manager_values AS (
  SELECT DISTINCT
    CRM_ACCOUNT_ID,
    NULLIF(TRIM(CRM_RENEWAL_OWNER_NAME), '') AS CRM_RENEWAL_OWNER_NAME
  FROM PRESENTATION.BULLSEYE_PRO.CUSTOMERS
  WHERE CRM_ACCOUNT_ID IS NOT NULL
), renewal_manager AS (
  SELECT
    CRM_ACCOUNT_ID,
    CASE WHEN COUNT(*) = 1 THEN MAX(CRM_RENEWAL_OWNER_NAME) ELSE NULL END AS CRM_RENEWAL_OWNER_NAME,
    COUNT(*) > 1 AS mapping_conflict
  FROM renewal_manager_values
  GROUP BY CRM_ACCOUNT_ID
)` : "";
  const salesforceJoins = needsSalesforce ? `
  LEFT JOIN CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS salesforce_account
    ON book.account_id = salesforce_account.ID
  ${dimensions.includes("account_executive") ? `LEFT JOIN CLEANSED.SALESFORCE.SALESFORCE_USER_BCV AS account_executive
    ON salesforce_account.OWNER_ID = account_executive.ID` : ""}` : "";
  const territoryJoin = needsTerritory ? `
  LEFT JOIN territory
    ON book.account_id = territory.CRM_ACCOUNT_ID` : "";
  const renewalManagerJoin = needsRenewalManager ? `
  LEFT JOIN renewal_manager
    ON book.account_id = renewal_manager.CRM_ACCOUNT_ID` : "";

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
), current_book AS (
  SELECT
    account_id,
    CASE WHEN COUNT(*) = 1 THEN MAX(net_arr_usd) ELSE NULL END AS net_arr_usd,
    CASE WHEN COUNT(*) = 1 THEN MAX(cs_segment) ELSE NULL END AS cs_segment,
    CASE WHEN COUNT(*) = 1 THEN MAX(market_segment) ELSE NULL END AS market_segment,
    CASE WHEN COUNT(*) = 1 THEN MAX(account_health) ELSE NULL END AS account_health,
    COUNT(*) > 1 AS mapping_conflict
  FROM (
    SELECT DISTINCT
      company.SFDC_ACCOUNT_ID AS account_id,
      company.NET_ARR_USD_GC AS net_arr_usd,
      company.DYNAMIC_SEGMENTATION_ENGAGEMENT_GC AS cs_segment,
      company.MARKET_SEGMENT_GC AS market_segment,
      company.ACCOUNT_HEALTH_STATUS_GC AS account_health
    FROM CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
    JOIN authenticated_csm ON company.SUCCESS_OWNER_C_GC = authenticated_csm.GSID
    WHERE company.SFDC_ACCOUNT_ID IS NOT NULL
  ) AS current_book_values
  GROUP BY account_id
)${territoryCtes}${renewalManagerCtes}, resolved_book AS (
  SELECT
    book.*${projections.length ? `,\n    ${projections.join(",\n    ")}` : ""}
  FROM current_book AS book${salesforceJoins}${territoryJoin}${renewalManagerJoin}
)
SELECT
  'scope' AS row_type,
  scope.scope_count,
  ${selectDimensionColumns}NULL::NUMBER AS account_count,
  NULL::NUMBER AS net_arr_usd,
  NULL::NUMBER AS accounts_missing_net_arr,
  NULL::NUMBER AS accounts_with_gainsight_mapping_conflicts
FROM scope
UNION ALL
SELECT
  'summary' AS row_type,
  1 AS scope_count,
  ${selectDimensionColumns}COUNT(DISTINCT account_id) AS account_count,
  SUM(net_arr_usd) AS net_arr_usd,
  COUNT_IF(net_arr_usd IS NULL) AS accounts_missing_net_arr,
  COUNT_IF(mapping_conflict) AS accounts_with_gainsight_mapping_conflicts
FROM resolved_book${groupedResult}
ORDER BY
  CASE row_type WHEN 'scope' THEN 0 WHEN 'summary' THEN 1 ELSE 2 END,
  account_count DESC,
  ${dimensions.length ? `${dimensionGroupBy(dimensions)}` : "row_type"}
`.trim();
}

function readScope(rows) {
  const scope = rows.find((row) => field(row, "ROW_TYPE") === "scope");
  if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
    throw new BetaError("BOOK_OF_BUSINESS_SCOPE_UNAVAILABLE", "The signed-in Snowflake user does not map to one CSM profile, so no book-of-business analysis was shown.");
  }
}

export function presentBookOfBusinessSummary(rows, dimensions = [], now = new Date()) {
  assertDimensions(dimensions);
  const summary = rows.find((row) => field(row, "ROW_TYPE") === "summary");
  if (!summary) {
    throw new BetaError("BOOK_OF_BUSINESS_ANALYSIS_RESPONSE_INVALID", "The book-of-business read did not return a summary row.");
  }
  const accountCount = finiteNumber(field(summary, "ACCOUNT_COUNT"), "account count");
  const missingNetArrCount = finiteNumber(field(summary, "ACCOUNTS_MISSING_NET_ARR"), "missing Net ARR count");
  const gainsightConflictCount = finiteNumber(field(summary, "ACCOUNTS_WITH_GAINSIGHT_MAPPING_CONFLICTS"), "Gainsight mapping conflict count") ?? 0;
  if (
    !Number.isInteger(accountCount) || accountCount < 0
    || !Number.isInteger(missingNetArrCount) || missingNetArrCount < 0 || missingNetArrCount > accountCount
    || !Number.isInteger(gainsightConflictCount) || gainsightConflictCount < 0 || gainsightConflictCount > accountCount
  ) {
    throw new BetaError("BOOK_OF_BUSINESS_ANALYSIS_RESPONSE_INVALID", "The book-of-business read returned inconsistent account counts.");
  }
  const groups = rows
    .filter((row) => field(row, "ROW_TYPE") === "group")
    .map((row) => {
      const groupAccountCount = finiteNumber(field(row, "ACCOUNT_COUNT"), "group account count");
      const groupMissingNetArrCount = finiteNumber(field(row, "ACCOUNTS_MISSING_NET_ARR"), "group missing Net ARR count");
      const groupGainsightConflictCount = finiteNumber(field(row, "ACCOUNTS_WITH_GAINSIGHT_MAPPING_CONFLICTS"), "group Gainsight mapping conflict count") ?? 0;
      if (
        !Number.isInteger(groupAccountCount) || groupAccountCount < 0
        || !Number.isInteger(groupMissingNetArrCount) || groupMissingNetArrCount < 0 || groupMissingNetArrCount > groupAccountCount
        || !Number.isInteger(groupGainsightConflictCount) || groupGainsightConflictCount < 0 || groupGainsightConflictCount > groupAccountCount
      ) {
        throw new BetaError("BOOK_OF_BUSINESS_ANALYSIS_RESPONSE_INVALID", "The book-of-business read returned inconsistent group counts.");
      }
      return {
        dimensions: Object.fromEntries(dimensions.map((dimension, index) => [
          dimension,
          field(row, `DIMENSION_${index + 1}`) || "Not mapped / unavailable",
        ])),
        account_count: groupAccountCount,
        net_arr_usd: finiteNumber(field(row, "NET_ARR_USD"), "group Net ARR"),
        accounts_missing_net_arr: groupMissingNetArrCount,
        accounts_with_gainsight_mapping_conflicts: groupGainsightConflictCount,
      };
    });
  if (dimensions.length > 0 && groups.reduce((total, group) => total + group.account_count, 0) !== accountCount) {
    throw new BetaError("BOOK_OF_BUSINESS_ANALYSIS_RESPONSE_INVALID", "The book-of-business groups did not reconcile to the total account count.");
  }
  return {
    scope: bookOfBusinessAnalyticsCapabilities().scope,
    grouped_by: dimensions.map((dimension) => ({ key: dimension, label: DIMENSION_DEFINITIONS[dimension].label, source: DIMENSION_DEFINITIONS[dimension].source })),
    summary: {
      account_count: accountCount,
      net_arr_usd: finiteNumber(field(summary, "NET_ARR_USD"), "Net ARR"),
      accounts_missing_net_arr: missingNetArrCount,
      accounts_with_gainsight_mapping_conflicts: gainsightConflictCount,
    },
    groups,
    source_states: {
      gainsight_book: gainsightConflictCount > 0 ? "checked_with_conflicts" : "checked",
      salesforce_account: dimensions.some((dimension) => dimension === "account_executive" || dimension === "industry") ? "checked" : "not_requested",
      bullseye_crm_territory: dimensions.some((dimension) => dimension === "crm_region" || dimension === "crm_sub_region") ? "checked" : "not_requested",
      bullseye_crm_renewal_manager: dimensions.includes("renewal_manager") ? "checked" : "not_requested",
    },
    source: "Gainsight current-book scope, with approved Salesforce and Bullseye Pro dimensions when requested",
    read_at: now.toISOString(),
  };
}

export async function readBookOfBusinessSummaryWithSession({ session, dimensions = [], now = new Date(), onProgress } = {}) {
  assertDimensions(dimensions);
  if (!session || typeof session.query !== "function") {
    throw new BetaError("BOOK_OF_BUSINESS_SESSION_REQUIRED", "The approved Snowflake session is required for book-of-business analysis.");
  }
  const startedAt = Date.now();
  let read;
  try {
    read = await runBookOfBusinessStatement({ session, sql: buildBookOfBusinessSummarySql(dimensions), onProgress });
    readScope(read.rows);
  } catch (error) {
    if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") {
      throw new BetaError("BOOK_OF_BUSINESS_ANALYSIS_READ_TIMEOUT", `Book-of-business analysis timed out after a ${BOOK_OF_BUSINESS_ANALYTICS_READ_TIMEOUT_MS / 1000}-second first attempt and one retry capped at ${BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS / 60000} minutes. Nothing was saved.`);
    }
    if (error instanceof BetaError && error.code === "SNOWFLAKE_CLI_LOGGING_UNAVAILABLE") {
      throw new BetaError("BOOK_OF_BUSINESS_CLI_CONFIGURATION_REQUIRED", "Book-of-business analysis could not start because the local Snowflake CLI logging setup needs repair. No data was read or saved.");
    }
    if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_START_TIMEOUT") {
      throw new BetaError("SNOWFLAKE_SIGN_IN_REQUIRED", "Snowflake/ZDP did not start this read. Complete browser sign-in, then try again.");
    }
    if (error instanceof BetaError && ["BOOK_OF_BUSINESS_SCOPE_UNAVAILABLE", "INVALID_BOOK_OF_BUSINESS_DIMENSIONS", "BOOK_OF_BUSINESS_DIMENSION_UNAVAILABLE"].includes(error.code)) throw error;
    throw new BetaError("BOOK_OF_BUSINESS_ANALYSIS_READ_FAILED", "The book-of-business analysis could not be read. Check the existing Snowflake connection and try again.");
  }
  const result = presentBookOfBusinessSummary(read.rows, dimensions, now);
  result.read_deadline_seconds = BOOK_OF_BUSINESS_ANALYTICS_READ_TIMEOUT_MS / 1000;
  result.retry_deadline_seconds = BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS / 1000;
  result.attempt_count = read.attempt_count;
  result.retry_used = read.retry_used;
  result.attempt_durations_ms = read.attempt_durations_ms;
  result.source_durations_ms = { book_of_business_analysis: Date.now() - startedAt };
  return result;
}

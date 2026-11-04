import { BetaError } from "./core.mjs";
import { PRODUCT_ANALYTICS_SOURCES } from "./product-analytics-sources.mjs";
import { BOOK_OF_BUSINESS_READ_TIMEOUT_MS, BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS, runBookOfBusinessStatement } from "./book-of-business-read-session.mjs";

export const BOOK_OF_BUSINESS_PORTFOLIO_QUERY_TIMEOUT_MS = BOOK_OF_BUSINESS_READ_TIMEOUT_MS;
export const BOOK_OF_BUSINESS_PORTFOLIO_QUERY_MAX_ROWS = 250;

const NOT_MAPPED = "Not mapped / unavailable";

const FIELD_DEFINITIONS = Object.freeze({
  account_name: {
    label: "Account name",
    source: "Salesforce Account NAME",
    expression: "book.account_name",
    kind: "text",
    always_selected: true,
  },
  net_arr_usd: {
    label: "Net ARR (USD)",
    source: "Gainsight Company NET_ARR_USD_GC",
    expression: "book.net_arr_usd",
    kind: "number",
    output_only: true,
  },
  industry: {
    label: "Industry",
    source: "Salesforce Account INDUSTRY",
    expression: "book.industry",
    kind: "text",
  },
  company_type: {
    label: "Account type",
    source: "Salesforce Account TYPE",
    expression: "book.company_type",
    kind: "text",
  },
  billing_country: {
    label: "Billing country",
    source: "Salesforce Account BILLING_COUNTRY",
    expression: "book.billing_country",
    kind: "text",
  },
  account_executive: {
    label: "Account Executive",
    source: "Salesforce Account owner joined to Salesforce User",
    expression: "book.account_executive",
    kind: "text",
  },
  crm_region: {
    label: "CRM region",
    source: "Bullseye Pro Customers CRM_REGION",
    expression: "book.crm_region",
    kind: "text",
    requires_bullseye: true,
  },
  crm_sub_region: {
    label: "CRM sub-region",
    source: "Bullseye Pro Customers CRM_SUB_REGION",
    expression: "book.crm_sub_region",
    kind: "text",
    requires_bullseye: true,
  },
  cs_segment: {
    label: "CS segment",
    source: "Gainsight Company DYNAMIC_SEGMENTATION_ENGAGEMENT_GC",
    expression: "book.cs_segment",
    kind: "text",
  },
  market_segment: {
    label: "Market segment",
    source: "Gainsight Company MARKET_SEGMENT_GC",
    expression: "book.market_segment",
    kind: "text",
  },
  account_health: {
    label: "Account health",
    source: "Gainsight Company ACCOUNT_HEALTH_STATUS_GC",
    expression: "book.account_health",
    kind: "text",
  },
  renewal_manager: {
    label: "Renewal manager",
    source: "Bullseye Pro Customers CRM_RENEWAL_OWNER_NAME",
    expression: "book.renewal_manager",
    kind: "text",
    requires_bullseye: true,
  },
  copilot_paid_status: {
    label: "Paid Copilot product-state signal",
    source: "Copilot CRM daily snapshot CRM_IS_COPILOT_PAID_PENETRATED and CRM_IS_COPILOT_PAID_ADOPTED",
    expression: "book.copilot_paid_status",
    kind: "enum",
    requires_copilot: true,
    values: ["paid_adopted", "paid_not_adopted", "paid_adoption_not_assessed", "not_paid_or_not_penetrated", "not_assessed", "conflicting_snapshot"],
  },
  copilot_snapshot_date: {
    label: "Copilot snapshot date",
    source: "Copilot CRM daily snapshot SOURCE_SNAPSHOT_DATE",
    expression: "book.copilot_snapshot_date",
    kind: "date",
    requires_copilot: true,
  },
  account_mapping_state: {
    label: "Book mapping state",
    source: "Gainsight current-book mapping",
    expression: "book.account_mapping_state",
    kind: "enum",
    output_only: true,
  },
});

const DEFAULT_COLUMNS = Object.freeze(["account_name", "net_arr_usd"]);
const SORTABLE_FIELDS = new Set(["account_name", "net_arr_usd"]);

function field(row, name) {
  return row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()] ?? null;
}

function asFiniteNumber(value, name) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new BetaError("BOOK_OF_BUSINESS_PORTFOLIO_RESPONSE_INVALID", `The portfolio read returned an invalid ${name}.`);
  }
  return number;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizedColumns(columns) {
  if (columns == null) return [...DEFAULT_COLUMNS];
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > 12 || new Set(columns).size !== columns.length) {
    throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_COLUMNS", "Choose one to twelve distinct approved portfolio columns.");
  }
  for (const column of columns) {
    if (!Object.hasOwn(FIELD_DEFINITIONS, column)) {
      throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_COLUMNS", "Choose approved portfolio columns only.");
    }
  }
  return [...new Set(["account_name", ...columns])];
}

function normalizedFilters(filters) {
  if (filters == null) return [];
  if (!Array.isArray(filters) || filters.length > 4) {
    throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS", "Use up to four approved portfolio filters.");
  }
  return filters.map((filter) => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS", "Each portfolio filter must name an approved field and operator.");
    }
    const definition = FIELD_DEFINITIONS[filter.field];
    if (!definition || definition.output_only || !["equals", "is_missing", "is_not_missing"].includes(filter.operator)) {
      throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS", "Use approved portfolio fields and operators only.");
    }
    if (filter.operator === "equals") {
      if (typeof filter.value !== "string" || filter.value.trim().length === 0 || filter.value.length > 160) {
        throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS", "An equals filter needs one non-empty value of at most 160 characters.");
      }
      const value = filter.value.trim();
      if (definition.kind === "enum" && !definition.values.includes(value)) {
        throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS", "Use one of the published values for this portfolio status.");
      }
      return { field: filter.field, operator: filter.operator, value };
    }
    if (Object.hasOwn(filter, "value")) {
      throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS", "Missing-value filters do not accept a value.");
    }
    return { field: filter.field, operator: filter.operator };
  });
}

function normalizedSort(sort) {
  if (sort == null) return { field: "account_name", direction: "asc" };
  if (!sort || typeof sort !== "object" || Array.isArray(sort) || !SORTABLE_FIELDS.has(sort.field) || !["asc", "desc"].includes(sort.direction)) {
    throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_SORT", "Sort portfolio results by account name or Net ARR, ascending or descending.");
  }
  return { field: sort.field, direction: sort.direction };
}

function normalizedLimit(limit) {
  if (limit == null) return 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > BOOK_OF_BUSINESS_PORTFOLIO_QUERY_MAX_ROWS) {
    throw new BetaError("INVALID_BOOK_OF_BUSINESS_PORTFOLIO_LIMIT", `Choose a result limit from 1 to ${BOOK_OF_BUSINESS_PORTFOLIO_QUERY_MAX_ROWS}.`);
  }
  return limit;
}

export function normalizeBookOfBusinessPortfolioRequest({ filters, columns, sort, limit } = {}) {
  return {
    filters: normalizedFilters(filters),
    columns: normalizedColumns(columns),
    sort: normalizedSort(sort),
    limit: normalizedLimit(limit),
  };
}

function requestedFields(request) {
  return new Set([...request.columns, ...request.filters.map((filter) => filter.field), request.sort.field]);
}

function filterSql(filter) {
  const definition = FIELD_DEFINITIONS[filter.field];
  const expression = definition.expression;
  if (filter.operator === "equals") {
    return `UPPER(TRIM(${expression})) = UPPER(${sqlLiteral(filter.value)})`;
  }
  const missing = `${expression} IS NULL OR TRIM(${expression}) = ''`;
  return filter.operator === "is_missing" ? `(${missing})` : `NOT (${missing})`;
}

function selectedColumnProjection(columns, prefix) {
  return columns.map((column) => `${prefix}.${column} AS ${column}`).join(",\n  ");
}

function scopeColumnProjection(columns) {
  return columns.map((column) => {
    const definition = FIELD_DEFINITIONS[column];
    const sqlType = definition.kind === "number" ? "NUMBER" : "STRING";
    return `NULL::${sqlType} AS ${column}`;
  }).join(",\n  ");
}

/**
 * Builds one fixed-shape current-book account-list query. Request fields come
 * only from the catalog above. Values are SQL-escaped literals; no raw SQL,
 * caller-provided table name, or caller-provided projection is accepted.
 */
export function buildBookOfBusinessPortfolioQuerySql(input = {}) {
  const request = normalizeBookOfBusinessPortfolioRequest(input);
  const fields = requestedFields(request);
  const needsAccountExecutive = fields.has("account_executive");
  const needsBullseye = [...fields].some((name) => FIELD_DEFINITIONS[name]?.requires_bullseye);
  const needsCopilot = [...fields].some((name) => FIELD_DEFINITIONS[name]?.requires_copilot);
  const filters = request.filters.length ? `WHERE ${request.filters.map(filterSql).join("\n    AND ")}` : "";
  const orderBy = request.sort.field === "net_arr_usd"
    ? `net_arr_usd ${request.sort.direction.toUpperCase()} NULLS LAST, account_name ASC, account_id ASC`
    : `account_name ${request.sort.direction.toUpperCase()} NULLS LAST, account_id ASC`;
  const salesforceOwnerProjection = needsAccountExecutive ? ", OWNER_ID" : "";
  const salesforceOwnerAggregation = needsAccountExecutive
    ? ",\n    CASE WHEN COUNT(*) = 1 THEN MAX(OWNER_ID) ELSE NULL END AS OWNER_ID"
    : "";
  const accountExecutiveCtes = needsAccountExecutive ? `, account_executive_values AS (
  SELECT DISTINCT salesforce_user.ID, salesforce_user.NAME
  FROM CLEANSED.SALESFORCE.SALESFORCE_USER_BCV AS salesforce_user
  JOIN salesforce_account ON salesforce_user.ID = salesforce_account.OWNER_ID
), account_executive AS (
  SELECT
    ID,
    CASE WHEN COUNT(*) = 1 THEN MAX(NAME) ELSE NULL END AS NAME,
    COUNT(*) > 1 AS mapping_conflict
  FROM account_executive_values
  GROUP BY ID
)` : "";
  const accountExecutiveJoin = needsAccountExecutive
    ? "\n  LEFT JOIN account_executive ON salesforce_account.OWNER_ID = account_executive.ID"
    : "";
  const accountExecutiveColumn = needsAccountExecutive
    ? "CASE WHEN salesforce_account.mapping_conflict OR account_executive.mapping_conflict THEN NULL ELSE NULLIF(TRIM(account_executive.NAME), '') END AS account_executive,"
    : "NULL::STRING AS account_executive,";
  const bullseyeCtes = needsBullseye ? `, bullseye_values AS (
  SELECT DISTINCT
    CRM_ACCOUNT_ID,
    NULLIF(TRIM(CRM_REGION), '') AS CRM_REGION,
    NULLIF(TRIM(CRM_SUB_REGION), '') AS CRM_SUB_REGION,
    NULLIF(TRIM(CRM_RENEWAL_OWNER_NAME), '') AS CRM_RENEWAL_OWNER_NAME
  FROM PRESENTATION.BULLSEYE_PRO.CUSTOMERS AS customers
  JOIN current_book ON customers.CRM_ACCOUNT_ID = current_book.account_id
), bullseye AS (
  SELECT
    CRM_ACCOUNT_ID,
    CASE WHEN COUNT(DISTINCT COALESCE(CRM_REGION, '__NULL__')) = 1 THEN MAX(CRM_REGION) ELSE NULL END AS CRM_REGION,
    CASE WHEN COUNT(DISTINCT COALESCE(CRM_SUB_REGION, '__NULL__')) = 1 THEN MAX(CRM_SUB_REGION) ELSE NULL END AS CRM_SUB_REGION,
    CASE WHEN COUNT(DISTINCT COALESCE(CRM_RENEWAL_OWNER_NAME, '__NULL__')) = 1 THEN MAX(CRM_RENEWAL_OWNER_NAME) ELSE NULL END AS CRM_RENEWAL_OWNER_NAME,
    COUNT(DISTINCT COALESCE(CRM_REGION, '__NULL__')) > 1 AS crm_region_conflict,
    COUNT(DISTINCT COALESCE(CRM_SUB_REGION, '__NULL__')) > 1 AS crm_sub_region_conflict,
    COUNT(DISTINCT COALESCE(CRM_RENEWAL_OWNER_NAME, '__NULL__')) > 1 AS renewal_manager_conflict
  FROM bullseye_values
  GROUP BY CRM_ACCOUNT_ID
)` : "";
  const bullseyeJoin = needsBullseye ? "\n  LEFT JOIN bullseye ON current_book.account_id = bullseye.CRM_ACCOUNT_ID" : "";
  const bullseyeColumns = needsBullseye ? `
    CASE WHEN bullseye.crm_region_conflict THEN NULL ELSE bullseye.CRM_REGION END AS crm_region,
    CASE WHEN bullseye.crm_sub_region_conflict THEN NULL ELSE bullseye.CRM_SUB_REGION END AS crm_sub_region,
    CASE WHEN bullseye.renewal_manager_conflict THEN NULL ELSE bullseye.CRM_RENEWAL_OWNER_NAME END AS renewal_manager,` : `
    NULL::STRING AS crm_region,
    NULL::STRING AS crm_sub_region,
    NULL::STRING AS renewal_manager,`;
  const copilotCtes = needsCopilot ? `, latest_copilot_snapshot AS (
  SELECT MAX(SOURCE_SNAPSHOT_DATE) AS source_snapshot_date
  FROM ${PRODUCT_ANALYTICS_SOURCES.copilot}
), copilot_values AS (
  SELECT DISTINCT
    copilot_snapshot.CRM_ACCOUNT_ID,
    copilot_snapshot.SOURCE_SNAPSHOT_DATE,
    copilot_snapshot.CRM_IS_COPILOT_PAID_PENETRATED,
    copilot_snapshot.CRM_IS_COPILOT_PAID_ADOPTED
  FROM ${PRODUCT_ANALYTICS_SOURCES.copilot} AS copilot_snapshot
  JOIN latest_copilot_snapshot
    ON copilot_snapshot.SOURCE_SNAPSHOT_DATE = latest_copilot_snapshot.source_snapshot_date
  JOIN current_book ON copilot_snapshot.CRM_ACCOUNT_ID = current_book.account_id
), copilot AS (
  SELECT
    CRM_ACCOUNT_ID,
    CASE WHEN COUNT(*) = 1 THEN MAX(SOURCE_SNAPSHOT_DATE) ELSE NULL END AS source_snapshot_date,
    CASE WHEN COUNT(*) = 1 THEN MAX(CRM_IS_COPILOT_PAID_PENETRATED) ELSE NULL END AS paid_penetrated,
    CASE WHEN COUNT(*) = 1 THEN MAX(CRM_IS_COPILOT_PAID_ADOPTED) ELSE NULL END AS paid_adopted,
    COUNT(*) > 1 AS mapping_conflict
  FROM copilot_values
  GROUP BY CRM_ACCOUNT_ID
)` : "";
  const copilotJoin = needsCopilot ? "\n  LEFT JOIN copilot ON current_book.account_id = copilot.CRM_ACCOUNT_ID" : "";
  const copilotColumns = needsCopilot ? `
    CASE
      WHEN copilot.mapping_conflict THEN 'conflicting_snapshot'
      WHEN copilot.CRM_ACCOUNT_ID IS NULL THEN 'not_assessed'
      WHEN copilot.paid_penetrated = TRUE AND copilot.paid_adopted = TRUE THEN 'paid_adopted'
      WHEN copilot.paid_penetrated = TRUE AND copilot.paid_adopted = FALSE THEN 'paid_not_adopted'
      WHEN copilot.paid_penetrated = TRUE AND copilot.paid_adopted IS NULL THEN 'paid_adoption_not_assessed'
      WHEN copilot.paid_penetrated IS NULL THEN 'not_assessed'
      ELSE 'not_paid_or_not_penetrated'
    END AS copilot_paid_status,
    TO_VARCHAR(copilot.source_snapshot_date, 'YYYY-MM-DD') AS copilot_snapshot_date,` : `
    NULL::STRING AS copilot_paid_status,
    NULL::STRING AS copilot_snapshot_date,`;

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
    COUNT(*) > 1 AS gainsight_mapping_conflict
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
), salesforce_account_values AS (
  SELECT DISTINCT ID, NAME, INDUSTRY, TYPE, BILLING_COUNTRY${salesforceOwnerProjection}
  FROM CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS salesforce
  JOIN current_book ON salesforce.ID = current_book.account_id
), salesforce_account AS (
  SELECT
    ID,
    CASE WHEN COUNT(*) = 1 THEN MAX(NAME) ELSE NULL END AS NAME,
    CASE WHEN COUNT(*) = 1 THEN MAX(INDUSTRY) ELSE NULL END AS INDUSTRY,
    CASE WHEN COUNT(*) = 1 THEN MAX(TYPE) ELSE NULL END AS TYPE,
    CASE WHEN COUNT(*) = 1 THEN MAX(BILLING_COUNTRY) ELSE NULL END AS BILLING_COUNTRY,
    COUNT(*) > 1 AS mapping_conflict${salesforceOwnerAggregation}
  FROM salesforce_account_values
  GROUP BY ID
)${accountExecutiveCtes}${bullseyeCtes}${copilotCtes}, resolved_book AS (
  SELECT
    current_book.account_id,
    current_book.net_arr_usd,
    CASE WHEN salesforce_account.mapping_conflict THEN NULL ELSE NULLIF(TRIM(salesforce_account.NAME), '') END AS account_name,
    CASE WHEN salesforce_account.mapping_conflict THEN NULL ELSE NULLIF(TRIM(salesforce_account.INDUSTRY), '') END AS industry,
    CASE WHEN salesforce_account.mapping_conflict THEN NULL ELSE NULLIF(TRIM(salesforce_account.TYPE), '') END AS company_type,
    CASE WHEN salesforce_account.mapping_conflict THEN NULL ELSE NULLIF(TRIM(salesforce_account.BILLING_COUNTRY), '') END AS billing_country,
    ${accountExecutiveColumn}
    current_book.cs_segment,
    current_book.market_segment,
    current_book.account_health,${bullseyeColumns}${copilotColumns}
    CASE
      WHEN current_book.gainsight_mapping_conflict THEN 'conflicting_gainsight_mapping'
      WHEN salesforce_account.mapping_conflict THEN 'conflicting_salesforce_mapping'
      WHEN salesforce_account.ID IS NULL THEN 'salesforce_account_not_mapped'
      ELSE 'mapped'
    END AS account_mapping_state
  FROM current_book
  LEFT JOIN salesforce_account ON current_book.account_id = salesforce_account.ID
  ${accountExecutiveJoin}${bullseyeJoin}${copilotJoin}
), filtered_book AS (
  SELECT *
  FROM resolved_book AS book
  ${filters}
), ranked_book AS (
  SELECT
    filtered_book.*,
    COUNT(*) OVER () AS matched_account_count,
    ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS row_number
  FROM filtered_book
)
SELECT
  'scope' AS row_type,
  scope.scope_count,
  NULL::NUMBER AS matched_account_count,
  NULL::NUMBER AS row_number,
  ${scopeColumnProjection(request.columns)}
FROM scope
UNION ALL
SELECT
  'account' AS row_type,
  1 AS scope_count,
  matched_account_count,
  row_number,
  ${selectedColumnProjection(request.columns, "ranked_book")}
FROM ranked_book
WHERE row_number <= ${request.limit}
ORDER BY CASE row_type WHEN 'scope' THEN 0 ELSE 1 END, row_number
`.trim();
}

function readScope(rows) {
  const scope = rows.find((row) => field(row, "ROW_TYPE") === "scope");
  if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
    throw new BetaError("BOOK_OF_BUSINESS_SCOPE_UNAVAILABLE", "The signed-in Snowflake user does not map to one CSM profile, so no book-of-business analysis was shown.");
  }
}

function outputValue(column, value) {
  const definition = FIELD_DEFINITIONS[column];
  if (definition.kind === "number") return asFiniteNumber(value, definition.label);
  if (value == null || String(value).trim() === "") return NOT_MAPPED;
  return value;
}

export function bookOfBusinessPortfolioQueryCapabilities() {
  const fields = Object.entries(FIELD_DEFINITIONS).map(([key, definition]) => ({
    key,
    label: definition.label,
    source: definition.source,
    filterable: !definition.output_only,
    output: true,
    ...(definition.values ? { values: definition.values } : {}),
  }));
  return {
    read_only_analysis: {
      execution_owner: "authenticated_desktop_host",
      same_verified_connection: true,
      request_authorizes_read: true,
      typed_catalog_is_exhaustive: false,
      reference: "skills/csm-copilot-beta/references/read-only-analysis.md",
      instruction: "If this catalog cannot express the requested factual analysis, use a bounded read-only query on the same verified Snowflake connection. Preserve the requested scope and source permissions; do not ask for a case or another read approval.",
    },
    account_query: {
      scope: "Current book only: accounts where the authenticated CSM is the current Gainsight Success Owner.",
      supported_fields: fields,
      operators: ["equals", "is_missing", "is_not_missing"],
      maximum_filters: 4,
      maximum_rows: BOOK_OF_BUSINESS_PORTFOLIO_QUERY_MAX_ROWS,
      default_columns: DEFAULT_COLUMNS,
      output: "Account-level rows from the current book only. No contacts, CTAs, raw identifiers, raw SQL, beta-case persistence, or external write.",
      product_caveat: "Paid Copilot status is a product-state signal, not commercial-entitlement proof. Only paid_adopted means adopted; paid_not_adopted requires paid penetration and an explicit not-adopted state in the latest snapshot.",
    },
  };
}

export function presentBookOfBusinessPortfolioQuery(rows, input = {}, now = new Date()) {
  const request = normalizeBookOfBusinessPortfolioRequest(input);
  readScope(rows);
  const accountRows = rows.filter((row) => field(row, "ROW_TYPE") === "account");
  const matchedAccountCount = accountRows.length === 0
    ? 0
    : asFiniteNumber(field(accountRows[0], "MATCHED_ACCOUNT_COUNT"), "matched account count");
  if (!Number.isInteger(matchedAccountCount) || matchedAccountCount < accountRows.length) {
    throw new BetaError("BOOK_OF_BUSINESS_PORTFOLIO_RESPONSE_INVALID", "The portfolio read returned inconsistent account counts.");
  }
  const accounts = accountRows.map((row) => Object.fromEntries(request.columns.map((column) => [column, outputValue(column, field(row, column))])));
  const requested = requestedFields(request);
  return {
    scope: {
      label: "Current book of business",
      definition: "Accounts where the authenticated CSM is the current Gainsight Success Owner. CTA ownership is not required.",
    },
    filters: request.filters,
    columns: request.columns.map((column) => ({ key: column, label: FIELD_DEFINITIONS[column].label, source: FIELD_DEFINITIONS[column].source })),
    sort: request.sort,
    matched_account_count: matchedAccountCount,
    returned_account_count: accounts.length,
    has_more: matchedAccountCount > accounts.length,
    accounts,
    source_states: {
      gainsight_book: "checked",
      salesforce_account: "checked",
      bullseye_crm_book_attributes: [...requested].some((name) => FIELD_DEFINITIONS[name]?.requires_bullseye) ? "checked" : "not_requested",
      copilot_paid_product_snapshot: [...requested].some((name) => FIELD_DEFINITIONS[name]?.requires_copilot) ? "checked" : "not_requested",
    },
    source: "Gainsight current-book scope, joined only to fixed Salesforce, Bullseye Pro, and Copilot snapshot fields requested by the CSM.",
    product_caveat: [...requested].some((name) => FIELD_DEFINITIONS[name]?.requires_copilot)
      ? "Paid Copilot status is a product-state signal, not commercial-entitlement proof. Only paid_adopted means adopted."
      : null,
    read_at: now.toISOString(),
  };
}

export async function readBookOfBusinessPortfolioQueryWithSession({ session, filters, columns, sort, limit, now = new Date(), onProgress } = {}) {
  const input = { filters, columns, sort, limit };
  const request = normalizeBookOfBusinessPortfolioRequest(input);
  if (!session || typeof session.query !== "function") {
    throw new BetaError("BOOK_OF_BUSINESS_SESSION_REQUIRED", "The approved Snowflake session is required for book-of-business analysis.");
  }
  const startedAt = Date.now();
  let read;
  try {
    read = await runBookOfBusinessStatement({ session, sql: buildBookOfBusinessPortfolioQuerySql(request), onProgress });
    readScope(read.rows);
  } catch (error) {
    if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") {
      throw new BetaError("BOOK_OF_BUSINESS_PORTFOLIO_READ_TIMEOUT", `The account-level book query timed out after a ${BOOK_OF_BUSINESS_PORTFOLIO_QUERY_TIMEOUT_MS / 1000}-second first attempt and one retry capped at ${BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS / 60000} minutes. Nothing was saved.`);
    }
    if (error instanceof BetaError && error.code === "SNOWFLAKE_CLI_LOGGING_UNAVAILABLE") {
      throw new BetaError("BOOK_OF_BUSINESS_CLI_CONFIGURATION_REQUIRED", "The account-level book query could not start because the local Snowflake CLI logging setup needs repair. No data was read or saved.");
    }
    if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_START_TIMEOUT") {
      throw new BetaError("SNOWFLAKE_SIGN_IN_REQUIRED", "Snowflake/ZDP did not start this read. Complete browser sign-in, then try again.");
    }
    if (error instanceof BetaError && error.code.startsWith("BOOK_OF_BUSINESS_")) throw error;
    throw new BetaError("BOOK_OF_BUSINESS_PORTFOLIO_READ_FAILED", "The account-level book query could not be read. Check the existing Snowflake connection and try again.");
  }
  const result = presentBookOfBusinessPortfolioQuery(read.rows, request, now);
  result.read_deadline_seconds = BOOK_OF_BUSINESS_PORTFOLIO_QUERY_TIMEOUT_MS / 1000;
  result.retry_deadline_seconds = BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS / 1000;
  result.attempt_count = read.attempt_count;
  result.retry_used = read.retry_used;
  result.attempt_durations_ms = read.attempt_durations_ms;
  result.source_durations_ms = { book_of_business_portfolio_query: Date.now() - startedAt };
  return result;
}

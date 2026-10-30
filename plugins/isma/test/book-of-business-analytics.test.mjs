import assert from "node:assert/strict";
import test from "node:test";

import { BetaError } from "../mcp/core.mjs";
import {
  bookOfBusinessAnalyticsCapabilities,
  buildBookOfBusinessSummarySql,
  presentBookOfBusinessSummary,
  readBookOfBusinessSummaryWithSession,
} from "../mcp/book-of-business-analytics.mjs";

test("book-of-business analysis scopes to the authenticated CSM's current Gainsight book, not CTA ownership", () => {
  const query = buildBookOfBusinessSummarySql(["account_executive", "crm_region"]);
  assert.match(query, /LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)/);
  assert.match(query, /company\.SUCCESS_OWNER_C_GC = authenticated_csm\.GSID/);
  assert.match(query, /COUNT\(DISTINCT account_id\) AS account_count/);
  assert.match(query, /SALESFORCE_ACCOUNT_BCV/);
  assert.match(query, /salesforce_account\.OWNER_ID = account_executive\.ID/);
  assert.match(query, /PRESENTATION\.BULLSEYE_PRO\.CUSTOMERS/);
  assert.match(query, /GROUP BY dimension_1, dimension_2/);
  assert.equal(query.includes("GAINSIGHT_CALL_TO_ACTION_BCV"), false);
  assert.equal(query.includes("SALESFORCE_CONTACT"), false);
  assert.equal(query.includes("GONG_"), false);
  assert.equal(query.includes("TRANSCRIPT"), false);
});

test("a total-only book read does not scan optional owner or territory sources", () => {
  const query = buildBookOfBusinessSummarySql();
  assert.equal(query.includes("PRESENTATION.BULLSEYE_PRO.CUSTOMERS"), false);
  assert.equal(query.includes("SALESFORCE_ACCOUNT_BCV"), false);
  assert.equal(query.includes("SALESFORCE_USER_BCV"), false);
  assert.match(query, /'scope' AS row_type/);
  assert.match(query, /'summary' AS row_type/);
});

test("the aggregate result retains missing values and never exposes account identifiers", () => {
  const result = presentBookOfBusinessSummary([
    { ROW_TYPE: "summary", ACCOUNT_COUNT: 5, NET_ARR_USD: 225000, ACCOUNTS_MISSING_NET_ARR: 1 },
    { ROW_TYPE: "group", DIMENSION_1: "Invented AE", DIMENSION_2: "EMEA", ACCOUNT_COUNT: 3, NET_ARR_USD: 150000, ACCOUNTS_MISSING_NET_ARR: 0 },
    { ROW_TYPE: "group", DIMENSION_1: "Unassigned / unavailable", DIMENSION_2: "Not mapped / unavailable", ACCOUNT_COUNT: 2, NET_ARR_USD: 75000, ACCOUNTS_MISSING_NET_ARR: 1 },
  ], ["account_executive", "crm_region"], new Date("2026-09-23T10:00:00Z"));
  assert.equal(result.summary.account_count, 5);
  assert.equal(result.summary.accounts_missing_net_arr, 1);
  assert.deepEqual(result.groups[1].dimensions, {
    account_executive: "Unassigned / unavailable",
    crm_region: "Not mapped / unavailable",
  });
  assert.equal(JSON.stringify(result).includes("001000000000000AAA"), false);
});

test("a conflicting Gainsight account mapping stays visible and does not inflate Net ARR", () => {
  const query = buildBookOfBusinessSummarySql(["account_health"]);
  assert.match(query, /SELECT DISTINCT/);
  assert.match(query, /COUNT\(\*\) > 1 AS mapping_conflict/);
  assert.match(query, /CASE WHEN COUNT\(\*\) = 1 THEN MAX\(net_arr_usd\) ELSE NULL END/);
  const result = presentBookOfBusinessSummary([
    { ROW_TYPE: "summary", ACCOUNT_COUNT: 2, NET_ARR_USD: 50000, ACCOUNTS_MISSING_NET_ARR: 1, ACCOUNTS_WITH_GAINSIGHT_MAPPING_CONFLICTS: 1 },
    { ROW_TYPE: "group", DIMENSION_1: "Green", ACCOUNT_COUNT: 1, NET_ARR_USD: 50000, ACCOUNTS_MISSING_NET_ARR: 0, ACCOUNTS_WITH_GAINSIGHT_MAPPING_CONFLICTS: 0 },
    { ROW_TYPE: "group", DIMENSION_1: "Conflicting mapping", ACCOUNT_COUNT: 1, NET_ARR_USD: null, ACCOUNTS_MISSING_NET_ARR: 1, ACCOUNTS_WITH_GAINSIGHT_MAPPING_CONFLICTS: 1 },
  ], ["account_health"]);
  assert.equal(result.summary.accounts_with_gainsight_mapping_conflicts, 1);
  assert.equal(result.source_states.gainsight_book, "checked_with_conflicts");
});

test("the catalog maps renewal manager to the verified CRM renewal-owner field", () => {
  const capabilities = bookOfBusinessAnalyticsCapabilities();
  assert.deepEqual(capabilities.unavailable_dimensions, []);
  assert.deepEqual(
    capabilities.supported_dimensions.find((dimension) => dimension.key === "renewal_manager"),
    {
      key: "renewal_manager",
      label: "Renewal manager",
      source: "Bullseye Pro Customers CRM_RENEWAL_OWNER_NAME",
      state: "ready",
    },
  );
  const query = buildBookOfBusinessSummarySql(["renewal_manager"]);
  assert.match(query, /NULLIF\(TRIM\(CRM_RENEWAL_OWNER_NAME\), ''\) AS CRM_RENEWAL_OWNER_NAME/);
  assert.match(query, /LEFT JOIN renewal_manager/);
  assert.match(query, /renewal_manager\.mapping_conflict/);
  const result = presentBookOfBusinessSummary([
    { ROW_TYPE: "summary", ACCOUNT_COUNT: 2, NET_ARR_USD: 80000, ACCOUNTS_MISSING_NET_ARR: 0 },
    { ROW_TYPE: "group", DIMENSION_1: "Invented renewal manager", ACCOUNT_COUNT: 1, NET_ARR_USD: 50000, ACCOUNTS_MISSING_NET_ARR: 0 },
    { ROW_TYPE: "group", DIMENSION_1: "Not mapped / unavailable", ACCOUNT_COUNT: 1, NET_ARR_USD: 30000, ACCOUNTS_MISSING_NET_ARR: 0 },
  ], ["renewal_manager"]);
  assert.equal(result.source_states.bullseye_crm_renewal_manager, "checked");
  assert.equal(result.groups[1].dimensions.renewal_manager, "Not mapped / unavailable");
});

test("the aggregate catalog supports an industry distribution without scanning Salesforce users", () => {
  const capabilities = bookOfBusinessAnalyticsCapabilities();
  assert.deepEqual(
    capabilities.supported_dimensions.find((dimension) => dimension.key === "industry"),
    {
      key: "industry",
      label: "Industry",
      source: "Salesforce Account INDUSTRY",
      state: "ready",
    },
  );
  const query = buildBookOfBusinessSummarySql(["industry"]);
  assert.match(query, /SALESFORCE_ACCOUNT_BCV/);
  assert.match(query, /salesforce_account\.INDUSTRY/);
  assert.equal(query.includes("SALESFORCE_USER_BCV"), false);
});

test("the managed reader validates scope and aggregates in one 120-second first attempt", async () => {
  const seen = [];
  const session = {
    async query(sql, { timeoutMs }) {
      seen.push({ sql, timeoutMs });
      return [
        { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
        { ROW_TYPE: "summary", ACCOUNT_COUNT: 2, NET_ARR_USD: 80000, ACCOUNTS_MISSING_NET_ARR: 0 },
        { ROW_TYPE: "group", DIMENSION_1: "Strategic", ACCOUNT_COUNT: 2, NET_ARR_USD: 80000, ACCOUNTS_MISSING_NET_ARR: 0 },
      ];
    },
  };
  const result = await readBookOfBusinessSummaryWithSession({
    session,
    dimensions: ["cs_segment"],
    now: new Date("2026-09-23T10:00:00Z"),
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /scope_count/);
  assert.match(seen[0].sql, /DYNAMIC_SEGMENTATION_ENGAGEMENT_GC/);
  assert.equal(seen[0].timeoutMs, 120_000);
  assert.equal(result.groups[0].dimensions.cs_segment, "Strategic");
});

test("the aggregate reader reports a local CLI logging setup failure without presenting a timeout", async () => {
  const session = {
    async query() {
      throw new BetaError("SNOWFLAKE_CLI_LOGGING_UNAVAILABLE", "Invented local CLI logging failure");
    },
  };

  await assert.rejects(
    readBookOfBusinessSummaryWithSession({ session, dimensions: ["crm_region"] }),
    { code: "BOOK_OF_BUSINESS_CLI_CONFIGURATION_REQUIRED" },
  );
});

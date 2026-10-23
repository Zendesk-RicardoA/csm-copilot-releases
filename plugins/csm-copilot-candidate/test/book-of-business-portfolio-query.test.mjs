import assert from "node:assert/strict";
import test from "node:test";

import { BetaError } from "../mcp/core.mjs";
import {
  BOOK_OF_BUSINESS_PORTFOLIO_QUERY_MAX_ROWS,
  bookOfBusinessPortfolioQueryCapabilities,
  buildBookOfBusinessPortfolioQuerySql,
  normalizeBookOfBusinessPortfolioRequest,
  presentBookOfBusinessPortfolioQuery,
  readBookOfBusinessPortfolioQueryWithSession,
} from "../mcp/book-of-business-portfolio-query.mjs";

test("the account-level book query remains scoped to the authenticated CSM's current Gainsight book", () => {
  const query = buildBookOfBusinessPortfolioQuerySql({
    filters: [{ field: "renewal_manager", operator: "equals", value: "Invented renewal manager" }],
    columns: ["account_name", "net_arr_usd", "renewal_manager", "industry"],
    sort: { field: "account_name", direction: "asc" },
    limit: 50,
  });
  assert.match(query, /LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)/);
  assert.match(query, /company\.SUCCESS_OWNER_C_GC = authenticated_csm\.GSID/);
  assert.match(query, /CRM_RENEWAL_OWNER_NAME/);
  assert.match(query, /SALESFORCE_ACCOUNT_BCV/);
  assert.match(query, /salesforce_account\.INDUSTRY/);
  assert.match(query, /ROW_NUMBER\(\) OVER/);
  assert.equal(query.includes("GAINSIGHT_CALL_TO_ACTION_BCV"), false);
  assert.equal(query.includes("SALESFORCE_CONTACT"), false);
  assert.equal(query.includes("GONG_"), false);
  assert.equal(query.includes("TRANSCRIPT"), false);
  assert.equal(query.includes("ranked_book.account_id AS"), false);
});

test("an account list joins Salesforce users only when Account Executive is requested", () => {
  const countryQuery = buildBookOfBusinessPortfolioQuerySql({
    columns: ["account_name", "billing_country"],
    limit: 250,
  });
  assert.match(countryQuery, /SALESFORCE_ACCOUNT_BCV/);
  assert.equal(countryQuery.includes("SALESFORCE_USER_BCV"), false);
  assert.equal(countryQuery.includes("account_executive_values"), false);

  const renewalManagerQuery = buildBookOfBusinessPortfolioQuerySql({
    filters: [{ field: "renewal_manager", operator: "equals", value: "Invented renewal manager" }],
    columns: ["account_name", "renewal_manager"],
  });
  assert.match(renewalManagerQuery, /CRM_RENEWAL_OWNER_NAME/);
  assert.equal(renewalManagerQuery.includes("SALESFORCE_USER_BCV"), false);

  const accountExecutiveQuery = buildBookOfBusinessPortfolioQuerySql({
    columns: ["account_name", "account_executive"],
  });
  assert.match(accountExecutiveQuery, /SALESFORCE_USER_BCV/);
  assert.match(accountExecutiveQuery, /account_executive_values/);
});

test("the paid-Copilot filter starts from paid penetration and does not convert missing data to not adopted", () => {
  const query = buildBookOfBusinessPortfolioQuerySql({
    filters: [{ field: "copilot_paid_status", operator: "equals", value: "paid_not_adopted" }],
    columns: ["account_name", "copilot_paid_status", "copilot_snapshot_date"],
  });
  assert.match(query, /MAX\(SOURCE_SNAPSHOT_DATE\)/);
  assert.match(query, /copilot_snapshot\.SOURCE_SNAPSHOT_DATE/);
  assert.match(query, /CRM_IS_COPILOT_PAID_PENETRATED/);
  assert.match(query, /CRM_IS_COPILOT_PAID_ADOPTED/);
  assert.match(query, /paid_penetrated = TRUE AND copilot\.paid_adopted = FALSE THEN 'paid_not_adopted'/);
  assert.match(query, /WHEN copilot\.CRM_ACCOUNT_ID IS NULL THEN 'not_assessed'/);
  assert.equal(query.includes("COALESCE(copilot.paid_adopted, FALSE)"), false);
});

test("the native request only accepts a fixed field and operator catalog", () => {
  assert.throws(
    () => normalizeBookOfBusinessPortfolioRequest({ filters: [{ field: "anything; DROP TABLE", operator: "equals", value: "x" }] }),
    { code: "INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS" },
  );
  assert.throws(
    () => normalizeBookOfBusinessPortfolioRequest({ filters: [{ field: "industry", operator: "is_missing", value: "x" }] }),
    { code: "INVALID_BOOK_OF_BUSINESS_PORTFOLIO_FILTERS" },
  );
  assert.throws(
    () => normalizeBookOfBusinessPortfolioRequest({ limit: BOOK_OF_BUSINESS_PORTFOLIO_QUERY_MAX_ROWS + 1 }),
    { code: "INVALID_BOOK_OF_BUSINESS_PORTFOLIO_LIMIT" },
  );
});

test("the account-level response returns only requested account columns and stays transient", () => {
  const result = presentBookOfBusinessPortfolioQuery([
    { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
    {
      ROW_TYPE: "account",
      MATCHED_ACCOUNT_COUNT: 2,
      ACCOUNT_NAME: "Invented Account One",
      NET_ARR_USD: 120000,
      RENEWAL_MANAGER: "Invented renewal manager",
      ACCOUNT_MAPPING_STATE: "mapped",
    },
    {
      ROW_TYPE: "account",
      MATCHED_ACCOUNT_COUNT: 2,
      ACCOUNT_NAME: "Invented Account Two",
      NET_ARR_USD: null,
      RENEWAL_MANAGER: null,
      ACCOUNT_MAPPING_STATE: "mapped",
    },
  ], {
    filters: [{ field: "renewal_manager", operator: "equals", value: "Invented renewal manager" }],
    columns: ["account_name", "net_arr_usd", "renewal_manager", "account_mapping_state"],
    limit: 50,
  }, new Date("2026-09-23T10:00:00Z"));
  assert.equal(result.matched_account_count, 2);
  assert.equal(result.has_more, false);
  assert.deepEqual(result.accounts[0], {
    account_name: "Invented Account One",
    net_arr_usd: 120000,
    renewal_manager: "Invented renewal manager",
    account_mapping_state: "mapped",
  });
  assert.equal(result.accounts[1].renewal_manager, "Not mapped / unavailable");
  assert.equal(JSON.stringify(result).includes("001000000000000AAA"), false);
});

test("the reader checks scope and account rows in one 120-second first attempt", async () => {
  const seen = [];
  const session = {
    async query(sql, { timeoutMs }) {
      seen.push({ sql, timeoutMs });
      return [
        { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
        { ROW_TYPE: "account", MATCHED_ACCOUNT_COUNT: 1, ACCOUNT_NAME: "Invented Account", COPILOT_PAID_STATUS: "paid_not_adopted", COPILOT_SNAPSHOT_DATE: "2026-09-22" },
      ];
    },
  };
  const result = await readBookOfBusinessPortfolioQueryWithSession({
    session,
    filters: [{ field: "copilot_paid_status", operator: "equals", value: "paid_not_adopted" }],
    columns: ["account_name", "copilot_paid_status", "copilot_snapshot_date"],
    now: new Date("2026-09-23T10:00:00Z"),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeoutMs, 120_000);
  assert.match(seen[0].sql, /latest_copilot_snapshot/);
  assert.equal(result.accounts[0].copilot_paid_status, "paid_not_adopted");
  assert.match(result.product_caveat, /not commercial-entitlement proof/);
});

test("the account reader reports a local CLI logging setup failure without presenting a timeout", async () => {
  const session = {
    async query() {
      throw new BetaError("SNOWFLAKE_CLI_LOGGING_UNAVAILABLE", "Invented local CLI logging failure");
    },
  };

  await assert.rejects(
    readBookOfBusinessPortfolioQueryWithSession({ session, columns: ["account_name", "billing_country"] }),
    { code: "BOOK_OF_BUSINESS_CLI_CONFIGURATION_REQUIRED" },
  );
});

test("the published capability describes account filters without accepting raw SQL", () => {
  const capabilities = bookOfBusinessPortfolioQueryCapabilities();
  assert.equal(capabilities.account_query.maximum_rows, 250);
  assert.deepEqual(capabilities.account_query.operators, ["equals", "is_missing", "is_not_missing"]);
  assert.match(capabilities.account_query.output, /No contacts, CTAs, raw identifiers, raw SQL/);
  assert.match(capabilities.account_query.product_caveat, /paid_not_adopted/);
});

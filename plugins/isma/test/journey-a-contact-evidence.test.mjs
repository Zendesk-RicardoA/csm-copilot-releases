import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BetaError } from "../mcp/core.mjs";

import {
  buildPerformanceMetricTable,
  buildAccountContextSql,
  buildGuideKnowledgeViewMetricsSql,
  buildRbaPerformanceMetricsSql,
  buildCoreContactIdentitySql,
  buildBulkCoreContactIdentitySql,
  buildContactEvidenceSql,
  composeShortlistEvidence,
  CONTACT_ENRICHMENT_EXTENDED_RETRY_TIMEOUT_MS,
  CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS,
  readCoreContactEvidence,
  readBackgroundJourneyAContactEvidenceWithSession,
  readFastJourneyAContactEvidenceWithSession,
  readSlowJourneyAContactEvidenceWithSession,
  presentBulkContactResearch,
  readJourneyAContactEvidence,
  recommendContacts,
  retryJourneyAContactEnrichment,
  retryJourneyAContactEnrichmentWithSession,
} from "../mcp/journey-a-contact-evidence.mjs";

const ACCOUNT_ID = "001000000000000AAA";

test("the contact-evidence query is one selected-account, transcript-free Salesforce and 180-day Gong read", () => {
  const query = buildContactEvidenceSql(ACCOUNT_ID);
  assert.match(query, /SALESFORCE_CONTACT_FORMULA_BCV/);
  assert.match(query, /SALESFORCE_TASK_FORMULA_BCV/);
  assert.match(query, /MART_GONG_CALLS_BCV/);
  assert.match(query, /company\.SUCCESS_OWNER_C_GC = current_csm\.GSID/);
  assert.match(query, /ACCOUNT_HEALTH_STATUS_GC/);
  assert.match(query, /company\.NET_ARR_USD_GC AS net_arr_usd/);
  assert.equal(query.includes("salesforce.CHILD_OF_DU_ARR_C AS net_arr_usd"), false);
  assert.match(query, /GONG_CALL_EFFECTIVE_START_DATETIME >= DATEADD\(day, -180/);
  assert.match(query, /task\.ACTIVITY_DATE >= DATEADD\(day, -90/);
  assert.match(query, /participant\.AFFILIATION IN \('External', 'non_company'\)/);
  assert.equal(query.includes("TRANSCRIPT"), false);
  assert.equal(query.includes("RECORDING"), false);
});

test("the core contact shortlist query is account-scoped and uses only the current contact snapshot", () => {
  const query = buildCoreContactIdentitySql(ACCOUNT_ID);
  assert.match(query, /DIM_CRM_CONTACTS_DAILY_SNAPSHOT/);
  assert.match(query, /LAST_SALES_TOUCH_DATE_TIME/);
  assert.match(query, /WHERE CRM_ACCOUNT_ID = '001000000000000AAA'/);
  assert.match(query, /PARTITION BY CONTACT_ID/);
  assert.equal(query.includes("GAINSIGHT_COMPANY_BCV"), false);
  assert.equal(query.includes("SALESFORCE_CONTACT_FORMULA_BCV"), false);
  assert.equal(query.includes("SALESFORCE_ACCOUNT_BCV"), false);
  assert.equal(query.includes("SALESFORCE_TASK_FORMULA_BCV"), false);
  assert.equal(query.includes("GONG_"), false);
  assert.equal(query.includes("PRODUCT_ANALYTICS"), false);
  assert.equal(query.includes("CHILD_OF_DU_ARR_C"), false);
});

test("the account brief reads product snapshots from the selected account, not every account", () => {
  const query = buildAccountContextSql(ACCOUNT_ID);
  assert.match(query, /WHERE CRM_ACCOUNT_ID = '001000000000000AAA'/);
  assert.match(query, /QUALIFY ROW_NUMBER\(\) OVER \(ORDER BY SOURCE_SNAPSHOT_DATE DESC\) = 1/);
  assert.match(query, /cta\.COMPANY_ID = \(SELECT company_gsid FROM account_brief\)/);
  assert.match(query, /salesforce\.BILLING_COUNTRY AS billing_country/);
  assert.match(query, /company\.NET_ARR_USD_GC AS net_arr_usd/);
  assert.equal(query.includes("salesforce.CHILD_OF_DU_ARR_C AS net_arr_usd"), false);
  assert.equal(query.includes("latest_guide_snapshot"), false);
  assert.equal(query.includes("latest_copilot_snapshot"), false);
  assert.equal(query.includes("LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)"), false);
  assert.match(query, /SALESFORCE_ACCOUNT_BCV AS salesforce/);
  assert.match(query, /salesforce\.INDUSTRY AS company_industry/);
  assert.match(query, /DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS/);
  assert.doesNotMatch(query, /BQ_PRODUCT_ARCHIVE_SLA_POLICIES_EDW/);
  assert.match(query, /NULL::BOOLEAN AS team_setup_sla_active/);
  assert.match(query, /SECURITY_FEATURES_INSTANCE_DAILY_SNAPSHOT/);
  assert.match(query, /BASIC_TOOLS_AND_RULES_INSTANCE_DAILY_SNAPSHOT/);
  assert.match(query, /INSTALLED_APPS_SOURCE_DASHBOARD/);
  assert.match(query, /INTEGRATIONS_AND_FLEXIBILITY_INSTANCE/);
  assert.equal(query.includes("tam_"), false);
  assert.equal(query.includes("TECH_STACK_STORE"), false);
  assert.equal(query.includes("SALESFORCE_TASK_FORMULA_BCV"), false);
  assert.equal(query.includes("GONG_"), false);
});

test("active account intelligence uses monthly RBA and Guide views, not a rolling ticket snapshot", () => {
  const rbaQuery = buildRbaPerformanceMetricsSql(ACCOUNT_ID);
  const guideQuery = buildGuideKnowledgeViewMetricsSql(ACCOUNT_ID);
  assert.match(rbaQuery, /FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW/);
  assert.match(guideQuery, /FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT/);
  assert.match(rbaQuery, /CRM_ACCOUNT_ID = '001000000000000AAA'/);
  assert.match(guideQuery, /CRM_ACCOUNT_ID = '001000000000000AAA'/);
  assert.match(rbaQuery, /RBA_FRT_MEDIAN_HOURS/);
  assert.match(rbaQuery, /RBA_TTC_MEDIAN_HOURS/);
  assert.match(rbaQuery, /RBA_CREATED_TICKETS/);
  assert.match(rbaQuery, /RBA_SOLVED_TICKETS/);
  assert.match(rbaQuery, /COALESCE\(rba\.TICKET_IS_PREAGENT, FALSE\) = FALSE/);
  assert.match(rbaQuery, /'human_support' AS rba_ticket_scope/);
  assert.match(rbaQuery, /rba_trend_series/i);
  assert.match(guideQuery, /SUM\(guide\.COUNT_GUIDE_ARTICLE_VIEWS\)/);
  assert.match(guideQuery, /year_ago_guide_knowledge_views/i);
  assert.equal(guideQuery.includes("FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT"), false);
});

test("legacy contact evidence keeps Gmail separate from the snapshot shortlist", () => {
  let args;
  const result = readJourneyAContactEvidence({
    accountId: ACCOUNT_ID,
    now: new Date("2026-09-13T12:00:00Z"),
    runner: (_command, receivedArgs) => {
      args = receivedArgs;
      if (receivedArgs[6].includes("FACT_AGGREGATED_TICKETS_UNIONED_DAILY_SNAPSHOT")) {
        return { status: 0, stdout: JSON.stringify([{
          TICKET_METRICS_SNAPSHOT_DATE: "2026-08-31", YEAR_AGO_TICKET_METRICS_SNAPSHOT_DATE: "2025-08-31",
          TICKET_METRICS_INSTANCE_COUNT: 1, YEAR_AGO_TICKET_METRICS_INSTANCE_COUNT: 1,
          TICKETS_CREATED_28D: 1200, TICKETS_CLOSED_28D: 1180, CSAT_GOOD_28D: 81,
          CSAT_RESPONDED_28D: 90, CSAT_OFFERED_28D: 600, CSAT_SCORE_PCT: 90,
          YEAR_AGO_TICKETS_CREATED_28D: 1000, YEAR_AGO_TICKETS_CLOSED_28D: 950, YEAR_AGO_CSAT_SCORE_PCT: 85,
          TICKET_TREND_SERIES: [
            { period: "2026-03-31", tickets_created: 950, tickets_closed: 900, csat_score_pct: 83 },
            { period: "2026-08-31", tickets_created: 1200, tickets_closed: 1180, csat_score_pct: 90 },
          ],
        }]) };
      }
      if (receivedArgs[6].includes("FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW")) {
        return { status: 0, stdout: JSON.stringify([{
          RBA_METRICS_MONTH: 202608, YEAR_AGO_RBA_METRICS_MONTH: 202508,
          CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 1200,
          YEAR_AGO_CREATED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_CREATED_TICKETS: 1000,
          SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 1180,
          YEAR_AGO_SOLVED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_SOLVED_TICKETS: 950,
          FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 1.5,
          YEAR_AGO_FIRST_REPLY_VALUE_COUNT: 1, YEAR_AGO_MEDIAN_FIRST_REPLY_HOURS: 2,
          RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 22.5,
          YEAR_AGO_RESOLUTION_VALUE_COUNT: 1, YEAR_AGO_MEDIAN_RESOLUTION_HOURS: 24,
          ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 12.5,
          YEAR_AGO_ZERO_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ZERO_TOUCH_TICKET_RATIO: 10,
          ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 18.5,
          YEAR_AGO_ONE_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ONE_TOUCH_TICKET_RATIO: 20,
          RBA_TREND_SERIES: [
            { period: "202603", tickets_created: 950, tickets_solved: 900, median_first_reply_hours: 2.5, median_resolution_hours: 25, zero_touch_ticket_ratio: 10, one_touch_ticket_ratio: 20 },
            { period: "202608", tickets_created: 1200, tickets_solved: 1180, median_first_reply_hours: 1.5, median_resolution_hours: 22.5, zero_touch_ticket_ratio: 12.5, one_touch_ticket_ratio: 18.5 },
          ],
        }]) };
      }
      if (receivedArgs[6].includes("FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT")) {
        return { status: 0, stdout: JSON.stringify([{
          GUIDE_KNOWLEDGE_VIEWS_MONTH: 202608, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS_MONTH: 202508,
          GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 1343,
          YEAR_AGO_GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS: 1277,
          GUIDE_KNOWLEDGE_VIEW_TREND_SERIES: [
            { period: "202603", knowledge_views: 1200 },
            { period: "202608", knowledge_views: 1343 },
          ],
        }]) };
      }
      return { status: 0, stdout: JSON.stringify([{
        ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account", ACCOUNT_HEALTH: "Green", CS_SEGMENT: "Scaled",
        MARKET_SEGMENT: "Commercial", NET_ARR_USD: 15000, CSM_NAME: "Invented CSM", OPEN_CTA_COUNT: 2,
        CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Invented Contact", CONTACT_EMAIL: "invented@example.invalid",
        CONTACT_TITLE: "Support Lead", SALESFORCE_ACTIVITY_COUNT: 3, LATEST_ACTIVITY_AT: "2026-09-10",
        GONG_MEETING_COUNT: 1, LATEST_MEETING_AT: "2026-09-12T09:00:00Z",
      }]) };
    },
  });
  assert.equal(args[0], "--config-file");
  assert.equal(result.contacts.length, 1);
  assert.equal(result.brief.account_name, "Invented Account");
  assert.equal(result.brief.source_states.product_performance_metrics, "checked");
  assert.equal(result.brief.product_performance_metrics.rows.length, 7);
  assert.equal(result.brief.product_performance_metrics.rows[0].value, 1200);
  assert.equal(result.brief.product_performance_metrics.rows[0].period, "Month ending 2026-08");
  assert.equal(result.brief.product_performance_metrics.rows[0].source, "Monthly RBA aggregate — human-agent scope");
  assert.equal(result.brief.product_performance_metrics.rows[2].metric, "Median first reply time");
  assert.equal(result.brief.product_performance_metrics.rows[2].value, 1.5);
  assert.equal(result.brief.product_performance_metrics.rows[2].evidence_state, "measured");
  assert.equal(result.brief.product_performance_metrics.rows[2].period, "Month ending 2026-08");
  assert.equal(result.brief.product_performance_metrics.rows[2].year_ago_period, "Year-ago month ending 2025-08");
  assert.match(result.brief.product_performance_metrics.scope_note, /AI Agent\/pre-agent/);
  assert.match(result.brief.product_performance_metrics.rows[4].definition, /excluding tickets classified as AI Agent\/pre-agent/);
  assert.equal(result.brief.product_performance_metrics.rows[6].metric, "Knowledge views");
  assert.equal(result.brief.product_performance_metrics.rows[6].value, 1343);
  assert.match(result.brief.product_performance_metrics.rows[6].definition, /not proof of ticket deflection/);
  assert.equal(result.contacts[0].display_name, "Invented Contact");
  assert.equal(result.contacts[0].contact_ref.includes("003"), false);
  assert.equal(result.source_states.gong_metadata, "checked");
  assert.equal(result.gong_lookback_days, 180);
  assert.equal(result.gmail_metadata_request.action, "gmail_search_email_ids");
  assert.equal(result.gmail_metadata_request.query.includes("after:"), false);
  assert.equal(result.gmail_metadata_request.required_follow_up.format, "metadata");
  assert.equal(result.gmail_metadata_request.query.includes("Invented Contact"), false);
  assert.equal(typeof result.source_durations_ms.salesforce_contact_identity, "number");
  assert.match(args[1], /\.snowflake\/config\.toml$/);
});

test("contact evidence preserves the existing authenticated configuration when the source read fails", () => {
  let args;
  assert.throws(() => readJourneyAContactEvidence({
    accountId: ACCOUNT_ID,
    runner: (_command, receivedArgs) => {
      args = receivedArgs;
      return { status: 1, stdout: "" };
    },
  }), { code: "CONTACT_IDENTITY_READ_FAILED" });
  assert.match(args[1], /\.snowflake\/config\.toml$/);
});

test("core identity returns within the first-response budget without waiting for enrichment", () => {
  const timeouts = [];
  const result = readCoreContactEvidence({
    accountId: ACCOUNT_ID,
    now: new Date("2026-09-13T12:00:00Z"),
    runner: (_command, receivedArgs, options) => {
      timeouts.push(options.timeout);
      assert.equal(receivedArgs[6].includes("MART_GONG_CALLS_BCV"), false);
      return { status: 0, stdout: JSON.stringify([{
        ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account",
        CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Invented Contact",
        CONTACT_EMAIL: "invented@example.invalid", CONTACT_TITLE: "Support Lead",
      }]) };
    },
  });
  assert.deepEqual(timeouts, [25_000]);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.source_states.salesforce_identity, "checked");
  assert.equal(result.source_states.gong_metadata, "pending");
  assert.equal(result.gmail_metadata_request.action, "gmail_search_email_ids");
});

test("the first useful brief includes monthly RBA and Guide metrics before slow relationship reads", async () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [{ contact_ref: "contact", display_name: "Invented Contact" }],
    gmail_metadata_request: { action: "gmail_search_email_ids" },
    source_durations_ms: { salesforce_contact_identity: 10 },
  };
  const queries = [];
  const session = {
    async query(query) {
      queries.push(query);
      if (query.includes("FACT_GUIDE_ARTICLE_VIEWS")) return [{
        GUIDE_KNOWLEDGE_VIEWS_MONTH: 202608, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS_MONTH: 202508,
        GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 1343,
        YEAR_AGO_GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS: 1277,
      }];
      return [{
        RBA_METRICS_MONTH: 202608, YEAR_AGO_RBA_METRICS_MONTH: 202508,
        CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 25,
        YEAR_AGO_CREATED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_CREATED_TICKETS: 20,
        SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 24,
        YEAR_AGO_SOLVED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_SOLVED_TICKETS: 20,
        FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 1.5,
        RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 20,
        ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 10,
        ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 20,
      }];
    },
  };
  const result = await readFastJourneyAContactEvidenceWithSession({ accountId: ACCOUNT_ID, coreEvidence, session });
  assert.equal(queries.length, 2);
  assert.equal(queries.some((query) => query.includes("MART_GONG_CALLS_BCV")), false);
  assert.equal(queries.some((query) => query.includes("SALESFORCE_TASK_FORMULA_BCV")), false);
  assert.equal(result.source_states.account_context, "pending");
  assert.equal(result.brief.product_performance_metrics.rows.filter((row) => row.evidence_state === "measured").length, 7);
  assert.equal(result.source_states.rba_monthly_metrics, "checked");
  assert.equal(result.source_states.guide_knowledge_views, "checked");
  assert.equal(result.gmail_metadata_request.action, "gmail_search_email_ids");
});

test("slow relationship checks reuse fast monthly evidence without running it again", async () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [{ contact_ref: "ca675faad1ca7f313bc0c4f3b939e3d2c1ea886ddb1028b0559a755490fcac23", display_name: "Invented Contact", role: "Support Lead" }],
    gmail_metadata_request: null, source_durations_ms: {},
  };
  const fastEvidence = await readFastJourneyAContactEvidenceWithSession({
    accountId: ACCOUNT_ID, coreEvidence,
    session: { async query(query) { return query.includes("FACT_GUIDE_ARTICLE_VIEWS") ? [{ GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1 }] : [{ FIRST_REPLY_VALUE_COUNT: 1 }]; } },
  });
  const slowQueries = [];
  const result = await readSlowJourneyAContactEvidenceWithSession({
    accountId: ACCOUNT_ID, coreEvidence, fastEvidence,
    session: { async query(query) {
      slowQueries.push(query);
      if (query.includes("SALESFORCE_TASK_FORMULA_BCV")) return [];
      if (query.includes("MART_GONG_CALLS_BCV")) return [];
      return [{
        ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account",
        COMPANY_INDUSTRY: "Invented industry", COMPANY_EMPLOYEE_COUNT: 42,
        COMPANY_HQ_CITY: "Invented city", COMPANY_HQ_COUNTRY: "Invented country",
        COMPANY_WEBSITE: "https://example.invalid",
        TEAM_SETUP_INSTANCE_COUNT: 1, TEAM_SETUP_ACTIVE_AGENT_COUNT: 3,
        TEAM_SETUP_SLA_ACTIVE: true, TEAM_SETUP_SECURITY_COVERED_INSTANCE_COUNT: 1,
        TEAM_SETUP_CUSTOM_ROLE_INSTANCE_COUNT: 0, TEAM_SETUP_BASIC_RULE_TYPES_ADOPTED_MAX: 3,
        TECH_STACK_SSO_ENABLED_INSTANCE_COUNT: 1,
        TECH_STACK_GUIDE_EXTERNAL_CONNECTOR_INSTANCE_COUNT: 1,
        TECH_STACK_MARKETPLACE_APP_NAMES: ["Invented App"],
        TECH_STACK_MAX_ACTIVE_WEBHOOK_COUNT: 2,
      }];
    } },
  });
  assert.equal(slowQueries.length, 3);
  assert.equal(slowQueries.some((query) => query.includes("FACT_AGGREGATED_TICKETS") || query.includes("FACT_AGGREGATED_RBA")), false);
  assert.equal(result.source_states.rba_monthly_metrics, "checked");
  assert.equal(result.source_states.guide_knowledge_views, "checked");
  assert.equal(result.brief.company_profile.employee_count, 42);
  assert.equal(result.brief.team_setup.active_agent_count, 3);
  assert.equal(result.brief.team_setup.basic_rule_types_adopted_max, 3);
  assert.deepEqual(result.brief.tech_stack.marketplace_app_names, ["Invented App"]);
});

test("background contact verification uses one managed statement at a time after the first brief", async () => {
  const fastCoreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} }, contacts: [],
    gmail_metadata_request: null, source_durations_ms: {},
  };
  const fastEvidence = await readFastJourneyAContactEvidenceWithSession({
    accountId: ACCOUNT_ID, coreEvidence: fastCoreEvidence,
    session: { async query(query) { return query.includes("FACT_GUIDE_ARTICLE_VIEWS") ? [{ GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1 }] : [{ FIRST_REPLY_VALUE_COUNT: 1 }]; } },
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const session = {
    async query(query) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (query.includes("SALESFORCE_CONTACT_FORMULA_BCV") && query.includes("selected_account")) {
        return [{ ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account", CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Invented Contact", CONTACT_EMAIL: "invented@example.invalid", CONTACT_TITLE: "Support Lead" }];
      }
      if (query.includes("SALESFORCE_TASK_FORMULA_BCV") || query.includes("MART_GONG_CALLS_BCV")) return [];
      return [{ ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account" }];
    },
  };
  const result = await readBackgroundJourneyAContactEvidenceWithSession({
    accountId: ACCOUNT_ID, fastEvidence, session,
  });
  assert.equal(maxInFlight, 1);
  assert.equal(result.identity_available, true);
  assert.equal(result.contacts.length, 0);
  assert.equal(result.source_states.rba_monthly_metrics, "checked");
  assert.equal(Object.keys(result).includes("monthly_metric_source_results"), false);
});

test("background verification retries timed-out monthly metrics with the longer evidence budget", async () => {
  const attempts = { rba: [], guide: [] };
  const fastEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [],
    gmail_metadata_request: null,
    source_durations_ms: {},
    source_states: { rba_monthly_metrics: "timed_out", guide_knowledge_views: "timed_out" },
  };
  const session = {
    async query(query, { timeoutMs }) {
      if (query.includes("FACT_AGGREGATED_RBA")) {
        attempts.rba.push(timeoutMs);
        if (attempts.rba.length === 1) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "slow RBA aggregate");
        return [{ FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 1, RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 2, ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 0, ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 100 }];
      }
      if (query.includes("FACT_GUIDE_ARTICLE_VIEWS")) {
        attempts.guide.push(timeoutMs);
        if (attempts.guide.length === 1) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "slow Guide view aggregate");
        return [{ GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 30 }];
      }
      if (query.includes("SALESFORCE_TASK_FORMULA_BCV") || query.includes("MART_GONG_CALLS_BCV")) return [];
      return [{ ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account" }];
    },
  };
  const result = await readBackgroundJourneyAContactEvidenceWithSession({
    accountId: ACCOUNT_ID,
    fastEvidence,
    session,
  });
  assert.deepEqual(attempts.rba, [CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS, CONTACT_ENRICHMENT_EXTENDED_RETRY_TIMEOUT_MS]);
  assert.deepEqual(attempts.guide, [CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS, CONTACT_ENRICHMENT_EXTENDED_RETRY_TIMEOUT_MS]);
  assert.equal(result.identity_available, true);
});

test("slower enrichment gets a separate longer retry budget and keeps core contacts on timeout", () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [{ display_name: "Invented Contact", salesforce_activity_state: "pending", gong_metadata_state: "pending" }],
    gmail_metadata_request: null,
    source_durations_ms: { salesforce_contact_identity: 10 },
  };
  let timeout;
  const result = retryJourneyAContactEnrichment({
    accountId: ACCOUNT_ID,
    coreEvidence,
    runner: (_command, _receivedArgs, options) => {
      timeout = options.timeout;
      return { error: { code: "ETIMEDOUT" }, stdout: "" };
    },
  });
  assert.equal(timeout, CONTACT_ENRICHMENT_RETRY_TIMEOUT_MS);
  assert.equal(result.contacts[0].display_name, "Invented Contact");
  assert.equal(result.source_states.salesforce_identity, "checked");
  assert.equal(result.source_states.gong_metadata, "not_run_after_combined_enrichment_timeout");
  assert.deepEqual(result.source_gap_codes, ["COMBINED_CONTACT_ENRICHMENT_TIMEOUT"]);
});

test("core contacts survive a later enrichment timeout with visible source gaps", () => {
  const result = readJourneyAContactEvidence({
    accountId: ACCOUNT_ID,
    runner: (_command, receivedArgs) => {
      if (receivedArgs[6].includes("MART_GONG_CALLS_BCV")) return { error: { code: "ETIMEDOUT" }, stdout: "" };
      return { status: 0, stdout: JSON.stringify([{
        ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account", ACCOUNT_HEALTH: "Green", CS_SEGMENT: "Scaled",
        MARKET_SEGMENT: "Commercial", NET_ARR_USD: 15000, CSM_NAME: "Invented CSM",
        CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Invented Contact", CONTACT_EMAIL: "invented@example.invalid",
        CONTACT_TITLE: "Support Lead",
      }]) };
    },
  });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.source_states.salesforce_identity, "checked");
  assert.equal(result.source_states.salesforce_activity, "not_run_after_combined_enrichment_timeout");
  assert.equal(result.source_states.gong_metadata, "not_run_after_combined_enrichment_timeout");
  assert.deepEqual(result.source_gap_codes, ["COMBINED_CONTACT_ENRICHMENT_TIMEOUT"]);
  assert.equal(result.gmail_metadata_request.action, "gmail_search_email_ids");
});

test("independent enrichment preserves Salesforce activity when Gong is delayed", async () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [{ contact_ref: "ca675faad1ca7f313bc0c4f3b939e3d2c1ea886ddb1028b0559a755490fcac23", display_name: "Invented Contact", role: "Support Lead" }],
    gmail_metadata_request: { action: "gmail_search_email_ids" },
    source_durations_ms: {},
  };
  const session = {
    async query(query) {
      if (query.includes("MART_GONG_CALLS_BCV")) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "slow");
      if (query.includes("SALESFORCE_TASK_FORMULA_BCV")) return [{ CONTACT_ID: "003000000000000AAA", SALESFORCE_ACTIVITY_COUNT: 2, LATEST_ACTIVITY_AT: "2026-09-12" }];
      if (query.includes("FACT_AGGREGATED_TICKETS")) return [{}];
      if (query.includes("FACT_AGGREGATED_RBA")) return [{}];
      return [{ ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account", ACCOUNT_HEALTH: "Green", CS_SEGMENT: "Scaled", MARKET_SEGMENT: "Commercial" }];
    },
  };
  const result = await retryJourneyAContactEnrichmentWithSession({ accountId: ACCOUNT_ID, coreEvidence, session, now: new Date("2026-09-15T12:00:00Z") });
  assert.equal(result.source_states.salesforce_activity, "checked");
  assert.equal(result.source_states.gong_metadata, "timed_out");
  assert.equal(result.contacts[0].salesforce_activity_count, 2);
  // A timed-out optional Gong read is unknown, not evidence of zero meetings.
  assert.equal(result.contacts[0].gong_meeting_count, null);
  assert.equal(result.contacts[0].gong_metadata_state, "timed_out");
  assert.equal(result.source_gap_codes.includes("GONG_METADATA_TIMEOUT"), true);
  assert.equal(result.source_diagnostics.gong_metadata.failed_stage, "statement_execution");
  assert.equal(result.source_diagnostics.gong_metadata.statement_started, false);
});

test("completed Gong metadata without a contact match is bounded evidence, not proof of no calls", async () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [{ contact_ref: "ca675faad1ca7f313bc0c4f3b939e3d2c1ea886ddb1028b0559a755490fcac23", display_name: "Invented Contact", role: "Support Lead" }],
    gmail_metadata_request: null, source_durations_ms: {},
  };
  const session = { async query(query) {
    if (query.includes("MART_GONG_CALLS_BCV")) return [];
    if (query.includes("SALESFORCE_TASK_FORMULA_BCV")) return [];
    if (query.includes("FACT_AGGREGATED_TICKETS") || query.includes("FACT_AGGREGATED_RBA")) return [{}];
    return [{ ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account" }];
  } };
  const result = await retryJourneyAContactEnrichmentWithSession({ accountId: ACCOUNT_ID, coreEvidence, session,
    now: new Date("2026-09-15T12:00:00Z") });
  assert.equal(result.source_states.gong_metadata, "checked");
  assert.equal(result.contacts[0].gong_meeting_count, 0);
  assert.equal(result.contacts[0].gong_match_state, "no_matching_metadata_in_bounded_read");
});

test("enrichment dispatches one active warehouse read", async () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [], gmail_metadata_request: null, source_durations_ms: {},
  };
  let inFlight = 0;
  let maxInFlight = 0;
  const session = {
    async query(query) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (query.includes("FACT_AGGREGATED_TICKETS") || query.includes("FACT_AGGREGATED_RBA")) return [{}];
      if (query.includes("SALESFORCE_TASK_FORMULA_BCV") || query.includes("MART_GONG_CALLS_BCV")) return [];
      return [{ ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account" }];
    },
  };
  await retryJourneyAContactEnrichmentWithSession({ accountId: ACCOUNT_ID, coreEvidence, session });
  assert.equal(maxInFlight, 1);
});

test("Gmail relationship metadata searches all available mailbox history", () => {
  const result = readCoreContactEvidence({
    accountId: ACCOUNT_ID,
    now: new Date("2026-09-15T12:00:00Z"),
    runner: () => ({ status: 0, stdout: JSON.stringify([{
      ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account",
      CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Invented Contact",
      CONTACT_EMAIL: "invented@example.invalid", CONTACT_TITLE: "Support Lead",
    }]) }),
  });
  assert.equal(result.gmail_metadata_request.query.includes("after:"), false);
});

test("a contact identity timeout stops same-run retries and identifies the failed source", () => {
  assert.throws(() => readJourneyAContactEvidence({
    accountId: ACCOUNT_ID,
    runner: () => ({ error: { code: "ETIMEDOUT" }, stdout: "" }),
  }), (error) => (
    error.code === "CONTACT_IDENTITY_READ_TIMEOUT"
    && error.details.source === "salesforce_contact_identity"
    && error.details.deadline_seconds === 25
    && error.details.retry_same_run === false
  ));
});

test("contact recommendations return only the most relevant contacts with visible reasons", () => {
  const recentTouch = new Date().toISOString();
  const result = recommendContacts([
    { contact_ref: "a", display_name: "Alex", role: "Support Lead", latest_recorded_sales_touch_at: recentTouch },
    { contact_ref: "b", display_name: "Blair", role: "Director", latest_recorded_sales_touch_at: recentTouch },
    { contact_ref: "c", display_name: "Casey", role: "Admin", latest_recorded_sales_touch_at: recentTouch },
    { contact_ref: "d", display_name: "Drew", role: "Manager" },
  ], { contact_snapshot: "checked" });
  assert.equal(result.state, "ranked");
  assert.equal(result.contacts.length, 3);
  assert.equal(result.contacts[0].contact_ref, "a");
  assert.equal(result.contacts[0].recommendation_reasons.includes("sales touch recorded in the last 30 days"), true);
  assert.equal(result.contacts[1].contact_ref, "c");
  assert.equal(result.contacts.some((contact) => contact.contact_ref === "d"), false);
  assert.equal(result.total_contact_count, 4);
  assert.equal(result.eligible_contact_count, 4);
});

test("a materially more recent contact beats a stale executive and keeps that executive separate", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const result = recommendContacts([
    { contact_ref: "a", display_name: "Avery", role: "CEO", latest_recorded_sales_touch_at: "2023-03-01T12:00:00Z" },
    { contact_ref: "b", display_name: "Blair", role: "Operations Manager", latest_recorded_sales_touch_at: "2026-09-10T12:00:00Z" },
    { contact_ref: "c", display_name: "Casey", role: "Support Lead", latest_recorded_sales_touch_at: "2026-08-15T12:00:00Z" },
  ], { contact_snapshot: "checked" }, 3, now);
  assert.deepEqual(result.contacts.map((contact) => contact.contact_ref), ["b", "c"]);
  assert.deepEqual(result.secondary_executive_contacts.map((contact) => contact.contact_ref), ["a"]);
  assert.equal(result.secondary_executive_contacts[0].contact_strategy, "executive_reengagement");
});

test("the bulk contact query uses only the current contact snapshot", () => {
  const query = buildBulkCoreContactIdentitySql([
    "001000000000000AAA",
    "001000000000001AAA",
  ]);
  assert.match(query, /FOUNDATIONAL\.CUSTOMER\.DIM_CRM_CONTACTS_DAILY_SNAPSHOT/);
  assert.match(query, /LAST_SALES_TOUCH_DATE_TIME/);
  assert.match(query, /CRM_ACCOUNT_ID IN/);
  assert.equal(query.includes("SALESFORCE_CONTACT_FORMULA_BCV"), false);
  assert.equal(query.includes("SALESFORCE_TASK_FORMULA_BCV"), false);
  assert.equal(query.includes("GONG_"), false);
});

test("bulk contact research returns one ranked shortlist per selected account", () => {
  const result = presentBulkContactResearch([
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Stale CEO", CONTACT_EMAIL: "stale@example.invalid", CONTACT_TITLE: "CEO", LATEST_SALES_TOUCH_AT: "2023-03-01T12:00:00Z", CANDIDATE_COUNT: 2 },
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000001AAA", CONTACT_NAME: "Current Operations", CONTACT_EMAIL: "current@example.invalid", CONTACT_TITLE: "Operations Manager", LATEST_SALES_TOUCH_AT: "2026-09-10T12:00:00Z", CANDIDATE_COUNT: 2 },
    { ACCOUNT_ID: "001000000000001AAA", CONTACT_ID: "003000000000002AAA", CONTACT_NAME: "Current Support", CONTACT_EMAIL: "casey@example.invalid", CONTACT_TITLE: "Support Lead", LATEST_SALES_TOUCH_AT: "2026-09-15T12:00:00Z", CANDIDATE_COUNT: 1 },
  ], [
    { accountId: "001000000000000AAA", accountName: "Invented A", workItemRef: "a".repeat(64), priority: "P0", ctaTitle: "P0: Non-Monthly Renewal" },
    { accountId: "001000000000001AAA", accountName: "Invented B", workItemRef: "b".repeat(64), priority: "P1", ctaTitle: "P1: Non-Monthly Renewal" },
  ], { now: new Date("2026-09-21T12:00:00Z") });
  assert.equal(result.length, 2);
  assert.equal(result[0].suggested_contacts[0].display_name, "Current Operations");
  assert.equal(result[0].secondary_executive_contacts[0].display_name, "Stale CEO");
  assert.equal(result[1].suggested_contacts[0].display_name, "Current Support");
});

test("bulk contact research hides addresses unless a copy-ready export is explicitly requested", () => {
  const rows = [
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Alex", CONTACT_EMAIL: "alex@example.invalid", CONTACT_TITLE: "Support Lead", LATEST_SALES_TOUCH_AT: "2026-09-18T12:00:00Z", CANDIDATE_COUNT: 1 },
    { ACCOUNT_ID: "001000000000001AAA", CONTACT_ID: "003000000000001AAA", CONTACT_NAME: "Blair", CONTACT_EMAIL: "blair@example.invalid", CONTACT_TITLE: "Operations Manager", LATEST_SALES_TOUCH_AT: "2026-09-17T12:00:00Z", CANDIDATE_COUNT: 1 },
  ];
  const selections = [
    { accountId: "001000000000000AAA", accountName: "Invented A", workItemRef: "a".repeat(64), priority: "P0", ctaTitle: "P0: Non-Monthly Renewal" },
    { accountId: "001000000000001AAA", accountName: "Invented B", workItemRef: "b".repeat(64), priority: "P1", ctaTitle: "P1: Non-Monthly Renewal" },
  ];
  const result = presentBulkContactResearch(rows, selections, { now: new Date("2026-09-21T12:00:00Z") });
  assert.equal(Array.isArray(result), true);
  assert.equal(JSON.stringify(result).includes("@example.invalid"), false);
  assert.equal("recipient_export" in result, false);
});

test("copy-ready bulk export includes every primary contact, both formats, and no stale executive", () => {
  const rows = [
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Stale CEO", CONTACT_EMAIL: "ceo@example.invalid", CONTACT_TITLE: "CEO", LATEST_SALES_TOUCH_AT: "2023-03-01T12:00:00Z", CANDIDATE_COUNT: 3 },
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000001AAA", CONTACT_NAME: "Current Operations", CONTACT_EMAIL: "ops@example.invalid", CONTACT_TITLE: "Operations Manager", LATEST_SALES_TOUCH_AT: "2026-09-18T12:00:00Z", CANDIDATE_COUNT: 3 },
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000002AAA", CONTACT_NAME: "Current Support", CONTACT_EMAIL: "jordan@example.invalid", CONTACT_TITLE: "Support Lead", LATEST_SALES_TOUCH_AT: "2026-09-17T12:00:00Z", CANDIDATE_COUNT: 3 },
    { ACCOUNT_ID: "001000000000001AAA", CONTACT_ID: "003000000000003AAA", CONTACT_NAME: "Current Admin", CONTACT_EMAIL: "casey@example.invalid", CONTACT_TITLE: "Support Admin", LATEST_SALES_TOUCH_AT: "2026-09-16T12:00:00Z", CANDIDATE_COUNT: 1 },
  ];
  const selections = [
    { accountId: "001000000000000AAA", accountName: "Invented A", workItemRef: "a".repeat(64), priority: "P0", ctaTitle: "P0: Non-Monthly Renewal" },
    { accountId: "001000000000001AAA", accountName: "Invented B", workItemRef: "b".repeat(64), priority: "P1", ctaTitle: "P1: Non-Monthly Renewal" },
  ];
  const result = presentBulkContactResearch(rows, selections, { includeContactEmails: true, now: new Date("2026-09-21T12:00:00Z") });
  assert.equal(Array.isArray(result), false);
  assert.equal(result.accounts[0].suggested_contacts.length, 2);
  // Owner-approved rule: the more recent exact touch wins, even within the same recency band.
  assert.equal(result.accounts[0].suggested_contacts[0].email_address, "ops@example.invalid");
  assert.equal(result.accounts[0].secondary_executive_contacts[0].display_name, "Stale CEO");
  assert.equal(result.recipient_export.one_email_per_line, "ops@example.invalid\njordan@example.invalid\ncasey@example.invalid");
  assert.equal(result.recipient_export.comma_separated, "ops@example.invalid, jordan@example.invalid, casey@example.invalid");
  assert.equal(result.recipient_export.one_email_per_line.includes("ceo@example.invalid"), false);
  assert.match(result.recipient_export.user_notice, /Clari Groove manually/i);
});

test("copy-ready bulk export deduplicates addresses and visibly flags missing or invalid addresses", () => {
  const rows = [
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000000AAA", CONTACT_NAME: "Alex", CONTACT_EMAIL: "same@example.invalid", CONTACT_TITLE: "Support Lead", LATEST_SALES_TOUCH_AT: "2026-09-18T12:00:00Z", CANDIDATE_COUNT: 3 },
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000001AAA", CONTACT_NAME: "No Address", CONTACT_EMAIL: null, CONTACT_TITLE: "Operations Manager", LATEST_SALES_TOUCH_AT: "2026-09-17T12:00:00Z", CANDIDATE_COUNT: 3 },
    { ACCOUNT_ID: "001000000000000AAA", CONTACT_ID: "003000000000002AAA", CONTACT_NAME: "Invalid Address", CONTACT_EMAIL: "invalid-address", CONTACT_TITLE: "Support Manager", LATEST_SALES_TOUCH_AT: "2026-09-16T12:00:00Z", CANDIDATE_COUNT: 3 },
    { ACCOUNT_ID: "001000000000001AAA", CONTACT_ID: "003000000000003AAA", CONTACT_NAME: "Blair", CONTACT_EMAIL: "SAME@example.invalid", CONTACT_TITLE: "Support Lead", LATEST_SALES_TOUCH_AT: "2026-09-15T12:00:00Z", CANDIDATE_COUNT: 1 },
  ];
  const selections = [
    { accountId: "001000000000000AAA", accountName: "Invented A", workItemRef: "a".repeat(64), priority: "P0", ctaTitle: "P0: Non-Monthly Renewal" },
    { accountId: "001000000000001AAA", accountName: "Invented B", workItemRef: "b".repeat(64), priority: "P1", ctaTitle: "P1: Non-Monthly Renewal" },
  ];
  const result = presentBulkContactResearch(rows, selections, { includeContactEmails: true, now: new Date("2026-09-21T12:00:00Z") });
  assert.equal(result.recipient_export.recipient_count, 1);
  assert.equal(result.recipient_export.one_email_per_line, "same@example.invalid");
  assert.equal(result.accounts[1].suggested_contacts[0].copy_ready_email_state, "duplicate_omitted");
  assert.deepEqual(result.accounts[0].copy_ready_email_warnings.map((warning) => warning.display_name), ["No Address", "Invalid Address"]);
  assert.equal(result.recipient_export.omitted_contact_count, 2);
});

test("contact recommendations use the hierarchy when optional engagement evidence is delayed", () => {
  const result = recommendContacts(
    [
      { contact_ref: "a", display_name: "Alex", role: "Director", salesforce_activity_count: 0, gong_meeting_count: 0 },
      { contact_ref: "b", display_name: "Blair", role: "Support Lead", salesforce_activity_count: 0, gong_meeting_count: 0 },
    ],
    { contact_snapshot: "checked", salesforce_activity: "timed_out", gong_metadata: "timed_out" },
  );
  assert.equal(result.state, "ranked");
  assert.deepEqual(result.contacts.map((contact) => contact.contact_ref), ["b", "a"]);
  assert.match(result.message, /latest recorded sales touch/i);
});

test("a shortlist remains available when slower activity and Gong reads are pending", () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [{ contact_ref: "a", display_name: "Alex", role: "Support Lead", identity_status: "eligible" }],
    gmail_metadata_request: { action: "gmail_search_email_ids" },
    source_durations_ms: { salesforce_contact_identity: 24_000 },
    read_at: "2026-09-16T12:00:00.000Z",
  };
  const fastEvidence = {
    brief: {
      product_performance_metrics: { rows: [{ metric: "Median first reply time", evidence_state: "measured" }] },
      source_states: { product_performance_metrics: "checked" },
    },
    source_states: { qbr_ticket_metrics: "checked", qbr_rba_metrics: "checked" },
    source_gap_codes: [],
    source_durations_ms: { qbr_ticket_metrics: 400, qbr_rba_metrics: 420 },
  };
  const evidence = composeShortlistEvidence({ coreEvidence, fastEvidence });
  const recommendations = recommendContacts(evidence.contacts, evidence.source_states);
  assert.equal(evidence.brief.product_performance_metrics.rows[0].metric, "Median first reply time");
  assert.equal(evidence.source_states.salesforce_identity, "checked");
  assert.equal(evidence.source_states.salesforce_activity, "pending");
  assert.equal(evidence.source_states.gong_metadata, "pending");
  assert.equal(recommendations.state, "ranked");
  assert.deepEqual(recommendations.contacts.map((contact) => contact.display_name), ["Alex"]);
});

test("final shortlist delivery turns unfinished supporting reads into visible source gaps", () => {
  const coreEvidence = {
    brief: { account_name: "Invented Account", source_states: {} },
    contacts: [{ contact_ref: "a", display_name: "Alex", role: "Support Lead", identity_status: "eligible" }],
    gmail_metadata_request: { action: "gmail_search_email_ids" },
  };
  const evidence = composeShortlistEvidence({ coreEvidence, secondarySourceState: "unavailable" });
  const recommendations = recommendContacts(evidence.contacts, evidence.source_states);
  assert.equal(evidence.source_states.salesforce_identity, "checked");
  assert.equal(evidence.source_states.salesforce_activity, "unavailable");
  assert.equal(evidence.source_states.gong_metadata, "unavailable");
  assert.deepEqual(evidence.source_gap_codes, ["SALESFORCE_ACTIVITY_UNAVAILABLE", "GONG_METADATA_UNAVAILABLE"]);
  assert.equal(recommendations.state, "ranked");
  assert.deepEqual(recommendations.contacts.map((contact) => contact.display_name), ["Alex"]);
});

test("contact recommendations exclude placeholder and shared-mailbox identities", () => {
  const result = recommendContacts([
    { contact_ref: "a", display_name: "Alex", role: "Support Lead", identity_status: "eligible", gong_meeting_count: 0 },
    { contact_ref: "b", display_name: "Unknown", role: "Support Lead", identity_status: "placeholder", gong_meeting_count: 3 },
    { contact_ref: "c", display_name: "Support", role: "Support", identity_status: "role_mailbox", gong_meeting_count: 4 },
  ], { salesforce_activity: "checked", gong_metadata: "checked" });
  assert.deepEqual(result.contacts.map((contact) => contact.contact_ref), ["a"]);
  assert.equal(result.total_contact_count, 3);
  assert.equal(result.eligible_contact_count, 1);
  assert.equal(result.excluded_contact_count, 2);
});

test("the performance-metric table keeps missing and conflicting values visible", () => {
  const table = buildPerformanceMetricTable({
    RBA_METRICS_MONTH: "2026-08-31",
    CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 0,
    SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 0,
    FIRST_REPLY_VALUE_COUNT: 2, MEDIAN_FIRST_REPLY_HOURS: null,
    RESOLUTION_VALUE_COUNT: 0, MEDIAN_RESOLUTION_HOURS: null,
    ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 0,
    ONE_TOUCH_VALUE_COUNT: 0, ONE_TOUCH_TICKET_RATIO: null,
    GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 0, GUIDE_KNOWLEDGE_VIEWS: null,
  });
  assert.equal(table.rows[0].evidence_state, "measured");
  assert.equal(table.rows[0].value, 0);
  assert.equal(table.rows[2].evidence_state, "conflicting");
  assert.equal(table.rows[3].evidence_state, "missing");
  assert.equal(table.rows[4].evidence_state, "measured");
  assert.equal(table.rows[4].value, 0);
  assert.equal(table.rows[4].comparison_state, "not_comparable");
  assert.equal(table.rows[6].evidence_state, "missing");
});

test("the performance-metric table exposes comparable trends without claiming product impact", () => {
  const table = buildPerformanceMetricTable({
    RBA_METRICS_MONTH: 202608, YEAR_AGO_RBA_METRICS_MONTH: 202508,
    CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 120, YEAR_AGO_CREATED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_CREATED_TICKETS: 100,
    SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 115, YEAR_AGO_SOLVED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_SOLVED_TICKETS: 105,
    FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 3, YEAR_AGO_FIRST_REPLY_VALUE_COUNT: 1, YEAR_AGO_MEDIAN_FIRST_REPLY_HOURS: 4,
    RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 20, YEAR_AGO_RESOLUTION_VALUE_COUNT: 1, YEAR_AGO_MEDIAN_RESOLUTION_HOURS: 25,
    ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 45, YEAR_AGO_ZERO_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ZERO_TOUCH_TICKET_RATIO: 40,
    ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 25, YEAR_AGO_ONE_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ONE_TOUCH_TICKET_RATIO: 20,
    RBA_TREND_SERIES: [
      { period: "202603", tickets_created: 100, tickets_solved: 90, median_first_reply_hours: 4, median_resolution_hours: 24, zero_touch_ticket_ratio: 40, one_touch_ticket_ratio: 20 },
      { period: "202608", tickets_created: 120, tickets_solved: 115, median_first_reply_hours: 3, median_resolution_hours: 20, zero_touch_ticket_ratio: 45, one_touch_ticket_ratio: 25 },
    ],
    GUIDE_KNOWLEDGE_VIEWS_MONTH: 202608, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS_MONTH: 202508,
    GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 1343,
    YEAR_AGO_GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS: 1277,
    GUIDE_KNOWLEDGE_VIEW_TREND_SERIES: [{ period: "202603", knowledge_views: 1200 }, { period: "202608", knowledge_views: 1343 }],
  });
  assert.match(table.scope_note, /source proves/);
  assert.equal(table.rows[0].source, "Monthly RBA aggregate — human-agent scope");
  assert.equal(table.rows[0].year_over_year_change, 20);
  assert.equal(table.rows[4].percentage_point_change, 5);
  assert.equal(table.rows[2].year_over_year_change, -1);
  assert.equal(table.rows[2].comparison_state, "comparable");
  assert.equal(table.rows[6].metric, "Knowledge views");
  assert.equal(table.rows[6].year_over_year_change_pct, 5.168363351605325);
  assert.match(table.rows[6].definition, /not proof of ticket deflection/);
});

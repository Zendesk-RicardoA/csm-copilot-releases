const account = "Invented Orchard";
const accountId = "001000000000000AAA";

export function rowsFor(sql) {
  if (sql.includes("owned_open_ctas")) return [
    { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
    {
      ROW_TYPE: "cta", SCOPE_COUNT: 1, CTA_ID: "invented-renewal-cta", ACCOUNT_ID: accountId,
      ACCOUNT_NAME: account, CTA_NAME: "P1: Non-Monthly Renewal", CTA_STATUS: "New",
      CTA_CREATED_AT: "2026-09-20T10:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue",
    },
  ];
  if (sql.includes("PRESENTATION.SUCCESS.BULLSEYE_VALUE_SELLING")) return ["Email", "Voice"].map(channel => ({
    INSTANCE_ACCOUNT_ID: 90001, AGGREGATION_MONTH: "2026-08-01", SNAPSHOT_DATE: "2026-09-01",
    CHOSEN_CLUSTER: "Invented peer cohort", CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 40, TICKET_CHANNEL_GROUP: channel, TICKET_REPLY: "Invented reply scope",
    MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 2, THE_25TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 1,
    THE_50TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 1.5, THE_75TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 3,
    CSAT_SCORE: 0.8, THE_25TH_CSAT_SCORE: 0.7, THE_50TH_CSAT_SCORE: 0.85, THE_75TH_CSAT_SCORE: 0.9,
  }));
  if (sql.includes("GAINSIGHT_CALL_TO_ACTION_BCV")) return [
    { CTA_TITLE: "P1: Non-Monthly Renewal", CTA_STATUS: "New", CREATED_AT: "2026-09-20", DUE_AT: "2026-10-01" },
  ];
  if (sql.includes("GAINSIGHT_COMPANY_BCV")) return [
    { ACCOUNT_NAME: account, CSM_NAME: "Invented CSM", ACCOUNT_HEALTH: "Green", CS_SEGMENT: "Scaled", MARKET_SEGMENT: "Commercial", NET_ARR_USD: 15000 },
  ];
  if (sql.includes("SALESFORCE_ACCOUNT_BCV")) return [
    { ACCOUNT_NAME: account, COMPANY_INDUSTRY: "Fictional services", COMPANY_EMPLOYEE_COUNT: 70, COMPANY_TYPE: "Private", COMPANY_SUMMARY: "Invented service company.", COMPANY_HQ_CITY: "Example City", COMPANY_HQ_COUNTRY: "Exampleland", COMPANY_WEBSITE: "https://example.invalid" },
  ];
  if (sql.includes("PRESENTATION.BULLSEYE_PRO.CUSTOMERS")) return [
    { ACCOUNT_EXECUTIVE: "Invented AE", RENEWAL_MANAGER: "Invented RM", ACCOUNT_REGION: "EMEA", ACCOUNT_SUB_REGION: "Example", RENEWAL_DATE: "2026-12-31", RENEWAL_DAYS_REMAINING: 98, RENEWAL_TERM: "Annual" },
  ];
  if (sql.includes("PRICING_COMM_SUBSCRIPTION")) return [
    { COMMERCIAL_SUBSCRIPTIONS_JSON: JSON.stringify([{ product_plan: "Professional", product_line: "Suite", offering: "Copilot", offering_group: "Copilot", status: "Active", seats: 4, arr_band: "12-100K", term_end: "2027-12-31" }]) },
  ];
  if (sql.includes("GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT")) return [{ GUIDE_ELIGIBLE: true, GUIDE_ACTIVATED: true, GUIDE_ADOPTED: false }];
  if (sql.includes("COPILOT_CRM_DAILY_SNAPSHOT")) return [{ COPILOT_PAID_PENETRATED: true, COPILOT_PAID_ACTIVATED: false, COPILOT_PAID_ADOPTED: false }];
  if (sql.includes("AI_AGENTS_CRM_DAILY_SNAPSHOT")) {
    if (!sql.includes("FROM FUNCTIONAL.PRODUCT_ANALYTICS.AI_AGENTS_CRM_DAILY_SNAPSHOT")) {
      throw new Error("The invented AI Agents reader requires the approved PRODUCT_ANALYTICS source.");
    }
    return [{}];
  }
  if (sql.includes("ZENDESK_SUITE_CRM_DAILY_SNAPSHOT") || sql.includes("BASIC_TOOLS_AND_RULES_CRM_DAILY_SNAPSHOT")) return [{}];
  if (sql.includes("FACT_AGGREGATED_TICKETS_DATA_DAILY_SNAPSHOT")) return [
    { TICKET_CHANNELS_MONTH: "2026-08-01", TICKET_CHANNELS_JSON: JSON.stringify([{ channel: "Email", tickets_created: 80, ticket_share: 0.67 }, { channel: "Web", tickets_created: 40, ticket_share: 0.33 }]) },
  ];
  if (sql.includes("FACT_AGGREGATED_RBA_KPIS")) return [{
    RBA_METRICS_MONTH: 202608, YEAR_AGO_RBA_METRICS_MONTH: 202508,
    CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 120, YEAR_AGO_CREATED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_CREATED_TICKETS: 100,
    SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 115, YEAR_AGO_SOLVED_TICKET_VALUE_COUNT: 1, YEAR_AGO_RBA_SOLVED_TICKETS: 105,
    FIRST_REPLY_VALUE_COUNT: 1, YEAR_AGO_FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 2, YEAR_AGO_MEDIAN_FIRST_REPLY_HOURS: 1.5,
    RESOLUTION_VALUE_COUNT: 1, YEAR_AGO_RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 20, YEAR_AGO_MEDIAN_RESOLUTION_HOURS: 18,
    ZERO_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 14, YEAR_AGO_ZERO_TOUCH_TICKET_RATIO: 10,
    ONE_TOUCH_VALUE_COUNT: 1, YEAR_AGO_ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 22, YEAR_AGO_ONE_TOUCH_TICKET_RATIO: 18,
    RBA_TREND_SERIES: [{ period: "202603", tickets_created: 105, tickets_solved: 98, median_first_reply_hours: 1.7, median_resolution_hours: 19, zero_touch_ticket_ratio: 12, one_touch_ticket_ratio: 20 }, { period: "202608", tickets_created: 120, tickets_solved: 115, median_first_reply_hours: 2, median_resolution_hours: 20, zero_touch_ticket_ratio: 14, one_touch_ticket_ratio: 22 }],
  }];
  if (sql.includes("FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT")) return [{ GUIDE_KNOWLEDGE_VIEWS_MONTH: 202608, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS_MONTH: 202508, GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 1343, YEAR_AGO_GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS: 1277, GUIDE_KNOWLEDGE_VIEW_TREND_SERIES: [{ period: "202603", knowledge_views: 1200 }, { period: "202608", knowledge_views: 1343 }] }];
  if (sql.includes("DIM_GROWTH_ENGINE_CUSTOMER_ACCOUNTS")) return [{ TEAM_SETUP_ACTIVE_AGENT_COUNT: 3, TEAM_SETUP_INSTANCE_COUNT: 1, TEAM_SETUP_SLA_ACTIVE: true }];
  if (sql.includes("recent_gong_spotlights_json")) return [{ RECENT_GONG_SPOTLIGHTS_JSON: "[]" }];
  if (sql.includes("PRESENTATION.BULLSEYE_PRO.SALES_ACTIVITY")) return [{ RELIABLY_MATCHED_CALL_COUNT: 0, RECENT_CALLS_JSON: "[]" }];
  throw new Error("The invented reader has no fixture for this governed statement.");
}

export class PersistentSnowflakeSession {
  async query(sql) { return rowsFor(sql); }
  close() {}
}

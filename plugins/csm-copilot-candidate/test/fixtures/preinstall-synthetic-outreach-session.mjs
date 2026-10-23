const accountId = "001000000000000AAA";

export class PersistentSnowflakeSession {
  async query(sql, { timeoutMs } = {}) {
    if (!sql.includes(accountId) && !sql.includes("owned_open_ctas")) {
      throw new Error("Invented outreach reader received an unscoped statement.");
    }
    if (sql.includes("owned_open_ctas")) {
      if (!sql.includes("authenticated_csm") || timeoutMs !== 25_000) throw new Error("CTA source contract changed.");
      return [
        { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
        { ROW_TYPE: "cta", CTA_ID: "invented-cta-1", ACCOUNT_ID: accountId, ACCOUNT_NAME: "Invented Orchard", CTA_NAME: "P1: Renewal", CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-20T10:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
      ];
    }
    if (sql.includes("current_contact_snapshot")) return [
      { CONTACT_ID: "invented-contact-1", CONTACT_NAME: "Invented Support Contact", CONTACT_EMAIL: "invented.person@example.invalid", CONTACT_TITLE: "Support Director", LATEST_SALES_TOUCH_AT: "2026-09-20T10:00:00Z" },
    ];
    if (sql.includes("FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW")) return [{
      RBA_METRICS_MONTH: 202608, CREATED_TICKET_VALUE_COUNT: 1, RBA_CREATED_TICKETS: 120,
      SOLVED_TICKET_VALUE_COUNT: 1, RBA_SOLVED_TICKETS: 115,
      FIRST_REPLY_VALUE_COUNT: 1, MEDIAN_FIRST_REPLY_HOURS: 2,
      RESOLUTION_VALUE_COUNT: 1, MEDIAN_RESOLUTION_HOURS: 20,
      ZERO_TOUCH_VALUE_COUNT: 1, ZERO_TOUCH_TICKET_RATIO: 14,
      ONE_TOUCH_VALUE_COUNT: 1, ONE_TOUCH_TICKET_RATIO: 22,
    }];
    if (sql.includes("FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT")) return [{ GUIDE_KNOWLEDGE_VIEWS_MONTH: 202608, GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 1343 }];
    if (sql.includes("account_brief") && sql.includes("GAINSIGHT_COMPANY_BCV")) return [{
      ACCOUNT_ID: accountId, ACCOUNT_NAME: "Invented Orchard", CSM_NAME: "Invented CSM",
      ACCOUNT_HEALTH: "Green", CS_SEGMENT: "Scaled", NET_ARR_USD: 12000,
      BILLING_COUNTRY: "Exampleland", OPEN_CTA_COUNT: 1,
      CONTACT_ID: "invented-contact-1", CONTACT_NAME: "Invented Support Contact",
      CONTACT_EMAIL: "invented.person@example.invalid", CONTACT_TITLE: "Support Director",
    }];
    if (sql.includes("SALESFORCE_TASK_BCV")) return [];
    if (sql.includes("GONG_CALL")) return [];
    throw new Error("The invented outreach reader has no fixture for this governed statement.");
  }
  close() {}
}

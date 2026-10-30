import { BetaError } from "../../mcp/core.mjs";

const ctas = [
  { ROW_TYPE: "cta", SCOPE_COUNT: 1, CTA_ID: "invented-p0-cta", ACCOUNT_ID: "001000000000000AAA", ACCOUNT_NAME: "Invented Orchard", CTA_NAME: "P0: Non-Monthly Renewal", CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-20T10:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
  { ROW_TYPE: "cta", SCOPE_COUNT: 1, CTA_ID: "invented-p1-cta", ACCOUNT_ID: "001000000000001AAA", ACCOUNT_NAME: "Invented Grove", CTA_NAME: "P1: Non-Monthly Renewal", CTA_STATUS: "In Progress", CTA_CREATED_AT: "2026-09-21T10:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
];

export class PersistentSnowflakeSession {
  async query(sql, { timeoutMs } = {}) {
    if (!sql.includes("owned_open_ctas") || !sql.includes("authenticated_csm") || timeoutMs !== 25_000) {
      throw new Error("Invented Daily Focus reader received an unapproved query or deadline.");
    }
    if (process.env.CSM_SYNTHETIC_DAILY_MODE === "queue_timeout") {
      throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented timeout");
    }
    return [{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }, ...ctas];
  }
  close() {}
}

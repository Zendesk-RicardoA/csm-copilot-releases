import { PersistentSnowflakeSession as ContactSession } from "./contact-priority-session.mjs";
import { BetaError } from "../../mcp/core.mjs";

export class PersistentSnowflakeSession extends ContactSession {
  constructor(...args) { super(...args); this.rbaAttempts = 0; this.contextSources = new Set(); }
  async query(sql, options = {}) {
    const mode = process.env.CSM_MONTHLY_RECOVERY_MODE;
    if (sql.includes("account_brief")) this.contextSources.add("context");
    if (sql.includes("SALESFORCE_TASK_FORMULA_BCV")) this.contextSources.add("activity");
    if (sql.includes("GONG_CALL")) this.contextSources.add("gong");
    if (sql.includes("FACT_AGGREGATED_RBA_KPIS_MONTHLY_SNAPSHOT_CS_VIEW")) {
      this.rbaAttempts++;
      if (this.rbaAttempts === 1) {
        if (options.timeoutMs !== 25000) throw new Error("Invented fast metric budget changed.");
        throw new BetaError(mode === "query_failed" ? "SNOWFLAKE_SESSION_QUERY_FAILED" : "SNOWFLAKE_SESSION_TIMEOUT", "Invented first metric failure.");
      }
      if (this.rbaAttempts !== 2 || options.timeoutMs !== 120000 || !Number.isFinite(options.deadlineAtMs)
        || this.contextSources.size !== 3) throw new Error("Invented metric recovery escaped its serial source contract.");
      await new Promise(resolve => setTimeout(resolve, 180));
      if (mode === "retry_failed") throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented final metric timeout.");
    }
    return super.query(sql, options);
  }
}

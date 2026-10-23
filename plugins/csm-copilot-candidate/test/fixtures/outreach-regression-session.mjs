import { PersistentSnowflakeSession as BaseSession } from "./preinstall-synthetic-outreach-session.mjs";
import { BetaError } from "../../mcp/core.mjs";

export class PersistentSnowflakeSession extends BaseSession {
  async query(sql, options = {}) {
    const mode = process.env.CSM_OUTREACH_REGRESSION_MODE;
    if (sql.includes("SALESFORCE_TASK_FORMULA_BCV")) return [];
    if (sql.includes("current_contact_snapshot") && mode === "blocked_contacts") {
      return Array.from({ length: 9 }, (_, i) => ({ CONTACT_ID: `invented-placeholder-${i}`,
        CONTACT_NAME: `Unknown ${i}`, CONTACT_EMAIL: `invented.${i}@example.invalid`, CONTACT_TITLE: "Support Lead" }));
    }
    if (sql.includes("account_brief") && sql.includes("GAINSIGHT_COMPANY_BCV")) {
      await new Promise(resolve => setTimeout(resolve, mode === "progress" ? 150 : 30));
      if (mode === "context_unavailable") throw new BetaError("SOURCE_PERMISSION_DENIED", "Invented source failure.");
      if (options.timeoutMs < 95000) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented context exceeds the old deadline.");
    }
    return super.query(sql, options);
  }
}

import { PersistentSnowflakeSession as BaseSession } from "./preinstall-synthetic-outreach-session.mjs";
const ACCOUNT = "001000000000000AAA";
export class PersistentSnowflakeSession extends BaseSession {
  async query(sql, options = {}) {
    if (sql.includes("current_contact_snapshot")) return [
      { CONTACT_ID: "003000000000001AAA", CONTACT_NAME: "Invented Recent Operator", CONTACT_EMAIL: null, CONTACT_TITLE: "Operations", LATEST_SALES_TOUCH_AT: "2026-10-01T12:00:00Z" },
      { CONTACT_ID: "003000000000002AAA", CONTACT_NAME: "Invented Older Support", CONTACT_EMAIL: null, CONTACT_TITLE: "Support Director", LATEST_SALES_TOUCH_AT: "2026-09-01T12:00:00Z" },
      { CONTACT_ID: "003000000000003AAA", CONTACT_NAME: "Invented Unresolved Person", CONTACT_EMAIL: null, CONTACT_TITLE: "Director", LATEST_SALES_TOUCH_AT: "2026-08-01T12:00:00Z" },
      { CONTACT_ID: "003000000000004AAA", CONTACT_NAME: "Unknown", CONTACT_EMAIL: null, CONTACT_TITLE: null, LATEST_SALES_TOUCH_AT: null },
    ];
    if (sql.includes("native_contact_details")) {
      if (!sql.includes("ACCOUNT_ID = '" + ACCOUNT + "'") || !sql.includes("ID IN (") || options.timeoutMs > 120000) throw new Error("Invented lookup escaped the source contract.");
      await new Promise(resolve => setTimeout(resolve, 150));
      const account = process.env.CSM_CONTACT_PRIORITY_MODE === "mismatch" ? "001000000000001AAA" : ACCOUNT;
      return [
        { ACCOUNT_ID: account, CONTACT_ID: "003000000000001AAA", CONTACT_NAME: "Invented Recent Operator", CONTACT_EMAIL: "recent@example.invalid", CONTACT_TITLE: "Operations" },
        { ACCOUNT_ID: account, CONTACT_ID: "003000000000002AAA", CONTACT_NAME: "Invented Older Support", CONTACT_EMAIL: "older@example.invalid", CONTACT_TITLE: "Support Director" },
      ];
    }
    if (sql.includes("SALESFORCE_TASK_FORMULA_BCV")) return [];
    if (sql.includes("account_brief") && process.env.CSM_CONTACT_PRIORITY_MODE === "context_wait") await new Promise(resolve => setTimeout(resolve, 300));
    return super.query(sql, options);
  }
}

import { BetaError } from "../../mcp/core.mjs";

export const BOOK_OF_BUSINESS_READ_TIMEOUT_MS = 120_000;
export const BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS = 300_000;
const attempts = new Map();

export async function runBookOfBusinessStatement({ session, sql, onProgress = () => {} }) {
  const durations = [];
  for (const [index, timeoutMs] of [BOOK_OF_BUSINESS_READ_TIMEOUT_MS, BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS].entries()) {
    onProgress({ phase: "reading", attempt: index + 1, attempt_deadline_seconds: timeoutMs / 1000, started_at_ms: Date.now() });
    try {
      const rows = await session.query(sql, { timeoutMs });
      durations.push(0);
      return { rows, attempt_count: index + 1, retry_used: index > 0, attempt_durations_ms: durations };
    } catch (error) {
      durations.push(0);
      if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT" && index === 0) continue;
      throw error;
    }
  }
  throw new Error("unreachable");
}

export class BookOfBusinessReadSession {
  async query(sql, { timeoutMs } = {}) {
    if (![120_000, 300_000].includes(timeoutMs) || !sql.includes("authenticated_csm") || !sql.includes("CURRENT_USER()")) {
      throw new Error("Invented book reader received an unapproved query or deadline.");
    }
    const kind = sql.includes("matched_account_count") ? "accounts" : "summary";
    const mode = process.env.CSM_SYNTHETIC_BOOK_MODE || "ready";
    const key = `${mode}:${kind}`;
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);
    if (mode === "retry" && attempt === 1) {
      throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented first-attempt timeout.");
    }
    if (mode === "scope_gap") return [{ ROW_TYPE: "scope", SCOPE_COUNT: 0 }];
    if (kind === "summary") {
      if (!sql.includes("CRM_REGION") || !sql.includes("dimension_1")) throw new Error("Expected a governed CRM-region breakdown.");
      return [
        { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
        { ROW_TYPE: "summary", ACCOUNT_COUNT: 2, NET_ARR_USD: 30000, ACCOUNTS_MISSING_NET_ARR: 0 },
        { ROW_TYPE: "group", DIMENSION_1: "EMEA", ACCOUNT_COUNT: 1, NET_ARR_USD: 12000, ACCOUNTS_MISSING_NET_ARR: 0 },
        { ROW_TYPE: "group", DIMENSION_1: "Not mapped / unavailable", ACCOUNT_COUNT: 1, NET_ARR_USD: 18000, ACCOUNTS_MISSING_NET_ARR: 0 },
      ];
    }
    if (!sql.includes("CRM_RENEWAL_OWNER_NAME") || !sql.includes("Invented Renewal Owner")) {
      throw new Error("Expected a governed renewal-manager account filter.");
    }
    return [
      { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
      { ROW_TYPE: "account", MATCHED_ACCOUNT_COUNT: 1, ACCOUNT_NAME: "Invented Orchard", RENEWAL_MANAGER: "Invented Renewal Owner", BILLING_COUNTRY: "Exampleland" },
    ];
  }
  close() {}
}

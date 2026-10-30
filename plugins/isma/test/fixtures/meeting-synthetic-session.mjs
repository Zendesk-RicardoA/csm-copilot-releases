import { rowsFor as renewalRowsFor } from "./renewal-synthetic-session.mjs";
import { BetaError } from "../../mcp/core.mjs";

const accountId = "001000000000000AAA";
const conversationKey = "invented_meeting_call_123";
const scope = { ROW_TYPE: "scope", SCOPE_COUNT: 1, ACCOUNT_MATCH_COUNT: 1 };
const account = { ROW_TYPE: "account", SCOPE_COUNT: 1, ACCOUNT_MATCH_COUNT: 1, ACCOUNT_ID: accountId, ACCOUNT_NAME: "Invented Orchard" };
const call = {
  ROW_TYPE: "call", SCOPE_COUNT: 1, ACCOUNT_ID: accountId, ACCOUNT_NAME: "Invented Orchard",
  CONVERSATION_KEY: conversationKey, CALL_AT: "2026-08-11T09:30:00Z", CALL_STATUS: "completed",
  CALL_DISPOSITION: "meeting", CALL_SCOPE: "customer", SPOTLIGHT_BRIEF: "Invented support review",
  SPOTLIGHT_OUTCOME: "A recommendations discussion was proposed", SPOTLIGHT_KEY_POINTS: "Invented workflow",
  SPOTLIGHT_NEXT_STEPS: "Review options", SPOTLIGHT_TYPE: "discovery", TRACKERS: "[]",
  HAS_CALL_RECORDING: true, SOURCE_UPDATED_AT: "2026-08-12T00:00:00Z",
};

export class PersistentSnowflakeSession {
  async query(sql) {
    const mode = process.env.CSM_SYNTHETIC_MEETING_MODE || "ready";
    if (sql.includes("best_accounts") || sql.includes("SHA2(CONCAT('account:'")) {
      if (mode === "account_mismatch" && sql.includes("SHA2(CONCAT('account:'")) {
        return [scope, { ...account, ACCOUNT_ID: "001000000000001AAA" }];
      }
      return [scope, account];
    }
    if (sql.includes("bounded_calls") || sql.includes("reliably_matched_call_keys")) {
      if (mode === "converge_only") throw new Error("The Converge flow must not use the legacy SQL Gong picker");
      if (mode === "gong_timeout") throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented timeout");
      return [call];
    }
    if (mode === "converge_only" && (sql.includes("COUNT(*) AS transcript_count") || sql.includes("AS safety_state") || sql.includes("AS finding_index"))) throw new Error("The Converge flow must not use the legacy SQL transcript screen");
    if (sql.includes("COUNT(*) AS transcript_count")) return [{ TRANSCRIPT_COUNT: 1, SOURCE_UPDATED_AT: "2026-08-12T00:00:00Z" }];
    if (sql.includes("AS safety_state")) return [{ CHUNK_INDEX: 0, CHUNK_COUNT: 1, SAFETY_STATE: mode === "restricted" ? "restricted" : "clear" }];
    if (sql.includes("AS finding_index")) return [
      { CHUNK_INDEX: 0, CHUNK_COUNT: 1, FINDING_INDEX: 0, CATEGORY: "pain_point", PARAPHRASE: "The support team manually routes some ticket categories.", TOPIC_REFERENCE: "Routing discussion", CONFIDENCE: "medium" },
      { CHUNK_INDEX: 0, CHUNK_COUNT: 1, FINDING_INDEX: 1, CATEGORY: "goal", PARAPHRASE: "The team wants to reduce ticket handling time.", TOPIC_REFERENCE: "Goals discussion", CONFIDENCE: "medium" },
    ];
    return renewalRowsFor(sql);
  }
  close() {}
}

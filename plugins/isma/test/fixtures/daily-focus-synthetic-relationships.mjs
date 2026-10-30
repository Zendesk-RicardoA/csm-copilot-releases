import { BetaError } from "../../mcp/core.mjs";
import { presentPortfolioRelationships } from "../../mcp/journey-a-portfolio-relationships.mjs?synthetic-original";

export async function readPortfolioRelationships({ lookbackDays = 60, onProgress } = {}) {
  onProgress?.({ stage: "recent_salesforce_activity", stage_deadline_seconds: 60 });
  if (process.env.CSM_SYNTHETIC_DAILY_MODE === "relationship_timeout") {
    throw new BetaError("PORTFOLIO_RELATIONSHIP_READ_TIMEOUT", "Invented timeout. Do not retry; use Gmail metadata.", { failed_stage: "recent_salesforce_activity", deadline_ms: 60_000 });
  }
  const rows = [
    { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
    { ROW_TYPE: "account", CTA_ID: "invented-p0-cta", ACCOUNT_ID: "001000000000000AAA", ACCOUNT_NAME: "Invented Orchard", CTA_NAME: "P0: Non-Monthly Renewal", SALESFORCE_ACTIVITY_COUNT: 1, LATEST_SALESFORCE_ACTIVITY_AT: "2026-09-23" },
    { ROW_TYPE: "account", CTA_ID: "invented-p1-cta", ACCOUNT_ID: "001000000000001AAA", ACCOUNT_NAME: "Invented Grove", CTA_NAME: "P1: Non-Monthly Renewal", SALESFORCE_ACTIVITY_COUNT: 0 },
  ];
  const result = presentPortfolioRelationships(rows, lookbackDays, new Date("2026-09-24T10:00:00Z"));
  Object.defineProperty(result, "runtimeSelectionByWorkItem", { enumerable: false, value: result.runtimeSelectionByWorkItem });
  result.read_deadline_seconds = 60;
  result.source_durations_ms = { recent_salesforce_activity: 0 };
  return result;
}

import { BetaError } from "./core.mjs";

// Owner-approved source correction. No silent V2 fallback is permitted.
export const PRODUCT_ANALYTICS_SOURCES = Object.freeze({
  guide: "FUNCTIONAL.PRODUCT_ANALYTICS.GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT",
  copilot: "FUNCTIONAL.PRODUCT_ANALYTICS.COPILOT_CRM_DAILY_SNAPSHOT",
  ai_agents: "FUNCTIONAL.PRODUCT_ANALYTICS.AI_AGENTS_CRM_DAILY_SNAPSHOT",
  suite: "FUNCTIONAL.PRODUCT_ANALYTICS.ZENDESK_SUITE_CRM_DAILY_SNAPSHOT",
  basic_tools: "FUNCTIONAL.PRODUCT_ANALYTICS.BASIC_TOOLS_AND_RULES_CRM_DAILY_SNAPSHOT",
  security_instances: "FUNCTIONAL.PRODUCT_ANALYTICS.SECURITY_FEATURES_INSTANCE_DAILY_SNAPSHOT",
  basic_tools_instances: "FUNCTIONAL.PRODUCT_ANALYTICS.BASIC_TOOLS_AND_RULES_INSTANCE_DAILY_SNAPSHOT",
  guide_instances: "FUNCTIONAL.PRODUCT_ANALYTICS.GUIDE_ADOPTION_INSTANCE_DAILY_SNAPSHOT",
  sla_policy_archive: "FUNCTIONAL.PRODUCT_ANALYTICS.BQ_PRODUCT_ARCHIVE_SLA_POLICIES_EDW",
});

/** Requires the caller's same selected-account account_instances CTE. */
export function buildHistoricalSlaPolicyCtes(accountId) {
  if (!/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId || "")) {
    throw new BetaError("INVALID_ACCOUNT_SELECTION", "The selected account reference is invalid.");
  }
  return `sla_archive_observations AS (
  SELECT archive.ACCOUNT_ID, archive.NUM_SLAS_ACTIVE, archive.RUN_AT
  FROM ${PRODUCT_ANALYTICS_SOURCES.sla_policy_archive} AS archive
  JOIN account_instances AS instance ON archive.ACCOUNT_ID = instance.instance_account_id
  WHERE archive.RUN_AT IS NOT NULL
  QUALIFY archive.RUN_AT = MAX(archive.RUN_AT) OVER (PARTITION BY archive.ACCOUNT_ID)
), sla_archive_latest AS (
  SELECT ACCOUNT_ID, MAX(RUN_AT) AS run_at,
    COUNT(DISTINCT COALESCE(TO_VARCHAR(NUM_SLAS_ACTIVE), '__NULL__')) > 1 AS count_conflict,
    CASE WHEN COUNT(DISTINCT COALESCE(TO_VARCHAR(NUM_SLAS_ACTIVE), '__NULL__')) = 1
      AND MIN(NUM_SLAS_ACTIVE) >= 0 AND MIN(NUM_SLAS_ACTIVE) = FLOOR(MIN(NUM_SLAS_ACTIVE))
      THEN MAX(NUM_SLAS_ACTIVE) ELSE NULL END AS NUM_SLAS_ACTIVE
  FROM sla_archive_observations
  GROUP BY ACCOUNT_ID
), support_setup AS (
  SELECT SUM(NUM_SLAS_ACTIVE) AS total_policy_count,
    MAX(NUM_SLAS_ACTIVE) AS max_policy_count,
    SUM(CASE WHEN NUM_SLAS_ACTIVE > 0 THEN 1 ELSE 0 END) AS positive_instance_count,
    COUNT(*) AS covered_instance_count,
    COUNT(*) - COUNT(NUM_SLAS_ACTIVE) AS unknown_policy_instance_count,
    SUM(CASE WHEN count_conflict THEN 1 ELSE 0 END) AS conflict_instance_count,
    MIN(run_at)::DATE AS oldest_snapshot_date, MAX(run_at)::DATE AS newest_snapshot_date
  FROM sla_archive_latest
)`;
}

export function historicalSlaPolicyColumns(alias = "support") {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("Invalid internal SLA alias");
  return `NULL::BOOLEAN AS team_setup_sla_active,
  ${alias}.total_policy_count AS team_setup_historical_sla_total_policy_count,
  ${alias}.max_policy_count AS team_setup_historical_sla_max_policy_count,
  ${alias}.positive_instance_count AS team_setup_historical_sla_positive_instance_count,
  ${alias}.covered_instance_count AS team_setup_historical_sla_covered_instance_count,
  ${alias}.unknown_policy_instance_count AS team_setup_historical_sla_unknown_instance_count,
  ${alias}.conflict_instance_count AS team_setup_historical_sla_conflict_instance_count,
  ${alias}.oldest_snapshot_date AS team_setup_historical_sla_oldest_date,
  ${alias}.newest_snapshot_date AS team_setup_historical_sla_newest_date`;
}

const field = (row, key) => row?.[key] ?? row?.[key.toLowerCase()] ?? null;
function count(row, key) {
  const value = field(row, key);
  if (value == null || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function sourceDate(value) {
  if (value instanceof Date) value = value.toISOString();
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(String(value || ""));
  return match ? match[1] : null;
}
export function sourceSnapshotDateRange(row, prefix) {
  const oldest = sourceDate(field(row, `${prefix}_OLDEST_SNAPSHOT_DATE`));
  const newest = sourceDate(field(row, `${prefix}_NEWEST_SNAPSHOT_DATE`));
  return oldest || newest ? { oldest, newest } : null;
}
export function historicalSlaPolicyEvidence(row) {
  const prefix = "TEAM_SETUP_HISTORICAL_SLA_";
  const covered = count(row, `${prefix}COVERED_INSTANCE_COUNT`);
  if (covered == null) return null;
  const measuredExpected = count(row, `${prefix}EXPECTED_INSTANCE_COUNT`);
  const currentExpected = count(row, "TEAM_SETUP_INSTANCE_COUNT");
  const expected = measuredExpected ?? currentExpected;
  const instanceMappingConflict = measuredExpected != null && currentExpected != null && measuredExpected !== currentExpected;
  const unknown = count(row, `${prefix}UNKNOWN_INSTANCE_COUNT`);
  const conflicts = count(row, `${prefix}CONFLICT_INSTANCE_COUNT`);
  const oldest = sourceDate(field(row, `${prefix}OLDEST_DATE`));
  const newest = sourceDate(field(row, `${prefix}NEWEST_DATE`));
  const total = count(row, `${prefix}TOTAL_POLICY_COUNT`);
  const maximum = count(row, `${prefix}MAX_POLICY_COUNT`);
  const positive = count(row, `${prefix}POSITIVE_INSTANCE_COUNT`);
  const complete = !instanceMappingConflict && expected > 0 && covered === expected && unknown === 0 && conflicts === 0
    && oldest != null && newest != null && oldest <= newest && total != null && maximum != null
    && positive != null && positive <= covered;
  return {
    state: "historical",
    coverage_state: conflicts > 0 || instanceMappingConflict ? "conflicting" : covered === 0 ? "no_data" : complete ? "checked" : "partially_checked",
    current_usage_state: "not_established",
    total_policy_count: complete ? total : null,
    max_policy_count_per_instance: complete ? maximum : null,
    instances_with_policies: complete ? positive : null,
    covered_instance_count: covered, expected_instance_count: expected,
    unknown_policy_instance_count: unknown, conflict_instance_count: conflicts,
    oldest_snapshot_date: oldest, newest_snapshot_date: newest,
    note: "Historical policy configuration for currently linked instances; this does not establish current SLA use or OLA configuration.",
  };
}

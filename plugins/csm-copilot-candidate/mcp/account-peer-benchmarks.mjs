import { buildRbaAccountInstancesSql } from "./journey-a-contact-evidence.mjs";

export const PEER_SOURCE = "PRESENTATION.SUCCESS.BULLSEYE_VALUE_SELLING";
export const MAX_PEER_ROWS = 100;
// Explicit CSM confirmation, not an inference from column names or values.
// This definition applies only to these fields and their peer percentiles.
export const PEER_RATE_UNIT_DEFINITIONS = Object.freeze(Object.fromEntries(
  ["CSAT_SCORE", "PERCENT_ZERO_REPLY_TICKETS", "REOPEN_RATE"].map(field => [field, Object.freeze({
    field, source: PEER_SOURCE, source_scale: "fraction_0_1", display_unit: "percent", multiplier: 100,
    authority: "csm_confirmed", confirmed_on: "2026-10-08", definition_ref: "peer-rate-units-2026-10-08",
  })]),
));
// Column names verified by metadata-only DESCRIBE on 2026-10-07. No runtime
// schema discovery, external skill, export or alternate customer-data path.
const METRICS = [
  ["TOTAL_MONTHLY_SOLVED_TICKET_VOLUME", "Tickets solved", "tickets", null],
  ["CSAT_SCORE", "CSAT score", "percent", "higher"],
  ["MEDIAN_FIRST_REPLY_TIME_IN_HOURS", "Median first reply time", "hours", "lower"],
  ["MEDIAN_FULL_RESOLUTION_TIME_IN_HOURS", "Median full resolution time", "hours", "lower"],
  ["SOLVED_TICKETS_PER_AGENT", "Solved tickets per agent", "tickets per agent", null],
  ["PERCENT_ZERO_REPLY_TICKETS", "Zero-reply tickets", "percent", null],
  ["REOPEN_RATE", "Reopen rate", "percent", "lower"],
];
const CONTEXT = ["INSTANCE_ACCOUNT_ID", "AGGREGATION_MONTH", "SNAPSHOT_DATE", "INDUSTRY_BUCKET", "CHOSEN_CLUSTER", "CHOSEN_CLUSTER_UNIQUE_ACCOUNTS", "TICKET_CHANNEL_GROUP", "TICKET_REPLY"];
export function buildAccountPeerBenchmarksSql(accountId) {
  const fields = [...CONTEXT, "TOTAL_MONTHLY_CREATED_TICKET_VOLUME", ...METRICS.flatMap(([field]) => [field, ...[25, 50, 75].map((p) => `THE_${p}TH_${field}`)])];
  return `WITH account_instances AS (
  ${buildRbaAccountInstancesSql(accountId, true)}
), scoped AS (
  SELECT ${fields.map((field) => `peer.${field}`).join(", ")}
  FROM ${PEER_SOURCE} AS peer
  JOIN account_instances AS instance ON peer.INSTANCE_ACCOUNT_ID = instance.ZENDESK_ACCOUNT_ID
  WHERE peer.AGGREGATION_MONTH < DATE_TRUNC('MONTH', CURRENT_DATE())
), latest AS (
  SELECT MAX(AGGREGATION_MONTH) AS aggregation_month FROM scoped
)
SELECT scoped.* FROM scoped
JOIN latest ON scoped.AGGREGATION_MONTH = latest.aggregation_month
QUALIFY SNAPSHOT_DATE = MAX(SNAPSHOT_DATE) OVER ()
ORDER BY INSTANCE_ACCOUNT_ID, CHOSEN_CLUSTER, TICKET_CHANNEL_GROUP, TICKET_REPLY
LIMIT ${MAX_PEER_ROWS + 1}`;
}
const get = (row, key) => row?.[key] ?? row?.[key.toLowerCase()] ?? null;
const numeric = (v) => !["number", "string"].includes(typeof v) || typeof v === "string" && !v.trim() || !Number.isFinite(Number(v)) ? null : Number(v);
const outsideRateRange = (value) => value != null && (value < 0 || value > 1);
const normalizeRate = (value, definition) => value == null ? null
  : definition ? outsideRateRange(value) ? null : value * definition.multiplier : value;
const month = (v) => /^\d{4}-\d{2}/.test(String(v || "")) ? String(v).slice(0, 7) : null;
export function buildPeerBenchmarkEvidence(rows, sourceState = "checked") {
  if (sourceState !== "checked") return { state: sourceState, source: PEER_SOURCE, operating_snapshot: [], comparisons: [], gap_details: [], note: "The approved snapshot and peer read did not complete. This is not evidence that the account has no peers." };
  if (!rows?.length) return { state: "no_data", source: PEER_SOURCE, operating_snapshot: [], comparisons: [], gap_details: [], note: "The read returned no matched snapshot for the selected operating instance." };
  const operating = [], comparisons = [], gaps = [], seen = new Map();
  for (const row of rows) {
    const period = month(get(row, "AGGREGATION_MONTH")), cohort = get(row, "CHOSEN_CLUSTER");
    const context = { period, snapshot_date: get(row, "SNAPSHOT_DATE"), cohort,
      cohort_accounts: numeric(get(row, "CHOSEN_CLUSTER_UNIQUE_ACCOUNTS")), industry: get(row, "INDUSTRY_BUCKET"),
      channel: get(row, "TICKET_CHANNEL_GROUP"), reply_scope: get(row, "TICKET_REPLY"), source: PEER_SOURCE };
    // Never sum channel-specific medians, merge reply cohorts or choose an
    // arbitrary row. Exact duplicate source rows are the only deduplication.
    for (const [key, metric, unit, direction] of [["TOTAL_MONTHLY_CREATED_TICKET_VOLUME", "Tickets created", "tickets", null], ...METRICS]) {
      const definition = PEER_RATE_UNIT_DEFINITIONS[key], sourceValue = numeric(get(row, key));
      const invalidCurrent = Boolean(definition && outsideRateRange(sourceValue));
      const item = { ...context, metric, unit, direction, current_value: normalizeRate(sourceValue, definition),
        ...(definition ? { rate_scale: definition.source_scale, unit_definition: definition, source_values: { current_value: sourceValue } }
          : unit === "source rate" ? { rate_scale: "unverified" } : {}),
        ...(invalidCurrent ? { invalid_fields: ["current_value"] } : {}) };
      const sourcePeers = METRICS.some(([field]) => field === key)
        ? Object.fromEntries([25, 50, 75].map((p) => [`p${p}`, numeric(get(row, `THE_${p}TH_${key}`))])) : null;
      const invalidPeers = definition && sourcePeers ? Object.keys(sourcePeers).filter(key => outsideRateRange(sourcePeers[key])) : [];
      const peers = sourcePeers ? Object.fromEntries(Object.entries(sourcePeers).map(([key, value]) => [key, normalizeRate(value, definition)])) : null;
      const identity = JSON.stringify([period, cohort, context.channel, context.reply_scope, metric]);
      // Distinct invalid source values must not collapse into a null duplicate.
      const values = JSON.stringify([sourceValue, sourcePeers]);
      if (seen.get(identity) === values) continue;
      if (seen.has(identity)) { item.state = "conflicting"; gaps.push("conflicting_peer_rows"); }
      else item.state = invalidCurrent ? "invalid_value" : item.current_value == null ? "missing" : unit === "source rate" ? "definition_gap" : "checked";
      seen.set(identity, values);
      operating.push(item);
      if (peers) {
        const state = ["conflicting", "definition_gap", "invalid_value"].includes(item.state) ? item.state : invalidPeers.length ? "invalid_value" : !period || !cohort || !context.cohort_accounts
          ? "missing_cohort" : item.current_value == null || Object.values(peers).every((v) => v == null) ? "missing" : "checked";
        comparisons.push({ ...item, ...peers, state,
          ...(definition ? { source_values: { current_value: sourceValue, ...sourcePeers } } : {}),
          ...(invalidCurrent || invalidPeers.length ? { invalid_fields: [...(item.invalid_fields || []), ...invalidPeers] } : {}) });
        if (state !== "checked") gaps.push(state);
      }
    }
  }
  // Mark both sides of a conflict, not just the later value.
  const conflicts = new Set(operating.filter((item) => item.state === "conflicting").map((i) => JSON.stringify([i.period, i.cohort, i.channel, i.reply_scope, i.metric])));
  for (const item of [...operating, ...comparisons]) if (conflicts.has(JSON.stringify([item.period, item.cohort, item.channel, item.reply_scope, item.metric]))) item.state = "conflicting";
  const gapDetails = new Map();
  for (const item of [...operating, ...comparisons]) {
    if (item.state === "checked") continue;
    const detail = { metric: item.metric, state: item.state, period: item.period, cohort: item.cohort,
      channel: item.channel, reply_scope: item.reply_scope,
      ...(item.state === "definition_gap" ? { reason: "Rate scale requires an explicit verified definition; column names and observed numeric ranges are not proof." } : {}),
      ...(item.invalid_fields?.length ? { invalid_fields: item.invalid_fields,
        reason: "Source rate value is outside the CSM-confirmed 0–1 range. No alternate scale was inferred." } : {}) };
    gapDetails.set(JSON.stringify(detail), detail);
  }
  const overflow = rows.length > MAX_PEER_ROWS;
  return { state: overflow || gaps.length ? "partially_checked" : "checked", source: PEER_SOURCE, operating_snapshot: operating, comparisons,
    source_limit_reached: overflow, gaps: [...new Set(gaps)], gap_details: [...gapDetails.values()],
    note: "Latest returned complete aggregation month. Every comparison retains its source cohort, channel and reply scope. P50 is the peer median, not an average. Percentiles are references, not agreed targets. Zero-reply share does not establish self-service or deflection. Different scopes are not combined. Rate units were confirmed by the CSM on 2026-10-08: CSAT, zero-reply and reopen source fractions are multiplied by 100 for both account values and peer percentiles. Producer SQL was not independently verified. Invalid or missing values remain gaps. Missing optional comparisons do not block the rest of a grounded deck." };
}

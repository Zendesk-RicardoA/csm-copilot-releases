import test from "node:test";
import assert from "node:assert/strict";
import { buildAccountPeerBenchmarksSql, buildPeerBenchmarkEvidence } from "../mcp/account-peer-benchmarks.mjs";
const row = { INSTANCE_ACCOUNT_ID: 90001, AGGREGATION_MONTH: "2026-09-01", SNAPSHOT_DATE: "2026-10-01", CHOSEN_CLUSTER: "Invented cohort", CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 100, TICKET_CHANNEL_GROUP: "Invented channel", TICKET_REPLY: "Invented reply scope", MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 0, THE_25TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 1, THE_50TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 2, THE_75TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 3 };
test("peer read uses the same selected operating instance, complete period and bounded latest snapshot", () => {
  const sql = buildAccountPeerBenchmarksSql("001000000000000AAA");
  for (const part of ["PRESENTATION.SUCCESS.BULLSEYE_VALUE_SELLING", "CRM_ACCOUNT_ID = '001000000000000AAA'", "CHOSEN_CLUSTER", "TICKET_REPLY", "THE_50TH_MEDIAN_FIRST_REPLY_TIME_IN_HOURS", "LIMIT 101"]) assert.ok(sql.includes(part));
  assert.throws(() => buildAccountPeerBenchmarksSql("unsafe'"), { code: "INVALID_ACCOUNT_SELECTION" });
});
test("zero, percentiles and scope remain explicit; unknown metrics are not synthesized", () => {
  const result = buildPeerBenchmarkEvidence([row, row]);
  assert.equal(result.comparisons.length, 7);
  const metric = result.comparisons.find((i) => i.metric === "Median first reply time");
  assert.equal(metric.current_value, 0); assert.equal(metric.p50, 2); assert.equal(metric.direction, "lower");
  assert.equal(metric.period, "2026-09"); assert.equal(metric.channel, "Invented channel");
  assert.equal(result.comparisons.find((i) => i.metric === "CSAT score").state, "missing");
});
test("missing cohort, conflicting values, overflow and timeout are visible, never absence or averaged medians", () => {
  assert.equal(buildPeerBenchmarkEvidence([], "timed_out").state, "timed_out");
  assert.equal(buildPeerBenchmarkEvidence([]).state, "no_data");
  assert.equal(buildPeerBenchmarkEvidence([{ ...row, CHOSEN_CLUSTER: null }]).comparisons[2].state, "missing_cohort");
  const conflict = buildPeerBenchmarkEvidence([row, { ...row, MEDIAN_FIRST_REPLY_TIME_IN_HOURS: 10 }]);
  assert.equal(conflict.comparisons.filter((i) => i.metric === "Median first reply time" && i.state === "conflicting").length, 2);
  assert.equal(buildPeerBenchmarkEvidence(Array(101).fill(row)).source_limit_reached, true);
});
const rateFields = [["CSAT_SCORE", "CSAT score"], ["PERCENT_ZERO_REPLY_TICKETS", "Zero-reply tickets"], ["REOPEN_RATE", "Reopen rate"]];
test("CSM-confirmed fractions normalize account and every peer percentile with source provenance", () => {
  const values = Object.fromEntries(rateFields.flatMap(([field]) => [[field, 0.25],
    [`THE_25TH_${field}`, 0.125], [`THE_50TH_${field}`, 0.5], [`THE_75TH_${field}`, 0.875]]));
  const source = { ...row, ...values, TOTAL_MONTHLY_SOLVED_TICKET_VOLUME: 250 };
  const result = buildPeerBenchmarkEvidence([source]);
  for (const [field, metric] of rateFields) {
    const item = result.comparisons.find(item => item.metric === metric);
    assert.equal(item.unit, "percent"); assert.equal(item.state, "checked");
    assert.equal(item.current_value, 25);
    assert.deepEqual([item.p25, item.p50, item.p75], [12.5, 50, 87.5]);
    assert.deepEqual(item.source_values, { current_value: 0.25, p25: 0.125, p50: 0.5, p75: 0.875 });
    assert.equal(item.unit_definition.field, field);
    assert.equal(item.unit_definition.authority, "csm_confirmed");
    assert.equal(item.unit_definition.confirmed_on, "2026-10-08");
    assert.equal(item.unit_definition.source_scale, "fraction_0_1");
    assert.equal(item.unit_definition.multiplier, 100);
    assert.equal(item.source, "PRESENTATION.SUCCESS.BULLSEYE_VALUE_SELLING");
    assert.equal(item.period, "2026-09"); assert.equal(item.channel, "Invented channel");
    assert.equal(result.operating_snapshot.find(item => item.metric === metric).current_value, 25);
  }
  assert.equal(source.CSAT_SCORE, 0.25);
  assert.equal(result.comparisons.find(item => item.metric === "Tickets solved").current_value, 250);
  assert.equal(result.comparisons.find(item => item.metric === "Median first reply time").p50, 2);
  assert.ok(!result.gaps.includes("definition_gap"));
  assert.match(result.note, /confirmed by the CSM/);
});
test("fraction boundaries and numeric strings convert once; missing and nonnumeric rates never become zero", () => {
  for (const [field, metric] of rateFields) {
    for (const value of [0, 1, 0.0035, "0.25"]) {
      const item = buildPeerBenchmarkEvidence([{ ...row, [field]: value, [`THE_50TH_${field}`]: value }]).comparisons.find(item => item.metric === metric);
      assert.equal(item.state, "checked");
      assert.ok(Math.abs(item.current_value - Number(value) * 100) < 1e-10);
      assert.equal(item.p50, item.current_value);
    }
    for (const value of [null, undefined, "", " ", true, false, NaN, Infinity, "not-a-number", [], {}]) {
      const item = buildPeerBenchmarkEvidence([{ ...row, [field]: value, [`THE_50TH_${field}`]: value }]).comparisons.find(item => item.metric === metric);
      assert.equal(item.state, "missing"); assert.equal(item.current_value, null); assert.equal(item.p50, null);
    }
  }
});
test("out-of-range source rates are visible data conflicts, not guessed alternative scales", () => {
  for (const [field, metric] of rateFields) {
    for (const value of [-0.1, 1.1, 25]) {
      const result = buildPeerBenchmarkEvidence([{ ...row, [field]: value, [`THE_50TH_${field}`]: 0.5 }]);
      const item = result.comparisons.find(item => item.metric === metric);
      assert.equal(item.state, "invalid_value"); assert.equal(item.current_value, null);
      assert.equal(item.source_values.current_value, value);
      assert.deepEqual(item.invalid_fields, ["current_value"]);
      assert.ok(result.gap_details.some(gap => gap.metric === metric && gap.state === "invalid_value"
        && gap.reason.includes("0–1") && gap.invalid_fields.includes("current_value")));
    }
    const result = buildPeerBenchmarkEvidence([{ ...row, [field]: 0.25, [`THE_50TH_${field}`]: 0.5, [`THE_75TH_${field}`]: 25 }]);
    const item = result.comparisons.find(item => item.metric === metric);
    assert.equal(item.state, "invalid_value"); assert.equal(item.current_value, 25); assert.equal(item.p50, 50); assert.equal(item.p75, null);
    assert.equal(item.source_values.p75, 25); assert.deepEqual(item.invalid_fields, ["p75"]);
    assert.equal(result.operating_snapshot.find(item => item.metric === metric).state, "checked");
  }
});
test("rate conversion keeps raw-row conflicts and does not extend to unconfirmed fields", () => {
  const result = buildPeerBenchmarkEvidence([{ ...row, CSAT_SCORE: 25, UNCONFIRMED_RATE: 0.25 }, { ...row, CSAT_SCORE: 30 }]);
  assert.equal(result.comparisons.filter(item => item.metric === "CSAT score" && item.state === "conflicting").length, 2);
  assert.deepEqual(result.comparisons.filter(item => item.metric === "CSAT score").map(item => item.source_values.current_value), [25, 30]);
  assert.ok(!JSON.stringify(result).includes("UNCONFIRMED_RATE"));
});

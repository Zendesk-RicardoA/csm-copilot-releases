import test from "node:test";
import assert from "node:assert/strict";
import { buildAccountPerformanceCharts, renderAccountPerformanceChartPng, accountPerformanceAxisLabels } from "../mcp/account-performance-charts.mjs";
const brief = (metrics) => ({ sections: { support_operations: { facts: { metric_table: metrics } } } });
test("monthly charts use actual months, preserve zero and gaps, and keep units separate", () => {
  const { charts } = buildAccountPerformanceCharts(brief([
    { metric: "Tickets created", unit: "tickets", trend: [{ period:"2026-06",value:0 },{ period:"2026-08",value:10 }] },
    { metric: "Tickets solved", unit: "tickets", trend: [{ period:"2026-07",value:3 },{ period:"2026-08",value:5 }] },
    { metric: "Median first reply time", unit: "hours", trend: [{ period:"2026-06",value:2.25 },{ period:"2026-08",value:1.5 }] },
  ]));
  assert.equal(charts.length,2); assert.equal(charts[0].type,"columns"); assert.equal(charts[0].series.length,2);
  assert.deepEqual(charts[0].series[0].points,[{ period:"2026-06",value:0 },{ period:"2026-07",value:null },{ period:"2026-08",value:10 }]);
  assert.equal(charts[1].unit,"hours"); assert.equal(charts[1].type,"line");
  const png = renderAccountPerformanceChartPng(charts[1]);
  assert.equal(png.subarray(1,4).toString(),"PNG"); assert.ok(png.length > 1000);
});
test("a single observation is a snapshot, not an invented monthly trend", () => {
  assert.equal(buildAccountPerformanceCharts(brief([{ metric:"CSAT",unit:"percent",trend:[{period:"2026-09",value:80}]}])).charts.length,0);
  assert.equal(buildAccountPerformanceCharts(brief([{metric:"CSAT",unit:"percent",trend:[{period:"2026-09",value:null}]}])).charts.length,0);
});
test("conflicting duplicate months remain a gap even if a later duplicate repeats one value",()=>{
  const result=buildAccountPerformanceCharts(brief([{metric:"Invented replies",unit:"hours",trend:[{period:"2026-06",value:1},{period:"2026-07",value:2},{period:"2026-07",value:3},{period:"2026-07",value:3},{period:"2026-08",value:4}]}]));
  assert.equal(result.charts[0].series[0].points[1].value,null);
  assert.ok(result.issues.includes("Invented replies:2026-07:conflicting"));
});

test("twelve-month chart labels remain readable across a year boundary without dropping periods", () => {
  const periods = Array.from({ length: 12 }, (_, index) => index < 4
    ? `2025-${String(index + 9).padStart(2, "0")}` : `2026-${String(index - 3).padStart(2, "0")}`);
  const labels = accountPerformanceAxisLabels(periods);
  assert.equal(labels.length, 12);
  assert.deepEqual(labels.map(label => label.index), Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(labels[0], { index: 0, month: "Sep", year: "2025" });
  assert.deepEqual(labels[4], { index: 4, month: "Jan", year: "2026" });
  assert.ok(labels.every(label => label.month.length === 3 && label.year.length === 4));
  const chart = buildAccountPerformanceCharts(brief([{ metric: "Invented replies", unit: "hours",
    trend: periods.map((period, index) => ({ period, value: index === 4 ? null : index })) }])).charts[0];
  assert.deepEqual(chart.series[0].points.map(point => point.period), periods);
  assert.equal(chart.series[0].points[4].value, null);
  assert.equal(renderAccountPerformanceChartPng(chart).readUInt32BE(16), 840);
});

test("longer histories space axis ticks without removing observations or hiding the first and last month", () => {
  const periods = Array.from({ length: 24 }, (_, index) => `${2025 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`);
  const labels = accountPerformanceAxisLabels(periods);
  assert.ok(labels.length <= 12);
  assert.equal(labels[0].index, 0);
  assert.equal(labels.at(-1).index, 23);
  assert.ok(labels.slice(1).every((label, index) => label.index - labels[index].index >= 2));
  const chart = buildAccountPerformanceCharts(brief([{ metric: "Invented tickets", unit: "tickets",
    trend: periods.map((period, value) => ({ period, value })) }])).charts[0];
  assert.equal(chart.series[0].points.length, 24);
});

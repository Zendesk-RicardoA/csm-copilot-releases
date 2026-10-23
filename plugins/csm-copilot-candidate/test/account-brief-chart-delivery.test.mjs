import test from "node:test";
import assert from "node:assert/strict";
import { accountBriefChartResult, accountBriefChartInlineImage } from "../mcp/account-brief-chart-delivery.mjs";
import { buildAccountPerformanceCharts } from "../mcp/account-performance-charts.mjs";

test("cached chart delivery returns an actual native PNG and does not claim visible display", () => {
  const display = buildAccountPerformanceCharts({ sections: { support_operations: { facts: { metric_table: [
    { metric: "Invented first reply", unit: "hours", trend: [{ period: "2026-06", value: 0 }, { period: "2026-08", value: 2.5 }] },
  ] } } } });
  assert.equal(display.charts.length, 1);
  const result = accountBriefChartResult(display, display.charts[0].id);
  assert.equal(result.isError, false);
  const receipt = JSON.parse(result.content[0].text);
  assert.equal(receipt.delivery_state, "image_returned_visibility_unverified");
  assert.equal(receipt.preferred_delivery, "authorized_temporary_png_markdown");
  assert.match(receipt.next_action, /local_file_delivery_authorized=true/);
  assert.deepEqual(receipt.inline_delivery, { helper: "generatedImage", image_content_index: 1, encoding: "data_url", separate_completed_exec: true, local_file_required: false });
  assert.match(receipt.next_action, /embed local_delivery.markdown directly in the final reply/);
  assert.match(receipt.next_action, /Otherwise keep the verified monthly tables/);
  assert.match(receipt.next_action, /Do not repeat the failed in-memory image route/);
  const nativeImage = result.content[1];
  assert.equal(nativeImage.type, "image");
  assert.equal(nativeImage.mimeType, "image/png");
  const bytes = Buffer.from(nativeImage.data, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(bytes.length > 1_000);
  assert.equal(bytes.readUInt32BE(16), 840);
  const output = accountBriefChartInlineImage(result);
  assert.equal(output.image_url, `data:image/png;base64,${nativeImage.data}`);
  assert.match(output.output_hint, /Invented first reply/);
  assert.match(output.output_hint, /hours/);
  assert.equal(Buffer.from(output.image_url.split(",")[1], "base64").compare(bytes), 0);
  assert.ok(!result.content[0].text.includes(nativeImage.data), "The PNG must not leak into tool text or a file handoff");
});

test("visible forwarding refuses missing, duplicate, corrupt or failed native output", () => {
  const display = buildAccountPerformanceCharts({ sections: { support_operations: { facts: { metric_table: [
    { metric: "Invented volume", unit: "tickets", trend: [{ period: "2026-06", value: 1 }, { period: "2026-07", value: 2 }] },
  ] } } } });
  const result = accountBriefChartResult(display, display.charts[0].id);
  for (const invalid of [null, { ...result, isError: true }, { ...result, content: [result.content[0]] },
    { ...result, content: [...result.content, result.content[1]] },
    { ...result, content: [result.content[0], { ...result.content[1], data: "not-a-native-png" }] }]) {
    assert.throws(() => accountBriefChartInlineImage(invalid), { code: "ACCOUNT_BRIEF_CHART_DELIVERY_INVALID" });
  }
});

test("a missing chart or absent monthly evidence is a visible gap, not a fabricated chart", () => {
  assert.throws(() => accountBriefChartResult({ charts: [] }, "invented-chart"), { code: "ACCOUNT_BRIEF_CHART_UNAVAILABLE" });
  assert.throws(() => accountBriefChartResult(null, "invented-chart"), { code: "ACCOUNT_BRIEF_CHART_UNAVAILABLE" });
});

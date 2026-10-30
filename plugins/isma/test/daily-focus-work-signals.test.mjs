import assert from "node:assert/strict";
import test from "node:test";
import { presentDailyFocusWorkSignals } from "../mcp/daily-focus-work-signals.mjs";

test("daily work digest is bounded, warns on source cap, and omits raw CTA details", () => {
  const queue = {
    queue: Array.from({ length: 12 }, (_, index) => ({
      work_item_ref: `opaque-${index}`,
      priority: index === 0 ? "P0" : null,
      account_display_name: `Invented Account ${index}`,
      cta_title: "Sensitive invented CTA title never returned",
      action_deadline: null,
      cta_due_at: null,
    })),
    source_limit_reached: true,
    read_at: "2026-09-25T10:00:00Z",
    read_deadline_seconds: 25,
  };
  const result = presentDailyFocusWorkSignals(queue);
  assert.equal(result.work_signals.length, 10);
  assert.equal(result.omitted_signals, 2);
  assert.deepEqual(result.source_gap_codes, ["WORK_SIGNALS_SOURCE_LIMIT_REACHED"]);
  assert.match(result.work_signals[0].reason, /P0 renewal CTA/);
  assert.doesNotMatch(JSON.stringify(result), /Sensitive invented CTA title/);
});

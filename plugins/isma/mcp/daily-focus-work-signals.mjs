// Daily Focus sees a small, transient work-signal digest, not the full CTA queue.
// The governed queue reader still owns book/CTA scoping and its 25-second deadline.
const MAX_SIGNALS = 10;

export function presentDailyFocusWorkSignals(queue) {
  const items = queue.queue.slice(0, MAX_SIGNALS).map((item) => ({
    workItemId: item.work_item_ref,
    reason: `${item.priority ? `${item.priority} renewal CTA` : "Open CTA"} for ${item.account_display_name}`,
    dueAt: item.action_deadline || item.cta_due_at || null,
    ctaDisposition: "queue",
  }));
  const omitted = Math.max(0, queue.queue.length - items.length);
  return {
    status: "ready",
    work_signals: items,
    returned_signals: items.length,
    omitted_signals: omitted,
    source_limit_reached: queue.source_limit_reached,
    source_gap_codes: queue.source_limit_reached ? ["WORK_SIGNALS_SOURCE_LIMIT_REACHED"] : [],
    warning: queue.source_limit_reached
      ? "The governed CTA source reached its limit; this is not a complete work-signal view."
      : omitted ? `${omitted} more work signals were returned by the governed source but not shown in this daily digest.` : null,
    read_at: queue.read_at,
    read_deadline_seconds: queue.read_deadline_seconds,
    next_action: "Review the daily focus, then confirm a route before opening an outreach case or full CTA queue.",
  };
}

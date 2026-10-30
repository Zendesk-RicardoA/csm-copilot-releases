// Capability-specific windows. They do not change CTA, portfolio or Converge limits.
export const ACCOUNT_EVIDENCE_FIRST_PASS_MS = 300_000;
export const ACCOUNT_EVIDENCE_RECOVERY_MS = 300_000;
export const ACCOUNT_EVIDENCE_STATEMENT_MS = 120_000;

/** One serial connection, coverage before retries, and no unbounded continuation. */
export async function readAccountEvidencePlan({ sources, read, nowMs = Date.now, onProgress = null, initialResults = {} }) {
  // A completed fast attempt is part of the same source budget. It must not
  // become a fresh first attempt followed by a third, hidden retry here.
  const results = Object.fromEntries(sources.filter(({ source }) => Object.hasOwn(initialResults, source))
    .map(({ source }) => [source, initialResults[source]]));
  const attempts = new Map(Object.keys(results).map(source => [source, 1]));
  const windows = [
    { stage: "account_evidence", duration: ACCOUNT_EVIDENCE_FIRST_PASS_MS },
    { stage: "account_evidence_recovery", duration: ACCOUNT_EVIDENCE_RECOVERY_MS },
  ];
  const retryable = (result) => result?.state === "timed_out"
    || result?.failure_code === "EVIDENCE_WINDOW_EXHAUSTED";
  for (const [pass, window] of windows.entries()) {
    const candidates = sources.filter((source) => (attempts.get(source.source) || 0) < 2 &&
      (pass === 0 ? !Object.hasOwn(results, source.source) : retryable(results[source.source])
      || (source.dependsOn && results[source.source]?.failure_code === "DEPENDENCY_NOT_CHECKED"
        && retryable(results[source.dependsOn]))));
    if (!candidates.length) break;
    // Unstarted independent reads go before second attempts. Dependencies stay
    // after their parent; a failed parent never becomes verified navigation data.
    if (pass) candidates.sort((a, b) => (attempts.get(a.source) || 0) - (attempts.get(b.source) || 0));
    const deadline = nowMs() + window.duration;
    const pending = [...candidates];
    while (pending.length) {
      let index = pending.findIndex((source) => !source.dependsOn || !pending.some((other) => other.source === source.dependsOn));
      if (index < 0) throw new Error("Account evidence has a circular source dependency.");
      const [source] = pending.splice(index, 1);
      if (source.dependsOn && results[source.dependsOn]?.state !== "checked") {
        results[source.source] = { state: "not_run", rows: [], failure_code: "DEPENDENCY_NOT_CHECKED" };
        read.skipped?.(source.source, window.stage, "DEPENDENCY_NOT_CHECKED");
        continue;
      }
      // Reserve a small start opportunity for every remaining source, rather
      // than allow an early statement or retry to consume the entire window.
      const remaining = Math.max(0, deadline - nowMs());
      const reserve = Math.min(3_000, Math.floor(remaining / (pending.length + 1)));
      const deadlineAtMs = deadline - pending.length * reserve;
      const available = Math.max(0, deadlineAtMs - nowMs());
      if (!available) {
        if (!results[source.source]) results[source.source] = { state: "not_run", rows: [], failure_code: "EVIDENCE_WINDOW_EXHAUSTED" };
        read.skipped?.(source.source, window.stage);
        continue;
      }
      const attempt = (attempts.get(source.source) || 0) + 1;
      attempts.set(source.source, attempt);
      onProgress?.({ stage: window.stage, stage_deadline_seconds: window.duration / 1000,
        source_deadline_seconds: Math.min(ACCOUNT_EVIDENCE_STATEMENT_MS, available) / 1000,
        source: source.source, attempt, completed_sources: Object.keys(results).length, total_sources: sources.length });
      results[source.source] = await read(source, {
        timeoutMs: Math.min(ACCOUNT_EVIDENCE_STATEMENT_MS, available), deadlineAtMs,
        attempt, phase: window.stage,
        retryState: attempt > 1 ? "retried_after_timeout" : pass ? "continued_after_window" : "not_retried",
      });
    }
  }
  return results;
}

import crypto from "node:crypto";

import { BetaError } from "./core.mjs";

const ACTIVE_LOOKUP_TTL_MS = 20 * 60_000;
const COMPLETED_LOOKUP_TTL_MS = 10 * 60_000;
const KINDS = new Set(["date", "date_range", "direct_link"]);

/** One transient, owner-bound source lookup. A completed Converge scope may
 * contain its native request in memory; no source payload is written to disk. */
export class MeetingPrepCallLookupJobs {
  constructor({ now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    this.now = now;
    this.randomBytes = randomBytes;
    this.jobs = new Map();
  }

  prune() {
    const now = this.now();
    for (const [ref, job] of this.jobs) {
      if (job.expiresAt <= now) this.jobs.delete(ref);
    }
  }

  scheduleExpiry(delayMs) {
    const timer = setTimeout(() => this.prune(), delayMs + 1);
    timer.unref?.();
  }

  start({ ownerRef, kind, read }) {
    this.prune();
    if (!ownerRef || !KINDS.has(kind) || typeof read !== "function") {
      throw new BetaError("MEETING_PREP_LOOKUP_INVALID", "A scoped Gong call lookup is required.");
    }
    for (const job of this.jobs.values()) {
      if (job.ownerRef === ownerRef && job.status === "in_progress") {
        throw new BetaError("MEETING_PREP_LOOKUP_IN_PROGRESS", "A Gong call lookup is already running. Continue that lookup before starting another.", { call_lookup_ref: job.ref });
      }
    }
    const startedAt = this.now();
    const ref = this.randomBytes(18).toString("base64url");
    const job = {
      ref, ownerRef, kind, status: "in_progress", startedAt,
      stage: "starting", stageStartedAt: startedAt, stageDeadlineSeconds: null,
      expiresAt: startedAt + ACTIVE_LOOKUP_TTL_MS, result: null, error: null,
    };
    this.jobs.set(ref, job);
    this.scheduleExpiry(ACTIVE_LOOKUP_TTL_MS);
    void Promise.resolve()
      .then(() => read((event) => {
        if (job.status !== "in_progress") return;
        job.stage = event.stage;
        job.stageStartedAt = this.now();
        job.stageDeadlineSeconds = event.stage_deadline_seconds;
      }))
      .then((result) => {
        job.status = "ready";
        job.result = result;
        job.expiresAt = this.now() + COMPLETED_LOOKUP_TTL_MS;
        this.scheduleExpiry(COMPLETED_LOOKUP_TTL_MS);
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error instanceof BetaError
          ? {
            code: error.code,
            message: error.message,
            ...(error.code === "MEETING_PREP_CALL_READ_TIMEOUT" && typeof error.details?.stage === "string"
              ? { failed_stage: error.details.stage, deadline_seconds: error.details.deadline_seconds }
              : {}),
          }
          : { code: "MEETING_PREP_LOOKUP_FAILED", message: "The Gong call lookup failed before returning a result." };
        job.expiresAt = this.now() + COMPLETED_LOOKUP_TTL_MS;
        this.scheduleExpiry(COMPLETED_LOOKUP_TTL_MS);
      });
    return this.poll({ ref, ownerRef });
  }

  poll({ ref, ownerRef }) {
    this.prune();
    const job = this.jobs.get(ref);
    if (!job || job.ownerRef !== ownerRef) {
      throw new BetaError("MEETING_PREP_LOOKUP_UNAVAILABLE", "This temporary Gong call lookup is unavailable. Start a fresh lookup.");
    }
    if (job.status === "ready") return { status: "ready", call_lookup_ref: ref, kind: job.kind, ...job.result };
    if (job.status === "failed") return { status: "failed", call_lookup_ref: ref, kind: job.kind, ...job.error };
    return {
      status: "in_progress",
      call_lookup_ref: ref,
      kind: job.kind,
      stage: job.stage,
      stage_deadline_seconds: job.stageDeadlineSeconds,
      elapsed_seconds: Math.floor((this.now() - job.startedAt) / 1000),
      stage_elapsed_seconds: Math.floor((this.now() - job.stageStartedAt) / 1000),
      next_check_after_seconds: 20,
    };
  }
}

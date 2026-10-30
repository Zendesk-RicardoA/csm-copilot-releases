import crypto from "node:crypto";

import { BetaError } from "./core.mjs";

const COMPLETED_RESULT_TTL_MS = 10 * 60_000;
const ACTIVE_READ_TTL_MS = 20 * 60_000;

/** Transient in-process reads let the CSM receive progress while Snowflake works. */
export class BookOfBusinessReadJobs {
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
    if (!ownerRef || typeof read !== "function" || !["summary", "accounts"].includes(kind)) {
      throw new BetaError("BOOK_OF_BUSINESS_READ_INVALID", "A scoped book-of-business read is required.");
    }
    for (const job of this.jobs.values()) {
      if (job.ownerRef === ownerRef && job.status === "in_progress") {
        throw new BetaError("BOOK_OF_BUSINESS_READ_IN_PROGRESS", "A book-of-business read is already running. Continue that read before starting another.", { book_read_ref: job.ref });
      }
    }
    const startedAt = this.now();
    const ref = this.randomBytes(18).toString("base64url");
    const job = {
      ref, ownerRef, kind, status: "in_progress", startedAt,
      attempt: 1, attemptStartedAt: startedAt, attemptDeadlineSeconds: 120,
      expiresAt: startedAt + ACTIVE_READ_TTL_MS, result: null, error: null,
    };
    this.jobs.set(ref, job);
    this.scheduleExpiry(ACTIVE_READ_TTL_MS);
    void Promise.resolve()
      .then(() => read((event) => {
        if (job.status !== "in_progress") return;
        job.attempt = event.attempt;
        job.attemptStartedAt = this.now();
        job.attemptDeadlineSeconds = event.attempt_deadline_seconds;
      }))
      .then((result) => {
        job.status = "ready";
        job.result = result;
        job.expiresAt = this.now() + COMPLETED_RESULT_TTL_MS;
        this.scheduleExpiry(COMPLETED_RESULT_TTL_MS);
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error instanceof BetaError
          ? { code: error.code, message: error.message }
          : { code: "BOOK_OF_BUSINESS_READ_FAILED", message: "The book-of-business read failed before returning a result." };
        job.expiresAt = this.now() + COMPLETED_RESULT_TTL_MS;
        this.scheduleExpiry(COMPLETED_RESULT_TTL_MS);
      });
    return this.poll({ ref, ownerRef });
  }

  poll({ ref, ownerRef }) {
    this.prune();
    const job = this.jobs.get(ref);
    if (!job || job.ownerRef !== ownerRef) {
      throw new BetaError("BOOK_OF_BUSINESS_READ_UNAVAILABLE", "This temporary book-of-business read is unavailable. Start a fresh read.");
    }
    if (job.status === "ready") return { status: "ready", book_read_ref: ref, kind: job.kind, ...job.result };
    if (job.status === "failed") return { status: "failed", book_read_ref: ref, kind: job.kind, ...job.error };
    return {
      status: "in_progress",
      book_read_ref: ref,
      kind: job.kind,
      attempt: job.attempt,
      retry_used: job.attempt > 1,
      elapsed_seconds: Math.floor((this.now() - job.startedAt) / 1000),
      attempt_elapsed_seconds: Math.floor((this.now() - job.attemptStartedAt) / 1000),
      attempt_deadline_seconds: job.attemptDeadlineSeconds,
      next_check_after_seconds: 20,
    };
  }
}

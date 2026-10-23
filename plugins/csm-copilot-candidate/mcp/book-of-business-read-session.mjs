import { spawn } from "node:child_process";

import { createTemporarySnowflakeConfig } from "./credential-bridges.mjs";
import { BetaError } from "./core.mjs";

// Book queries compile substantially longer than the CTA queue. Give the
// first read two minutes, then retry a timed-out read once for at most five
// more minutes. Other source failures are never retried automatically.
export const BOOK_OF_BUSINESS_READ_TIMEOUT_MS = 120_000;
export const BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS = 300_000;

export async function runBookOfBusinessStatement({ session, sql, onProgress = () => {} }) {
  const deadlines = [BOOK_OF_BUSINESS_READ_TIMEOUT_MS, BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS];
  const attemptDurationsMs = [];
  for (let index = 0; index < deadlines.length; index += 1) {
    const attempt = index + 1;
    const timeoutMs = deadlines[index];
    const startedAt = Date.now();
    try { onProgress({ phase: "reading", attempt, attempt_deadline_seconds: timeoutMs / 1000, started_at_ms: startedAt }); } catch (_error) { /* progress never changes a read */ }
    try {
      const rows = await session.query(sql, { timeoutMs });
      attemptDurationsMs.push(Date.now() - startedAt);
      return { rows, attempt_count: attempt, retry_used: attempt > 1, attempt_durations_ms: attemptDurationsMs };
    } catch (error) {
      attemptDurationsMs.push(Date.now() - startedAt);
      if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT" && index === 0) continue;
      throw error;
    }
  }
  throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Both bounded book-of-business read attempts timed out.");
}

function snowflakeRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (_error) {
    throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "The approved Snowflake source returned an unreadable book-of-business response.");
  }
  if (!Array.isArray(parsed)) {
    throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "The approved Snowflake source returned an invalid book-of-business response.");
  }
  return parsed;
}

function isCliLogHandlerFailure(stdout, stderr) {
  return `${stdout}\n${stderr}`.includes("Unable to configure handler 'file'");
}

/**
 * Executes exactly one already-fixed book-of-business statement through the
 * same Snowflake CLI connection verified during setup. The persistent Python
 * connector is deliberately not used here: it has a different auth/session
 * path from the verified CLI and has produced false 25-second timeouts even
 * when the identical statement finishes quickly through the approved CLI.
 * The command uses the user's existing, already-authenticated connection
 * configuration with a per-process no-file-log override; it never copies,
 * modifies, or stores that configuration.
 */
export class BookOfBusinessReadSession {
  constructor({
    connectionName = "zdp-global",
    spawnCommand = spawn,
    configFactory = createTemporarySnowflakeConfig,
  } = {}) {
    this.connectionName = connectionName;
    this.spawnCommand = spawnCommand;
    this.configFactory = configFactory;
    this.closed = false;
    this.activeChild = null;
  }

  async query(sql, { timeoutMs = BOOK_OF_BUSINESS_READ_TIMEOUT_MS } = {}) {
    if (this.closed) throw new BetaError("SNOWFLAKE_SESSION_CLOSED", "The temporary book-of-business session is no longer available.");
    if (typeof sql !== "string" || !sql.trim()) throw new BetaError("SNOWFLAKE_QUERY_INVALID", "A fixed Snowflake statement is required for book-of-business analysis.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new BetaError("SNOWFLAKE_TIMEOUT_INVALID", "A positive source time limit is required.");

    const temporary = this.configFactory();
    let child;
    let timer;
    let completed = false;
    let stdout = "";
    let stderr = "";
    try {
      return await new Promise((resolve, reject) => {
        const finish = (callback) => {
          if (completed) return;
          completed = true;
          if (timer) clearTimeout(timer);
          if (this.activeChild === child) this.activeChild = null;
          callback();
        };
        try {
          child = this.spawnCommand(
            "snow",
            ["--config-file", temporary.configPath, "sql", "--connection", this.connectionName, "--query", sql, "--format", "json"],
            { env: temporary.env, stdio: ["ignore", "pipe", "pipe"] },
          );
          this.activeChild = child;
        } catch (_error) {
          finish(() => reject(new BetaError("SNOWFLAKE_SESSION_UNAVAILABLE", "The approved Snowflake source could not start this book-of-business read.")));
          return;
        }
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.once("error", () => {
          finish(() => reject(new BetaError("SNOWFLAKE_SESSION_UNAVAILABLE", "The approved Snowflake source could not continue this book-of-business read.")));
        });
        child.once("close", (exitCode, signal) => {
          finish(() => {
            if (exitCode !== 0) {
              if (isCliLogHandlerFailure(stdout, stderr)) {
                reject(new BetaError("SNOWFLAKE_CLI_LOGGING_UNAVAILABLE", "The local Snowflake CLI could not start this book-of-business read because its logging setup is unavailable."));
                return;
              }
              reject(new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "The approved Snowflake source could not complete this book-of-business read.", {
                exit_code: exitCode ?? null,
                signal: signal ?? null,
                source_error: stderr.trim() ? "reported" : "not_reported",
              }));
              return;
            }
            try {
              resolve(snowflakeRows(stdout));
            } catch (error) {
              reject(error);
            }
          });
        });
        timer = setTimeout(() => {
          finish(() => {
            try { child.kill(); } catch (_error) { /* the process already ended */ }
            reject(new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "The approved Snowflake source did not return within its book-of-business time limit.", {
              execution_timeout_ms: timeoutMs,
            }));
          });
        }, timeoutMs);
      });
    } finally {
      if (this.activeChild === child) this.activeChild = null;
      temporary.cleanup();
    }
  }

  close() {
    this.closed = true;
    if (this.activeChild) {
      try { this.activeChild.kill(); } catch (_error) { /* the process already ended */ }
      this.activeChild = null;
    }
  }
}

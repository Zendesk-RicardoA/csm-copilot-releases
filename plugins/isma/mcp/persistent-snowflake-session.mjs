import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { BetaError } from "./core.mjs";
import { createTemporarySnowflakeConfig } from "./credential-bridges.mjs";
import { safeSnowflakeReadDiagnostics } from "./source-read-diagnostics.mjs";
import {resolveSnowflakePython} from './snowflake-runtime.mjs';

/**
 * Owns one serial Snowflake statement queue for one controlled beta case.
 * A source deadline begins only after the worker has acquired the connection
 * and acknowledged that its cursor is about to execute. A real timeout kills
 * that worker before the following statement can start.
 */
export class PersistentSnowflakeSession {
  constructor({
    connectionName = "zdp-global",
    workerPath,
    spawnWorker = spawn,
    configFactory = createTemporarySnowflakeConfig,
    pythonPath = resolveSnowflakePython,
    // Browser SSO is completed during setup, but opening the authenticated
    // connector can still take longer than fifteen seconds on a cold worker.
    // This is a connection-start safeguard only; each capability supplies its
    // own statement deadline when it calls query().
    workerStartTimeoutMs = 25_000,
  } = {}) {
    this.connectionName = connectionName;
    this.workerPath = workerPath || path.join(path.dirname(fileURLToPath(import.meta.url)), "snowflake-session-worker.py");
    this.spawnWorker = spawnWorker;
    this.configFactory = configFactory;
    this.pythonPath = pythonPath;
    this.temporary = null;
    this.child = null;
    this.queue = [];
    this.active = null;
    this.nextRequestId = 1;
    this.closed = false;
    this.workerStartTimeoutMs = workerStartTimeoutMs;
  }

  start() {
    if (this.closed) throw new BetaError("SNOWFLAKE_SESSION_CLOSED", "The temporary Snowflake session is no longer available.");
    if (this.child) return;
    this.temporary = this.configFactory();
    const env = { ...this.temporary.env, CSM_COPILOT_SNOWFLAKE_CONFIG: this.temporary.configPath };
    try {
      const child = this.spawnWorker(this.pythonPath(), [this.workerPath], { env, stdio: ["pipe", "pipe", "ignore"] });
      this.child = child;
      child.once("error", (error) => this.#workerEnded(child, { worker_error_code: ["ENOENT", "EACCES", "EPERM", "ENOMEM"].includes(error?.code) ? error.code : "WORKER_START_FAILED" }));
      child.once("exit", (exitCode, signal) => this.#workerEnded(child, { worker_exit_code: Number.isInteger(exitCode) ? exitCode : null, worker_signal: ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(signal) ? signal : null }));
      readline.createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(child, line));
    } catch (error) {
      this.#disposeWorker();
      if (error instanceof BetaError) throw error;
      throw new BetaError("SNOWFLAKE_SESSION_UNAVAILABLE", "The temporary Snowflake session could not be started.", {
        statement_started: false, failure_stage: "worker_bootstrap",
        worker_error_code: ["ENOENT", "EACCES", "EPERM", "ENOMEM"].includes(error?.code) ? error.code : "WORKER_START_FAILED",
      });
    }
  }

  async query(sql, { timeoutMs, onStarted = null, onDiagnostics = null, deadlineAtMs = null } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new BetaError("SNOWFLAKE_TIMEOUT_INVALID", "A positive source time limit is required.");
    }
    this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: String(this.nextRequestId++), sql, timeoutMs, onStarted, onDiagnostics, deadlineAtMs, resolve, reject,
        enqueuedAt: Date.now(), startedAt: null, timer: null, startTimer: null,
        phase: "connection_start", timings: {},
      });
      this.#dispatchNext();
    });
  }

  #dispatchNext() {
    if (this.closed || this.active || this.queue.length === 0) return;
    try { this.start(); } catch (error) {
      this.#rejectQueue(error);
      return;
    }
    const request = this.queue.shift();
    this.active = request;
    try {
      // Browser SSO must be completed during setup, not while a case is
      // running. This distinct timer prevents a stalled connector bootstrap
      // from bypassing the execution timer, which intentionally begins only
      // after the worker confirms the statement has started.
      const remaining = request.deadlineAtMs == null ? Infinity : request.deadlineAtMs - Date.now();
      if (remaining <= 0) { this.#timeoutWindow(request); return; }
      request.startTimer = setTimeout(() => remaining <= this.workerStartTimeoutMs
        ? this.#timeoutWindow(request) : this.#timeoutWorkerStart(request), Math.min(this.workerStartTimeoutMs, remaining));
      this.child.stdin.write(`${JSON.stringify({ id: request.id, action: "query", connection_name: this.connectionName, sql: request.sql })}\n`);
    } catch (_error) {
      if (request.startTimer) clearTimeout(request.startTimer);
      this.active = null;
      request.reject(new BetaError("SNOWFLAKE_SESSION_UNAVAILABLE", "The temporary Snowflake session could not continue.", {
        statement_started: false, failure_stage: "worker_protocol", worker_error_code: "WORKER_INPUT_FAILED",
      }));
      this.#restartWorker();
      this.#dispatchNext();
    }
  }

  #onLine(child, line) {
    if (child !== this.child) return;
    const invalidResponse = () => this.#workerEnded(child, {
      failure_stage: "worker_protocol", worker_error_code: "INVALID_WORKER_RESPONSE",
    });
    let message;
    try { message = JSON.parse(line); } catch (_error) { invalidResponse(); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { invalidResponse(); return; }
    if (child === this.child && message.event === "bootstrap_failed") {
      this.#workerEnded(child, { failure_stage: "worker_bootstrap", source_error_type: ["ModuleNotFoundError", "ImportError", "PermissionError", "OSError"].includes(message.error_type) ? message.error_type : "BootstrapError" });
      return;
    }
    if (child !== this.child || !this.active || String(message.id) !== this.active.id) return;
    const request = this.active;
    if (message.event === "started") {
      if (request.startedAt != null) return;
      if (request.startTimer) clearTimeout(request.startTimer);
      request.startedAt = Date.now();
      request.phase = "statement_execution";
      this.#observeTimings(request, message.timings);
      try { request.onStarted?.({ started_at: new Date(request.startedAt).toISOString(), queue_wait_ms: request.startedAt - request.enqueuedAt }); } catch (_error) { /* observers never affect a read */ }
      const remaining = request.deadlineAtMs == null ? Infinity : request.deadlineAtMs - Date.now();
      request.timer = setTimeout(() => remaining <= request.timeoutMs
        ? this.#timeoutWindow(request) : this.#timeoutActive(request), Math.max(1, Math.min(request.timeoutMs, remaining)));
      return;
    }
    if (message.event === "phase") {
      if (["statement_execution", "fetch_results", "serialization"].includes(message.phase)) request.phase = message.phase;
      this.#observeTimings(request, message.timings);
      return;
    }
    if ((message.ok !== true && message.ok !== false) || (message.ok === true && !Array.isArray(message.rows))) {
      invalidResponse(); return;
    }
    if (request.timer) clearTimeout(request.timer);
    if (request.startTimer) clearTimeout(request.startTimer);
    this.active = null;
    this.#observeTimings(request, message.timings);
    const failureStage = ["connection_start", "authentication", "statement_execution", "fetch_results", "serialization"].includes(message.failure_stage)
      ? message.failure_stage : request.phase;
    try { request.onDiagnostics?.({ ...request.timings, statement_started: request.startedAt != null,
      ...(message.ok ? {} : { failure_stage: failureStage }) }); } catch { /* diagnostic observers cannot change results */ }
    if (message.ok) request.resolve(message.rows);
    else request.reject(new BetaError(message.code === "SIGN_IN_REQUIRED" ? "SNOWFLAKE_SIGN_IN_REQUIRED" : "SNOWFLAKE_SESSION_QUERY_FAILED",
      message.code === "SIGN_IN_REQUIRED" ? "Complete Snowflake/ZDP sign-in during setup, then retry this read."
        : "The approved Snowflake source could not complete this read.", {
      ...safeSnowflakeReadDiagnostics({ details: { source_error_type: message.error_type,
        source_error_number: message.error_number, source_sqlstate: message.sqlstate, failure_stage: failureStage } }),
      statement_started: request.startedAt != null,
      failure_stage: failureStage,
      ...request.timings,
    }));
    this.#dispatchNext();
  }

  #timeoutActive(request) {
    if (this.active !== request) return;
    this.active = null;
    request.reject(new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "The approved Snowflake source did not return within its execution time limit.", {
      statement_started: true,
      execution_timeout_ms: request.timeoutMs,
      execution_duration_ms: Date.now() - request.startedAt,
      failure_stage: request.phase,
      ...request.timings,
    }));
    // The connector cannot safely cancel a statement from this same blocked
    // connection. Terminate the worker so no later source waits behind it.
    this.#restartWorker();
    this.#dispatchNext();
  }

  #observeTimings(request, timings) {
    for (const key of ["connection_start_ms", "statement_execution_ms", "fetch_results_ms", "serialization_ms"]) {
      if (Number.isFinite(timings?.[key]) && timings[key] >= 0) request.timings[key] = Math.round(timings[key]);
    }
  }

  #timeoutWindow(request) {
    if (this.active !== request) return;
    if (request.timer) clearTimeout(request.timer);
    if (request.startTimer) clearTimeout(request.startTimer);
    this.active = null;
    request.reject(new BetaError("SNOWFLAKE_SESSION_WINDOW_TIMEOUT", "This account-evidence read reached its bounded work window.", {
      statement_started: request.startedAt != null, failure_stage: request.phase,
      window_exhausted: true, ...request.timings,
    }));
    this.#restartWorker();
    this.#dispatchNext();
  }

  #timeoutWorkerStart(request) {
    if (this.active !== request || request.startedAt != null) return;
    this.active = null;
    request.reject(new BetaError(
      "SNOWFLAKE_SESSION_START_TIMEOUT",
      "The approved Snowflake session did not start the read. Complete browser sign-in, then retry.",
      { statement_started: false, failure_stage: "connection_start", worker_start_timeout_ms: this.workerStartTimeoutMs },
    ));
    // A connection bootstrap may be waiting for an expired browser session.
    // Kill it before dispatching any later work so no request can remain
    // behind an unstarted worker.
    this.#restartWorker();
    this.#dispatchNext();
  }

  #workerEnded(child, diagnostics = {}) {
    if (child !== this.child) return;
    const active = this.active;
    this.active = null;
    this.#disposeWorker();
    if (active) {
      if (active.timer) clearTimeout(active.timer);
      if (active.startTimer) clearTimeout(active.startTimer);
      active.reject(new BetaError("SNOWFLAKE_SESSION_UNAVAILABLE", "The temporary Snowflake session ended before the read completed.", {
        failure_stage: active.phase,
        statement_started: active.startedAt != null,
        ...active.timings,
        elapsed_ms: Date.now() - active.enqueuedAt,
        ...diagnostics,
      }));
    }
    if (!this.closed) this.#dispatchNext();
  }

  #restartWorker() { this.#disposeWorker(); }

  #disposeWorker() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch (_error) { /* already closed */ }
      try { child.kill(); } catch (_error) { /* already closed */ }
    }
    if (this.temporary) this.temporary.cleanup();
    this.temporary = null;
  }

  #rejectQueue(error) {
    for (const request of this.queue.splice(0)) request.reject(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.active) {
      if (this.active.timer) clearTimeout(this.active.timer);
      if (this.active.startTimer) clearTimeout(this.active.startTimer);
      this.active.reject(new BetaError("SNOWFLAKE_SESSION_CLOSED", "The temporary Snowflake session is no longer available."));
      this.active = null;
    }
    this.#rejectQueue(new BetaError("SNOWFLAKE_SESSION_CLOSED", "The temporary Snowflake session is no longer available."));
    this.#disposeWorker();
  }
}

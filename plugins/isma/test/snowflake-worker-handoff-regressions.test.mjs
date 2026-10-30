import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BetaError } from "../mcp/core.mjs";
import { PersistentSnowflakeSession } from "../mcp/persistent-snowflake-session.mjs";
import { readOwnedCtaQueueWithSession } from "../mcp/journey-a-cta-queue.mjs";

function sessionReturning(writeResponse) {
  return new PersistentSnowflakeSession({
    pythonPath: () => "invented-python",
    configFactory: () => ({ configPath: "/private/tmp/invented.toml", env: {}, cleanup() {} }),
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(String(chunk));
        queueMicrotask(() => writeResponse(child, request));
        callback();
      } });
      child.kill = () => true;
      return child;
    },
  });
}

test("the actual Python worker isolates SDK output and never prompts during a governed read", () => {
  // This test imports only a fake connector, with no connection settings or live Python SDK.
  const result = spawnSync(process.env.CSM_COPILOT_TEST_PYTHON || "python3", ["-B",
    fileURLToPath(new URL("./fixtures/snowflake-worker-protocol-test.py", import.meta.url)),
    fileURLToPath(new URL("../mcp/snowflake-session-worker.py", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 4 tests/);
});

test("a malformed worker response reports protocol failure without retaining its contents", async (t) => {
  const session = sessionReturning(child => child.stdout.write("invented-auth-notice secret-token=never-retain\n"));
  t.after(() => session.close());
  await assert.rejects(session.query("invented private SQL", { timeoutMs: 100 }), error => {
    assert.equal(error.code, "SNOWFLAKE_SESSION_UNAVAILABLE");
    assert.equal(error.details.failure_stage, "worker_protocol");
    assert.equal(error.details.worker_error_code, "INVALID_WORKER_RESPONSE");
    assert.equal(error.details.statement_started, false);
    assert.doesNotMatch(JSON.stringify(error), /invented-auth-notice|secret-token|private SQL/);
    return true;
  });
});

test("a sign-in-required worker result stops before execution and is not a query timeout", async (t) => {
  const session = sessionReturning((child, { id }) => child.stdout.write(JSON.stringify({ id, ok: false,
    code: "SIGN_IN_REQUIRED", error_type: "SnowflakeSignInRequired", failure_stage: "authentication",
    message: "invented-secret-sign-in-url", sqlstate: "not-safe", error_number: "invented-account" }) + "\n"));
  t.after(() => session.close());
  await assert.rejects(session.query("invented SQL", { timeoutMs: 100 }), error => {
    assert.equal(error.code, "SNOWFLAKE_SIGN_IN_REQUIRED");
    assert.equal(error.details.failure_stage, "authentication");
    assert.equal(error.details.statement_started, false);
    assert.equal(error.details.source_error_number, null);
    assert.equal(error.details.source_sqlstate, null);
    assert.doesNotMatch(JSON.stringify(error), /invented-secret|invented-account|not-safe/);
    return true;
  });
});

test("CTA failures preserve safe root stages and never retry or broaden the 25-second read", async () => {
  const scenarios = [
    ["SNOWFLAKE_SESSION_UNAVAILABLE", "worker_protocol", "CTA_QUEUE_READ_FAILED"],
    ["SNOWFLAKE_SIGN_IN_REQUIRED", "authentication", "SNOWFLAKE_SIGN_IN_REQUIRED"],
    ["SNOWFLAKE_SESSION_TIMEOUT", "statement_execution", "CTA_QUEUE_READ_TIMEOUT"],
  ];
  for (const [code, stage, publicCode] of scenarios) {
    let attempts = 0;
    const session = { async query(_sql, options) {
      attempts++;
      assert.equal(options.timeoutMs, 25_000);
      throw new BetaError(code, "invented sensitive message", { failure_stage: stage,
        statement_started: stage === "statement_execution", worker_error_code: "INVALID_WORKER_RESPONSE",
        worker_exit_code: 2, connection_start_ms: 22, source_error_type: "ProgrammingError",
        source_error_number: 1003, source_sqlstate: "42000", sql: "invented-private-SQL",
        raw_response: "invented-private-response" });
    } };
    await assert.rejects(readOwnedCtaQueueWithSession({ session }), error => {
      assert.equal(error.code, publicCode);
      assert.equal(error.details.failure_stage, stage);
      assert.equal(error.details.source_read_code, code);
      assert.equal(error.details.worker_exit_code, 2);
      assert.equal(error.details.connection_start_ms, 22);
      assert.equal(error.details.source_error_number, 1003);
      assert.doesNotMatch(JSON.stringify(error), /invented-private|sensitive message/);
      return true;
    });
    assert.equal(attempts, 1);
  }
});

test("untrusted diagnostic fields cannot be copied into a CTA error", async () => {
  const session = { async query() { throw new BetaError("invented-customer-code", "private", {
    failure_stage: "invented-account-stage", source_error_type: "invented-email-type",
    source_error_number: "invented-id", source_sqlstate: "invented-token",
    worker_error_code: "invented-secret", worker_exit_code: "invented-id", connection_start_ms: -3,
  }); } };
  await assert.rejects(readOwnedCtaQueueWithSession({ session }), error => {
    assert.equal(error.code, "CTA_QUEUE_READ_FAILED");
    assert.doesNotMatch(JSON.stringify(error.details), /invented-/);
    return true;
  });
});

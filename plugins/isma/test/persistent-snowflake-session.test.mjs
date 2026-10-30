import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { PersistentSnowflakeSession } from "../mcp/persistent-snowflake-session.mjs";

function fakeWorkerFactory() {
  let launches = 0;
  const workers = [];
  const spawnWorker = () => {
    launches += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(String(chunk));
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, event: "started" })}\n`));
        if (launches > 1) {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ok: true, rows: [{ value: "second worker" }] })}\n`));
        }
        callback();
      },
    });
    child.kill = () => { child.emit("exit", 1); return true; };
    workers.push(child);
    return child;
  };
  return { spawnWorker, workers, launchCount: () => launches };
}

test("the managed worker gets the beta's full 25-second startup allowance", () => {
  const session = new PersistentSnowflakeSession({
    spawnWorker: () => { throw new Error("not started by this configuration test"); },
    pythonPath: () => "python",
    configFactory: () => ({ configPath: "/private/tmp/test.toml", env: {}, cleanup() {} }),
  });
  assert.equal(session.workerStartTimeoutMs, 25_000);
  session.close();
});

test("a real execution timeout replaces the worker before the next queued statement starts", async () => {
  const fake = fakeWorkerFactory();
  const starts = [];
  const session = new PersistentSnowflakeSession({
    spawnWorker: fake.spawnWorker,
    pythonPath: () => "python",
    configFactory: () => ({ configPath: "/private/tmp/test.toml", env: {}, cleanup() {} }),
  });
  const timedOut = session.query("first", { timeoutMs: 10, onStarted: (event) => starts.push(event) });
  const next = session.query("second", { timeoutMs: 50, onStarted: (event) => starts.push(event) });
  await assert.rejects(timedOut, (error) => error.code === "SNOWFLAKE_SESSION_TIMEOUT" && error.details?.statement_started === true);
  assert.deepEqual(await next, [{ value: "second worker" }]);
  assert.equal(fake.launchCount(), 2);
  assert.equal(starts.length, 2);
  session.close();
});

test("a stalled worker bootstrap fails separately before an execution timer can start", async () => {
  const spawnWorker = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.kill = () => { child.emit("exit", 1); return true; };
    return child;
  };
  const session = new PersistentSnowflakeSession({
    spawnWorker,
    pythonPath: () => "python",
    configFactory: () => ({ configPath: "/private/tmp/test.toml", env: {}, cleanup() {} }),
    workerStartTimeoutMs: 10,
  });
  await assert.rejects(
    session.query("select 1", { timeoutMs: 50 }),
    (error) => error.code === "SNOWFLAKE_SESSION_START_TIMEOUT" && error.details?.statement_started === false,
  );
  session.close();
});

test("worker bootstrap failure reports its safe stage, never raw exception details", async () => {
  const session = new PersistentSnowflakeSession({
    pythonPath: () => "python", configFactory: () => ({ configPath: "/private/tmp/invented.toml", env: {}, cleanup() {} }),
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, callback) {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ event: "bootstrap_failed", error_type: "ModuleNotFoundError", message: "invented-sensitive-value" })}\n`));
        callback();
      } });
      child.kill = () => true;
      return child;
    },
  });
  await assert.rejects(session.query("invented-query-text", { timeoutMs: 100 }), (error) => {
    assert.equal(error.code, "SNOWFLAKE_SESSION_UNAVAILABLE");
    assert.equal(error.details.statement_started, false);
    assert.equal(error.details.failure_stage, "worker_bootstrap");
    assert.equal(error.details.source_error_type, "ModuleNotFoundError");
    assert.doesNotMatch(JSON.stringify(error.details), /invented-sensitive-value|invented-query-text/);
    return true;
  });
  session.close();
});

test("a stalled result fetch is distinguished from slow statement execution without raw diagnostics", async () => {
  const session = new PersistentSnowflakeSession({
    pythonPath: () => "python", configFactory: () => ({ configPath: "/private/tmp/invented.toml", env: {}, cleanup() {} }),
    spawnWorker: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const { id } = JSON.parse(String(chunk));
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ id, event: "started" })}\n`);
          child.stdout.write(`${JSON.stringify({ id, event: "phase", phase: "fetch_results", timings: { statement_execution_ms: 2, query_id: "invented-private-id" } })}\n`);
        }); callback();
      } }); child.kill = () => true; return child;
    },
  });
  await assert.rejects(session.query("invented query", { timeoutMs: 10 }), (error) => {
    assert.equal(error.details.failure_stage, "fetch_results");
    assert.equal(error.details.statement_execution_ms, 2);
    assert.doesNotMatch(JSON.stringify(error.details), /invented-private-id|invented query/); return true;
  }); session.close();
});

test("an evidence window includes cold-worker setup, unlike a statement deadline", async () => {
  const session = new PersistentSnowflakeSession({ pythonPath: () => "python", workerStartTimeoutMs: 100,
    configFactory: () => ({ configPath: "/private/tmp/invented.toml", env: {}, cleanup() {} }),
    spawnWorker: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      child.kill = () => true; return child;
    },
  });
  await assert.rejects(session.query("invented query", { timeoutMs: 100, deadlineAtMs: Date.now() + 10 }), (error) => {
    assert.equal(error.code, "SNOWFLAKE_SESSION_WINDOW_TIMEOUT");
    assert.equal(error.details.statement_started, false);
    assert.equal(error.details.failure_stage, "connection_start"); return true;
  }); session.close();
});

test("successful execution and fetch diagnostics retain only safe numeric timings", async () => {
  const observations = [];
  const session = new PersistentSnowflakeSession({
    pythonPath: () => "python", configFactory: () => ({ configPath: "/private/tmp/invented.toml", env: {}, cleanup() {} }),
    spawnWorker: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const { id } = JSON.parse(String(chunk));
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ id, event: "started" })}\n`);
          child.stdout.write(`${JSON.stringify({ id, event: "phase", phase: "fetch_results", timings: { statement_execution_ms: 2, query_id: "invented-private-id" } })}\n`);
          child.stdout.write(`${JSON.stringify({ id, event: "phase", phase: "serialization", timings: { fetch_results_ms: 3, sql: "invented-private-query", serialization_ms: -1 } })}\n`);
          child.stdout.write(`${JSON.stringify({ id, ok: true, rows: [{ value: 0 }], timings: { serialization_ms: 1, access_token: "invented-secret" } })}\n`);
        }); callback();
      } }); child.kill = () => true; return child;
    },
  });
  assert.deepEqual(await session.query("invented query", { timeoutMs: 100, onDiagnostics: (event) => observations.push(event) }), [{ value: 0 }]);
  assert.deepEqual(observations, [{ statement_execution_ms: 2, fetch_results_ms: 3, serialization_ms: 1, statement_started: true }]);
  assert.doesNotMatch(JSON.stringify(observations), /invented-private|invented-secret/);
  session.close();
});

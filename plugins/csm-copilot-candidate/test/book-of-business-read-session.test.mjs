import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BetaError } from "../mcp/core.mjs";
import {
  BOOK_OF_BUSINESS_READ_TIMEOUT_MS,
  BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS,
  BookOfBusinessReadSession,
  runBookOfBusinessStatement,
} from "../mcp/book-of-business-read-session.mjs";

function fakeChild({ stdout = "", stderr = "", exitCode = 0, neverCompletes = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close", null, "SIGTERM");
    return true;
  };
  if (!neverCompletes) {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode, null);
    });
  }
  return child;
}

test("book analysis uses the setup-verified CLI connection and cleans its temporary configuration", async () => {
  const seen = [];
  let cleaned = false;
  const session = new BookOfBusinessReadSession({
    connectionName: "zdp-global",
    configFactory: () => ({ configPath: "/private/tmp/test-book-config.toml", env: { TEST: "1" }, cleanup: () => { cleaned = true; } }),
    spawnCommand: (command, args, options) => {
      seen.push({ command, args, options });
      return fakeChild({ stdout: '[{"ROW_TYPE":"summary"}]' });
    },
  });

  const rows = await session.query("SELECT fixed_book_query", { timeoutMs: BOOK_OF_BUSINESS_READ_TIMEOUT_MS });

  assert.deepEqual(rows, [{ ROW_TYPE: "summary" }]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, "snow");
  assert.deepEqual(seen[0].args.slice(0, 6), ["--config-file", "/private/tmp/test-book-config.toml", "sql", "--connection", "zdp-global", "--query"]);
  assert.equal(seen[0].args.at(-1), "json");
  assert.equal(cleaned, true);
});

test("book analysis stops a non-returning CLI read at its capability-specific deadline", async () => {
  const child = fakeChild({ neverCompletes: true });
  const session = new BookOfBusinessReadSession({
    configFactory: () => ({ configPath: "/private/tmp/test-book-config.toml", env: {}, cleanup() {} }),
    spawnCommand: () => child,
  });

  await assert.rejects(
    session.query("SELECT fixed_book_query", { timeoutMs: 1 }),
    { code: "SNOWFLAKE_SESSION_TIMEOUT" },
  );
  assert.equal(child.killed, true);
});

test("book analysis reports a local CLI logging failure without calling it a source timeout", async () => {
  const session = new BookOfBusinessReadSession({
    configFactory: () => ({ configPath: "/private/tmp/test-book-config.toml", env: {}, cleanup() {} }),
    spawnCommand: () => fakeChild({
      stdout: "Unable to configure handler 'file'",
      exitCode: 1,
    }),
  });

  await assert.rejects(
    session.query("SELECT fixed_book_query"),
    { code: "SNOWFLAKE_CLI_LOGGING_UNAVAILABLE" },
  );
});

test("a timed-out book read retries once with a five-minute cap", async () => {
  const seen = [];
  const events = [];
  const session = {
    async query(_sql, { timeoutMs }) {
      seen.push(timeoutMs);
      if (seen.length === 1) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented timeout");
      return [{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }];
    },
  };
  const result = await runBookOfBusinessStatement({ session, sql: "SELECT fixed_book_query", onProgress: (event) => events.push(event) });
  assert.deepEqual(seen, [120_000, 300_000]);
  assert.equal(BOOK_OF_BUSINESS_READ_TIMEOUT_MS, 120_000);
  assert.equal(BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS, 300_000);
  assert.equal(result.attempt_count, 2);
  assert.equal(result.retry_used, true);
  assert.deepEqual(events.map((event) => event.attempt), [1, 2]);
});

test("the book reader never retries a non-timeout source failure or a second timeout", async () => {
  let attempts = 0;
  const failed = { async query() { attempts += 1; throw new BetaError("SNOWFLAKE_SESSION_QUERY_FAILED", "Invented source failure"); } };
  await assert.rejects(runBookOfBusinessStatement({ session: failed, sql: "SELECT fixed_book_query" }), { code: "SNOWFLAKE_SESSION_QUERY_FAILED" });
  assert.equal(attempts, 1);

  attempts = 0;
  const timedOut = { async query() { attempts += 1; throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "Invented timeout"); } };
  await assert.rejects(runBookOfBusinessStatement({ session: timedOut, sql: "SELECT fixed_book_query" }), { code: "SNOWFLAKE_SESSION_TIMEOUT" });
  assert.equal(attempts, 2);
});

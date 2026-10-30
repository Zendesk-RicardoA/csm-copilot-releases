import assert from "node:assert/strict";
import test from "node:test";

import { BookOfBusinessReadJobs } from "../mcp/book-of-business-read-jobs.mjs";

test("a book read returns immediately and exposes safe progress until its result is ready", async () => {
  let now = 1_000_000;
  let finish;
  let update;
  const jobs = new BookOfBusinessReadJobs({ now: () => now });
  const started = jobs.start({
    ownerRef: "invented-tester",
    kind: "accounts",
    read: (onProgress) => new Promise((resolve) => { update = onProgress; finish = resolve; }),
  });
  assert.equal(started.status, "in_progress");
  assert.equal(started.attempt_deadline_seconds, 120);
  assert.equal(Object.hasOwn(started, "accounts"), false);
  await Promise.resolve();

  now += 25_000;
  assert.deepEqual(
    { status: jobs.poll({ ref: started.book_read_ref, ownerRef: "invented-tester" }).status,
      elapsed: jobs.poll({ ref: started.book_read_ref, ownerRef: "invented-tester" }).elapsed_seconds },
    { status: "in_progress", elapsed: 25 },
  );
  update({ attempt: 2, attempt_deadline_seconds: 300 });
  const retry = jobs.poll({ ref: started.book_read_ref, ownerRef: "invented-tester" });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.retry_used, true);
  assert.equal(retry.attempt_deadline_seconds, 300);

  finish({ accounts: [{ account_name: "Invented Account" }], attempt_count: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  const ready = jobs.poll({ ref: started.book_read_ref, ownerRef: "invented-tester" });
  assert.equal(ready.status, "ready");
  assert.equal(ready.accounts[0].account_name, "Invented Account");
  assert.equal(ready.attempt_count, 2);
  assert.throws(() => jobs.poll({ ref: started.book_read_ref, ownerRef: "different-tester" }), { code: "BOOK_OF_BUSINESS_READ_UNAVAILABLE" });
});

test("a book read permits only one active read per CSM and expires transient results", async () => {
  let now = 1_000_000;
  let finish;
  const jobs = new BookOfBusinessReadJobs({ now: () => now });
  const started = jobs.start({ ownerRef: "invented-tester", kind: "summary", read: () => new Promise((resolve) => { finish = resolve; }) });
  assert.throws(
    () => jobs.start({ ownerRef: "invented-tester", kind: "accounts", read: async () => ({}) }),
    { code: "BOOK_OF_BUSINESS_READ_IN_PROGRESS" },
  );
  await Promise.resolve();
  finish({ summary: { account_count: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.poll({ ref: started.book_read_ref, ownerRef: "invented-tester" }).status, "ready");
  now += 10 * 60_000 + 1;
  assert.throws(() => jobs.poll({ ref: started.book_read_ref, ownerRef: "invented-tester" }), { code: "BOOK_OF_BUSINESS_READ_UNAVAILABLE" });
});

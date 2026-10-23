import assert from "node:assert/strict";
import test from "node:test";

import { BetaError } from "../mcp/core.mjs";
import { MeetingPrepCallLookupJobs } from "../mcp/meeting-prep-call-lookup-jobs.mjs";

test("a Gong lookup starts immediately and exposes only stage progress until ready", async () => {
  let now = 1_000;
  let finish;
  const jobs = new MeetingPrepCallLookupJobs({ now: () => now, randomBytes: () => Buffer.alloc(18, 4) });
  const started = jobs.start({
    ownerRef: "tester-one",
    kind: "direct_link",
    read: (onProgress) => new Promise((resolve) => {
      onProgress({ stage: "account_scope", stage_deadline_seconds: 90 });
      finish = (result) => resolve(result);
    }),
  });
  assert.equal(started.status, "in_progress");
  assert.match(started.call_lookup_ref, /^[A-Za-z0-9_-]{24}$/);
  await Promise.resolve();
  now += 30_000;
  const progress = jobs.poll({ ref: started.call_lookup_ref, ownerRef: "tester-one" });
  assert.equal(progress.stage, "account_scope");
  assert.equal(progress.elapsed_seconds, 30);
  assert.equal(progress.stage_deadline_seconds, 90);
  assert.equal(JSON.stringify(progress).includes("account_id"), false);
  finish({ candidate_count: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.poll({ ref: started.call_lookup_ref, ownerRef: "tester-one" }).candidate_count, 1);
  assert.throws(() => jobs.poll({ ref: started.call_lookup_ref, ownerRef: "tester-two" }), { code: "MEETING_PREP_LOOKUP_UNAVAILABLE" });
  now += 10 * 60_000 + 1;
  assert.throws(() => jobs.poll({ ref: started.call_lookup_ref, ownerRef: "tester-one" }), { code: "MEETING_PREP_LOOKUP_UNAVAILABLE" });
});

test("one CSM cannot start a second lookup while one is running", async () => {
  const jobs = new MeetingPrepCallLookupJobs({ randomBytes: () => Buffer.alloc(18, 5) });
  const started = jobs.start({ ownerRef: "tester-one", kind: "date_range", read: () => new Promise(() => {}) });
  assert.throws(
    () => jobs.start({ ownerRef: "tester-one", kind: "direct_link", read: () => [] }),
    (error) => error.code === "MEETING_PREP_LOOKUP_IN_PROGRESS" && error.details.call_lookup_ref === started.call_lookup_ref,
  );
});

test("a running lookup replaces its public progress stage as the source advances", async () => {
  let update;
  const jobs = new MeetingPrepCallLookupJobs({ randomBytes: () => Buffer.alloc(18, 7) });
  const started = jobs.start({
    ownerRef: "tester-one",
    kind: "direct_link",
    read: (onProgress) => new Promise(() => { update = onProgress; }),
  });
  await Promise.resolve();
  update({ stage: "link_id_resolution", stage_deadline_seconds: 25 });
  const progress = jobs.poll({ ref: started.call_lookup_ref, ownerRef: "tester-one" });
  assert.equal(progress.stage, "link_id_resolution");
  assert.equal(progress.stage_deadline_seconds, 25);
  assert.equal(progress.next_check_after_seconds, 20);
});

test("a failed lookup exposes a safe source gap, not a call ID", async () => {
  const jobs = new MeetingPrepCallLookupJobs({ randomBytes: () => Buffer.alloc(18, 6) });
  const started = jobs.start({
    ownerRef: "tester-one",
    kind: "direct_link",
    read: async () => {
      throw new BetaError("MEETING_PREP_CALL_READ_TIMEOUT", "The account-linked Gong check timed out.", {
        stage: "direct_link_validation", deadline_seconds: 100,
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(jobs.poll({ ref: started.call_lookup_ref, ownerRef: "tester-one" }), {
    status: "failed", call_lookup_ref: started.call_lookup_ref, kind: "direct_link",
    code: "MEETING_PREP_CALL_READ_TIMEOUT", message: "The account-linked Gong check timed out.",
    failed_stage: "direct_link_validation", deadline_seconds: 100,
  });
});

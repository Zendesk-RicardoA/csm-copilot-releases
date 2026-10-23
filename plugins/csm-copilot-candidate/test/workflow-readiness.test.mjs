import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOW_STEPS,
  assessLoadedPackageVersion,
  recordWorkflowOutcome,
  summarizeWorkflowReadiness,
} from "../mcp/workflow-readiness.mjs";

const tools = Object.values(WORKFLOW_STEPS).flatMap((steps) => steps.flatMap((step) => step.tools));
const matched = { state: "matched" };

test("setup and exposed steps do not claim a source read has succeeded", () => {
  const state = summarizeWorkflowReadiness({ workflow: "daily_focus", availableTools: tools, setupStatus: "ready", packageStatus: matched });
  assert.equal(state.state, "available_unverified");
  assert.equal(state.steps[0].state, "available_unverified");
});

test("connected sources are not live-ready when package execution approval is missing", () => {
  const state = summarizeWorkflowReadiness({ workflow: "daily_focus", availableTools: tools, setupStatus: "ready", packageStatus: matched, executionApproval: "approval_required" });
  assert.equal(state.state, "approval_required");
  assert.equal(state.steps.find((step) => step.step === "work_signals").state, "available_unverified");
});

test("missing selected-transcript control blocks meeting prep", () => {
  const availableTools = tools.filter((name) => name !== "beta_bind_converge_call_evidence");
  const state = summarizeWorkflowReadiness({ workflow: "meeting_prep", availableTools, setupStatus: "ready", packageStatus: matched });
  assert.equal(state.state, "blocked");
  assert.equal(state.steps.find((step) => step.step === "selected_transcript").state, "missing");
});

test("local readiness names the Converge host dependency without claiming it authenticated", () => {
  const state = summarizeWorkflowReadiness({ workflow: "meeting_prep", availableTools: tools, setupStatus: "ready", packageStatus: matched });
  const step = state.steps.find((item) => item.step === "selected_transcript");
  assert.deepEqual(step.host_tools_required, ["Converge.get_customer_call"]);
  assert.equal(step.host_connection_state, "not_checked_by_local_control");
  assert.equal(state.state, "available_unverified");
});

test("missing cached-chart delivery is not reported as a fully available account-brief workflow", () => {
  const availableTools = tools.filter((name) => name !== "beta_get_account_brief_chart");
  for (const workflow of ["meeting_prep", "renewal_conversation_brief"]) {
    const state = summarizeWorkflowReadiness({ workflow, availableTools, setupStatus: "ready", packageStatus: matched });
    assert.equal(state.state, "blocked");
    assert.ok(state.steps.some((step) => step.missing_tools.includes("beta_get_account_brief_chart")));
  }
});

test("case-bound CTA failure degrades outreach, not the separate Daily Focus digest", () => {
  const observations = {};
  recordWorkflowOutcome(observations, { toolName: "beta_read_owned_cta_queue", errorCode: "CTA_QUEUE_READ_TIMEOUT", elapsedMs: 25_013, now: new Date("2026-09-24T10:00:00Z") });
  const outreach = summarizeWorkflowReadiness({ workflow: "outreach", availableTools: tools, setupStatus: "ready", packageStatus: matched, observations });
  assert.equal(outreach.state, "degraded");
  assert.equal(outreach.steps[0].last_error_code, "CTA_QUEUE_READ_TIMEOUT");
  const daily = summarizeWorkflowReadiness({ workflow: "daily_focus", availableTools: tools, setupStatus: "ready", packageStatus: matched, observations });
  assert.equal(daily.state, "available_unverified");
  assert.deepEqual(Object.keys(observations.cta_queue).sort(), ["checked_at", "elapsed_ms", "error_code", "state"]);
  recordWorkflowOutcome(observations, { toolName: "beta_read_owned_cta_queue", resultStatus: "ready", elapsedMs: 1200 });
  assert.equal(observations.cta_queue.state, "healthy");
});

test("case-free work-signal failure degrades Daily Focus without exposing source data", () => {
  const observations = {};
  recordWorkflowOutcome(observations, { toolName: "beta_read_daily_focus_work_signals", errorCode: "CTA_QUEUE_READ_TIMEOUT", elapsedMs: 25_001 });
  const daily = summarizeWorkflowReadiness({ workflow: "daily_focus", availableTools: tools, setupStatus: "ready", packageStatus: matched, observations });
  assert.equal(daily.state, "degraded");
  assert.equal(daily.steps.find((step) => step.step === "work_signals").last_error_code, "CTA_QUEUE_READ_TIMEOUT");
  assert.deepEqual(Object.keys(observations.work_signals).sort(), ["checked_at", "elapsed_ms", "error_code", "state"]);
});

test("invalid input is not misreported as a source outage", () => {
  const observations = {};
  recordWorkflowOutcome(observations, { toolName: "beta_read_owned_cta_queue", errorCode: "INVALID_CASE_KIND", elapsedMs: 1 });
  assert.deepEqual(observations, {});
});

test("a failed or partial full account brief is not described as meeting prep readiness", () => {
  const observations = {};
  recordWorkflowOutcome(observations, { toolName: "beta_continue_meeting_prep_account_brief", errorCode: "SNOWFLAKE_SESSION_UNAVAILABLE", elapsedMs: 20 });
  assert.equal(summarizeWorkflowReadiness({ workflow: "meeting_prep", availableTools: tools, setupStatus: "ready", packageStatus: matched, observations }).state, "degraded");
  recordWorkflowOutcome(observations, { toolName: "beta_continue_meeting_prep_account_brief", resultStatus: "partial", elapsedMs: 30 });
  assert.equal(observations.account_brief.error_code, "ACCOUNT_BRIEF_SOURCE_GAP");
  recordWorkflowOutcome(observations, { toolName: "beta_continue_meeting_prep_account_brief", resultStatus: "ready", elapsedMs: 30 });
  assert.equal(observations.account_brief.state, "healthy");
});

test("loaded package mismatch requests a fresh process, not a false ready state", () => {
  const packageStatus = assessLoadedPackageVersion({ loadedVersion: "invented-1", diskVersion: "invented-2", approvedVersion: "invented-2" });
  assert.equal(packageStatus.state, "fresh_session_required");
  const state = summarizeWorkflowReadiness({ workflow: "meeting_prep", availableTools: tools, setupStatus: "ready", packageStatus });
  assert.equal(state.state, "fresh_session_required");
  assert.equal(assessLoadedPackageVersion({ loadedVersion: "invented-1", diskVersion: "invented-1", approvedVersion: "invented-2" }).state, "approved_version_mismatch");
});

test("completed source reads with blank optional fields are not misreported as an account-source failure", () => {
  const observations = {};
  recordWorkflowOutcome(observations, { toolName: "beta_continue_meeting_prep_account_brief", resultStatus: "partial", sourceReadState: "completed", elapsedMs: 30 });
  assert.equal(observations.account_brief.state, "healthy");
  assert.equal(observations.account_brief.error_code, null);
  assert.equal(summarizeWorkflowReadiness({ workflow: "meeting_prep", availableTools: tools, setupStatus: "ready", packageStatus: matched, observations }).state, "available_unverified");
  recordWorkflowOutcome(observations, { toolName: "beta_continue_meeting_prep_account_brief", resultStatus: "partial", sourceReadState: "partially_completed", elapsedMs: 50 });
  assert.equal(observations.account_brief.state, "failed");
});

test("process restart clears in-memory source observations", () => {
  const oldProcess = {};
  recordWorkflowOutcome(oldProcess, { toolName: "beta_read_owned_cta_queue", resultStatus: "ready", elapsedMs: 200 });
  const freshProcess = {};
  assert.equal(summarizeWorkflowReadiness({ workflow: "daily_focus", availableTools: tools, setupStatus: "ready", packageStatus: matched, observations: freshProcess }).state, "available_unverified");
  assert.equal(oldProcess.cta_queue.state, "healthy");
});

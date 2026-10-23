import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function start(t, mode = "recovered") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-monthly-recovery-invented-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json")));
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true,
    production_system_writes: false, generated_artifacts: true };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-metric-tester" },
    snowflake: { state: "connected", read_only_verified: true }, organizational_controls: { company_identity: true,
      read_only_zdp: true, transcript_secondary_processing: true, private_draft_google_scope: true,
      approved_renderer_execution: true, retention_policy: true, operational_support: true } }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/outreach-monthly-recovery-loader.mjs", import.meta.url).href,
    path.join(root, "mcp/server.mjs")], { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env,
      PLUGIN_DATA: path.join(dir, "state"), CSM_COPILOT_BETA_STATE_NAMESPACE: `csm-monthly-recovery-${randomBytes(6).toString("hex")}`,
      CSM_COPILOT_BETA_MANIFEST_PATH: path.join(dir, "manifest.json"), CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(dir, "runtime.json"),
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true", CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
      CSM_MONTHLY_RECOVERY_MODE: mode } });
  let id = 0; const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => { let response;
    try { response = JSON.parse(line); } catch { return; } const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter(response); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Invented protocol timeout.")); }, 5000);
    pending.set(requestId, r => { clearTimeout(timer); resolve(r); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); });
  t.after(() => { child.stdin.end(); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, rpc, call: async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(r.result?.content?.[0]?.text, JSON.stringify(r)); return { ...JSON.parse(r.result.content[0].text), isError: r.result.isError === true }; } };
}
async function begin(s) {
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await s.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await s.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const contacts = await s.call("beta_run_journey_a_contact_evidence", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  const args = { case_id: created.case_id, contact_evidence_run_id: contacts.contact_evidence_run_id };
  const first = await s.call("beta_continue_journey_a_contact_evidence", args);
  assert.equal(first.source_states.rba_monthly_metrics, "timed_out");
  assert.equal(first.source_states.guide_knowledge_views, "checked");
  return { created, contacts, first, args };
}
async function waitFor(s, args, predicate) {
  for (let i = 0; i < 50; i++) {
    const r = await s.call("beta_continue_journey_a_contact_evidence", args);
    if (predicate(r)) return r;
    if (!/pending$/.test(r.status)) assert.fail("The native workflow finished without the required recovery result.");
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail("The invented native workflow did not finish its bounded recovery.");
}

test("native metric timeout recovery reports attempt two, preserves contacts, and cannot be completed or drafted early", { timeout: 10000 }, async t => {
  const s = start(t), run = await begin(s);
  const recovering = await waitFor(s, run.args, r => r.source_progress?.source === "rba_monthly_metrics");
  assert.equal(recovering.source_progress.stage, "account_evidence_recovery");
  assert.equal(recovering.source_progress.attempt, 2);
  assert.equal(recovering.source_progress.source_deadline_seconds, 120);
  assert.equal(recovering.source_progress.stage_deadline_seconds, 300);
  assert.equal(recovering.recommended_contacts.length, 2);
  assert.deepEqual(recovering.prioritized_contacts.map(c => c.contact_ref), run.contacts.prioritized_contacts.map(c => c.contact_ref));
  const premature = await s.call("beta_complete_journey_a_contact_evidence", { ...run.args, gmail_metadata_state: "unavailable",
    gmail_metadata_message_count: 0, source_gap_codes: ["GMAIL_METADATA_UNAVAILABLE"] });
  assert.equal(premature.code, "PERFORMANCE_METRICS_PENDING");
  const draft = await s.call("beta_claim_outreach_draft", { case_id: run.created.case_id, revision: run.created.revision,
    content_digest: "a".repeat(64), private_draft_authorized: true });
  assert.equal(draft.code, "PERFORMANCE_METRICS_PENDING");
  const ready = await waitFor(s, run.args, r => r.relationship_context_state === "completed");
  assert.equal(ready.source_states.rba_monthly_metrics, "checked");
  assert.deepEqual(ready.source_gap_codes, []);
  assert.equal(ready.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, 120);
  assert.equal(ready.brief.product_performance_metrics.rows.find(r => r.metric === "Knowledge views").value, 1343);
  assert.equal(ready.recommended_contacts.length, 2);
  const state = await s.call("beta_case_status", { case_id: run.created.case_id });
  assert.deepEqual(state.completed_gates, []); assert.equal(state.private_artifact_bound, false);
  const saved = fs.readFileSync(path.join(s.dir, "state", run.created.case_id + ".json"), "utf8");
  assert.doesNotMatch(saved, /Invented (Recent|Older|Unresolved)|@example\.invalid|003000000000|RBA_CREATED_TICKETS/);
});

test("native failed metric retry ends once with its gap and still returns verified contacts", { timeout: 10000 }, async t => {
  const s = start(t, "retry_failed"), run = await begin(s);
  await waitFor(s, run.args, r => r.source_progress?.source === "rba_monthly_metrics");
  const final = await waitFor(s, run.args, r => r.relationship_context_state === "completed_with_gaps");
  assert.deepEqual(final.source_gap_codes, ["RBA_MONTHLY_METRICS_TIMEOUT"]);
  assert.equal(final.source_states.rba_monthly_metrics, "timed_out");
  assert.equal(final.recommended_contacts.length, 2);
  assert.equal(final.brief.product_performance_metrics.rows.find(r => r.metric === "Knowledge views").value, 1343);
  assert.equal(final.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, null);
});

test("native query failure is not retried and is never represented as a timeout or zero value", { timeout: 10000 }, async t => {
  const s = start(t, "query_failed");
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await s.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await s.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const contacts = await s.call("beta_run_journey_a_contact_evidence", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  const args = { case_id: created.case_id, contact_evidence_run_id: contacts.contact_evidence_run_id };
  await s.call("beta_continue_journey_a_contact_evidence", args);
  const final = await waitFor(s, args, r => r.relationship_context_state === "completed_with_gaps");
  assert.equal(final.source_states.rba_monthly_metrics, "unavailable");
  assert.deepEqual(final.source_gap_codes, ["RBA_MONTHLY_METRICS_UNAVAILABLE"]);
  assert.equal(final.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, null);
  assert.equal(final.recommended_contacts.length, 2);
});

test("restart expires the active metric recovery instead of restoring customer evidence or approvals", { timeout: 10000 }, async t => {
  const s = start(t), run = await begin(s);
  await waitFor(s, run.args, r => r.source_progress?.source === "rba_monthly_metrics");
  const fresh = start(t); await fresh.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await fresh.call("beta_create_authorized_journey_a_case", { language: "en" });
  const expired = await fresh.call("beta_continue_journey_a_contact_evidence", { ...run.args, case_id: created.case_id });
  assert.equal(expired.code, "CONTACT_EVIDENCE_RUN_EXPIRED");
  const state = await fresh.call("beta_case_status", { case_id: created.case_id });
  assert.deepEqual(state.completed_gates, []); assert.equal(state.private_artifact_bound, false);
});

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
function start(t, mode) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-outreach-reproduction-"));
  const namespace = `csm-outreach-repro-${randomBytes(6).toString("hex")}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json")));
  // Only this disposable invented-data fixture gets a fresh test lifetime.
  manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true,
    production_system_writes: false, generated_artifacts: true };
  const manifestPath = path.join(temp, "invented-manifest.json"), runtimePath = path.join(temp, "invented-runtime.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(runtimePath, JSON.stringify({ mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-outreach-tester" },
    snowflake: { state: "connected", read_only_verified: true },
    organizational_controls: { company_identity: true, read_only_zdp: true, transcript_secondary_processing: true,
      private_draft_google_scope: true, approved_renderer_execution: true, retention_policy: true, operational_support: true },
  }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/outreach-regression-loader.mjs", import.meta.url).href,
    path.join(root, "mcp/server.mjs")], { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env,
      PLUGIN_DATA: path.join(temp, "state"), CSM_COPILOT_BETA_STATE_NAMESPACE: namespace,
      CSM_COPILOT_BETA_MANIFEST_PATH: manifestPath, CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: runtimePath,
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true", CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
      CSM_OUTREACH_REGRESSION_MODE: mode } });
  let id = 0; const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let response; try { response = JSON.parse(line); } catch { return; }
    const waiter = pending.get(response.id); if (waiter) { pending.delete(response.id); waiter.resolve(response); }
  });
  child.on("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error("Invented test server ended.")); pending.clear(); });
  t.after(() => { child.stdin.end(); child.kill(); fs.rmSync(temp, { recursive: true, force: true }); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id; const timer = setTimeout(() => reject(new Error("Invented response timed out.")), 5000);
    pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  return { temp, rpc, call: async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(r.result?.content?.[0]?.text, JSON.stringify(r));
    return { ...JSON.parse(r.result.content[0].text), isError: r.result.isError === true };
  } };
}
async function prepared(server) {
  await server.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await server.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const contacts = await server.call("beta_run_journey_a_contact_evidence", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  const args = { case_id: created.case_id, contact_evidence_run_id: contacts.contact_evidence_run_id };
  const first = await server.call("beta_continue_journey_a_contact_evidence", args);
  let result = first;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    result = await server.call("beta_continue_journey_a_contact_evidence", args);
    if (!/pending$/.test(result.status)) break;
  }
  return { created, contacts, first, result, args };
}

test("completed outreach reads do not remain pending, and verified metrics survive a context gap", { timeout: 10000 }, async t => {
  const server = start(t, "context_unavailable"); const run = await prepared(server);
  assert.equal(run.result.status, "brief_and_contacts_ready");
  assert.equal(run.result.relationship_context_state, "completed_with_gaps");
  assert.deepEqual(run.result.source_gap_codes, ["ACCOUNT_CONTEXT_UNAVAILABLE"]);
  assert.equal(run.result.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, 120);
  assert.equal(run.result.recommended_contacts[0].display_name, "Invented Support Contact");
  const state = await server.call("beta_case_status", { case_id: run.created.case_id });
  assert.deepEqual(state.completed_gates, []); assert.equal(state.private_artifact_bound, false);
});

test("nine rejected contacts are explained and never presented as a ready recipient or approved draft", { timeout: 10000 }, async t => {
  const server = start(t, "blocked_contacts"); const run = await prepared(server);
  assert.equal(run.contacts.status, "no_eligible_contacts");
  assert.equal(run.contacts.outreach_pack.status, "no_eligible_contacts");
  assert.match(run.contacts.user_notice, /No contact is recommended/);
  assert.equal(run.result.status, "no_eligible_contacts");
  assert.equal(run.result.contact_counts.total, 9); assert.equal(run.result.contact_counts.eligible, 0);
  assert.deepEqual(run.result.contact_diagnostics.rejection_summary, { placeholder: 9 });
  assert.equal(run.result.contact_diagnostics.excluded_contacts.length, 9);
  assert.doesNotMatch(JSON.stringify(run.result.contact_diagnostics), /@|invented-placeholder-/);
  assert.equal(run.result.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, 120);
  const completed = await server.call("beta_complete_journey_a_contact_evidence", { ...run.args,
    gmail_metadata_state: "unavailable", gmail_metadata_message_count: 0, source_gap_codes: ["GMAIL_METADATA_UNAVAILABLE"] });
  assert.equal(completed.outreach_pack.status, "no_eligible_contacts");
  assert.deepEqual(completed.contact_diagnostics.rejection_summary, { placeholder: 9 });
  assert.match(completed.next_action, /rejection reasons/);
  const state = await server.call("beta_case_status", { case_id: run.created.case_id });
  assert.deepEqual(state.completed_gates, []); assert.equal(state.private_artifact_bound, false);
  const saved = fs.readFileSync(path.join(server.temp, "state", `${run.created.case_id}.json`), "utf8");
  assert.doesNotMatch(saved, /Unknown [0-9]|@example\.invalid|Invented Orchard/);
});

test("outreach exposes bounded source progress only while running and a restart expires its transient run", { timeout: 10000 }, async t => {
  const server = start(t, "progress");
  await server.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await server.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const contacts = await server.call("beta_run_journey_a_contact_evidence", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  const args = { case_id: created.case_id, contact_evidence_run_id: contacts.contact_evidence_run_id };
  await server.call("beta_continue_journey_a_contact_evidence", args);
  const pending = await server.call("beta_continue_journey_a_contact_evidence", args);
  assert.equal(pending.status, "relationship_context_pending");
  assert.equal(pending.next_check_after_seconds, 20);
  assert.equal(pending.source_progress.source, "account_context");
  assert.equal(pending.source_progress.attempt, 1);
  assert.equal(pending.source_progress.stage_deadline_seconds, 300);
  assert.equal(pending.source_progress.source_deadline_seconds, 120);
  assert.ok(pending.source_progress.elapsed_seconds >= 0);
  assert.doesNotMatch(JSON.stringify(pending.source_progress), /SELECT|invented-account|@/);
  await new Promise(resolve => setTimeout(resolve, 250));
  const ready = await server.call("beta_continue_journey_a_contact_evidence", args);
  assert.equal(ready.relationship_context_state, "completed");
  assert.equal(ready.status, "brief_and_contacts_ready");
  const freshProcess = start(t, "progress");
  await freshProcess.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const freshCase = await freshProcess.call("beta_create_authorized_journey_a_case", { language: "en" });
  const expired = await freshProcess.call("beta_continue_journey_a_contact_evidence", { ...args, case_id: freshCase.case_id });
  assert.equal(expired.isError, true);
  assert.equal(expired.code, "CONTACT_EVIDENCE_RUN_EXPIRED");
  const state = await freshProcess.call("beta_case_status", { case_id: freshCase.case_id });
  assert.deepEqual(state.completed_gates, []);
  assert.equal(state.private_artifact_bound, false);
});

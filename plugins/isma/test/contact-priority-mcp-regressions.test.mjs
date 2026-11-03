import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = process.env.CSM_CONTACT_TEST_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function start(t, mode = "ready") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-contact-priority-invented-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json")));
  // Only this disposable invented-data fixture gets a fresh test lifetime.
  manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-contact-tester" },
    snowflake: { state: "connected", read_only_verified: true }, organizational_controls: { company_identity: true, read_only_zdp: true,
      transcript_secondary_processing: true, private_draft_google_scope: true, approved_renderer_execution: true, retention_policy: true, operational_support: true } }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/contact-priority-loader.mjs", import.meta.url).href, path.join(root, "mcp/server.mjs")],
    { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PLUGIN_DATA: path.join(dir, "state"),
      CSM_COPILOT_BETA_MANIFEST_PATH: path.join(dir, "manifest.json"), CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(dir, "runtime.json"),
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true", CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python", CSM_CONTACT_PRIORITY_MODE: mode } });
  let id = 0; const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => { let r; try { r = JSON.parse(line); } catch { return; }
    const p = pending.get(r.id); if (p) { pending.delete(r.id); p(r); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Invented protocol response timed out.")); }, 5000);
    pending.set(requestId, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); });
  t.after(() => { child.stdin.end(); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, rpc, call: async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(r.result?.content?.[0]?.text, JSON.stringify(r)); return { ...JSON.parse(r.result.content[0].text), isError: r.result.isError === true }; } };
}
async function begin(s) {
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await s.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await s.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const first = await s.call("beta_run_journey_a_contact_evidence", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  return { created, first, workItemRef: queue.queue[0].work_item_ref, args: { case_id: created.case_id, contact_evidence_run_id: first.contact_evidence_run_id } };
}
async function finish(s, args) {
  for (let i = 0; i < 30; i++) { const r = await s.call("beta_continue_journey_a_contact_evidence", args);
    if (!/pending$/.test(r.status)) return r; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("Invented contact details did not finish.");
}

test("native beta displays priorities immediately, reports lookup progress and then returns two verified recipients", { timeout: 10000 }, async t => {
  const s = start(t), run = await begin(s);
  assert.equal(run.first.status, "contact_details_pending");
  assert.equal(run.first.contact_counts.prioritized, 3);
  assert.equal(run.first.recommended_contacts.length, 0);
  assert.equal(run.first.prioritized_contacts[0].display_name, "Invented Recent Operator");
  const interim = await s.call("beta_continue_journey_a_contact_evidence", run.args);
  assert.equal(interim.status, "contact_details_pending");
  assert.equal(interim.source_states.salesforce_identity, "not_requested");
  const pending = await s.call("beta_continue_journey_a_contact_evidence", run.args);
  assert.equal(pending.status, "contact_details_pending");
  assert.equal(pending.source_progress.source, "contact_details");
  assert.equal(pending.source_progress.source_deadline_seconds, 120);
  const premature = await s.call("beta_complete_journey_a_contact_evidence", { ...run.args, gmail_metadata_state: "unavailable", gmail_metadata_message_count: 0, source_gap_codes: ["GMAIL_METADATA_UNAVAILABLE"] });
  assert.equal(premature.code, "CONTACT_DETAILS_PENDING");
  const final = await finish(s, run.args);
  assert.equal(final.status, "brief_and_contacts_ready");
  assert.equal(final.recommended_contacts.length, 2);
  assert.equal(final.prioritized_contacts.length, 3);
  assert.equal(final.prioritized_contacts[2].contact_detail_state, "unmatched");
  assert.equal(final.brief.product_performance_metrics.rows.find(r => r.metric === "Tickets created").value, 120);
  assert.equal(final.source_states.contact_details, "checked");
  assert.doesNotMatch(JSON.stringify(final.prioritized_contacts), /@|003000000000/);
  const completed = await s.call("beta_complete_journey_a_contact_evidence", { ...run.args, gmail_metadata_state: "unavailable", gmail_metadata_message_count: 0, source_gap_codes: ["GMAIL_METADATA_UNAVAILABLE"] });
  assert.equal(completed.outreach_pack.status, "ready_for_contact_selection");
  const state = await s.call("beta_case_status", { case_id: run.created.case_id });
  assert.deepEqual(state.completed_gates, []); assert.equal(state.private_artifact_bound, false);
  const saved = fs.readFileSync(path.join(s.dir, "state", run.created.case_id + ".json"), "utf8");
  assert.doesNotMatch(saved, /Invented (Recent|Older|Unresolved)|@example\.invalid|003000000000/);
});

test("native contact approval cannot turn a missing email into an approved recipient", { timeout: 10000 }, async t => {
  const s = start(t), run = await begin(s);
  const bound = await s.call("beta_bind_journey_context", { case_id: run.created.case_id, journey: "journey_a", context_digest: "a".repeat(64),
    account_ref_digest: createHash("sha256").update("account:001000000000000AAA").digest("hex"), context_version: "1.0.0", item_count: 3, warning_codes: [] });
  for (const gate of ["work_selection", "account_evidence"]) assert.equal((await s.call("beta_record_journey_a_approval", { case_id: run.created.case_id, revision: bound.revision, gate })).isError, false);
  const blocked = await s.call("beta_record_journey_a_approval", { case_id: run.created.case_id, revision: bound.revision, gate: "contact_selection" });
  assert.equal(blocked.code, "CONTACT_RECIPIENT_NOT_VERIFIED");
});

test("native cross-account details stop safely with a visible gap and preserved contact priorities", { timeout: 10000 }, async t => {
  const s = start(t, "mismatch"), run = await begin(s);
  await s.call("beta_continue_journey_a_contact_evidence", run.args);
  const failed = await finish(s, run.args);
  assert.equal(failed.status, "relationship_context_unavailable");
  assert.ok(failed.source_gap_codes.includes("CONTACT_DETAIL_ACCOUNT_MISMATCH"));
  assert.equal(failed.source_states.contact_details, "unavailable");
  assert.equal(failed.prioritized_contacts.length, 3);
  assert.equal(failed.recommended_contacts.length, 0);
  const state = await s.call("beta_case_status", { case_id: run.created.case_id });
  assert.deepEqual(state.completed_gates, []); assert.equal(state.private_artifact_bound, false);
});

test("a new process cannot resume old raw contact bindings or a used account selection", { timeout: 10000 }, async t => {
  const s = start(t), run = await begin(s);
  const reused = await s.call("beta_run_journey_a_contact_evidence", { case_id: run.created.case_id, work_item_ref: run.workItemRef });
  assert.equal(reused.code, "ACCOUNT_SELECTION_EXPIRED");
  const fresh = start(t), other = await begin(fresh);
  const expired = await fresh.call("beta_continue_journey_a_contact_evidence", { ...run.args, case_id: other.created.case_id });
  assert.equal(expired.code, "CONTACT_EVIDENCE_RUN_EXPIRED");
});

test("verified details are visible with accurate source state before optional context finishes", { timeout: 10000 }, async t => {
  const s = start(t, "context_wait"), run = await begin(s);
  await s.call("beta_continue_journey_a_contact_evidence", run.args);
  await new Promise(resolve => setTimeout(resolve, 200));
  const partial = await s.call("beta_continue_journey_a_contact_evidence", run.args);
  assert.equal(partial.status, "relationship_context_pending");
  assert.equal(partial.recommended_contacts.length, 2);
  assert.equal(partial.source_states.contact_details, "checked");
  assert.equal(partial.brief.source_states.salesforce_contact_identity, "checked");
  assert.equal(partial.source_progress.source, "account_context");
});

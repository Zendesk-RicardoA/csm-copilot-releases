import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-bulk-invented-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json"), "utf8"));
  // Only this disposable invented-data fixture gets a fresh test lifetime.
  manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true,
    production_system_writes: false, generated_artifacts: true };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-bulk-tester" },
    snowflake: { state: "connected", read_only_verified: true }, organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true,
      private_draft_google_scope: true, approved_renderer_execution: true, retention_policy: true, operational_support: true,
    } }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/bulk-contact-loader.mjs", import.meta.url).href,
    path.join(root, "mcp/server.mjs")], { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env,
      PLUGIN_DATA: path.join(dir, "state"), CSM_COPILOT_BETA_MANIFEST_PATH: path.join(dir, "manifest.json"),
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(dir, "runtime.json"), CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true" } });
  let id = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const callback = pending.get(response.id);
    if (callback) { pending.delete(response.id); callback(response); }
  });
  t.after(() => { child.stdin.end(); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Invented protocol response timed out.")); }, 5000);
    pending.set(requestId, (response) => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  return { rpc, call: async (name, args = {}) => {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.ok(response.result?.content?.[0]?.text, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  } };
}

test("one case returns five shortlists first, then one same-account Salesforce verification with no draft", { timeout: 10_000 }, async (t) => {
  const server = start(t);
  await server.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await server.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  assert.equal(queue.queue.length, 5);
  const first = await server.call("beta_run_bulk_contact_research", { case_id: created.case_id,
    work_item_refs: queue.queue.map((item) => item.work_item_ref), include_copy_ready_emails: true });
  assert.equal(first.status, "bulk_contact_shortlist_ready", JSON.stringify(first));
  assert.equal(first.accounts.length, 5);
  assert.equal(first.recipient_export, null);
  assert.equal(first.email_verification_state, "pending");
  let verified;
  for (let n = 0; n < 30; n++) {
    verified = await server.call("beta_get_bulk_contact_email_verification", { case_id: created.case_id,
      bulk_contact_research_ref: first.bulk_contact_research_ref });
    if (verified.status !== "bulk_contact_email_verification_pending") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(verified.status, "bulk_contact_email_verification_ready", JSON.stringify(verified));
  assert.equal(verified.recipient_export.recipient_count, 5);
  assert.equal(verified.accounts[0].suggested_contacts[0].email_address, "person1@example.invalid");
  const status = await server.call("beta_case_status", { case_id: created.case_id });
  assert.equal(status.private_artifact_bound, false);
  assert.deepEqual(status.completed_gates, []);
});

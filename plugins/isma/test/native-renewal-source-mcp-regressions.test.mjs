import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => createHash("sha256").update(value).digest("hex");
function start(t, existing = null) {
  const dir = existing || fs.mkdtempSync(path.join(os.tmpdir(), "csm-native-renewal-invented-"));
  if (!existing) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json")));
    // Only this disposable invented-data fixture gets a fresh test lifetime.
    manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
    manifest.status = "approved_for_limited_beta";
    manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ mode: "limited_beta", renderer_mode: "manual_bound_script",
      identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-drive-tester" },
      snowflake: { state: "connected", read_only_verified: true }, organizational_controls: { company_identity: true, read_only_zdp: true,
        transcript_secondary_processing: true, private_draft_google_scope: true, approved_renderer_execution: true, retention_policy: true, operational_support: true } }), { mode: 0o600 });
  }
  const child = spawn(process.execPath, [path.join(root, "mcp/server.mjs")], { cwd: root, stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, PLUGIN_DATA: path.join(dir, "state"), CSM_COPILOT_BETA_MANIFEST_PATH: path.join(dir, "manifest.json"),
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(dir, "runtime.json"), CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true", CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python" } });
  let id = 0; const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => { let r; try { r = JSON.parse(line); } catch { return; }
    const done = pending.get(r.id); if (done) { pending.delete(r.id); done(r); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Invented native protocol request timed out.")); }, 5000);
    pending.set(requestId, r => { clearTimeout(timer); resolve(r); }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); });
  t.after(() => { child.stdin.end(); child.kill(); if (!existing) fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, rpc, call: async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(r.result?.content?.[0]?.text, JSON.stringify(r)); return { ...JSON.parse(r.result.content[0].text), isError: r.result.isError === true }; } };
}
async function caseFor(s) {
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await s.call("beta_create_authorized_journey_a_case", { language: "es" });
  assert.equal(created.isError, false);
  const bound = await s.call("beta_bind_journey_context", { case_id: created.case_id, journey: "journey_a", context_digest: "b".repeat(64),
    account_ref_digest: "a".repeat(64), context_version: "1.0.0", item_count: 2, warning_codes: [] });
  return { case_id: created.case_id, revision: bound.revision };
}
async function guideFor(s, selected, copy = "Invented reviewed renewal guidance") {
  let pending = await s.call("beta_resolve_renewal_sequence", { case_id: selected.case_id, priority: "P0", language: "es", language_variant: "EMEA" });
  for (let i = 0; pending.native_request && i < 20; i++) {
    const request = pending.native_request, args = request.arguments;
    let result;
    if (request.tool === "get_profile") result = { connected: true, profile_digest: hash("invented profile") };
    else if (request.tool === "search") result = { results: args.special_filter_query_str.includes("mimeType")
      ? [{ id: "invented-tracker", title: "H2 2099 Renewal Sequences | Localization Tracker", mime_type: "application/vnd.google-apps.spreadsheet" }]
      : [{ id: "invented-guide", title: "Spanish | Invented Guide", mime_type: "application/vnd.google-apps.document" }] };
    else if (request.tool === "get_spreadsheet_metadata") result = { spreadsheetId: "invented-tracker", sheets: [
      { properties: { sheetId: 1, title: "Template Link", gridProperties: { rowCount: 2, columnCount: 4 } } },
      { properties: { sheetId: 2, title: "H2 Renewal Sequences", gridProperties: { rowCount: 2, columnCount: 5 } } }] };
    else if (request.tool === "get_spreadsheet_range") {
      const rows = args.sheet_name === "Template Link" ? [["Clari Groove", "Clari Groove Copy", "Link", "Gainsight"], ["P0: Renewal [EMEA - ES]", "", "", ""]]
        : [["Language", "Sequence", "Localized One Pager", "Reviewed By", "Completed"], ["Spanish - EMEA", "Spanish | Invented Guide", "", "Invented reviewer", "TRUE"]];
      result = { range: `'${args.sheet_name}'!${args.range}`, majorDimension: "ROWS", values: [rows[args.range.startsWith("A1") ? 0 : 1]] };
    } else if (request.tool === "get_file_metadata") result = { id: "invented-guide", name: "Spanish | Invented Guide", mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2099-01-01T00:00:00Z", trashed: false };
    else if (request.tool === "get_document_text") result = { file_ref_digest: hash("invented-guide"), content_digest: hash(copy), character_count: copy.length, truncated: false };
    else throw new Error("No invented native write or unsupported method exists.");
    pending = await s.call("beta_continue_renewal_sequence", { case_id: selected.case_id, renewal_source_ref: pending.renewal_source_ref,
      tool_name: request.tool, source_status: "ok", result }); assert.equal(pending.isError, false, JSON.stringify(pending));
  }
  assert.equal(pending.status, "ready"); return pending;
}

test("native renewal source starts from the existing host Drive connection without an OAuth client", { timeout: 10000 }, async t => {
  const s = start(t), selected = await caseFor(s);
  const result = await s.call("beta_resolve_renewal_sequence", { case_id: selected.case_id, priority: "P0", language: "es", language_variant: "EMEA" });
  assert.equal(result.status, "native_google_drive_read_required"); assert.equal(result.isError, false);
  assert.deepEqual(result.native_request, { provider: "Google Drive", tool: "get_profile", arguments: {} });
  assert.doesNotMatch(JSON.stringify(result), /sign_in_required|OAuth|client_secret|authorization_url/);
  const next = await s.call("beta_continue_renewal_sequence", { case_id: selected.case_id, renewal_source_ref: result.renewal_source_ref,
    tool_name: "get_profile", source_status: "ok", result: { connected: true, profile_digest: hash("invented native Drive profile") } });
  assert.equal(next.native_request.tool, "search"); assert.equal(next.isError, false);
  const saved = fs.readFileSync(path.join(s.dir, "state", selected.case_id + ".json"), "utf8");
  assert.doesNotMatch(saved, /invented native Drive profile|renewal_source_ref|google.*token/);
});
test("native Drive setup is a host profile check, not another browser grant", { timeout: 10000 }, async t => {
  const s = start(t); await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const setup = await s.call("beta_connect_google_shared_sources");
  assert.equal(setup.status, "native_google_drive_check_required"); assert.equal(setup.native_request.tool, "get_profile");
  const completed = await s.call("beta_complete_google_shared_sources_connection", { connection_ref: setup.connection_ref,
    connected: true, profile_digest: hash("invented native Drive profile") });
  assert.equal(completed.status, "ready"); assert.equal(completed.source_copy_checked, false);
  const status = await s.call("beta_setup_status", { workflow: "outreach" });
  assert.equal(status.connection_setup.state, "ready"); assert.equal(status.status, "available_unverified");
});
test("renewal source continuation is registered and cannot accept arbitrary private content", { timeout: 10000 }, async t => {
  const s = start(t), listed = await s.rpc("tools/list", {});
  const tool = listed.result.tools.find(x => x.name === "beta_continue_renewal_sequence");
  assert.ok(tool, "The complete native Drive continuation must be packaged and callable.");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.tool_name.enum, ["get_profile", "search", "get_spreadsheet_metadata", "get_spreadsheet_range", "get_file_metadata", "get_document_text", "fetch"]);
  const selected = await caseFor(s), pending = await s.call("beta_resolve_renewal_sequence", { case_id: selected.case_id, priority: "P0", language: "es" });
  const invalid = await s.call("beta_continue_renewal_sequence", { case_id: selected.case_id, renewal_source_ref: pending.renewal_source_ref,
    tool_name: "get_profile", source_status: "ok", result: { connected: true, profile_digest: hash("invented profile"), transcript: "Invented but forbidden content" } });
  assert.equal(invalid.code, "RENEWAL_NATIVE_RESULT_INVALID");
});
test("native failed renewal read is incomplete and grants no customer, content or write approval", { timeout: 10000 }, async t => {
  const s = start(t), selected = await caseFor(s), pending = await s.call("beta_resolve_renewal_sequence", { case_id: selected.case_id, priority: "P0", language: "es" });
  const failed = await s.call("beta_continue_renewal_sequence", { case_id: selected.case_id, renewal_source_ref: pending.renewal_source_ref,
    tool_name: "get_profile", source_status: "timed_out", result: {} });
  assert.equal(failed.status, "renewal_source_unavailable"); assert.equal(failed.failure_stage, "profile");
  const state = JSON.parse(fs.readFileSync(path.join(s.dir, "state", selected.case_id + ".json")));
  assert.deepEqual(state.journey_state.contexts.journey_a.approvals, []); assert.equal(state.outreach_delivery, undefined);
  assert.equal(state.renewal_source_receipt, undefined); assert.equal(state.revision, selected.revision);
  const again = await s.call("beta_continue_renewal_sequence", { case_id: selected.case_id, renewal_source_ref: pending.renewal_source_ref,
    tool_name: "get_profile", source_status: "ok", result: { connected: true, profile_digest: hash("invented profile") } });
  assert.equal(again.code, "RENEWAL_SOURCE_READ_EXPIRED");
});
test("restart and a foreign case cannot resume an old source read", { timeout: 10000 }, async t => {
  const s = start(t), selected = await caseFor(s), pending = await s.call("beta_resolve_renewal_sequence", { case_id: selected.case_id, priority: "P0", language: "es" });
  const other = await s.call("beta_create_authorized_journey_a_case", { language: "es" });
  await s.call("beta_bind_journey_context", { case_id: other.case_id, journey: "journey_a", context_digest: "b".repeat(64), account_ref_digest: "a".repeat(64), context_version: "1.0.0", item_count: 1 });
  const args = { case_id: other.case_id, renewal_source_ref: pending.renewal_source_ref, tool_name: "get_profile", source_status: "ok", result: { connected: true, profile_digest: hash("invented profile") } };
  assert.equal((await s.call("beta_continue_renewal_sequence", args)).code, "RENEWAL_SOURCE_SCOPE_MISMATCH");
  const fresh = start(t, s.dir); await fresh.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal((await fresh.call("beta_continue_renewal_sequence", { ...args, case_id: selected.case_id })).code, "RENEWAL_SOURCE_READ_EXPIRED");
});
test("complete native source execution persists only the receipt and never copy, file IDs, reviewer names or automatic approvals", { timeout: 10000 }, async t => {
  const s = start(t), selected = await caseFor(s), completed = await guideFor(s, selected);
  const raw = fs.readFileSync(path.join(s.dir, "state", selected.case_id + ".json"), "utf8"), state = JSON.parse(raw);
  assert.equal(state.renewal_source_receipt.sequence_content_digest, hash("Invented reviewed renewal guidance"));
  assert.equal(state.revision, selected.revision); assert.deepEqual(state.journey_state.contexts.journey_a.approvals, []);
  assert.equal(state.outreach_delivery, undefined); assert.equal(completed.copy_state, "read");
  assert.doesNotMatch(raw, /invented-tracker|invented-guide|Invented reviewer|Spanish|Invented reviewed renewal guidance|https:/);
});
test("changed guide invalidates only template/email review and cannot carry prior wording approval", { timeout: 10000 }, async t => {
  const s = start(t), selected = await caseFor(s); await guideFor(s, selected);
  const file = path.join(s.dir, "state", selected.case_id + ".json"), state = JSON.parse(fs.readFileSync(file));
  state.journey_state.contexts.journey_a.approvals = ["work_selection", "account_evidence", "contact_selection", "template_preview", "outreach_draft"].map(gate => ({ gate, revision: selected.revision }));
  state.outreach_delivery = { state: "review_ready", content_digest: "c".repeat(64), revision: selected.revision };
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  await guideFor(s, selected, "Invented revised renewal guidance");
  const changed = JSON.parse(fs.readFileSync(file));
  assert.equal(changed.revision, selected.revision + 1);
  assert.deepEqual(changed.journey_state.contexts.journey_a.approvals.map(a => a.gate), ["work_selection", "account_evidence", "contact_selection"]);
  assert.equal(changed.outreach_delivery, undefined);
});
test("evidence-only guidance is an explicit template decision, never an early approval bypass", { timeout: 10000 }, async t => {
  const s = start(t), selected = await caseFor(s);
  const listed = await s.rpc("tools/list", {}), approval = listed.result.tools.find(x => x.name === "beta_record_journey_a_approval");
  assert.deepEqual(approval.inputSchema.properties.renewal_source_mode?.enum, ["current_sequence", "evidence_only"]);
  const early = await s.call("beta_record_journey_a_approval", { ...selected, gate: "template_preview", renewal_source_mode: "evidence_only" });
  assert.equal(early.code, "APPROVAL_ORDER_VIOLATION");
  const wrongGate = await s.call("beta_record_journey_a_approval", { ...selected, gate: "work_selection", renewal_source_mode: "evidence_only" });
  assert.equal(wrongGate.code, "RENEWAL_SOURCE_DECISION_GATE_REQUIRED");
  const state = JSON.parse(fs.readFileSync(path.join(s.dir, "state", selected.case_id + ".json")));
  assert.deepEqual(state.journey_state.contexts.journey_a.approvals, []); assert.equal(state.renewal_source_mode, undefined);
});

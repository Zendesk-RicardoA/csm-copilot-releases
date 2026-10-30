import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inventedRenewalNativeLayout } from "./fixtures/renewal-native-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
function start(temp) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json")));
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true,
    production_system_writes: false, generated_artifacts: true };
  const manifestPath = path.join(temp, "invented-manifest.json"), runtimePath = path.join(temp, "invented-runtime.json");
  writeJson(manifestPath, manifest);
  writeJson(runtimePath, { mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-review-owner" },
    snowflake: { state: "connected", read_only_verified: true }, organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true, private_draft_google_scope: true,
      approved_renderer_execution: true, retention_policy: true, operational_support: true } });
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/renewal-review-clock-loader.mjs", import.meta.url).href,
    path.join(root, "mcp/server.mjs")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
    PLUGIN_DATA: path.join(temp, "state"), CSM_COPILOT_BETA_STATE_NAMESPACE: "csm-invented-review-window",
    CSM_COPILOT_BETA_MANIFEST_PATH: manifestPath, CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: runtimePath,
    CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true", CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
    CSM_INVENTED_RENEWAL_CLOCK: path.join(temp, "clock.json") } });
  let id = 0, stderr = "";
  const pending = new Map();
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const result = JSON.parse(line), resolve = pending.get(result.id);
    if (resolve) { pending.delete(result.id); resolve(result); }
  });
  const call = async (name, args) => {
    const next = ++id;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Invented ${name} stalled: ${stderr.slice(-800)}`)), 10_000);
      pending.set(next, value => { clearTimeout(timer); resolve(value); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const response = await result;
    return { ...JSON.parse(response.result.content[0].text), isError: response.result.isError === true };
  };
  return { call, stop: () => { child.stdin.end(); child.kill(); } };
}

async function prepared(t, collectionElapsedMs) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-invented-review-window-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const clockPath = path.join(temp, "clock.json");
  writeJson(clockPath, { offset_ms: 0, collection_elapsed_ms: collectionElapsedMs });
  const server = start(temp);
  t.after(() => server.stop());
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await server.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const begun = await server.call("beta_prepare_renewal_conversation_brief", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  const args = { case_id: created.case_id, renewal_conversation_run_id: begun.renewal_conversation_run_id };
  const evidence = await server.call("beta_wait_for_renewal_conversation_evidence", { ...args, wait_seconds: 1 });
  assert.equal(evidence.status, "evidence_ready_with_gaps");
  const review = await server.call("beta_get_renewal_conversation_evidence", args);
  const metric = review.customer_content_review.tables.find(table => table.id === "progress_metric_candidates").rows[0].id;
  const pair = review.customer_content_review.tables.find(table => table.id === "linked_opportunities_and_focus").rows[0].id;
  const advance = offset_ms => writeJson(clockPath, { offset_ms, collection_delay_used: true });
  const select = () => server.call("beta_select_renewal_deck_content", { ...args, revision: begun.revision,
    selected_metric_ids: [metric], selected_pair_ids: [pair] });
  const statePath = path.join(temp, "state", `${created.case_id}.json`);
  return { temp, server, args, review, advance, select, statePath };
}

test("slow collection does not consume the renewal's 15-minute review and approved-draft handoff window", { timeout: 30_000 }, async t => {
  const flow = await prepared(t, 200_000);
  flow.advance(850_000);
  const selected = await flow.select();
  assert.equal(selected.status, "native_fit_required");
  const fitted = await flow.server.call("beta_bind_renewal_native_fit", { ...flow.args, revision: selected.revision,
    native_fit_request_ref: selected.native_fit_request_ref, native_result: inventedRenewalNativeLayout(selected.native_layout_capture_request) });
  assert.equal(fitted.status, "review_ready");
  flow.advance(1_000_000); // Old timer expired at 900s; evidence is only 800s old.
  const wrongOrder = await flow.server.call("beta_record_renewal_conversation_approval", { case_id: flow.args.case_id, revision: fitted.revision, gate: "evidence" });
  assert.equal(wrongOrder.code, "APPROVAL_ORDER_VIOLATION");
  const early = await flow.server.call("beta_render_renewal_conversation_brief", { case_id: flow.args.case_id, revision: fitted.revision, private_draft_authorized: true });
  assert.equal(early.code, "REVIEW_INCOMPLETE");
  for (const gate of ["identity", "evidence", "renewal_hypotheses", "renewal_content"]) {
    const approval = await flow.server.call("beta_record_renewal_conversation_approval", { case_id: flow.args.case_id, revision: fitted.revision, gate });
    assert.equal(approval.isError, false, JSON.stringify(approval));
  }
  assert.equal(flow.review.review_window.duration_seconds, 900);
  assert.ok(flow.review.review_window.remaining_seconds >= 899);
  const expiry = flow.review.review_window.expires_at;
  assert.equal(selected.review_window.expires_at, expiry);
  assert.equal((await flow.server.call("beta_get_renewal_conversation_evidence", flow.args)).review_window.expires_at, expiry,
    "Review, display and approval calls never extend the evidence's absolute expiry");
  const denied = await flow.server.call("beta_render_renewal_conversation_brief", { case_id: flow.args.case_id, revision: fitted.revision, private_draft_authorized: false });
  assert.equal(denied.code, "DRAFT_NOT_AUTHORIZED");
  const request = await flow.server.call("beta_render_renewal_conversation_brief", { case_id: flow.args.case_id, revision: fitted.revision, private_draft_authorized: true });
  assert.equal(request.status, "manual_action_required");
  assert.deepEqual(JSON.parse(request.manual_render_request).bridgeInput.reviewPackage.customer_slides, fitted.renewal_deck_content.customer_slides);
  assert.equal(JSON.parse(request.manual_render_request).bridgeInput.output.private_draft_only, true);
  assert.equal(request.private_draft, undefined, "Preparing a request is not deck creation");
});

test("expired review cannot gain approvals, extend itself or render saved digests", { timeout: 30_000 }, async t => {
  const flow = await prepared(t, 200_000);
  const selected = await flow.select();
  const fitted = await flow.server.call("beta_bind_renewal_native_fit", { ...flow.args, revision: selected.revision,
    native_fit_request_ref: selected.native_fit_request_ref, native_result: inventedRenewalNativeLayout(selected.native_layout_capture_request) });
  flow.advance(1_110_000);
  const before = fs.readFileSync(flow.statePath, "utf8");
  const approval = await flow.server.call("beta_record_renewal_conversation_approval", { case_id: flow.args.case_id, revision: fitted.revision, gate: "identity" });
  assert.equal(approval.code, "RENEWAL_REVIEW_RUN_EXPIRED");
  assert.equal(fs.readFileSync(flow.statePath, "utf8"), before);
  assert.equal((await flow.server.call("beta_get_renewal_conversation_evidence", flow.args)).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
  assert.equal((await flow.server.call("beta_revise_renewal_customer_copy", { ...flow.args, revision: fitted.revision, recheck_native_fit: true })).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
});

test("restart discards review data and cannot transfer approvals to a new account", { timeout: 30_000 }, async t => {
  const flow = await prepared(t, 0);
  const selected = await flow.select();
  const fitted = await flow.server.call("beta_bind_renewal_native_fit", { ...flow.args, revision: selected.revision,
    native_fit_request_ref: selected.native_fit_request_ref, native_result: inventedRenewalNativeLayout(selected.native_layout_capture_request) });
  const record = JSON.parse(fs.readFileSync(flow.statePath));
  record.renewal_conversation.account_ref_digest = "c".repeat(64);
  writeJson(flow.statePath, record);
  assert.equal((await flow.server.call("beta_record_renewal_conversation_approval", { case_id: flow.args.case_id, revision: fitted.revision, gate: "identity" })).code, "RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH");
  assert.deepEqual(JSON.parse(fs.readFileSync(flow.statePath)).renewal_conversation.approvals, []);
  flow.server.stop();
  const restarted = start(flow.temp);
  t.after(() => restarted.stop());
  assert.equal((await restarted.call("beta_record_renewal_conversation_approval", { case_id: flow.args.case_id, revision: fitted.revision, gate: "identity" })).code, "RENEWAL_REVIEW_RUN_EXPIRED");
  assert.equal((await restarted.call("beta_get_renewal_conversation_evidence", flow.args)).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
});

test("a late stopped collection cannot rehydrate customer evidence or persist a completed review", { timeout: 30_000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-invented-late-collection-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const clockPath = path.join(temp, "clock.json");
  writeJson(clockPath, { offset_ms: 0, hold_collection: true });
  const server = start(temp);
  t.after(() => server.stop());
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await server.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const begun = await server.call("beta_prepare_renewal_conversation_brief", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  const args = { case_id: created.case_id, renewal_conversation_run_id: begun.renewal_conversation_run_id };
  writeJson(clockPath, { offset_ms: 910_000, hold_collection: true });
  assert.equal((await server.call("beta_get_renewal_conversation_evidence", args)).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
  const statePath = path.join(temp, "state", `${created.case_id}.json`);
  const before = fs.readFileSync(statePath, "utf8");
  writeJson(clockPath, { offset_ms: 910_000, hold_collection: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await server.call("beta_get_renewal_conversation_evidence", args)).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
  assert.equal(fs.readFileSync(statePath, "utf8"), before, "Late SDK results cannot overwrite the stopped review state");
});

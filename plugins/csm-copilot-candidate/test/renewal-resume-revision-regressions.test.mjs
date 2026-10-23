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
const gates = ["identity", "evidence", "renewal_hypotheses", "renewal_content"];
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

function start(temp, controls) {
  const child = spawn(process.execPath, ["--experimental-loader",
    new URL("./fixtures/renewal-resume-loader.mjs", import.meta.url).href, path.join(root, "mcp/server.mjs")], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
      PLUGIN_DATA: path.join(temp, "state"), CSM_COPILOT_BETA_STATE_NAMESPACE: "csm-invented-renewal-resume",
      CSM_COPILOT_BETA_MANIFEST_PATH: path.join(temp, "manifest.json"),
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(temp, "runtime.json"),
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true", CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
      CSM_INVENTED_RENEWAL_RESUME: controls,
    },
  });
  let id = 0, stderr = "";
  const pending = new Map();
  child.stderr.on("data", part => { stderr += String(part); });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter.resolve(response); }
  });
  child.on("exit", code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Invented renewal server exited ${code}: ${stderr.slice(-800)}`));
    pending.clear();
  });
  async function call(name, args) {
    const next = ++id;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`Invented ${name} stalled: ${stderr.slice(-800)}`)); }, 10_000);
      pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const result = await response;
    assert.ok(result.result?.content?.[0]?.text, JSON.stringify(result));
    return { ...JSON.parse(result.result.content[0].text), isError: result.result.isError === true };
  }
  return { call, stop: () => { child.stdin.end(); child.kill(); } };
}

async function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-invented-renewal-resume-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const controls = path.join(temp, "controls.json");
  writeJson(controls, { now_ms: Date.parse("2026-10-23T10:00:00Z"), arr_usd: 15000, query_count: 0 });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json")));
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true,
    production_system_writes: false, generated_artifacts: true };
  writeJson(path.join(temp, "manifest.json"), manifest);
  writeJson(path.join(temp, "runtime.json"), { mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-resume-owner" },
    snowflake: { state: "connected", read_only_verified: true }, organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true, private_draft_google_scope: true,
      approved_renderer_execution: true, retention_policy: true, operational_support: true } });
  const servers = [];
  const restart = () => { for (const server of servers) server.stop(); const server = start(temp, controls); servers.push(server); return server; };
  t.after(() => { for (const server of servers) server.stop(); });
  const server = restart();
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  assert.equal(created.isError, false, JSON.stringify(created));
  const statePath = path.join(temp, "state", `${created.case_id}.json`);
  const read = () => JSON.parse(fs.readFileSync(statePath));
  const control = patch => { const value = JSON.parse(fs.readFileSync(controls)); if (patch) writeJson(controls, { ...value, ...patch }); return value; };
  const begin = async currentServer => {
    const queue = await currentServer.call("beta_read_owned_cta_queue", { case_id: created.case_id });
    assert.equal(queue.status, "ready", JSON.stringify(queue));
    const begun = await currentServer.call("beta_prepare_renewal_conversation_brief", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
    assert.equal(begun.status, "collecting", JSON.stringify(begun));
    return begun;
  };
  const wait = (currentServer, begun) => currentServer.call("beta_wait_for_renewal_conversation_evidence", {
    case_id: created.case_id, renewal_conversation_run_id: begun.renewal_conversation_run_id, wait_seconds: 1,
  });
  const first = await begin(server);
  assert.equal(first.revision, 2);
  const evidence = await wait(server, first);
  assert.equal(evidence.status, "evidence_ready_with_gaps", JSON.stringify(evidence));
  assert.equal(evidence.revision, 2);
  return { temp, server, controls, restart, caseId: created.case_id, statePath, read, control, begin, wait, first, evidence };
}

function selections(flow, evidence, revision) {
  return { case_id: flow.caseId, renewal_conversation_run_id: evidence.renewal_conversation_run_id, revision,
    selected_metric_ids: ["metric:zero-touch-ticket-ratio"], selected_pair_ids: ["pair:metric:median-first-reply-time"] };
}

async function fit(flow, server, evidence, revision) {
  const selected = await server.call("beta_select_renewal_deck_content", selections(flow, evidence, revision));
  assert.equal(selected.status, "native_fit_required", JSON.stringify(selected));
  const fitted = await server.call("beta_bind_renewal_native_fit", { case_id: flow.caseId,
    renewal_conversation_run_id: evidence.renewal_conversation_run_id, revision: selected.revision,
    native_fit_request_ref: selected.native_fit_request_ref,
    native_result: inventedRenewalNativeLayout(selected.native_layout_capture_request) });
  assert.equal(fitted.status, "review_ready", JSON.stringify(fitted));
  return { selected, fitted };
}

async function approveAndHandoff(flow, server, fitted) {
  for (const gate of gates) {
    const approved = await server.call("beta_record_renewal_conversation_approval", { case_id: flow.caseId, revision: fitted.revision, gate });
    assert.equal(approved.isError, false, JSON.stringify(approved));
  }
  const handoff = await server.call("beta_render_renewal_conversation_brief", { case_id: flow.caseId, revision: fitted.revision, private_draft_authorized: true });
  assert.equal(handoff.status, "manual_action_required", JSON.stringify(handoff));
  assert.equal(handoff.private_draft, undefined, "An invented handoff is not an actual Google Slides draft");
  return handoff;
}

async function closeForRetry(flow, server, begun, revision) {
  const closed = await server.call("beta_complete_renewal_conversation", { case_id: flow.caseId,
    renewal_conversation_run_id: begun.renewal_conversation_run_id, revision, outcome: "retry_later" });
  assert.equal(closed.status, "retry_later", JSON.stringify(closed));
}

test("changed evidence in a resumed renewal uses the issued case revision and requires a new complete review", { timeout: 30_000 }, async t => {
  const flow = await setup(t);
  const oldFit = await fit(flow, flow.server, flow.evidence, 2);
  const oldHandoff = await approveAndHandoff(flow, flow.server, oldFit.fitted);
  const previous = flow.read();
  assert.equal(previous.revision, 3);
  await closeForRetry(flow, flow.server, flow.first, 3);
  flow.control({ arr_usd: 15500 });
  const begun = await flow.begin(flow.server);
  assert.equal(begun.revision, 4);
  const fresh = await flow.wait(flow.server, begun);
  assert.equal(fresh.status, "evidence_ready_with_gaps");
  assert.match(fresh.account_brief_display.markdown, /\$15,500\.00/);
  const saved = flow.read();
  assert.equal(saved.revision, 5, "Changed account evidence independently advances the persisted revision");
  assert.equal(fresh.revision, 5, "The active run must expose that same newly issued revision");
  assert.equal(saved.account_intelligence_core.revision, 5);
  assert.notEqual(saved.account_intelligence_core.content_digest, previous.account_intelligence_core.content_digest);
  assert.deepEqual(saved.approvals, []);
  assert.deepEqual(saved.renewal_conversation.approvals, []);
  assert.equal(saved.renewal_conversation.native_fit_receipt, undefined);
  assert.equal(saved.renewal_conversation.draft_handoff_receipt, undefined);
  assert.equal((await flow.server.call("beta_select_renewal_deck_content", selections(flow, fresh, 4))).code, "STALE_CASE_REVISION");
  const queries = flow.control().query_count;
  const current = await fit(flow, flow.server, fresh, 5);
  assert.equal(current.fitted.revision, 6);
  assert.equal(current.fitted.native_fit_receipt.reviewed_revision, 6);
  assert.equal((await flow.server.call("beta_record_renewal_conversation_approval", { case_id: flow.caseId, revision: 6, gate: "evidence" })).code, "APPROVAL_ORDER_VIOLATION");
  assert.equal((await flow.server.call("beta_render_renewal_conversation_brief", { case_id: flow.caseId, revision: 6, private_draft_authorized: true })).code, "REVIEW_INCOMPLETE");
  const handoff = await approveAndHandoff(flow, flow.server, current.fitted);
  const nativeRequest = JSON.parse(handoff.manual_render_request);
  assert.deepEqual(nativeRequest.bridgeInput.reviewPackage.customer_slides, current.fitted.renewal_deck_content.customer_slides);
  assert.equal(nativeRequest.bridgeInput.output.private_draft_only, true);
  assert.equal(flow.control().query_count, queries, "Selection and review reuse the new evidence without source rereads");
  const completion = { case_id: flow.caseId, renewal_conversation_run_id: fresh.renewal_conversation_run_id,
    revision: 6, outcome: "draft_created", draft_receipt_ref: handoff.draft_receipt_ref,
    private_draft_created_confirmed: true, rendered_draft_reviewed: true };
  assert.equal((await flow.server.call("beta_complete_renewal_conversation", { ...completion, draft_receipt_ref: oldHandoff.draft_receipt_ref })).code, "RENEWAL_DRAFT_HANDOFF_REQUIRED");
  assert.equal((await flow.server.call("beta_complete_renewal_conversation", { ...completion, rendered_draft_reviewed: false })).code, "RENEWAL_RENDERED_REVIEW_REQUIRED");
  assert.equal((await flow.server.call("beta_complete_renewal_conversation", completion)).status, "draft_created");
  assert.equal((await flow.server.call("beta_complete_renewal_conversation", completion)).already_completed, true);
  assert.doesNotMatch(fs.readFileSync(flow.statePath, "utf8"), /Invented Orchard|15,500|shorter path|first-response waits/);
});

test("an unchanged refreshed receipt does not invent an additional evidence revision", { timeout: 30_000 }, async t => {
  const flow = await setup(t), digest = flow.read().account_intelligence_core.content_digest;
  await closeForRetry(flow, flow.server, flow.first, 2);
  const begun = await flow.begin(flow.server);
  const fresh = await flow.wait(flow.server, begun);
  assert.equal(flow.read().account_intelligence_core.content_digest, digest);
  assert.equal(begun.revision, 3);
  assert.equal(fresh.revision, 3);
  assert.equal(flow.read().revision, 3);
  assert.equal((await fit(flow, flow.server, fresh, 3)).fitted.status, "review_ready");
});

test("restart requires a fresh read and the refreshed saved case can then be reviewed", { timeout: 30_000 }, async t => {
  const flow = await setup(t);
  await closeForRetry(flow, flow.server, flow.first, 2);
  const restarted = flow.restart();
  assert.equal((await restarted.call("beta_get_renewal_conversation_evidence", { case_id: flow.caseId, renewal_conversation_run_id: flow.first.renewal_conversation_run_id })).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
  flow.control({ arr_usd: 15500 });
  const begun = await flow.begin(restarted), fresh = await flow.wait(restarted, begun);
  assert.equal(fresh.revision, 4);
  assert.equal(flow.read().revision, 4);
  assert.equal((await fit(flow, restarted, fresh, 4)).fitted.status, "review_ready");
});

test("revision reconciliation never extends a renewed evidence window or resurrects it after expiry", { timeout: 30_000 }, async t => {
  const flow = await setup(t);
  await closeForRetry(flow, flow.server, flow.first, 2);
  flow.control({ arr_usd: 15500 });
  const begun = await flow.begin(flow.server), fresh = await flow.wait(flow.server, begun);
  assert.equal(fresh.revision, flow.read().revision);
  const before = fs.readFileSync(flow.statePath, "utf8");
  flow.control({ now_ms: flow.control().now_ms + 901_000 });
  assert.equal((await flow.server.call("beta_select_renewal_deck_content", selections(flow, fresh, fresh.revision))).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
  assert.equal((await flow.server.call("beta_get_renewal_conversation_evidence", { case_id: flow.caseId, renewal_conversation_run_id: fresh.renewal_conversation_run_id })).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
  assert.equal(fs.readFileSync(flow.statePath, "utf8"), before);
});

test("a concurrent saved-case revision is not overwritten or adopted by an older collection", { timeout: 30_000 }, async t => {
  const flow = await setup(t);
  await closeForRetry(flow, flow.server, flow.first, 2);
  flow.control({ arr_usd: 15500, hold_account_read: true });
  const begun = await flow.begin(flow.server);
  const concurrent = flow.read();
  concurrent.revision = 4;
  writeJson(flow.statePath, concurrent);
  const before = fs.readFileSync(flow.statePath, "utf8");
  flow.control({ hold_account_read: false });
  const fresh = await flow.wait(flow.server, begun);
  assert.equal(fresh.revision, 3, "Only this run's successful persisted binding may reconcile its revision");
  assert.equal(fs.readFileSync(flow.statePath, "utf8"), before);
  assert.equal((await flow.server.call("beta_select_renewal_deck_content", selections(flow, fresh, 4))).code, "STALE_CASE_REVISION");
  assert.equal((await flow.server.call("beta_select_renewal_deck_content", selections(flow, fresh, 3))).code, "STALE_CASE_REVISION");
});

test("a different-account receipt is never accepted while reconciling a resumed run", { timeout: 30_000 }, async t => {
  const flow = await setup(t);
  await closeForRetry(flow, flow.server, flow.first, 2);
  flow.control({ arr_usd: 15500, hold_account_read: true });
  const begun = await flow.begin(flow.server), foreign = flow.read();
  foreign.renewal_conversation.account_ref_digest = "f".repeat(64);
  writeJson(flow.statePath, foreign);
  flow.control({ hold_account_read: false });
  const result = await flow.wait(flow.server, begun);
  assert.equal(result.execution_receipt.safe_source_outcome, "CROSS_JOURNEY_ACCOUNT_MISMATCH");
  assert.equal(flow.read().revision, 3);
  assert.equal(flow.read().account_intelligence_core.content_digest, foreign.account_intelligence_core.content_digest);
  assert.equal((await flow.server.call("beta_select_renewal_deck_content", selections(flow, result, 3))).code, "RENEWAL_CONTENT_NOT_READY");
  assert.deepEqual(flow.read().renewal_conversation.approvals, []);
});

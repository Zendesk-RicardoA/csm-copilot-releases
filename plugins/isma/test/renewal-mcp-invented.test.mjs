import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { cleanupTemporaryChartDirectory } from "../mcp/account-brief-chart-files.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inventedRenewalNativeLayout, refreshInventedLayoutDigest } from './fixtures/renewal-native-layout.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureLoader = new URL("./fixtures/renewal-synthetic-loader.mjs", import.meta.url);

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

function testRuntime(tempDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "config", "approved-version-manifest.json"), "utf8"));
  // This simulated approval exists only inside this test's temporary folder.
  // The fake reader and impossible Python path prevent live source access.
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = {
    real_customer_data: true, external_reads: true, private_draft_writes: true,
    production_system_writes: false, generated_artifacts: true,
  };
  const manifestPath = path.join(tempDir, "synthetic-manifest.json");
  const runtimePath = path.join(tempDir, "synthetic-runtime.json");
  writeJson(manifestPath, manifest);
  writeJson(runtimePath, {
    mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_company_sso", subject: "invented-renewal-tester" },
    snowflake: { state: "connected", read_only_verified: true },
    organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true,
      private_draft_google_scope: true, approved_renderer_execution: true,
      retention_policy: true, operational_support: true,
    },
  });
  return { manifestPath, runtimePath };
}

function startServer(tempDir, { manifestPath, runtimePath }) {
  const child = spawn(process.execPath, [
    "--experimental-loader", pathToFileURL(fileURLToPath(fixtureLoader)).href,
    path.join(pluginRoot, "mcp", "server.mjs"),
  ], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      PLUGIN_DATA: path.join(tempDir, "state"),
      CSM_COPILOT_BETA_STATE_NAMESPACE: `csm-invented-renewal-${randomBytes(5).toString("hex")}`,
      CSM_COPILOT_BETA_MANIFEST_PATH: manifestPath,
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: runtimePath,
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true",
      CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (part) => { stderr += part.toString(); });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    waiter.resolve(response);
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Invented beta server exited ${code}: ${stderr.slice(-800)}`));
    pending.clear();
  });
  async function send(method, params) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Invented beta server did not answer ${method}`)); }, 10_000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }
  async function call(name, args = {}) {
    const response = await send("tools/call", { name, arguments: args });
    assert.ok(response.result?.content?.[0]?.text, `${name} had no result: ${JSON.stringify(response)}`);
    return { ...JSON.parse(response.result.content[0].text), isError: response.result.isError === true };
  }
  return { child, send, call };
}

test("invented renewal CTA reaches reviewed content and a private render request through packaged MCP tools", { timeout: 30_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-renewal-mcp-invented-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const controls = testRuntime(tempDir);
  const server = startServer(tempDir, controls);
  t.after(() => { server.child.stdin.end(); server.child.kill(); });
  const initialized = await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const packagedName = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).name;
  assert.equal(initialized.result.serverInfo.name, packagedName);

  const setup = await server.call("beta_setup_status", { workflow: "renewal_conversation_brief" });
  assert.equal(setup.package_status.state, "matched");
  assert.equal(setup.connection_setup.state, "ready");
  const route = await server.call("beta_route_workflow", { intent: "renewal_conversation_brief" });
  assert.equal(route.route_label, "Renewal Conversation Brief");

  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  assert.ok(created.case_id);
  const caseId = created.case_id;
  const statePath = path.join(tempDir, "state", `${caseId}.json`);
  const queue = await server.call("beta_read_owned_cta_queue", { case_id: caseId });
  assert.equal(queue.status, "ready");
  assert.equal(queue.queue.length, 1);
  assert.equal(queue.queue[0].account_display_name, "Invented Orchard");
  const workItemRef = queue.queue[0].work_item_ref;

  const started = await server.call("beta_prepare_renewal_conversation_brief", { case_id: caseId, work_item_ref: workItemRef });
  assert.equal(started.status, "collecting");
  let evidence;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    evidence = await server.call("beta_wait_for_renewal_conversation_evidence", { case_id: caseId, renewal_conversation_run_id: started.renewal_conversation_run_id, wait_seconds: 1 });
    if (evidence.status !== "still_preparing") break;
  }
  const reviewed = await server.call("beta_get_renewal_conversation_evidence", { case_id: caseId, renewal_conversation_run_id: started.renewal_conversation_run_id });
  assert.equal(evidence.status, "evidence_ready_with_gaps", JSON.stringify({ source_gap_codes: evidence.source_gap_codes, content_readiness: evidence.content_readiness, candidate_counts: reviewed.customer_content_review?.tables?.map((table) => [table.id, table.rows?.length]), trends: reviewed.csm_evidence_display?.tables?.find((table) => table.id === "performance_trends")?.rows }));
  assert.equal(evidence.execution_receipt.statement_order.length, 18);
  assert.ok(evidence.execution_receipt.statement_order.some((item) => item.source === "historical_sla_policies"), "The separate archived-policy read must appear in the evidence receipt");
  assert.equal(evidence.execution_receipt.retry_state, "not_retried");
  // Presentation baseline: the concise markdown is the only default brief,
  // not an additional compatibility-table dump beside it.
  assert.equal("csm_evidence_display" in reviewed, false);
  assert.match(reviewed.account_brief_display.markdown, /\|/);
  assert.equal(reviewed.account_brief_display.format,"markdown_tables_and_charts");
  assert.ok(reviewed.account_brief_display.charts.length > 0);
  assert.ok(reviewed.account_brief_display.chart_requests.length > 0);
  const beforeDisplayFocus = fs.readFileSync(statePath, "utf8");
  const catalog = reviewed.account_brief_display.display_catalog;
  const focused = await server.call("beta_get_renewal_conversation_evidence", { case_id: caseId,
    renewal_conversation_run_id: started.renewal_conversation_run_id,
    display_focus: { metric_refs: [catalog.metrics.find(item => item.name === "Median first reply time").ref],
      peer_scope_refs: [catalog.peer_scopes.find(item => item.channel === "Email").ref] } });
  assert.equal(focused.isError, false, JSON.stringify(focused));
  assert.equal(focused.account_brief_display.presentation_focus.peer_scope_count, 1);
  assert.deepEqual(focused.customer_content_review, reviewed.customer_content_review, "A display focus does not select or rewrite renewal deck cards");
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeDisplayFocus);
  assert.equal(reviewed.account_brief_display.display_mode, "concise_overview");
  assert.doesNotMatch(reviewed.account_brief_display.markdown, /<\/?details>|<\/?summary>|Exact monthly values/);
  const details = await server.call("beta_get_renewal_conversation_evidence", { case_id: caseId,
    renewal_conversation_run_id: started.renewal_conversation_run_id, display_details: ["support_operations"] });
  assert.equal(details.isError, false, JSON.stringify(details));
  assert.equal(details.account_brief_display.display_mode, "requested_details");
  assert.match(details.account_brief_display.markdown, /Exact monthly values/);
  assert.deepEqual(details.customer_content_review, reviewed.customer_content_review);
  assert.deepEqual(details.account_intelligence_core, reviewed.account_intelligence_core);
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeDisplayFocus, "Full detail view must not change renewal reviews");
  const chartRequest = reviewed.account_brief_display.chart_requests[0];
  assert.equal(chartRequest.arguments.case_id, caseId);
  const nativeChart = await server.send("tools/call", { name: chartRequest.tool, arguments: chartRequest.arguments });
  assert.equal(nativeChart.result.isError, false, nativeChart.result.content.find((item) => item.type === "text")?.text);
  assert.equal(nativeChart.result.content.filter((item) => item.type === "image").length, 1);
  assert.equal(JSON.parse(nativeChart.result.content[0].text).delivery_state, "image_returned_visibility_unverified");
  const localChart = await server.send("tools/call", { name: chartRequest.tool,
    arguments: { ...chartRequest.arguments, local_file_delivery_authorized: true } });
  assert.equal(localChart.result.isError, false, localChart.result.content[0].text);
  const local = JSON.parse(localChart.result.content[0].text).local_delivery;
  assert.equal(local.method, "markdown_local_image");
  assert.equal(fs.readFileSync(local.file_path).toString("base64"), nativeChart.result.content[1].data);
  cleanupTemporaryChartDirectory(path.dirname(local.file_path), Date.parse(local.expires_at));
  assert.equal((await server.call(chartRequest.tool, { renewal_conversation_run_id: started.renewal_conversation_run_id, chart_id: chartRequest.arguments.chart_id })).code, "ACCOUNT_BRIEF_CHART_SCOPE_REQUIRED");
  assert.equal((await server.call(chartRequest.tool, { ...chartRequest.arguments, chart_id: "not-in-this-brief" })).code, "ACCOUNT_BRIEF_CHART_UNAVAILABLE");
  const metricTable = reviewed.customer_content_review.tables.find((table) => table.id === "progress_metric_candidates");
  const pairTable = reviewed.customer_content_review.tables.find((table) => table.id === "linked_opportunities_and_focus");
  assert.ok(metricTable.rows.length >= 1);
  assert.ok(pairTable.rows.length >= 1);
  const metricId = metricTable.rows[0].id;
  const pairId = pairTable.rows[0].id;

  const prematureApproval = await server.call("beta_record_renewal_conversation_approval", { case_id: caseId, gate: "identity", revision: started.revision });
  assert.equal(prematureApproval.code, "RENEWAL_EVIDENCE_DECISION_REQUIRED");

  const proposed = await server.call("beta_select_renewal_deck_content", {
    case_id: caseId, renewal_conversation_run_id: started.renewal_conversation_run_id,
    revision: started.revision, selected_metric_ids: [metricId], selected_pair_ids: [pairId],
  });
  assert.equal(proposed.status, "native_fit_required");
  assert.equal(proposed.renewal_deck_content.content_status, "native_fit_pending");
  assert.equal((await server.call("beta_record_renewal_conversation_approval", {case_id:caseId,revision:proposed.revision,gate:"identity"})).code,"RENEWAL_NATIVE_PREFLIGHT_REQUIRED");
  const nativeResult=inventedRenewalNativeLayout(proposed.native_layout_capture_request);
  const beforeNativeFit=fs.readFileSync(statePath,"utf8");
  const overflow=structuredClone(nativeResult);overflow.slides[0].subtitle_fit.heightPt=1;refreshInventedLayoutDigest(overflow);
  assert.equal((await server.call("beta_bind_renewal_native_fit",{case_id:caseId,revision:proposed.revision,renewal_conversation_run_id:started.renewal_conversation_run_id,
    native_fit_request_ref:proposed.native_fit_request_ref,native_result:overflow})).code,"CONTENT_FIT_RISK");
  assert.equal(fs.readFileSync(statePath,"utf8"),beforeNativeFit,"An unsuccessful native check cannot freeze wording or record approval");
  let selected=await server.call("beta_bind_renewal_native_fit",{case_id:caseId,revision:proposed.revision,renewal_conversation_run_id:started.renewal_conversation_run_id,
    native_fit_request_ref:proposed.native_fit_request_ref,native_result:nativeResult});
  assert.equal(selected.status, "review_ready");
  assert.deepEqual(selected.renewal_deck_content.customer_slides.map((slide) => slide.role), ["progress", "opportunities", "focus"]);
  const unchanged = await server.call("beta_revise_renewal_customer_copy", {
    case_id: caseId, renewal_conversation_run_id: started.renewal_conversation_run_id,
    revision: selected.revision,
  });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.code, "RENEWAL_CUSTOMER_COPY_UNCHANGED");
  assert.equal(unchanged.revision, selected.revision);
  const outOfOrder = await server.call("beta_record_renewal_conversation_approval", { case_id: caseId, gate: "evidence", revision: selected.revision });
  assert.equal(outOfOrder.code, "APPROVAL_ORDER_VIOLATION");
  for (const gate of ["identity", "evidence", "renewal_hypotheses", "renewal_content"]) {
    const approval = await server.call("beta_record_renewal_conversation_approval", { case_id: caseId, gate, revision: selected.revision });
    assert.ok(approval.completed_gates.includes(gate));
  }
  const recheck=await server.call("beta_revise_renewal_customer_copy",{case_id:caseId,renewal_conversation_run_id:started.renewal_conversation_run_id,revision:selected.revision,recheck_native_fit:true});
  assert.equal(recheck.status,"native_fit_required");
  assert.deepEqual(recheck.retained_review_gates,["identity","evidence","renewal_hypotheses"]);
  assert.deepEqual(recheck.renewal_deck_content.selected_metric_ids,selected.renewal_deck_content.selected_metric_ids);
  assert.deepEqual(recheck.renewal_deck_content.selected_pair_ids,selected.renewal_deck_content.selected_pair_ids);
  assert.equal((await server.call("beta_render_renewal_conversation_brief",{case_id:caseId,revision:recheck.revision,private_draft_authorized:true})).code,"REVIEW_INCOMPLETE");
  assert.equal((await server.call("beta_bind_renewal_native_fit",{case_id:caseId,revision:recheck.revision,renewal_conversation_run_id:started.renewal_conversation_run_id,
    native_fit_request_ref:recheck.native_fit_request_ref,native_result:nativeResult})).code,"RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH");
  selected=await server.call("beta_bind_renewal_native_fit",{case_id:caseId,revision:recheck.revision,renewal_conversation_run_id:started.renewal_conversation_run_id,
    native_fit_request_ref:recheck.native_fit_request_ref,native_result:inventedRenewalNativeLayout(recheck.native_layout_capture_request)});
  assert.equal(selected.status,"review_ready");
  const wording=await server.call("beta_record_renewal_conversation_approval",{case_id:caseId,revision:selected.revision,gate:"renewal_content"});
  assert.deepEqual(wording.completed_gates,["identity","evidence","renewal_hypotheses","renewal_content"]);
  const unauthorized = await server.call("beta_render_renewal_conversation_brief", { case_id: caseId, revision: selected.revision, private_draft_authorized: false });
  assert.equal(unauthorized.code, "DRAFT_NOT_AUTHORIZED");
  const draft = await server.call("beta_render_renewal_conversation_brief", { case_id: caseId, revision: selected.revision, private_draft_authorized: true });
  assert.equal(draft.status, "manual_action_required");
  assert.equal(draft.customer_shared, false);
  assert.equal(draft.private_draft, undefined);
  const request = JSON.parse(draft.manual_render_request);
  assert.equal(request.bridgeInput.output.private_draft_only, true);
  assert.equal(request.bridgeInput.nativeFitReceipt.contract,"renewal-native-preflight-v1");
  assert.equal(request.bridgeInput.nativeFitReceipt.reviewed_revision,selected.revision);
  assert.deepEqual(request.bridgeInput.reviewPackage.customer_slides.map((slide) => slide.role), ["progress", "opportunities", "focus"]);
  const missingReview = await server.call("beta_complete_renewal_conversation", {
    case_id: caseId, renewal_conversation_run_id: started.renewal_conversation_run_id,
    outcome: "draft_created", revision: selected.revision, draft_receipt_ref: draft.draft_receipt_ref,
  });
  assert.equal(missingReview.code, "RENEWAL_RENDERED_REVIEW_REQUIRED");
  // Restart destroys every evidence map. Completion must depend only on the
  // minimal authorized handoff and explicit CSM confirmation, never raw copy.
  server.child.kill();
  const restarted = startServer(tempDir, controls);
  t.after(() => { restarted.child.stdin.end(); restarted.child.kill(); });
  await restarted.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const expiredRender = await restarted.call("beta_render_renewal_conversation_brief", { case_id: caseId, revision: selected.revision, private_draft_authorized: true });
  assert.equal(expiredRender.code, "RENEWAL_REVIEW_RUN_EXPIRED");
  assert.equal((await restarted.call("beta_get_account_brief_chart", { ...chartRequest.arguments, local_file_delivery_authorized: true })).code, "RENEWAL_EVIDENCE_RUN_EXPIRED");
  const completionArgs = {
    case_id: caseId, renewal_conversation_run_id: started.renewal_conversation_run_id,
    outcome: "draft_created", revision: selected.revision, draft_receipt_ref: draft.draft_receipt_ref,
    private_draft_created_confirmed: true, rendered_draft_reviewed: true,
  };
  const closed = await restarted.call("beta_complete_renewal_conversation", completionArgs);
  assert.equal(closed.status, "draft_created");
  assert.equal(closed.completion_basis, "csm_confirmed_created_and_rendered_reviewed");
  assert.equal((await restarted.call("beta_complete_renewal_conversation", completionArgs)).already_completed, true);
  assert.doesNotMatch(fs.readFileSync(path.join(tempDir, "state", `${caseId}.json`), "utf8"), /Invented Orchard/);
});

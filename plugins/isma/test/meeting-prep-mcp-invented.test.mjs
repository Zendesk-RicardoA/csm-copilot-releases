import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createApprovedRecoveryDesign, DIRECT_ROLES, IMMUTABLE_ROLES, PHASE_VARIANTS, REQUIRED_FIELDS, SUPPORTING_METRIC_VARIANTS } from "../mcp/approved-recovery-design.mjs";
import { RECOMMENDATION_REVIEW_SECTIONS } from "../mcp/core.mjs";
import { meetingPrepDraftEvidenceRefs } from "../mcp/meeting-prep-draft-binding.mjs";
import { accountBriefChartInlineImage } from "../mcp/account-brief-chart-delivery.mjs";
import { cleanupTemporaryChartDirectory } from "../mcp/account-brief-chart-files.mjs";
import { inventedMeetingPrepDraft, INVENTED_MASTER_INVENTORY, omitInventedLibrary, addInventedNarrative } from "./fixtures/meeting-prep-draft-input.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureLoader = new URL("./fixtures/meeting-synthetic-loader.mjs", import.meta.url);

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

function makeRuntime(tempDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "config", "approved-version-manifest.json"), "utf8"));
  // Only this disposable invented-data fixture gets a fresh test lifetime.
  manifest.expires_at = new Date(Date.now() + 3_600_000).toISOString();
  // Only this isolated test process sees simulated approval and an invented reader.
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
  const manifestPath = path.join(tempDir, "synthetic-manifest.json");
  const runtimePath = path.join(tempDir, "synthetic-runtime.json");
  writeJson(manifestPath, manifest);
  writeJson(runtimePath, {
    mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_company_sso", subject: "invented-meeting-tester" },
    snowflake: { state: "connected", read_only_verified: true },
    organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true,
      private_draft_google_scope: true, approved_renderer_execution: true,
      retention_policy: true, operational_support: true,
    },
  });
  return { manifestPath, runtimePath };
}

function startServer(tempDir, runtime, { mode = "ready", namespace = `csm-invented-meeting-${randomBytes(5).toString("hex")}` } = {}) {
  const child = spawn(process.execPath, [
    "--experimental-loader", pathToFileURL(fileURLToPath(fixtureLoader)).href,
    path.join(pluginRoot, "mcp", "server.mjs"),
  ], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      PLUGIN_DATA: path.join(tempDir, "state"),
      CSM_COPILOT_BETA_STATE_NAMESPACE: namespace,
      CSM_COPILOT_BETA_MANIFEST_PATH: runtime.manifestPath,
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: runtime.runtimePath,
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true",
      CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
      CSM_SYNTHETIC_MEETING_MODE: mode,
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
  return { child, send, call, namespace };
}

async function awaitResult(server, startTool, continueTool, startArgs, refName) {
  const started = await server.call(startTool, startArgs);
  if (["ready", "partial"].includes(started.status)) return started;
  assert.equal(started.status, "in_progress", JSON.stringify(started));
  let result;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    result = await server.call(continueTool, { [refName]: started[refName], wait_seconds: 0 });
    if (result.status !== "in_progress") return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${continueTool} did not complete: ${JSON.stringify(result)}`);
}

function syntheticDesignContract() {
  const roles = {};
  const slides = {};
  let sequence = 0;
  const add = (role, fields) => {
    const nativeSlideId = `invented-source-${++sequence}`;
    slides[nativeSlideId] = { contentFingerprint: `sha256:${"a".repeat(64)}`, fields };
    return { nativeSlideId };
  };
  const fieldsFor = (role) => {
    const fields = Object.fromEntries((REQUIRED_FIELDS[role] || []).map((field) => [field, { renderer: "text" }]));
    if (role === "volume_trend") fields.volume_trend_series = { renderer: "series" };
    if (role === "speed_quality_trend") {
      fields.frt_series = { renderer: "series" };
      fields.csat_series = { renderer: "series" };
    }
    return fields;
  };
  DIRECT_ROLES.forEach((role) => { roles[role] = add(role, IMMUTABLE_ROLES.has(role) ? {} : fieldsFor(role)); });
  roles.phase_detail = { variants: {} };
  PHASE_VARIANTS.forEach((variant) => { roles.phase_detail.variants[variant] = add(`phase_detail.${variant}`, fieldsFor("phase_detail")); });
  roles.supporting_metric = { variants: {} };
  SUPPORTING_METRIC_VARIANTS.forEach((variant) => { roles.supporting_metric.variants[variant] = add(`supporting_metric.${variant}`, fieldsFor("supporting_metric")); });
  return createApprovedRecoveryDesign({
    recoveryFamily: "journey-b-approved-design-v3", strictFieldCoverage: true,
    contentFingerprint: `sha256:${"f".repeat(64)}`, roles, slides,
  });
}

function registerCleanup(t, tempDir, server) {
  t.after(() => {
    server.child.stdin.end();
    server.child.kill();
    const isolatedConfig = path.join(os.homedir(), ".codex", server.namespace);
    assert.match(server.namespace, /^csm-invented-meeting-[a-f0-9]{10}$/);
    fs.rmSync(isolatedConfig, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

async function selectInventedCall(server) {
  const lookup = await awaitResult(server, "beta_start_meeting_prep_call_candidates_in_range", "beta_continue_meeting_prep_call_lookup", {
    account_name: "Invented Orchard", start_date: "2026-08-01", end_date: "2026-08-31",
  }, "call_lookup_ref");
  assert.equal(lookup.status, "call_selection_required", JSON.stringify(lookup));
  assert.equal(lookup.candidates.length, 1);
  assert.doesNotMatch(JSON.stringify(lookup), /invented_meeting_call_123/);
  return lookup.candidates[0].call_selection_ref;
}

async function selectInventedConvergeCall(server) {
  const lookup = await awaitResult(server, "beta_start_converge_call_lookup", "beta_continue_meeting_prep_call_lookup", {
    account_name: "Invented Orchard", start_date: "2026-08-01", end_date: "2026-08-31",
  }, "call_lookup_ref");
  assert.equal(lookup.status, "converge_lookup_required", JSON.stringify(lookup));
  assert.equal(lookup.native_request.tool, "list_customer_calls");
  assert.equal(lookup.native_request.arguments.identifier, "001000000000000AAA");
  // Invented native response only. No live Converge or Snowflake connection exists.
  const result = await server.call("beta_accept_converge_call_candidates", {
    converge_lookup_ref: lookup.converge_lookup_ref, truncated: false,
    calls: [{ conversation_key: "opaque:invented/converge/key", call_start_datetime: "2026-08-11T09:30:00Z", summary: "Invented routing review" }],
  });
  assert.equal(result.status, "call_selection_required", JSON.stringify(result));
  return result.candidates[0].call_selection_ref;
}

async function confirmInventedPrivateSetup(server) {
  const master = await server.call("beta_confirm_personal_master", { private_master_confirmed: true });
  assert.equal(master.status, "ready");
  const renderer = await server.call("beta_confirm_manual_renderer_ready", { renderer_opened: true, google_authorization_completed: true });
  assert.equal(renderer.status, "ready");
}

for (const scenario of ["baseline", "flexible_replacement", "no_library"]) {
test(`invented Converge meeting prep (${scenario}) reaches reviewed evidence and a private draft request without the legacy transcript screen`, { timeout: 40_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-meeting-mcp-invented-"));
  const server = startServer(tempDir, makeRuntime(tempDir), { mode: "converge_only" });
  registerCleanup(t, tempDir, server);
  const initialized = await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const packagedName = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).name;
  assert.equal(initialized.result.serverInfo.name, packagedName);
  const setup = await server.call("beta_setup_status", { workflow: "meeting_prep", preparation_mode: "selected_call" });
  assert.equal(setup.package_status.state, "matched");
  assert.equal(setup.connection_setup.state, "action_required");
  await confirmInventedPrivateSetup(server);
  const ready = await server.call("beta_setup_status", { workflow: "meeting_prep", preparation_mode: "selected_call" });
  assert.equal(ready.connection_setup.state, "ready");
  const route = await server.call("beta_route_workflow", { intent: "meeting_preparation" });
  assert.equal(route.route_label, "Customer Planning and Meeting Prep");

  const selectionRef = await selectInventedConvergeCall(server);
  const created = await server.call("beta_create_meeting_prep_case_from_call_selection", { call_selection_ref: selectionRef, language: "en" });
  assert.ok(created.case_id, JSON.stringify(created));
  assert.equal(created.account_intelligence_core, null);
  const caseId = created.case_id;

  const standaloneBrief = await awaitResult(server, "beta_start_meeting_prep_account_brief", "beta_continue_meeting_prep_account_brief", { account_name: "Invented Orchard" }, "account_brief_ref");
  assert.equal(standaloneBrief.status, "partial", JSON.stringify(standaloneBrief));
  // The default response carries the concise display and its receipt, not the
  // raw evidence object that previously tempted a duplicate prose dump.
  assert.equal("account_brief" in standaloneBrief, false);
  assert.match(standaloneBrief.account_brief_display.markdown, /Data limits/);
  assert.match(standaloneBrief.account_brief_display.markdown, /Product \| Value/);
  assert.equal(standaloneBrief.account_brief_display.section_order.length, 12);
  assert.equal(standaloneBrief.account_intelligence_receipt.contract, "AccountIntelligenceCoreV1");

  const statePath = path.join(tempDir, "state", `${caseId}.json`);
  const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const wrongAccount = { ...saved, account_ref_digest: "f".repeat(64) };
  fs.writeFileSync(statePath, JSON.stringify(wrongAccount));
  const mismatch = await server.call("beta_continue_meeting_prep_account_brief", { account_brief_ref: standaloneBrief.account_brief_ref, case_id: caseId, wait_seconds: 0 });
  assert.equal(mismatch.code, "CROSS_JOURNEY_ACCOUNT_MISMATCH");
  fs.writeFileSync(statePath, JSON.stringify({ ...saved, package_version: "invented-older-package" }));
  const stale = await server.call("beta_continue_meeting_prep_account_brief", { account_brief_ref: standaloneBrief.account_brief_ref, case_id: caseId, wait_seconds: 0 });
  assert.equal(stale.code, "CASE_VERSION_MISMATCH");
  fs.writeFileSync(statePath, JSON.stringify(saved));
  const beforeBadInitialFocus = fs.readFileSync(statePath, "utf8");
  const badInitialFocus = await server.call("beta_continue_meeting_prep_account_brief", { account_brief_ref: standaloneBrief.account_brief_ref,
    case_id: caseId, wait_seconds: 0, display_focus: { peer_scope_refs: ["peer:" + "0".repeat(24)] } });
  assert.equal(badInitialFocus.code, "ACCOUNT_BRIEF_DISPLAY_FOCUS_INVALID");
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeBadInitialFocus, "Bad selectors must fail before attaching evidence or revising the case");
  const badInitialDetails = await server.call("beta_continue_meeting_prep_account_brief", { account_brief_ref: standaloneBrief.account_brief_ref,
    case_id: caseId, wait_seconds: 0, display_details: ["invented_unknown_section"] });
  assert.equal(badInitialDetails.code, "ACCOUNT_BRIEF_DISPLAY_DETAILS_INVALID");
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeBadInitialFocus, "Invalid details must not bind evidence first");
  const lateBound = await server.call("beta_continue_meeting_prep_account_brief", { account_brief_ref: standaloneBrief.account_brief_ref, case_id: caseId, wait_seconds: 0 });
  assert.equal(lateBound.status, "partial");
  assert.equal(lateBound.case_status.account_intelligence_core.brief_state, "partial");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).account_intelligence_core.content_digest, standaloneBrief.account_intelligence_receipt.content_digest, "The finished standalone receipt binds after case creation without another source read");
  const caseBrief = await awaitResult(server, "beta_start_meeting_prep_account_brief", "beta_continue_meeting_prep_account_brief", { case_id: caseId }, "account_brief_ref");
  assert.equal(caseBrief.status, "partial");
  assert.equal(caseBrief.reused_fresh_read, true);
  assert.ok(caseBrief.performance_slide_proposals.some((item) => item.available && item.evidence === "baseline"));
  assert.ok(caseBrief.case_status.account_intelligence_core, "A partial brief must bind to the current case without being labelled complete");
  assert.equal(caseBrief.case_status.account_intelligence_core.brief_state, "partial");
  assert.equal(caseBrief.account_intelligence_receipt.account_ref_digest, standaloneBrief.account_intelligence_receipt.account_ref_digest);
  assert.equal(caseBrief.case_call_context.state, "selected_pending");
  assert.match(caseBrief.account_brief_display.markdown, /A call is selected and authorized/);
  assert.doesNotMatch(caseBrief.account_brief_display.markdown, /A selected and authorized call or reviewed CSM notes is required/);
  assert.ok(caseBrief.account_brief_display.chart_requests.length > 0);
  assert.equal(caseBrief.account_brief_display.chart_delivery_method, "temporary_local_markdown_if_authorized");
  const cachedBriefResponse = await server.send("tools/call", { name: "beta_continue_meeting_prep_account_brief",
    arguments: { account_brief_ref: standaloneBrief.account_brief_ref, case_id: caseId, wait_seconds: 0 } });
  assert.equal(cachedBriefResponse.result.isError, false);
  assert.equal(cachedBriefResponse.result.content.filter((item) => item.type === "image").length, 0,
    "The brief must issue chart requests, not duplicate hidden PNGs that can be mistaken for visible delivery");
  for (const request of caseBrief.account_brief_display.chart_requests) {
    const response = await server.send("tools/call", { name: request.tool, arguments: request.arguments });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.content.filter((item) => item.type === "image").length, 1);
    const nativeImage = response.result.content.find((item) => item.type === "image");
    assert.equal(Buffer.from(nativeImage.data, "base64").subarray(1, 4).toString(), "PNG");
    assert.equal(JSON.parse(response.result.content[0].text).delivery_state, "image_returned_visibility_unverified");
    const delivery = accountBriefChartInlineImage(response.result);
    assert.equal(delivery.image_url, `data:image/png;base64,${nativeImage.data}`);
    assert.match(delivery.output_hint, /Exact monthly values/);
  }
  const chartScope = caseBrief.account_brief_display.chart_requests[0].arguments;
  const fileResponse = await server.send("tools/call", { name: "beta_get_account_brief_chart",
    arguments: { ...chartScope, case_id: caseId, local_file_delivery_authorized: true } });
  assert.equal(fileResponse.result.isError, false);
  const fileDelivery = JSON.parse(fileResponse.result.content[0].text).local_delivery;
  assert.equal(fileDelivery.method, "markdown_local_image");
  assert.match(fileDelivery.markdown, /!\[.*\]\(\/.*\.png\)/);
  assert.equal(fs.readFileSync(fileDelivery.file_path).toString("base64"), fileResponse.result.content[1].data);
  assert.ok(!fileDelivery.file_path.startsWith(pluginRoot));
  assert.equal(fs.statSync(fileDelivery.file_path).mode & 0o777, 0o600);
  cleanupTemporaryChartDirectory(path.dirname(fileDelivery.file_path), Date.parse(fileDelivery.expires_at));
  assert.equal(fs.existsSync(fileDelivery.file_path), false);
  fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), tester_id: "other-invented-owner" }));
  assert.equal((await server.call("beta_get_account_brief_chart", { ...chartScope, case_id: caseId, local_file_delivery_authorized: true })).code, "CASE_OWNER_MISMATCH");
  fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), tester_id: saved.tester_id }));

  const blockedBeforeEvidence = await server.call("beta_record_approval", { case_id: caseId, gate: "evidence", revision: created.revision });
  assert.equal(blockedBeforeEvidence.code, "APPROVAL_ORDER_VIOLATION");
  const wrongReader = await server.call("beta_start_selected_call_evidence", {
    case_id: caseId, revision: created.revision, transcript_processing_authorized: true,
    no_service_data: true, no_sensitive_personal_data: false, no_suspected_l5: true,
  });
  assert.equal(wrongReader.code, "CONVERGE_NATIVE_READ_REQUIRED");
  const callRead = await server.call("beta_get_selected_converge_call_request", { case_id: caseId });
  assert.equal(callRead.native_request.tool, "get_customer_call");
  assert.equal(callRead.native_request.arguments.conversation_key, "opaque:invented/converge/key");
  const repeatedRequest = await server.call("beta_get_selected_converge_call_request", { case_id: caseId });
  assert.equal(repeatedRequest.status, "read_request_already_issued");
  assert.equal(repeatedRequest.call_read_ref, callRead.call_read_ref);
  assert.equal(repeatedRequest.native_request, undefined);
  const inventedNativeDetail = { transcript: "Invented team wants clearer ticket routing and shorter handling time.",
    linked_accounts: ["001000000000000AAA", "001000000000001AAA"] };
  const findings = [{ category: "pain_point", paraphrase: "Some ticket categories need clearer routing.", topic: "Routing", confidence: "medium" },
    { category: "goal", paraphrase: "The team wants shorter handling time.", topic: "Goals", confidence: "medium" }];
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const selectedEvidence = await server.call("beta_bind_converge_call_evidence", {
    case_id: caseId, revision: caseBrief.case_status.revision, call_read_ref: callRead.call_read_ref,
    source_status: "transcript_available", linked_account_ids: inventedNativeDetail.linked_accounts,
    source_result_digest: digest(inventedNativeDetail), evidence_digest: digest(findings), finding_count: findings.length,
  });
  assert.equal(selectedEvidence.status, "evidence_bound", JSON.stringify(selectedEvidence));
  assert.equal(selectedEvidence.receipt.finding_count, 2);
  assert.ok(JSON.parse(fs.readFileSync(path.join(tempDir, "state", `${caseId}.json`), "utf8")).derived_evidence);
  assert.doesNotMatch(JSON.stringify(selectedEvidence), /opaque:invented\/converge\/key|Invented team wants/);
  const noRepeatedRead = await server.call("beta_get_selected_converge_call_request", { case_id: caseId });
  assert.equal(noRepeatedRead.status, "evidence_already_bound");
  assert.equal(noRepeatedRead.native_request, undefined);
  const displayedAfterBinding = await server.call("beta_start_meeting_prep_account_brief", { case_id: caseId });
  assert.equal(displayedAfterBinding.reused_fresh_read, true);
  assert.equal(displayedAfterBinding.case_call_context.state, "available");
  assert.equal(displayedAfterBinding.case_call_context.finding_count, 2);
  assert.match(displayedAfterBinding.account_brief_display.markdown, /Selected-call findings are available for review/);
  assert.doesNotMatch(displayedAfterBinding.account_brief_display.markdown, /A selected and authorized call or reviewed CSM notes is required/);
  assert.equal(displayedAfterBinding.account_intelligence_receipt.content_digest, standaloneBrief.account_intelligence_receipt.content_digest);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).approvals, [], "Binding/displaying evidence never records human approval");
  const beforeFocus = fs.readFileSync(statePath, "utf8");
  const catalog = displayedAfterBinding.account_brief_display.display_catalog;
  assert.equal(catalog.peer_scopes.length, 2);
  const focusedBrief = await server.call("beta_continue_meeting_prep_account_brief", {
    account_brief_ref: standaloneBrief.account_brief_ref, wait_seconds: 0,
    display_focus: { metric_refs: [catalog.metrics.find(item => item.name === "Median first reply time").ref],
      peer_scope_refs: [catalog.peer_scopes.find(item => item.channel === "Email").ref] },
  });
  assert.equal(focusedBrief.isError, false, JSON.stringify(focusedBrief));
  assert.equal(focusedBrief.case_call_context.state, "available", "A cached focus retains its case overlay even without repeating case_id");
  assert.equal(focusedBrief.account_brief_display.presentation_focus.peer_scope_count, 1);
  assert.equal(focusedBrief.account_intelligence_receipt.content_digest, standaloneBrief.account_intelligence_receipt.content_digest);
  assert.equal(focusedBrief.source_elapsed_ms, standaloneBrief.source_elapsed_ms, "Focusing the display must not restart source reads");
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeFocus, "Display focus never changes evidence, revision or approvals");
  const details = await server.call("beta_continue_meeting_prep_account_brief", {
    account_brief_ref: standaloneBrief.account_brief_ref, wait_seconds: 0,
    display_details: ["support_operations", "recent_conversations"],
  });
  assert.equal(details.isError, false, JSON.stringify(details));
  assert.equal(details.account_brief_display.display_mode, "requested_details");
  assert.match(details.account_brief_display.markdown, /Exact monthly values|Metric definitions/);
  assert.doesNotMatch(details.account_brief_display.markdown, /<\/?details>|<\/?summary>/);
  assert.equal("account_brief" in details, false);
  assert.deepEqual(details.account_intelligence_receipt, standaloneBrief.account_intelligence_receipt);
  assert.equal(details.source_elapsed_ms, standaloneBrief.source_elapsed_ms);
  assert.equal(details.case_call_context.state, "available");
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeFocus, "Detail requests must not change gates or case state");
  const badFocus = await server.call("beta_continue_meeting_prep_account_brief", {
    account_brief_ref: standaloneBrief.account_brief_ref, wait_seconds: 0, display_focus: { peer_scope_refs: ["peer:" + "0".repeat(24)] },
  });
  assert.equal(badFocus.code, "ACCOUNT_BRIEF_DISPLAY_FOCUS_INVALID");
  assert.equal(fs.readFileSync(statePath, "utf8"), beforeFocus);
  let revision = selectedEvidence.case_status.revision;
  const identity = await server.call("beta_record_approval", { case_id: caseId, gate: "identity", revision });
  assert.equal(identity.isError, false, JSON.stringify(identity));
  const evidence = await server.call("beta_record_approval", { case_id: caseId, gate: "evidence", revision });
  assert.equal(evidence.isError, false, JSON.stringify(evidence));
  const prematureRecommendation = await server.call("beta_record_approval", { case_id: caseId, gate: "recommendations", revision });
  assert.equal(prematureRecommendation.code, "RECOMMENDATION_REVIEW_PACKAGE_REQUIRED");
  const review = await server.call("beta_bind_recommendation_review_package", {
    case_id: caseId, revision, review_package_digest: "f".repeat(64), sections: RECOMMENDATION_REVIEW_SECTIONS,
    recommendation_refs: [1, 2, 3, 4].map((n) => `recommendation:${n}`),
  });
  assert.equal(review.isError, false, JSON.stringify(review));
  const recommendationsApproved = await server.call("beta_record_approval", { case_id: caseId, gate: "recommendations", revision });
  assert.equal(recommendationsApproved.isError, false, JSON.stringify(recommendationsApproved));
  const notFrozen = await server.call("beta_record_approval", { case_id: caseId, gate: "customer_content", revision });
  assert.equal(notFrozen.code, "DRAFT_REVIEW_REQUIRED");
  const beforeDraft = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const bridgeInput = inventedMeetingPrepDraft(beforeDraft);
  // Host supplies facts and copy, not approvals the control must issue.
  delete bridgeInput.outputReadiness; delete bridgeInput.assemblyAuthorization;
  delete bridgeInput.customerContent.approval; bridgeInput.customerContent.status = "draft";
  delete bridgeInput.slideSelectionReview.deckInputReview; delete bridgeInput.slideSelectionReview.assemblyEligible;
  bridgeInput.slideSelectionReview.proposals.forEach((proposal) => { delete proposal.review; });
  const missingPreflight = await server.call("beta_prepare_meeting_prep_draft_review", { case_id: caseId, revision, bridge_input: bridgeInput,
    master_inventory: INVENTED_MASTER_INVENTORY });
  assert.equal(missingPreflight.code, "MEETING_PREP_MASTER_PREFLIGHT_REQUIRED");
  const badReceipt = await server.call("beta_bind_meeting_prep_master_preflight", { case_id: caseId, revision,
    master_inventory: { ...INVENTED_MASTER_INVENTORY, renderer_components: null } });
  assert.equal(badReceipt.code, "MEETING_PREP_MASTER_RECEIPT_REQUIRED");
  const verifiedMaster = await server.call("beta_bind_meeting_prep_master_preflight", { case_id: caseId, revision,
    master_inventory: INVENTED_MASTER_INVENTORY });
  assert.equal(verifiedMaster.status, "renderer_verified", JSON.stringify(verifiedMaster));
  const badMaster = await server.call("beta_prepare_meeting_prep_draft_review", { case_id: caseId, revision, bridge_input: bridgeInput,
    master_inventory: { ...INVENTED_MASTER_INVENTORY, slide_count: 20 } });
  assert.equal(badMaster.code, "MEETING_PREP_MASTER_INVENTORY_INVALID");
  let frozen = await server.call("beta_prepare_meeting_prep_draft_review", { case_id: caseId, revision, bridge_input: bridgeInput, master_inventory: INVENTED_MASTER_INVENTORY });
  assert.equal(frozen.status, "review_ready", JSON.stringify(frozen));
  assert.equal(frozen.slide_order.length, 17);
  assert.deepEqual(frozen.review_request.decisions.map(item => item.gate), ["customer_content", "maintained_slides"]);
  assert.equal(frozen.review_request.suggested_reply, "Approve the customer wording and slide choices.");
  for (const gate of ["customer_content", "maintained_slides"]) {
    const approval = await server.call("beta_record_approval", { case_id: caseId, gate, revision });
    assert.equal(approval.isError, false, JSON.stringify(approval));
  }
  const alreadyReviewed = await server.call("beta_prepare_meeting_prep_draft_review", { case_id: caseId, revision, bridge_input: bridgeInput, master_inventory: INVENTED_MASTER_INVENTORY });
  assert.deepEqual(alreadyReviewed.review_request.decisions, []);
  assert.equal(alreadyReviewed.review_request.suggested_reply, null);
  assert.equal(alreadyReviewed.review_request.separate_draft_authorization_required, true);

  if (scenario !== "baseline") {
    omitInventedLibrary(bridgeInput, 2); const narrative = addInventedNarrative(bridgeInput, 2);
    if (scenario === "no_library") {
      for (const order of [1, 3, 4]) omitInventedLibrary(bridgeInput, order);
      addInventedNarrative(bridgeInput, 2, "resolution");
    }
    const changed = await server.call("beta_render_private_draft", { case_id: caseId, revision, private_draft_authorized: true, bridge_input: bridgeInput });
    assert.equal(changed.code, "APPROVED_DRAFT_CHANGED");
    frozen = await server.call("beta_prepare_meeting_prep_draft_review", { case_id: caseId, revision, bridge_input: bridgeInput, master_inventory: INVENTED_MASTER_INVENTORY });
    assert.equal(frozen.status, "review_ready", JSON.stringify(frozen));
    assert.equal(frozen.case_status.revision, revision + 1); revision = frozen.case_status.revision;
    assert.deepEqual(frozen.case_status.completed_gates, ["identity", "evidence", "recommendations"]);
    assert.ok(frozen.slide_order.includes("zendesk_enabler:phase_2:1"));
    assert.equal(frozen.slide_order.includes("maintained_product:phase_2"), false);
    if (scenario === "no_library") {
      assert.equal(frozen.slide_order.some(role => role.startsWith("maintained_product:")), false);
      assert.ok(frozen.slide_order.includes("zendesk_enabler:phase_2:2"));
      assert.equal(frozen.slide_order.length, 15);
    }
    assert.equal(frozen.slide_content_review.phase_slide_plan["phase:2"].generatedModules[0].fields.investigation_focus, narrative.fields.investigation_focus);
    for (const gate of ["customer_content", "maintained_slides"]) {
      assert.equal((await server.call("beta_record_approval", { case_id: caseId, gate, revision })).isError, false);
    }
    assert.equal((await server.call("beta_get_selected_converge_call_request", { case_id: caseId })).status, "evidence_already_bound");
  }

  const state = JSON.parse(fs.readFileSync(path.join(tempDir, "state", `${caseId}.json`), "utf8"));
  assert.deepEqual(state.approvals.map((item) => item.gate), ["identity", "evidence", "recommendations", "customer_content", "maintained_slides"]);
  const workflow = await server.call("beta_workflow_status", { case_id: caseId });
  assert.deepEqual(workflow.workflows.meeting_prep.completed_gates, state.approvals.map((item) => item.gate));
  assert.equal(workflow.workflows.meeting_prep.next_gate, "rendered_output");
  const unauthorized = await server.call("beta_render_private_draft", { case_id: caseId, revision, private_draft_authorized: false, bridge_input: bridgeInput });
  assert.equal(unauthorized.code, "DRAFT_NOT_AUTHORIZED");
  const noDesign = await server.call("beta_render_private_draft", { case_id: caseId, revision, private_draft_authorized: true, bridge_input: bridgeInput });
  assert.equal(noDesign.code, "APPROVED_DESIGN_CONTRACT_REQUIRED");
  const approvedDesign = await server.call("beta_approve_recovery_design", { owner_approval_confirmed: true, approved_design_contract: syntheticDesignContract() });
  assert.equal(approvedDesign.status, "approved_design_recorded");
  const draft = await server.call("beta_render_private_draft", { case_id: caseId, revision, private_draft_authorized: true, bridge_input: bridgeInput });
  assert.equal(draft.status, "manual_action_required", JSON.stringify(draft));
  assert.equal(draft.customer_shared, false);
  assert.equal(draft.private_draft, undefined);
  const envelope = JSON.parse(draft.manual_render_request);
  assert.equal(envelope.schemaVersion, "1.1");
  assert.equal(envelope.requiredRendererContract, "phase-story-v2");
  assert.equal(envelope.bridgeInput.reviewedCaseEvidence.case_id, caseId);
  assert.equal(envelope.bridgeInput.reviewedCaseEvidence.account_brief_digest, state.account_intelligence_core.content_digest);
  assert.equal(envelope.bridgeInput.reviewedCaseEvidence.selected_call_evidence_digest, state.derived_evidence.digest);
  assert.equal(envelope.bridgeInput.templateBinding.bindingMode, "capture_active_private_master");
  assert.equal(envelope.bridgeInput.outputReadiness.readinessStatus, "customer_plan_ready");
  assert.equal(envelope.bridgeInput.customerContent.approval.decision,"approved");
  assert.equal(draft.delivery_status,"not_delivered");
  assert.equal(draft.render_request_digest, createHash("sha256").update(draft.manual_render_request).digest("hex"));
  const repeatedHandoff = await server.call("beta_render_private_draft", { case_id: caseId, revision, private_draft_authorized: true, bridge_input: bridgeInput });
  assert.equal(repeatedHandoff.render_request_digest,draft.render_request_digest,"Retry the same authorized handoff without changing its idempotency key or authorization timestamp");
  if (process.env.CSM_SOURCE_COMPILER_ACCEPTANCE === "true") {
    const helper = new URL("../../../apps-script/deck-assembler/test/helpers/invented-meeting-compiler.mjs", import.meta.url);
    assert.ok(fs.existsSync(fileURLToPath(helper)), "Source compiler gate requires the repository assembler; it cannot silently skip.");
    const { verifyExactInventedEnvelope } = await import(helper.href);
    assert.equal(verifyExactInventedEnvelope(envelope, frozen.slide_order).slideCount,frozen.slide_order.length);
  }
  const handoffNotRendered = await server.call("beta_record_approval", { case_id: caseId, revision, gate: "rendered_output" });
  assert.equal(handoffNotRendered.code, "PRIVATE_DRAFT_REQUIRED");
  // Simulated native output and human review: this creates no real Slides file.
  const artifact = await server.call("beta_bind_private_artifact", { case_id: caseId, artifact_ref_digest: "a".repeat(64), audit_ref_digest: "b".repeat(64) });
  assert.equal(artifact.isError, false, JSON.stringify(artifact));
  const rendered = await server.call("beta_record_approval", { case_id: caseId, revision, gate: "rendered_output" });
  assert.equal(rendered.status, "approved", JSON.stringify(rendered));
  const reopened = await server.call("beta_reopen_meeting_prep_recommendation_review", { case_id: caseId, revision, revision_requested_by_csm: true });
  assert.equal(reopened.status, "recommendation_review_required");
  assert.deepEqual(reopened.case_status.completed_gates, ["identity", "evidence"]);
  assert.equal(reopened.case_status.account_intelligence_core.bound, true);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).account_intelligence_core.content_digest, state.account_intelligence_core.content_digest);
  assert.equal(reopened.case_status.derived_evidence_bound, true);
  assert.doesNotMatch(fs.readFileSync(path.join(tempDir, "state", `${caseId}.json`), "utf8"), /Invented Orchard|opaque:invented\/converge\/key|Invented team wants|001000000000000AAA/);
  assert.equal(state.derived_evidence.source_receipt.provider, "Converge");
  assert.equal(state.transcript_eligibility.service_data_absent, undefined);
  server.child.kill();
  const restartedServer = startServer(tempDir, makeRuntime(tempDir), { mode: "converge_only", namespace: server.namespace });
  t.after(() => { restartedServer.child.stdin.end(); restartedServer.child.kill(); });
  await restartedServer.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const restartedBrief = await awaitResult(restartedServer, "beta_start_meeting_prep_account_brief", "beta_continue_meeting_prep_account_brief", { case_id: caseId }, "account_brief_ref");
  assert.equal(restartedBrief.case_call_context.state, "unavailable");
  assert.match(restartedBrief.account_brief_display.markdown, /receipt cannot restore expired findings/);
  assert.doesNotMatch(restartedBrief.account_brief_display.markdown, /paraphrased findings are bound to this case/);
  assert.equal((await restartedServer.call("beta_get_account_brief_chart", chartScope)).code, "MEETING_PREP_BRIEF_UNAVAILABLE");
});
}

for (const mode of ["restricted", "account_mismatch"]) {
  test(`legacy SQL selection is rejected before case creation on ${mode}`, { timeout: 20_000 }, async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-meeting-mcp-invented-"));
    const server = startServer(tempDir, makeRuntime(tempDir), { mode });
    registerCleanup(t, tempDir, server);
    await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    await confirmInventedPrivateSetup(server);
    const selectionRef = await selectInventedCall(server);
    const created = await server.call("beta_create_meeting_prep_case_from_call_selection", { call_selection_ref: selectionRef, language: "en" });
    assert.equal(created.code, "CONVERGE_SELECTION_REQUIRED");
    assert.equal(created.case_id, undefined);
  });
}

test("an invented 31-day Gong timeout is a named source gap, not no calls", { timeout: 20_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-meeting-mcp-invented-"));
  const server = startServer(tempDir, makeRuntime(tempDir), { mode: "gong_timeout" });
  registerCleanup(t, tempDir, server);
  await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  await confirmInventedPrivateSetup(server);
  const lookup = await awaitResult(server, "beta_start_meeting_prep_call_candidates_in_range", "beta_continue_meeting_prep_call_lookup", {
    account_name: "Invented Orchard", start_date: "2026-08-01", end_date: "2026-08-31",
  }, "call_lookup_ref");
  assert.equal(lookup.status, "failed");
  assert.equal(lookup.code, "MEETING_PREP_CALL_READ_TIMEOUT");
  assert.equal(lookup.failed_stage, "date_range_lookup");
  assert.equal(lookup.deadline_seconds, 100);
  assert.equal(lookup.candidates, undefined);
});

test("a Converge-selected call cannot be consumed after an invented server restart", { timeout: 20_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-meeting-mcp-invented-"));
  const runtime = makeRuntime(tempDir);
  const first = startServer(tempDir, runtime);
  registerCleanup(t, tempDir, first);
  await first.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  await confirmInventedPrivateSetup(first);
  const selectionRef = await selectInventedConvergeCall(first);
  first.child.kill();
  const second = startServer(tempDir, runtime, { namespace: first.namespace });
  t.after(() => { second.child.stdin.end(); second.child.kill(); });
  await second.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const stale = await second.call("beta_create_meeting_prep_case_from_call_selection", { call_selection_ref: selectionRef, language: "en" });
  assert.equal(stale.code, "MEETING_PREP_CALL_SELECTION_EXPIRED");
});

for (const [sourceStatus, ids, code] of [
  ["transcript_missing", [], "CONVERGE_CALL_SOURCE_GAP"],
  ["source_failed", [], "CONVERGE_CALL_SOURCE_GAP"],
  ["transcript_available", ["001000000000001AAA"], "SELECTED_CALL_ACCOUNT_MISMATCH"],
]) {
  test(`native Converge ${sourceStatus}/${code} leaves evidence unbound`, { timeout: 20_000 }, async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-meeting-mcp-invented-"));
    const server = startServer(tempDir, makeRuntime(tempDir), { mode: "converge_only" });
    registerCleanup(t, tempDir, server);
    await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const selection = await selectInventedConvergeCall(server);
    const created = await server.call("beta_create_meeting_prep_case_from_call_selection", { call_selection_ref: selection, language: "en" });
    const request = await server.call("beta_get_selected_converge_call_request", { case_id: created.case_id });
    const duplicate = await server.call("beta_get_selected_converge_call_request", { case_id: created.case_id });
    assert.equal(duplicate.call_read_ref, request.call_read_ref, "Repeated requests do not create alternative evidence-binding references");
    const result = await server.call("beta_bind_converge_call_evidence", {
      case_id: created.case_id, revision: created.revision, call_read_ref: request.call_read_ref,
      source_status: sourceStatus, linked_account_ids: ids, source_result_digest: "a".repeat(64), evidence_digest: "b".repeat(64), finding_count: 0,
    });
    assert.equal(result.code, code, JSON.stringify(result));
    const state = JSON.parse(fs.readFileSync(path.join(tempDir, "state", `${created.case_id}.json`), "utf8"));
    assert.equal(state.derived_evidence, null);
    assert.deepEqual(state.approvals, []);
    const failedCallBrief = await awaitResult(server, "beta_start_meeting_prep_account_brief", "beta_continue_meeting_prep_account_brief", { case_id: created.case_id }, "account_brief_ref");
    assert.equal(failedCallBrief.case_call_context.state, "unavailable");
    assert.equal(failedCallBrief.case_call_context.source_gap, code);
    assert.match(failedCallBrief.account_brief_display.markdown, /selected call could not be analyzed/);
  });
}

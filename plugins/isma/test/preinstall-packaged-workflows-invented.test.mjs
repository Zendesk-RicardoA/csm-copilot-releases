import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureLoader = new URL("./fixtures/preinstall-synthetic-loader.mjs", import.meta.url);

function startInventedServer(t, { bookMode = "ready" } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-preinstall-invented-"));
  const namespace = `csm-preinstall-${randomBytes(6).toString("hex")}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "config", "approved-version-manifest.json"), "utf8"));
  // This simulation never edits the candidate manifest and cannot reach a live source.
  // Give only this disposable, synthetic fixture a one-minute test lifetime.
  manifest.expires_at = new Date(Date.now() + 60_000).toISOString();
  manifest.status = "approved_for_limited_beta";
  manifest.constraints = {
    real_customer_data: true, external_reads: true, private_draft_writes: true,
    production_system_writes: false, generated_artifacts: true,
  };
  const manifestPath = path.join(tempDir, "invented-manifest.json");
  const runtimePath = path.join(tempDir, "invented-runtime.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(runtimePath, JSON.stringify({
    mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_company_sso", subject: "invented-preinstall-tester" },
    snowflake: { state: "connected", read_only_verified: true },
    organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true,
      private_draft_google_scope: true, approved_renderer_execution: true,
      retention_policy: true, operational_support: true,
    },
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [
    "--experimental-loader", pathToFileURL(fileURLToPath(fixtureLoader)).href,
    path.join(pluginRoot, "mcp", "server.mjs"),
  ], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      PLUGIN_DATA: path.join(tempDir, "state"),
      CSM_COPILOT_BETA_STATE_NAMESPACE: namespace,
      CSM_COPILOT_BETA_MANIFEST_PATH: manifestPath,
      CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: runtimePath,
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true",
      CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
      CSM_SYNTHETIC_BOOK_MODE: bookMode,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  child.stderr.on("data", (part) => { stderr += part.toString(); });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter.resolve(response); }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Invented MCP exited ${code}: ${stderr.slice(-800)}`));
    pending.clear();
  });
  t.after(() => {
    child.stdin.end();
    child.kill();
    fs.rmSync(path.join(os.homedir(), ".codex", namespace), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  async function send(method, params) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Invented MCP did not answer ${method}: ${stderr.slice(-800)}`)); }, 10_000);
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
  return { tempDir, send, call };
}

async function finishBookRead(server, started) {
  assert.equal(started.status, "in_progress");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await server.call("beta_continue_book_of_business_read", { book_read_ref: started.book_read_ref, wait_seconds: 0 });
    if (result.status !== "in_progress") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Invented book read did not settle.");
}

test("invented packaged Book of Business tools return grouped and filtered current-book data without a case", { timeout: 20_000 }, async (t) => {
  const server = startInventedServer(t);
  await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const setup = await server.call("beta_setup_status", { workflow: "portfolio_analytics" });
  assert.equal(setup.package_status.state, "matched");
  assert.equal(setup.connection_setup.state, "ready");
  const capabilities = await server.call("beta_get_book_of_business_analysis_capabilities");
  assert.ok(capabilities.supported_dimensions.some((dimension) => dimension.key === "crm_region"));
  const summary = await finishBookRead(server, await server.call("beta_start_book_of_business_summary", { dimensions: ["crm_region"] }));
  assert.equal(summary.status, "ready", JSON.stringify(summary));
  assert.equal(summary.summary.account_count, 2);
  assert.equal(summary.groups.length, 2);
  assert.equal(summary.retry_used, false);
  const accounts = await finishBookRead(server, await server.call("beta_start_book_of_business_accounts", {
    filters: [{ field: "renewal_manager", operator: "equals", value: "Invented Renewal Owner" }],
    columns: ["account_name", "renewal_manager", "billing_country"],
  }));
  assert.equal(accounts.status, "ready", JSON.stringify(accounts));
  assert.equal(accounts.matched_account_count, 1);
  assert.equal(accounts.accounts[0].account_name, "Invented Orchard");
  assert.equal(accounts.accounts[0].billing_country, "Exampleland");
  assert.equal(fs.readdirSync(path.join(server.tempDir, "state")).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).length, 0);
});

test("invented packaged Book of Business retries only a timed-out first statement and stops on scope gaps", { timeout: 20_000 }, async (t) => {
  const retry = startInventedServer(t, { bookMode: "retry" });
  await retry.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const result = await finishBookRead(retry, await retry.call("beta_start_book_of_business_summary", { dimensions: ["crm_region"] }));
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.attempt_count, 2);
  assert.equal(result.retry_used, true);
  const gap = startInventedServer(t, { bookMode: "scope_gap" });
  await gap.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const failed = await finishBookRead(gap, await gap.call("beta_start_book_of_business_summary", { dimensions: ["crm_region"] }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, "BOOK_OF_BUSINESS_SCOPE_UNAVAILABLE");
});

test("invented packaged outreach tools preserve the shortlist, metrics, source gaps, and review gates", { timeout: 20_000 }, async (t) => {
  const server = startInventedServer(t);
  await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const setup = await server.call("beta_setup_status", { workflow: "outreach" });
  assert.equal(setup.connection_setup.state, "ready");
  const route = await server.call("beta_route_workflow", { intent: "outreach" });
  assert.equal(route.route, "journey_a");
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const caseId = created.case_id;
  const queue = await server.call("beta_read_owned_cta_queue", { case_id: caseId });
  assert.equal(queue.queue.length, 1, JSON.stringify(queue));
  assert.ok(queue.queue_display_table);
  const shortlist = await server.call("beta_run_journey_a_contact_evidence", { case_id: caseId, work_item_ref: queue.queue[0].work_item_ref });
  assert.equal(shortlist.status, "contact_shortlist_ready", JSON.stringify(shortlist));
  assert.ok(shortlist.recommended_contacts?.length, JSON.stringify(shortlist));
  assert.equal(shortlist.recommended_contacts[0].display_name, "Invented Support Contact");
  let brief = await server.call("beta_continue_journey_a_contact_evidence", { case_id: caseId, contact_evidence_run_id: shortlist.contact_evidence_run_id });
  assert.equal(brief.status, "brief_and_contacts_ready", JSON.stringify(brief));
  assert.equal(brief.brief.product_performance_metrics.state, undefined);
  assert.ok(brief.brief.product_performance_metrics.rows?.length > 0);
  const premature = await server.call("beta_record_journey_a_approval", { case_id: caseId, gate: "work_selection", revision: created.revision });
  assert.equal(premature.code, "JOURNEY_CONTEXT_REQUIRED");
  const completed = await server.call("beta_complete_journey_a_contact_evidence", {
    case_id: caseId, contact_evidence_run_id: shortlist.contact_evidence_run_id,
    gmail_metadata_state: "unavailable", gmail_metadata_message_count: 0,
    source_gap_codes: ["GMAIL_METADATA_UNAVAILABLE"],
  });
  assert.ok(completed.source_gap_codes.includes("GMAIL_METADATA_UNAVAILABLE"));
  assert.equal(completed.recommended_contacts[0].display_name, "Invented Support Contact");
  const digest = "a".repeat(64);
  const bound = await server.call("beta_bind_journey_context", {
    case_id: caseId, journey: "journey_a", context_digest: digest,
    account_ref_digest: createHash("sha256").update("account:001000000000000AAA").digest("hex"),
    context_version: "1.0.0", item_count: 1,
    warning_codes: ["GMAIL_METADATA_UNAVAILABLE"],
  });
  assert.ok(Number.isInteger(bound.revision), JSON.stringify(bound));
  const outOfOrder = await server.call("beta_record_journey_a_approval", { case_id: caseId, gate: "outreach_draft", revision: bound.revision });
  assert.equal(outOfOrder.code, "APPROVAL_ORDER_VIOLATION");
  const gates = ["work_selection", "account_evidence", "contact_selection", "template_preview", "outreach_draft"];
  // Fixed customer-ready expected arguments. The host mock exposes only the
  // native Gmail create-draft method, never send or invented service methods.
  const expectedEmail={to:"invented.person@example.invalid",subject:"Review your support priorities",payload:{mime_type:"text/html",body:{content:"<p>Let’s review your support priorities together.</p>"}}};
  const emailDigest=createHash("sha256").update(JSON.stringify(expectedEmail)).digest("hex");
  let recipientBinding = {};
  for (const [index, gate] of gates.entries()) {
    if(gate==="contact_selection") {
      const selected=await server.call("beta_get_verified_outreach_recipient",{case_id:caseId,revision:bound.revision,
        contact_evidence_run_id:shortlist.contact_evidence_run_id,contact_ref:completed.recommended_contacts[0].contact_ref});
      assert.equal(selected.status,"verified_recipient_for_review",JSON.stringify(selected));
      assert.equal(selected.recipient.email,expectedEmail.to);
      recipientBinding={recipient_ref:selected.recipient_ref,to_digest:createHash("sha256").update(selected.recipient.email).digest("hex")};
    }
    if(gate==="outreach_draft") {
      const frozen=await server.call("beta_bind_outreach_draft_review",{case_id:caseId,revision:bound.revision,content_digest:emailDigest,...recipientBinding});
      assert.equal(frozen.status,"review_ready",JSON.stringify(frozen));
      const skipped=await server.call("beta_claim_outreach_draft",{case_id:caseId,revision:bound.revision,content_digest:emailDigest,private_draft_authorized:true,...recipientBinding});
      assert.equal(skipped.code,"REVIEW_INCOMPLETE");
    }
    const approved = await server.call("beta_record_journey_a_approval", { case_id: caseId, gate, revision: bound.revision });
    assert.deepEqual(approved.workflow.workflows.outreach.completed_gates, gates.slice(0, index + 1), JSON.stringify(approved));
  }
  const reviewed = await server.call("beta_workflow_status", { case_id: caseId });
  assert.equal(reviewed.workflows?.outreach?.status, "reviewed", JSON.stringify(reviewed));
  let nativeCreates=0;
  const gmail=Object.freeze({gmail_create_draft:async args=>{nativeCreates++;assert.deepEqual(args,expectedEmail);return {id:"invented-provider-draft",message:{id:"invented-message"}};}});
  const claimed=await server.call("beta_claim_outreach_draft",{case_id:caseId,revision:bound.revision,content_digest:emailDigest,private_draft_authorized:true,...recipientBinding});
  assert.equal(claimed.native_action,"gmail_create_draft");assert.equal(claimed.invoke_gmail,true);
  const provider=await gmail.gmail_create_draft(structuredClone(expectedEmail));
  const delivered=await server.call("beta_complete_outreach_draft",{case_id:caseId,revision:bound.revision,draft_request_ref:claimed.draft_request_ref,provider_draft_created:!!provider.id});
  assert.equal(delivered.status,"draft_created",JSON.stringify(delivered));
  const repeated=await server.call("beta_claim_outreach_draft",{case_id:caseId,revision:bound.revision,content_digest:emailDigest,private_draft_authorized:true,...recipientBinding});
  assert.equal(repeated.invoke_gmail,false);assert.equal(repeated.status,"already_created");assert.equal(nativeCreates,1);
  assert.equal((await server.call("beta_workflow_status",{case_id:caseId})).workflows.outreach.draft_delivery,"draft_created");
  const savedCase = fs.readFileSync(path.join(server.tempDir, "state", `${caseId}.json`), "utf8");
  assert.doesNotMatch(savedCase, /Invented Orchard|Invented Support Contact|invented\.person@example\.invalid/);
  assert.doesNotMatch(JSON.stringify(completed), /gmail_draft_id|sent_at/);
});

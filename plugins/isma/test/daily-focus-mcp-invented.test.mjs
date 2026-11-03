import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureLoader = new URL("./fixtures/daily-focus-synthetic-loader.mjs", import.meta.url);

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

function makeRuntime(tempDir, { approved = true } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "config", "approved-version-manifest.json"), "utf8"));
  // Simulated approval belongs only to this test process. All data is invented.
  // The bundled and installed expiration policies remain unchanged.
  manifest.expires_at = new Date(Date.now() + 60_000).toISOString();
  if (approved) {
    manifest.status = "approved_for_limited_beta";
    manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
  } else {
    manifest.status = "approved_for_invented_testing";
    manifest.constraints = { real_customer_data: false, external_reads: false, external_writes: false, generated_artifacts: false };
  }
  const manifestPath = path.join(tempDir, "synthetic-manifest.json");
  const runtimePath = path.join(tempDir, "synthetic-runtime.json");
  writeJson(manifestPath, manifest);
  writeJson(runtimePath, {
    mode: "limited_beta", renderer_mode: "manual_bound_script",
    identity: { state: "connected", verified: true, provider: "invented_company_sso", subject: "invented-daily-tester" },
    snowflake: { state: "connected", read_only_verified: true },
    organizational_controls: {
      company_identity: true, read_only_zdp: true, transcript_secondary_processing: true,
      private_draft_google_scope: true, approved_renderer_execution: true,
      retention_policy: true, operational_support: true,
    },
  });
  return { manifestPath, runtimePath };
}

test("next-install invented-only approval stops a live Daily Focus source read", { timeout: 20_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-daily-mcp-invented-"));
  const server = startServer(tempDir, makeRuntime(tempDir, { approved: false }));
  registerCleanup(t, tempDir, server);
  await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const setup = await server.call("beta_setup_status", { workflow: "daily_focus" });
  assert.equal(setup.connection_setup.state, "ready");
  assert.equal(setup.execution_approval.state, "approval_required");
  assert.equal(setup.workflow_readiness.state, "approval_required");
  const refused = await server.call("beta_read_daily_focus_work_signals");
  assert.equal(refused.isError, true);
  assert.equal(refused.code, "REAL_BETA_VERSION_NOT_APPROVED");
});

function startServer(tempDir, runtime, { mode = "ready", namespace = `csm-invented-daily-${randomBytes(5).toString("hex")}` } = {}) {
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
      CSM_SYNTHETIC_DAILY_MODE: mode,
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
  return { child, namespace, send, call };
}

function registerCleanup(t, tempDir, server) {
  t.after(() => {
    server.child.stdin.end();
    server.child.kill();
    assert.match(server.namespace, /^csm-invented-daily-[a-f0-9]{10}$/);
    fs.rmSync(path.join(os.homedir(), ".codex", server.namespace), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

test("invented Daily Focus reads bounded work signals without opening or saving a case", { timeout: 20_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-daily-mcp-invented-"));
  const server = startServer(tempDir, makeRuntime(tempDir));
  registerCleanup(t, tempDir, server);
  const initialized = await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const packagedName = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).name;
  assert.equal(initialized.result.serverInfo.name, packagedName);
  const setup = await server.call("beta_setup_status", { workflow: "daily_focus" });
  assert.equal(setup.package_status.state, "matched");
  assert.equal(setup.connection_setup.state, "ready");
  assert.deepEqual(setup.workflow_readiness.steps.map((step) => step.step), ["calendar_metadata", "email_metadata", "work_signals"]);
  assert.deepEqual(setup.workflow_readiness.steps.slice(0, 2).map((step) => step.owner), ["desktop_host", "desktop_host"]);
  const route = await server.call("beta_route_workflow", { intent: "broad_focus" });
  assert.equal(route.route, "daily_operating_layer");
  assert.equal(route.requires_case, false);

  const signals = await server.call("beta_read_daily_focus_work_signals");
  assert.equal(signals.status, "ready", JSON.stringify(signals));
  assert.equal(signals.work_signals.length, 2);
  assert.match(signals.work_signals[0].reason, /^P0 renewal CTA/);
  assert.equal(signals.read_deadline_seconds, 25);
  assert.equal(signals.source_limit_reached, false);
  assert.ok(signals.work_signals.every((item) => item.ctaDisposition === "queue"));
  const afterReads = await server.call("beta_setup_status", { workflow: "daily_focus" });
  assert.deepEqual(afterReads.workflow_readiness.steps.map((step) => step.state), ["available_unverified", "available_unverified", "healthy"]);
  assert.equal(fs.readdirSync(path.join(tempDir, "state")).filter((name) => name.endsWith(".json") && /^[0-9a-f-]{36}\.json$/.test(name)).length, 0);
});

test("invented Daily Focus marks its work-signal source degraded on timeout, then clears runtime health on restart", { timeout: 20_000 }, async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-daily-mcp-invented-"));
    const runtime = makeRuntime(tempDir);
    const server = startServer(tempDir, runtime, { mode: "queue_timeout" });
    registerCleanup(t, tempDir, server);
    await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const failed = await server.call("beta_read_daily_focus_work_signals");
    assert.equal(failed.code, "CTA_QUEUE_READ_TIMEOUT");
    assert.equal(failed.isError, true);
    const setup = await server.call("beta_setup_status", { workflow: "daily_focus" });
    assert.equal(setup.workflow_readiness.state, "degraded");
    assert.equal(setup.workflow_readiness.steps.find((step) => step.step === "work_signals").last_error_code, "CTA_QUEUE_READ_TIMEOUT");
    server.child.kill();
    const fresh = startServer(tempDir, runtime, { namespace: server.namespace });
    t.after(() => { fresh.child.stdin.end(); fresh.child.kill(); });
    await fresh.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const afterRestart = await fresh.call("beta_setup_status", { workflow: "daily_focus" });
    assert.equal(afterRestart.workflow_readiness.state, "available_unverified");
});

test("invented MCP relationship read returns progress and the same bounded evidence without selecting a CTA", { timeout: 20_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-daily-mcp-invented-"));
  const server = startServer(tempDir, makeRuntime(tempDir));
  registerCleanup(t, tempDir, server);
  await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const started = await server.call("beta_read_portfolio_recent_relationships", { case_id: created.case_id, lookback_days: 60 });
  assert.equal(started.status, "in_progress", JSON.stringify(started));
  const args = { case_id: created.case_id, relationship_read_ref: started.relationship_read_ref, wait_seconds: 0 };
  let result;
  for (let i = 0; i < 10; i++) {
    result = await server.call("beta_continue_portfolio_recent_relationships", args);
    if (result.status !== "in_progress") break;
  }
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.accounts.length, 2);
  assert.equal(result.read_deadline_seconds, 60);
  assert.equal(result.accounts[1].recent_relationship_in_past_days.state, "needs_gmail_metadata_check");
  assert.doesNotMatch(JSON.stringify(result), /runtimeSelectionByWorkItem|001000000000000AAA/);
  const other = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const mismatch = await server.call("beta_continue_portfolio_recent_relationships", { ...args, case_id: other.case_id });
  assert.equal(mismatch.code, "PORTFOLIO_RELATIONSHIP_RUN_UNAVAILABLE");
  const repeated = await server.call("beta_continue_portfolio_recent_relationships", args);
  assert.deepEqual(repeated.accounts, result.accounts);
  const savedCase = fs.readFileSync(path.join(tempDir, "state", `${created.case_id}.json`), "utf8");
  assert.doesNotMatch(savedCase, /Invented Orchard|Invented Grove|invented-p0-cta|001000000000000AAA/);
});

test("invented MCP relationship timeout is a source failure, not an empty result or automatic retry", { timeout: 20_000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-daily-mcp-invented-"));
  const server = startServer(tempDir, makeRuntime(tempDir), { mode: "relationship_timeout" });
  registerCleanup(t, tempDir, server);
  await server.send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await server.call("beta_create_authorized_journey_a_case", { language: "en" });
  const started = await server.call("beta_read_portfolio_recent_relationships", { case_id: created.case_id });
  const args = { case_id: created.case_id, relationship_read_ref: started.relationship_read_ref, wait_seconds: 0 };
  let result;
  for (let i = 0; i < 10; i++) {
    result = await server.call("beta_continue_portfolio_recent_relationships", args);
    if (result.status !== "in_progress") break;
  }
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.code, "PORTFOLIO_RELATIONSHIP_READ_TIMEOUT");
  assert.equal(result.isError, true);
  assert.equal(result.accounts, undefined);
  assert.match(result.next_action, /do not retry.*no recent contact/i);
  assert.equal((await server.call("beta_continue_portfolio_recent_relationships", args)).code, result.code);
});

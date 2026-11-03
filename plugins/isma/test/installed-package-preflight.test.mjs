import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePackagePreflight } from "../mcp/core.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the declared packaged launcher starts MCP and exposes all five workflows", () => {
  const config = JSON.parse(fs.readFileSync(path.join(packageRoot, ".mcp.json"), "utf8"));
  const [server] = Object.values(config.mcpServers);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-declared-launcher-"));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "config", "approved-version-manifest.json"), "utf8"));
    const run = spawnSync(server.command, server.args, {
      cwd: path.resolve(packageRoot, server.cwd),
      env: { ...process.env, ...server.env, PLUGIN_DATA: path.join(tempDir, "state"),
        CSM_COPILOT_BETA_MANIFEST_PATH: path.join(packageRoot, "config", "approved-version-manifest.json"),
        CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(packageRoot, "config", "limited-beta-runtime.json"),
        CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true" },
      input: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ].map((request) => `${JSON.stringify(request)}\n`).join(""), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    const responses = new Map(run.stdout.trim().split("\n").map((line) => { const item = JSON.parse(line); return [item.id, item]; }));
    assert.equal(responses.get(1).result.serverInfo.version, manifest.package_version);
    const names = new Set(responses.get(2).result.tools.map((tool) => tool.name));
    for (const tool of ["beta_read_daily_focus_work_signals", "beta_start_book_of_business_summary", "beta_run_journey_a_contact_evidence", "beta_complete_renewal_conversation", "beta_start_converge_call_lookup", "beta_bind_converge_call_evidence", "beta_start_meeting_prep_account_brief", "beta_get_account_brief_chart", "beta_prepare_meeting_prep_draft_review", "beta_render_private_draft"]) assert.ok(names.has(tool), `Missing ${tool}`);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test("the unchanged package verifies its frozen bytes and still refuses an expired approval", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(packageRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "config", "approved-version-manifest.json"), "utf8"));
  const result = validatePackagePreflight({
    manifest,
    packageRoot,
    expectedPackageName: plugin.name,
    expectedPackageVersion: plugin.version,
    // Verify the immutable artifact within its declared lifetime. This does not
    // renew it: an expired package must still be refused at the actual time.
    now: manifest.expires_at ? new Date(Date.parse(manifest.expires_at) - 1000) : new Date(),
  });
  assert.equal(result.package_version, plugin.version);
  assert.equal(result.boundaries.external_reads, manifest.status === "approved_for_limited_beta");
  if (manifest.expires_at && Date.parse(manifest.expires_at) <= Date.now()) {
    assert.throws(() => validatePackagePreflight({manifest, packageRoot,
      expectedPackageName: plugin.name, expectedPackageVersion: plugin.version}), {code: "VERSION_STALE"});
  }
});

test("an invented-only installed package reports approval required and refuses Daily Focus reads", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "config", "approved-version-manifest.json"), "utf8"));
  if (manifest.status !== "approved_for_invented_testing") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-installed-preflight-"));
  try {
    // Only this disposable invented-only fixture gets a one-minute lifetime.
    // The installed/bundled manifest is never changed by the test.
    const fixturePath = path.join(tempDir, "invented-manifest.json");
    fs.writeFileSync(fixturePath, JSON.stringify({...manifest,
      expires_at: new Date(Date.now() + 60_000).toISOString()}), {mode: 0o600});
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "beta_setup_status", arguments: { workflow: "daily_focus" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "beta_read_daily_focus_work_signals", arguments: {} } },
    ];
    const run = spawnSync(process.execPath, [path.join(packageRoot, "mcp", "server.mjs")], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PLUGIN_DATA: path.join(tempDir, "state"),
        CSM_COPILOT_BETA_STATE_NAMESPACE: `csm-preflight-${randomBytes(5).toString("hex")}`,
        CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true",
        CSM_COPILOT_BETA_MANIFEST_PATH: fixturePath,
        CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python",
      },
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const responses = new Map(run.stdout.trim().split("\n").map((line) => {
      const response = JSON.parse(line);
      return [response.id, response];
    }));
    const setup = JSON.parse(responses.get(2).result.content[0].text);
    assert.equal(responses.get(2).result.isError, false);
    assert.equal(setup.package_status.state, "matched");
    assert.equal(setup.execution_approval.state, "approval_required");
    assert.equal(setup.workflow_readiness.state, "approval_required");
    const refused = JSON.parse(responses.get(3).result.content[0].text);
    assert.equal(responses.get(3).result.isError, true);
    assert.equal(refused.code, "SETUP_REQUIRED");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

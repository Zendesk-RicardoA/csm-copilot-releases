import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const accountDigest = hash("account:001000000000000AAA");
function start(t, existing = null) {
  const dir = existing || fs.mkdtempSync(path.join(os.tmpdir(), "csm-recipient-handoff-invented-"));
  if (!existing) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/approved-version-manifest.json")));
    manifest.status = "approved_for_limited_beta";
    manifest.constraints = { real_customer_data: true, external_reads: true, private_draft_writes: true, production_system_writes: false, generated_artifacts: true };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ mode: "limited_beta", renderer_mode: "manual_bound_script",
      identity: { state: "connected", verified: true, provider: "invented_sso", subject: "invented-contact-tester" },
      snowflake: { state: "connected", read_only_verified: true }, organizational_controls: { company_identity: true, read_only_zdp: true,
        transcript_secondary_processing: true, private_draft_google_scope: true, approved_renderer_execution: true, retention_policy: true, operational_support: true } }), { mode: 0o600 });
  }
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/contact-priority-loader.mjs", import.meta.url).href, path.join(root, "mcp/server.mjs")],
    { cwd: root, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PLUGIN_DATA: path.join(dir, "state"),
      CSM_COPILOT_BETA_MANIFEST_PATH: path.join(dir, "manifest.json"), CSM_COPILOT_BETA_LIMITED_RUNTIME_PATH: path.join(dir, "runtime.json"),
      CSM_COPILOT_BETA_DISABLE_OWNER_ASSISTED: "true", CSM_COPILOT_SNOWFLAKE_PYTHON: "/not-a-real-snowflake-python", CSM_CONTACT_PRIORITY_MODE: "ready" } });
  let id = 0; const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => { let r; try { r = JSON.parse(line); } catch { return; }
    const p = pending.get(r.id); if (p) { pending.delete(r.id); p(r); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Invented protocol response timed out.")); }, 5000);
    pending.set(requestId, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); });
  t.after(() => { child.stdin.end(); child.kill(); if (!existing) fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, child, rpc, call: async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args });
    assert.ok(r.result?.content?.[0]?.text, JSON.stringify(r)); return { ...JSON.parse(r.result.content[0].text), isError: r.result.isError === true }; } };
}
async function prepare(s) {
  await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const created = await s.call("beta_create_authorized_journey_a_case", { language: "en" });
  const queue = await s.call("beta_read_owned_cta_queue", { case_id: created.case_id });
  const first = await s.call("beta_run_journey_a_contact_evidence", { case_id: created.case_id, work_item_ref: queue.queue[0].work_item_ref });
  assert.equal(first.isError, false);
  const args = { case_id: created.case_id, contact_evidence_run_id: first.contact_evidence_run_id };
  let final;
  for (let i = 0; i < 30; i++) {
    final = await s.call("beta_continue_journey_a_contact_evidence", args);
    if (final.relationship_context_state === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(final.relationship_context_state, "completed");
  assert.equal(final.recommended_contacts.length, 2);
  assert.doesNotMatch(JSON.stringify(final.recommended_contacts), /@/);
  const completed = await s.call("beta_complete_journey_a_contact_evidence", { ...args, gmail_metadata_state: "not_requested", gmail_metadata_message_count: 0 });
  assert.equal(completed.isError, false);
  assert.equal(completed.source_states.gmail_metadata, "not_requested");
  const bound = await s.call("beta_bind_journey_context", { case_id: created.case_id, journey: "journey_a", context_digest: "a".repeat(64),
    account_ref_digest: accountDigest, context_version: "1.0.0", item_count: 3, warning_codes: [] });
  for (const gate of ["work_selection", "account_evidence"]) {
    assert.equal((await s.call("beta_record_journey_a_approval", { case_id: created.case_id, revision: bound.revision, gate })).isError, false);
  }
  return { args, final, revision: bound.revision };
}
const select = (s, run, index = 0) => s.call("beta_get_verified_outreach_recipient", { ...run.args, revision: run.revision,
  contact_ref: run.final.recommended_contacts[index].contact_ref });
async function reviewed(s, run) {
  const selected = await select(s, run);
  assert.equal(selected.status, "verified_recipient_for_review");
  for (const gate of ["contact_selection", "template_preview"]) assert.equal((await s.call("beta_record_journey_a_approval", {
    case_id: run.args.case_id, revision: selected.revision, gate })).isError, false);
  const email = { to: selected.recipient.email, subject: "Review your support priorities", payload: { mime_type: "text/html", charset: "UTF-8",
    body: { content: "<p>Let’s review your support priorities together.</p><p>Invented CSM</p>" } } };
  const binding = { case_id: run.args.case_id, revision: selected.revision, recipient_ref: selected.recipient_ref,
    to_digest: hash(email.to), content_digest: hash(JSON.stringify(email)) };
  assert.equal((await s.call("beta_bind_outreach_draft_review", binding)).isError, false);
  return { selected, email, binding };
}

test("native completed contact read supplies Gmail To: one verified same-account address, never a test-supplied recipient", { timeout: 10000 }, async t => {
  const s = start(t);
  const tools = await s.rpc("tools/list", {});
  const schema = tools.result.tools.find(tool => tool.name === "beta_get_verified_outreach_recipient");
  assert.ok(schema, "The native selected-address handoff must be callable.");
  assert.equal(schema.inputSchema.additionalProperties, false);
  assert.equal(schema.inputSchema.properties.email, undefined);
  const run = await prepare(s), review = await reviewed(s, run);
  assert.equal(review.email.to, "recent@example.invalid");
  assert.equal(review.selected.recipient.display_name, "Invented Recent Operator");
  assert.equal(review.selected.address_digest, hash("recent@example.invalid"));
  assert.equal((await s.call("beta_record_journey_a_approval", { case_id: run.args.case_id, revision: review.binding.revision, gate: "outreach_draft" })).isError, false);
  const claim = await s.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  assert.equal(claim.invoke_gmail, true);
  const calls = [];
  const gmail = { gmail_create_draft: async args => { calls.push(structuredClone(args)); return { id: "invented-private-draft" }; } };
  if (claim.invoke_gmail) await gmail.gmail_create_draft(review.email);
  assert.deepEqual(calls, [{ to: "recent@example.invalid", subject: "Review your support priorities", payload: { mime_type: "text/html", charset: "UTF-8",
    body: { content: "<p>Let’s review your support priorities together.</p><p>Invented CSM</p>" } } }]);
  const done = await s.call("beta_complete_outreach_draft", { case_id: run.args.case_id, revision: review.binding.revision,
    draft_request_ref: claim.draft_request_ref, provider_draft_created: true });
  assert.equal(done.status, "draft_created");
  const repeated = await s.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  assert.equal(repeated.status, "already_created"); assert.equal(repeated.invoke_gmail, false); assert.equal(calls.length, 1);
  const saved = fs.readFileSync(path.join(s.dir, "state", run.args.case_id + ".json"), "utf8");
  assert.doesNotMatch(saved, /@example\.invalid|Invented Recent|003000000000|Review your support priorities|invented-private-draft/);
});

test("native contact selection and email review cannot bypass the verified-address handoff", { timeout: 10000 }, async t => {
  const s = start(t), run = await prepare(s);
  const approval = await s.call("beta_record_journey_a_approval", { case_id: run.args.case_id, revision: run.revision, gate: "contact_selection" });
  assert.equal(approval.code, "OUTREACH_RECIPIENT_REQUIRED");
  const binding = await s.call("beta_bind_outreach_draft_review", { case_id: run.args.case_id, revision: run.revision, content_digest: "b".repeat(64) });
  assert.equal(binding.code, "OUTREACH_RECIPIENT_REQUIRED");
  const invalid = await s.call("beta_get_verified_outreach_recipient", { ...run.args, revision: run.revision,
    contact_ref: run.final.prioritized_contacts[2].contact_ref });
  assert.equal(invalid.code, "CONTACT_RECIPIENT_NOT_VERIFIED");
});

test("native foreign contact, expired run and a replaced To digest stop before a host write", { timeout: 10000 }, async t => {
  const s = start(t), run = await prepare(s);
  const foreign = await s.call("beta_get_verified_outreach_recipient", { ...run.args, revision: run.revision, contact_ref: "f".repeat(64) });
  assert.equal(foreign.code, "CONTACT_RECIPIENT_NOT_VERIFIED");
  const expired = await s.call("beta_get_verified_outreach_recipient", { ...run.args, revision: run.revision,
    contact_evidence_run_id: "00000000-0000-4000-8000-000000000000", contact_ref: run.final.recommended_contacts[0].contact_ref });
  assert.equal(expired.code, "OUTREACH_RECIPIENT_EXPIRED");
  const review = await reviewed(s, run);
  const bad = await s.call("beta_claim_outreach_draft", { ...review.binding, to_digest: hash("different@example.invalid"), private_draft_authorized: true });
  assert.equal(bad.code, "OUTREACH_RECIPIENT_MISMATCH");
  const unapproved = await s.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  assert.equal(unapproved.code, "REVIEW_INCOMPLETE");
});

test("changing the selected contact clears contact and email approvals, not reviewed work and account evidence", { timeout: 10000 }, async t => {
  const s = start(t), run = await prepare(s), review = await reviewed(s, run);
  assert.equal((await s.call("beta_record_journey_a_approval", { case_id: run.args.case_id, revision: run.revision, gate: "outreach_draft" })).isError, false);
  const changed = await select(s, run, 1);
  assert.equal(changed.status, "verified_recipient_for_review"); assert.equal(changed.recipient.email, "older@example.invalid");
  assert.equal(changed.revision, run.revision + 1);
  const status = await s.call("beta_workflow_status", { case_id: run.args.case_id });
  assert.equal(status.workflows.outreach.next_gate, "contact_selection");
  const old = await s.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  assert.equal(old.code, "STALE_CASE_REVISION");
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, "state", run.args.case_id + ".json")));
  assert.deepEqual(saved.journey_state.contexts.journey_a.approvals.map(a => a.gate), ["work_selection", "account_evidence"]);
  assert.equal(saved.outreach_delivery, undefined);
});

test("restart cannot restore selected email from saved receipt; confirmed drafts stay idempotent", { timeout: 10000 }, async t => {
  const s = start(t), run = await prepare(s), review = await reviewed(s, run);
  const fresh = start(t, s.dir);
  await fresh.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const expired = await fresh.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  assert.equal(expired.code, "OUTREACH_RECIPIENT_EXPIRED");
  assert.equal((await s.call("beta_record_journey_a_approval", { case_id: run.args.case_id, revision: run.revision, gate: "outreach_draft" })).isError, false);
  const claim = await s.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  await s.call("beta_complete_outreach_draft", { case_id: run.args.case_id, revision: run.revision, draft_request_ref: claim.draft_request_ref, provider_draft_created: true });
  const duplicate = await fresh.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  assert.equal(duplicate.status, "already_created"); assert.equal(duplicate.invoke_gmail, false);
});

test("an uncertain provider result never permits recipient replacement or another create", { timeout: 10000 }, async t => {
  const s = start(t), run = await prepare(s), review = await reviewed(s, run);
  await s.call("beta_record_journey_a_approval", { case_id: run.args.case_id, revision: run.revision, gate: "outreach_draft" });
  const claim = await s.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true });
  await s.call("beta_complete_outreach_draft", { case_id: run.args.case_id, revision: run.revision, draft_request_ref: claim.draft_request_ref, provider_draft_created: false });
  assert.equal((await select(s, run, 1)).code, "DRAFT_RECONCILIATION_REQUIRED");
  assert.equal((await s.call("beta_claim_outreach_draft", { ...review.binding, private_draft_authorized: true })).code, "DRAFT_RECONCILIATION_REQUIRED");
});
test("wording-only native review retains the recipient and early gates, but clears final approval", { timeout: 10000 }, async t => {
  const s = start(t), run = await prepare(s), review = await reviewed(s, run);
  await s.call("beta_record_journey_a_approval", { case_id: run.args.case_id, revision: run.revision, gate: "outreach_draft" });
  const email = { ...review.email, subject: "Review your next support priorities" };
  const changed = await s.call("beta_bind_outreach_draft_review", { ...review.binding, content_digest: hash(JSON.stringify(email)) });
  assert.equal(changed.status, "review_ready"); assert.equal(changed.revision, run.revision + 1);
  const same = await select(s, { ...run, revision: changed.revision });
  assert.equal(same.recipient_ref, review.selected.recipient_ref); assert.equal(same.expires_at, review.selected.expires_at);
  const status = await s.call("beta_workflow_status", { case_id: run.args.case_id });
  assert.deepEqual(status.workflows.outreach.completed_gates, ["work_selection", "account_evidence", "contact_selection", "template_preview"]);
  assert.equal(status.workflows.outreach.next_gate, "outreach_draft");
  const claim = await s.call("beta_claim_outreach_draft", { ...review.binding, revision: changed.revision, content_digest: hash(JSON.stringify(email)), private_draft_authorized: true });
  assert.equal(claim.code, "REVIEW_INCOMPLETE");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as source from "../mcp/renewal-source-resolver.mjs";
import { summarizeWorkflowReadiness } from "../mcp/workflow-readiness.mjs";
import { WORKFLOW_STEPS } from "../mcp/workflow-catalog.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const owner = "invented-native-drive-owner";
const record = () => ({ case_id: "invented-case", tester_id: owner, package_version: "0.0.0-test", revision: 3,
  case_kind: "real_authorized_journey_a", journey_state: { active_journey: "journey_a", account_ref_digest: "a".repeat(64) } });
const templateRows = [["Clari Groove", "Clari Groove Copy", "Link", "Gainsight"],
  ["P0: Non-Monthly [EMEA - ES]", "Copy of an obsolete invented guide", "", "Invented CTA label"],
  ["P0: Non-Monthly [LATAM - ES]", "", "", "Invented CTA label"], ["P1: Non-Monthly [EN]", "", "", "Invented CTA label"]];
const sequenceRows = [["Language", "Sequence", "Localized One Pager", "Reviewed By", "Completed"],
  ["Spanish - EMEA", "Spanish | Invented Renewal Guide", "", "", "TRUE"],
  ["Spanish - LATAM", "Spanish (LATAM) | Invented Renewal Guide", "", "", "TRUE"],
  ["English", "English | Invented Renewal Guide", "", "", "TRUE"]];
const tracker = { id: "invented-tracker", title: "H2 2099 Renewal Sequences | Localization Tracker",
  mime_type: "application/vnd.google-apps.spreadsheet", url: "https://docs.google.com/spreadsheets/d/invented-tracker/edit" };
const guide = { id: "invented-guide", title: "Spanish | Invented Renewal Guide", mime_type: "application/vnd.google-apps.document",
  url: "https://docs.google.com/document/d/invented-guide/edit" };
const modified = "2099-01-01T00:00:00Z";
const tools = ["get_profile", "search", "get_file_metadata", "get_spreadsheet_metadata", "get_spreadsheet_range", "get_document_text", "fetch"];

function create(options = {}) {
  assert.equal(typeof source.NativeRenewalSourceBridge, "function", "The registered native Drive bridge must exist; a private OAuth client is not a host connection.");
  return new source.NativeRenewalSourceBridge(options);
}
function response(request, changes = {}) {
  const args = request.arguments;
  if (request.tool === "get_profile") return { connected: true, profile_digest: hash("invented authenticated Drive profile") };
  if (request.tool === "search") return args.special_filter_query_str.includes("mimeType")
    ? { results: [tracker] } : { results: [guide] };
  if (request.tool === "get_spreadsheet_metadata") return { spreadsheetId: tracker.id, sheets: [
    { properties: { sheetId: 10, title: "Template Link", gridProperties: { rowCount: 4, columnCount: 4 } } },
    { properties: { sheetId: 11, title: "H2 Renewal Sequences", gridProperties: { rowCount: 4, columnCount: 5 } } }] };
  if (request.tool === "get_spreadsheet_range") {
    const all = args.sheet_name === "Template Link" ? templateRows : sequenceRows;
    const [start, end] = args.range.match(/\d+/g).map(Number);
    return { range: `'${args.sheet_name}'!${args.range}`, majorDimension: "ROWS", values: structuredClone(all.slice(start - 1, end)) };
  }
  if (request.tool === "get_file_metadata") return { id: guide.id, name: guide.title, mimeType: guide.mime_type,
    webViewLink: guide.url, modifiedTime: modified, trashed: false, ...changes };
  if (request.tool === "get_document_text") return { content_digest: hash("Invented current renewal email guidance"),
    character_count: 39, truncated: false, file_ref_digest: hash(guide.id) };
  throw new Error("The invented adapter exposes only actual connected Drive read methods.");
}
function start(bridge, caseRecord = record(), overrides = {}) {
  return bridge.start({ ownerRef: owner, caseRecord, priority: "P0", language: "es", languageVariant: "EMEA", ...overrides });
}
function accept(bridge, pending, caseRecord = record(), result = response(pending.native_request)) {
  return bridge.accept({ ref: pending.renewal_source_ref, ownerRef: owner, caseRecord,
    tool: pending.native_request.tool, sourceStatus: "ok", result });
}
function complete(bridge, pending = start(bridge), caseRecord = record()) {
  const requests = [];
  for (let i = 0; pending.native_request && i < 30; i++) {
    assert.ok(tools.includes(pending.native_request.tool)); requests.push(structuredClone(pending.native_request));
    pending = accept(bridge, pending, caseRecord);
  }
  assert.equal(pending.native_request, undefined); return { result: pending, requests };
}

test("current tracker columns and regional language select the authoritative guide, not a stale Copy title", () => {
  const actual = source.selectRenewalSequence({ templateRows, sequenceRows, priority: "P0", language: "es", languageVariant: "EMEA" });
  assert.equal(actual.status, "mapped"); assert.equal(actual.sequence_title, "Spanish | Invented Renewal Guide");
  assert.equal(actual.reviewed, true); assert.equal(actual.language_label, "Spanish - EMEA");
});
test("regional Spanish is not guessed and duplicate matching priority rows stop selection", () => {
  assert.equal(source.selectRenewalSequence({ templateRows, sequenceRows, priority: "P0", language: "es" }).status, "language_variant_required");
  assert.equal(source.selectRenewalSequence({ templateRows: [...templateRows, templateRows[1]], sequenceRows,
    priority: "P0", language: "es", languageVariant: "EMEA" }).status, "template_mapping_ambiguous");
});
test("an already connected native Drive account needs no plugin OAuth client, token or browser login", () => {
  const bridge = create(), run = complete(bridge);
  assert.equal(run.result.status, "ready"); assert.equal(run.result.copy_state, "read");
  assert.equal(run.result.sequence.title, "Spanish | Invented Renewal Guide");
  assert.equal(run.result.receipt.account_ref_digest, "a".repeat(64));
  assert.equal(run.result.receipt.package_version, "0.0.0-test");
  assert.equal(run.result.receipt.sequence_content_digest, hash("Invented current renewal email guidance"));
  assert.deepEqual(run.requests.map(r => r.tool), ["get_profile", "search", "get_spreadsheet_metadata",
    "get_spreadsheet_range", "get_spreadsheet_range", "get_spreadsheet_range", "get_spreadsheet_range",
    "search", "get_file_metadata", "get_document_text", "get_file_metadata"]);
  assert.doesNotMatch(JSON.stringify(run), /access_token|refresh_token|client_secret|authorization_url/);
  assert.doesNotMatch(JSON.stringify(run.result.receipt), /invented-tracker|invented-guide|Spanish|http/);
});
test("sequence metadata alone cannot satisfy the actual-copy requirement", () => {
  const bridge = create(); let pending = start(bridge);
  while (pending.native_request.tool !== "get_document_text") pending = accept(bridge, pending);
  assert.notEqual(pending.status, "ready");
  assert.throws(() => accept(bridge, pending, record(), { file_ref_digest: hash(guide.id), content_digest: hash(""), character_count: 0, truncated: false }), { code: "RENEWAL_SEQUENCE_COPY_REQUIRED" });
});
test("unreviewed guidance stops before content retrieval or approval", () => {
  const bridge = create(); let pending = start(bridge);
  for (let i = 0; pending.native_request && i < 20; i++) {
    const result = response(pending.native_request);
    if (pending.native_request.tool === "get_spreadsheet_range" && pending.native_request.arguments.sheet_name === "H2 Renewal Sequences" && pending.native_request.arguments.range.startsWith("A2")) result.values[0][4] = "FALSE";
    pending = accept(bridge, pending, record(), result);
  }
  assert.equal(pending.status, "sequence_not_reviewed"); assert.equal(pending.receipt, undefined);
});
test("truncated search pages cannot be mistaken for a complete or unique tracker", () => {
  const bridge = create(); let pending = accept(bridge, start(bridge));
  pending = accept(bridge, pending, record(), { results: [tracker], next_page_token: "invented-next-page" });
  assert.equal(pending.native_request.arguments.page_token, "invented-next-page");
  pending = accept(bridge, pending, record(), { results: [{ ...tracker, id: "invented-other-tracker" }] });
  assert.equal(pending.status, "tracker_ambiguous"); assert.equal(pending.receipt, undefined);
});
test("mismatched owner, case, account and package cannot bind the native source", () => {
  for (const replacement of [{ case_id: "other-case" }, { package_version: "0.0.1-test" },
    { journey_state: { active_journey: "journey_a", account_ref_digest: "b".repeat(64) } }]) {
    const bridge = create(), pending = start(bridge);
    assert.throws(() => accept(bridge, pending, { ...record(), ...replacement }), { code: "RENEWAL_SOURCE_SCOPE_MISMATCH" });
  }
  const bridge = create(), pending = start(bridge);
  assert.throws(() => bridge.accept({ ref: pending.renewal_source_ref, ownerRef: "other-owner", caseRecord: record(),
    tool: "get_profile", sourceStatus: "ok", result: response(pending.native_request) }), { code: "RENEWAL_SOURCE_READ_EXPIRED" });
});
test("expiry and process restart cannot restore source content or receipts", () => {
  let now = 1000; const bridge = create({ now: () => now }), pending = start(bridge);
  now += 15 * 60_000;
  assert.throws(() => accept(bridge, pending), { code: "RENEWAL_SOURCE_READ_EXPIRED" });
  assert.throws(() => accept(create(), pending), { code: "RENEWAL_SOURCE_READ_EXPIRED" });
});
test("the requested native tool and file must match, and changed copy cannot become ready", () => {
  const bridge = create(); let pending = start(bridge);
  assert.throws(() => bridge.accept({ ref: pending.renewal_source_ref, ownerRef: owner, caseRecord: record(),
    tool: "search", sourceStatus: "ok", result: { results: [tracker] } }), { code: "RENEWAL_NATIVE_TOOL_MISMATCH" });
  while (pending.native_request.tool !== "get_document_text") pending = accept(bridge, pending);
  assert.throws(() => accept(bridge, pending, record(), { ...response(pending.native_request), file_ref_digest: hash("other-file") }), { code: "RENEWAL_SOURCE_FILE_MISMATCH" });
  pending = accept(bridge, pending);
  assert.throws(() => accept(bridge, pending, record(), response(pending.native_request, { modifiedTime: "2099-01-02T00:00:00Z" })), { code: "RENEWAL_SEQUENCE_CHANGED" });
});
test("timeouts and missing tabs are source gaps, not zero data or a reason to bypass Drive", () => {
  const bridge = create(), pending = start(bridge);
  const failed = bridge.accept({ ref: pending.renewal_source_ref, ownerRef: owner, caseRecord: record(), tool: "get_profile", sourceStatus: "timed_out", result: {} });
  assert.equal(failed.status, "renewal_source_unavailable"); assert.equal(failed.failure_stage, "profile");
  assert.equal(failed.receipt, undefined); assert.match(failed.next_action, /without sequence wording/);
  const second = create(); let request = start(second);
  request = accept(second, request); request = accept(second, request);
  const absent = accept(second, request, record(), { spreadsheetId: tracker.id, sheets: [] });
  assert.equal(absent.status, "tracker_layout_unavailable"); assert.equal(absent.receipt, undefined);
});
test("unbounded grids and silently shortened content cannot produce a ready guide", () => {
  const bridge = create(); let pending = start(bridge); pending = accept(bridge, pending); pending = accept(bridge, pending);
  const metadata = response(pending.native_request); metadata.sheets[0].properties.gridProperties.rowCount = 1000000;
  assert.throws(() => accept(bridge, pending, record(), metadata), { code: "RENEWAL_SOURCE_LIMIT" });
  const second = create(); let request = start(second); while (request.native_request.tool !== "get_document_text") request = accept(second, request);
  assert.throws(() => accept(second, request, record(), { ...response(request.native_request), truncated: true }), { code: "RENEWAL_SEQUENCE_COPY_REQUIRED" });
});
test("missing native renewal controls degrade outreach, not book analysis", () => {
  const all = [...new Set(Object.values(WORKFLOW_STEPS).flatMap(steps => steps.flatMap(s => s.tools)))];
  assert.ok(all.includes("beta_continue_renewal_sequence"));
  const availableTools = all.filter(t => t !== "beta_continue_renewal_sequence");
  const assess = workflow => summarizeWorkflowReadiness({ workflow, availableTools, setupStatus: "ready", packageStatus: { state: "matched" } });
  assert.equal(assess("outreach").state, "blocked"); assert.equal(assess("portfolio_analytics").state, "available_unverified");
});
test("completed guide receipts remain owner-bound, expire absolutely and cannot survive restart", () => {
  let now = 1000; const bridge = create({ now: () => now }), result = complete(bridge).result;
  const bound = { ...record(), renewal_source_receipt: result.receipt };
  assert.equal(bridge.assertReceipt(bound, owner), true);
  assert.throws(() => bridge.assertReceipt({ ...bound, renewal_source_receipt: { ...result.receipt, sequence_content_digest: "f".repeat(64) } }, owner), { code: "RENEWAL_SOURCE_RECEIPT_MISMATCH" });
  now += 15 * 60_000;
  assert.throws(() => bridge.assertReceipt(bound, owner), { code: "RENEWAL_SOURCE_READ_EXPIRED" });
  assert.throws(() => create().assertReceipt(bound, owner), { code: "RENEWAL_SOURCE_READ_EXPIRED" });
});
test("an optional one-pager read failure does not erase the verified complete sequence", () => {
  const bridge = create(); let pending = start(bridge);
  for (let i = 0; i < 20; i++) {
    if (pending.stage === "one_pager_search") break;
    const result = response(pending.native_request);
    if (pending.native_request.tool === "get_spreadsheet_range" && pending.native_request.arguments.sheet_name === "H2 Renewal Sequences" && pending.native_request.arguments.range.startsWith("A2")) result.values[0][2] = "Invented optional guide.pdf";
    pending = accept(bridge, pending, record(), result);
  }
  assert.equal(pending.stage, "one_pager_search");
  const completed = bridge.accept({ ref: pending.renewal_source_ref, ownerRef: owner, caseRecord: record(), tool: "search", sourceStatus: "unavailable", result: {} });
  assert.equal(completed.status, "ready"); assert.equal(completed.copy_state, "read");
  assert.equal(completed.one_pager.state, "unavailable");
  assert.equal(completed.receipt.sequence_content_digest, hash("Invented current renewal email guidance"));
});

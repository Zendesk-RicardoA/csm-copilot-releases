import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as source from "../mcp/renewal-source-resolver.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const record = { case_id: "invented-normalized-native-source", tester_id: "invented-owner", package_version: "0.0.0-test", revision: 1,
  case_kind: "real_authorized_journey_a", journey_state: { active_journey: "journey_a", account_ref_digest: "a".repeat(64) } };
const metadata = { id: "invented-guide", title: "English | Invented Guide", mime_type: "application/vnd.google-apps.document",
  url: "https://docs.google.com/document/d/invented-guide/edit", modified_time: "2099-01-01T00:00:00Z", source_visibility_status: "access_not_verified" };
function resultFor(request) {
  if (request.tool === "get_profile") return { connected: true, profile_digest: hash("invented native profile") };
  if (request.tool === "search") return { results: request.arguments.special_filter_query_str.includes("mimeType")
    ? [{ id: "invented-tracker", title: "H2 2099 Renewal Sequences | Localization Tracker", mime_type: "application/vnd.google-apps.spreadsheet" }]
    : [{ id: "invented-guide", title: metadata.title, mime_type: metadata.mime_type }] };
  if (request.tool === "get_spreadsheet_metadata") return { spreadsheetId: "invented-tracker", sheets: [
    { properties: { sheetId: 1, title: "Template Link", gridProperties: { rowCount: 2, columnCount: 4 } } },
    { properties: { sheetId: 2, title: "H2 Renewal Sequences", gridProperties: { rowCount: 2, columnCount: 5 } } }] };
  if (request.tool === "get_spreadsheet_range") {
    const rows = request.arguments.sheet_name === "Template Link" ? [["Clari Groove", "Clari Groove Copy", "Link", "Gainsight"], ["P1: Renewal [EN]", "", "", ""]]
      : [["Language", "Sequence", "Localized One Pager", "Reviewed By", "Completed"], ["English", metadata.title, "", "", "TRUE"]];
    return { range: `'${request.arguments.sheet_name}'!${request.arguments.range}`, majorDimension: "ROWS", values: [rows[request.arguments.range.startsWith("A1") ? 0 : 1]] };
  }
  if (request.tool === "get_file_metadata") return structuredClone(metadata);
  if (request.tool === "get_document_text") return { file_ref_digest: hash(metadata.id), content_digest: hash("Invented full copy\n"), character_count: 19, truncated: false };
  throw new Error("No unsupported native method is present.");
}
function begin() {
  const bridge = new source.NativeRenewalSourceBridge();
  return { bridge, pending: bridge.start({ ownerRef: record.tester_id, caseRecord: record, priority: "P1", language: "en" }) };
}
const accept = (bridge, pending, result = resultFor(pending.native_request)) => bridge.accept({ ref: pending.renewal_source_ref,
  ownerRef: record.tester_id, caseRecord: record, tool: pending.native_request.tool, sourceStatus: "ok", result });

test("actual native normalized metadata needs no fabricated trash or access flag and proves current presence after full copy", () => {
  const { bridge, pending: first } = begin(); let pending = first; const stages = [];
  for (let i = 0; pending.native_request && i < 20; i++) { stages.push(pending.stage); pending = accept(bridge, pending); }
  assert.equal(pending.status, "ready"); assert.equal(pending.copy_state, "read");
  assert.ok(stages.includes("sequence_presence_recheck"));
  assert.equal(pending.receipt.sequence_content_digest, hash("Invented full copy\n"));
  assert.equal(metadata.source_visibility_status, "access_not_verified"); assert.equal(metadata.trashed, undefined);
});
test("a removed or replaced file cannot pass the normalized metadata presence check", () => {
  for (const replacement of [[], [{ id: "invented-replacement", title: metadata.title, mime_type: metadata.mime_type }]]) {
    const { bridge, pending: first } = begin(); let pending = first;
    for (let i = 0; pending.native_request && pending.stage !== "sequence_presence_recheck" && i < 20; i++) pending = accept(bridge, pending);
    assert.equal(pending.stage, "sequence_presence_recheck");
    assert.throws(() => accept(bridge, pending, { results: replacement }), { code: "RENEWAL_SOURCE_FILE_MISMATCH" });
  }
});
test("native normalization still rejects missing revision, changed title and private metadata", () => {
  for (const replacement of [{ ...metadata, modified_time: null }, { ...metadata, title: "Another invented guide" }, { ...metadata, permissions: [{ emailAddress: "invented@example.invalid" }] }]) {
    const { bridge, pending: first } = begin(); let pending = first;
    while (pending.native_request.tool !== "get_file_metadata") pending = accept(bridge, pending);
    assert.throws(() => accept(bridge, pending, replacement), error => ["RENEWAL_SOURCE_FILE_MISMATCH", "RENEWAL_NATIVE_RESULT_INVALID"].includes(error.code));
  }
});
test("native document paragraphs supply exact copy and digest, not the Action completed message", () => {
  assert.equal(typeof source.projectNativeRenewalCopyReceipt, "function");
  const projected = source.projectNativeRenewalCopyReceipt({ fileId: "invented-guide", toolResult: { content: [{ type: "text", text: "Action completed." }],
    structuredContent: { documentId: "invented-guide", title: "Invented Guide", tabId: null, paragraphs: [{ text: "First line.\n", tabId: "invented-tab" }, { text: "Second line.\n", tabId: "invented-tab" }] } } });
  assert.deepEqual(projected, { file_ref_digest: hash("invented-guide"), content_digest: hash("First line.\nSecond line.\n"), character_count: 25, truncated: false });
  assert.equal(projected.runtimeCopy, "First line.\nSecond line.\n");
  assert.doesNotMatch(JSON.stringify(projected), /First line|Second line|Action completed|invented-guide|Invented Guide/);
});
test("wrong document, empty, truncated, partial or confirmation-only results never supply guide copy", () => {
  assert.equal(typeof source.projectNativeRenewalCopyReceipt, "function");
  for (const result of [
    { documentId: "invented-other", paragraphs: [{ text: "Wrong source" }] },
    { documentId: "invented-guide", paragraphs: [] },
    { documentId: "invented-guide", paragraphs: [{ text: "Partial" }], truncated: true },
    { documentId: "invented-guide", paragraphs: [{ text: "Partial" }], next_page_token: "invented-more" },
    { documentId: "invented-guide", paragraphs: [{ text: "Partial" }], partial: true },
  ]) assert.throws(() => source.projectNativeRenewalCopyReceipt({ fileId: "invented-guide", toolResult: { structuredContent: result } }), error => ["RENEWAL_SOURCE_FILE_MISMATCH", "RENEWAL_SEQUENCE_COPY_REQUIRED"].includes(error.code));
  assert.throws(() => source.projectNativeRenewalCopyReceipt({ fileId: "invented-guide", toolResult: { content: [{ type: "text", text: "Action completed." }] } }), { code: "RENEWAL_SEQUENCE_COPY_REQUIRED" });
});

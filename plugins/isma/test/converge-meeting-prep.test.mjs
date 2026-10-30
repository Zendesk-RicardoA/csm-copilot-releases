import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ConvergeMeetingPrepBridge, convergeCallWindow } from "../mcp/converge-meeting-prep.mjs";
import { createConvergeMeetingPrepCase } from "../mcp/real-beta.mjs";

const account = { accountId: "001000000000000AAA", accountName: "Invented Orchard" };
const ownerRef = "invented-operator";
const call = { conversation_key: "opaque:invented/key-123", call_start_datetime: "2026-08-11T09:30:00Z", summary: "Invented routing discussion" };
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function start(bridge, extra = {}) {
  return bridge.start({ ownerRef, account, startDate: "2026-08-01", endDate: "2026-08-31", ...extra });
}
function picked(bridge) {
  const lookup = start(bridge);
  const result = bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef, calls: [call], truncated: false });
  const selection = result.runtimeSelectionByRef.get(result.candidates[0].call_selection_ref);
  const record = createConvergeMeetingPrepCase({ sourceDigest: hash(`gong-call:${call.conversation_key}`), language: "en", testerId: ownerRef,
    manifest: { package_version: "invented-1", renderer_baseline: "recovery-v3" }, caseId: "invented-case" });
  record.account_ref_digest = hash(`account:${account.accountId}`);
  return { selection, record };
}
function readInput(bridge) {
  const { selection, record } = picked(bridge);
  const request = bridge.selectedRead({ ownerRef, caseId: record.case_id, selection, sourceDigest: record.source_locator_digest });
  return { ref: request.call_read_ref, ownerRef, caseRecord: record, sourceStatus: "transcript_available", linkedAccountIds: [account.accountId],
    sourceResultDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), findingCount: 2, warningCodes: [] };
}

test("Converge filters cover Lisbon days, inclusive end bounds, and daylight-saving transitions", () => {
  assert.deepEqual(convergeCallWindow({ startDate: "2026-08-01", endDate: "2026-08-31" }), {
    start_datetime: "2026-07-31T23:00:00.000Z", end_datetime: "2026-08-31T22:59:59.999Z",
  });
  assert.deepEqual(convergeCallWindow({ startDate: "2026-03-28", endDate: "2026-03-29" }), {
    start_datetime: "2026-03-28T00:00:00.000Z", end_datetime: "2026-03-29T22:59:59.999Z",
  });
  assert.throws(() => convergeCallWindow({ startDate: "2026-08-01", endDate: "2026-09-01" }), { code: "INVALID_CALL_DATE_RANGE" });
});

test("list and keyword search always carry the verified account unchanged", () => {
  const bridge = new ConvergeMeetingPrepBridge();
  assert.equal(start(bridge).native_request.arguments.identifier, account.accountId);
  assert.throws(() => start(bridge, { query: "routing automation" }), { code: "CONVERGE_KEYWORD_FILTER_NOT_REQUESTED" });
  const search = start(bridge, { query: "routing automation", keywordSearchRequested: true }).native_request;
  assert.equal(search.tool, "search_customer_calls");
  assert.equal(search.arguments.crm_account_id, account.accountId);
  assert.equal(search.arguments.query, "routing automation");
  for (const id of ["006000000000000AAA", "001000000000000", "guessed"]) {
    assert.throws(() => start(bridge, { account: { ...account, accountId: id } }), { code: "CONVERGE_ACCOUNT_ID_REQUIRED" });
  }
});

test("pagination keeps start/account filters, deduplicates boundary rows, and does not auto-select", () => {
  const bridge = new ConvergeMeetingPrepBridge();
  const lookup = start(bridge);
  const page = bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef, calls: [call], truncated: true });
  assert.equal(page.status, "converge_lookup_required");
  assert.equal(page.native_request.arguments.end_datetime, call.call_start_datetime);
  assert.equal(page.native_request.arguments.start_datetime, lookup.native_request.arguments.start_datetime);
  assert.equal(page.native_request.arguments.identifier, account.accountId);
  const older = { ...call, conversation_key: "older/invented/key", call_start_datetime: "2026-08-02T08:00:00Z" };
  const done = bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef, calls: [call, older], truncated: false });
  assert.equal(done.status, "call_selection_required");
  assert.equal(done.candidates.length, 2);
  assert.equal(done.truncated, false);
  assert.doesNotMatch(JSON.stringify(done), /opaque:invented\/key|001000000000000AAA/);
  assert.equal(done.runtimeSelectionByRef.size, 2);
});

test("stalled paging and malformed/truncated responses are gaps, not empty results", () => {
  const bridge = new ConvergeMeetingPrepBridge();
  const lookup = start(bridge);
  bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef, calls: [call], truncated: true });
  assert.throws(() => bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef, calls: [call], truncated: true }), { code: "CONVERGE_PAGINATION_STALLED" });
  const next = start(bridge);
  assert.throws(() => bridge.acceptPage({ ref: next.converge_lookup_ref, ownerRef, calls: [], truncated: "true" }), { code: "CONVERGE_RESPONSE_INVALID" });
  assert.throws(() => bridge.acceptPage({ ref: next.converge_lookup_ref, ownerRef, calls: [{ ...call, transcript: "invented raw text" }], truncated: false }), { code: "CONVERGE_RESPONSE_INVALID" });
  assert.throws(() => bridge.acceptPage({ ref: next.converge_lookup_ref, ownerRef, calls: [{ ...call, summary: "x".repeat(6001) }], truncated: false }), { code: "CONVERGE_METADATA_OVERFLOW" });
  assert.throws(() => bridge.acceptPage({ ref: next.converge_lookup_ref, ownerRef, calls: [{ ...call, call_start_datetime: "2026-09-01T00:00:00Z" }], truncated: false }), { code: "CONVERGE_RESPONSE_INVALID" });
});

test("empty native result stays bounded, includes lag, and creates no selection", () => {
  const bridge = new ConvergeMeetingPrepBridge();
  const lookup = start(bridge);
  const result = bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef, calls: [], truncated: false });
  assert.equal(result.status, "no_candidates");
  assert.equal(result.source_lag_hours, 24);
  assert.equal(result.runtimeSelectionByRef.size, 0);
});

test("approved Converge case makes no fabricated recording/safety assertions", () => {
  const { record } = picked(new ConvergeMeetingPrepBridge());
  assert.deepEqual(record.transcript_eligibility, { selected_by_csm: true, provider: "Converge",
    approval_basis: "approved_mcp_capabilities", secondary_processing_authorized: true });
  assert.deepEqual(record.approvals, []);
  assert.equal(record.derived_evidence, null);
});

test("full native call is requested by exact key, accepts multi-account association, and issues a content-free receipt", () => {
  const bridge = new ConvergeMeetingPrepBridge();
  const { selection, record } = picked(bridge);
  const request = bridge.selectedRead({ ownerRef, caseId: record.case_id, selection, sourceDigest: record.source_locator_digest });
  assert.equal(request.native_request.tool, "get_customer_call");
  assert.deepEqual(request.native_request.arguments, { conversation_key: call.conversation_key });
  const input = readInput(bridge);
  const receipt = bridge.evidenceReceipt({ ...input, linkedAccountIds: ["001000000000001AAA", account.accountId] });
  assert.match(receipt.evidence_digest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.finding_count, 2);
  assert.equal(receipt.case_id, input.caseRecord.case_id);
  assert.equal(receipt.package_version, "invented-1");
  assert.equal(receipt.approval_basis, "approved_mcp_capabilities");
  assert.doesNotMatch(JSON.stringify(receipt), /Invented Orchard|001000000000000AAA|opaque:invented\/key|summary|transcript:/);
});

test("full native result must match the selected account and case", () => {
  const bridge = new ConvergeMeetingPrepBridge();
  const input = readInput(bridge);
  assert.throws(() => bridge.evidenceReceipt({ ...input, linkedAccountIds: ["001000000000001AAA"] }), { code: "SELECTED_CALL_ACCOUNT_MISMATCH" });
  assert.throws(() => bridge.evidenceReceipt({ ...input, caseRecord: { ...input.caseRecord, case_id: "other-case" } }), { code: "SELECTED_CALL_ACCOUNT_MISMATCH" });
  assert.throws(() => bridge.evidenceReceipt({ ...input, sourceResultDigest: "raw content" }), { code: "CONVERGE_EVIDENCE_RECEIPT_INVALID" });
});

for (const sourceStatus of ["transcript_missing", "not_found", "source_failed"]) {
  test(`native ${sourceStatus} cannot bind summary-only evidence`, () => {
    const bridge = new ConvergeMeetingPrepBridge();
    const input = readInput(bridge);
    assert.throws(() => bridge.evidenceReceipt({ ...input, sourceStatus }), { code: "CONVERGE_CALL_SOURCE_GAP" });
    assert.equal(bridge.reads.size, 0);
  });
}

test("expiry, owner mismatch, restart, and consumed reads cannot reuse native references", () => {
  let now = 1000;
  const bridge = new ConvergeMeetingPrepBridge({ now: () => now });
  const lookup = start(bridge);
  assert.throws(() => bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef: "other", calls: [], truncated: false }), { code: "CONVERGE_REFERENCE_EXPIRED" });
  const input = readInput(bridge);
  assert.throws(() => new ConvergeMeetingPrepBridge().evidenceReceipt(input), { code: "CONVERGE_REFERENCE_EXPIRED" });
  bridge.finishRead(input.ref);
  assert.throws(() => bridge.evidenceReceipt(input), { code: "CONVERGE_REFERENCE_EXPIRED" });
  now += 15 * 60_000 + 1;
  assert.throws(() => bridge.acceptPage({ ref: lookup.converge_lookup_ref, ownerRef, calls: [], truncated: false }), { code: "CONVERGE_REFERENCE_EXPIRED" });
});

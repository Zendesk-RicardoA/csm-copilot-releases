import crypto from "node:crypto";
import { BetaError } from "./core.mjs";
import { requireMeetingPrepCallDateRange } from "./meeting-prep-call-selection.mjs";

export const CONVERGE_HOST_TOOLS = Object.freeze([
  "Converge.list_customer_calls", "Converge.search_customer_calls", "Converge.get_customer_call",
]);
const ACCOUNT_ID = /^001[A-Za-z0-9]{15}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TTL_MS = 15 * 60_000;
const PAGE_SIZE = 50;
const MAX_CALLS = 1000;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function accountId(value) {
  if (typeof value !== "string" || !ACCOUNT_ID.test(value)) {
    throw new BetaError("CONVERGE_ACCOUNT_ID_REQUIRED", "Converge needs the verified 18-character Salesforce Account ID, unchanged.");
  }
  return value;
}

function opaqueKey(value) {
  if (typeof value !== "string" || !value.length || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BetaError("CONVERGE_CALL_REFERENCE_INVALID", "Use the conversation key returned by Converge unchanged.");
  }
  return value;
}

// The native connector has inclusive datetime filters. Preserve Lisbon calendar
// days across DST and end one millisecond before the next local midnight.
function lisbonMidnight(date) {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  let guess = midnight;
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(guess).map(({ type, value }) => [type, value]));
    const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    guess += midnight - local;
  }
  return guess;
}

export function convergeCallWindow({ startDate, endDate }) {
  const range = requireMeetingPrepCallDateRange({ startDate, endDate });
  return {
    start_datetime: new Date(lisbonMidnight(range.startDate)).toISOString(),
    end_datetime: new Date(lisbonMidnight(range.endExclusiveDate) - 1).toISOString(),
  };
}

/** Host calls the authenticated native MCP. This bridge keeps only temporary
 * scope/selection references, not credentials, transcripts, or durable exports.
 * Native result projection is performed by the host; arbitrary raw tool output
 * must never be passed to these control methods. */
export class ConvergeMeetingPrepBridge {
  constructor({ now = () => Date.now(), randomUUID = crypto.randomUUID } = {}) {
    this.now = now;
    this.randomUUID = randomUUID;
    this.lookups = new Map();
    this.reads = new Map();
  }

  prune() {
    for (const map of [this.lookups, this.reads]) {
      for (const [ref, record] of map) if (record.expiresAt <= this.now()) map.delete(ref);
    }
  }

  retain(map, ref, value) {
    map.set(ref, value);
    const timer = setTimeout(() => this.prune(), Math.max(1, value.expiresAt - this.now() + 1));
    timer.unref?.();
  }

  require(map, ref, ownerRef) {
    this.prune();
    const value = map.get(ref);
    if (!value || value.ownerRef !== ownerRef) {
      throw new BetaError("CONVERGE_REFERENCE_EXPIRED", "The temporary Converge reference expired or is unavailable after a restart. Repeat the original lookup and choose a call again.");
    }
    return value;
  }

  request(lookup) {
    return {
      provider: "Converge",
      tool: lookup.query ? "search_customer_calls" : "list_customer_calls",
      arguments: {
        ...(lookup.query ? { query: lookup.query, crm_account_id: lookup.accountId } : { identifier: lookup.accountId }),
        start_datetime: lookup.start_datetime, end_datetime: lookup.end_datetime, limit: PAGE_SIZE,
      },
    };
  }

  start({ ownerRef, account, startDate, endDate, query, keywordSearchRequested = false }) {
    this.prune();
    if (query && keywordSearchRequested !== true) throw new BetaError("CONVERGE_KEYWORD_FILTER_NOT_REQUESTED", "List calls in the requested window; use keywords only when the CSM explicitly requested a keyword search.");
    if (query != null && (typeof query !== "string" || !query.trim() || query.length > 500)) {
      throw new BetaError("INVALID_INPUT", "Use bounded search keywords, or omit them to list calls.");
    }
    const ref = this.randomUUID();
    const lookup = {
      ownerRef, accountId: accountId(account.accountId), accountName: account.accountName,
      ...convergeCallWindow({ startDate, endDate }), query: query || null,
      calls: new Map(), expiresAt: this.now() + TTL_MS,
    };
    this.retain(this.lookups, ref, lookup);
    return { status: "converge_lookup_required", converge_lookup_ref: ref, account_name: account.accountName,
      native_request: this.request(lookup), source_lag_hours: 24 };
  }

  acceptPage({ ref, ownerRef, calls, truncated }) {
    const lookup = this.require(this.lookups, ref, ownerRef);
    if (!Array.isArray(calls) || calls.length > PAGE_SIZE || typeof truncated !== "boolean") {
      throw new BetaError("CONVERGE_RESPONSE_INVALID", "Converge did not return a valid bounded call batch.");
    }
    const normalized = calls.map((call) => {
      if (!call || Object.keys(call).some((key) => !["conversation_key", "call_start_datetime", "title", "summary"].includes(key))) {
        throw new BetaError("CONVERGE_RESPONSE_INVALID", "Pass only call metadata, never transcript text, into the picker control.");
      }
      const key = opaqueKey(call.conversation_key);
      const at = Date.parse(call.call_start_datetime);
      if (!Number.isFinite(at) || at < Date.parse(lookup.start_datetime) || at > Date.parse(lookup.end_datetime)) {
        throw new BetaError("CONVERGE_RESPONSE_INVALID", "A returned call is outside the requested date window.");
      }
      for (const [field, max] of [["title", 500], ["summary", 6000]]) {
        if (call[field] != null && (typeof call[field] !== "string" || call[field].length > max)) {
          throw new BetaError("CONVERGE_METADATA_OVERFLOW", "Call metadata exceeds the picker limit; do not silently shorten it.");
        }
      }
      return { ...call, conversation_key: key, at };
    });
    if (normalized.some((call, index) => index > 0 && call.at > normalized[index - 1].at)) {
      throw new BetaError("CONVERGE_RESPONSE_INVALID", "Converge call batches must be newest first.");
    }
    for (const call of normalized) lookup.calls.set(call.conversation_key, call);
    if (lookup.calls.size > MAX_CALLS) {
      this.lookups.delete(ref);
      throw new BetaError("CONVERGE_CALL_OVERFLOW", "More than 1,000 calls matched; narrow the search. No complete picker was returned.");
    }
    if (truncated) {
      const oldest = normalized.at(-1);
      if (!oldest || oldest.at >= Date.parse(lookup.end_datetime)) {
        this.lookups.delete(ref);
        throw new BetaError("CONVERGE_PAGINATION_STALLED", "The connector cannot page further within this window. The lookup is incomplete, not an empty result.");
      }
      // Inclusive paging can repeat the boundary row; the map deduplicates keys.
      lookup.end_datetime = oldest.call_start_datetime;
      return { status: "converge_lookup_required", converge_lookup_ref: ref,
        returned_count: lookup.calls.size, native_request: this.request(lookup), source_lag_hours: 24 };
    }
    const selections = new Map();
    const candidates = [...lookup.calls.values()].sort((a, b) => b.at - a.at).map((call) => {
      const selectionRef = this.randomUUID();
      selections.set(selectionRef, { provider: "Converge", conversationKey: call.conversation_key,
        accountId: lookup.accountId, accountName: lookup.accountName, callAt: call.call_start_datetime });
      return { call_selection_ref: selectionRef, call_at: call.call_start_datetime,
        ...(call.title != null ? { title: call.title } : {}), ...(call.summary != null ? { summary: call.summary } : {}) };
    });
    this.lookups.delete(ref);
    const result = { status: candidates.length ? "call_selection_required" : "no_candidates",
      provider: "Converge", account_name: lookup.accountName, candidates, truncated: false, source_lag_hours: 24 };
    Object.defineProperty(result, "runtimeSelectionByRef", { value: selections });
    return result;
  }

  selectedRead({ ownerRef, caseId, selection, sourceDigest }) {
    const key = opaqueKey(selection.conversationKey);
    if (sourceDigest !== hash(`gong-call:${key}`)) throw new BetaError("SELECTED_CALL_ACCOUNT_MISMATCH", "The case and selected call do not match.");
    this.prune();
    const existing = [...this.reads.entries()].find(([, read]) => read.ownerRef === ownerRef && read.caseId === caseId && read.sourceDigest === sourceDigest);
    if (existing) return { status: "read_request_already_issued", call_read_ref: existing[0],
      next_action: "Use the existing native request/result for analysis and binding. Do not fetch the selected transcript again." };
    const ref = existing?.[0] || this.randomUUID();
    if (!existing) {
      this.retain(this.reads, ref, { ownerRef, caseId, sourceDigest, accountId: accountId(selection.accountId), timezoneMissing: !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(selection.callAt || ""), expiresAt: this.now() + TTL_MS });
    }
    return { call_read_ref: ref, native_request: { provider: "Converge", tool: "get_customer_call", arguments: { conversation_key: key } },
      expected_account_id: selection.accountId };
  }

  evidenceReceipt({ ref, ownerRef, caseRecord, sourceStatus, linkedAccountIds, sourceResultDigest, evidenceDigest, findingCount, warningCodes = [] }) {
    const read = this.require(this.reads, ref, ownerRef);
    if (read.caseId !== caseRecord.case_id || read.sourceDigest !== caseRecord.source_locator_digest ||
        hash(`account:${read.accountId}`) !== caseRecord.account_ref_digest) {
      throw new BetaError("SELECTED_CALL_ACCOUNT_MISMATCH", "The native call read belongs to a different case or account.");
    }
    if (sourceStatus !== "transcript_available") {
      this.reads.delete(ref);
      throw new BetaError("CONVERGE_CALL_SOURCE_GAP", "Converge did not return a usable full selected-call transcript. Do not substitute its summary.", { source_status: sourceStatus });
    }
    if (!Array.isArray(linkedAccountIds) || linkedAccountIds.some((id) => !ACCOUNT_ID.test(id)) || !linkedAccountIds.includes(read.accountId)) {
      throw new BetaError("SELECTED_CALL_ACCOUNT_MISMATCH", "The full call's account associations do not include the selected account.");
    }
    if (![sourceResultDigest, evidenceDigest].every((value) => DIGEST.test(value || "")) ||
        !Number.isInteger(findingCount) || findingCount < 0 || findingCount > 500 ||
        !Array.isArray(warningCodes) || warningCodes.some((code) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(code))) {
      throw new BetaError("CONVERGE_EVIDENCE_RECEIPT_INVALID", "Bind only valid native-result and paraphrased-evidence digests, counts, and warning codes.");
    }
    const receipt = { provider: "Converge", approval_basis: "approved_mcp_capabilities",
      case_id: caseRecord.case_id, package_version: caseRecord.package_version,
      source_locator_digest: read.sourceDigest, account_ref_digest: caseRecord.account_ref_digest,
      source_result_digest: sourceResultDigest, findings_digest: evidenceDigest, finding_count: findingCount,
      warning_codes: [...new Set([...warningCodes, ...(read.timezoneMissing ? ["CALL_TIMEZONE_NOT_RETURNED"] : [])])], processing_boundary: "authenticated_native_mcp_and_desktop_host" };
    return { ...receipt, evidence_digest: hash(JSON.stringify(receipt)) };
  }

  finishRead(ref) {
    const selected = this.reads.get(ref);
    for (const [key, read] of this.reads) {
      if (key === ref || (selected && read.caseId === selected.caseId && read.ownerRef === selected.ownerRef)) this.reads.delete(key);
    }
  }
}

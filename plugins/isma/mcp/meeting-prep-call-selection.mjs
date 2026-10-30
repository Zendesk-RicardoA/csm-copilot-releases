import crypto from "node:crypto";

import { BetaError } from "./core.mjs";

export const MEETING_PREP_CALL_CANDIDATE_LIMIT = 12;
// These are deliberately capability-specific. The CTA queue's interactive
// deadline is not a global Snowflake rule: an inclusive 31-day Gong search is
// a larger metadata read with a separately measured deadline.
export const MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS = 90_000;
// A one-day search uses the same account-linked Gong statement as a range;
// narrowing the date does not remove its join/compilation cost. A controlled
// one-day read took 93.7 seconds, so 120 seconds leaves operational headroom.
export const MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS = 120_000;
export const MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS = 100_000;
export const MEETING_PREP_CALL_ID_RESOLUTION_READ_TIMEOUT_MS = 25_000;
export const MEETING_PREP_CALL_LINK_VALIDATION_READ_TIMEOUT_MS = 100_000;
export const MEETING_PREP_CALL_DATE_RANGE_MAX_DAYS = 31;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GONG_CALL_ID = /^\d{8,30}$/;
const GONG_CONVERSATION_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const SALESFORCE_ACCOUNT_ID = /^[A-Za-z0-9]{15,18}$/;
const MAX_ACCOUNT_NAME_LENGTH = 160;

function field(row, name) {
  return row[name] ?? row[name.toLowerCase()] ?? null;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requireAccountName(accountName) {
  if (typeof accountName !== "string" || !accountName.trim() || accountName.trim().length > MAX_ACCOUNT_NAME_LENGTH) {
    throw new BetaError("INVALID_ACCOUNT_NAME", "Provide an account name or Salesforce account ID of up to 160 characters.");
  }
  return accountName.trim();
}

function requireCallDate(callDate) {
  const parsed = typeof callDate === "string" && ISO_DATE.test(callDate)
    ? new Date(`${callDate}T00:00:00Z`)
    : null;
  if (!parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== callDate) {
    throw new BetaError("INVALID_CALL_DATE", "Use a complete call date in YYYY-MM-DD format.");
  }
  return callDate;
}

function nextLisbonDate(callDate) {
  const date = new Date(`${callDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function requireMeetingPrepCallDateRange({ startDate, endDate }) {
  const start = requireCallDate(startDate);
  const end = requireCallDate(endDate);
  const startAt = new Date(`${start}T00:00:00Z`);
  const endAt = new Date(`${end}T00:00:00Z`);
  const inclusiveDays = Math.floor((endAt - startAt) / 86_400_000) + 1;
  if (inclusiveDays < 1 || inclusiveDays > MEETING_PREP_CALL_DATE_RANGE_MAX_DAYS) {
    throw new BetaError(
      "INVALID_CALL_DATE_RANGE",
      `Use a Europe/Lisbon call window from one to ${MEETING_PREP_CALL_DATE_RANGE_MAX_DAYS} calendar days.`,
    );
  }
  return { startDate: start, endDate: end, endExclusiveDate: nextLisbonDate(end), inclusiveDays };
}

function requireConversationKey(conversationKey) {
  const value = String(conversationKey || "").trim();
  if (!GONG_CONVERSATION_KEY.test(value)) {
    throw new BetaError("INVALID_GONG_CALL_REFERENCE", "The Gong conversation reference is invalid.");
  }
  return value;
}

function requireGongCallId(callId) {
  const value = String(callId || "").trim();
  if (!GONG_CALL_ID.test(value)) {
    throw new BetaError("INVALID_GONG_CALL_REFERENCE", "The Gong link call ID is invalid.");
  }
  return value;
}

function requireAccountId(accountId) {
  const value = String(accountId || "").trim();
  if (!SALESFORCE_ACCOUNT_ID.test(value)) {
    throw new BetaError("MEETING_PREP_ACCOUNT_RESPONSE_INVALID", "The selected account could not be used safely for the Gong search.");
  }
  return value;
}

/**
 * Resolve a name or Salesforce ID within the authenticated CSM's book first.
 * Salesforce owns the account display name; Gainsight owns book membership.
 * A unique brand fragment is useful for discovery, but multiple matches must
 * be shown for an explicit account choice before any Gong lookup.
 */
export function buildMeetingPrepAccountScopeSql({ accountName }) {
  const name = sqlLiteral(requireAccountName(accountName));
  return `
WITH current_user_candidates AS (
  SELECT GSID
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV
  WHERE LOWER(EMAIL) = LOWER(CURRENT_USER())
), scope AS (
  SELECT COUNT(*) AS scope_count FROM current_user_candidates
), authenticated_csm AS (
  SELECT candidate.GSID
  FROM current_user_candidates AS candidate
  CROSS JOIN scope
  WHERE scope.scope_count = 1
), in_book_accounts AS (
  SELECT DISTINCT
    company.SFDC_ACCOUNT_ID AS account_id,
    account.NAME AS salesforce_name,
    company.NAME AS gainsight_name
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
  JOIN authenticated_csm
    ON company.SUCCESS_OWNER_C_GC = authenticated_csm.GSID
  JOIN CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS account
    ON company.SFDC_ACCOUNT_ID = account.ID
  WHERE company.SFDC_ACCOUNT_ID IS NOT NULL
), scored_accounts AS (
  SELECT
    account_id,
    COALESCE(NULLIF(TRIM(salesforce_name), ''), NULLIF(TRIM(gainsight_name), ''), 'Unnamed account') AS account_name,
    CASE
      WHEN UPPER(account_id) = UPPER(TRIM(${name})) THEN 0
      WHEN UPPER(TRIM(salesforce_name)) = UPPER(TRIM(${name})) THEN 1
      WHEN UPPER(TRIM(gainsight_name)) = UPPER(TRIM(${name})) THEN 2
      WHEN CONTAINS(UPPER(TRIM(salesforce_name)), UPPER(TRIM(${name}))) THEN 3
      WHEN CONTAINS(UPPER(TRIM(gainsight_name)), UPPER(TRIM(${name}))) THEN 4
      ELSE 5
    END AS match_rank
  FROM in_book_accounts
), matched_accounts AS (
  SELECT account_id, account_name, MIN(match_rank) AS match_rank
  FROM scored_accounts
  WHERE match_rank < 5
  GROUP BY account_id, account_name
), best_match_rank AS (
  SELECT MIN(match_rank) AS match_rank FROM matched_accounts
), best_accounts AS (
  SELECT matched.account_id, matched.account_name
  FROM matched_accounts AS matched
  JOIN best_match_rank AS best ON matched.match_rank = best.match_rank
), match_count AS (
  SELECT COUNT(*) AS account_match_count FROM best_accounts
), bounded_accounts AS (
  SELECT account_id, account_name
  FROM best_accounts
  ORDER BY account_name, account_id
  LIMIT 12
)
SELECT
  'scope' AS row_type,
  scope.scope_count,
  match_count.account_match_count,
  NULL::STRING AS account_id,
  NULL::STRING AS account_name
FROM scope
CROSS JOIN match_count
UNION ALL
SELECT
  'account' AS row_type,
  1 AS scope_count,
  match_count.account_match_count,
  account_id,
  account_name
FROM bounded_accounts
CROSS JOIN match_count
ORDER BY CASE row_type WHEN 'scope' THEN 0 ELSE 1 END, account_name, account_id`.trim();
}

function baseAccountCallSql({ accountId, accountActivityFilterSql, participantCallFilterSql }) {
  const id = sqlLiteral(requireAccountId(accountId));
  return `
WITH selected_account AS (
  SELECT ID AS account_id, NAME AS account_name
  FROM CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV
  WHERE ID = ${id}
), account_contacts AS (
  SELECT contact.ID AS contact_id
  FROM CLEANSED.SALESFORCE.SALESFORCE_CONTACT_FORMULA_BCV AS contact
  JOIN selected_account AS account ON contact.ACCOUNT_ID = account.account_id
), account_activity_call_keys AS (
  SELECT DISTINCT TO_VARCHAR(activity.GONG_CONVERSATION_KEY) AS conversation_key
  FROM PRESENTATION.BULLSEYE_PRO.SALES_ACTIVITY AS activity
  JOIN selected_account AS account ON activity.CRM_ACCOUNT_ID = account.account_id
  WHERE activity.GONG_CONVERSATION_KEY IS NOT NULL
    AND ${accountActivityFilterSql}
), participant_contact_call_keys AS (
  SELECT DISTINCT TO_VARCHAR(participant.CONVERSATION_KEY) AS conversation_key
  FROM CLEANSED.GONG.GONG_CONVERSATION_PARTICIPANTS_BCV AS participant
  JOIN account_contacts AS contact ON participant.ASSOCIATED_OBJECT_ID = contact.contact_id
  JOIN FOUNDATIONAL.ENTERPRISE_MART.MART_GONG_CALLS_BCV AS participant_call
    ON participant.CONVERSATION_KEY = participant_call.GONG_CONVERSATION_KEY
  WHERE participant.AFFILIATION = 'External'
    AND ${participantCallFilterSql}
), reliably_matched_call_keys AS (
  SELECT conversation_key FROM account_activity_call_keys
  UNION
  SELECT conversation_key FROM participant_contact_call_keys
)`;
}

function queryRowsSql({ accountId, callFilterSql, accountActivityFilterSql, participantCallFilterSql }) {
  return `${baseAccountCallSql({ accountId, accountActivityFilterSql, participantCallFilterSql })}, matched_calls AS (
  SELECT DISTINCT
    account.account_id,
    account.account_name,
    TO_VARCHAR(call.GONG_CONVERSATION_KEY) AS conversation_key,
    call.GONG_CALL_EFFECTIVE_START_DATETIME AS call_at,
    TO_VARCHAR(call.GONG_CALL_STATUS) AS call_status,
    TO_VARCHAR(call.GONG_CALL_DISPOSITION) AS call_disposition,
    TO_VARCHAR(call.GONG_CALL_SCOPE) AS call_scope,
    TO_VARCHAR(call.GONG_CALL_SPOTLIGHT_BRIEF) AS spotlight_brief,
    TO_VARCHAR(call.GONG_CALL_SPOTLIGHT_OUTCOME) AS spotlight_outcome,
    TO_VARCHAR(call.GONG_CALL_SPOTLIGHT_KEY_POINTS) AS spotlight_key_points,
    TO_VARCHAR(call.GONG_CALL_SPOTLIGHT_NEXT_STEPS) AS spotlight_next_steps,
    TO_VARCHAR(call.GONG_CALL_SPOTLIGHT_TYPE) AS spotlight_type,
    TO_VARCHAR(call.GONG_CALL_TRACKERS) AS trackers,
    call.HAS_CALL_RECORDING AS has_call_recording,
    call.ZDP_META_UPDATED_AT_TIMESTAMP AS source_updated_at
  FROM FOUNDATIONAL.ENTERPRISE_MART.MART_GONG_CALLS_BCV AS call
  JOIN reliably_matched_call_keys AS matched
    ON TO_VARCHAR(call.GONG_CONVERSATION_KEY) = matched.conversation_key
  JOIN selected_account AS account ON TRUE
  WHERE ${callFilterSql}
), bounded_calls AS (
  SELECT *
  FROM matched_calls
  QUALIFY ROW_NUMBER() OVER (ORDER BY call_at DESC NULLS LAST, conversation_key DESC) <= ${MEETING_PREP_CALL_CANDIDATE_LIMIT}
)
SELECT
  'call' AS row_type,
  1 AS scope_count,
  account_id, account_name, conversation_key, call_at,
  call_status, call_disposition, call_scope, spotlight_brief, spotlight_outcome,
  spotlight_key_points, spotlight_next_steps, spotlight_type, trackers,
  has_call_recording, source_updated_at
FROM bounded_calls
ORDER BY
  call_at DESC NULLS LAST,
  conversation_key DESC`.trim();
}

/**
 * Finds only account-matched, metadata-only Gong candidates for a bounded
 * inclusive local Lisbon date range. The CTA queue is deliberately absent:
 * direct meeting preparation is not an Account Prioritization workflow.
 */
export function buildMeetingPrepCallCandidatesRangeSql({ accountId, startDate, endDate }) {
  const range = requireMeetingPrepCallDateRange({ startDate, endDate });
  const startAt = `CONVERT_TIMEZONE('Europe/Lisbon', 'UTC', ${sqlLiteral(`${range.startDate} 00:00:00`)}::TIMESTAMP_NTZ)`;
  const endAt = `CONVERT_TIMEZONE('Europe/Lisbon', 'UTC', ${sqlLiteral(`${range.endExclusiveDate} 00:00:00`)}::TIMESTAMP_NTZ)`;
  return queryRowsSql({
    accountId,
    callFilterSql: `call.GONG_CALL_EFFECTIVE_START_DATETIME >= ${startAt}
    AND call.GONG_CALL_EFFECTIVE_START_DATETIME < ${endAt}`,
    accountActivityFilterSql: `activity.ACTIVITY_DATETIME >= ${startAt}
    AND activity.ACTIVITY_DATETIME < ${endAt}`,
    participantCallFilterSql: `participant_call.GONG_CALL_EFFECTIVE_START_DATETIME >= ${startAt}
    AND participant_call.GONG_CALL_EFFECTIVE_START_DATETIME < ${endAt}`,
  });
}

/** Builds the one-day version of the bounded date-range search. */
export function buildMeetingPrepCallCandidatesSql({ accountId, callDate }) {
  const date = requireCallDate(callDate);
  return buildMeetingPrepCallCandidatesRangeSql({ accountId, startDate: date, endDate: date });
}

/**
 * A pasted Gong call URL is a CSM selection, not a source of truth. Its id is
 * used only as a transient key in the same account-scoped, metadata-only
 * query; the URL itself is never placed in SQL, a result, or case state.
 */
export function parseGongCallUrl(gongCallUrl) {
  if (typeof gongCallUrl !== "string" || gongCallUrl.length > 2048) {
    throw new BetaError("INVALID_GONG_CALL_URL", "Provide a valid Gong call link.");
  }
  let parsed;
  try {
    parsed = new URL(gongCallUrl);
  } catch (_error) {
    throw new BetaError("INVALID_GONG_CALL_URL", "Provide a valid Gong call link.");
  }
  const validHost = /^[a-z0-9-]+\.app\.gong\.io$/i.test(parsed.hostname);
  if (
    parsed.protocol !== "https:"
    || !validHost
    || parsed.username
    || parsed.password
    || !/^\/call\/?$/i.test(parsed.pathname)
  ) {
    throw new BetaError("INVALID_GONG_CALL_URL", "Provide a valid Gong call link.");
  }
  return requireGongCallId(parsed.searchParams.get("id"));
}

/** Map the pasted URL's numeric call ID to its distinct opaque source key. */
export function buildMeetingPrepGongCallIdResolutionSql({ callId }) {
  return `SELECT DISTINCT TO_VARCHAR(CONVERSATION_KEY) AS conversation_key
FROM CLEANSED.GONG.GONG_CALLS_BCV
WHERE TO_VARCHAR(CONVERSATION_ID) = ${sqlLiteral(requireGongCallId(callId))}
LIMIT 3`;
}

export function buildMeetingPrepCallLinkValidationSql({ accountId, conversationKey }) {
  const key = sqlLiteral(requireConversationKey(conversationKey));
  return queryRowsSql({
    accountId,
    callFilterSql: `TO_VARCHAR(call.GONG_CONVERSATION_KEY) = ${key}`,
    accountActivityFilterSql: `TO_VARCHAR(activity.GONG_CONVERSATION_KEY) = ${key}`,
    participantCallFilterSql: `TO_VARCHAR(participant_call.GONG_CONVERSATION_KEY) = ${key}`,
  });
}

function recordingPresent(value) {
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

function candidateFromRow(row, selectionRef) {
  const conversationKey = requireConversationKey(field(row, "CONVERSATION_KEY"));
  const hasRecording = recordingPresent(field(row, "HAS_CALL_RECORDING"));
  return {
    runtime: {
      conversationKey,
      accountId: field(row, "ACCOUNT_ID"),
      accountName: field(row, "ACCOUNT_NAME"),
      hasCallRecording: hasRecording,
      callAt: field(row, "CALL_AT"),
    },
    display: {
      call_selection_ref: selectionRef,
      call_at: field(row, "CALL_AT"),
      recording_state: hasRecording ? "present" : "not_present",
      call_status: field(row, "CALL_STATUS"),
      call_disposition: field(row, "CALL_DISPOSITION"),
      call_scope: field(row, "CALL_SCOPE"),
      spotlight_brief: field(row, "SPOTLIGHT_BRIEF"),
      spotlight_outcome: field(row, "SPOTLIGHT_OUTCOME"),
      spotlight_key_points: field(row, "SPOTLIGHT_KEY_POINTS"),
      spotlight_next_steps: field(row, "SPOTLIGHT_NEXT_STEPS"),
      spotlight_type: field(row, "SPOTLIGHT_TYPE"),
      trackers: field(row, "TRACKERS"),
      source_updated_at: field(row, "SOURCE_UPDATED_AT"),
    },
  };
}

/**
 * Converts the worker's transient rows to a CSM-safe picker. Conversation
 * keys are kept only in the non-serializable runtime map, never in result
 * content. A direct link is already a one-call CSM selection; a date or date
 * range search always leaves final selection to the CSM.
 */
export function presentMeetingPrepCallCandidates(rows, {
  callDate = null,
  callDateRange = null,
  selectionOrigin = "date_search",
  now = new Date(),
  createSelectionRef = () => crypto.randomUUID(),
} = {}) {
  if (!Array.isArray(rows)) {
    throw new BetaError("MEETING_PREP_CALL_RESPONSE_INVALID", "The Gong call candidates could not be read safely.");
  }
  const scope = rows.find((row) => field(row, "ROW_TYPE") === "scope");
  if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
    throw new BetaError("MEETING_PREP_SCOPE_UNAVAILABLE", "The signed-in Snowflake user does not map to one CSM profile, so no Gong calls were shown.");
  }
  const accounts = rows.filter((row) => field(row, "ROW_TYPE") === "account");
  if (accounts.length === 0) {
    return {
      status: "account_not_found",
      source: "Salesforce account identity scoped by the authenticated Gainsight CSM profile",
      next_action: "No in-book Salesforce or Gainsight account name matched that search. Gong was not searched. Try another known name or a Salesforce account ID; this does not establish that the account or call is absent.",
    };
  }
  const accountMatchCount = Number(field(scope, "ACCOUNT_MATCH_COUNT")) || accounts.length;
  if (accounts.length !== 1 || accountMatchCount !== 1) {
    return {
      status: "account_selection_required",
      account_match_count: accountMatchCount,
      accounts: accounts.map((row) => ({ account_display_name: field(row, "ACCOUNT_NAME") || "Unnamed account" })),
      next_action: "More than one in-book account matched. Choose the exact Salesforce account name or provide its account ID before searching Gong; no call has been opened.",
    };
  }

  const runtimeSelectionByRef = new Map();
  const dateSearchFields = callDateRange
    ? { call_date_range: { start_date: callDateRange.startDate, end_date: callDateRange.endDate, timezone: "Europe/Lisbon" } }
    : { call_date: callDate };
  const searchLabel = callDateRange ? "requested date range" : "requested date";
  const candidates = rows
    .filter((row) => field(row, "ROW_TYPE") === "call")
    .map((row) => {
      const selectionRef = createSelectionRef();
      const candidate = candidateFromRow(row, selectionRef);
      runtimeSelectionByRef.set(selectionRef, candidate.runtime);
      return candidate.display;
    });
  const result = candidates.length === 0
    ? {
      status: "no_candidates",
      account_display_name: field(accounts[0], "ACCOUNT_NAME") || "Selected account",
      ...dateSearchFields,
      source: `Account-linked Gong metadata for the ${searchLabel}`,
      next_action: "No account-linked call metadata matched this search window. Choose another date or date range, or paste the specific Gong call link; this does not establish that no meeting happened.",
    }
    : {
      status: selectionOrigin === "direct_link" ? "selected_call_verified" : "call_selection_required",
      account_display_name: field(accounts[0], "ACCOUNT_NAME") || "Selected account",
      ...dateSearchFields,
      candidates,
      source: "Account-linked Gong metadata for the authenticated CSM's book",
      next_action: selectionOrigin === "direct_link"
        ? "The pasted call is account-matched and its recording state was checked. Continue with this selected call; no Gong link is retained."
        : "Choose exactly one call from this short list. Once you choose, the existing call selection can be used directly without searching again. A matching date or summary never selects a call automatically.",
    };
  Object.defineProperty(result, "runtimeSelectionByRef", {
    enumerable: false,
    writable: false,
    value: runtimeSelectionByRef,
  });
  Object.defineProperty(result, "read_at", {
    enumerable: false,
    writable: false,
    value: now.toISOString(),
  });
  return result;
}

export function resolveMeetingPrepAccountScope(rows, { callDate = null, callDateRange = null, selectionOrigin = "date_search" } = {}) {
  if (!Array.isArray(rows)) {
    throw new BetaError("MEETING_PREP_CALL_RESPONSE_INVALID", "The account scope for the Gong call search could not be read safely.");
  }
  const scope = rows.find((row) => field(row, "ROW_TYPE") === "scope");
  if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
    throw new BetaError("MEETING_PREP_SCOPE_UNAVAILABLE", "The signed-in Snowflake user does not map to one CSM profile, so no Gong calls were shown.");
  }
  const accounts = rows.filter((row) => field(row, "ROW_TYPE") === "account");
  const accountMatchCount = Number(field(scope, "ACCOUNT_MATCH_COUNT")) || accounts.length;
  if (accounts.length !== 1 || accountMatchCount !== 1) {
    return { finalResult: presentMeetingPrepCallCandidates(rows, { callDate, callDateRange, selectionOrigin }), account: null };
  }
  const account = accounts[0];
  return {
    finalResult: null,
    account: {
      accountId: requireAccountId(field(account, "ACCOUNT_ID")),
      accountName: field(account, "ACCOUNT_NAME") || "Selected account",
    },
  };
}

function meetingPrepReadFailure(error, { stage, timeoutMs }) {
  if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_START_TIMEOUT") {
    return new BetaError("SNOWFLAKE_SIGN_IN_REQUIRED", "Snowflake/ZDP did not start this read. Complete browser sign-in, then try again.");
  }
  if (error instanceof BetaError && error.code === "SNOWFLAKE_SESSION_TIMEOUT") {
    const seconds = timeoutMs / 1000;
    const message = stage === "account_scope"
      ? `The in-book account check did not return within ${seconds} seconds. Nothing was saved. Try the same search again.`
      : stage === "date_range_lookup"
        ? `The account-linked Gong search for this date range did not return within ${seconds} seconds. Nothing was saved. Try a shorter date range or the same search again.`
        : stage === "link_id_resolution"
          ? `The Gong link ID check did not return within ${seconds} seconds. Nothing was saved. Try the same link again.`
        : stage === "direct_link_validation"
          ? `The account-linked Gong link check did not return within ${seconds} seconds. Nothing was saved. Try the same link again.`
          : `The account-linked Gong call search did not return within ${seconds} seconds. Nothing was saved. Try the same search again.`;
    return new BetaError("MEETING_PREP_CALL_READ_TIMEOUT", message, {
      stage,
      deadline_seconds: seconds,
    });
  }
  return error;
}

function attachReadDeadlines(result, { callLookupTimeoutMs, callIdResolutionTimeoutMs = null }) {
  result.read_deadline_seconds = callLookupTimeoutMs / 1000;
  result.source_read_deadlines_seconds = {
    account_scope: MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS / 1000,
    ...(callIdResolutionTimeoutMs == null ? {} : { gong_call_id_resolution: callIdResolutionTimeoutMs / 1000 }),
    gong_call_lookup: callLookupTimeoutMs / 1000,
  };
  return result;
}

function reportReadProgress(onProgress, stage, timeoutMs) {
  try { onProgress?.({ stage, stage_deadline_seconds: timeoutMs / 1000 }); } catch (_error) { /* progress cannot change a source read */ }
}

export async function readMeetingPrepCallCandidatesWithSession({ session, accountName, callDate, onProgress }) {
  if (!session || typeof session.query !== "function") {
    throw new BetaError("MEETING_PREP_CALL_SESSION_REQUIRED", "The approved Snowflake session is required for Gong call selection.");
  }
  let scopeRows;
  let callRows;
  let activeRead = { stage: "account_scope", timeoutMs: MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS };
  try {
    reportReadProgress(onProgress, activeRead.stage, activeRead.timeoutMs);
    scopeRows = await session.query(
      buildMeetingPrepAccountScopeSql({ accountName }),
      { timeoutMs: MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS },
    );
    const scope = resolveMeetingPrepAccountScope(scopeRows, { callDate });
    if (scope.finalResult) {
      return attachReadDeadlines(scope.finalResult, { callLookupTimeoutMs: MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS });
    }
    activeRead = { stage: "exact_date_lookup", timeoutMs: MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS };
    reportReadProgress(onProgress, activeRead.stage, activeRead.timeoutMs);
    callRows = await session.query(
      buildMeetingPrepCallCandidatesSql({ accountId: scope.account.accountId, callDate }),
      { timeoutMs: MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS },
    );
  } catch (error) {
    throw meetingPrepReadFailure(error, activeRead);
  }
  const result = presentMeetingPrepCallCandidates([...scopeRows, ...callRows], { callDate, selectionOrigin: "date_search" });
  return attachReadDeadlines(result, { callLookupTimeoutMs: MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS });
}

/**
 * Searches one inclusive Europe/Lisbon date window in one account-resolution
 * read plus one call-metadata read. It deliberately does not fan out into one
 * potentially slow call query per calendar day.
 */
export async function readMeetingPrepCallCandidatesInRangeWithSession({ session, accountName, startDate, endDate, onProgress }) {
  if (!session || typeof session.query !== "function") {
    throw new BetaError("MEETING_PREP_CALL_SESSION_REQUIRED", "The approved Snowflake session is required for Gong call selection.");
  }
  const range = requireMeetingPrepCallDateRange({ startDate, endDate });
  let scopeRows;
  let callRows;
  let activeRead = { stage: "account_scope", timeoutMs: MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS };
  try {
    reportReadProgress(onProgress, activeRead.stage, activeRead.timeoutMs);
    scopeRows = await session.query(
      buildMeetingPrepAccountScopeSql({ accountName }),
      { timeoutMs: MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS },
    );
    const scope = resolveMeetingPrepAccountScope(scopeRows, { callDateRange: range });
    if (scope.finalResult) {
      return attachReadDeadlines(scope.finalResult, { callLookupTimeoutMs: MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS });
    }
    activeRead = { stage: "date_range_lookup", timeoutMs: MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS };
    reportReadProgress(onProgress, activeRead.stage, activeRead.timeoutMs);
    callRows = await session.query(
      buildMeetingPrepCallCandidatesRangeSql({
        accountId: scope.account.accountId,
        startDate: range.startDate,
        endDate: range.endDate,
      }),
      { timeoutMs: MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS },
    );
  } catch (error) {
    throw meetingPrepReadFailure(error, activeRead);
  }
  const result = presentMeetingPrepCallCandidates([...scopeRows, ...callRows], {
    callDateRange: range,
    selectionOrigin: "date_range_search",
  });
  return attachReadDeadlines(result, { callLookupTimeoutMs: MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS });
}

export async function validateMeetingPrepCallLinkWithSession({ session, accountName, gongCallUrl, onProgress }) {
  if (!session || typeof session.query !== "function") {
    throw new BetaError("MEETING_PREP_CALL_SESSION_REQUIRED", "The approved Snowflake session is required for Gong call selection.");
  }
  const callId = parseGongCallUrl(gongCallUrl);
  let scopeRows;
  let callRows;
  let activeRead = { stage: "account_scope", timeoutMs: MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS };
  try {
    reportReadProgress(onProgress, activeRead.stage, activeRead.timeoutMs);
    scopeRows = await session.query(
      buildMeetingPrepAccountScopeSql({ accountName }),
      { timeoutMs: MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS },
    );
    const scope = resolveMeetingPrepAccountScope(scopeRows, { selectionOrigin: "direct_link" });
    if (scope.finalResult) {
      if (scope.finalResult.status === "account_not_found") {
        throw new BetaError("GONG_CALL_NOT_ACCOUNT_MATCHED", "The pasted Gong call could not be verified as an account-linked call in your current book. No case was created.");
      }
      throw new BetaError("GONG_CALL_LINK_AMBIGUOUS", "The pasted Gong call did not resolve to exactly one account-linked call. No case was created.");
    }
    activeRead = { stage: "link_id_resolution", timeoutMs: MEETING_PREP_CALL_ID_RESOLUTION_READ_TIMEOUT_MS };
    reportReadProgress(onProgress, activeRead.stage, activeRead.timeoutMs);
    const idRows = await session.query(
      buildMeetingPrepGongCallIdResolutionSql({ callId }),
      { timeoutMs: MEETING_PREP_CALL_ID_RESOLUTION_READ_TIMEOUT_MS },
    );
    if (!Array.isArray(idRows)) {
      throw new BetaError("GONG_CALL_LINK_RESPONSE_INVALID", "The Gong link ID could not be read safely. No case was created.");
    }
    const keys = [...new Set(idRows.map((row) => requireConversationKey(field(row, "CONVERSATION_KEY"))))];
    if (keys.length === 0) {
      throw new BetaError("GONG_CALL_LINK_ID_UNRESOLVED", "The Gong link ID did not resolve to a source call reference. No case was created; this does not prove the call is absent.");
    }
    if (keys.length !== 1) {
      throw new BetaError("GONG_CALL_LINK_AMBIGUOUS", "The Gong link ID resolved to more than one source call reference. No case was created.");
    }
    activeRead = { stage: "direct_link_validation", timeoutMs: MEETING_PREP_CALL_LINK_VALIDATION_READ_TIMEOUT_MS };
    reportReadProgress(onProgress, activeRead.stage, activeRead.timeoutMs);
    callRows = await session.query(
      buildMeetingPrepCallLinkValidationSql({ accountId: scope.account.accountId, conversationKey: keys[0] }),
      { timeoutMs: MEETING_PREP_CALL_LINK_VALIDATION_READ_TIMEOUT_MS },
    );
  } catch (error) {
    throw meetingPrepReadFailure(error, activeRead);
  }
  const result = presentMeetingPrepCallCandidates([...scopeRows, ...callRows], { selectionOrigin: "direct_link" });
  if (result.status === "no_candidates") {
    throw new BetaError("GONG_CALL_NOT_ACCOUNT_MATCHED", "The pasted Gong call could not be verified as an account-linked call in your current book. No case was created.");
  }
  if (result.status !== "selected_call_verified" || result.candidates.length !== 1) {
    throw new BetaError("GONG_CALL_LINK_AMBIGUOUS", "The pasted Gong call did not resolve to exactly one account-linked call. No case was created.");
  }
  return attachReadDeadlines(result, {
    callLookupTimeoutMs: MEETING_PREP_CALL_LINK_VALIDATION_READ_TIMEOUT_MS,
    callIdResolutionTimeoutMs: MEETING_PREP_CALL_ID_RESOLUTION_READ_TIMEOUT_MS,
  });
}

/** Build the privacy-safe case input only after a runtime selection succeeds. */
export function authorizedMeetingPrepCallInput(selection, language) {
  if (!selection?.hasCallRecording) {
    throw new BetaError("CALL_RECORDING_UNAVAILABLE", "The selected Gong call has no available recording, so it cannot be processed for meeting preparation.");
  }
  const conversationKey = requireConversationKey(selection.conversationKey);
  return {
    source_locator_digest: crypto.createHash("sha256").update(`gong-call:${conversationKey}`).digest("hex"),
    language,
    recording_present: true,
    selected_call_only: true,
  };
}

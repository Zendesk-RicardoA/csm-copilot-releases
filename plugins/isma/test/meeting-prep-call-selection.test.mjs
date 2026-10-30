import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS,
  MEETING_PREP_CALL_CANDIDATE_LIMIT,
  MEETING_PREP_CALL_DATE_RANGE_MAX_DAYS,
  MEETING_PREP_CALL_ID_RESOLUTION_READ_TIMEOUT_MS,
  MEETING_PREP_CALL_LINK_VALIDATION_READ_TIMEOUT_MS,
  MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS,
  MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS,
  authorizedMeetingPrepCallInput,
  buildMeetingPrepAccountScopeSql,
  buildMeetingPrepCallCandidatesSql,
  buildMeetingPrepCallCandidatesRangeSql,
  buildMeetingPrepCallLinkValidationSql,
  buildMeetingPrepGongCallIdResolutionSql,
  parseGongCallUrl,
  presentMeetingPrepCallCandidates,
  readMeetingPrepCallCandidatesWithSession,
  readMeetingPrepCallCandidatesInRangeWithSession,
  requireMeetingPrepCallDateRange,
  validateMeetingPrepCallLinkWithSession,
} from "../mcp/meeting-prep-call-selection.mjs";
import { BetaError } from "../mcp/core.mjs";

const ACCOUNT_ID = "001000000000000AAA";
const CONVERSATION_KEY = "a".repeat(64);
const GONG_CALL_ID = "123456789012345678";

function scopedRows(overrides = {}) {
  return [
    { ROW_TYPE: "scope", SCOPE_COUNT: 1, ACCOUNT_MATCH_COUNT: 1 },
    { ROW_TYPE: "account", SCOPE_COUNT: 1, ACCOUNT_ID, ACCOUNT_NAME: "Invented Account" },
    {
      ROW_TYPE: "call",
      SCOPE_COUNT: 1,
      ACCOUNT_ID,
      ACCOUNT_NAME: "Invented Account",
      CONVERSATION_KEY,
      CALL_AT: "2026-09-22T09:30:00Z",
      CALL_STATUS: "completed",
      CALL_DISPOSITION: "meeting",
      CALL_SCOPE: "customer",
      SPOTLIGHT_BRIEF: "Invented summary",
      SPOTLIGHT_OUTCOME: "Invented outcome",
      SPOTLIGHT_KEY_POINTS: "Invented key point",
      SPOTLIGHT_NEXT_STEPS: "Invented next step",
      SPOTLIGHT_TYPE: "discovery",
      TRACKERS: "[]",
      HAS_CALL_RECORDING: true,
      SOURCE_UPDATED_AT: "2026-09-22T10:00:00Z",
      ...overrides,
    },
  ];
}

test("date-based meeting-prep call search resolves Salesforce names and brand fragments within the CSM book", () => {
  const accountScope = buildMeetingPrepAccountScopeSql({ accountName: "Invented" });
  const query = buildMeetingPrepCallCandidatesSql({ accountId: ACCOUNT_ID, callDate: "2026-09-22" });
  assert.match(accountScope, /company\.SUCCESS_OWNER_C_GC = authenticated_csm\.GSID/);
  assert.match(accountScope, /LOWER\(EMAIL\) = LOWER\(CURRENT_USER\(\)\)/);
  assert.match(accountScope, /company\.SFDC_ACCOUNT_ID AS account_id/);
  assert.match(accountScope, /company\.NAME AS gainsight_name/);
  assert.match(accountScope, /account\.NAME AS salesforce_name/);
  assert.match(accountScope, /company\.SFDC_ACCOUNT_ID = account\.ID/);
  assert.match(accountScope, /CONTAINS\(UPPER\(TRIM\(salesforce_name\)\), UPPER\(TRIM\('Invented'\)\)\)/);
  assert.match(accountScope, /CONTAINS\(UPPER\(TRIM\(gainsight_name\)\), UPPER\(TRIM\('Invented'\)\)\)/);
  assert.match(accountScope, /WHEN UPPER\(account_id\) = UPPER\(TRIM\('Invented'\)\) THEN 0/);
  assert.match(accountScope, /SELECT COUNT\(\*\) AS account_match_count FROM best_accounts/);
  assert.match(query, /WHERE ID = '001000000000000AAA'/);
  assert.match(query, /SALESFORCE_CONTACT_FORMULA_BCV/);
  assert.match(query, /PRESENTATION\.BULLSEYE_PRO\.SALES_ACTIVITY/);
  assert.match(query, /GONG_CONVERSATION_PARTICIPANTS_BCV/);
  assert.match(query, /participant\.ASSOCIATED_OBJECT_ID = contact\.contact_id/);
  assert.match(query, /MART_GONG_CALLS_BCV/);
  assert.match(query, /CONVERT_TIMEZONE\('Europe\/Lisbon', 'UTC', '2026-09-22 00:00:00'::TIMESTAMP_NTZ\)/);
  assert.match(query, /CONVERT_TIMEZONE\('Europe\/Lisbon', 'UTC', '2026-09-23 00:00:00'::TIMESTAMP_NTZ\)/);
  assert.match(query, /activity\.ACTIVITY_DATETIME >= CONVERT_TIMEZONE/);
  assert.match(query, /activity\.ACTIVITY_DATETIME < CONVERT_TIMEZONE/);
  assert.match(query, /participant_call\.GONG_CALL_EFFECTIVE_START_DATETIME >= CONVERT_TIMEZONE/);
  assert.match(query, /participant_call\.GONG_CALL_EFFECTIVE_START_DATETIME < CONVERT_TIMEZONE/);
  assert.match(query, new RegExp(`<= ${MEETING_PREP_CALL_CANDIDATE_LIMIT}`));
  assert.equal(accountScope.includes("GAINSIGHT_CALL_TO_ACTION"), false);
  assert.equal(query.includes("GONG_CALL_URL"), false);
  assert.equal(query.includes("GONG_CALL_TRANSCRIPT_CURATED"), false);
  assert.equal(query.includes("GONG_CALL_TRANSCRIPTS_BCV"), false);
  assert.equal(query.includes("EMAIL_ADDRESS"), false);
  assert.equal(query.includes("CALL_OWNER"), false);
});

test("one-day Gong search uses the same bounded statement with its measured deadline", () => {
  const oneDay = buildMeetingPrepCallCandidatesSql({ accountId: ACCOUNT_ID, callDate: "2026-09-22" });
  const sameDayRange = buildMeetingPrepCallCandidatesRangeSql({
    accountId: ACCOUNT_ID, startDate: "2026-09-22", endDate: "2026-09-22",
  });
  assert.equal(oneDay, sameDayRange);
  assert.equal(MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS, 120_000);
});

test("a unique in-book Salesforce name match reaches Gong when Gainsight uses another name", async () => {
  let queryCount = 0;
  const session = {
    async query(query) {
      queryCount += 1;
      if (queryCount === 1) {
        assert.match(query, /account\.NAME AS salesforce_name/);
        return scopedRows().slice(0, 2);
      }
      assert.match(query, /MART_GONG_CALLS_BCV/);
      assert.match(query, /WHERE ID = '001000000000000AAA'/);
      return scopedRows().slice(2);
    },
  };
  const result = await readMeetingPrepCallCandidatesWithSession({
    session,
    accountName: "Invented",
    callDate: "2026-09-22",
  });
  assert.equal(queryCount, 2);
  assert.equal(result.status, "call_selection_required");
  assert.equal(result.read_deadline_seconds, 120);
});

test("multiple in-book name matches are shown without searching Gong", async () => {
  let queryCount = 0;
  const session = {
    async query() {
      queryCount += 1;
      return [
        { ROW_TYPE: "scope", SCOPE_COUNT: 1, ACCOUNT_MATCH_COUNT: 2 },
        { ROW_TYPE: "account", ACCOUNT_ID, ACCOUNT_NAME: "Invented Account" },
        { ROW_TYPE: "account", ACCOUNT_ID: "001000000000001AAA", ACCOUNT_NAME: "Invented Service" },
      ];
    },
  };
  const result = await readMeetingPrepCallCandidatesWithSession({ session, accountName: "Invented", callDate: "2026-09-22" });
  assert.equal(queryCount, 1);
  assert.equal(result.status, "account_selection_required");
  assert.equal(result.account_match_count, 2);
  assert.deepEqual(result.accounts.map((account) => account.account_display_name), ["Invented Account", "Invented Service"]);
});

test("the local Gong date range respects Lisbon midnight across a daylight-saving change", () => {
  const query = buildMeetingPrepCallCandidatesSql({ accountId: ACCOUNT_ID, callDate: "2026-10-25" });
  assert.match(query, /'2026-10-25 00:00:00'::TIMESTAMP_NTZ/);
  assert.match(query, /'2026-10-26 00:00:00'::TIMESTAMP_NTZ/);
});

test("a multi-day call search runs one inclusive Lisbon window rather than one lookup per day", () => {
  const query = buildMeetingPrepCallCandidatesRangeSql({
    accountId: ACCOUNT_ID,
    startDate: "2026-08-01",
    endDate: "2026-08-15",
  });
  assert.match(query, /'2026-08-01 00:00:00'::TIMESTAMP_NTZ/);
  assert.match(query, /'2026-08-16 00:00:00'::TIMESTAMP_NTZ/);
  assert.match(query, /activity\.ACTIVITY_DATETIME >= CONVERT_TIMEZONE/);
  assert.match(query, /participant_call\.GONG_CALL_EFFECTIVE_START_DATETIME < CONVERT_TIMEZONE/);
  assert.equal(query.includes("GAINSIGHT_CALL_TO_ACTION"), false);
  assert.equal(query.includes("GONG_CALL_TRANSCRIPTS_BCV"), false);
});

test("a call-search range needs real ordered dates and remains bounded", () => {
  assert.deepEqual(
    requireMeetingPrepCallDateRange({ startDate: "2026-08-01", endDate: "2026-08-15" }),
    { startDate: "2026-08-01", endDate: "2026-08-15", endExclusiveDate: "2026-08-16", inclusiveDays: 15 },
  );
  assert.throws(
    () => requireMeetingPrepCallDateRange({ startDate: "2026-08-15", endDate: "2026-08-01" }),
    { code: "INVALID_CALL_DATE_RANGE" },
  );
  assert.throws(
    () => requireMeetingPrepCallDateRange({ startDate: "2026-08-01", endDate: "2026-09-01" }),
    { code: "INVALID_CALL_DATE_RANGE" },
  );
  assert.equal(MEETING_PREP_CALL_DATE_RANGE_MAX_DAYS, 31);
});

test("a call date must be a real complete calendar date", () => {
  assert.throws(
    () => buildMeetingPrepCallCandidatesSql({ accountName: "Invented Account", callDate: "2026-02-30" }),
    { code: "INVALID_CALL_DATE" },
  );
});

test("a pasted Gong call link is parsed only to a transient numeric call ID", () => {
  assert.equal(
    parseGongCallUrl("https://us-12345.app.gong.io/call?id=123456789012345678&entry=calls_widget"),
    GONG_CALL_ID,
  );
  const idQuery = buildMeetingPrepGongCallIdResolutionSql({ callId: GONG_CALL_ID });
  assert.match(idQuery, /FROM CLEANSED\.GONG\.GONG_CALLS_BCV/);
  assert.match(idQuery, /TO_VARCHAR\(CONVERSATION_ID\) = '123456789012345678'/);
  assert.match(idQuery, /LIMIT 3/);
  const query = buildMeetingPrepCallLinkValidationSql({
    accountId: ACCOUNT_ID,
    conversationKey: CONVERSATION_KEY,
  });
  assert.match(query, new RegExp(`TO_VARCHAR\\(call\\.GONG_CONVERSATION_KEY\\) = '${CONVERSATION_KEY}'`));
  assert.match(query, new RegExp(`TO_VARCHAR\\(activity\\.GONG_CONVERSATION_KEY\\) = '${CONVERSATION_KEY}'`));
  assert.match(query, new RegExp(`TO_VARCHAR\\(participant_call\\.GONG_CONVERSATION_KEY\\) = '${CONVERSATION_KEY}'`));
  assert.equal(query.includes(GONG_CALL_ID), false);
  assert.equal(query.includes("https://"), false);
  assert.equal(idQuery.includes("https://"), false);
  assert.throws(() => parseGongCallUrl("https://example.invalid/call?id=123456789012345678"), { code: "INVALID_GONG_CALL_URL" });
  assert.throws(() => parseGongCallUrl("https://us-12345.app.gong.io/call?id=not-an-id"), { code: "INVALID_GONG_CALL_REFERENCE" });
});

test("a date search gives the CSM opaque call choices and never serializes a source key", () => {
  const result = presentMeetingPrepCallCandidates(scopedRows(), {
    callDate: "2026-09-22",
    createSelectionRef: () => "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.status, "call_selection_required");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].call_selection_ref, "11111111-1111-4111-8111-111111111111");
  assert.equal(JSON.stringify(result).includes(CONVERSATION_KEY), false);
  assert.equal(result.runtimeSelectionByRef.get(result.candidates[0].call_selection_ref).conversationKey, CONVERSATION_KEY);
  const authorized = authorizedMeetingPrepCallInput(result.runtimeSelectionByRef.get(result.candidates[0].call_selection_ref), "en");
  assert.match(authorized.source_locator_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(authorized).includes(CONVERSATION_KEY), false);
  assert.throws(() => presentMeetingPrepCallCandidates(scopedRows({ CONVERSATION_KEY: "bad key with spaces" })), { code: "INVALID_GONG_CALL_REFERENCE" });
});

test("a pasted link is treated as a direct CSM selection but still exposes no raw locator", async () => {
  let queryCount = 0;
  const progress = [];
  const session = {
    async query(query, { timeoutMs }) {
      queryCount += 1;
      assert.equal(timeoutMs, [
        MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS,
        MEETING_PREP_CALL_ID_RESOLUTION_READ_TIMEOUT_MS,
        MEETING_PREP_CALL_LINK_VALIDATION_READ_TIMEOUT_MS,
      ][queryCount - 1]);
      if (queryCount === 1) {
        assert.match(query, /company\.SUCCESS_OWNER_C_GC = authenticated_csm\.GSID/);
        return scopedRows().slice(0, 2);
      }
      if (queryCount === 2) {
        assert.match(query, /TO_VARCHAR\(CONVERSATION_ID\) = '123456789012345678'/);
        return [{ CONVERSATION_KEY }];
      }
      assert.match(query, new RegExp(`TO_VARCHAR\\(call\\.GONG_CONVERSATION_KEY\\) = '${CONVERSATION_KEY}'`));
      return scopedRows().slice(2);
    },
  };
  const result = await validateMeetingPrepCallLinkWithSession({
    session,
    accountName: "Invented Account",
    gongCallUrl: "https://us-12345.app.gong.io/call?id=123456789012345678",
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.status, "selected_call_verified");
  assert.equal(queryCount, 3);
  assert.equal(result.candidates.length, 1);
  assert.equal(JSON.stringify(result).includes(CONVERSATION_KEY), false);
  assert.equal(JSON.stringify(result).includes(GONG_CALL_ID), false);
  assert.deepEqual(result.source_read_deadlines_seconds, {
    account_scope: 90,
    gong_call_id_resolution: 25,
    gong_call_lookup: 100,
  });
  assert.deepEqual(progress, [
    { stage: "account_scope", stage_deadline_seconds: 90 },
    { stage: "link_id_resolution", stage_deadline_seconds: 25 },
    { stage: "direct_link_validation", stage_deadline_seconds: 100 },
  ]);
});

test("an unmapped or ambiguous Gong link stops before account-linked call validation", async () => {
  for (const [mappedRows, expectedCode] of [
    [[], "GONG_CALL_LINK_ID_UNRESOLVED"],
    [[{ CONVERSATION_KEY }, { CONVERSATION_KEY: "b".repeat(64) }], "GONG_CALL_LINK_AMBIGUOUS"],
  ]) {
    let queryCount = 0;
    const session = {
      async query() {
        queryCount += 1;
        return queryCount === 1 ? scopedRows().slice(0, 2) : mappedRows;
      },
    };
    await assert.rejects(
      validateMeetingPrepCallLinkWithSession({
        session,
        accountName: "Invented Account",
        gongCallUrl: `https://us-12345.app.gong.io/call?id=${GONG_CALL_ID}`,
      }),
      { code: expectedCode },
    );
    assert.equal(queryCount, 2);
  }
});

test("Gong link mapping and account validation have distinct timeout stages", async () => {
  for (const [timeoutAt, expectedStage, expectedSeconds] of [
    [2, "link_id_resolution", 25],
    [3, "direct_link_validation", 100],
  ]) {
    let queryCount = 0;
    const session = {
      async query() {
        queryCount += 1;
        if (queryCount === timeoutAt) throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "source timeout");
        return queryCount === 1 ? scopedRows().slice(0, 2) : [{ CONVERSATION_KEY }];
      },
    };
    await assert.rejects(
      validateMeetingPrepCallLinkWithSession({
        session,
        accountName: "Invented Account",
        gongCallUrl: `https://us-12345.app.gong.io/call?id=${GONG_CALL_ID}`,
      }),
      (error) => error.code === "MEETING_PREP_CALL_READ_TIMEOUT"
        && error.details.stage === expectedStage
        && error.details.deadline_seconds === expectedSeconds,
    );
    assert.equal(queryCount, timeoutAt);
  }
});

test("account resolution runs before the bounded call-metadata lookup", async () => {
  let queryCount = 0;
  const session = {
    async query(query, { timeoutMs }) {
      queryCount += 1;
      assert.equal(timeoutMs, queryCount === 1
        ? MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS
        : MEETING_PREP_EXACT_DATE_CALL_READ_TIMEOUT_MS);
      if (queryCount === 1) {
        assert.match(query, /matched_accounts/);
        assert.equal(query.includes("MART_GONG_CALLS_BCV"), false);
        return scopedRows().slice(0, 2);
      }
      assert.match(query, /MART_GONG_CALLS_BCV/);
      assert.match(query, /WHERE ID = '001000000000000AAA'/);
      return scopedRows().slice(2);
    },
  };
  const result = await readMeetingPrepCallCandidatesWithSession({
    session,
    accountName: "Invented Account",
    callDate: "2026-09-22",
  });
  assert.equal(queryCount, 2);
  assert.equal(result.status, "call_selection_required");
});

test("a date-range picker resolves the account once and runs exactly one call lookup", async () => {
  let queryCount = 0;
  const session = {
    async query(query, { timeoutMs }) {
      queryCount += 1;
      if (queryCount === 1) {
        assert.equal(timeoutMs, MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS);
        assert.match(query, /matched_accounts/);
        return scopedRows().slice(0, 2);
      }
      assert.equal(timeoutMs, MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS);
      assert.match(query, /'2026-08-01 00:00:00'::TIMESTAMP_NTZ/);
      assert.match(query, /'2026-08-16 00:00:00'::TIMESTAMP_NTZ/);
      return scopedRows().slice(2);
    },
  };
  const result = await readMeetingPrepCallCandidatesInRangeWithSession({
    session,
    accountName: "Invented Account",
    startDate: "2026-08-01",
    endDate: "2026-08-15",
  });
  assert.equal(queryCount, 2);
  assert.equal(result.status, "call_selection_required");
  assert.deepEqual(result.call_date_range, {
    start_date: "2026-08-01",
    end_date: "2026-08-15",
    timezone: "Europe/Lisbon",
  });
  assert.equal(result.read_deadline_seconds, 100);
  assert.deepEqual(result.source_read_deadlines_seconds, {
    account_scope: 90,
    gong_call_lookup: 100,
  });
  assert.equal(JSON.stringify(result).includes(CONVERSATION_KEY), false);
});

test("a 31-day call lookup has its own measured deadline and names the failed stage", async () => {
  let queryCount = 0;
  const session = {
    async query(_query, { timeoutMs }) {
      queryCount += 1;
      if (queryCount === 1) {
        assert.equal(timeoutMs, MEETING_PREP_ACCOUNT_SCOPE_READ_TIMEOUT_MS);
        return scopedRows().slice(0, 2);
      }
      assert.equal(timeoutMs, MEETING_PREP_DATE_RANGE_CALL_READ_TIMEOUT_MS);
      throw new BetaError("SNOWFLAKE_SESSION_TIMEOUT", "source timeout");
    },
  };
  await assert.rejects(
    readMeetingPrepCallCandidatesInRangeWithSession({
      session,
      accountName: "Invented Account",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    }),
    (error) => error.code === "MEETING_PREP_CALL_READ_TIMEOUT"
      && error.details.stage === "date_range_lookup"
      && error.details.deadline_seconds === 100
      && /100 seconds/.test(error.message),
  );
});

test("a non-recorded selected call cannot open an authorized meeting-prep case", () => {
  const result = presentMeetingPrepCallCandidates(scopedRows({ HAS_CALL_RECORDING: false }), {
    createSelectionRef: () => "22222222-2222-4222-8222-222222222222",
  });
  const selection = result.runtimeSelectionByRef.get("22222222-2222-4222-8222-222222222222");
  assert.throws(() => authorizedMeetingPrepCallInput(selection, "en"), { code: "CALL_RECORDING_UNAVAILABLE" });
});

test("a call candidate search distinguishes no linked metadata from no customer meeting", () => {
  const result = presentMeetingPrepCallCandidates(scopedRows().slice(0, 2), { callDate: "2026-09-22" });
  assert.equal(result.status, "no_candidates");
  assert.match(result.next_action, /does not establish that no meeting happened/);
});

test("ambiguous ownership or account identity fail before any call is shown", () => {
  assert.throws(
    () => presentMeetingPrepCallCandidates([{ ROW_TYPE: "scope", SCOPE_COUNT: 2 }]),
    { code: "MEETING_PREP_SCOPE_UNAVAILABLE" },
  );
  const ambiguous = presentMeetingPrepCallCandidates([
    { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
    { ROW_TYPE: "account", ACCOUNT_ID: ACCOUNT_ID, ACCOUNT_NAME: "Invented Account" },
    { ROW_TYPE: "account", ACCOUNT_ID: "001000000000001AAA", ACCOUNT_NAME: "Invented Account" },
  ]);
  assert.equal(ambiguous.status, "account_selection_required");
});

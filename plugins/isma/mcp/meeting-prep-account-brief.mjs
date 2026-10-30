import crypto from "node:crypto";

import { BetaError } from "./core.mjs";
import { buildMeetingPrepAccountScopeSql } from "./meeting-prep-call-selection.mjs";
import { readRenewalConversationEvidenceWithSession } from "./renewal-conversation-brief.mjs";
import { assessAccountIntelligenceCompleteness, buildAccountIntelligenceDisplay } from "./account-intelligence-display.mjs";
import { ACCOUNT_EVIDENCE_FIRST_PASS_MS } from "./account-evidence-read-plan.mjs";
import { verifyManagerSelectedAccountWithSession } from './manager-account-search.mjs';

const ACCOUNT_ID = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const DIGEST = /^[a-f0-9]{64}$/;
export const MEETING_PREP_ACCOUNT_SCOPE_TIMEOUT_MS = 120_000;
const JOB_TTL_MS = 15 * 60_000;

function field(row, key) {
  return row?.[key] ?? row?.[key.toLowerCase()] ?? null;
}

/** Resolve a resumed case without persisting a raw Salesforce account ID or name. */
export function buildMeetingPrepCaseAccountScopeSql(accountRefDigest) {
  if (!DIGEST.test(accountRefDigest || "")) {
    throw new BetaError("MEETING_PREP_ACCOUNT_DIGEST_INVALID", "The meeting-prep case has no valid account reference.");
  }
  return `
WITH current_user_candidates AS (
  SELECT GSID FROM CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV
  WHERE LOWER(EMAIL) = LOWER(CURRENT_USER())
), scope AS (
  SELECT COUNT(*) AS scope_count FROM current_user_candidates
), matched AS (
  SELECT DISTINCT company.SFDC_ACCOUNT_ID AS account_id, account.NAME AS account_name
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
  JOIN current_user_candidates AS csm ON company.SUCCESS_OWNER_C_GC = csm.GSID
  JOIN CLEANSED.SALESFORCE.SALESFORCE_ACCOUNT_BCV AS account ON company.SFDC_ACCOUNT_ID = account.ID
  CROSS JOIN scope
  WHERE scope.scope_count = 1
    AND LOWER(SHA2(CONCAT('account:', company.SFDC_ACCOUNT_ID), 256)) = '${accountRefDigest}'
)
SELECT 'scope' AS row_type, scope.scope_count, NULL::STRING AS account_id, NULL::STRING AS account_name
FROM scope
UNION ALL
SELECT 'account' AS row_type, 1 AS scope_count, account_id, account_name FROM matched
ORDER BY row_type`.trim();
}

/** The account must still be uniquely in the authenticated CSM's book. */
export function resolveMeetingPrepBriefAccount(rows) {
  const scope = rows?.find((row) => field(row, "ROW_TYPE") === "scope");
  if (!scope || Number(field(scope, "SCOPE_COUNT")) !== 1) {
    throw new BetaError("MEETING_PREP_SCOPE_UNAVAILABLE", "The signed-in user does not map to one CSM profile; the account brief was not read.");
  }
  const accounts = rows.filter((row) => field(row, "ROW_TYPE") === "account");
  const count = Number(field(scope, "ACCOUNT_MATCH_COUNT")) || accounts.length;
  if (count === 0) {
    return { status: "account_not_found", next_action: "No matching account is in the current CSM book. Check the account name; this does not establish that the account is absent from Salesforce." };
  }
  if (count !== 1 || accounts.length !== 1) {
    return {
      status: "account_selection_required",
      account_match_count: count,
      accounts: accounts.map((row) => ({ account_display_name: field(row, "ACCOUNT_NAME") || "Unnamed account" })),
      next_action: "Choose one exact in-book account before reading its brief.",
    };
  }
  const accountId = String(field(accounts[0], "ACCOUNT_ID") || "");
  if (!ACCOUNT_ID.test(accountId)) {
    throw new BetaError("MEETING_PREP_ACCOUNT_RESPONSE_INVALID", "The selected account could not be verified safely.");
  }
  return { status: "selected", accountId };
}

export async function readMeetingPrepAccountBriefWithSession({ session, accountName = null, accountRefDigest = null, managerSelection = null, managerAuthority = null, onProgress = null, readAccountEvidence = readRenewalConversationEvidenceWithSession } = {}) {
  if (!session || typeof session.query !== "function" || [accountName, accountRefDigest, managerSelection].filter(Boolean).length !== 1) {
    throw new BetaError("MEETING_PREP_ACCOUNT_SCOPE_REQUIRED", "Provide one account name or one active meeting-prep case.");
  }
  onProgress?.({ stage: "account_scope", stage_deadline_seconds: MEETING_PREP_ACCOUNT_SCOPE_TIMEOUT_MS / 1000 });
  let rows;
  let selection;
  if (managerSelection) {
    selection = { status: 'selected', ...await verifyManagerSelectedAccountWithSession({ session, selection: managerSelection, authority: managerAuthority, onProgress }) };
  } else {
  try {
    rows = await session.query(
      accountRefDigest ? buildMeetingPrepCaseAccountScopeSql(accountRefDigest) : buildMeetingPrepAccountScopeSql({ accountName }),
      { timeoutMs: MEETING_PREP_ACCOUNT_SCOPE_TIMEOUT_MS },
    );
  } catch (error) {
    if (error?.code === "SNOWFLAKE_SESSION_TIMEOUT") {
      throw new BetaError("MEETING_PREP_ACCOUNT_READ_TIMEOUT", "The in-book account check timed out; no account brief was returned.");
    }
    throw error;
  }
  selection = resolveMeetingPrepBriefAccount(rows);
  }
  if (selection.status !== "selected") return selection;
  onProgress?.({ stage: "account_evidence", stage_deadline_seconds: ACCOUNT_EVIDENCE_FIRST_PASS_MS / 1000 });
  const evidence = await readAccountEvidence({
    accountId: selection.accountId,
    selectedCta: null,
    session,
    onProgress,
  });
  const brief = evidence.review_package.shared_account_intelligence;
  const completeness = assessAccountIntelligenceCompleteness(brief);
  return {
    account_scope: managerSelection ? 'manager_selected_account' : 'csm_book',
    status: completeness.state === "needs_evidence" ? "source_gap" : completeness.state,
    account_brief: brief,
    account_brief_completeness: completeness,
    account_brief_read_state: completeness.read_state,
    account_brief_read_summary: completeness.read_summary,
    account_brief_display: buildAccountIntelligenceDisplay(brief),
    account_intelligence_receipt: evidence.account_intelligence_receipt,
    performance_slide_proposals: Object.entries(evidence.account_intelligence_receipt.performance_coverage || {}).map(([evidence, available]) => ({ evidence, available,
      proposed_layout: evidence === "year_over_year" ? "supporting_metric" : evidence,
      next_action: available ? "Propose this evidence in the customer-content review; the CSM decides its relevance." : "Keep the gap visible; do not require this evidence to create the rest of the deck." })),
    source_durations_ms: evidence.source_durations_ms,
    source_read_diagnostics: evidence.statement_executions || [],
    read_at: evidence.read_at,
    next_action: "Use display_delivery_request to get the approved final Markdown, then copy its first text block verbatim. Do not request display_details for ordinary meeting preparation; it is optional raw detail, not a more complete default brief. Preserve all sections, table headers/rows and the opening read summary. Only recent-call Summary/Next steps cells may be paraphrased from the same cached notes. No separate recording search or meeting-date question is needed. Deliver cached charts when authorized; otherwise show the brief now and offer temporary charts once. Put questions after the brief. Keep data limits visible; partial is not complete field coverage. Explicit detailed-evidence requests still use display_details without rereads or approval changes.",
  };
}

/** Case presentation only: never change the canonical account evidence or its digest. */
export function projectMeetingPrepBrief(result, { caseRecord, ownerRef, selection = null, evidenceAvailable = false, displayFocus = null, displayDetails = null } = {}) {
  if (!result.account_brief || !caseRecord) return result;
  if (caseRecord.tester_id !== ownerRef) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  if (result.account_intelligence_receipt?.account_ref_digest !== caseRecord.account_ref_digest) {
    throw new BetaError("CROSS_JOURNEY_ACCOUNT_MISMATCH", "The account brief and selected-call case do not match.");
  }
  const derived = caseRecord.derived_evidence;
  const receipt = derived?.source_receipt;
  if (receipt && (receipt.account_ref_digest !== caseRecord.account_ref_digest || receipt.case_id !== caseRecord.case_id)) {
    throw new BetaError("SELECTED_CALL_ACCOUNT_MISMATCH", "The selected-call receipt belongs to another account or case.");
  }
  const context = derived ? evidenceAvailable
    ? { state: "available", finding_count: derived.finding_count,
      note: derived.finding_count > 0
        ? "The selected call has been analyzed and its paraphrased findings are bound to this case. Review the findings and their gaps separately below. This does not approve the evidence or establish every possible call-context field."
        : "The selected call was analyzed, but no paraphrased findings were returned. Customer goals and commitments have not been established." }
    : { state: "unavailable", availability_scope: "control_only",
      note: "The call was analyzed and its receipt is bound to this case. This control cannot confirm whether the reviewed findings are still held in this chat. Keep using retained findings without retrieving the call again. If they are gone, a receipt cannot restore expired findings; repeat the authorized selection flow." }
    : selection?.sourceGap
      ? { state: "unavailable", source_gap: selection.sourceGap, note: "A call is selected, but its transcript read failed or returned no usable transcript. Customer facts have not been established; the call summary is not a substitute." }
      : selection
        ? { state: "selected_pending", note: "A call is selected and its processing is authorized. Transcript findings are not yet bound; customer goals and commitments remain unverified." }
        : { state: "unavailable", note: "The selected call is no longer in temporary memory. Repeat the authorized selection flow before processing it; this account brief does not prove that its transcript was read." };
  return { ...result, case_call_context: context,
    account_brief_display: buildAccountIntelligenceDisplay(result.account_brief, { callContext: context, displayFocus, displayDetails }) };
}

/** Temporary, owner-bound progress and result; customer evidence never enters case state. */
export class MeetingPrepAccountBriefJobs {
  constructor({ now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    this.now = now;
    this.randomBytes = randomBytes;
    this.jobs = new Map();
  }

  prune() {
    for (const [ref, job] of this.jobs) if (job.expiresAt <= this.now()) this.jobs.delete(ref);
  }

  matchingReceipt({ ownerRef, accountRefDigest }) {
    this.prune();
    const matches = [...this.jobs.values()].filter((job) => job.ownerRef === ownerRef
      && job.status === "ready"
      && job.result?.account_intelligence_receipt?.account_ref_digest === accountRefDigest);
    matches.sort((a, b) => b.startedAt - a.startedAt);
    return matches[0]?.result.account_intelligence_receipt || null;
  }

  matchingResult({ ownerRef, accountRefDigest, contentDigest }) {
    this.prune();
    const match = [...this.jobs.values()].find((job) => job.ownerRef === ownerRef && job.status === "ready"
      && job.result?.account_intelligence_receipt?.account_ref_digest === accountRefDigest
      && job.result?.account_intelligence_receipt?.content_digest === contentDigest);
    return match ? { ...structuredClone(match.result), account_brief_ref: match.ref, reused_fresh_read: true } : null;
  }

  start({ ownerRef, read }) {
    this.prune();
    if (!ownerRef || typeof read !== "function") throw new BetaError("MEETING_PREP_BRIEF_INVALID", "A scoped account brief read is required.");
    for (const job of this.jobs.values()) {
      if (job.ownerRef === ownerRef && job.status === "in_progress") {
        throw new BetaError("MEETING_PREP_BRIEF_IN_PROGRESS", "An account brief is already being prepared. Continue that read.", { account_brief_ref: job.ref });
      }
    }
    const ref = this.randomBytes(18).toString("base64url");
    const job = { ref, ownerRef, status: "in_progress", startedAt: this.now(), stageStartedAt: this.now(), stage: "starting", stageDeadlineSeconds: null, expiresAt: this.now() + JOB_TTL_MS, result: null, error: null };
    this.jobs.set(ref, job);
    const timer = setTimeout(() => this.prune(), JOB_TTL_MS + 1);
    timer.unref?.();
    void Promise.resolve()
      .then(() => read((progress) => { if (job.stage !== progress.stage) job.stageStartedAt = this.now(); job.stage = progress.stage; job.stageDeadlineSeconds = progress.stage_deadline_seconds;
        job.sourceProgress = Object.fromEntries(["source", "attempt", "completed_sources", "total_sources"].filter((key) => progress[key] != null).map((key) => [key, progress[key]])); }))
      .then((result) => { job.status = "ready"; job.result = { ...result, source_elapsed_ms: this.now() - job.startedAt }; })
      .catch((error) => {
        job.status = "failed";
        job.sourceElapsedMs = this.now() - job.startedAt;
        const diagnosticKeys = ["failure_stage", "statement_started", "worker_exit_code", "worker_signal", "worker_error_code", "source_error_type", "source_error_number", "source_sqlstate", "elapsed_ms", "execution_timeout_ms", "worker_start_timeout_ms"];
        job.error = error instanceof BetaError
          ? { code: error.code, message: error.message, details: Object.fromEntries(diagnosticKeys.filter((key) => error.details?.[key] != null).map((key) => [key, error.details[key]])) }
          : { code: "MEETING_PREP_BRIEF_FAILED", message: "The account brief read failed before returning evidence." };
      });
    return this.poll({ ref, ownerRef });
  }

  poll({ ref, ownerRef }) {
    this.prune();
    const job = this.jobs.get(ref);
    if (!job || job.ownerRef !== ownerRef) throw new BetaError("MEETING_PREP_BRIEF_UNAVAILABLE", "This temporary account brief is unavailable. Start a fresh read.");
    if (job.status === "ready") return { account_brief_ref: ref, ...job.result };
    if (job.status === "failed") return { status: "failed", account_brief_ref: ref, source_elapsed_ms: job.sourceElapsedMs, ...job.error };
    return { status: "in_progress", account_brief_ref: ref, stage: job.stage, stage_deadline_seconds: job.stageDeadlineSeconds, ...job.sourceProgress, stage_elapsed_seconds: Math.floor((this.now() - job.stageStartedAt) / 1000), elapsed_seconds: Math.floor((this.now() - job.startedAt) / 1000), next_check_after_seconds: 20 };
  }

  chartExpiry({ ref, ownerRef }) {
    this.poll({ ref, ownerRef });
    return this.jobs.get(ref).expiresAt;
  }
}

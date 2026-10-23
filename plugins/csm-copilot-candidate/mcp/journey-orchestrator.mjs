import { BetaError, JOURNEY_LABELS, WORKFLOW_NAMES, assertSafeFreeText, initialJourneyState, nextGate } from "./core.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const CONTACT_SOURCE_STATES = new Set(["checked", "timed_out", "unavailable", "not_requested"]);
export const JOURNEYS = ["journey_a", "journey_b"];
export const JOURNEY_A_GATES = [
  "work_selection",
  "account_evidence",
  "contact_selection",
  "template_preview",
  "outreach_draft",
];
export const HANDOFF_REASONS = [
  "discovery_or_success_plan",
  "outreach_or_follow_up",
  "meeting_preparation",
  "shared_account_context",
];

function requireOwner(record, testerId) {
  if (record.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
}

function requireJourney(journey) {
  if (!JOURNEYS.includes(journey)) {
    throw new BetaError(
      "INVALID_JOURNEY",
      "Choose Account Prioritization and Outreach or Customer Planning and Meeting Prep.",
    );
  }
}

function stateFor(record) {
  return record.journey_state ? structuredClone(record.journey_state) : initialJourneyState();
}

function invalidateCaseReview(record, now) {
  record.revision += 1;
  record.approvals = [];
  record.status = "in_review";
  record.updated_at = now.toISOString();
  return record;
}

function requireReviewedHandoffEvidence(record, state, fromJourney) {
  if (fromJourney === "journey_a") {
    const completed = (state.contexts.journey_a.approvals || []).map((approval) => approval.gate);
    if (!completed.includes("account_evidence")) {
      throw new BetaError(
        "HANDOFF_EVIDENCE_NOT_REVIEWED",
        "Review the Account Prioritization and Outreach work selection and account evidence before handoff.",
      );
    }
    return;
  }
  const completed = (record.approvals || []).map((approval) => approval.gate);
  if (!completed.includes("identity") || !completed.includes("evidence")) {
    throw new BetaError(
      "HANDOFF_EVIDENCE_NOT_REVIEWED",
      "Review the Customer Planning and Meeting Prep identity and evidence before handoff.",
    );
  }
}

export function meetingPreparationMode(workflow, preparationMode) {
  if (workflow !== "meeting_prep") {
    if (preparationMode !== undefined) throw new BetaError("INVALID_MEETING_PREPARATION_MODE", "Preparation mode applies only to meeting preparation.");
    return null;
  }
  if (preparationMode === undefined) return "account_brief";
  if (!["account_brief", "selected_call"].includes(preparationMode)) {
    throw new BetaError("INVALID_MEETING_PREPARATION_MODE", "Choose account_brief for ordinary preparation or selected_call only for explicit recording analysis.");
  }
  return preparationMode;
}

export function routeWorkflowIntent(intent, { preparationMode } = {}) {
  const routes = {
    broad_focus: { route: "daily_operating_layer", requires_case: false },
    outreach: { route: "journey_a", requires_case: true },
    meeting_preparation: { route: "journey_b", requires_case: true },
    success_plan: { route: "journey_b", requires_case: true },
    presentation: { route: "journey_b", requires_case: true },
    renewal_conversation_brief: { route: "journey_a", requires_case: true, route_label: "Renewal Conversation Brief" },
    follow_up: { route: "journey_a", requires_case: true },
  };
  if (!routes[intent]) throw new BetaError("INVALID_WORKFLOW_INTENT", "Use one of the supported workflow intents.");
  const mode = meetingPreparationMode(intent === "meeting_preparation" ? "meeting_prep" : intent, preparationMode);
  const route = mode ? {
    ...routes[intent],
    preparation_mode: mode,
    requires_case: mode === "selected_call",
    requires_call_selection: mode === "selected_call",
    first_tool: mode === "account_brief" ? "beta_start_meeting_prep_account_brief" : "beta_start_converge_call_lookup",
    next_action: mode === "account_brief"
      ? "Start the named account brief now and show its ordered account_brief_display sections and tables. Recent-call summaries are already part of the brief. Do not ask for the upcoming meeting date. Do not start a separate recording search, create a case or request transcript selection. Put optional meeting questions after the brief. Without temporary-chart authorization, deliver the brief first and offer chart authorization once."
      : "Use the explicitly requested historical recording context and the existing Converge picker. A call must be chosen before case creation or transcript analysis. Reuse a fresh same-account brief; retain every existing review and draft-authorization gate.",
  } : routes[intent];
  return {
    intent,
    ...route,
    route_label: route.route_label || JOURNEY_LABELS[route.route] || "Daily Focus",
  };
}

function requireCustomerPlanningAbandonment(fromJourney, toJourney, abandonCustomerPlanning) {
  if (fromJourney === "journey_b" && toJourney !== "journey_b" && abandonCustomerPlanning !== true) {
    throw new BetaError(
      "CUSTOMER_PLANNING_ABANDONMENT_REQUIRED",
      "Keep Customer Planning and Meeting Prep active unless the CSM explicitly asks to abandon preparation for a different task.",
    );
  }
}

export function startJourney(caseRecord, { journey, abandonCustomerPlanning = false, testerId, now = new Date() }) {
  requireOwner(caseRecord, testerId);
  requireJourney(journey);
  const updated = structuredClone(caseRecord);
  const state = stateFor(updated);
  const previous = state.active_journey;
  requireCustomerPlanningAbandonment(previous, journey, abandonCustomerPlanning);
  if (previous !== journey && state.contexts[previous]?.context) {
    throw new BetaError(
      "HANDOFF_REQUIRED",
      "Use the journey handoff after evidence has been bound so shared context is not lost.",
    );
  }
  state.active_journey = journey;
  state.contexts[journey].status = "active";
  updated.journey_state = state;
  return invalidateCaseReview(updated, now);
}

export function bindJourneyContext(
  caseRecord,
  {
    journey,
    contextDigest,
    accountRefDigest,
    contextVersion,
    itemCount,
    warningCodes = [],
    testerId,
    now = new Date(),
  },
) {
  requireOwner(caseRecord, testerId);
  requireJourney(journey);
  if (!DIGEST.test(contextDigest || "") || !DIGEST.test(accountRefDigest || "")) {
    throw new BetaError("INVALID_CONTEXT_DIGEST", "Context and account references must use SHA-256 digests.");
  }
  if (contextVersion !== "1.0.0") {
    throw new BetaError("UNSUPPORTED_CONTEXT_VERSION", "CrossJourneyContextV1 version 1.0.0 is required.");
  }
  if (!Number.isInteger(itemCount) || itemCount < 0 || itemCount > 1000) {
    throw new BetaError("INVALID_CONTEXT_COUNT", "item_count must be an integer from 0 to 1000.");
  }
  if (!Array.isArray(warningCodes) || warningCodes.some((code) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(code))) {
    throw new BetaError("INVALID_WARNING_CODE", "warning_codes must contain only bounded machine-readable codes.");
  }
  const updated = structuredClone(caseRecord);
  const state = stateFor(updated);
  if (state.account_ref_digest && state.account_ref_digest !== accountRefDigest) {
    throw new BetaError(
      "CROSS_JOURNEY_ACCOUNT_MISMATCH",
      "The new journey context resolves to a different account. The handoff is blocked.",
    );
  }
  state.account_ref_digest = accountRefDigest;
  state.active_journey = journey;
  state.contexts[journey] = {
    ...state.contexts[journey],
    status: "evidence_ready",
    context: {
      digest: contextDigest,
      schema_version: contextVersion,
      item_count: itemCount,
      warning_codes: [...new Set(warningCodes)],
      raw_customer_content_retained: false,
      bound_at: now.toISOString(),
    },
    approvals: [],
  };
  updated.journey_state = state;
  return invalidateCaseReview(updated, now);
}

export function recordOrchestrationRun(caseRecord, { journey, accountRefDigest, durationMs, sourceGaps = [], testerId, now = new Date() }) {
  requireOwner(caseRecord, testerId);
  requireJourney(journey);
  if (!DIGEST.test(accountRefDigest || "")) throw new BetaError("INVALID_CONTEXT_DIGEST", "Account reference must use a SHA-256 digest.");
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 30000) throw new BetaError("INVALID_ORCHESTRATION_DURATION", "The first response duration must be from 0 to 30000 ms.");
  if (!Array.isArray(sourceGaps) || sourceGaps.some((item) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(item))) {
    throw new BetaError("INVALID_WARNING_CODE", "source_gaps must contain bounded machine-readable codes.");
  }
  const updated = structuredClone(caseRecord);
  const state = stateFor(updated);
  if (state.account_ref_digest && state.account_ref_digest !== accountRefDigest) {
    throw new BetaError("CROSS_JOURNEY_ACCOUNT_MISMATCH", "The orchestration run resolves to a different account.");
  }
  state.account_ref_digest = accountRefDigest;
  state.active_journey = journey;
  state.contexts[journey].orchestration = { duration_ms: durationMs, source_gap_codes: [...new Set(sourceGaps)], completed_at: now.toISOString() };
  updated.journey_state = state;
  updated.updated_at = now.toISOString();
  return updated;
}

export function recordJourneyAContactVerification(
  caseRecord,
  {
    accountRefDigest,
    salesforceIdentityState,
    contactSnapshotState = salesforceIdentityState,
    salesforceActivityState,
    gmailMetadataState,
    gongMetadataState,
    gongLookbackDays,
    candidateCount,
    eligibleContactCount = null,
    sourceGaps = [],
    testerId,
    now = new Date(),
  },
) {
  requireOwner(caseRecord, testerId);
  if (!DIGEST.test(accountRefDigest || "")) {
    throw new BetaError("INVALID_CONTEXT_DIGEST", "Account reference must use a SHA-256 digest.");
  }
  const sourceStates = {
    salesforce_identity: salesforceIdentityState,
    contact_snapshot: contactSnapshotState,
    salesforce_activity: salesforceActivityState,
    gmail_metadata: gmailMetadataState,
    gong_metadata: gongMetadataState,
  };
  if (Object.values(sourceStates).some((state) => !CONTACT_SOURCE_STATES.has(state))) {
    throw new BetaError("CONTACT_VERIFICATION_INCOMPLETE", "Contact verification included an unknown source state.");
  }
  if (contactSnapshotState !== "checked") {
    throw new BetaError("CONTACT_IDENTITY_NOT_VERIFIED", "The current contact snapshot must verify contact identity before any contact suggestion is presented.");
  }
  if (gongLookbackDays !== 180) {
    throw new BetaError("GONG_LOOKBACK_REQUIRED", "If Gong context is requested, it must use the full 180-day metadata lookback.");
  }
  if (!Number.isInteger(candidateCount) || candidateCount < 0 || candidateCount > 100) {
    throw new BetaError("INVALID_CONTACT_CANDIDATE_COUNT", "candidate_count must be an integer from 0 to 100.");
  }
  if (eligibleContactCount !== null && (!Number.isInteger(eligibleContactCount) || eligibleContactCount < 0 || eligibleContactCount > candidateCount)) {
    throw new BetaError("INVALID_CONTACT_CANDIDATE_COUNT", "Verified recipient count must be within the returned contact count.");
  }
  if (!Array.isArray(sourceGaps) || sourceGaps.some((item) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(item))) {
    throw new BetaError("INVALID_WARNING_CODE", "source_gaps must contain only bounded machine-readable codes.");
  }
  const updated = structuredClone(caseRecord);
  const state = stateFor(updated);
  if (state.active_journey !== "journey_a") {
    throw new BetaError("JOURNEY_NOT_ACTIVE", "Account Prioritization and Outreach must be active before contact evidence can be recorded.");
  }
  if (state.account_ref_digest && state.account_ref_digest !== accountRefDigest) {
    throw new BetaError("CROSS_JOURNEY_ACCOUNT_MISMATCH", "Contact verification resolves to a different account.");
  }
  state.account_ref_digest = accountRefDigest;
  state.contexts.journey_a.contact_verification = {
    source_states: sourceStates,
    gong_lookback_days: gongLookbackDays,
    candidate_count: candidateCount,
    ...(eligibleContactCount !== null ? { eligible_recipient_count: eligibleContactCount } : {}),
    source_gap_codes: [...new Set(sourceGaps)],
    checked_at: now.toISOString(),
  };
  updated.journey_state = state;
  updated.updated_at = now.toISOString();
  return updated;
}

export function approveJourneyAGate(
  caseRecord,
  { gate, revision, testerId, note = null, now = new Date() },
) {
  requireOwner(caseRecord, testerId);
  if (revision !== caseRecord.revision) {
    throw new BetaError("STALE_CASE_REVISION", "The approval does not match the current case revision.");
  }
  const updated = structuredClone(caseRecord);
  const state = stateFor(updated);
  if (state.active_journey !== "journey_a") {
    throw new BetaError(
      "JOURNEY_NOT_ACTIVE",
      "Account Prioritization and Outreach must be active before recording its approval.",
    );
  }
  if (!state.contexts.journey_a.context) {
    throw new BetaError(
      "JOURNEY_CONTEXT_REQUIRED",
      "Bind the reviewed Account Prioritization and Outreach context before approvals.",
    );
  }
  const approvals = state.contexts.journey_a.approvals || [];
  const expected = JOURNEY_A_GATES[approvals.length] || null;
  if (gate !== expected) {
    throw new BetaError(
      "APPROVAL_ORDER_VIOLATION",
      `The next required Account Prioritization and Outreach review is ${expected}.`,
    );
  }
  if (gate === "contact_selection" && !state.contexts.journey_a.contact_verification) {
    throw new BetaError(
      "CONTACT_VERIFICATION_REQUIRED",
      "Complete the current contact-snapshot check before reviewing contact selection. Gmail, Salesforce activity, and Gong are optional supporting context.",
    );
  }
  if (gate === "contact_selection" && state.contexts.journey_a.contact_verification.eligible_recipient_count === 0) {
    throw new BetaError("CONTACT_RECIPIENT_NOT_VERIFIED", "Contact priority is not recipient verification. Complete the same-account detail lookup before approving a contact for an outreach draft.");
  }
  const cleanNote = note ? assertSafeFreeText(note, "note", 240) : null;
  approvals.push({ gate, revision, tester_id: testerId, note: cleanNote, approved_at: now.toISOString() });
  state.contexts.journey_a.approvals = approvals;
  state.contexts.journey_a.status = approvals.length === JOURNEY_A_GATES.length ? "reviewed" : "in_review";
  updated.journey_state = state;
  updated.updated_at = now.toISOString();
  return updated;
}

export function handoffJourney(
  caseRecord,
  { fromJourney, toJourney, reason, abandonCustomerPlanning = false, revision, testerId, now = new Date() },
) {
  requireOwner(caseRecord, testerId);
  requireJourney(fromJourney);
  requireJourney(toJourney);
  if (fromJourney === toJourney) throw new BetaError("INVALID_HANDOFF", "The source and destination journeys must differ.");
  if (!HANDOFF_REASONS.includes(reason)) throw new BetaError("INVALID_HANDOFF_REASON", "Use one of the supported handoff reasons.");
  if (revision !== caseRecord.revision) throw new BetaError("STALE_CASE_REVISION", "The handoff does not match the current case revision.");
  requireCustomerPlanningAbandonment(fromJourney, toJourney, abandonCustomerPlanning);
  const updated = structuredClone(caseRecord);
  const state = stateFor(updated);
  if (state.active_journey !== fromJourney) throw new BetaError("JOURNEY_NOT_ACTIVE", "The source journey is not active.");
  const sourceContext = state.contexts[fromJourney]?.context;
  if (!sourceContext || !state.account_ref_digest) {
    throw new BetaError("JOURNEY_CONTEXT_REQUIRED", "Bind reviewed shared account context before handoff.");
  }
  requireReviewedHandoffEvidence(updated, state, fromJourney);
  state.contexts[fromJourney].status = "handed_off";
  state.contexts[toJourney].status = "active";
  state.active_journey = toJourney;
  state.handoffs.push({
    from_journey: fromJourney,
    to_journey: toJourney,
    reason,
    source_context_digest: sourceContext.digest,
    account_ref_digest: state.account_ref_digest,
    source_warning_codes: [...sourceContext.warning_codes],
    created_at: now.toISOString(),
  });
  updated.journey_state = state;
  return invalidateCaseReview(updated, now);
}

export function publicJourneyStatus(caseRecord) {
  const state = stateFor(caseRecord);
  return {
    schema_version: state.schema_version,
    active_workflow: WORKFLOW_NAMES[state.active_journey],
    active_workflow_label: JOURNEY_LABELS[state.active_journey],
    account_context_bound: Boolean(state.account_ref_digest),
    workflows: Object.fromEntries(Object.entries(state.contexts).map(([journey, value]) => [WORKFLOW_NAMES[journey], {
      label: JOURNEY_LABELS[journey],
      status: value.status,
      ...(journey === "journey_a" ? { draft_delivery: caseRecord.outreach_delivery?.state || "not_requested" } : {}),
      context_bound: Boolean(value.context),
      context_version: value.context?.schema_version || null,
      item_count: value.context?.item_count ?? null,
      warning_codes: value.context?.warning_codes || [],
      orchestration: value.orchestration || null,
      contact_verification: journey === "journey_a" && value.contact_verification
        ? {
          source_states: value.contact_verification.source_states,
          gong_lookback_days: value.contact_verification.gong_lookback_days,
          candidate_count: value.contact_verification.candidate_count,
          source_gap_codes: value.contact_verification.source_gap_codes,
        }
        : null,
      completed_gates: (journey === "journey_b" ? caseRecord.approvals || [] : value.approvals || []).map((approval) => approval.gate),
      next_gate: journey === "journey_a" ? JOURNEY_A_GATES[(value.approvals || []).length] || null : nextGate(caseRecord),
      ...(journey === "journey_b" ? { account_brief_bound: Boolean(caseRecord.account_intelligence_core), selected_call_evidence_bound: Boolean(caseRecord.derived_evidence) } : {}),
    }])),
    handoffs: state.handoffs.map((item) => ({
      from_workflow: WORKFLOW_NAMES[item.from_journey],
      from_workflow_label: JOURNEY_LABELS[item.from_journey],
      to_workflow: WORKFLOW_NAMES[item.to_journey],
      to_workflow_label: JOURNEY_LABELS[item.to_journey],
      reason: item.reason,
      created_at: item.created_at,
    })),
  };
}

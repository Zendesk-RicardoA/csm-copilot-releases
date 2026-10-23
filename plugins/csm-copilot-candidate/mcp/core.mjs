import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GATES = [
  "identity",
  "evidence",
  "recommendations",
  "customer_content",
  "maintained_slides",
  "rendered_output",
];

export const RECOMMENDATION_REVIEW_SECTIONS = [
  "account_identity_scope",
  "metric_baseline_and_definitions",
  "call_pain_points",
  "product_configuration_evidence_and_gaps",
  "pain_point_capability_metric_mapping",
];

export const ACCOUNT_INTELLIGENCE_CORE_CONTRACT = "AccountIntelligenceCoreV1";
export const ACCOUNT_INTELLIGENCE_CORE_VERSION = "1.0.0";
export const ACCOUNT_INTELLIGENCE_CORE_SECTIONS = [
  "account_header",
  "cta_context",
  "company_profile",
  "commercial_footprint",
  "product_footprint",
  "adoption_gaps",
  "team_and_setup",
  "tech_stack",
  "support_operations",
  "recent_conversations",
];

const SHA256_DIGEST = /^[a-f0-9]{64}$/;

export const JOURNEY_LABELS = Object.freeze({
  journey_a: "Account Prioritization and Outreach",
  journey_b: "Customer Planning and Meeting Prep",
});

export const WORKFLOW_NAMES = Object.freeze({ journey_a: "outreach", journey_b: "meeting_prep" });

export function initialJourneyState() {
  return {
    schema_version: "1.0",
    active_journey: "journey_b",
    account_ref_digest: null,
    contexts: {
      journey_a: { status: "not_started", context: null, contact_verification: null, approvals: [] },
      journey_b: { status: "active", context: null, approvals: [] },
    },
    handoffs: [],
  };
}

export const SCENARIOS = {
  "northstar-support": {
    customer: "Northstar Support Labs",
    summary: "Invented four-phase service-improvement case with six months of synthetic metrics.",
  },
  "harbor-helpdesk": {
    customer: "Harbor Helpdesk Cooperative",
    summary: "Invented knowledge and workflow case with no external data or generated artifact.",
  },
};

export class BetaError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "BetaError";
    this.code = code;
    this.details = details;
  }
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function validatePackagePreflight({
  manifest,
  packageRoot,
  expectedPackageName,
  expectedPackageVersion,
  now = new Date(),
}) {
  if (!["approved_for_invented_testing", "approved_for_limited_beta"].includes(manifest.status)) {
    throw new BetaError("VERSION_NOT_APPROVED", "The package version is not approved for its configured beta mode.");
  }
  if (
    (expectedPackageName && manifest.package_name !== expectedPackageName) ||
    (expectedPackageVersion && manifest.package_version !== expectedPackageVersion)
  ) {
    throw new BetaError("PACKAGE_VERSION_MISMATCH", "The local package does not match the approved manifest.");
  }
  if (!manifest.expires_at || new Date(manifest.expires_at) <= now) {
    throw new BetaError("VERSION_STALE", "The approved package version has expired.");
  }
  const constraints = manifest.constraints || {};
  if (manifest.status === "approved_for_invented_testing") {
    if (
      constraints.real_customer_data !== false ||
      constraints.external_reads !== false ||
      constraints.external_writes !== false ||
      constraints.generated_artifacts !== false
    ) {
      throw new BetaError("BOUNDARY_MISMATCH", "The approved manifest does not enforce the invented-only boundary.");
    }
  } else if (
    constraints.real_customer_data !== true ||
    constraints.external_reads !== true ||
    constraints.private_draft_writes !== true ||
    constraints.production_system_writes !== false ||
    constraints.generated_artifacts !== true
  ) {
    throw new BetaError("BOUNDARY_MISMATCH", "The limited-beta manifest does not enforce read-only sources and private-draft-only writes.");
  }
  for (const [relativePath, expected] of Object.entries(manifest.integrity?.files || {})) {
    const resolved = path.resolve(packageRoot, relativePath);
    const root = `${path.resolve(packageRoot)}${path.sep}`;
    if (!resolved.startsWith(root) || !fs.existsSync(resolved) || sha256File(resolved) !== expected) {
      throw new BetaError("PACKAGE_INTEGRITY_FAILED", `${relativePath} differs from the approved package.`);
    }
  }
  return {
    package_version: manifest.package_version,
    renderer_baseline: manifest.renderer_baseline,
    expires_at: manifest.expires_at,
    boundaries: constraints,
  };
}

function nextSetupAction(code, title, instruction) {
  return { code, title, instruction };
}

function deriveOperatorRef(identity) {
  const provider = identity?.provider;
  const subject = identity?.subject;
  if (!provider || !subject) return null;
  const digest = crypto.createHash("sha256").update(`${provider}:${subject}`).digest("hex").slice(0, 20);
  return `operator_${digest}`;
}

export function evaluateOnboarding({ credentialState, packageResult }) {
  if (!["invented_only", "limited_beta"].includes(credentialState?.mode)) {
    throw new BetaError("UNSUPPORTED_MODE", "The credential adapter mode is not enabled.");
  }

  const checks = {
    package: "ready",
    company_identity: "pending",
    snowflake_zdp: "pending",
    salesforce_cli: credentialState.salesforce_cli?.state || "not_configured",
    google_drive_slides: "pending",
    manual_renderer: credentialState.manual_renderer?.state || "not_configured",
    presenter_profile: "pending",
    tester_register: credentialState.tester_register?.state || "not_configured",
  };
  const manualRenderer = credentialState.renderer_mode === "manual_bound_script";
  const warnings = [];
  let action = null;

  if (credentialState.identity?.state !== "connected" || credentialState.identity?.verified !== true) {
    checks.company_identity = credentialState.identity?.state || "not_connected";
    action = nextSetupAction(
      "CONNECT_SNOWFLAKE_ZDP",
      "Connect Snowflake/ZDP with your company account",
      "Run the Snowflake/ZDP connection. Its approved browser sign-in verifies your company identity and read-only access, then run setup status again.",
    );
  } else {
    checks.company_identity = "ready";
  }

  const operatorRef = deriveOperatorRef(credentialState.identity);
  if (!action && !operatorRef) {
    checks.company_identity = "invalid";
    action = nextSetupAction(
      "IDENTITY_NOT_VERIFIABLE",
      "Company identity could not be verified",
      "Reconnect the company account. Do not type an identity or use shared credentials.",
    );
  }

  if (!action && credentialState.snowflake?.state !== "connected") {
    checks.snowflake_zdp = credentialState.snowflake?.state || "not_connected";
    action = nextSetupAction(
      "CONNECT_SNOWFLAKE_ZDP",
      "Connect Snowflake/ZDP",
      "Complete Snowflake browser SSO with the company account, then run setup status again.",
    );
  } else if (!action && credentialState.snowflake?.read_only_verified !== true) {
    checks.snowflake_zdp = "permission_not_verified";
    action = nextSetupAction(
      "VERIFY_READ_ONLY_ZDP_ACCESS",
      "Verify read-only ZDP access",
      "Ask the beta owner to verify that the signed-in Snowflake role is read-only for the approved sources.",
    );
  } else if (!action) {
    checks.snowflake_zdp = "ready";
  }

  if (checks.salesforce_cli !== "ready") {
    warnings.push({
      code: "SALESFORCE_CLI_OPTIONAL",
      message: "Optional direct Salesforce identity verification is not ready. Snowflake remains available; ask the Copilot to guide local Salesforce CLI setup when needed.",
      blocking: false,
    });
  }

  if (!action && credentialState.presenter_profile?.state !== "ready") {
    checks.presenter_profile = credentialState.presenter_profile?.state || "not_configured";
    action = nextSetupAction(
      "PERSONALIZE_PRIVATE_MASTER_DECK",
      "Confirm your personal master deck",
      "If your private deck already exists, confirm that it contains your name, title, and photo so the Copilot can save the missing local setup record. Create and personalize it only if it does not exist.",
    );
  } else if (!action) {
    checks.presenter_profile = "ready";
  }

  if (!action && manualRenderer && credentialState.manual_renderer?.state !== "ready") {
    checks.google_drive_slides = "manual_authorization_required";
    checks.manual_renderer = credentialState.manual_renderer?.state || "not_configured";
    action = nextSetupAction(
      "AUTHORIZE_MANUAL_RENDERER",
      "Authorize the private master-deck renderer",
      "Open your private master deck, choose CSM Copilot > Open private renderer, complete Google's authorization prompt, then confirm that the renderer opened.",
    );
  } else if (!action && manualRenderer) {
    checks.google_drive_slides = "ready";
    checks.manual_renderer = "ready";
  } else if (!action && credentialState.google?.state !== "connected") {
    checks.google_drive_slides = credentialState.google?.state || "not_connected";
    action = nextSetupAction(
      "CONNECT_GOOGLE_DRIVE_SLIDES",
      "Connect Google Drive and Slides",
      "Complete the approved Google browser authorization for private drafts, then run setup status again.",
    );
  } else if (!action && credentialState.google?.private_draft_scope_verified !== true) {
    checks.google_drive_slides = "permission_not_verified";
    action = nextSetupAction(
      "VERIFY_PRIVATE_DRAFT_SCOPE",
      "Verify private-draft permission",
      "Ask the beta owner to verify the approved Drive and Slides scope. Do not paste an OAuth code into chat.",
    );
  } else if (!action) {
    checks.google_drive_slides = "ready";
  }

  if (checks.tester_register !== "connected") {
    warnings.push({
      code: "TESTER_REGISTER_NOT_CONNECTED",
      message: "Pilot coordination will remain local until the owner-only tester register is connected.",
      blocking: false,
    });
  }

  return {
    status: action ? "action_required" : "ready",
    mode: credentialState.mode,
    operator_ref: operatorRef,
    package_version: packageResult.package_version,
    renderer_baseline: packageResult.renderer_baseline,
    checks,
    next_action: action,
    warnings,
  };
}

/**
 * Account Prioritization and Outreach reads do not create a deck.  They must
 * therefore not be held behind private-renderer setup, while still requiring
 * the package boundary, authenticated CSM identity, and read-only Snowflake
 * access that define the owned CTA scope.
 */
export function evaluateJourneyAReadiness({ credentialState, packageResult }) {
  if (credentialState?.mode !== "limited_beta") {
    throw new BetaError("UNSUPPORTED_MODE", "Account Prioritization and Outreach requires the approved limited-beta mode.");
  }

  const checks = {
    package: "ready",
    company_identity: "pending",
    snowflake_zdp: "pending",
  };
  let action = null;

  if (credentialState.identity?.state !== "connected" || credentialState.identity?.verified !== true) {
    checks.company_identity = credentialState.identity?.state || "not_connected";
    action = nextSetupAction(
      "CONNECT_SNOWFLAKE_ZDP",
      "Connect Snowflake/ZDP with your company account",
      "Run the Snowflake/ZDP connection. Its approved browser sign-in verifies your company identity and read-only access, then run setup status again.",
    );
  } else {
    checks.company_identity = "ready";
  }

  const operatorRef = deriveOperatorRef(credentialState.identity);
  if (!action && !operatorRef) {
    checks.company_identity = "invalid";
    action = nextSetupAction(
      "IDENTITY_NOT_VERIFIABLE",
      "Company identity could not be verified",
      "Reconnect the company account. Do not type an identity or use shared credentials.",
    );
  }

  if (!action && credentialState.snowflake?.state !== "connected") {
    checks.snowflake_zdp = credentialState.snowflake?.state || "not_connected";
    action = nextSetupAction(
      "CONNECT_SNOWFLAKE_ZDP",
      "Connect Snowflake/ZDP",
      "Complete Snowflake browser SSO with the company account, then run setup status again.",
    );
  } else if (!action && credentialState.snowflake?.read_only_verified !== true) {
    checks.snowflake_zdp = "permission_not_verified";
    action = nextSetupAction(
      "VERIFY_READ_ONLY_ZDP_ACCESS",
      "Verify read-only ZDP access",
      "Ask the beta owner to verify that the signed-in Snowflake role is read-only for the approved sources.",
    );
  } else if (!action) {
    checks.snowflake_zdp = "ready";
  }

  return {
    status: action ? "action_required" : "ready",
    package_version: packageResult.package_version,
    renderer_baseline: packageResult.renderer_baseline,
    operator_ref: operatorRef,
    checks,
    next_action: action,
  };
}

/**
 * Public setup is capability-scoped.  In particular, outreach research must
 * never inherit presenter or renderer requirements from meeting preparation.
 */
export function evaluateCapabilityReadiness({ credentialState, packageResult, workflow, signatureStatus = null }) {
  if (!new Set(["daily_focus", "outreach", "portfolio_analytics", "meeting_prep", "renewal_conversation_brief"]).has(workflow)) {
    throw new BetaError("WORKFLOW_REQUIRED", "Choose Daily Focus, Account Prioritization and Outreach, Book of Business Analysis, Customer Planning and Meeting Prep, or Renewal Conversation Brief.");
  }
  if (credentialState?.mode === "invented_only") {
    return {
      status: "not_checked",
      package_version: packageResult.package_version,
      renderer_baseline: packageResult.renderer_baseline,
      operator_ref: null,
      checks: { package: "ready", company_identity: "not_checked", snowflake_zdp: "not_checked" },
      next_action: nextSetupAction(
        "LIVE_APPROVAL_REQUIRED",
        "Live source reads are not approved for this Candidate",
        "This installed Candidate supports invented testing only. A separately approved limited-beta package is required for customer-data reads.",
      ),
      workflow,
      capabilities: {},
      setup_notes: [],
    };
  }
  if (workflow === "meeting_prep") {
    return { ...evaluateOnboarding({ credentialState, packageResult }), workflow, capabilities: {
      customer_research: credentialState?.snowflake?.read_only_verified === true ? "ready" : "action_required",
      private_google_slides_draft: "ready",
    } };
  }
  const core = evaluateJourneyAReadiness({ credentialState, packageResult });
  if (workflow === "portfolio_analytics") {
    return {
      ...core,
      workflow,
      capabilities: {
        book_of_business_analysis: core.status === "ready" ? "ready" : "action_required",
        aggregate_account_counts: core.status === "ready" ? "ready" : "action_required",
        aggregate_net_arr_usd: core.status === "ready" ? "ready" : "action_required",
      },
      setup_notes: [
        "Book of Business Analysis uses only your authenticated, read-only Snowflake scope. It does not need CTA selection, a private deck, a renderer, or Gmail setup.",
      ],
    };
  }
  if (workflow === "renewal_conversation_brief") {
    const presentation = evaluateOnboarding({ credentialState, packageResult });
    const draftReady = presentation.status === "ready";
    return {
      ...core,
      workflow,
      capabilities: {
        renewal_evidence: core.status === "ready" ? "ready" : "action_required",
        shared_account_intelligence: core.status === "ready" ? "ready" : "action_required",
        private_google_slides_draft: draftReady ? "ready" : "setup_needed",
      },
      setup_notes: draftReady ? [] : [
        "You can prepare and review the renewal evidence now. Your private master and renderer are needed only after you approve a private Slides draft.",
      ],
    };
  }
  const signatureState = signatureStatus?.state || "not_configured";
  return {
    ...core,
    workflow,
    capabilities: {
      daily_focus: workflow === "daily_focus" ? (core.status === "ready" ? "ready" : "action_required") : "not_requested",
      cta_queue: workflow === "outreach" ? (core.status === "ready" ? "ready" : "action_required") : "not_requested",
      account_brief: workflow === "outreach" ? (core.status === "ready" ? "ready" : "action_required") : "not_requested",
      contact_shortlist: workflow === "outreach" ? (core.status === "ready" ? "ready" : "action_required") : "not_requested",
      gmail_draft: workflow === "outreach" ? (signatureState === "ready" ? "ready" : "setup_needed") : "not_requested",
    },
    setup_notes: workflow === "outreach" && signatureState !== "ready" ? [
      "You can still review CTAs, account context, metrics, and contacts. Set up your Gmail signature only when you want to create a Gmail draft.",
    ] : [],
  };
}

export function assertSafeFreeText(value, fieldName, maxLength = 500) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BetaError("INVALID_INPUT", `${fieldName} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new BetaError("INVALID_INPUT", `${fieldName} exceeds ${maxLength} characters.`);
  }
  const forbidden = [
    /https?:\/\//i,
    /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
    /\b(?:gong|salesforce|gainsight|snowflake)\b/i,
    /\b(?:account|tenant|call)[-_ ]?id\b/i,
    /\b\d{12,}\b/,
  ];
  if (forbidden.some((pattern) => pattern.test(value))) {
    throw new BetaError(
      "REAL_DATA_REJECTED",
      `${fieldName} appears to contain external-system or identifiable data. Use invented, generic feedback only.`,
    );
  }
  return value.trim();
}

export function validateInventedAllowlistPreflight({
  testerId,
  allowlist,
  manifest,
  packageRoot,
  expectedPackageName,
  expectedPackageVersion,
  now = new Date(),
}) {
  if (!testerId) {
    throw new BetaError(
      "TESTER_ID_MISSING",
      "The invented tester ID is missing from the control-shell test input.",
    );
  }
  if (allowlist.mode !== "invented_only") {
    throw new BetaError("UNSUPPORTED_MODE", "Only invented_only mode is enabled in this package.");
  }
  const tester = allowlist.testers?.find((entry) => entry.id === testerId && entry.enabled === true);
  if (!tester) {
    throw new BetaError("TESTER_NOT_ALLOWLISTED", "This tester is not enabled for the controlled beta.");
  }
  const packageResult = validatePackagePreflight({
    manifest,
    packageRoot,
    expectedPackageName,
    expectedPackageVersion,
    now,
  });
  return {
    ok: true,
    mode: "invented_only",
    tester_id: testerId,
    ...packageResult,
  };
}

export function createInventedCase({ scenario, testerId, manifest, now = new Date(), caseId }) {
  const selected = SCENARIOS[scenario];
  if (!selected) {
    throw new BetaError("INVALID_SCENARIO", "Use one of the fixed invented scenarios.");
  }
  return {
    schema_version: "1.0",
    case_id: caseId || crypto.randomUUID(),
    tester_id: testerId,
    package_version: manifest.package_version,
    renderer_baseline: manifest.renderer_baseline,
    scenario,
    invented_customer: selected.customer,
    scenario_summary: selected.summary,
    revision: 1,
    status: "in_review",
    approvals: [],
    feedback: null,
    presentation_plan: null,
    journey_state: initialJourneyState(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function nextGate(caseRecord) {
  return GATES[caseRecord.approvals.length] || null;
}

export function bindRecommendationReviewPackage(
  caseRecord,
  { reviewPackageDigest, sections, recommendationRefs = null, revision, testerId, now = new Date() },
) {
  if (caseRecord.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (revision !== caseRecord.revision) {
    throw new BetaError("STALE_CASE_REVISION", "The recommendation review package does not match the current case revision.");
  }
  const activeJourney = (caseRecord.journey_state || initialJourneyState()).active_journey;
  if (activeJourney !== "journey_b") {
    throw new BetaError(
      "JOURNEY_NOT_ACTIVE",
      "Customer Planning and Meeting Prep must be active before recommendations can be reviewed.",
    );
  }
  const approved = new Set((caseRecord.approvals || []).map((approval) => approval.gate));
  if (!approved.has("identity") || !approved.has("evidence")) {
    throw new BetaError(
      "EVIDENCE_REVIEW_REQUIRED",
      "Review identity and evidence before binding the recommendation review package.",
    );
  }
  if (approved.has("recommendations")) {
    throw new BetaError(
      "RECOMMENDATION_REVIEW_LOCKED",
      "Recommendations are already approved for this revision. Update the evidence before presenting a revised package.",
    );
  }
  if (!SHA256_DIGEST.test(reviewPackageDigest || "")) {
    throw new BetaError("INVALID_RECOMMENDATION_REVIEW_DIGEST", "The recommendation review package must use a SHA-256 digest.");
  }
  if (caseRecord.account_ref_digest && (!caseRecord.account_intelligence_core || !caseRecord.derived_evidence)) {
    throw new BetaError("MEETING_PREP_EVIDENCE_INCOMPLETE", "Read the account brief and selected call before binding recommendations.");
  }
  const sharedAccountCore = caseRecord.account_intelligence_core;
  if (sharedAccountCore) {
    const currentAccount = caseRecord.journey_state?.account_ref_digest || caseRecord.renewal_conversation?.account_ref_digest || null;
    if (
      sharedAccountCore.contract !== ACCOUNT_INTELLIGENCE_CORE_CONTRACT
      || sharedAccountCore.schema_version !== ACCOUNT_INTELLIGENCE_CORE_VERSION
      || !SHA256_DIGEST.test(sharedAccountCore.content_digest || "")
      || (currentAccount && sharedAccountCore.account_ref_digest !== currentAccount)
    ) {
      throw new BetaError(
        "ACCOUNT_INTELLIGENCE_BINDING_INVALID",
        "The shared account brief is missing, outdated, or belongs to a different account. Refresh it before reviewing the full customer plan.",
      );
    }
  }
  const uniqueSections = [...new Set(sections || [])];
  if (
    !Array.isArray(sections)
    || uniqueSections.length !== RECOMMENDATION_REVIEW_SECTIONS.length
    || RECOMMENDATION_REVIEW_SECTIONS.some((section) => !uniqueSections.includes(section))
  ) {
    throw new BetaError(
      "RECOMMENDATION_REVIEW_INCOMPLETE",
      "The recommendation review must include account scope, metric definitions, call pain points, product and configuration evidence with gaps, and pain-point-to-capability-to-metric mappings.",
    );
  }
  if (caseRecord.account_ref_digest && (!Array.isArray(recommendationRefs) || !recommendationRefs.length || recommendationRefs.length > 50
    || new Set(recommendationRefs).size !== recommendationRefs.length || recommendationRefs.some((ref) => !/^recommendation:[1-9][0-9]{0,2}$/.test(ref)))) {
    throw new BetaError("RECOMMENDATION_REFERENCES_REQUIRED", "Bind a stable numbered reference for every reviewed recommendation.");
  }
  const updated = structuredClone(caseRecord);
  updated.recommendation_review_package = {
    digest: reviewPackageDigest,
    sections: RECOMMENDATION_REVIEW_SECTIONS,
    recommendation_refs: recommendationRefs,
    account_intelligence_core_digest: caseRecord.account_intelligence_core?.content_digest || null,
    revision,
    raw_customer_content_retained: false,
    bound_at: now.toISOString(),
  };
  updated.updated_at = now.toISOString();
  return updated;
}

/**
 * Persist only the issued contract receipt, never the customer brief itself.
 * A later full-plan review can prove that it inherited the same account truth
 * without retaining customer values in beta case state.
 */
export function bindAccountIntelligenceCore(
  caseRecord,
  {
    contract,
    schemaVersion,
    contentDigest,
    briefState,
    sectionStates,
    sourceGapCodes = [],
    performanceCoverage = null,
    accountRefDigest,
    revision,
    testerId,
    now = new Date(),
  },
) {
  if (caseRecord.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (revision !== caseRecord.revision) {
    throw new BetaError("STALE_CASE_REVISION", "The account brief does not match the current case revision.");
  }
  if (contract !== ACCOUNT_INTELLIGENCE_CORE_CONTRACT || schemaVersion !== ACCOUNT_INTELLIGENCE_CORE_VERSION) {
    throw new BetaError("UNSUPPORTED_ACCOUNT_INTELLIGENCE_CONTRACT", "Use the current AccountIntelligenceCoreV1 receipt.");
  }
  if (!SHA256_DIGEST.test(contentDigest || "") || !SHA256_DIGEST.test(accountRefDigest || "")) {
    throw new BetaError("INVALID_ACCOUNT_INTELLIGENCE_RECEIPT", "The account brief receipt must use SHA-256 references.");
  }
  if (!new Set(["complete", "partial", "needs_evidence"]).has(briefState)) {
    throw new BetaError("INVALID_ACCOUNT_INTELLIGENCE_STATE", "The account brief has an invalid evidence state.");
  }
  const entries = Object.entries(sectionStates || {});
  if (
    entries.length !== ACCOUNT_INTELLIGENCE_CORE_SECTIONS.length
    || ACCOUNT_INTELLIGENCE_CORE_SECTIONS.some((section) => typeof sectionStates?.[section] !== "string")
  ) {
    throw new BetaError("ACCOUNT_INTELLIGENCE_SECTIONS_INCOMPLETE", "The account brief receipt must include every required section state.");
  }
  if (!Array.isArray(sourceGapCodes) || sourceGapCodes.some((code) => typeof code !== "string" || code.length > 128)) {
    throw new BetaError("INVALID_ACCOUNT_INTELLIGENCE_GAPS", "The account brief receipt includes an invalid source-gap code.");
  }
  const performanceRoles = ["baseline", "volume_trend", "speed_quality_trend", "peer_comparison", "year_over_year"];
  if (performanceCoverage !== null && (Object.keys(performanceCoverage).length !== performanceRoles.length || performanceRoles.some((role) => typeof performanceCoverage[role] !== "boolean"))) {
    throw new BetaError("INVALID_PERFORMANCE_COVERAGE", "Only boolean performance-availability receipts may be retained in case state.");
  }
  const existingAccount = caseRecord.account_ref_digest || caseRecord.journey_state?.account_ref_digest || caseRecord.renewal_conversation?.account_ref_digest;
  if (existingAccount && existingAccount !== accountRefDigest) {
    throw new BetaError("CROSS_JOURNEY_ACCOUNT_MISMATCH", "The account brief resolves to a different account.");
  }
  const updated = structuredClone(caseRecord);
  if (caseRecord.account_intelligence_core && caseRecord.account_intelligence_core.content_digest !== contentDigest) {
    // A changed source receipt is new evidence, not a wording edit. Keep the
    // same call/account identity; require evidence and all later reviews again.
    updated.revision += 1;
    updated.approvals = (updated.approvals || []).filter((item) => item.gate === "identity")
      .map((item) => ({ ...item, revision: updated.revision, carried_from_revision: caseRecord.revision }));
    for (const key of ["recommendation_review_package", "draft_review", "artifact", "private_draft_authorization"]) delete updated[key];
    updated.status = "in_review";
  }
  updated.account_intelligence_core = {
    contract,
    schema_version: schemaVersion,
    content_digest: contentDigest,
    brief_state: briefState,
    section_states: Object.fromEntries(entries),
    source_gap_codes: [...new Set(sourceGapCodes)],
    account_ref_digest: accountRefDigest,
    revision: updated.revision,
    performance_coverage: performanceCoverage,
    raw_customer_content_retained: false,
    bound_at: now.toISOString(),
  };
  updated.updated_at = now.toISOString();
  return updated;
}

export function approveGate(caseRecord, { gate, revision, testerId, note, now = new Date() }) {
  if (caseRecord.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (revision !== caseRecord.revision) {
    throw new BetaError("STALE_CASE_REVISION", "The approval does not match the current case revision.");
  }
  const expected = nextGate(caseRecord);
  if (!expected) {
    throw new BetaError("APPROVALS_COMPLETE", "All approval gates have already passed.");
  }
  if (gate !== expected) {
    throw new BetaError("APPROVAL_ORDER_VIOLATION", `The next required gate is ${expected}.`);
  }
  if (gate === "evidence" && caseRecord.account_ref_digest && (!caseRecord.account_intelligence_core || !caseRecord.derived_evidence)) {
    throw new BetaError("MEETING_PREP_EVIDENCE_INCOMPLETE", "Review the bound account brief and selected-call findings before approving evidence.");
  }
  if (gate === "recommendations") {
    const reviewPackage = caseRecord.recommendation_review_package;
    if (!reviewPackage || reviewPackage.revision !== revision) {
      throw new BetaError(
        "RECOMMENDATION_REVIEW_PACKAGE_REQUIRED",
        "Bind the complete recommendation review package before approving recommendations.",
      );
    }
  }
  if (caseRecord.account_ref_digest && ["customer_content", "maintained_slides"].includes(gate)
    && caseRecord.draft_review?.revision !== revision) {
    throw new BetaError("DRAFT_REVIEW_REQUIRED", "Prepare the exact customer content and verified slide selections before recording this approval.");
  }
  if (caseRecord.account_ref_digest && gate === "rendered_output"
    && (caseRecord.artifact?.revision !== revision || caseRecord.artifact.private_draft !== true)) {
    throw new BetaError("PRIVATE_DRAFT_REQUIRED", "Record the created private draft before approving its rendered output. A renderer handoff is not a created artifact.");
  }
  const cleanNote = note ? assertSafeFreeText(note, "note", 240) : null;
  const updated = structuredClone(caseRecord);
  updated.approvals.push({ gate, revision, tester_id: testerId, note: cleanNote, approved_at: now.toISOString() });
  updated.updated_at = now.toISOString();
  if (!nextGate(updated)) updated.status = "approved";
  return updated;
}

export function submitFeedback(
  caseRecord,
  { wouldUse, savedTime, biggestImprovement, revision, testerId, now = new Date() },
) {
  if (caseRecord.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (revision !== caseRecord.revision) {
    throw new BetaError("STALE_CASE_REVISION", "The feedback does not match the current case revision.");
  }
  if (caseRecord.status !== "approved" || nextGate(caseRecord)) {
    throw new BetaError("REVIEW_INCOMPLETE", "Complete every approval gate before submitting feedback.");
  }
  const allowed = new Set(["yes", "no", "unsure"]);
  if (!allowed.has(wouldUse) || !allowed.has(savedTime)) {
    throw new BetaError("INVALID_INPUT", "would_use and saved_time must be yes, no, or unsure.");
  }
  const updated = structuredClone(caseRecord);
  updated.feedback = {
    would_use: wouldUse,
    saved_time: savedTime,
    biggest_improvement: assertSafeFreeText(biggestImprovement, "biggest_improvement"),
    tester_id: testerId,
    case_id: caseRecord.case_id,
    package_version: caseRecord.package_version,
    renderer_baseline: caseRecord.renderer_baseline,
    revision,
    delivery_status: "prepared",
    prepared_at: now.toISOString(),
    submitted_at: null,
  };
  updated.status = "feedback_pending_submission";
  updated.updated_at = now.toISOString();
  return updated;
}

export function publicCaseStatus(caseRecord) {
  return {
    case_id: caseRecord.case_id,
    scenario: caseRecord.scenario,
    invented_customer: caseRecord.invented_customer,
    case_kind: caseRecord.case_kind || "invented",
    package_version: caseRecord.package_version,
    renderer_baseline: caseRecord.renderer_baseline,
    revision: caseRecord.revision,
    status: caseRecord.status,
    completed_gates: caseRecord.approvals.map((approval) => approval.gate),
    next_gate: nextGate(caseRecord),
    feedback_prepared: Boolean(caseRecord.feedback),
    feedback_submitted: caseRecord.feedback?.delivery_status === "user_confirmed_submitted",
    language_review: caseRecord.language_review || null,
    presentation_plan: caseRecord.presentation_plan || null,
    derived_evidence_bound: Boolean(caseRecord.derived_evidence),
    selected_call_provider: caseRecord.account_ref_digest ? caseRecord.transcript_eligibility?.provider || "snowflake_legacy" : null,
    draft_evidence_refs: caseRecord.account_ref_digest && caseRecord.account_intelligence_core?.content_digest && caseRecord.derived_evidence?.digest
      ? {
        account_brief: `evidence:account:${caseRecord.account_intelligence_core.content_digest.slice(0, 32)}`,
        selected_call: `evidence:call:${caseRecord.derived_evidence.digest.slice(0, 32)}`,
      }
      : null,
    selected_call_processing_state: caseRecord.account_ref_digest
      ? (caseRecord.derived_evidence ? "derived_findings_ready" : caseRecord.transcript_eligibility?.secondary_processing_authorized ? "processing_authorized" : "safety_confirmation_required")
      : null,
    recommendation_review_package: caseRecord.recommendation_review_package
      ? {
        bound: caseRecord.recommendation_review_package.revision === caseRecord.revision,
        revision: caseRecord.recommendation_review_package.revision,
        sections: caseRecord.recommendation_review_package.sections,
      }
      : null,
    account_intelligence_core: caseRecord.account_intelligence_core
      ? {
        bound: true,
        contract: caseRecord.account_intelligence_core.contract,
        schema_version: caseRecord.account_intelligence_core.schema_version,
        brief_state: caseRecord.account_intelligence_core.brief_state,
        section_states: caseRecord.account_intelligence_core.section_states,
        source_gap_count: caseRecord.account_intelligence_core.source_gap_codes.length,
      }
      : null,
    private_artifact_bound: Boolean(caseRecord.artifact?.private_draft),
    draft_review: caseRecord.draft_review?.revision === caseRecord.revision ? {
      bound: true, digest: caseRecord.draft_review.digest, revision: caseRecord.draft_review.revision,
      slide_order: caseRecord.draft_review.slide_order, metric_slide_plan: caseRecord.draft_review.metric_slide_plan,
    } : { bound: false },
    workflow: {
      active_workflow: WORKFLOW_NAMES[(caseRecord.journey_state || initialJourneyState()).active_journey],
      active_workflow_label: JOURNEY_LABELS[(caseRecord.journey_state || initialJourneyState()).active_journey],
      account_context_bound: Boolean((caseRecord.journey_state || initialJourneyState()).account_ref_digest),
      handoff_count: (caseRecord.journey_state || initialJourneyState()).handoffs.length,
    },
  };
}
